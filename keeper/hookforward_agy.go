package main

// AIB-keeper hook agy-<event> <address file>: an Antigravity CLI (`agy`) command hook forwarded to AIB (subagent worktrees,
// Antigravity: server/subagents/antigravity.ts). Same forwarder as Claude's, Codex's and Qwen's (hookforward.go: key and chat from the
// environment, a fresh nonce, the answer signed by AIB, no redirects, the address file's pid alive), agy's own events and answer
// shapes (tested on agy 1.5.11, aib-shared/research/provider-builder-probe-2026-11-25.md):
//
//	agy-pre-tool       PreToolUse, every tool. The hook prints {"decision":"allow"} for a tool it does not touch (any other output makes
//	                   agy fail the call: a reply agy can't read, or a non-zero exit, fails the tool call, so it fails closed on its own).
//	                   The main agent's calls other than the subagent tools pass here, without AIB. The subagent tools (invoke_subagent,
//	                   define_subagent, run_workflow, swarm, manage_subagents) and every call of a subagent go to AIB.
//	agy-session-start  SessionStart: a subagent's conversation starts (its cwd is its worktree): AIB binds the worktree to it. Prints {}.
//	agy-stop           Stop: a subagent's loop ended: a hint for AIB (the work lands when it ends). Prints {}.
//
// Who is a subagent: its cwd lies under AIB_HOOK_SUBROOT, the folder agy keeps its subagent worktrees in (<gemini dir>/antigravity-cli/
// worktrees; set by AIB on the agent process, never by the agent). The main agent works in the chat's folder. A chat AIB can give no
// isolation (not a git project) has AIB_HOOK_PASS=1: everything passes, as the other agents' subagents do there.
//
// A signed answer is still checked for shape, and what is printed is rebuilt here (never AIB's bytes):
//
//	allow             {"decision":"allow"}, for any call except: invoke_subagent (needs the overwrite below), run_workflow, a swarm `add`,
//	                  and any subagent tool called by a subagent; a subagent's write_file or edit_file only for an absolute Path inside a
//	                  folder under AIB_HOOK_SUBROOT.
//	allow + overwrite invoke_subagent of the main agent with exactly {"Workspace":"branch"} (agy then makes the subagent a real git
//	                  worktree and branch); define_subagent with {"EnableSubagentTools":false} (no nested subagents).
//	deny              {"decision":"deny","reason":...} with a reason.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
)

var agyEventPaths = map[string]string{"agy-pre-tool": "pre-tool", "agy-session-start": "session-start", "agy-stop": "stop"}

// agySpawnTools: every tool that starts or controls other agents.
var agySpawnTools = map[string]bool{"invoke_subagent": true, "define_subagent": true, "run_workflow": true, "swarm": true, "manage_subagents": true}

// agyWriteTools: agy's file-changing tools (run_command is checked by AIB).
var agyWriteTools = map[string]bool{"write_file": true, "edit_file": true}

func agyJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func agyDeny(reason string) []byte { return agyJSON(map[string]any{"decision": "deny", "reason": reason}) }
func agyAllow() []byte             { return agyJSON(map[string]any{"decision": "allow"}) }

type agyInput struct {
	Conversation string `json:"conversationId"`
	Cwd          string `json:"cwd"`
	ToolCall     struct {
		Name string          `json:"name"`
		Args json.RawMessage `json:"args"`
	} `json:"toolCall"`
}

func parseAgyInput(input []byte) (agyInput, bool) {
	var in agyInput
	return in, json.Unmarshal(input, &in) == nil
}

// pathUnder: path is root or lies inside it (case-insensitive on Windows; separators either way; no `..` part).
func pathUnder(path, root string, orIs bool) bool {
	if path == "" || root == "" || strings.ContainsAny(path, "\r\n\x00") {
		return false
	}
	for _, part := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return false
		}
	}
	p, r := filepath.Clean(filepath.FromSlash(path)), filepath.Clean(filepath.FromSlash(root))
	if runtime.GOOS == "windows" {
		p, r = strings.ToLower(p), strings.ToLower(r)
	}
	if p == r {
		return orIs
	}
	return strings.HasPrefix(p, strings.TrimRight(r, string(filepath.Separator))+string(filepath.Separator))
}

func (h *hookForwarder) agyIsSub(cwd string) bool { return pathUnder(cwd, h.subRoot, false) }

// agyLocal: what to print without asking AIB, when that is decided here (AIB down or not).
func (h *hookForwarder) agyLocal(input []byte) ([]byte, bool) {
	in, ok := parseAgyInput(input)
	if h.event != "agy-pre-tool" {
		if h.pass || (ok && !h.agyIsSub(in.Cwd)) {
			return []byte("{}"), true // the main agent's own start and stop, or a chat with no isolation: nothing to ask
		}
		return nil, false
	}
	if !ok {
		return nil, false
	}
	if in.ToolCall.Name == "run_command" {
		var args struct {
			CommandLine string `json:"CommandLine"`
		}
		if json.Unmarshal(in.ToolCall.Args, &args) == nil && killsByName(args.CommandLine, 0) {
			return agyDeny("AIB: " + killByNameReason), true // hook 3's refusal, for the main agent and subagents alike
		}
	}
	if h.pass || (!h.agyIsSub(in.Cwd) && !agySpawnTools[in.ToolCall.Name]) {
		return agyAllow(), true
	}
	return nil, false
}

// agyAnswer: what to print and the exit code for AIB's signed answer to an agy-* event.
func (h *hookForwarder) agyAnswer(input []byte, status int, body []byte, stdout, stderr io.Writer) int {
	if h.event != "agy-pre-tool" {
		stdout.Write([]byte("{}")) // session start / stop: only a hint for AIB
		return 0
	}
	if status != http.StatusOK {
		fmt.Fprintln(stderr, hookRestarting)
		stdout.Write(agyDeny(hookRestarting))
		return 0
	}
	out, ok := checkAgyPreToolAnswer(input, body, h.subRoot)
	if !ok {
		fmt.Fprintln(stderr, hookUnconfirmed)
		stdout.Write(agyDeny(hookUnconfirmed))
		return 0
	}
	stdout.Write(out)
	return 0
}

// checkAgyPreToolAnswer: what to print for AIB's signed pre-tool answer (see the file comment), or false.
func checkAgyPreToolAnswer(input, body []byte, subRoot string) ([]byte, bool) {
	in, ok := parseAgyInput(input)
	if !ok {
		return nil, false
	}
	tool := in.ToolCall.Name
	sub := pathUnder(in.Cwd, subRoot, false)
	top, ok := jsonObject(body)
	if !ok {
		return nil, false
	}
	var decision string
	if json.Unmarshal(top["decision"], &decision) != nil {
		return nil, false
	}
	switch decision {
	case "deny":
		var reason string
		if len(top) != 2 || json.Unmarshal(top["reason"], &reason) != nil || strings.TrimSpace(reason) == "" {
			return nil, false
		}
		return agyDeny(reason), true
	case "allow":
	default:
		return nil, false
	}
	var args map[string]any
	if len(in.ToolCall.Args) > 0 {
		if json.Unmarshal(in.ToolCall.Args, &args) != nil {
			return nil, false
		}
	}
	var overwrite map[string]any
	switch len(top) {
	case 1:
	case 2:
		raw, has := top["overwrite"]
		if !has {
			return nil, false
		}
		if json.Unmarshal(raw, &overwrite) != nil || overwrite == nil {
			return nil, false
		}
	default:
		return nil, false
	}
	want := map[string]any(nil) // the overwrite this call must carry, if any
	switch {
	case sub && agySpawnTools[tool]:
		return nil, false // a subagent never starts or controls agents: AIB denies
	case tool == "invoke_subagent":
		want = map[string]any{"Workspace": "branch"}
	case tool == "run_workflow":
		return nil, false // AIB always denies it
	case tool == "swarm":
		if action, _ := args["action"].(string); action == "add" {
			return nil, false
		}
	case tool == "define_subagent":
		if args["EnableSubagentTools"] == true {
			want = map[string]any{"EnableSubagentTools": false}
		}
	case sub && agyWriteTools[tool]:
		path, _ := args["Path"].(string)
		if !filepath.IsAbs(filepath.FromSlash(path)) || !pathUnder(path, subRoot, false) {
			return nil, false
		}
	}
	if want == nil && overwrite != nil {
		return nil, false
	}
	if want != nil && !reflect.DeepEqual(overwrite, want) {
		return nil, false
	}
	if want != nil {
		return agyJSON(map[string]any{"decision": "allow", "overwrite": want}), true
	}
	return agyAllow(), true
}
