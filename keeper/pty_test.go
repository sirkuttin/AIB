package main

// Terminals in the keeper (keeper 1.2.0): once-keyed input and resize on a pty, the bounded journal (`scrollback`), the opaque
// `label`, exit codes, and the whole terminal tree dying with the keeper (K3).

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func spawnPty(t *testing.T, c *client, id string, extra map[string]any, args ...string) msg {
	t.Helper()
	fields := map[string]any{"channel": id, "command": agentBin, "args": args, "pty": map[string]int{"cols": 80, "rows": 25}}
	for k, v := range extra {
		fields[k] = v
	}
	return c.must("spawn", fields, nil)
}

func TestPtyInputAndResizeOnceKeys(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	c := dial(t, k)
	spawnPty(t, c, "p", nil, "echo", "pty")
	c.must("attach", map[string]any{"channel": "p"}, nil)
	c.outputUntil("p", 10*time.Second, "out", `"ready"`)
	c.must("write", map[string]any{"channel": "p", "epoch": 1, "once": "in:1"}, []byte("first\r"))
	if r := c.call("write", map[string]any{"channel": "p", "epoch": 1, "once": "in:1"}, []byte("first\r")); r.str("error") != errDuplicate {
		t.Fatalf("a repeated input key: %v", r.h)
	}
	c.must("write", map[string]any{"channel": "p", "epoch": 1, "once": "in:2"}, []byte("second\r"))
	out := c.outputUntil("p", 10*time.Second, "out", "ECHO second")
	if n := bytes.Count([]byte(out), []byte("ECHO first")); n != 1 {
		t.Fatalf("the keyed input reached the terminal %d times: %q", n, out)
	}
	c.must("resize", map[string]any{"channel": "p", "epoch": 1, "once": "size:1", "cols": 120, "rows": 40}, nil)
	if r := c.call("resize", map[string]any{"channel": "p", "epoch": 1, "once": "size:1", "cols": 50, "rows": 10}, nil); r.str("error") != errDuplicate {
		t.Fatalf("a repeated resize key: %v", r.h)
	}
	c.must("write", map[string]any{"channel": "p", "epoch": 1}, []byte("size\r"))
	c.outputUntil("p", 10*time.Second, "out", "SIZE 120x40")
}

func TestPtyExitCodeAndKill(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	c := dial(t, k)
	spawnPty(t, c, "a", nil, "echo", "pty")
	c.must("attach", map[string]any{"channel": "a"}, nil)
	c.outputUntil("a", 10*time.Second, "out", `"ready"`)
	c.must("write", map[string]any{"channel": "a", "epoch": 1}, []byte("exit 7\r"))
	exit := c.next(10*time.Second, isRecord("a", "exit"))
	if !bytes.Contains(exit.body, []byte(`"code":7`)) || !bytes.Contains(exit.body, []byte(`"reason":"exit"`)) {
		t.Fatalf("exit %s", exit.body)
	}
	if r := c.call("write", map[string]any{"channel": "a", "epoch": 1}, []byte("x\r")); r.str("error") != errEnded {
		t.Fatalf("write after exit: %v", r.h)
	}

	spawnPty(t, c, "b", nil, "tree")
	c.must("attach", map[string]any{"channel": "b"}, nil)
	child, grand := ptyTree(t, c, "b")
	c.must("kill", map[string]any{"channel": "b", "epoch": 1}, nil)
	waitGone(t, child, 3*time.Second)
	waitGone(t, grand, 3*time.Second)
	exit = c.next(5*time.Second, isRecord("b", "exit"))
	if !bytes.Contains(exit.body, []byte(`"reason":"killed"`)) {
		t.Fatalf("exit %s", exit.body)
	}
}

var treeLine = regexp.MustCompile(`\{"child":(\d+),"grandchild":(\d+)\}`)

// ptyTree reads the tree mode's pids from terminal output (escape sequences and line wrapping around them).
func ptyTree(t *testing.T, c *client, id string) (int, int) {
	t.Helper()
	out := c.outputUntil(id, 10*time.Second, "out", "}")
	m := treeLine.FindStringSubmatch(out)
	if m == nil {
		out += c.outputUntil(id, 5*time.Second, "out", "ready")
		if m = treeLine.FindStringSubmatch(out); m == nil {
			t.Fatalf("tree output %q", out)
		}
	}
	child, _ := strconv.Atoi(m[1])
	grand, _ := strconv.Atoi(m[2])
	return child, grand
}

func TestPtyScrollbackIsBoundedAndLabelListed(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data)
	c := dial(t, k)
	const scrollback = 64 << 10
	if r := c.call("spawn", map[string]any{"channel": "bad", "command": agentBin, "args": []string{"sleep"}, "scrollback": 1000}, nil); r.str("error") != errBadRequest {
		t.Fatalf("a too small scrollback: %v", r.h)
	}
	label := `{"t":"terminal","key":"chat 1"}`
	spawnPty(t, c, "s", map[string]any{"scrollback": scrollback, "label": label}, "spam", "20000") // about 2 MB of output
	c.must("attach", map[string]any{"channel": "s"}, nil)
	c.next(30*time.Second, isRecord("s", "exit"))
	c.must("detach", map[string]any{"channel": "s"}, nil)

	l := c.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if l["label"] != label {
		t.Fatalf("label %v", l["label"])
	}
	if first := uint64(l["first"].(float64)); first <= 1 {
		t.Fatalf("nothing was dropped (first %d)", first)
	}
	var onDisk int64
	files, _ := os.ReadDir(filepath.Join(data, "keeper", "channels", "s"))
	for _, f := range files {
		if fi, err := f.Info(); err == nil {
			onDisk += fi.Size()
		}
	}
	// At most scrollback plus a quarter (the bound) plus the active segment.
	if onDisk > scrollback+scrollback/2 {
		t.Fatalf("journal on disk is %d bytes for a %d-byte scrollback", onDisk, scrollback)
	}

	// A new reader gets a gap, then at least the newest `scrollback` bytes of records, ending with the exit.
	c2 := dial(t, k)
	c2.must("attach", map[string]any{"channel": "s", "from": 0}, nil)
	gap := c2.next(5*time.Second, func(m msg) bool { return m.str("ev") == "gap" })
	if gap.num("from") != 1 || gap.num("next") <= 1 {
		t.Fatalf("gap %v", gap.h)
	}
	var kept int
	for {
		m := c2.next(10*time.Second, func(m msg) bool { return m.str("ev") == "record" || m.str("ev") == "live" })
		if m.str("ev") == "live" {
			break
		}
		kept += recHead + len(m.body) + recTail
	}
	if kept < scrollback {
		t.Fatalf("only %d bytes of records kept for a %d-byte scrollback", kept, scrollback)
	}

	// The label survives a keeper restart (channels.json).
	k.kill()
	k2 := startKeeper(t, data)
	c3 := dial(t, k2)
	l = c3.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if l["label"] != label {
		t.Fatalf("label after restart %v", l["label"])
	}
}

func TestPtyTreeDiesWithKeeper(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data)
	c := dial(t, k)
	spawnPty(t, c, "t", map[string]any{"scrollback": 1 << 20}, "tree")
	c.must("attach", map[string]any{"channel": "t"}, nil)
	child, grand := ptyTree(t, c, "t")
	if !processAlive(child) || !processAlive(grand) {
		t.Fatal("terminal tree not running")
	}
	k.kill() // a crash: nothing in the keeper runs
	waitGone(t, child, 3*time.Second)
	if runtime.GOOS == "windows" {
		waitGone(t, grand, 3*time.Second) // the terminal's Job Object closes with the keeper
	}
}
