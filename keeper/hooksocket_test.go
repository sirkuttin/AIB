package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// tunnelServer stands in for the WSL helper's tunnel socket (<data>/helper/mcp.sock): it reads each request line and answers with
// handle's tunnel status and body. Returns the socket path and the request lines it took.
func tunnelServer(t *testing.T, handle func(req map[string]any) (int, string)) (string, *[]map[string]any) {
	t.Helper()
	dir, err := os.MkdirTemp("", "ht")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	os.MkdirAll(filepath.Join(dir, "helper"), 0o700)
	socket := filepath.Join(dir, "helper", "mcp.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Skipf("no unix sockets here: %v", err)
	}
	t.Cleanup(func() { l.Close() })
	var mu sync.Mutex
	seen := &[]map[string]any{}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				line, _ := bufio.NewReader(c).ReadBytes('\n')
				var req map[string]any
				json.Unmarshal(line, &req)
				mu.Lock()
				*seen = append(*seen, req)
				mu.Unlock()
				status, body := handle(req)
				out, _ := json.Marshal(map[string]any{"status": status, "body": body})
				c.Write(append(out, '\n'))
			}(c)
		}
	}()
	return socket, seen
}

// envelope: AIB's signed hook answer inside the tunnel's body (server/host/studio.ts wslHookCall).
func envelope(req map[string]any, status int, body string) (int, string) {
	headers, _ := req["headers"].(map[string]any)
	nonce, _ := headers[hookNonceHeader].(string)
	out, _ := json.Marshal(map[string]any{"status": status, "body": body, "proof": hookProof(testHookKey, nonce, status, []byte(body))})
	return 200, string(out)
}

func runSocketHook(t *testing.T, event, socket, input string, deadline time.Duration) (int, string, string) {
	t.Helper()
	h := &hookForwarder{event: event, addressFile: socket, socket: socket, key: testHookKey, chat: "c-1", readOnly: splitList("Explore,Plan"), deadline: deadline}
	var out, errb strings.Builder
	code := h.run(strings.NewReader(input), &out, &errb)
	return code, out.String(), errb.String()
}

func TestHookSocketForwardsHeadersAndPrintsAIBsAnswer(t *testing.T) {
	socket, seen := tunnelServer(t, func(req map[string]any) (int, string) { return envelope(req, 200, isolatedAnswer) })
	code, out, errText := runSocketHook(t, "pre-tool", socket, agentCall, 5*time.Second)
	if code != 0 {
		t.Fatalf("code %d out %q err %q", code, out, errText)
	}
	var got, want any
	json.Unmarshal([]byte(out), &got)
	json.Unmarshal([]byte(isolatedAnswer), &want)
	if !jsonEqual(got, want) {
		t.Fatalf("out %q", out)
	}
	if len(*seen) != 1 {
		t.Fatalf("requests %v", *seen)
	}
	req := (*seen)[0]
	headers := req["headers"].(map[string]any)
	if headers[hookKeyHeader] != testHookKey || headers[hookChatHeader] != "c-1" || headers[hookEventHeader] != "pre-tool" || len(headers[hookNonceHeader].(string)) != 64 {
		t.Fatalf("headers %v", headers)
	}
	if req["body"] != agentCall {
		t.Fatalf("body %v", req["body"])
	}
}

func TestHookSocketReadOnlyAgentPassesWithoutAsking(t *testing.T) {
	socket, seen := tunnelServer(t, func(req map[string]any) (int, string) { return envelope(req, 200, `{}`) })
	call := `{"tool_name":"Agent","tool_input":{"subagent_type":"Explore","prompt":"x"}}`
	if code, out, _ := runSocketHook(t, "pre-tool", socket, call, 5*time.Second); code != 0 || out != "" {
		t.Fatalf("code %d out %q", code, out)
	}
	if len(*seen) != 0 {
		t.Fatalf("asked AIB: %v", *seen)
	}
}

func TestHookSocketRefusesAnswersNotSignedByAIB(t *testing.T) {
	cases := map[string]func(req map[string]any) (int, string){
		"no proof": func(req map[string]any) (int, string) {
			out, _ := json.Marshal(map[string]any{"status": 200, "body": isolatedAnswer})
			return 200, string(out)
		},
		"proof of another key": func(req map[string]any) (int, string) {
			headers := req["headers"].(map[string]any)
			out, _ := json.Marshal(map[string]any{"status": 200, "body": isolatedAnswer, "proof": hookProof("another", headers[hookNonceHeader].(string), 200, []byte(isolatedAnswer))})
			return 200, string(out)
		},
		"proof of another status": func(req map[string]any) (int, string) {
			headers := req["headers"].(map[string]any)
			out, _ := json.Marshal(map[string]any{"status": 200, "body": isolatedAnswer, "proof": hookProof(testHookKey, headers[hookNonceHeader].(string), 409, []byte(isolatedAnswer))})
			return 200, string(out)
		},
		"not an envelope":   func(req map[string]any) (int, string) { return 200, isolatedAnswer },
		"tunnel says away":  func(req map[string]any) (int, string) { return 503, "" },
		"tunnel says no":    func(req map[string]any) (int, string) { return 401, "" },
		"signed allow-ish":  func(req map[string]any) (int, string) { return envelope(req, 200, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`) },
		"AIB says 500":      func(req map[string]any) (int, string) { return envelope(req, 500, "boom") },
		"signed other tool": func(req map[string]any) (int, string) { return envelope(req, 200, `{}`) },
	}
	for name, handle := range cases {
		socket, _ := tunnelServer(t, handle)
		code, out, errText := runSocketHook(t, "pre-tool", socket, agentCall, 2*time.Second)
		if code != 2 || out != "" || errText == "" {
			t.Errorf("%s: code %d out %q err %q", name, code, out, errText)
		}
	}
}

func TestHookSocketBlocksWhenNothingListens(t *testing.T) {
	dir, _ := os.MkdirTemp("", "ht")
	t.Cleanup(func() { os.RemoveAll(dir) })
	start := time.Now()
	code, out, errText := runSocketHook(t, "pre-tool", filepath.Join(dir, "helper", "mcp.sock"), agentCall, time.Second)
	if code != 2 || out != "" || !strings.Contains(errText, "restarting") || time.Since(start) > 4*time.Second {
		t.Fatalf("code %d out %q err %q after %v", code, out, errText, time.Since(start))
	}
}

func TestHookSocketHintsNeverBlock(t *testing.T) {
	socket, seen := tunnelServer(t, func(req map[string]any) (int, string) { return envelope(req, 200, `{}`) })
	if code, out, _ := runSocketHook(t, "subagent-stop", socket, `{"agent_id":"a1","agent_type":"x"}`, 5*time.Second); code != 0 || out != "" {
		t.Fatalf("code %d out %q", code, out)
	}
	if len(*seen) != 1 || (*seen)[0]["headers"].(map[string]any)[hookEventHeader] != "subagent-stop" {
		t.Fatalf("requests %v", *seen)
	}
	away, _ := tunnelServer(t, func(req map[string]any) (int, string) { return 503, "" })
	if code, out, _ := runSocketHook(t, "post-agent", away, `{}`, 2*time.Second); code != 0 || out != "" {
		t.Fatalf("hint with AIB away: code %d out %q", code, out)
	}
}

// worktree-create prints only a sub-* folder AIB made under <data>/worktrees/<repo hash>/ (the root is named by the socket's place).
func TestHookSocketWorktreeCreateChecksThePathAgainstTheDistrosFolder(t *testing.T) {
	var path string
	socket, _ := tunnelServer(t, func(req map[string]any) (int, string) { return envelope(req, 200, path) })
	data := filepath.Dir(filepath.Dir(socket))
	good := filepath.Join(data, "worktrees", "0123456789ab", "sub-c1-1")
	os.MkdirAll(good, 0o700)
	path = good
	if code, out, errText := runSocketHook(t, "worktree-create", socket, `{"name":"agent-a1"}`, 5*time.Second); code != 0 || out != good {
		t.Fatalf("code %d out %q err %q", code, out, errText)
	}
	elsewhere := filepath.Join(t.TempDir(), "worktrees", "0123456789ab", "sub-c1-1")
	os.MkdirAll(elsewhere, 0o700)
	path = elsewhere
	if code, out, _ := runSocketHook(t, "worktree-create", socket, `{"name":"agent-a1"}`, 5*time.Second); code != 2 || out != "" {
		t.Fatalf("a folder outside the distro's worktrees: code %d out %q", code, out)
	}
	path = filepath.Join(data, "worktrees", "0123456789ab", "sub-missing")
	if code, out, _ := runSocketHook(t, "worktree-create", socket, `{"name":"agent-a1"}`, 5*time.Second); code != 2 || out != "" {
		t.Fatalf("a folder that is not there: code %d out %q", code, out)
	}
}

func TestHookSocketCodexDenyStaysAJSONDenyWhenAIBIsAway(t *testing.T) {
	away, _ := tunnelServer(t, func(req map[string]any) (int, string) { return 503, "" })
	code, out, _ := runSocketHook(t, "codex-pre-tool", away, `{"tool_name":"spawn_agent","tool_input":{}}`, 2*time.Second)
	if code != 0 || !strings.Contains(out, "deny") {
		t.Fatalf("code %d out %q", code, out)
	}
}

func TestHookMainParsesTheSocketForm(t *testing.T) {
	// a bad form is a usage error (2), never a hook that runs against nothing
	if code := hookMain([]string{"pre-tool", "--helper-socket"}); code != 2 {
		t.Fatalf("code %d", code)
	}
	if code := hookMain([]string{"nope", "--helper-socket", "/x/y"}); code != 2 {
		t.Fatalf("code %d", code)
	}
}
