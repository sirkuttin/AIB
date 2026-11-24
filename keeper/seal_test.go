package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Security item 7: what an agent of this user can read must never give it the keeper.

func TestSealRoundTripAndPurposes(t *testing.T) {
	s, err := sealText(sealHookKey, "k-123")
	if err != nil {
		t.Fatal(err)
	}
	if !canSeal {
		if s != "k-123" {
			t.Fatalf("no DPAPI here: the value stays plain, got %q", s)
		}
		if _, err := openSealed(sealHookKey, sealPrefix+"AAAA"); err == nil {
			t.Fatal("a sealed value must not open without DPAPI")
		}
		return
	}
	if !strings.HasPrefix(s, sealPrefix) || strings.Contains(s, "k-123") {
		t.Fatalf("not sealed: %q", s)
	}
	if got, err := openSealed(sealHookKey, s); err != nil || got != "k-123" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := openSealed(sealForwardHeader, s); err == nil {
		t.Fatal("a value sealed for one purpose opened as another")
	}
	if got, _ := openSealed(sealHookKey, "plain"); got != "plain" {
		t.Fatalf("a plain value (an older AIB) must pass through, got %q", got)
	}
	if _, err := openSealed(sealHookKey, sealPrefix+"!!"); err == nil {
		t.Fatal("damaged value opened")
	}
}

func TestForwardersOpenSealedEnv(t *testing.T) {
	plain := `{"X-Studio-Artifact-Key":"abc","X-Studio-Conversation-Id":"c1"}`
	sealed, _ := sealText(sealForwardHeader, plain)
	t.Setenv("MCP_FORWARD_HEADERS", sealed)
	if got := openedEnv(sealForwardHeader, "MCP_FORWARD_HEADERS"); got != plain {
		t.Fatalf("headers: %q", got)
	}
	t.Setenv("AIB_HOOK_KEY", "plain-key")
	if got := openedEnv(sealHookKey, "AIB_HOOK_KEY"); got != "plain-key" {
		t.Fatalf("plain hook key: %q", got)
	}
	if canSeal {
		t.Setenv("AIB_HOOK_KEY", sealed) // sealed for the headers, not for a hook key
		if got := openedEnv(sealHookKey, "AIB_HOOK_KEY"); got != "" {
			t.Fatalf("a key sealed for another purpose must be dropped, got %q", got)
		}
	}
	if line := checkLine("hook 2"); !strings.HasPrefix(line, "hook 2") || strings.HasSuffix(line, " sealed") != canSeal {
		t.Fatalf("check line %q", line)
	}
}

// The file an agent finds: on Windows keeper.json carries no usable token at all.
func TestKeeperJSONHidesTheToken(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	b, err := os.ReadFile(filepath.Join(k.data, "keeper", "keeper.json"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	json.Unmarshal(b, &raw)
	token := infoToken(raw)
	if len(token) != 64 {
		t.Fatalf("AIB cannot read the token: %v", raw)
	}
	if runtime.GOOS == "windows" {
		if _, ok := raw["token"]; ok || strings.Contains(string(b), token) {
			t.Fatalf("keeper.json shows the token in the clear: %s", b)
		}
		if s, _ := raw["tokenSealed"].(string); !strings.HasPrefix(s, sealPrefix) {
			t.Fatalf("no sealed token: %s", b)
		}
	}
	dial(t, k) // AIB's way in still works
}

// An agent the keeper runs reads keeper.json and tries hello, directly and from a process that left its parent: refused either way
// (Windows: it finds no token, bad_token; Linux: it is under a channel, bad_peer).
func TestAChannelCannotTakeTheKeeper(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	c := dial(t, k)
	file := filepath.Join(k.data, "keeper", "keeper.json")
	want := errBadToken
	if runtime.GOOS == "linux" {
		want = errBadPeer
	}
	for _, mode := range [][]string{{"steal", file}, {"steal", file, "detach"}} {
		id := "thief-" + itoa(len(mode))
		c.must("spawn", map[string]any{"channel": id, "command": agentBin, "args": mode, "cwd": t.TempDir()}, nil)
		c.must("attach", map[string]any{"channel": id, "from": 0}, nil)
		out := c.outputUntil(id, 15*time.Second, "out", `"stole"`)
		if strings.Contains(out, `"ok":true`) || !strings.Contains(out, `"error":"`+want+`"`) {
			t.Fatalf("%v: the agent got in, or not refused as %s: %s", mode, want, out)
		}
	}
	// The keeper still serves AIB afterwards.
	c2 := dial(t, k)
	c2.must("list", nil, nil)
}
