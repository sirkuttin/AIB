package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func spawnEcho(t *testing.T, c *client, id string, mode ...string) msg {
	t.Helper()
	if len(mode) == 0 {
		mode = []string{"echo"}
	}
	return c.must("spawn", map[string]any{"channel": id, "command": agentBin, "args": mode, "cwd": t.TempDir()}, nil)
}

func TestEchoWriteReadExit(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	c := dial(t, k)
	r := spawnEcho(t, c, "a1")
	if r.num("epoch") != 1 || r.num("pid") == 0 || r.str("kind") != "pipe" {
		t.Fatalf("spawn answer: %v", r.h)
	}
	c.must("attach", map[string]any{"channel": "a1", "from": 0}, nil)
	c.outputUntil("a1", 10*time.Second, "out", `"ready"`)
	w := c.must("write", map[string]any{"channel": "a1", "epoch": 1, "once": "prompt:1"}, []byte("hello\n"))
	if w.num("seq") == 0 {
		t.Fatalf("write gave no seq: %v", w.h)
	}
	in := c.next(5*time.Second, isRecord("a1", "in"))
	if string(in.body) != "hello\n" || in.num("seq") != w.num("seq") {
		t.Fatalf("in record: %v %q", in.h, in.body)
	}
	c.outputUntil("a1", 5*time.Second, "out", `{"echo":"hello"}`)
	c.outputUntil("a1", 5*time.Second, "err", "err:hello")
	c.must("closeStdin", map[string]any{"channel": "a1", "epoch": 1}, nil)
	exit := c.next(10*time.Second, isRecord("a1", "exit"))
	var e struct {
		Code   int    `json:"code"`
		Reason string `json:"reason"`
	}
	json.Unmarshal(exit.body, &e)
	if e.Code != 0 || e.Reason != "exit" {
		t.Fatalf("exit record %s", exit.body)
	}
	list := c.must("list", nil, nil)
	chs := list.h["channels"].([]any)
	if len(chs) != 1 || chs[0].(map[string]any)["live"].(bool) || !chs[0].(map[string]any)["owner"].(bool) {
		t.Fatalf("list: %v", list.h)
	}
	if r := c.call("write", map[string]any{"channel": "a1", "epoch": 1}, []byte("x\n")); r.str("error") != errEnded {
		t.Fatalf("write after exit: %v", r.h)
	}
	if r := c.call("spawn", map[string]any{"channel": "a1", "command": agentBin, "args": []string{"echo"}}, nil); r.str("error") != errExists {
		t.Fatalf("spawn of an existing id: %v", r.h)
	}
	// A note still goes onto an ended channel (AIB's release note, for example).
	c.must("note", map[string]any{"channel": "a1", "epoch": 1}, []byte(`{"v":1,"t":"release"}`))
	if n := c.next(5*time.Second, isRecord("a1", "note")); string(n.body) != `{"v":1,"t":"release"}` {
		t.Fatalf("note %q", n.body)
	}
}

func TestExitCodeAndEnv(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	c := dial(t, k)
	spawnEcho(t, c, "x")
	c.must("attach", map[string]any{"channel": "x"}, nil)
	c.must("write", map[string]any{"channel": "x", "epoch": 1}, []byte("exit 7\n"))
	exit := c.next(10*time.Second, isRecord("x", "exit"))
	if !bytes.Contains(exit.body, []byte(`"code":7`)) {
		t.Fatalf("exit %s", exit.body)
	}
	if r := c.call("spawn", map[string]any{"command": filepath.Join(t.TempDir(), "missing-program")}, nil); r.str("error") != errSpawnFailed {
		t.Fatalf("missing program: %v", r.h)
	}
	if r := c.call("spawn", map[string]any{"channel": "../evil", "command": agentBin}, nil); r.str("error") != errBadRequest {
		t.Fatalf("bad id: %v", r.h)
	}
}

func TestReplayFromAnyOffsetAcrossRotationAndRestart(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data, "--segment-bytes", "4096")
	c := dial(t, k)
	spawnEcho(t, c, "r", "spam", "500") // ~55 KB of output: many segments
	c.must("attach", map[string]any{"channel": "r"}, nil)
	var all []msg
	for {
		m := c.next(10*time.Second, func(m msg) bool { return m.str("ev") == "record" })
		all = append(all, m)
		if m.str("kind") == "exit" {
			break
		}
	}
	var out bytes.Buffer
	for i, m := range all {
		if m.num("seq") != uint64(i+1) {
			t.Fatalf("record %d has seq %d", i, m.num("seq"))
		}
		if m.str("kind") == "out" {
			out.Write(m.body)
		}
	}
	if lines := strings.Count(out.String(), "\n"); lines != 500 {
		t.Fatalf("got %d lines", lines)
	}
	segs, _ := filepath.Glob(filepath.Join(data, "keeper", "channels", "r", "*.journal"))
	if len(segs) < 5 {
		t.Fatalf("expected rotation, got %d segments", len(segs))
	}
	check := func(c *client, from uint64) {
		t.Helper()
		c.must("attach", map[string]any{"channel": "r", "from": from}, nil)
		for want := from; want <= uint64(len(all)); want++ {
			m := c.next(10*time.Second, func(m msg) bool { return m.str("ev") == "record" })
			ref := all[want-1]
			if m.num("seq") != want || m.str("kind") != ref.str("kind") || !bytes.Equal(m.body, ref.body) {
				t.Fatalf("from %d: record %d differs: %v", from, want, m.h)
			}
		}
		live := c.next(5*time.Second, func(m msg) bool { return m.str("ev") == "live" })
		if live.num("seq") != uint64(len(all)) {
			t.Fatalf("live at %d", live.num("seq"))
		}
		c.must("detach", map[string]any{"channel": "r"}, nil)
	}
	c2 := dial(t, k)
	for _, from := range []uint64{1, 2, uint64(len(all) / 3), uint64(len(all) / 2), uint64(len(all))} {
		check(c2, from)
	}
	// Beyond the end: nothing, then live.
	c2.must("attach", map[string]any{"channel": "r", "from": uint64(len(all) + 5)}, nil)
	if m := c2.next(5*time.Second, func(m msg) bool { return m.str("channel") == "r" }); m.str("ev") != "live" {
		t.Fatalf("beyond the end: %v", m.h)
	}
	c2.must("detach", map[string]any{"channel": "r"}, nil)

	// Truncate needs the owner; it removes whole old segments only.
	c2.must("claim", map[string]any{"channel": "r"}, nil)
	tr := c2.must("truncate", map[string]any{"channel": "r", "epoch": 2, "before": uint64(len(all) / 2)}, nil)
	first := tr.num("first")
	if first <= 1 || first > uint64(len(all)/2) {
		t.Fatalf("truncate first=%d", first)
	}
	c2.must("attach", map[string]any{"channel": "r", "from": 1}, nil)
	if g := c2.next(5*time.Second, func(m msg) bool { return m.str("channel") == "r" }); g.str("ev") != "gap" || g.num("next") != first {
		t.Fatalf("expected gap: %v", g.h)
	}
	c2.must("detach", map[string]any{"channel": "r"}, nil)

	// Restart: the journal is read back from disk by a new keeper.
	c.call("shutdown", nil, nil)
	if !k.waitExit(10 * time.Second) {
		t.Fatal("keeper did not shut down")
	}
	k2 := startKeeper(t, data, "--segment-bytes", "4096")
	c3 := dial(t, k2)
	l := c3.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if l["live"].(bool) || l["reason"] != "exit" || uint64(l["first"].(float64)) != first || uint64(l["last"].(float64)) != uint64(len(all)) {
		t.Fatalf("after restart: %v", l)
	}
	check(c3, first+3)
	// Removing an ended channel entirely: truncate past its end.
	ep := c3.must("claim", map[string]any{"channel": "r"}, nil).num("epoch")
	if r := c3.must("truncate", map[string]any{"channel": "r", "epoch": ep, "before": uint64(len(all) + 1)}, nil); r.h["removed"] != true {
		t.Fatalf("remove: %v", r.h)
	}
	if _, err := os.Stat(filepath.Join(data, "keeper", "channels", "r")); !os.IsNotExist(err) {
		t.Fatalf("journal folder still there: %v", err)
	}
}

func TestTakeoverFencesOldClient(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	a := dial(t, k)
	spawnEcho(t, a, "t")
	b := dial(t, k)
	b.must("attach", map[string]any{"channel": "t"}, nil)
	if r := b.call("write", map[string]any{"channel": "t", "epoch": 1}, []byte("x\n")); r.str("error") != errFenced {
		t.Fatalf("a non-owner wrote with the owner's epoch: %v", r.h)
	}
	cl := b.must("claim", map[string]any{"channel": "t"}, nil)
	if cl.num("epoch") != 2 {
		t.Fatalf("claim epoch %v", cl.h)
	}
	f := a.next(5*time.Second, func(m msg) bool { return m.str("ev") == "fenced" })
	if f.str("channel") != "t" || f.num("epoch") != 2 {
		t.Fatalf("fenced event %v", f.h)
	}
	for _, op := range []string{"write", "note", "kill", "closeStdin", "truncate"} {
		r := a.call(op, map[string]any{"channel": "t", "epoch": 1}, []byte("old\n"))
		if r.str("error") != errFenced || r.num("epoch") != 2 {
			t.Fatalf("old client %s: %v", op, r.h)
		}
		r = a.call(op, map[string]any{"channel": "t", "epoch": 2}, []byte("old\n")) // knowing the number is not enough
		if r.str("error") != errFenced {
			t.Fatalf("old client %s with new epoch: %v", op, r.h)
		}
	}
	b.must("write", map[string]any{"channel": "t", "epoch": 2}, []byte("new\n"))
	b.outputUntil("t", 5*time.Second, "out", `{"echo":"new"}`)
	// Nothing the old client sent reached the agent or the journal.
	b.must("detach", map[string]any{"channel": "t"}, nil)
	b.must("attach", map[string]any{"channel": "t"}, nil)
	for {
		m := b.next(5*time.Second, func(m msg) bool { return m.str("channel") == "t" })
		if m.str("ev") == "live" {
			break
		}
		if bytes.Contains(m.body, []byte("old")) {
			t.Fatalf("old client's bytes in the journal: %v %q", m.h, m.body)
		}
	}
	// The old client takes it back: the new one is fenced in turn.
	if a.must("claim", map[string]any{"channel": "t"}, nil).num("epoch") != 3 {
		t.Fatal("epoch 3 expected")
	}
	b.next(5*time.Second, func(m msg) bool { return m.str("ev") == "fenced" && m.num("epoch") == 3 })
}

func TestOnceKeyRefusesRepeat(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	a := dial(t, k)
	spawnEcho(t, a, "o")
	a.must("write", map[string]any{"channel": "o", "epoch": 1, "once": "prompt:42"}, []byte("one\n"))
	if r := a.call("write", map[string]any{"channel": "o", "epoch": 1, "once": "prompt:42"}, []byte("one\n")); r.str("error") != errDuplicate {
		t.Fatalf("repeat: %v", r.h)
	}
	a.must("note", map[string]any{"channel": "o", "epoch": 1, "once": "note:1"}, []byte("{}"))
	if r := a.call("note", map[string]any{"channel": "o", "epoch": 1, "once": "note:1"}, []byte("{}")); r.str("error") != errDuplicate {
		t.Fatalf("repeat note: %v", r.h)
	}
	// After a takeover the key is still used: the new owner's retry is refused, not sent twice.
	b := dial(t, k)
	ep := b.must("claim", map[string]any{"channel": "o"}, nil).num("epoch")
	if r := b.call("write", map[string]any{"channel": "o", "epoch": ep, "once": "prompt:42"}, []byte("one\n")); r.str("error") != errDuplicate {
		t.Fatalf("repeat after takeover: %v", r.h)
	}
	b.must("write", map[string]any{"channel": "o", "epoch": ep, "once": "prompt:43"}, []byte("two\n"))
	b.must("attach", map[string]any{"channel": "o"}, nil)
	out := b.outputUntil("o", 5*time.Second, "out", `{"echo":"two"}`)
	if strings.Count(out, `{"echo":"one"}`) != 1 {
		t.Fatalf("one was echoed %d times: %q", strings.Count(out, `{"echo":"one"}`), out)
	}
}

func readTree(t *testing.T, c *client, id string) (int, int) {
	t.Helper()
	out := c.outputUntil(id, 10*time.Second, "out", "}\n")
	var p struct{ Child, Grandchild int }
	if err := json.Unmarshal([]byte(strings.SplitN(out, "\n", 2)[0]), &p); err != nil || p.Grandchild == 0 {
		t.Fatalf("tree output %q", out)
	}
	return p.Child, p.Grandchild
}

func TestKillTree(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	c := dial(t, k)
	spawnEcho(t, c, "k", "tree")
	c.must("attach", map[string]any{"channel": "k"}, nil)
	child, grand := readTree(t, c, "k")
	if !processAlive(child) || !processAlive(grand) {
		t.Fatal("tree not running")
	}
	c.must("kill", map[string]any{"channel": "k", "epoch": 1}, nil)
	waitGone(t, child, 3*time.Second)
	waitGone(t, grand, 3*time.Second)
	exit := c.next(5*time.Second, isRecord("k", "exit"))
	if !bytes.Contains(exit.body, []byte(`"reason":"killed"`)) {
		t.Fatalf("exit %s", exit.body)
	}
}

func TestKeeperCrashKillsChildren(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data)
	c := dial(t, k)
	spawnEcho(t, c, "crash", "tree")
	c.must("attach", map[string]any{"channel": "crash"}, nil)
	child, grand := readTree(t, c, "crash")
	k.kill() // TerminateProcess / SIGKILL: no cleanup code runs in the keeper
	waitGone(t, child, 3*time.Second)
	if runtime.GOOS == "windows" {
		waitGone(t, grand, 3*time.Second) // the Job Object closes with the keeper's last handle
	}
	// The next keeper marks the channel as lost; nothing can be written to it.
	k2 := startKeeper(t, data)
	c2 := dial(t, k2)
	l := c2.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if l["live"].(bool) || l["reason"] != "keeper_lost" {
		t.Fatalf("after crash: %v", l)
	}
	c2.must("attach", map[string]any{"channel": "crash"}, nil)
	exit := c2.next(5*time.Second, isRecord("crash", "exit"))
	if !bytes.Contains(exit.body, []byte(`"reason":"keeper_lost"`)) {
		t.Fatalf("exit %s", exit.body)
	}
}

func TestPtySpawnResizeEcho(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	c := dial(t, k)
	r := c.must("spawn", map[string]any{"channel": "p", "command": agentBin, "args": []string{"echo", "pty"}, "pty": map[string]int{"cols": 80, "rows": 25}}, nil)
	if r.str("kind") != "pty" {
		t.Fatalf("kind %v", r.h)
	}
	c.must("attach", map[string]any{"channel": "p"}, nil)
	c.outputUntil("p", 10*time.Second, "out", `"ready"`)
	c.must("write", map[string]any{"channel": "p", "epoch": 1}, []byte("size\r"))
	c.outputUntil("p", 10*time.Second, "out", "SIZE 80x25")
	rs := c.must("resize", map[string]any{"channel": "p", "epoch": 1, "cols": 100, "rows": 30}, nil)
	rec := c.next(5*time.Second, isRecord("p", "resize"))
	if rec.num("seq") != rs.num("seq") || string(rec.body) != `{"cols":100,"rows":30}` {
		t.Fatalf("resize record %v %s", rec.h, rec.body)
	}
	c.must("write", map[string]any{"channel": "p", "epoch": 1}, []byte("size\r"))
	c.outputUntil("p", 10*time.Second, "out", "SIZE 100x30")
	c.must("write", map[string]any{"channel": "p", "epoch": 1}, []byte("hello pty\r"))
	c.outputUntil("p", 10*time.Second, "out", "ECHO hello pty")
	if r := c.call("closeStdin", map[string]any{"channel": "p", "epoch": 1}, nil); r.str("error") != errUnsupported {
		t.Fatalf("closeStdin on a pty: %v", r.h)
	}
	c.must("write", map[string]any{"channel": "p", "epoch": 1}, []byte("exit 3\r"))
	exit := c.next(10*time.Second, isRecord("p", "exit"))
	if !bytes.Contains(exit.body, []byte(`"code":3`)) {
		t.Fatalf("pty exit %s", exit.body)
	}
}

func TestAuthAndBadFrames(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	// Wrong token: refused and closed.
	c := newClient(t, rawDial(t, k))
	if r := c.call("hello", map[string]any{"token": "nope", "min": 1, "max": 1}, nil); r.str("error") != errBadToken {
		t.Fatalf("bad token: %v", r.h)
	}
	<-c.closed
	// Any op before hello: refused and closed.
	c = newClient(t, rawDial(t, k))
	if r := c.call("list", nil, nil); r.str("error") != errNotAuth {
		t.Fatalf("list before hello: %v", r.h)
	}
	<-c.closed
	// A newer protocol only.
	c = newClient(t, rawDial(t, k))
	if r := c.call("hello", map[string]any{"token": k.info["token"], "min": 2, "max": 5}, nil); r.str("error") != errUnsupportedVer {
		t.Fatalf("min 2: %v", r.h)
	}
	// A browser or anything speaking HTTP: the first four bytes are a huge length, so it is closed at once.
	nc := rawDial(t, k)
	nc.Write([]byte("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\n\r\n"))
	nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 4096)
	for {
		if _, err := nc.Read(buf); err != nil {
			break
		}
	}
	// Unknown op: answered, connection stays.
	c = dial(t, k)
	if r := c.call("frobnicate", map[string]any{"newField": 1}, nil); r.str("error") != errUnknownOp {
		t.Fatalf("unknown op: %v", r.h)
	}
	st := c.must("status", nil, nil)
	if st.str("keeper") != keeperVersion {
		t.Fatalf("status %v", st.h)
	}
	// Hello answer carries the features.
	c2 := newClient(t, rawDial(t, k))
	h := c2.must("hello", map[string]any{"token": k.info["token"], "min": 1, "max": 3, "client": "AIB test"}, nil)
	if h.num("protocol") != 1 || !strings.Contains(fmt.Sprint(h.h["features"]), "pty") {
		t.Fatalf("hello %v", h.h)
	}
}

func TestSecondKeeperRefused(t *testing.T) {
	data := t.TempDir()
	startKeeper(t, data)
	cmd := execKeeper(data)
	out, err := cmd.CombinedOutput()
	if err == nil || cmd.ProcessState.ExitCode() != 3 {
		t.Fatalf("second keeper: %v %s", err, out)
	}
}

func TestIdleExit(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data, "--exit-after", "1s")
	c := dial(t, k)
	spawnEcho(t, c, "i")
	c.must("closeStdin", map[string]any{"channel": "i", "epoch": 1}, nil)
	if k.waitExit(2500 * time.Millisecond) {
		t.Fatal("exited while a client was attached")
	}
	c.nc.Close()
	if !k.waitExit(5 * time.Second) {
		t.Fatal("did not exit with no channel and no client")
	}
	if _, err := os.Stat(filepath.Join(data, "keeper", "keeper.json")); !os.IsNotExist(err) {
		t.Fatal("keeper.json left behind")
	}
}

func TestOrphanCommandThenGiveUp(t *testing.T) {
	data := t.TempDir()
	marker := filepath.Join(t.TempDir(), "orphan.txt")
	oc, _ := json.Marshal(orphanCommand{Command: agentBin, Args: []string{"touch", marker}})
	k := startKeeper(t, data, "--orphan-command", string(oc), "--orphan-after", "300ms", "--orphan-retry", "400ms")
	c := dial(t, k)
	spawnEcho(t, c, "lonely", "tree")
	c.must("attach", map[string]any{"channel": "lonely"}, nil)
	child, grand := readTree(t, c, "lonely")
	c.nc.Close()
	// Three attempts, then the keeper stops its channels and exits (rule V1).
	if !k.waitExit(10 * time.Second) {
		t.Fatal("keeper kept running alone")
	}
	waitGone(t, child, 3*time.Second)
	waitGone(t, grand, 3*time.Second)
	b, _ := os.ReadFile(marker)
	if n := strings.Count(string(b), "started"); n != 3 {
		t.Fatalf("orphan command ran %d times: %q", n, b)
	}
	k2 := startKeeper(t, data)
	c2 := dial(t, k2)
	l := c2.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if l["reason"] != "orphaned" {
		t.Fatalf("reason %v", l)
	}
}

func TestOrphanCommandSetAtRuntimeAndClientReturns(t *testing.T) {
	data := t.TempDir()
	marker := filepath.Join(t.TempDir(), "orphan.txt")
	k := startKeeper(t, data, "--orphan-after", "300ms", "--orphan-retry", "5s")
	c := dial(t, k)
	c.must("setOrphanCommand", map[string]any{"orphan": orphanCommand{Command: agentBin, Args: []string{"touch", marker}}}, nil)
	spawnEcho(t, c, "s")
	c.nc.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if b, _ := os.ReadFile(marker); strings.Contains(string(b), "started") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("orphan command did not run")
		}
		time.Sleep(50 * time.Millisecond)
	}
	// "AIB" comes back: it reattaches and the channel is still alive.
	c2 := dial(t, k)
	l := c2.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if !l["live"].(bool) {
		t.Fatalf("channel died: %v", l)
	}
	if r := c2.call("shutdown", nil, nil); r.str("error") != errBusy {
		t.Fatalf("shutdown with live channels: %v", r.h)
	}
	c2.must("shutdown", map[string]any{"force": true}, nil)
	if !k.waitExit(10 * time.Second) {
		t.Fatal("forced shutdown did not exit")
	}
}

// Fifty clients at once, half of them dropping in the middle of a frame: the channel and the others are unaffected.
// hold (keeper 1.3.0): the client leaves on purpose (the person quit AIB with work running). No orphan command runs and the channels
// are never stopped as orphaned, however long nobody comes. A client that only looks (hello, list, attach) leaves the hold; one that
// claims a channel (the next AIB taking over) ends it, and rule V1 applies again once that one leaves without hold.
func TestHoldKeepsChannelsUntilAClientTakesOver(t *testing.T) {
	data := t.TempDir()
	marker := filepath.Join(t.TempDir(), "orphan.txt")
	oc, _ := json.Marshal(orphanCommand{Command: agentBin, Args: []string{"touch", marker}})
	k := startKeeper(t, data, "--orphan-command", string(oc), "--orphan-after", "200ms", "--orphan-retry", "200ms", "--orphan-tries", "2")
	c := dial(t, k)
	if h := c.must("status", nil, nil).h; h["held"] != false {
		t.Fatalf("held before any hold: %v", h)
	}
	spawnEcho(t, c, "held", "tree")
	c.must("attach", map[string]any{"channel": "held"}, nil)
	child, grand := readTree(t, c, "held")
	c.must("hold", nil, nil)
	c.nc.Close()
	stillHeld := func(what string) {
		t.Helper()
		// Far past orphan-after + tries * retry: still running, no orphan command, both processes alive.
		if k.waitExit(2 * time.Second) {
			t.Fatalf("%s: the keeper gave up on held channels", what)
		}
		if b, _ := os.ReadFile(marker); len(b) > 0 {
			t.Fatalf("%s: the orphan command ran while held: %q", what, b)
		}
		if !processAlive(child) || !processAlive(grand) {
			t.Fatalf("%s: a held channel's processes were stopped", what)
		}
		info, _ := os.ReadFile(filepath.Join(data, "keeper", "keeper.json"))
		if !strings.Contains(string(info), `"held": true`) {
			t.Fatalf("%s: keeper.json does not say held: %s", what, info)
		}
	}
	stillHeld("nobody came")
	// A client that only looks (a test reading the record, a status probe) comes and goes: still held.
	look := dial(t, k)
	look.must("list", nil, nil)
	look.must("attach", map[string]any{"channel": "held"}, nil)
	if h := look.must("status", nil, nil).h; h["held"] != true {
		t.Fatalf("status while held: %v", h)
	}
	look.nc.Close()
	stillHeld("a client only looked")
	// An AIB comes back and claims the channel: the hold ends; V1 applies again once it leaves without hold.
	c2 := dial(t, k)
	c2.must("claim", map[string]any{"channel": "held"}, nil)
	if h := c2.must("status", nil, nil).h; h["held"] != false {
		t.Fatalf("still held after a client took the channel over: %v", h)
	}
	l := c2.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if !l["live"].(bool) {
		t.Fatalf("channel died: %v", l)
	}
	c2.nc.Close()
	if !k.waitExit(10 * time.Second) {
		t.Fatal("rule V1 did not apply again after the hold ended")
	}
	waitGone(t, child, 3*time.Second)
	if b, _ := os.ReadFile(marker); strings.Count(string(b), "started") != 2 {
		t.Fatalf("orphan command after the hold ended: %q", b)
	}
}

// A held keeper with no live channel left still exits by rule V2 (nothing to keep).
func TestHoldStillExitsWhenNothingRuns(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data, "--exit-after", "500ms")
	c := dial(t, k)
	c.must("hold", nil, nil)
	c.nc.Close()
	if !k.waitExit(5 * time.Second) {
		t.Fatal("a held keeper with nothing running did not exit")
	}
}

func TestManyClientsAndDroppedFrames(t *testing.T) {
	k := startKeeper(t, t.TempDir())
	owner := dial(t, k)
	spawnEcho(t, owner, "m")
	var wg sync.WaitGroup
	errs := make(chan string, 100)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				nc := rawDial(t, k)
				f, _ := encodeFrame(map[string]any{"op": "hello", "token": k.info["token"], "min": 1, "max": 1}, nil)
				nc.Write(f)
				g, _ := encodeFrame(map[string]any{"op": "attach", "channel": "m"}, make([]byte, 1000))
				nc.Write(g[:len(g)/2]) // half a frame, then gone
				nc.Close()
				return
			}
			c := dial(t, k)
			c.must("attach", map[string]any{"channel": "m", "from": 1}, nil)
			if r := c.call("write", map[string]any{"channel": "m", "epoch": 1}, []byte("x\n")); r.str("error") != errFenced {
				errs <- fmt.Sprint(r.h)
			}
			c.next(10*time.Second, func(m msg) bool { return m.str("ev") == "live" })
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal("non-owner write:", e)
	}
	owner.must("attach", map[string]any{"channel": "m"}, nil)
	owner.must("write", map[string]any{"channel": "m", "epoch": 1}, []byte("still here\n"))
	owner.outputUntil("m", 5*time.Second, "out", `{"echo":"still here"}`)
}
