package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func qwenCall(tool, agent string, input map[string]any) string {
	in := map[string]any{"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input}
	if agent != "" {
		in["agent_id"] = agent
	}
	b, _ := json.Marshal(in)
	return string(b)
}

func qwenAllow(input map[string]any) string {
	b, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "AIB: the subagent's own worktree", "updatedInput": input,
	}})
	return string(b)
}

func TestQwenMainAgentToolsPassWithoutAIB(t *testing.T) {
	file := deadAddress(t)
	if code, out, _ := runHook(t, "qwen-pre-tool", file, qwenCall("write_file", "", map[string]any{"file_path": "x"}), 2*time.Second); code != 0 || out != "" {
		t.Fatalf("main agent's write_file: %d %q", code, out)
	}
	// an agent call of a read-only type AIB listed passes without AIB (the main agent's or a subagent's); its own calls go to AIB
	for _, agent := range []string{"", "general-purpose-t1"} {
		if code, out, _ := runHook(t, "qwen-pre-tool", file, qwenCall("agent", agent, map[string]any{"subagent_type": "Explore", "prompt": "p"}), 2*time.Second); code != 0 || out != "" {
			t.Fatalf("Explore from %q: %d %q", agent, code, out)
		}
	}
	// `agent` and every subagent call need AIB: down -> a JSON deny, exit 0
	for _, in := range []string{qwenCall("agent", "", map[string]any{}), qwenCall("Agent", "", map[string]any{}), qwenCall("run_shell_command", "a-1", map[string]any{"command": "ls"}), qwenCall("read_file", "a-1", nil)} {
		code, out, errb := runHook(t, "qwen-pre-tool", file, in, 600*time.Millisecond)
		if code != 0 || !jsonSame(out, string(codexDeny(hookRestarting))) || !strings.Contains(errb, "restarting") {
			t.Fatalf("%s with AIB down: %d %q %q", in, code, out, errb)
		}
	}
}

func TestQwenKillByNameRefusedLocally(t *testing.T) {
	file := deadAddress(t)
	code, out, _ := runHook(t, "qwen-pre-tool", file, qwenCall("run_shell_command", "", map[string]any{"command": "taskkill /F /IM node.exe"}), 2*time.Second)
	if code != 0 || !strings.Contains(out, `"permissionDecision":"deny"`) {
		t.Fatalf("%d %q", code, out)
	}
}

func TestQwenHooksUseTheirOwnRoute(t *testing.T) {
	var path string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		path = r.URL.Path
		signed(w, r, 200, `{}`)
	})
	runHook(t, "qwen-pre-tool", file, qwenCall("read_file", "a", nil), 2*time.Second)
	if path != "/hooks/qwen/pre-tool" {
		t.Fatal(path)
	}
	runHook(t, "qwen-subagent-stop", file, `{"agent_id":"a"}`, 2*time.Second)
	if path != "/hooks/qwen/subagent-stop" {
		t.Fatal(path)
	}
}

func TestQwenPreToolAnswerShape(t *testing.T) {
	var answer string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		signed(w, r, 200, answer)
	})
	wt := worktreeFolder(t, file, "sub-abc-1")
	fwd := filepath.ToSlash(wt)
	other := filepath.Join(t.TempDir(), "sub-x")
	call := map[string]any{"description": "d", "prompt": "p", "subagent_type": "general-purpose"}
	withDir := func(dir string) map[string]any {
		m := map[string]any{"working_dir": dir}
		for k, v := range call {
			m[k] = v
		}
		return m
	}
	other2 := withDir(fwd)
	other2["prompt"] = "changed"
	cases := []struct {
		name, input, answer string
		allowed             bool
		out                 string
	}{
		{"agent {} refused", qwenCall("agent", "", call), `{}`, false, ""},
		{"agent isolated", qwenCall("agent", "", call), qwenAllow(withDir(fwd)), true, qwenAllow(withDir(fwd))},
		{"agent other prompt", qwenCall("agent", "", call), qwenAllow(other2), false, ""},
		{"agent other folder", qwenCall("agent", "", call), qwenAllow(withDir(filepath.ToSlash(other))), false, ""},
		{"agent the folder above", qwenCall("agent", "", call), qwenAllow(withDir(filepath.ToSlash(filepath.Dir(wt)))), false, ""},
		{"agent dotdot", qwenCall("agent", "", call), qwenAllow(withDir(fwd + "/../sub-abc-1")), false, ""},
		{"nested agent allow", qwenCall("agent", "a", call), qwenAllow(withDir(fwd)), false, ""},
		{"nested agent {}", qwenCall("agent", "a", call), `{}`, false, ""},
		{"sub shell allow", qwenCall("run_shell_command", "a", map[string]any{"command": "x"}), qwenAllow(map[string]any{"command": "x"}), false, ""},
		{"sub shell {}", qwenCall("run_shell_command", "a", map[string]any{"command": "x"}), `{}`, true, ""},
		{"sub read {}", qwenCall("read_file", "a", map[string]any{"file_path": "x"}), `{}`, true, ""},
		{"deny", qwenCall("run_shell_command", "a", map[string]any{"command": "x"}), string(codexDeny("no")), true, string(codexDeny("no"))},
		{"deny empty reason", qwenCall("write_file", "a", nil), `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":" "}}`, false, ""},
		{"html", qwenCall("agent", "", call), `<html>`, false, ""},
		{"extra key", qwenCall("agent", "", call), `{"continue":false}`, false, ""},
		{"write inside", qwenCall("write_file", "a", map[string]any{"file_path": filepath.Join(wt, "f.txt")}), `{}`, true, ""},
		{"edit inside", qwenCall("edit", "a", map[string]any{"file_path": filepath.Join(wt, "src", "f.txt")}), `{}`, true, ""},
		{"notebook inside", qwenCall("notebook_edit", "a", map[string]any{"notebook_path": filepath.Join(wt, "n.ipynb")}), `{}`, true, ""},
		{"write relative", qwenCall("write_file", "a", map[string]any{"file_path": "f.txt"}), `{}`, false, ""},
		{"write other folder", qwenCall("write_file", "a", map[string]any{"file_path": filepath.Join(other, "f.txt")}), `{}`, false, ""},
		{"write dotdot", qwenCall("write_file", "a", map[string]any{"file_path": wt + string(filepath.Separator) + ".." + string(filepath.Separator) + "f.txt"}), `{}`, false, ""},
		{"write no path", qwenCall("write_file", "a", map[string]any{}), `{}`, false, ""},
		{"main call {}", qwenCall("read_file", "", nil), `{}`, true, ""},
	}
	for _, c := range cases {
		answer = c.answer
		wantOut := c.out
		if !c.allowed {
			wantOut = string(codexDeny(hookUnconfirmed))
		}
		code, out, _ := runHook(t, "qwen-pre-tool", file, c.input, 2*time.Second)
		if code != 0 || !jsonSame(out, wantOut) {
			t.Errorf("%s: code %d out %q, want %q", c.name, code, out, wantOut)
		}
	}
}

func TestQwenSubagentStartPrintsOnlyContext(t *testing.T) {
	ctx := `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"your folder is X"}}`
	if code, out, _ := runHook(t, "qwen-subagent-start", answering(t, 200, ctx), `{"agent_id":"a"}`, 2*time.Second); code != 0 || !jsonSame(out, ctx) {
		t.Fatalf("%d %q", code, out)
	}
	for _, bad := range []string{`{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"x","decision":"block"}}`, `{"continue":false}`, `x`} {
		if code, out, _ := runHook(t, "qwen-subagent-start", answering(t, 200, bad), `{"agent_id":"a"}`, 2*time.Second); code != 0 || out != "" {
			t.Fatalf("%s: %d %q", bad, code, out)
		}
	}
}

func TestQwenWithoutKeyFailsClosed(t *testing.T) {
	file := answering(t, 200, `{}`)
	h := &hookForwarder{event: "qwen-pre-tool", addressFile: file, readOnly: map[string]bool{}, deadline: time.Second}
	var out, errb bytes.Buffer
	if code := h.run(strings.NewReader(qwenCall("agent", "", map[string]any{})), &out, &errb); code != 0 || !strings.Contains(out.String(), `"permissionDecision":"deny"`) {
		t.Fatalf("%d %q", code, out.String())
	}
}
