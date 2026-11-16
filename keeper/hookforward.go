package main

// AIB-keeper hook <event> <address file>: a Claude Code command hook that forwards to AIB (subagent worktrees design v2 2.1, P0b).
//
// AIB gives each Claude chat in a git project per-session settings (never ~/.claude) whose hooks run this program:
//
//	PreToolUse(Agent|Task|EnterWorktree|Workflow)  -> hook pre-tool        AIB answers hookSpecificOutput JSON (updatedInput or deny)
//	WorktreeCreate                                 -> hook worktree-create AIB answers the worktree's bare path (text/plain)
//	PostToolUse(Agent|Task)                        -> hook post-agent      a hint only
//	SubagentStop                                   -> hook subagent-stop   a hint only
//
// It lives in the keeper's folder (never an AIB version folder) and reads AIB's current address from <address file> (the MCP forwarder's
// artifact-mcp.json), so a chat kept running across an AIB restart or update reaches whichever AIB runs now.
//
// Fails closed (P0b R1, R2, R2c): Claude Code runs a tool when a hook fails in any other way than exit 2, or outlives its `timeout`. So
// for pre-tool and worktree-create, when AIB cannot be reached, answers anything but 200, or takes longer than hookDeadline (well under
// the 30 s `timeout` AIB puts in the settings), this exits 2 with "AIB is restarting; try the subagent again in a moment." on stderr,
// which blocks the call. AIB's own refusals come as JSON deny (exit 0, the parent sees the reason only); a 409 with a text body is a
// refusal of worktree-create (its text goes to stderr, exit 2). post-agent and subagent-stop always exit 0 (fail open: hints only).
//
// Decided here, without AIB (so they work while AIB is down): an Agent/Task call whose subagent_type is in AIB_HOOK_READONLY (the
// read-only types AIB listed for this chat: Explore, Plan, ...) or with isolation "remote" passes unchanged (exit 0, no output).
//
// The chat's key goes in a header from the environment (AIB_HOOK_KEY, AIB_HOOK_CHAT; set by AIB on the agent process, inherited by
// its hooks); never in the command line, which Claude Code shows the model when a hook exits 2. Only loopback http URLs; no proxy.
// Git Bash runs the command (P0b R3), so AIB writes the program path with forward slashes in double quotes.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	hookDeadline   = 10 * time.Second
	hookMaxInput   = 4 << 20
	hookRestarting = "AIB is restarting; try the subagent again in a moment."
	hookKeyHeader  = "X-Studio-Hook-Key"
	hookChatHeader = "X-Studio-Conversation-Id"
)

var hookEvents = map[string]bool{"pre-tool": true, "worktree-create": true, "post-agent": true, "subagent-stop": true}

// blocking: the events whose failure must block the call (exit 2).
func hookBlocking(event string) bool { return event == "pre-tool" || event == "worktree-create" }

func hookMain(args []string) int {
	if len(args) == 1 && args[0] == "--check" {
		fmt.Println("hook 1")
		return 0
	}
	if len(args) != 2 || !hookEvents[args[0]] || args[1] == "" {
		fmt.Fprintln(os.Stderr, "usage: AIB-keeper hook pre-tool|worktree-create|post-agent|subagent-stop <address file>")
		return 2
	}
	h := &hookForwarder{
		event:       args[0],
		addressFile: args[1],
		key:         os.Getenv("AIB_HOOK_KEY"),
		chat:        os.Getenv("AIB_HOOK_CHAT"),
		readOnly:    splitList(os.Getenv("AIB_HOOK_READONLY")),
		deadline:    hookDeadline,
	}
	return h.run(os.Stdin, os.Stdout, os.Stderr)
}

type hookForwarder struct {
	event       string
	addressFile string
	key, chat   string
	readOnly    map[string]bool
	deadline    time.Duration
}

func splitList(text string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(text, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out[p] = true
		}
	}
	return out
}

// run handles one hook call and returns the exit code.
func (h *hookForwarder) run(in io.Reader, stdout, stderr io.Writer) int {
	ctx, cancel := context.WithTimeout(context.Background(), h.deadline)
	defer cancel()
	fail := func(message string) int {
		if !hookBlocking(h.event) {
			return 0
		}
		fmt.Fprintln(stderr, message)
		return 2
	}
	input, err := readAllWithin(ctx, in, hookMaxInput)
	if err != nil {
		return fail(hookRestarting)
	}
	if h.event == "pre-tool" && h.passesLocally(input) {
		return 0
	}
	if h.key == "" || h.chat == "" {
		return fail(hookRestarting)
	}
	status, body, err := h.post(ctx, input)
	if err != nil {
		return fail(hookRestarting)
	}
	switch {
	case status == http.StatusOK:
		if h.event == "worktree-create" {
			path := strings.TrimSpace(string(body))
			if path == "" || strings.ContainsAny(path, "\r\n") {
				return fail(hookRestarting)
			}
			fmt.Fprint(stdout, path) // the bare path (P0b R2e): JSON here would be taken as a folder name
			return 0
		}
		stdout.Write(body)
		return 0
	case status == http.StatusConflict && h.event == "worktree-create" && len(bytes.TrimSpace(body)) > 0:
		return fail(clip(strings.TrimSpace(string(body)), 400))
	default:
		return fail(hookRestarting)
	}
}

// passesLocally: an Agent/Task call AIB never isolates (a read-only type it listed, or a remote one) passes unchanged, AIB up or not.
func (h *hookForwarder) passesLocally(input []byte) bool {
	var doc struct {
		ToolName  string `json:"tool_name"`
		ToolInput struct {
			SubagentType *string `json:"subagent_type"`
			Isolation    string  `json:"isolation"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(input, &doc) != nil {
		return false
	}
	if doc.ToolName != "Agent" && doc.ToolName != "Task" {
		return false
	}
	if doc.ToolInput.Isolation == "remote" {
		return true
	}
	return doc.ToolInput.SubagentType != nil && h.readOnly[*doc.ToolInput.SubagentType]
}

// endpoint: the hook route of the AIB named in the address file, or an error (missing, closed, not loopback).
func (h *hookForwarder) endpoint() (string, error) {
	raw, err := os.ReadFile(h.addressFile)
	if err != nil {
		return "", err
	}
	var doc struct {
		URL    string `json:"url"`
		Closed bool   `json:"closed"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	if doc.Closed {
		return "", errAIBClosed
	}
	u, err := url.Parse(doc.URL)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return "", fmt.Errorf("not a loopback http URL: %q", doc.URL)
	}
	u.Path = "/hooks/claude/" + h.event
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}

// post delivers the hook input, trying again while AIB cannot be reached (a restart), until the deadline.
func (h *hookForwarder) post(ctx context.Context, input []byte) (int, []byte, error) {
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}
	client := &http.Client{Transport: transport}
	for {
		target, err := h.endpoint()
		if err == nil {
			req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(input))
			if rerr != nil {
				return 0, nil, rerr
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(hookKeyHeader, h.key)
			req.Header.Set(hookChatHeader, h.chat)
			resp, derr := client.Do(req)
			if derr == nil {
				body, berr := io.ReadAll(io.LimitReader(resp.Body, hookMaxInput))
				resp.Body.Close()
				if berr != nil {
					return 0, nil, berr
				}
				return resp.StatusCode, body, nil
			}
			if !notDelivered(derr) { // it may have reached AIB: never sent twice
				return 0, nil, derr
			}
			err = derr
		}
		if errors.Is(err, errAIBClosed) {
			return 0, nil, err
		}
		select {
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// readAllWithin reads in to its end (at most limit bytes) or fails at the context's deadline.
func readAllWithin(ctx context.Context, in io.Reader, limit int64) ([]byte, error) {
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(in, limit))
		done <- result{data, err}
	}()
	select {
	case r := <-done:
		return r.data, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
