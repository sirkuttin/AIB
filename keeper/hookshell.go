package main

// AIB-keeper hook pre-shell <address file> (hook 2): the non-blocking shell hook of a Claude chat (no-stuck-processes, Slice 0, steps 3-4;
// aib-shared/reviews/no-stuck-processes-architect-review.md S0-M1 to S0-M3).
//
// Claude Code runs it before a Bash or PowerShell call. For a call made inside a subagent (the payload carries agent_id) AIB may answer
// with the call's own command behind ONE prefix that sets the cookie AIB_PROC=<chat>.<owner>.<call id>:
//
//	Bash         export AIB_PROC='<cookie>'; <command>
//	PowerShell   $env:AIB_PROC='<cookie>'; <command>
//
// so every process the command starts carries the subagent that started it (a later step reads the cookie to stop what a finished
// subagent left running). The forwarder decides everything itself and prints only what it has rebuilt:
//   - the main agent's own calls (no agent_id) and every tool other than Bash and PowerShell pass here, without AIB: nothing is printed;
//   - the answer is the call's tool_input with ONLY the command changed, to exactly <prefix for the tool><the original command>, the
//     cookie of shape <chat>.<owner>.<call id> (each [A-Za-z0-9_-]) whose chat is this forwarder's own chat (AIB_HOOK_CHAT);
//   - a command whose shell cannot be proven to read the prefix stays untagged (checkTaggable: a PowerShell script starting with
//     using / #requires / param( or a comment block before them).
//
// It never blocks and never denies: AIB down, slow, wrong key, wrong proof, a refusal, an answer of any other shape, a missing key: exit 0
// and print nothing, so the call runs untagged (hookBlocking). It is its own PreToolUse entry, so it is not counted against the chat's
// waiting pre-tool calls (the per-chat limit of 4 applies to AIB's Agent hooks only).
//
// Codex has no separate event: its subagent Bash answer (hookforward_codex.go) may carry the same prefix in front of its `cd '<worktree>'; `.

import (
	"encoding/json"
	"io"
	"reflect"
	"regexp"
	"strings"
)

const (
	aibBashPrefix = "export AIB_PROC='"
	aibPwshPrefix = "$env:AIB_PROC='"
)

// aibCookieShape: <chat>.<owner>.<call id>, no other character (the cookie is put inside single quotes, so it needs no escaping).
var aibCookieShape = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{1,100}\.[A-Za-z0-9_-]{1,200}$`)

// pwshFirst: a PowerShell script that must begin with these (a prefix would be a parse error).
var pwshFirst = regexp.MustCompile(`(?i)^(using[ \t]|#requires\b|param[ \t]*\(|\[cmdletbinding)`)

// shellOfTool: the shell that runs Claude Code's tool, or "" for any other tool (never guessed).
func shellOfTool(tool string) string {
	switch tool {
	case "Bash":
		return "bash"
	case "PowerShell":
		return "pwsh"
	}
	return ""
}

// checkTaggable: true when the prefix can be put in front of command for this shell ("bash" or "pwsh") without changing what it means.
func checkTaggable(shell, command string) bool {
	if strings.TrimSpace(command) == "" {
		return false
	}
	switch shell {
	case "bash":
		return true
	case "pwsh":
		text := command
		for { // comment-based help and # lines before the first statement may precede param( and using
			text = strings.TrimLeft(text, " \t\r\n"+string(rune(0xFEFF)))
			if strings.HasPrefix(text, "<#") {
				end := strings.Index(text, "#>")
				if end < 0 {
					return false
				}
				text = text[end+2:]
				continue
			}
			if strings.HasPrefix(text, "#") && !strings.HasPrefix(strings.ToLower(text), "#requires") {
				nl := strings.IndexByte(text, '\n')
				if nl < 0 {
					return false
				}
				text = text[nl+1:]
				continue
			}
			break
		}
		return !pwshFirst.MatchString(text)
	}
	return false
}

// aibTagPrefix: the exact prefix text for a shell and cookie.
func aibTagPrefix(shell, cookie string) string {
	switch shell {
	case "bash":
		return aibBashPrefix + cookie + "'; "
	case "pwsh":
		return aibPwshPrefix + cookie + "'; "
	}
	return ""
}

// cutAibTag splits "<exact prefix><rest>" into the shell form, the cookie and the rest. ok is false when command has no exact prefix.
func cutAibTag(command string) (shell, cookie, rest string, ok bool) {
	for _, form := range []struct{ shell, head string }{{"bash", aibBashPrefix}, {"pwsh", aibPwshPrefix}} {
		after, found := strings.CutPrefix(command, form.head)
		if !found {
			continue
		}
		end := strings.Index(after, "'; ")
		if end <= 0 {
			return "", "", "", false
		}
		cookie = after[:end]
		if !aibCookieShape.MatchString(cookie) {
			return "", "", "", false
		}
		return form.shell, cookie, after[end+3:], true
	}
	return "", "", "", false
}

// cookieIsMine: the cookie's chat field is this forwarder's own chat.
func cookieIsMine(cookie, chat string) bool {
	return chat != "" && strings.HasPrefix(cookie, chat+".") && aibCookieShape.MatchString(cookie)
}

// shellCall: the tool and command of a PreToolUse payload for Bash or PowerShell made inside a subagent (agent_id set).
func shellCall(input []byte) (tool, command string, ok bool) {
	var call struct {
		ToolName  string `json:"tool_name"`
		AgentID   string `json:"agent_id"`
		ToolInput struct {
			Command *string `json:"command"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil || call.AgentID == "" || shellOfTool(call.ToolName) == "" || call.ToolInput.Command == nil {
		return "", "", false
	}
	return call.ToolName, *call.ToolInput.Command, true
}

// preShellWants: true when this pre-shell call is worth asking AIB about (a subagent's taggable Bash or PowerShell call, with a key).
func (h *hookForwarder) preShellWants(input []byte) bool {
	tool, command, ok := shellCall(input)
	return ok && checkTaggable(shellOfTool(tool), command) && h.key != "" && h.chat != ""
}

// preShellAnswer: what AIB's answer to a pre-shell call prints (nothing when it is not an exact tagging). Never blocks.
func (h *hookForwarder) preShellAnswer(input []byte, status int, body []byte, stdout io.Writer) {
	if status != 200 {
		return
	}
	if out, ok := checkPreShellAnswer(input, body, h.chat); ok && len(out) > 0 {
		stdout.Write(out)
	}
}

// checkPreShellAnswer: what to print for AIB's (signed) answer to a pre-shell call, or false. Nothing is printed for {}; otherwise the
// call's own tool_input with only the command changed to the exact prefix plus the original command, rebuilt here (never AIB's bytes).
func checkPreShellAnswer(input, body []byte, chat string) ([]byte, bool) {
	tool, command, ok := shellCall(input)
	if !ok {
		return nil, false
	}
	top, ok := jsonObject(body)
	if !ok {
		return nil, false
	}
	if len(top) == 0 {
		return []byte{}, true
	}
	raw, ok := top["hookSpecificOutput"]
	if len(top) != 1 || !ok {
		return nil, false
	}
	out, ok := jsonObject(raw)
	if !ok || len(out) != 2 {
		return nil, false
	}
	var event string
	if json.Unmarshal(out["hookEventName"], &event) != nil || event != "PreToolUse" {
		return nil, false
	}
	var call struct {
		ToolInput json.RawMessage `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil {
		return nil, false
	}
	updated, ok := out["updatedInput"]
	if !ok {
		return nil, false
	}
	var got map[string]any
	if json.Unmarshal(updated, &got) != nil || got == nil {
		return nil, false
	}
	gotCommand, ok := got["command"].(string)
	if !ok {
		return nil, false
	}
	shell, cookie, rest, ok := cutAibTag(gotCommand)
	if !ok || shell != shellOfTool(tool) || rest != command || !cookieIsMine(cookie, chat) || !checkTaggable(shell, command) {
		return nil, false
	}
	want, ok := toolInputMap(call.ToolInput, false)
	if !ok {
		return nil, false
	}
	want["command"] = gotCommand
	if !reflect.DeepEqual(got, any(want)) {
		return nil, false
	}
	exact, _ := toolInputMap(call.ToolInput, true) // the call's own values, numbers as written
	exact["command"] = gotCommand
	answer, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "PreToolUse", "updatedInput": exact}})
	return answer, err == nil
}
