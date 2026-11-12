package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for _, l := range strings.Split(b.buf.String(), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// echoServer answers a request with {"id":..,"result":{"seen":<header>,"port":<n>}} and a notification with 202.
func echoServer(t *testing.T, hits *atomic.Int32) (string, func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		body, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(body, &m)
		if _, ok := m["id"]; !ok {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": m["id"], "result": map[string]any{"seen": r.Header.Get("X-Test-Key"), "port": port}})
	})}
	go srv.Serve(l)
	return "http://127.0.0.1:" + itoa(port) + "/mcp", func() { srv.Close() }
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func writeAddress(t *testing.T, path, url string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(`{"url":"`+url+`","pid":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestMcpForwardRelaysAndSurvivesASwitch(t *testing.T) {
	dir := t.TempDir()
	addr := filepath.Join(dir, "artifact-mcp.json")
	var hits atomic.Int32
	url1, stop1 := echoServer(t, &hits)
	writeAddress(t, addr, url1)
	out := &syncBuffer{}
	f, err := newForwarder(addr, `{"X-Test-Key":"k1"}`, out)
	if err != nil {
		t.Fatal(err)
	}
	f.retryFor = 5 * time.Second
	inR, inW := io.Pipe()
	done := make(chan struct{})
	go func() { f.run(inR); close(done) }()

	inW.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n"))
	inW.Write([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n"))
	waitFor(t, func() bool { return len(out.lines()) == 1 && hits.Load() == 2 }, "first answer")
	if !strings.Contains(out.lines()[0], `"seen":"k1"`) {
		t.Fatalf("headers not forwarded: %s", out.lines()[0])
	}

	// The AIB it talked to goes away; a request sent now waits until the next AIB writes its address.
	stop1()
	os.Remove(addr)
	inW.Write([]byte(`{"jsonrpc":"2.0","id":"two","method":"tools/call"}` + "\n"))
	time.Sleep(600 * time.Millisecond)
	if len(out.lines()) != 1 {
		t.Fatalf("answered without an AIB: %v", out.lines())
	}
	var hits2 atomic.Int32
	url2, stop2 := echoServer(t, &hits2)
	defer stop2()
	writeAddress(t, addr, url2)
	waitFor(t, func() bool { return len(out.lines()) == 2 }, "answer after the switch")
	if !strings.Contains(out.lines()[1], `"id":"two"`) || hits2.Load() != 1 {
		t.Fatalf("second answer %v (hits %d)", out.lines(), hits2.Load())
	}
	inW.Close()
	<-done
}

func TestMcpForwardGivesUpWithAnError(t *testing.T) {
	dir := t.TempDir()
	addr := filepath.Join(dir, "artifact-mcp.json")
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := "http://" + l.Addr().String() + "/mcp"
	l.Close() // nothing listens there
	writeAddress(t, addr, dead)
	out := &syncBuffer{}
	f, _ := newForwarder(addr, "", out)
	f.retryFor = 700 * time.Millisecond
	f.run(strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}` + "\n" + `{"jsonrpc":"2.0","method":"note"}` + "\n"))
	lines := out.lines()
	if len(lines) != 1 || !strings.Contains(lines[0], `"id":7`) || !strings.Contains(lines[0], "AIB is not running") {
		t.Fatalf("want one error for id 7, got %v", lines)
	}
}

// AIB was quit on purpose while its chats run in the keeper: the address file says closed, and a request is answered at once (no 15 s
// wait) with a clear error; a tools/call gets a tool result with isError so the model can read it and try again later.
func TestMcpForwardAnswersAtOnceWhileAIBIsClosed(t *testing.T) {
	dir := t.TempDir()
	addr := filepath.Join(dir, "a.json")
	os.WriteFile(addr, []byte(`{"closed":true,"pid":1}`), 0o600)
	out := &syncBuffer{}
	f, _ := newForwarder(addr, "", out)
	f.retryFor = 10 * time.Second
	start := time.Now()
	f.run(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"publish"}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n" + `{"jsonrpc":"2.0","method":"notifications/x"}` + "\n"))
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("waited %v for a closed AIB", took)
	}
	lines := out.lines()
	if len(lines) != 2 {
		t.Fatalf("want two answers, got %v", lines)
	}
	byID := map[string]map[string]any{}
	for _, l := range lines {
		var m map[string]any
		json.Unmarshal([]byte(l), &m)
		byID[itoa(int(m["id"].(float64)))] = m
	}
	call := byID["1"]["result"].(map[string]any)
	text := call["content"].([]any)[0].(map[string]any)["text"].(string)
	if call["isError"] != true || !strings.Contains(text, "AIB is closed") || !strings.Contains(text, "try again later") {
		t.Fatalf("tools/call answer %v", byID["1"])
	}
	if e := byID["2"]["error"].(map[string]any); !strings.Contains(e["message"].(string), "AIB is closed") {
		t.Fatalf("tools/list answer %v", byID["2"])
	}
}

func TestMcpForwardRefusesNonLoopback(t *testing.T) {
	dir := t.TempDir()
	addr := filepath.Join(dir, "a.json")
	writeAddress(t, addr, "http://example.com/mcp")
	f, _ := newForwarder(addr, "", io.Discard)
	if _, err := f.endpoint(); err == nil {
		t.Fatal("a non-loopback URL was accepted")
	}
}

func TestMcpForwardNeverResendsADeliveredMessage(t *testing.T) {
	dir := t.TempDir()
	addr := filepath.Join(dir, "a.json")
	var hits atomic.Int32
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		hj, _ := w.(http.Hijacker)
		c, _, _ := hj.Hijack()
		c.Close() // delivered, then the connection breaks (an AIB exiting mid-request)
	})}
	go srv.Serve(l)
	defer srv.Close()
	writeAddress(t, addr, "http://"+l.Addr().String()+"/mcp")
	out := &syncBuffer{}
	f, _ := newForwarder(addr, "", out)
	f.retryFor = 2 * time.Second
	f.run(strings.NewReader(`{"jsonrpc":"2.0","id":3,"method":"tools/call"}` + "\n"))
	if hits.Load() != 1 {
		t.Fatalf("sent %d times", hits.Load())
	}
	if lines := out.lines(); len(lines) != 1 || !strings.Contains(lines[0], `"id":3`) {
		t.Fatalf("want one error for id 3, got %v", lines)
	}
}

func waitFor(t *testing.T, ok func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
