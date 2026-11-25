package main

// AIB-keeper hook qwen-<event> <address file>: a Qwen Code command hook forwarded to AIB (subagent worktrees, Qwen Code:
// server/subagents/qwen.ts). Same forwarder as Claude's and Codex's (hookforward.go: key and chat from the environment, a fresh
// nonce, the answer signed by AIB, no redirects, the address file's pid alive, fails closed), Qwen's own events and answer shapes.
// Qwen Code runs the command with `cmd.exe /d /s /c` on Windows (Git Bash when it runs in one) and `bash -c` elsewhere; exit 2 with a
// reason on stderr blocks a PreToolUse call, and so does a JSON deny. So:
//
//	qwen-pre-tool        PreToolUse, every tool. The main agent's own calls other than `agent` pass here, without AIB (the input has
//	                     no agent_id). `agent` (AIB prepares the subagent's worktree and sets its working_dir) and every call of a
//	                     subagent (agent_id set) go to AIB; AIB down, slow or unconfirmed -> a JSON deny, exit 0.
//	qwen-subagent-start  SubagentStart: AIB binds the prepared worktree to the agent_id and names it in additionalContext.
//	qwen-subagent-stop   SubagentStop: a hint for AIB (the work lands when the subagent ends); nothing is printed.
//
// A signed answer is still checked for shape, and what is printed is rebuilt here (never AIB's bytes):
//
//	pre-tool   {} for a subagent's tool, except a file write (write_file, edit, notebook_edit), which passes only when its path is an
//	           absolute path inside an AIB subagent worktree; a deny with a reason; for the main agent's `agent` call only, allow with
//	           updatedInput equal to the call's own input plus working_dir, an AIB subagent worktree folder (checkWorktreePath).
//	subagent-start  {} or additionalContext text (as Codex's).

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
)

// qwenIsAgentTool: Qwen's subagent tool (the model reaches it through tool_search and tool_call, but hooks see its own name).
func qwenIsAgentTool(name string) bool { return strings.EqualFold(name, "agent") }

// qwenPassesLocally: the main agent's own call of a tool other than `agent` (no agent_id) passes without AIB, and so does an
// `agent` call of a read-only type AIB listed (AIB_HOOK_READONLY: Explore), from the main agent or a subagent: that subagent runs
// in the project folder, and AIB limits its own calls (they carry its agent_id and go to AIB).
func (h *hookForwarder) qwenPassesLocally(input []byte) bool {
	var call struct {
		ToolName  string `json:"tool_name"`
		AgentID   string `json:"agent_id"`
		ToolInput struct {
			SubagentType *string `json:"subagent_type"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil || call.ToolName == "" {
		return false
	}
	if !qwenIsAgentTool(call.ToolName) {
		return call.AgentID == ""
	}
	return call.ToolInput.SubagentType != nil && h.readOnly[*call.ToolInput.SubagentType]
}

// qwenWriteTools: Qwen's file-changing tools and the input field that holds the path.
var qwenWriteTools = map[string]string{"write_file": "file_path", "edit": "file_path", "notebook_edit": "notebook_path"}

// qwenAnswer: what to print and the exit code for AIB's signed answer to a qwen-* event.
func (h *hookForwarder) qwenAnswer(input []byte, status int, body []byte, stdout, stderr io.Writer) int {
	switch h.event {
	case "qwen-subagent-start":
		if status == http.StatusOK {
			if out, ok := checkCodexStartAnswer(body); ok && out != nil {
				stdout.Write(out)
			}
		}
		return 0
	case "qwen-pre-tool":
		if status != http.StatusOK {
			fmt.Fprintln(stderr, hookRestarting)
			stdout.Write(codexDeny(hookRestarting))
			return 0
		}
		out, ok := checkQwenPreToolAnswer(input, body, h.worktreesRoot())
		if !ok {
			fmt.Fprintln(stderr, hookUnconfirmed)
			stdout.Write(codexDeny(hookUnconfirmed))
			return 0
		}
		stdout.Write(out)
		return 0
	default:
		return 0 // qwen-subagent-stop: a hint
	}
}

// checkQwenPreToolAnswer: what to print for AIB's signed pre-tool answer (see the file comment), or false.
func checkQwenPreToolAnswer(input, body []byte, root string) ([]byte, bool) {
	var call struct {
		ToolName  string          `json:"tool_name"`
		AgentID   string          `json:"agent_id"`
		ToolInput json.RawMessage `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil {
		return nil, false
	}
	sub := call.AgentID != ""
	agent := qwenIsAgentTool(call.ToolName)
	top, ok := jsonObject(body)
	if !ok {
		return nil, false
	}
	if len(top) == 0 {
		if agent {
			return nil, false // a subagent call is always isolated (main) or refused (nested): never passed as it is
		}
		if !sub {
			return []byte{}, true
		}
		if field, writes := qwenWriteTools[call.ToolName]; writes {
			in, ok := toolInputMap(call.ToolInput, false)
			path, isText := in[field].(string)
			return []byte{}, ok && isText && insideSubagentWorktree(path, root)
		}
		return []byte{}, true
	}
	out, ok := jsonObject(top["hookSpecificOutput"])
	if len(top) != 1 || !ok {
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
		if len(out) != 3 || json.Unmarshal(out["permissionDecisionReason"], &reason) != nil || strings.TrimSpace(reason) == "" {
			return nil, false
		}
		return codexDeny(reason), true
	case "allow":
		// only the main agent's own `agent` call, with its input plus working_dir (an AIB subagent worktree)
		if !agent || sub || len(out) != 4 {
			return nil, false
		}
		var reason string
		if json.Unmarshal(out["permissionDecisionReason"], &reason) != nil || strings.TrimSpace(reason) == "" {
			return nil, false
		}
		var got map[string]any
		if json.Unmarshal(out["updatedInput"], &got) != nil || got == nil {
			return nil, false
		}
		dir, isText := got["working_dir"].(string)
		if !isText || checkWorktreePath(filepath.FromSlash(dir), root) != nil {
			return nil, false
		}
		want, ok := toolInputMap(call.ToolInput, false)
		if !ok {
			return nil, false
		}
		want["working_dir"] = dir
		if !reflect.DeepEqual(got, want) {
			return nil, false
		}
		exact, _ := toolInputMap(call.ToolInput, true) // the call's own values, numbers as written
		exact["working_dir"] = dir
		answer, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "AIB: the subagent's own worktree",
			"updatedInput": exact,
		}})
		return answer, err == nil
	default:
		return nil, false
	}
}
