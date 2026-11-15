package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A relay in this process with a fake helper on its stdio: answer decides what the helper says to each request (nil: no answer,
// the connection is dropped by closing the relay's side).
type relayLab struct {
	socket string
	reqs   atomic.Int32
	gone   atomic.Int32
	stop   func()
}

func startRelay(t *testing.T, answer func(req map[string]any) map[string]any) *relayLab {
	t.Helper()
	dir, err := os.MkdirTemp("", "aibrl")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "h", "mcp.sock")
	l, err := relayListen(socket)
	if err != nil {
		os.RemoveAll(dir)
		t.Skipf("no unix sockets here: %v", err)
	}
	outR, outW := io.Pipe()
	inR, inW := io.Pipe()
	r := &relay{out: outW, conns: map[int64]net.Conn{}}
	go r.serve(l)
	go r.answers(inR)
	lab := &relayLab{socket: socket}
	go func() {
		reader := bufio.NewReader(outR)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var msg struct {
				C    int64          `json:"c"`
				Req  map[string]any `json:"req"`
				Gone bool           `json:"gone"`
			}
			json.Unmarshal(line, &msg)
			if msg.Gone {
				lab.gone.Add(1)
				continue
			}
			if msg.Req == nil {
				continue
			}
			lab.reqs.Add(1)
			go func(c int64, req map[string]any) { // answers come in any order, as the helper's do
				res := answer(req)
				if res == nil {
					r.drop(c)
					return
				}
				out, _ := json.Marshal(map[string]any{"c": c, "res": res})
				inW.Write(append(out, '\n'))
			}(msg.C, msg.Req)
		}
	}()
	lab.stop = func() {
		l.Close()
		inW.Close()
		outW.Close()
		r.closeAll()
		os.RemoveAll(dir)
	}
	t.Cleanup(lab.stop)
	return lab
}

func socketForwarder(t *testing.T, socket string, out io.Writer) *forwarder {
	t.Helper()
	f, err := newSocketForwarder(socket, `{"X-Studio-Artifact-Key":"k1","X-Studio-Conversation-Id":"c1"}`, out)
	if err != nil {
		t.Fatal(err)
	}
	f.retryFor = 2 * time.Second
	return f
}

func TestMcpForwardHelperSocketRelaysWithHeaders(t *testing.T) {
	lab := startRelay(t, func(req map[string]any) map[string]any {
		var m map[string]any
		json.Unmarshal([]byte(req["body"].(string)), &m)
		if _, ok := m["id"]; !ok {
			return map[string]any{"status": 202}
		}
		h := req["headers"].(map[string]any)
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m["id"], "result": map[string]any{"key": h["X-Studio-Artifact-Key"], "conv": h["X-Studio-Conversation-Id"]}})
		return map[string]any{"status": 200, "body": string(body)}
	})
	out := &syncBuffer{}
	f := socketForwarder(t, lab.socket, out)
	f.run(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n" + `{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
		`{"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"list"}}` + "\n"))
	lines := out.lines()
	if len(lines) != 2 || lab.reqs.Load() != 3 {
		t.Fatalf("want two answers for three messages, got %v (%d requests)", lines, lab.reqs.Load())
	}
	for _, l := range lines {
		if !strings.Contains(l, `"key":"k1"`) || !strings.Contains(l, `"conv":"c1"`) {
			t.Fatalf("headers did not reach the helper: %s", l)
		}
	}
}

// AIB refused the key (the helper passes AIB's 401 on): a JSON-RPC error naming the status, sent once.
func TestMcpForwardHelperSocketPassesARefusalOn(t *testing.T) {
	lab := startRelay(t, func(req map[string]any) map[string]any {
		return map[string]any{"status": 401, "body": `{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"AIB refused the artifact key for this conversation"}}`}
	})
	out := &syncBuffer{}
	socketForwarder(t, lab.socket, out).run(strings.NewReader(`{"jsonrpc":"2.0","id":5,"method":"tools/list"}` + "\n"))
	lines := out.lines()
	if len(lines) != 1 || !strings.Contains(lines[0], `"id":5`) || !strings.Contains(lines[0], "HTTP 401") || !strings.Contains(lines[0], "refused the artifact key") {
		t.Fatalf("want one refusal for id 5, got %v", lines)
	}
	if lab.reqs.Load() != 1 {
		t.Fatalf("sent %d times", lab.reqs.Load())
	}
}

// The helper says AIB cannot take it (503 with a message): answered at once, a tools/call as a tool result with isError.
func TestMcpForwardHelperSocketAibAway(t *testing.T) {
	lab := startRelay(t, func(req map[string]any) map[string]any {
		return map[string]any{"status": 503, "error": "AIB is closed, so this tool cannot answer now. Try again later."}
	})
	out := &syncBuffer{}
	f := socketForwarder(t, lab.socket, out)
	f.retryFor = 10 * time.Second
	start := time.Now()
	f.run(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"publish"}}` + "\n" + `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n"))
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("waited %v", took)
	}
	lines := out.lines()
	if len(lines) != 2 || lab.reqs.Load() != 2 {
		t.Fatalf("want two answers, got %v", lines)
	}
	for _, l := range lines {
		var m map[string]any
		json.Unmarshal([]byte(l), &m)
		if m["id"].(float64) == 1 {
			res := m["result"].(map[string]any)
			if res["isError"] != true || !strings.Contains(l, "AIB is closed") {
				t.Fatalf("tools/call answer %s", l)
			}
		} else if e, ok := m["error"].(map[string]any); !ok || !strings.Contains(e["message"].(string), "AIB is closed") {
			t.Fatalf("tools/list answer %s", l)
		}
	}
}

// No socket (the helper is not running): retried until retryFor, then "AIB is not running"; a dropped connection after delivery is
// never sent again.
func TestMcpForwardHelperSocketMissingAndBroken(t *testing.T) {
	out := &syncBuffer{}
	f := socketForwarder(t, filepath.Join(t.TempDir(), "none.sock"), out)
	f.retryFor = 600 * time.Millisecond
	f.run(strings.NewReader(`{"jsonrpc":"2.0","id":9,"method":"tools/list"}` + "\n"))
	if lines := out.lines(); len(lines) != 1 || !strings.Contains(lines[0], `"id":9`) || !strings.Contains(lines[0], "AIB is not running") {
		t.Fatalf("want one error for id 9, got %v", lines)
	}

	lab := startRelay(t, func(req map[string]any) map[string]any { return nil })
	out2 := &syncBuffer{}
	socketForwarder(t, lab.socket, out2).run(strings.NewReader(`{"jsonrpc":"2.0","id":3,"method":"tools/call"}` + "\n"))
	if lab.reqs.Load() != 1 {
		t.Fatalf("sent %d times", lab.reqs.Load())
	}
	if lines := out2.lines(); len(lines) != 1 || !strings.Contains(lines[0], `"id":3`) || !strings.Contains(lines[0], "broke") {
		t.Fatalf("want one error for id 3, got %v", lines)
	}
}

// The relay: a line that is not JSON is answered there and never passed on; a forwarder that leaves before its answer is reported.
func TestMcpRelayRefusesNonJSONAndReportsGone(t *testing.T) {
	lab := startRelay(t, func(req map[string]any) map[string]any {
		time.Sleep(10 * time.Second) // never answers in time
		return nil
	})
	c, err := dialUnix(lab.socket)
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("not json\n"))
	answer, _ := bufio.NewReader(c).ReadString('\n')
	c.Close()
	if !strings.Contains(answer, `"status":400`) {
		t.Fatalf("answer %q", answer)
	}
	c2, err := dialUnix(lab.socket)
	if err != nil {
		t.Fatal(err)
	}
	c2.Write([]byte(`{"headers":{},"body":"{}"}` + "\n"))
	waitFor(t, func() bool { return lab.reqs.Load() == 1 }, "the request passed on")
	c2.Close()
	waitFor(t, func() bool { return lab.gone.Load() == 1 }, "gone reported")
}

func TestMcpRelayRefusesBadPaths(t *testing.T) {
	if _, err := relayListen("relative/mcp.sock"); err == nil {
		t.Fatal("a relative path was accepted")
	}
	if _, err := relayListen("/" + strings.Repeat("x", 120)); err == nil {
		t.Fatal("a too-long path was accepted")
	}
	file := filepath.Join(t.TempDir(), "plain")
	os.WriteFile(file, []byte("x"), 0o600)
	if _, err := relayListen(file); err == nil {
		t.Fatal("a plain file was replaced")
	}
}

func dialUnix(path string) (net.Conn, error) { return net.DialTimeout("unix", path, 2*time.Second) }
