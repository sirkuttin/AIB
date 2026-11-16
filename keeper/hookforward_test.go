package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// hookServer serves handler on loopback and writes its address file (as AIB's artifact-mcp.json); returns the file.
func hookServer(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	file := filepath.Join(t.TempDir(), "artifact-mcp.json")
	os.WriteFile(file, []byte(`{"url":"http://`+l.Addr().String()+`/mcp","pid":1}`), 0o600)
	return file
}

func deadAddress(t *testing.T) string {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	file := filepath.Join(t.TempDir(), "artifact-mcp.json")
	os.WriteFile(file, []byte(`{"url":"http://`+addr+`/mcp","pid":1}`), 0o600)
	return file
}

func runHook(t *testing.T, event, file, input string, deadline time.Duration) (int, string, string) {
	t.Helper()
	h := &hookForwarder{event: event, addressFile: file, key: "k-123", chat: "c-1", readOnly: splitList("Explore,Plan"), deadline: deadline}
	var out, errb bytes.Buffer
	code := h.run(strings.NewReader(input), &out, &errb)
	return code, out.String(), errb.String()
}

const agentCall = `{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"general-purpose","prompt":"x"}}`

func TestHookPreToolPassesAIBAnswerAndKey(t *testing.T) {
	var seen http.Header
	var path string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		seen, path = r.Header.Clone(), r.URL.Path
		io.ReadAll(r.Body)
		w.Write([]byte(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"isolation":"worktree"}}}`))
	})
	code, out, _ := runHook(t, "pre-tool", file, agentCall, 5*time.Second)
	if code != 0 || !strings.Contains(out, `"isolation":"worktree"`) {
		t.Fatalf("code %d out %q", code, out)
	}
	if path != "/hooks/claude/pre-tool" || seen.Get(hookKeyHeader) != "k-123" || seen.Get(hookChatHeader) != "c-1" {
		t.Fatalf("path %q headers %v", path, seen)
	}
}

func TestHookFailsClosedWhenAIBIsDown(t *testing.T) {
	code, out, errText := runHook(t, "pre-tool", deadAddress(t), agentCall, 1500*time.Millisecond)
	if code != 2 || out != "" || !strings.Contains(errText, hookRestarting) {
		t.Fatalf("code %d out %q err %q", code, out, errText)
	}
	code, _, errText = runHook(t, "worktree-create", filepath.Join(t.TempDir(), "missing.json"), `{"name":"agent-a1"}`, 800*time.Millisecond)
	if code != 2 || !strings.Contains(errText, hookRestarting) {
		t.Fatalf("missing address file: code %d err %q", code, errText)
	}
}

func TestHookClosedAIBFailsAtOnce(t *testing.T) {
	file := filepath.Join(t.TempDir(), "artifact-mcp.json")
	os.WriteFile(file, []byte(`{"closed":true,"pid":1}`), 0o600)
	start := time.Now()
	code, _, _ := runHook(t, "pre-tool", file, agentCall, 5*time.Second)
	if code != 2 || time.Since(start) > 2*time.Second {
		t.Fatalf("code %d after %v", code, time.Since(start))
	}
}

func TestHookSlowAIBFailsClosedBeforeDeadline(t *testing.T) {
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
		w.Write([]byte(`{}`))
	})
	start := time.Now()
	code, _, errText := runHook(t, "pre-tool", file, agentCall, 700*time.Millisecond)
	if code != 2 || !strings.Contains(errText, hookRestarting) || time.Since(start) > 2*time.Second {
		t.Fatalf("code %d err %q after %v", code, errText, time.Since(start))
	}
}

func TestHookNon200FailsClosed(t *testing.T) {
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", 500) })
	if code, _, _ := runHook(t, "pre-tool", file, agentCall, 2*time.Second); code != 2 {
		t.Fatalf("500: code %d", code)
	}
	if code, _, _ := runHook(t, "post-agent", file, agentCall, 2*time.Second); code != 0 {
		t.Fatalf("post-agent fails open: code %d", code)
	}
}

func TestHookReadOnlyAndRemotePassWithoutAIB(t *testing.T) {
	dead := deadAddress(t)
	for _, input := range []string{
		`{"tool_name":"Agent","tool_input":{"subagent_type":"Explore"}}`,
		`{"tool_name":"Task","tool_input":{"subagent_type":"Plan"}}`,
		`{"tool_name":"Agent","tool_input":{"subagent_type":"general-purpose","isolation":"remote"}}`,
	} {
		if code, out, _ := runHook(t, "pre-tool", dead, input, time.Second); code != 0 || out != "" {
			t.Fatalf("%s: code %d out %q", input, code, out)
		}
	}
	// no type = general-purpose; another tool name is never decided here
	for _, input := range []string{`{"tool_name":"Agent","tool_input":{}}`, `{"tool_name":"EnterWorktree","tool_input":{"subagent_type":"Explore"}}`} {
		if code, _, _ := runHook(t, "pre-tool", dead, input, 600*time.Millisecond); code != 2 {
			t.Fatalf("%s: code %d", input, code)
		}
	}
}

func TestHookWorktreeCreatePrintsBarePathOrRefusal(t *testing.T) {
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("C:/wt/sub-1\n"))
	})
	code, out, _ := runHook(t, "worktree-create", file, `{"name":"agent-a1"}`, 2*time.Second)
	if code != 0 || out != "C:/wt/sub-1" {
		t.Fatalf("code %d out %q", code, out)
	}
	refuse := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte("AIB didn't expect this worktree"))
	})
	code, out, errText := runHook(t, "worktree-create", refuse, `{"name":"x"}`, 2*time.Second)
	if code != 2 || out != "" || !strings.Contains(errText, "AIB didn't expect this worktree") {
		t.Fatalf("code %d out %q err %q", code, out, errText)
	}
}

func TestHookWithoutKeyFailsClosed(t *testing.T) {
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) })
	h := &hookForwarder{event: "pre-tool", addressFile: file, readOnly: map[string]bool{}, deadline: time.Second}
	var out, errb bytes.Buffer
	if code := h.run(strings.NewReader(agentCall), &out, &errb); code != 2 {
		t.Fatalf("code %d", code)
	}
}
