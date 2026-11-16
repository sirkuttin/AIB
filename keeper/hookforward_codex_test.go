package main

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func codexCall(tool, agent, command string) string {
	in := map[string]any{"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": map[string]any{"command": command}}
	if agent != "" {
		in["agent_id"] = agent
		in["agent_type"] = "default"
	}
	b, _ := json.Marshal(in)
	return string(b)
}

func allowCommand(command string) string {
	b, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": map[string]any{"command": command},
	}})
	return string(b)
}

func TestCodexMainAgentToolsPassWithoutAIB(t *testing.T) {
	file := deadAddress(t)
	code, out, _ := runHook(t, "codex-pre-tool", file, codexCall("Bash", "", "ls"), 2*time.Second)
	if code != 0 || out != "" {
		t.Fatalf("main agent's Bash: %d %q", code, out)
	}
	// spawn_agent and every subagent call need AIB: down -> blocked
	for _, in := range []string{codexCall("spawn_agent", "", ""), codexCall("Bash", "a-1", "ls"), codexCall("view_image", "a-1", "")} {
		if code, _, errb := runHook(t, "codex-pre-tool", file, in, 600*time.Millisecond); code != 2 || !strings.Contains(errb, "restarting") {
			t.Fatalf("%s with AIB down: %d %q", in, code, errb)
		}
	}
}

func TestCodexHooksUseTheirOwnRoute(t *testing.T) {
	var path string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		path = r.URL.Path
		signed(w, r, 200, `{}`)
	})
	if code, _, _ := runHook(t, "codex-pre-tool", file, codexCall("spawn_agent", "", ""), 2*time.Second); code != 0 || path != "/hooks/codex/pre-tool" {
		t.Fatalf("%d %q", code, path)
	}
	runHook(t, "codex-subagent-stop", file, `{"agent_id":"a"}`, 2*time.Second)
	if path != "/hooks/codex/subagent-stop" {
		t.Fatal(path)
	}
}

func TestCodexPreToolAnswerShape(t *testing.T) {
	var answer string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		signed(w, r, 200, answer)
	})
	wt := worktreeFolder(t, file, "sub-abc-1")
	fwd := filepath.ToSlash(wt)
	other := filepath.Join(t.TempDir(), "sub-x")
	sep := string(filepath.Separator)
	cases := []struct {
		name, input, answer string
		code                int
		out                 string
	}{
		{"spawn {}", codexCall("spawn_agent", "", ""), `{}`, 0, ""},
		{"sub bash {} refused", codexCall("Bash", "a", "echo hi"), `{}`, 2, ""},
		{"sub bash redirected", codexCall("Bash", "a", "echo hi"), allowCommand("cd '" + fwd + "'; echo hi"), 0, allowCommand("cd '" + fwd + "'; echo hi")},
		{"sub bash other command", codexCall("Bash", "a", "echo hi"), allowCommand("cd '" + fwd + "'; rm -rf x"), 2, ""},
		{"sub bash other folder", codexCall("Bash", "a", "echo hi"), allowCommand("cd '" + filepath.ToSlash(other) + "'; echo hi"), 2, ""},
		{"main call allow", codexCall("spawn_agent", "", "echo hi"), allowCommand("cd '" + fwd + "'; echo hi"), 2, ""},
		{"sub patch allow", codexCall("apply_patch", "a", "echo hi"), allowCommand("cd '" + fwd + "'; echo hi"), 2, ""},
		{"deny", codexCall("Bash", "a", "echo hi"), denyAnswer, 0, denyAnswer},
		{"deny empty reason", codexCall("Bash", "a", "x"), `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":" "}}`, 2, ""},
		{"html", codexCall("spawn_agent", "", ""), `<html>`, 2, ""},
		{"extra key", codexCall("spawn_agent", "", ""), `{"continue":false}`, 2, ""},
		{"patch inside", codexCall("apply_patch", "a", "*** Begin Patch\n*** Add File: "+filepath.Join(wt, "f.txt")+"\n+x\n*** End Patch"), `{}`, 0, ""},
		{"patch relative", codexCall("apply_patch", "a", "*** Begin Patch\n*** Add File: f.txt\n+x\n*** End Patch"), `{}`, 2, ""},
		{"patch move out", codexCall("apply_patch", "a", "*** Begin Patch\n*** Update File: "+filepath.Join(wt, "f.txt")+"\n*** Move to: "+filepath.Join(other, "f.txt")+"\n*** End Patch"), `{}`, 2, ""},
		{"patch dotdot", codexCall("apply_patch", "a", "*** Begin Patch\n*** Add File: "+wt+sep+".."+sep+"f.txt\n*** End Patch"), `{}`, 2, ""},
		{"sub other tool {}", codexCall("view_image", "a", ""), `{}`, 0, ""},
	}
	for _, c := range cases {
		answer = c.answer
		code, out, _ := runHook(t, "codex-pre-tool", file, c.input, 2*time.Second)
		if code != c.code || (c.code == 0 && !jsonSame(out, c.out)) {
			t.Errorf("%s: code %d out %q, want %d %q", c.name, code, out, c.code, c.out)
		}
	}
}

func jsonSame(a, b string) bool {
	if a == "" || b == "" {
		return a == b
	}
	var x, y any
	return json.Unmarshal([]byte(a), &x) == nil && json.Unmarshal([]byte(b), &y) == nil && jsonEqual(x, y)
}

func TestCodexSubagentStartPrintsOnlyContext(t *testing.T) {
	ctx := `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"your folder is X"}}`
	if code, out, _ := runHook(t, "codex-subagent-start", answering(t, 200, ctx), `{"agent_id":"a"}`, 2*time.Second); code != 0 || !jsonSame(out, ctx) {
		t.Fatalf("%d %q", code, out)
	}
	for _, bad := range []string{`{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"x","decision":"block"}}`, `{"continue":false}`, `x`} {
		if code, out, _ := runHook(t, "codex-subagent-start", answering(t, 200, bad), `{"agent_id":"a"}`, 2*time.Second); code != 0 || out != "" {
			t.Fatalf("%s: %d %q", bad, code, out)
		}
	}
	if code, out, _ := runHook(t, "codex-subagent-stop", answering(t, 200, ctx), `{"agent_id":"a"}`, 2*time.Second); code != 0 || out != "" {
		t.Fatalf("stop printed %q", out)
	}
}
