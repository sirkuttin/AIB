package main

// AIB-keeper hook <event> <address file>: a Claude Code command hook that forwards to AIB (subagent worktrees design v2 2.1, P0b).
//
// AIB gives each Claude chat in a git project per-session settings (never ~/.claude) whose hooks run this program:
//
//	PreToolUse(Agent|Task|EnterWorktree|Workflow|Skill) -> hook pre-tool   AIB answers hookSpecificOutput JSON (updatedInput or deny;
//	                                               Skill: a deny for a `context: fork` skill, else {})
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
// refusal of worktree-create (its text goes to stderr, exit 2). post-agent and subagent-stop always exit 0 and print nothing (hints).
//
// The answer is trusted only when it is AIB's (security review P1, MF 1): each request carries a fresh random nonce
// (X-Studio-Hook-Nonce) and AIB signs its answer with the chat's hook key: X-Studio-Hook-Proof = hex HMAC-SHA256(key,
// "studio-hook-proof/v1\0" nonce "\0" status "\0" body). A missing or wrong proof blocks, whatever the status. Even a signed answer
// is checked for shape before anything is printed: pre-tool prints only nothing ({} for a tool that is not a subagent), a deny with a
// text reason, or the call's own input plus isolation "worktree" (rebuilt here, never the server's bytes); worktree-create prints only
// a sub-* folder directly under <address file's folder>/worktrees/<repo hash>/ that exists and is no junction or link. No redirects
// are followed (the key never goes anywhere else) and the address file's pid must be a running process.
//
// Decided here, without AIB (so they work while AIB is down): an Agent/Task call whose subagent_type is in AIB_HOOK_READONLY (the
// read-only types AIB listed for this chat: Explore, Plan, ...) passes unchanged (exit 0, no output). Every other isolation value
// ("remote" too: nothing shows it never runs in the folder) goes to AIB.
//
// The chat's key goes in a header from the environment (AIB_HOOK_KEY, AIB_HOOK_CHAT; set by AIB on the agent process, inherited by
// its hooks); never in the command line, which Claude Code shows the model when a hook exits 2. Only loopback http URLs; no proxy.
// Git Bash runs the command (P0b R3), so AIB writes the program path with forward slashes in double quotes.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	hookDeadline    = 10 * time.Second
	hookMaxInput    = 4 << 20
	hookRestarting  = "AIB is restarting; try the subagent again in a moment."
	hookUnconfirmed = "AIB could not confirm this hook's answer, so the subagent was blocked; try again in a moment."
	hookKeyHeader   = "X-Studio-Hook-Key"
	hookChatHeader  = "X-Studio-Conversation-Id"
	hookNonceHeader = "X-Studio-Hook-Nonce"
	hookProofHeader = "X-Studio-Hook-Proof"
	hookProofLabel  = "studio-hook-proof/v1\x00"
)

var hookEvents = map[string]bool{"pre-tool": true, "worktree-create": true, "post-agent": true, "subagent-stop": true,
	"codex-pre-tool": true, "codex-subagent-start": true, "codex-subagent-stop": true, // codex-*: hookforward_codex.go
	"gemini-before-tool": true} // Gemini CLI's BeforeTool (hookgemini.go)

// blocking: the events whose failure must block the call (exit 2).
func hookBlocking(event string) bool {
	return event == "pre-tool" || event == "worktree-create" || event == "codex-pre-tool"
}

// errAIBGone: the address file names a process that no longer runs (AIB crashed; its port may be anyone's now).
var errAIBGone = errors.New("the AIB named in the address file is not running")

func hookMain(args []string) int {
	if len(args) == 1 && args[0] == "--check" {
		fmt.Println("hook 1")
		return 0
	}
	if len(args) != 2 || !hookEvents[args[0]] || args[1] == "" {
		fmt.Fprintln(os.Stderr, "usage: AIB-keeper hook pre-tool|worktree-create|post-agent|subagent-stop|codex-pre-tool|codex-subagent-start|codex-subagent-stop|gemini-before-tool <address file>")
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
	if h.event == "codex-pre-tool" && codexPassesLocally(input) {
		return 0 // the main Codex agent's own tool call (not spawn_agent): nothing to ask AIB
	}
	if h.key == "" || h.chat == "" {
		return fail(hookRestarting)
	}
	nonce, err := newHookNonce()
	if err != nil {
		return fail(hookRestarting)
	}
	status, body, proof, err := h.post(ctx, input, nonce)
	if err != nil {
		return fail(hookRestarting)
	}
	if !hmac.Equal([]byte(strings.ToLower(proof)), []byte(hookProof(h.key, nonce, status, body))) {
		return fail(hookUnconfirmed) // not AIB's answer (another program on the port), or changed on the way
	}
	if strings.HasPrefix(h.event, "codex-") {
		return h.codexAnswer(input, status, body, stdout, stderr)
	}
	if h.event == "gemini-before-tool" {
		if status != http.StatusOK {
			return 0 // the policy fence decides (hookgemini.go)
		}
		if out, ok := checkGeminiAnswer(input, body, h.worktreesRoot()); ok && len(out) > 0 {
			stdout.Write(out)
		}
		return 0
	}
	if !hookBlocking(h.event) {
		return 0 // post-agent, subagent-stop: hints for AIB; nothing goes back to Claude Code
	}
	switch {
	case status == http.StatusOK && h.event == "pre-tool":
		out, ok := checkPreToolAnswer(input, body)
		if !ok {
			return fail(hookUnconfirmed)
		}
		stdout.Write(out)
		return 0
	case status == http.StatusOK && h.event == "worktree-create":
		path := strings.TrimSpace(string(body))
		if checkWorktreePath(path, h.worktreesRoot()) != nil {
			return fail(hookUnconfirmed)
		}
		fmt.Fprint(stdout, path) // the bare path (P0b R2e): JSON here would be taken as a folder name
		return 0
	case status == http.StatusConflict && h.event == "worktree-create" && len(bytes.TrimSpace(body)) > 0:
		return fail(clip(strings.TrimSpace(string(body)), 400))
	default:
		return fail(hookRestarting)
	}
}

// passesLocally: an Agent/Task call of a read-only type AIB listed passes unchanged, AIB up or not. Nothing else does: no isolation
// value is exempt (security review P1, MF 2: "remote" was never shown to stay out of the folder).
func (h *hookForwarder) passesLocally(input []byte) bool {
	var doc struct {
		ToolName  string `json:"tool_name"`
		ToolInput struct {
			SubagentType *string `json:"subagent_type"`
		} `json:"tool_input"`
	}
	if json.Unmarshal(input, &doc) != nil {
		return false
	}
	if doc.ToolName != "Agent" && doc.ToolName != "Task" {
		return false
	}
	return doc.ToolInput.SubagentType != nil && h.readOnly[*doc.ToolInput.SubagentType]
}

func newHookNonce() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// hookProof: what AIB puts in X-Studio-Hook-Proof for this answer (server/artifacts/keys.ts hookProof).
func hookProof(key, nonce string, status int, body []byte) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(hookProofLabel))
	m.Write([]byte(nonce))
	m.Write([]byte{0})
	m.Write([]byte(strconv.Itoa(status)))
	m.Write([]byte{0})
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// checkPreToolAnswer: what to print for AIB's (signed) pre-tool answer, or false when it is none AIB gives (security review P1,
// MF 1b). Accepted, and rebuilt here from the call itself:
//   - {} for a tool that is not a subagent (nothing is printed);
//   - a deny with a text reason;
//   - for Agent/Task, updatedInput equal to the call's own tool_input plus isolation "worktree".
//
// Anything else (allow, ask, continue, systemMessage, another input, {} for a subagent or for EnterWorktree/Workflow) is refused.
func checkPreToolAnswer(input, body []byte) ([]byte, bool) {
	var call struct {
		ToolName  string          `json:"tool_name"`
		ToolInput json.RawMessage `json:"tool_input"`
	}
	if json.Unmarshal(input, &call) != nil {
		return nil, false
	}
	subagent := call.ToolName == "Agent" || call.ToolName == "Task"
	refused := call.ToolName == "EnterWorktree" || call.ToolName == "Workflow" // AIB always denies these
	top, ok := jsonObject(body)
	if !ok {
		return nil, false
	}
	if len(top) == 0 {
		return nil, !subagent && !refused
	}
	raw, ok := top["hookSpecificOutput"]
	if len(top) != 1 || !ok {
		return nil, false
	}
	out, ok := jsonObject(raw)
	if !ok {
		return nil, false
	}
	var event string
	if json.Unmarshal(out["hookEventName"], &event) != nil || event != "PreToolUse" {
		return nil, false
	}
	switch len(out) {
	case 3:
		var decision, reason string
		if json.Unmarshal(out["permissionDecision"], &decision) != nil || decision != "deny" ||
			json.Unmarshal(out["permissionDecisionReason"], &reason) != nil || strings.TrimSpace(reason) == "" {
			return nil, false
		}
		answer, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason,
		}})
		return answer, err == nil
	case 2:
		updated, ok := out["updatedInput"]
		if !ok || !subagent {
			return nil, false
		}
		var got any
		if json.Unmarshal(updated, &got) != nil {
			return nil, false
		}
		want, ok := toolInputMap(call.ToolInput, false)
		if !ok {
			return nil, false
		}
		want["isolation"] = "worktree"
		if !reflect.DeepEqual(got, any(want)) {
			return nil, false
		}
		exact, _ := toolInputMap(call.ToolInput, true) // the call's own values, numbers as written
		exact["isolation"] = "worktree"
		answer, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "PreToolUse", "updatedInput": exact}})
		return answer, err == nil
	default:
		return nil, false
	}
}

// jsonObject: a JSON object's members (not null, not an array, not text).
func jsonObject(raw []byte) (map[string]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var out map[string]json.RawMessage
	if json.Unmarshal(trimmed, &out) != nil || out == nil {
		return nil, false
	}
	return out, true
}

// toolInputMap: the call's tool_input as a map ({} when it is missing or not an object, as AIB reads it).
func toolInputMap(raw json.RawMessage, numbers bool) (map[string]any, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return map[string]any{}, true
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	if numbers {
		dec.UseNumber()
	}
	var out map[string]any
	if dec.Decode(&out) != nil || out == nil {
		return nil, false
	}
	return out, true
}

var (
	subFolderName  = regexp.MustCompile(`^sub-[A-Za-z0-9_-]{1,64}$`)
	repoFolderName = regexp.MustCompile(`^[0-9a-f]{6,64}$`)
)

// worktreesRoot: AIB's worktrees folder, beside the address file in AIB's state folder (never taken from the environment).
func (h *hookForwarder) worktreesRoot() string {
	return filepath.Join(filepath.Dir(filepath.Clean(filepath.FromSlash(h.addressFile))), "worktrees")
}

// checkWorktreePath: nil when path is a worktree folder AIB makes: absolute, <root>/<repo hash>/sub-*, both an existing directory
// and neither a junction, a symlink nor another reparse point (security review P1, MF 1c).
func checkWorktreePath(path, root string) error {
	if path == "" || strings.ContainsAny(path, "\r\n\x00") || !filepath.IsAbs(path) {
		return errors.New("not an absolute path")
	}
	for _, part := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == "." || part == ".." {
			return errors.New("not a plain path")
		}
	}
	clean := filepath.Clean(path)
	repo := filepath.Dir(clean)
	if !samePath(filepath.Dir(repo), filepath.Clean(root)) {
		return errors.New("not under AIB's worktrees folder")
	}
	if !subFolderName.MatchString(filepath.Base(clean)) || !repoFolderName.MatchString(filepath.Base(repo)) {
		return errors.New("not a subagent worktree's name")
	}
	for _, p := range []string{repo, clean} {
		fi, err := os.Lstat(p)
		if err != nil || !fi.IsDir() || isReparsePoint(fi) {
			return fmt.Errorf("%s is not a plain folder", p)
		}
	}
	return nil
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// endpoint: the hook route of the AIB named in the address file, or an error (missing, closed, not loopback, its process gone).
func (h *hookForwarder) endpoint() (string, error) {
	raw, err := os.ReadFile(h.addressFile)
	if err != nil {
		return "", err
	}
	var doc struct {
		URL    string `json:"url"`
		Closed bool   `json:"closed"`
		Pid    *int   `json:"pid"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	if doc.Closed {
		return "", errAIBClosed
	}
	if doc.Pid == nil || !pidAlive(*doc.Pid) {
		return "", errAIBGone // a crash leaves the file: until a new AIB rewrites it, nobody on that port is AIB
	}
	u, err := url.Parse(doc.URL)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return "", fmt.Errorf("not a loopback http URL: %q", doc.URL)
	}
	u.Path = "/hooks/claude/" + h.event
	if rest, ok := strings.CutPrefix(h.event, "codex-"); ok {
		u.Path = "/hooks/codex/" + rest
	}
	if h.event == "gemini-before-tool" {
		u.Path = "/hooks/gemini/before-tool"
	}
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}

// post delivers the hook input, trying again while AIB cannot be reached (a restart), until the deadline. Returns the status, the
// body and the answer's proof header. Redirects are never followed: the key and the input go to the address file's URL only.
func (h *hookForwarder) post(ctx context.Context, input []byte, nonce string) (int, []byte, string, error) {
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for {
		target, err := h.endpoint()
		if err == nil {
			req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(input))
			if rerr != nil {
				return 0, nil, "", rerr
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(hookKeyHeader, h.key)
			req.Header.Set(hookChatHeader, h.chat)
			req.Header.Set(hookNonceHeader, nonce)
			resp, derr := client.Do(req)
			if derr == nil {
				body, berr := io.ReadAll(io.LimitReader(resp.Body, hookMaxInput))
				resp.Body.Close()
				if berr != nil {
					return 0, nil, "", berr
				}
				return resp.StatusCode, body, resp.Header.Get(hookProofHeader), nil
			}
			if !notDelivered(derr) { // it may have reached AIB: never sent twice
				return 0, nil, "", derr
			}
			err = derr
		}
		if errors.Is(err, errAIBClosed) {
			return 0, nil, "", err
		}
		select {
		case <-ctx.Done():
			return 0, nil, "", ctx.Err()
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
