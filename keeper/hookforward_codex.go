package main

// AIB-keeper hook codex-<event> <address file>: a Codex command hook forwarded to AIB (subagent worktrees, Codex:
// server/subagents/codex.ts). Same forwarder as Claude's (hookforward.go: key and chat from the environment, a fresh nonce, the
// answer signed by AIB, no redirects, the address file's pid alive, fails closed), its own events and answer shapes. Codex runs the
// command with cmd.exe /C on Windows ($SHELL -lc elsewhere) and treats a hook like Claude Code does: exit 2 with a reason on stderr
// blocks a PreToolUse call; exit 0 with JSON on stdout answers; any other failure lets the call run. So:
//
//	codex-pre-tool        PreToolUse, every tool. The main agent's own calls other than spawn_agent pass here, without AIB (the
//	                      input has no agent_id). spawn_agent (AIB prepares the subagent's worktree) and every call of a subagent
//	                      (agent_id set) go to AIB; AIB down, slow or unconfirmed -> a JSON deny, exit 0 (Codex 0.166 RUNS a call
//	                      whose hook exits 2: work/cx_codex_subagent_probe.py spawn-exit2).
//	codex-subagent-start  SubagentStart: AIB binds a prepared worktree to the agent_id and names it in additionalContext. Never
//	                      blocks: a subagent with no worktree has every call refused by codex-pre-tool instead.
//	codex-subagent-stop   SubagentStop: a hint for AIB (the work lands at the parent's turn end); nothing is printed.
//
// A signed answer is still checked for shape, and what is printed is rebuilt here (never AIB's bytes):
//
//	pre-tool        {} for spawn_agent, or for a subagent's tool other than Bash and apply_patch; for apply_patch only when every
//	                file in the patch is an absolute path inside an AIB subagent worktree; a deny with a reason; for a subagent's
//	                Bash call only, allow with updatedInput {command: "cd '<worktree>'; " + the call's own command}, <worktree> an
//	                AIB subagent worktree folder (checkCodexWorktreePath: also in the chat's own .cx-<chat> folder; forward slashes, so PowerShell and bash both read it, and
//	                cmd.exe runs nothing: it takes the whole line as cd's folder).
//	subagent-start  {} or additionalContext text.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// codexPassesLocally: the main agent's own call of a tool other than spawn_agent (no agent_id) passes without AIB.
func codexPassesLocally(input []byte) bool {
	var call struct {
		ToolName string `json:"tool_name"`
		AgentID  string `json:"agent_id"`
	}
	if json.Unmarshal(input, &call) != nil {
		return false
	}
	return call.AgentID == "" && call.ToolName != "spawn_agent" && call.ToolName != ""
}

// codexAnswer: what to print and the exit code for AIB's signed answer to a codex-* event.
func (h *hookForwarder) codexAnswer(input []byte, status int, body []byte, stdout, stderr io.Writer) int {
	switch h.event {
	case "codex-subagent-start":
		if status == http.StatusOK {
			if out, ok := checkCodexStartAnswer(body); ok && out != nil {
				stdout.Write(out)
			}
		}
		return 0
	case "codex-pre-tool":
		if status != http.StatusOK {
			fmt.Fprintln(stderr, hookRestarting)
			stdout.Write(codexDeny(hookRestarting))
			return 0
		}
		out, ok := checkCodexPreToolAnswer(input, body, h.worktreesRoot(), h.chat)
		if !ok {
			fmt.Fprintln(stderr, hookUnconfirmed)
			stdout.Write(codexDeny(hookUnconfirmed))
			return 0
		}
		stdout.Write(out)
		return 0
	default:
		return 0 // codex-subagent-stop: a hint
	}
}

// codexDeny: the JSON deny that refuses a Codex PreToolUse call. Codex runs a call whose hook exits 2 (verified on 0.166:
// work/cx_codex_subagent_probe.py spawn-exit2), so every refusal of the forwarder (AIB down, slow, unconfirmed) is this, exit 0.
func codexDeny(reason string) []byte {
	b, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason,
	}})
	return b
}

// checkCodexStartAnswer: nil to print for {}, the rebuilt additionalContext answer, or false.
func checkCodexStartAnswer(body []byte) ([]byte, bool) {
	top, ok := jsonObject(body)
	if !ok {
		return nil, false
	}
	if len(top) == 0 {
		return nil, true
	}
	out, ok := jsonObject(top["hookSpecificOutput"])
	if len(top) != 1 || !ok || len(out) != 2 {
		return nil, false
	}
	var event, context string
	if json.Unmarshal(out["hookEventName"], &event) != nil || event != "SubagentStart" ||
		json.Unmarshal(out["additionalContext"], &context) != nil || strings.TrimSpace(context) == "" {
		return nil, false
	}
	answer, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "SubagentStart", "additionalContext": context}})
	return answer, err == nil
}

// checkCodexPreToolAnswer: what to print for AIB's signed pre-tool answer (see the file comment), or false.
func checkCodexPreToolAnswer(input, body []byte, root, chat string) ([]byte, bool) {
	var call struct {
		ToolName  string `json:"tool_name"`
		AgentID   string `json:"agent_id"`
		ToolInput struct {
			Command *string `json:"command"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil {
		return nil, false
	}
	sub := call.AgentID != ""
	top, ok := jsonObject(body)
	if !ok {
		return nil, false
	}
	if len(top) == 0 {
		if !sub {
			return []byte{}, call.ToolName == "spawn_agent"
		}
		switch call.ToolName {
		case "Bash":
			return nil, false // a subagent's shell command always runs in its worktree (or is denied)
		case "apply_patch":
			return []byte{}, call.ToolInput.Command != nil && patchInWorktrees(*call.ToolInput.Command, root)
		}
		return []byte{}, true
	}
	out, ok := jsonObject(top["hookSpecificOutput"])
	if len(top) != 1 || !ok || len(out) != 3 {
		return nil, false
	}
	var event, decision string
	if json.Unmarshal(out["hookEventName"], &event) != nil || event != "PreToolUse" ||
		json.Unmarshal(out["permissionDecision"], &decision) != nil {
		return nil, false
	}
	switch decision {
	case "deny":
		var reason string
		if json.Unmarshal(out["permissionDecisionReason"], &reason) != nil || strings.TrimSpace(reason) == "" {
			return nil, false
		}
		answer, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason,
		}})
		return answer, err == nil
	case "allow":
		if !sub || call.ToolName != "Bash" || call.ToolInput.Command == nil {
			return nil, false
		}
		updated, ok := jsonObject(out["updatedInput"])
		var command string
		if !ok || len(updated) != 1 || json.Unmarshal(updated["command"], &command) != nil {
			return nil, false
		}
		// hook 2: AIB's exact cookie prefix may stand in front of the cd (hookshell.go): the shell form of the call's own shell, the
		// cookie's chat this forwarder's own. An answer with any other prefix is refused as before.
		tagged := command
		if shell, cookie, after, found := cutAibTag(command); found {
			if !cookieIsMine(cookie, chat) || !checkTaggable(shell, *call.ToolInput.Command) {
				return nil, false
			}
			tagged = after
		}
		folder, rest, ok := cutCdPrefix(tagged)
		if !ok || rest != *call.ToolInput.Command || checkCodexWorktreePath(filepath.FromSlash(folder), root) != nil {
			return nil, false
		}
		answer, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": map[string]any{"command": command},
		}})
		return answer, err == nil
	default:
		return nil, false
	}
}

// cutCdPrefix splits "cd '<folder>'; <rest>" (no quote inside the folder).
func cutCdPrefix(command string) (folder, rest string, ok bool) {
	after, found := strings.CutPrefix(command, "cd '")
	if !found {
		return "", "", false
	}
	end := strings.Index(after, "'; ")
	if end <= 0 || strings.ContainsAny(after[:end], "'\r\n") {
		return "", "", false
	}
	return after[:end], after[end+3:], true
}

// patchInWorktrees: every file an apply_patch text names (Add / Update / Delete File, Move to) is an absolute path inside an AIB
// subagent worktree (<root>/<repo hash>/sub-*). A patch that names no file is harmless.
func patchInWorktrees(patch, root string) bool {
	for _, line := range strings.Split(patch, "\n") {
		line = strings.TrimRight(line, "\r")
		var path string
		for _, head := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
			if p, found := strings.CutPrefix(line, head); found {
				path = strings.TrimSpace(p)
			}
		}
		if path == "" {
			if strings.HasPrefix(line, "*** ") && !strings.HasPrefix(line, "*** Begin Patch") && !strings.HasPrefix(line, "*** End Patch") &&
				!strings.HasPrefix(line, "*** End of File") {
				return false // a file header this check does not know
			}
			continue
		}
		if !insideSubagentWorktree(path, root) {
			return false
		}
	}
	return true
}

func insideSubagentWorktree(path, root string) bool {
	native := filepath.FromSlash(path)
	if !filepath.IsAbs(native) || strings.ContainsAny(native, "\x00") {
		return false
	}
	for _, part := range strings.FieldsFunc(native, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == "." || part == ".." {
			return false
		}
	}
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(native))
	if err != nil {
		return false
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) < 3 || parts[0] == ".." {
		return false
	}
	if codexChatFolder.MatchString(parts[1]) { // <root>/<repo hash>/.cx-<chat>/sub-*/<file>
		return len(parts) >= 4 && checkCodexWorktreePath(filepath.Join(filepath.Clean(root), parts[0], parts[1], parts[2]), root) == nil
	}
	return checkWorktreePath(filepath.Join(filepath.Clean(root), parts[0], parts[1]), root) == nil
}

// codexChatFolder: a Codex chat's own folder for its subagents' worktrees (server/subagents/codex.ts subagentFolder), a writable
// root of that chat's sandbox.
var codexChatFolder = regexp.MustCompile(`^\.cx-[A-Za-z0-9_-]{1,64}$`)

// checkCodexWorktreePath: an AIB subagent worktree folder, <root>/<repo hash>/sub-* (checkWorktreePath) or a Codex chat's
// <root>/<repo hash>/.cx-<chat>/sub-*, every folder on the way plain (no link, no reparse point).
func checkCodexWorktreePath(path, root string) error {
	if checkWorktreePath(path, root) == nil {
		return nil
	}
	if path == "" || strings.ContainsAny(path, "\r\n\x00") || !filepath.IsAbs(path) {
		return errors.New("not an absolute path")
	}
	for _, part := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == "." || part == ".." {
			return errors.New("not a plain path")
		}
	}
	clean := filepath.Clean(path)
	chat := filepath.Dir(clean)
	repo := filepath.Dir(chat)
	if !samePath(filepath.Dir(repo), filepath.Clean(root)) {
		return errors.New("not under AIB's worktrees folder")
	}
	if !subFolderName.MatchString(filepath.Base(clean)) || !codexChatFolder.MatchString(filepath.Base(chat)) ||
		!repoFolderName.MatchString(filepath.Base(repo)) {
		return errors.New("not a Codex subagent worktree's name")
	}
	for _, p := range []string{repo, chat, clean} {
		fi, err := os.Lstat(p)
		if err != nil || !fi.IsDir() || isReparsePoint(fi) {
			return fmt.Errorf("%s is not a plain folder", p)
		}
	}
	return nil
}
