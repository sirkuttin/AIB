package main

// AIB-keeper hook gemini-before-tool <address file>: a Gemini CLI BeforeTool command hook (subagent worktrees, Gemini part;
// private design gemini-proof.md). AIB gives each Gemini chat in a git project its own GEMINI_CLI_HOME whose settings run this for
// write_file and replace. The chat's hook key and id ride in the hook entry's own `env` (Gemini sanitizes the inherited environment).
//
// The fence is not here. AIB launches every such chat with an --admin-policy file that denies each subagent's write_file and replace
// unless file_path is inside the chat's own subagent folder (<state>/worktrees/<repo hash>/.gem-<chat>/), and its shell and MCP tools
// always. Gemini checks that policy AFTER this hook (on the rewritten arguments), so this hook can only move a subagent's write into its
// worktree; it can never let one into the project folder. So every failure here (AIB unreachable, slow, not AIB's signed answer, an
// answer of the wrong shape) prints nothing and exits 0: the call goes on unchanged and the fence denies it.
//
// A signed answer is printed only when it is one of (rebuilt here, never the server's bytes):
//   - {}                                        nothing is printed (the parent's call, or a tool AIB leaves alone);
//   - {"decision": "deny", "reason": "<text>"}  the call is blocked with AIB's reason;
//   - {"hookSpecificOutput": {"hookEventName": "BeforeTool", "tool_input": {...}}} for write_file / replace: the call's own
//     arguments with only file_path changed, to a plain path inside a sub-* worktree in a .gem-* folder of AIB's worktrees folder.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
)

var (
	geminiChatFolder = regexp.MustCompile(`^\.gem-[A-Za-z0-9_-]{1,64}$`)
	geminiEditTools  = map[string]bool{"write_file": true, "replace": true}
)

// checkGeminiAnswer: what to print for AIB's (signed) BeforeTool answer, and whether it is one AIB gives. Nothing is printed for {}.
func checkGeminiAnswer(input, body []byte, root string) ([]byte, bool) {
	var call struct {
		ToolName  string          `json:"tool_name"`
		ToolInput json.RawMessage `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil {
		return nil, false
	}
	top, ok := jsonObject(body)
	if !ok {
		return nil, false
	}
	if len(top) == 0 {
		return nil, true
	}
	if len(top) == 2 {
		var decision, reason string
		if json.Unmarshal(top["decision"], &decision) != nil || decision != "deny" ||
			json.Unmarshal(top["reason"], &reason) != nil || strings.TrimSpace(reason) == "" {
			return nil, false
		}
		out, err := json.Marshal(map[string]any{"decision": "deny", "reason": clip(reason, 2000)})
		return out, err == nil
	}
	raw, ok := top["hookSpecificOutput"]
	if len(top) != 1 || !ok || !geminiEditTools[call.ToolName] {
		return nil, false
	}
	spec, ok := jsonObject(raw)
	if !ok || len(spec) != 2 {
		return nil, false
	}
	var event string
	if json.Unmarshal(spec["hookEventName"], &event) != nil || event != "BeforeTool" {
		return nil, false
	}
	var got map[string]any
	if json.Unmarshal(spec["tool_input"], &got) != nil || got == nil {
		return nil, false
	}
	target, _ := got["file_path"].(string)
	if checkGeminiTarget(target, root) != nil {
		return nil, false
	}
	want, ok := toolInputMap(call.ToolInput, false)
	if !ok {
		return nil, false
	}
	want["file_path"] = target
	if !reflect.DeepEqual(any(got), any(want)) {
		return nil, false // anything but file_path changed
	}
	exact, _ := toolInputMap(call.ToolInput, true) // the call's own values, numbers as written
	exact["file_path"] = target
	out, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "BeforeTool", "tool_input": exact}})
	return out, err == nil
}

// checkGeminiTarget: nil when path is a file path inside a subagent worktree AIB makes for a Gemini chat:
// <root>/<repo hash>/.gem-<chat>/sub-<name>/<something>, absolute, with no . or .. segment, and none of the three folders a junction,
// a link or another reparse point (they must exist). The file itself and folders below the worktree may not exist yet.
func checkGeminiTarget(path, root string) error {
	if path == "" || len(path) > 4096 || strings.ContainsAny(path, "\r\n\x00") || !filepath.IsAbs(path) {
		return errors.New("not an absolute path")
	}
	for _, part := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == "." || part == ".." {
			return errors.New("not a plain path")
		}
	}
	clean := filepath.Clean(path)
	rel, err := filepath.Rel(filepath.Clean(root), clean)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return errors.New("not under AIB's worktrees folder")
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) < 4 || !repoFolderName.MatchString(parts[0]) || !geminiChatFolder.MatchString(parts[1]) || !subFolderName.MatchString(parts[2]) {
		return errors.New("not inside a Gemini subagent worktree")
	}
	if !samePath(filepath.Join(filepath.Clean(root), parts[0], parts[1], parts[2], filepath.Join(parts[3:]...)), clean) {
		return errors.New("not a plain path")
	}
	dir := filepath.Clean(root)
	for _, p := range parts[:3] {
		dir = filepath.Join(dir, p)
		fi, err := os.Lstat(dir)
		if err != nil || !fi.IsDir() || isReparsePoint(fi) {
			return errors.New(dir + " is not a plain folder")
		}
	}
	return nil
}

