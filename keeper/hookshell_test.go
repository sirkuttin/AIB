package main

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// pre-shell (hook 2, hookshell.go): never blocks, tags only a subagent's Bash or PowerShell call, only with the exact prefix.

func shellInput(tool, agent, command string, extra map[string]any) string {
	in := map[string]any{"command": command}
	for k, v := range extra {
		in[k] = v
	}
	call := map[string]any{"hook_event_name": "PreToolUse", "tool_name": tool, "tool_use_id": "toolu_1", "tool_input": in}
	if agent != "" {
		call["agent_id"] = agent
	}
	b, _ := json.Marshal(call)
	return string(b)
}

func shellAnswer(tool, command string, extra map[string]any) string {
	in := map[string]any{"command": command}
	for k, v := range extra {
		in[k] = v
	}
	b, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "PreToolUse", "updatedInput": in}})
	return string(b)
}

const cookie = "c-1.agent7.toolu_1"

func TestPreShellTagsASubagentCallExactly(t *testing.T) {
	var answer string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		signed(w, r, 200, answer)
	})
	bash := "export AIB_PROC='" + cookie + "'; "
	pwsh := "$env:AIB_PROC='" + cookie + "'; "
	extra := map[string]any{"description": "d", "timeout": 5000, "run_in_background": true}
	cases := []struct {
		name, input, answer, out string
	}{
		{"bash tagged", shellInput("Bash", "agent7", "npm test", extra), shellAnswer("Bash", bash+"npm test", extra), shellAnswer("Bash", bash+"npm test", extra)},
		{"pwsh tagged", shellInput("PowerShell", "agent7", "Get-Date", nil), shellAnswer("PowerShell", pwsh+"Get-Date", nil), shellAnswer("PowerShell", pwsh+"Get-Date", nil)},
		{"empty answer", shellInput("Bash", "agent7", "ls", nil), `{}`, ""},
		{"pwsh form for Bash", shellInput("Bash", "agent7", "ls", nil), shellAnswer("Bash", pwsh+"ls", nil), ""},
		{"bash form for PowerShell", shellInput("PowerShell", "agent7", "ls", nil), shellAnswer("PowerShell", bash+"ls", nil), ""},
		{"another chat's cookie", shellInput("Bash", "agent7", "ls", nil), shellAnswer("Bash", "export AIB_PROC='c-2.agent7.toolu_1'; ls", nil), ""},
		{"cookie of another shape", shellInput("Bash", "agent7", "ls", nil), shellAnswer("Bash", "export AIB_PROC='c-1.a b.x'; ls", nil), ""},
		{"a second statement", shellInput("Bash", "agent7", "ls", nil), shellAnswer("Bash", bash+"rm -rf x; ls", nil), ""},
		{"another command", shellInput("Bash", "agent7", "ls", nil), shellAnswer("Bash", bash+"rm -rf x", nil), ""},
		{"no prefix at all", shellInput("Bash", "agent7", "ls", nil), shellAnswer("Bash", "ls; rm x", nil), ""},
		{"another field changed", shellInput("Bash", "agent7", "ls", extra), shellAnswer("Bash", bash+"ls", map[string]any{"description": "other", "timeout": 5000, "run_in_background": true}), ""},
		{"a field added", shellInput("Bash", "agent7", "ls", nil), shellAnswer("Bash", bash+"ls", map[string]any{"dangerouslyDisableSandbox": true}), ""},
		{"a deny", shellInput("Bash", "agent7", "ls", nil), denyAnswer, ""},
		{"an allow", shellInput("Bash", "agent7", "ls", nil), `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"ls"}}}`, ""},
		{"html", shellInput("Bash", "agent7", "ls", nil), `<html>`, ""},
	}
	for _, c := range cases {
		answer = c.answer
		code, out, errb := runHook(t, "pre-shell", file, c.input, 2*time.Second)
		if code != 0 || errb != "" || !jsonSame(out, c.out) {
			t.Errorf("%s: code %d out %q err %q, want 0 %q", c.name, code, out, errb, c.out)
		}
	}
}

func TestPreShellNeverAsksAIBForMainCallsOtherToolsOrUntaggableCommands(t *testing.T) {
	var asked atomic.Int32
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		asked.Add(1)
		signed(w, r, 200, `{}`)
	})
	for name, input := range map[string]string{
		"main agent's call":    shellInput("Bash", "", "ls", nil),
		"another tool":         shellInput("Read", "agent7", "ls", nil),
		"empty command":        shellInput("Bash", "agent7", "  ", nil),
		"using namespace":      shellInput("PowerShell", "agent7", "using namespace System.IO\nGet-Date", nil),
		"requires":             shellInput("PowerShell", "agent7", "#requires -Version 7\nGet-Date", nil),
		"param block":          shellInput("PowerShell", "agent7", "param($x)\nWrite-Output $x", nil),
		"param with space":     shellInput("PowerShell", "agent7", "  Param ( $x )", nil),
		"param after help":     shellInput("PowerShell", "agent7", "<# help #>\n[CmdletBinding()]\nparam($x)", nil),
		"param after comments": shellInput("PowerShell", "agent7", "# a\n# b\nparam($x)", nil),
		"unclosed comment":     shellInput("PowerShell", "agent7", "<# never closed\nparam($x)", nil),
		"not a command at all": `{"tool_name":"Bash","agent_id":"agent7","tool_input":{"command":7}}`,
		"not json":             `nope`,
	} {
		code, out, errb := runHook(t, "pre-shell", file, input, 2*time.Second)
		if code != 0 || out != "" || errb != "" {
			t.Errorf("%s: code %d out %q err %q", name, code, out, errb)
		}
	}
	if n := asked.Load(); n != 0 {
		t.Fatalf("AIB was asked %d times for calls that stay untagged", n)
	}
	// a plain script and a comment before a normal command are asked about
	answer := shellAnswer("PowerShell", "$env:AIB_PROC='"+cookie+"'; # note\nGet-Date", nil)
	file = hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		signed(w, r, 200, answer)
	})
	code, out, _ := runHook(t, "pre-shell", file, shellInput("PowerShell", "agent7", "# note\nGet-Date", nil), 2*time.Second)
	if code != 0 || !jsonSame(out, answer) {
		t.Errorf("a comment line before a command is tagged: %d %q", code, out)
	}
}

func TestPreShellNeverBlocksWhenAIBIsDownSlowOrWrong(t *testing.T) {
	input := shellInput("Bash", "agent7", "npm test", nil)
	check := func(name string, file string, event string, within time.Duration) {
		start := time.Now()
		code, out, errb := runHook(t, event, file, input, 300*time.Millisecond)
		if code != 0 || out != "" || errb != "" {
			t.Errorf("%s: code %d out %q err %q (must exit 0 silently, so the call runs untagged)", name, code, out, errb)
		}
		if took := time.Since(start); took > within {
			t.Errorf("%s: took %v", name, took)
		}
	}
	check("AIB down", deadAddress(t), "pre-shell", 2*time.Second)
	check("no AIB address file", filepath.Join(t.TempDir(), "none.json"), "pre-shell", 2*time.Second)
	check("500", answering(t, 500, "boom"), "pre-shell", 2*time.Second)
	check("401", answering(t, 401, "no"), "pre-shell", 2*time.Second)
	check("slow", hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		time.Sleep(2 * time.Second)
		signed(w, r, 200, `{}`)
	}), "pre-shell", 2*time.Second)
	// an unsigned answer (another program on the port) that looks like a tagging is never printed
	bad := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.Write([]byte(shellAnswer("Bash", "export AIB_PROC='"+cookie+"'; npm test", nil)))
	})
	check("unsigned", bad, "pre-shell", 2*time.Second)
	// no key: nothing is asked
	h := &hookForwarder{event: "pre-shell", addressFile: deadAddress(t), chat: "c-1", deadline: 300 * time.Millisecond}
	var out, errb strings.Builder
	if code := h.run(strings.NewReader(input), &out, &errb); code != 0 || out.String() != "" || errb.String() != "" {
		t.Errorf("no key: %d %q %q", code, out.String(), errb.String())
	}
	// and the blocking events still block (pre-shell is the only one that never does)
	if !hookBlocking("pre-tool") || hookBlocking("pre-shell") {
		t.Fatal("pre-shell is non-blocking, pre-tool blocks")
	}
}

func TestHookCheckLineIsHook2(t *testing.T) {
	if line := checkLine("hook 2"); !strings.HasPrefix(line, "hook 2") {
		t.Fatalf("check line %q", line)
	}
}

func TestCodexPreToolAcceptsAibPrefixBeforeTheCd(t *testing.T) {
	var answer string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		signed(w, r, 200, answer)
	})
	fwd := filepath.ToSlash(worktreeFolder(t, file, "sub-abc-1"))
	bash := "export AIB_PROC='" + cookie + "'; "
	pwsh := "$env:AIB_PROC='" + cookie + "'; "
	cd := "cd '" + fwd + "'; "
	cases := []struct {
		name, input, answer string
		ok                  bool
	}{
		{"bash tag before cd", codexCall("Bash", "a", "echo hi"), allowCommand(bash + cd + "echo hi"), true},
		{"pwsh tag before cd", codexCall("Bash", "a", "echo hi"), allowCommand(pwsh + cd + "echo hi"), true},
		{"another chat's tag", codexCall("Bash", "a", "echo hi"), allowCommand("export AIB_PROC='c-2.a.x'; " + cd + "echo hi"), false},
		{"tag after the cd", codexCall("Bash", "a", "echo hi"), allowCommand(cd + bash + "echo hi"), false},
		{"tag, no cd", codexCall("Bash", "a", "echo hi"), allowCommand(bash + "echo hi"), false},
		{"tag, other command", codexCall("Bash", "a", "echo hi"), allowCommand(bash + cd + "rm -rf x"), false},
		{"tag on a param script", codexCall("Bash", "a", "param($x)"), allowCommand(pwsh + cd + "param($x)"), false},
		{"no tag still works", codexCall("Bash", "a", "echo hi"), allowCommand(cd + "echo hi"), true},
	}
	for _, c := range cases {
		answer = c.answer
		want := string(codexDeny(hookUnconfirmed))
		if c.ok {
			want = c.answer
		}
		code, out, _ := runHook(t, "codex-pre-tool", file, c.input, 2*time.Second)
		if code != 0 || !jsonSame(out, want) {
			t.Errorf("%s: code %d out %q, want %q", c.name, code, out, want)
		}
	}
}
