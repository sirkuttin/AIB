package main

// Kill by name is refused in every AIB chat (owner 2026-11-24, "2a"; server/allow/kill_by_name.ts has the rule, its reason text and the
// same patterns, and work/deno/kill_by_name_test.ts runs both over one table). The decision is local, in the forwarder, so it works with
// AIB down and costs no round trip:
//
//	Claude   pre-shell          every Bash/PowerShell call, the main agent's too (hook 3)       -> PreToolUse deny
//	Codex    codex-pre-tool     every shell tool call (Bash, exec_command, shell...)            -> PreToolUse deny, exit 0
//	Gemini   gemini-before-tool run_shell_command (the hook entry's matcher has it from hook 3) -> {"decision":"deny","reason":...}
//
// Text inside quotes or a heredoc is data (a commit message that mentions taskkill) and is stripped first; a shell wrapper's own script
// (bash -c "...", powershell -Command "...") is read first. Fails open: input that is not a shell call, or unreadable, prints nothing.

import (
	"encoding/json"
	"regexp"
	"strings"
)

const killByNameReason = "never kill by image name: it kills every session's copy, AIB's own processes included. Kill only PIDs you started: taskkill /PID <pid> /T /F (or Stop-Process -Id / kill <pid>)."

var (
	killTaskkillIM = regexp.MustCompile(`(?i)\btaskkill(\.exe)?\b[^|;&\n]*\s/{1,2}im\b`)
	killStopName   = regexp.MustCompile(`(?i)\b(stop-process|spps)\b[^|;\n]*\s-(name|processname)\b`)
	killGetProcess = regexp.MustCompile(`(?i)\b(get-process|gps)\b([^|]*)\|\s*(stop-process|spps|kill)\b`)
	killPkill      = regexp.MustCompile(`(?i)(^|[\s;&|(])(pkill|killall)\s`)
	killWmic       = regexp.MustCompile(`(?i)\bwmic\b[^\n]*\bprocess\b[^\n]*\bname\s*=`)
	killTaskword   = regexp.MustCompile(`(?i)\btaskkill\b`)
	killFilter     = regexp.MustCompile(`(?i)\btaskkill(\.exe)?(?:\s[^|;&\n]*)?\s/{1,2}fi\s+["']?imagename\b`)
	killID         = regexp.MustCompile(`(?i)\s-id\b`)
	killHeredoc    = regexp.MustCompile(`<<-?\s*['"]?(\w+)['"]?`)
	killQuoted     = regexp.MustCompile(`'[^']*'|"(?:\\.|[^"\\])*"`)
	killWrapped    = regexp.MustCompile(`(?i)\b(?:(?:ba|z|da)?sh\s+-[a-z]*c|(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-z]+\s+\S+\s+)*-(?:command|c))\s+(?:'((?:[^']|'')*)'|"((?:\\.|[^"\\])*)")`)
	killUnescape   = regexp.MustCompile(`\\(.)`)
	// the shell tools of Codex (never apply_patch: a patch's text may name any command)
	killCodexShell = map[string]bool{"Bash": true, "shell": true, "exec_command": true, "local_shell": true, "shell_command": true, "unified_exec": true}
)

// killStripped: command without heredoc bodies and quoted text (both are data, not commands).
func killStripped(cmd string) string {
	for {
		loc := killHeredoc.FindStringSubmatchIndex(cmd)
		if loc == nil {
			break
		}
		tag := cmd[loc[2]:loc[3]]
		rest := cmd[loc[1]:]
		end := -1
		for from := 0; ; {
			at := strings.Index(rest[from:], "\n"+tag)
			if at < 0 {
				break
			}
			after := from + at + 1 + len(tag)
			if after >= len(rest) || !isWordByte(rest[after]) {
				end = after
				break
			}
			from = after
		}
		if end < 0 {
			cmd = cmd[:loc[0]] + cmd[loc[1]:] // no terminator: keep the text after the marker, as a plain command
			continue
		}
		cmd = cmd[:loc[0]] + rest[end:]
	}
	return killQuoted.ReplaceAllString(cmd, "''")
}

func isWordByte(b byte) bool {
	return b == '_' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// killsByName: true when the command kills processes by name.
func killsByName(command string, depth int) bool {
	if command == "" || len(command) > 20000 {
		return false
	}
	code := killStripped(command)
	if killTaskkillIM.MatchString(code) || killStopName.MatchString(code) || killPkill.MatchString(code) || killWmic.MatchString(code) {
		return true
	}
	for _, m := range killGetProcess.FindAllStringSubmatch(code, -1) {
		if !killID.MatchString(m[2]) {
			return true
		}
	}
	if killTaskword.MatchString(code) && killFilter.MatchString(command) {
		return true
	}
	if depth < 2 {
		for _, m := range killWrapped.FindAllStringSubmatch(command, -1) {
			inner := killUnescape.ReplaceAllString(m[2], "$1")
			if m[1] != "" {
				inner = strings.ReplaceAll(m[1], "''", "'")
			}
			if killsByName(inner, depth+1) {
				return true
			}
		}
	}
	return false
}

// shellCommandText: the command text of a shell call, from tool_input.command (a string, or an argv list) or tool_input.cmd.
// claudeOnly: only Claude's Bash and PowerShell tools; else Codex's shell tools.
func shellCommandText(input []byte, claude bool) (string, bool) {
	var call struct {
		ToolName  string `json:"tool_name"`
		ToolInput struct {
			Command json.RawMessage `json:"command"`
			Cmd     json.RawMessage `json:"cmd"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil {
		return "", false
	}
	if claude && shellOfTool(call.ToolName) == "" || !claude && !killCodexShell[call.ToolName] {
		return "", false
	}
	for _, raw := range []json.RawMessage{call.ToolInput.Command, call.ToolInput.Cmd} {
		var s string
		if json.Unmarshal(raw, &s) == nil && s != "" {
			return s, true
		}
		var argv []string
		if json.Unmarshal(raw, &argv) == nil && len(argv) > 0 {
			return strings.Join(argv, " "), true
		}
	}
	return "", false
}

// killRefusal: the deny text when a Claude (claude true) or Codex shell call kills by name, else "".
func killRefusal(input []byte, claude bool) string {
	command, ok := shellCommandText(input, claude)
	if ok && killsByName(command, 0) {
		return "AIB: " + killByNameReason
	}
	return ""
}

// geminiKillRefusal: the same for Gemini's run_shell_command (tool_input.command).
func geminiKillRefusal(input []byte) string {
	var call struct {
		ToolName  string `json:"tool_name"`
		ToolInput struct {
			Command string `json:"command"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil || call.ToolName != "run_shell_command" || !killsByName(call.ToolInput.Command, 0) {
		return ""
	}
	return "AIB: " + killByNameReason
}

// geminiToolName: the tool_name of a Gemini BeforeTool payload ('' when unreadable).
func geminiToolName(input []byte) string {
	var call struct {
		ToolName string `json:"tool_name"`
	}
	_ = json.Unmarshal(input, &call)
	return call.ToolName
}

// geminiDeny: Gemini's BeforeTool refusal.
func geminiDeny(reason string) []byte {
	b, _ := json.Marshal(map[string]any{"decision": "deny", "reason": reason})
	return b
}
