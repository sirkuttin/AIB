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

// agy hooks (hookforward_agy.go): the input is agy's own PreToolUse JSON (conversationId, cwd, toolCall{name,args}).

func agyCall(tool, cwd string, args map[string]any) string {
	b, _ := json.Marshal(map[string]any{"hookEventName": "PreToolUse", "conversationId": "conv-1", "cwd": cwd, "toolCall": map[string]any{"id": "t1", "name": tool, "args": args}})
	return string(b)
}

func runAgy(t *testing.T, event, file, subRoot string, pass bool, input string, deadline time.Duration) (int, string, string) {
	t.Helper()
	h := &hookForwarder{event: event, addressFile: file, key: testHookKey, chat: "c-1", readOnly: map[string]bool{}, deadline: deadline, subRoot: subRoot, pass: pass}
	var out, errb bytes.Buffer
	code := h.run(strings.NewReader(input), &out, &errb)
	return code, out.String(), errb.String()
}

func agyRoot(t *testing.T) (root, main, sub string) {
	t.Helper()
	dir := t.TempDir()
	root = filepath.Join(dir, "gd", "antigravity-cli", "worktrees")
	main = filepath.Join(dir, "project")
	sub = filepath.Join(root, "0f1e2d3c-conv", "subagent-Builder-Agent-builder-1a2b3c4d")
	return
}

const agyAllowJSON = `{"decision":"allow"}`

func TestAgyMainAgentToolsPassWithoutAIB(t *testing.T) {
	file := deadAddress(t)
	root, main, _ := agyRoot(t)
	for _, tool := range []string{"write_file", "run_command", "read_file", "edit_file", "mcp_x_y", "swarm"} {
		args := map[string]any{"Path": filepath.Join(main, "a.txt"), "action": "status"}
		code, out, _ := runAgy(t, "agy-pre-tool", file, root, false, agyCall(tool, main, args), 2*time.Second)
		if tool == "swarm" { // a spawn tool: needs AIB, which is down here
			if code != 0 || !strings.Contains(out, `"decision":"deny"`) {
				t.Fatalf("swarm with AIB down: %d %q", code, out)
			}
			continue
		}
		if code != 0 || !jsonSame(out, agyAllowJSON) {
			t.Fatalf("main agent's %s: %d %q", tool, code, out)
		}
	}
	// session start and stop of the main agent: {} without AIB
	for _, ev := range []string{"agy-session-start", "agy-stop"} {
		if code, out, _ := runAgy(t, ev, file, root, false, agyCall("", main, nil), 2*time.Second); code != 0 || out != "{}" {
			t.Fatalf("%s: %d %q", ev, code, out)
		}
	}
}

func TestAgySpawnToolsAndSubagentCallsNeedAIB(t *testing.T) {
	file := deadAddress(t)
	root, main, sub := agyRoot(t)
	for _, tool := range []string{"invoke_subagent", "define_subagent", "run_workflow", "swarm", "manage_subagents"} {
		code, out, errb := runAgy(t, "agy-pre-tool", file, root, false, agyCall(tool, main, map[string]any{}), 600*time.Millisecond)
		if code != 0 || !jsonSame(out, string(agyDeny(hookRestarting))) || !strings.Contains(errb, "restarting") {
			t.Fatalf("%s with AIB down: %d %q %q", tool, code, out, errb)
		}
	}
	for _, tool := range []string{"write_file", "run_command", "read_file"} {
		code, out, _ := runAgy(t, "agy-pre-tool", file, root, false, agyCall(tool, sub, map[string]any{}), 600*time.Millisecond)
		if code != 0 || !jsonSame(out, string(agyDeny(hookRestarting))) {
			t.Fatalf("subagent %s with AIB down: %d %q", tool, code, out)
		}
	}
	// a subagent's session start and stop: {} even when AIB is down (a hint)
	for _, ev := range []string{"agy-session-start", "agy-stop"} {
		if code, out, _ := runAgy(t, ev, file, root, false, agyCall("", sub, nil), 600*time.Millisecond); code != 0 || out != "{}" {
			t.Fatalf("%s: %d %q", ev, code, out)
		}
	}
}

func TestAgyPassChatPassesEverything(t *testing.T) {
	file := deadAddress(t)
	root, main, sub := agyRoot(t)
	for _, cwd := range []string{main, sub} {
		for _, tool := range []string{"invoke_subagent", "run_workflow", "write_file"} {
			if code, out, _ := runAgy(t, "agy-pre-tool", file, root, true, agyCall(tool, cwd, map[string]any{}), time.Second); code != 0 || !jsonSame(out, agyAllowJSON) {
				t.Fatalf("pass chat %s %s: %d %q", cwd, tool, code, out)
			}
		}
	}
	// even then, kill by name is refused
	code, out, _ := runAgy(t, "agy-pre-tool", file, root, true, agyCall("run_command", main, map[string]any{"CommandLine": "taskkill /F /IM node.exe"}), time.Second)
	if code != 0 || !strings.Contains(out, `"decision":"deny"`) {
		t.Fatalf("%d %q", code, out)
	}
}

func TestAgyUsesItsOwnRoute(t *testing.T) {
	var path string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		path = r.URL.Path
		signed(w, r, 200, agyAllowJSON)
	})
	root, main, sub := agyRoot(t)
	runAgy(t, "agy-pre-tool", file, root, false, agyCall("define_subagent", main, map[string]any{}), 2*time.Second)
	if path != "/hooks/agy/pre-tool" {
		t.Fatal(path)
	}
	runAgy(t, "agy-session-start", file, root, false, agyCall("", sub, nil), 2*time.Second)
	if path != "/hooks/agy/session-start" {
		t.Fatal(path)
	}
	runAgy(t, "agy-stop", file, root, false, agyCall("", sub, nil), 2*time.Second)
	if path != "/hooks/agy/stop" {
		t.Fatal(path)
	}
}

func TestAgyPreToolAnswerShape(t *testing.T) {
	var answer string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		signed(w, r, 200, answer)
	})
	root, main, sub := agyRoot(t)
	inside := filepath.Join(sub, "f.txt")
	deny := string(agyDeny("no"))
	branch := `{"decision":"allow","overwrite":{"Workspace":"branch"}}`
	noNest := `{"decision":"allow","overwrite":{"EnableSubagentTools":false}}`
	cases := []struct {
		name, input, answer string
		allowed             bool
		out                 string
	}{
		{"invoke branch", agyCall("invoke_subagent", main, map[string]any{"TypeName": "b"}), branch, true, branch},
		{"invoke plain allow", agyCall("invoke_subagent", main, map[string]any{"TypeName": "b"}), agyAllowJSON, false, ""},
		{"invoke share", agyCall("invoke_subagent", main, map[string]any{}), `{"decision":"allow","overwrite":{"Workspace":"share"}}`, false, ""},
		{"invoke a path", agyCall("invoke_subagent", main, map[string]any{}), `{"decision":"allow","overwrite":{"Workspace":"C:\\x"}}`, false, ""},
		{"invoke branch and more", agyCall("invoke_subagent", main, map[string]any{}), `{"decision":"allow","overwrite":{"Workspace":"branch","Prompt":"x"}}`, false, ""},
		{"invoke by a subagent", agyCall("invoke_subagent", sub, map[string]any{}), branch, false, ""},
		{"invoke deny", agyCall("invoke_subagent", main, map[string]any{}), deny, true, deny},
		{"define nesting off", agyCall("define_subagent", main, map[string]any{"EnableSubagentTools": true}), noNest, true, noNest},
		{"define nesting kept", agyCall("define_subagent", main, map[string]any{"EnableSubagentTools": true}), agyAllowJSON, false, ""},
		{"define plain", agyCall("define_subagent", main, map[string]any{"Name": "b"}), agyAllowJSON, true, agyAllowJSON},
		{"define stray overwrite", agyCall("define_subagent", main, map[string]any{"Name": "b"}), noNest, false, ""},
		{"workflow allow", agyCall("run_workflow", main, map[string]any{}), agyAllowJSON, false, ""},
		{"workflow deny", agyCall("run_workflow", main, map[string]any{}), deny, true, deny},
		{"swarm add allow", agyCall("swarm", main, map[string]any{"action": "add"}), agyAllowJSON, false, ""},
		{"swarm status allow", agyCall("swarm", main, map[string]any{"action": "status"}), agyAllowJSON, true, agyAllowJSON},
		{"manage allow", agyCall("manage_subagents", main, map[string]any{"Action": "list"}), agyAllowJSON, true, agyAllowJSON},
		{"sub swarm status", agyCall("swarm", sub, map[string]any{"action": "status"}), agyAllowJSON, false, ""},
		{"sub write inside", agyCall("write_file", sub, map[string]any{"Path": inside}), agyAllowJSON, true, agyAllowJSON},
		{"sub edit inside", agyCall("edit_file", sub, map[string]any{"Path": inside}), agyAllowJSON, true, agyAllowJSON},
		{"sub write main", agyCall("write_file", sub, map[string]any{"Path": filepath.Join(main, "f.txt")}), agyAllowJSON, false, ""},
		{"sub write relative", agyCall("write_file", sub, map[string]any{"Path": "f.txt"}), agyAllowJSON, false, ""},
		{"sub write dotdot", agyCall("write_file", sub, map[string]any{"Path": sub + string(filepath.Separator) + ".." + string(filepath.Separator) + ".." + string(filepath.Separator) + "x"}), agyAllowJSON, false, ""},
		{"sub write the root", agyCall("write_file", sub, map[string]any{"Path": root}), agyAllowJSON, false, ""},
		{"sub run allow", agyCall("run_command", sub, map[string]any{"CommandLine": "x"}), agyAllowJSON, true, agyAllowJSON},
		{"sub run overwrite", agyCall("run_command", sub, map[string]any{"CommandLine": "x"}), `{"decision":"allow","overwrite":{"CommandLine":"y"}}`, false, ""},
		{"ask", agyCall("run_command", sub, map[string]any{"CommandLine": "x"}), `{"decision":"ask"}`, false, ""},
		{"deny empty reason", agyCall("run_command", sub, map[string]any{}), `{"decision":"deny","reason":" "}`, false, ""},
		{"deny extra key", agyCall("run_command", sub, map[string]any{}), `{"decision":"deny","reason":"no","overwrite":{}}`, false, ""},
		{"extra key", agyCall("run_command", sub, map[string]any{}), `{"decision":"allow","reason":"x"}`, false, ""},
		{"html", agyCall("run_command", sub, map[string]any{}), `<html>`, false, ""},
		{"empty object", agyCall("run_command", sub, map[string]any{}), `{}`, false, ""},
	}
	for _, c := range cases {
		answer = c.answer
		wantOut := c.out
		if !c.allowed {
			wantOut = string(agyDeny(hookUnconfirmed))
		}
		code, out, _ := runAgy(t, "agy-pre-tool", file, root, false, c.input, 2*time.Second)
		if code != 0 || !jsonSame(out, wantOut) {
			t.Errorf("%s: code %d out %q, want %q", c.name, code, out, wantOut)
		}
	}
}

func TestAgyStopAndStartPrintOnlyAnEmptyObject(t *testing.T) {
	root, _, sub := agyRoot(t)
	for _, ev := range []string{"agy-session-start", "agy-stop"} {
		for _, body := range []string{`{}`, `{"decision":"deny","reason":"x"}`, `x`} {
			if code, out, _ := runAgy(t, ev, answering(t, 200, body), root, false, agyCall("", sub, nil), 2*time.Second); code != 0 || out != "{}" {
				t.Fatalf("%s %s: %d %q", ev, body, code, out)
			}
		}
	}
}

func TestAgyWithoutKeyFailsClosed(t *testing.T) {
	root, main, _ := agyRoot(t)
	h := &hookForwarder{event: "agy-pre-tool", addressFile: answering(t, 200, agyAllowJSON), readOnly: map[string]bool{}, deadline: time.Second, subRoot: root}
	var out, errb bytes.Buffer
	if code := h.run(strings.NewReader(agyCall("invoke_subagent", main, map[string]any{})), &out, &errb); code != 0 || !strings.Contains(out.String(), `"decision":"deny"`) {
		t.Fatalf("%d %q", code, out.String())
	}
}

func TestAgyBadAnswerStatusIsADeny(t *testing.T) {
	root, main, _ := agyRoot(t)
	code, out, _ := runAgy(t, "agy-pre-tool", answering(t, 503, agyAllowJSON), root, false, agyCall("invoke_subagent", main, map[string]any{}), 2*time.Second)
	if code != 0 || !jsonSame(out, string(agyDeny(hookRestarting))) {
		t.Fatalf("%d %q", code, out)
	}
}
