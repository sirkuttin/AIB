package main

import (
	"bytes"
	"strings"
	"testing"
)

// Kill by name (hookkill.go): the same table as work/deno/kill_by_name_test.ts, run in Go so a Linux build (a WSL distro's keeper) is
// checked by `go test` as well.
var killRefused = []string{
	"taskkill /F /IM node.exe", "taskkill.exe /IM AIB.exe /F", "taskkill //F //IM node.exe", `taskkill /FI "IMAGENAME eq node.exe" /F`,
	"Stop-Process -Name node -Force", "spps -Name node", "Stop-Process -ProcessName deno", "Get-Process node | Stop-Process",
	"Get-Process -Name node | Stop-Process -Force", "pkill -f node", "killall node", "cd app && pkill node",
	`wmic process where name="node.exe" delete`, `bash -c "pkill node"`, `powershell -Command "taskkill /IM node.exe /F"`,
	`echo start; sh -lc 'killall deno'`,
}

var killPasses = []string{
	"taskkill /PID 1234 /T /F", "taskkill /F /PID 1234", "Stop-Process -Id 4242 -Force", "Get-Process -Id 4242 | Stop-Process",
	"kill 4242", "kill -9 4242", `git commit -m "docs: never taskkill /IM node.exe, never pkill node"`, `git commit -m "x" -m 'killall is banned'`,
	"git commit -F - <<'EOF'\nfix: stop using taskkill /IM\n\npkill node is refused now\nEOF", `echo "Stop-Process -Name node"`,
	"deno task test", `bash -c "echo hello"`,
}

func TestKillsByName(t *testing.T) {
	for _, c := range killRefused {
		if !killsByName(c, 0) {
			t.Errorf("should refuse: %s", c)
		}
	}
	for _, c := range killPasses {
		if killsByName(c, 0) {
			t.Errorf("should pass: %s", c)
		}
	}
}

func killRun(t *testing.T, event, payload string) string {
	t.Helper()
	var out, errOut bytes.Buffer
	h := &hookForwarder{event: event, addressFile: "no-address.json", key: "k", chat: "c0ffee00aa11bb22cc33dd44ee55ff66", readOnly: map[string]bool{}, deadline: hookDeadline}
	if code := h.run(strings.NewReader(payload), &out, &errOut); code != 0 {
		t.Fatalf("%s exit %d: %s", event, code, errOut.String())
	}
	return out.String()
}

func TestKillByNameRefusedByEveryForwarderEvent(t *testing.T) {
	const claude = `{"tool_name":"Bash","tool_input":{"command":%q}%s}`
	for _, sub := range []string{"", `,"agent_id":"a1"`} {
		if out := killRun(t, "pre-shell", strings.Replace(strings.Replace(claude, "%q", `"pkill node"`, 1), "%s", sub, 1)); !strings.Contains(out, `"permissionDecision":"deny"`) {
			t.Errorf("claude pre-shell (agent %q) was not refused: %s", sub, out)
		}
	}
	if out := killRun(t, "codex-pre-tool", `{"tool_name":"exec_command","tool_input":{"cmd":"taskkill /IM node.exe /F"}}`); !strings.Contains(out, `"permissionDecision":"deny"`) {
		t.Errorf("codex main agent was not refused: %s", out)
	}
	if out := killRun(t, "gemini-before-tool", `{"tool_name":"run_shell_command","tool_input":{"command":"killall node"}}`); !strings.Contains(out, `"decision":"deny"`) {
		t.Errorf("gemini was not refused: %s", out)
	}
	// a PID kill and a patch that merely names the command: nothing is printed for the main agent's calls
	if out := killRun(t, "pre-shell", `{"tool_name":"Bash","tool_input":{"command":"taskkill /PID 4 /T /F"}}`); out != "" {
		t.Errorf("claude PID kill printed: %s", out)
	}
	if out := killRun(t, "codex-pre-tool", `{"tool_name":"apply_patch","tool_input":{"command":"+ pkill node"}}`); out != "" {
		t.Errorf("codex patch printed: %s", out)
	}
	if out := killRun(t, "gemini-before-tool", `{"tool_name":"run_shell_command","tool_input":{"command":"git commit -m \"pkill node\""}}`); out != "" {
		t.Errorf("gemini quoted mention printed: %s", out)
	}
}
