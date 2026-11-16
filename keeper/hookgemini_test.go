package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// geminiWorktree makes <state>/worktrees/<hash>/.gem-c1/sub-c1-1 next to the address file; returns the worktree folder.
func geminiWorktree(t *testing.T, file string) string {
	t.Helper()
	wt := filepath.Join(filepath.Dir(file), "worktrees", "abcdef12", ".gem-c1", "sub-c1-1")
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	return wt
}

const geminiWrite = `{"hook_event_name":"BeforeTool","tool_name":"write_file","tool_input":{"file_path":"sub.txt","content":"x","n":2}}`

func rewrite(path string) string {
	b, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "BeforeTool",
		"tool_input": map[string]any{"file_path": path, "content": "x", "n": 2}}})
	return string(b)
}

func TestGeminiHookPrintsRewriteIntoItsWorktree(t *testing.T) {
	var gotPath, target string
	file := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		gotPath = r.URL.Path
		signed(w, r, 200, rewrite(target))
	})
	target = filepath.Join(geminiWorktree(t, file), "sub.txt")
	code, out, errText := runHook(t, "gemini-before-tool", file, geminiWrite, 5*time.Second)
	if code != 0 || errText != "" {
		t.Fatalf("code %d stderr %q", code, errText)
	}
	if gotPath != "/hooks/gemini/before-tool" {
		t.Fatalf("path %q", gotPath)
	}
	var doc map[string]map[string]any
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("not JSON: %q", out)
	}
	ti := doc["hookSpecificOutput"]["tool_input"].(map[string]any)
	if ti["file_path"] != target || ti["content"] != "x" || doc["hookSpecificOutput"]["hookEventName"] != "BeforeTool" {
		t.Fatalf("rewrite %q", out)
	}
	if !strings.Contains(out, `"n":2`) {
		t.Fatalf("numbers as written: %q", out)
	}
}

func TestGeminiHookPrintsDenyAndNothingForPass(t *testing.T) {
	code, out, _ := runHook(t, "gemini-before-tool", answering(t, 200, `{"decision":"deny","reason":"AIB says no"}`), geminiWrite, 5*time.Second)
	if code != 0 || out != `{"decision":"deny","reason":"AIB says no"}` {
		t.Fatalf("deny: %d %q", code, out)
	}
	code, out, _ = runHook(t, "gemini-before-tool", answering(t, 200, `{}`), geminiWrite, 5*time.Second)
	if code != 0 || out != "" {
		t.Fatalf("pass: %d %q", code, out)
	}
}

// Every failure prints nothing and exits 0: the call goes on unchanged and AIB's policy fence (which Gemini checks after this hook)
// denies a subagent's write outside its worktree. Nothing a non-AIB program says is printed.
func TestGeminiHookFailuresLeaveTheCallToTheFence(t *testing.T) {
	unsigned := hookServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.WriteHeader(200)
		w.Write([]byte(`{"decision":"allow"}`))
	})
	cases := map[string]string{
		"dead":     deadAddress(t),
		"unsigned": unsigned,
		"non-200":  answering(t, 503, `{"decision":"deny","reason":"x"}`),
		"allow":    answering(t, 200, `{"decision":"allow","reason":"x"}`),
		"html":     answering(t, 200, `<html></html>`),
		"extra":    answering(t, 200, `{"decision":"deny","reason":"x","systemMessage":"hi"}`),
	}
	for name, file := range cases {
		code, out, errText := runHook(t, "gemini-before-tool", file, geminiWrite, 3*time.Second)
		if code != 0 || out != "" || errText != "" {
			t.Fatalf("%s: code %d out %q err %q", name, code, out, errText)
		}
	}
}

func TestGeminiHookRefusesRewritesOutsideAGeminiWorktree(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "artifact-mcp.json")
	wt := geminiWorktree(t, file)
	root := filepath.Join(dir, "worktrees")
	os.MkdirAll(filepath.Join(root, "abcdef12", "sub-c1-2"), 0o755) // a Claude subagent's worktree (no .gem- folder)
	bad := map[string]string{
		"project":        filepath.Join(dir, "proj", "sub.txt"),
		"claude layout":  filepath.Join(root, "abcdef12", "sub-c1-2", "sub.txt"),
		"dotdot":         wt + string(filepath.Separator) + ".." + string(filepath.Separator) + "x.txt",
		"the worktree":   wt,
		"relative":       "sub.txt",
		"missing chat":   filepath.Join(root, "abcdef12", ".gem-zz", "sub-zz-1", "a.txt"),
		"bad hash":       filepath.Join(root, "ABC", ".gem-c1", "sub-c1-1", "a.txt"),
		"newline":        wt + string(filepath.Separator) + "a\n.txt",
	}
	for name, path := range bad {
		if checkGeminiTarget(path, root) == nil {
			t.Fatalf("%s: %q accepted", name, path)
		}
	}
	if err := checkGeminiTarget(filepath.Join(wt, "deep", "new", "a.txt"), root); err != nil {
		t.Fatalf("a new file deep in the worktree: %v", err)
	}
	// only file_path may change, and only for write_file / replace
	answer := []byte(rewrite(filepath.Join(wt, "sub.txt")))
	if _, ok := checkGeminiAnswer([]byte(geminiWrite), answer, root); !ok {
		t.Fatal("a good rewrite was refused")
	}
	other := strings.Replace(string(answer), `"content":"x"`, `"content":"y"`, 1)
	if _, ok := checkGeminiAnswer([]byte(geminiWrite), []byte(other), root); ok {
		t.Fatal("changed content accepted")
	}
	shell := `{"hook_event_name":"BeforeTool","tool_name":"run_shell_command","tool_input":{"file_path":"sub.txt","content":"x","n":2}}`
	if _, ok := checkGeminiAnswer([]byte(shell), answer, root); ok {
		t.Fatal("a rewrite of a shell call accepted")
	}
	link := filepath.Join(root, "abcdef12", ".gem-c3")
	if makeDirLink(link, filepath.Join(dir, "elsewhere")) {
		os.MkdirAll(filepath.Join(dir, "elsewhere", "sub-c3-1"), 0o755)
		if checkGeminiTarget(filepath.Join(link, "sub-c3-1", "a.txt"), root) == nil {
			t.Fatal("a .gem- junction accepted")
		}
	}
}
