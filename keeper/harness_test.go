package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

var keeperBin, agentBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "aib-keeper-test-")
	if err != nil {
		panic(err)
	}
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	keeperBin = filepath.Join(dir, "AIB-keeper"+exe)
	agentBin = filepath.Join(dir, "fakeagent"+exe)
	ldflags := "-s -w"
	if runtime.GOOS == "windows" {
		ldflags += " -H windowsgui" // the shipped keeper is a GUI-subsystem program: it can never get a console window
	}
	for _, b := range [][]string{
		{"build", "-trimpath", "-ldflags", ldflags, "-o", keeperBin, "."},
		{"build", "-o", agentBin, "./internal/fakeagent"},
	} {
		cmd := exec.Command("go", b...)
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "go %v: %v\n%s", b, err, out)
			os.Exit(1)
		}
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// ---- a keeper process --------------------------------------------------------------------------------------------------

type keeperProc struct {
	t      *testing.T
	cmd    *exec.Cmd
	data   string
	info   map[string]any
	exited chan struct{}
}

// freePort is a free loopback port in 8950-8999 (the range these tests may use).
func freePort(t *testing.T) int {
	for p := 8950; p <= 8999; p++ {
		l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err == nil {
			l.Close()
			return p
		}
	}
	t.Fatal("no free port in 8950-8999")
	return 0
}

func startKeeper(t *testing.T, data string, extra ...string) *keeperProc {
	t.Helper()
	args := append([]string{"serve", "--data", data, "--port", strconv.Itoa(freePort(t))}, extra...)
	cmd := exec.Command(keeperBin, args...)
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	k := &keeperProc{t: t, cmd: cmd, data: data, exited: make(chan struct{})}
	go func() { cmd.Wait(); close(k.exited) }()
	t.Cleanup(func() {
		k.kill()
		if t.Failed() {
			b, _ := os.ReadFile(filepath.Join(data, "keeper", "keeper.log"))
			t.Logf("keeper.log:\n%s", b)
		}
	})
	infoPath := filepath.Join(data, "keeper", "keeper.json")
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(infoPath); err == nil {
			var info map[string]any
			if json.Unmarshal(b, &info) == nil && int(info["pid"].(float64)) == cmd.Process.Pid {
				k.info = info
				return k
			}
		}
		select {
		case <-k.exited:
			t.Fatalf("keeper exited at start (code %d)", cmd.ProcessState.ExitCode())
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("keeper.json did not appear")
	return nil
}

// kill hard-kills the keeper (TerminateProcess / SIGKILL), as a crash would.
func (k *keeperProc) kill() {
	select {
	case <-k.exited:
		return
	default:
	}
	k.cmd.Process.Kill()
	<-k.exited
}

func (k *keeperProc) waitExit(d time.Duration) bool {
	select {
	case <-k.exited:
		return true
	case <-time.After(d):
		return false
	}
}

// ---- a protocol client -------------------------------------------------------------------------------------------------

type msg struct {
	h    map[string]any
	body []byte
}

func (m msg) str(key string) string { s, _ := m.h[key].(string); return s }
func (m msg) num(key string) uint64 { f, _ := m.h[key].(float64); return uint64(f) }
func (m msg) ok() bool              { b, _ := m.h["ok"].(bool); return b }

type client struct {
	t      *testing.T
	nc     net.Conn
	wmu    sync.Mutex
	mu     sync.Mutex
	nextID int
	waits  map[int]chan msg
	events chan msg
	closed chan struct{}
}

func rawDial(t *testing.T, k *keeperProc) net.Conn {
	t.Helper()
	nc, err := net.Dial(k.info["transport"].(string), k.info["address"].(string))
	if err != nil {
		t.Fatal(err)
	}
	return nc
}

func dial(t *testing.T, k *keeperProc) *client {
	t.Helper()
	c := newClient(t, rawDial(t, k))
	r := c.call("hello", map[string]any{"token": k.info["token"], "min": 1, "max": 1, "client": "test"}, nil)
	if !r.ok() {
		t.Fatalf("hello: %v", r.h)
	}
	return c
}

func newClient(t *testing.T, nc net.Conn) *client {
	c := &client{t: t, nc: nc, waits: map[int]chan msg{}, events: make(chan msg, 100000), closed: make(chan struct{})}
	t.Cleanup(func() { nc.Close() })
	go func() {
		defer close(c.closed)
		for {
			hb, body, err := readFrame(nc)
			if err != nil {
				return
			}
			var h map[string]any
			if json.Unmarshal(hb, &h) != nil {
				return
			}
			m := msg{h, body}
			if re, ok := h["re"].(float64); ok {
				c.mu.Lock()
				ch := c.waits[int(re)]
				delete(c.waits, int(re))
				c.mu.Unlock()
				if ch != nil {
					ch <- m
				}
				continue
			}
			if _, isEvent := h["ev"]; !isEvent {
				c.events <- msg{h: map[string]any{"ev": "_unrouted", "h": h}}
				continue
			}
			c.events <- m
		}
	}()
	return c
}

func (c *client) sendRaw(h map[string]any, body []byte) error {
	f, err := encodeFrame(h, body)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.nc.Write(f)
	return err
}

func (c *client) call(op string, fields map[string]any, body []byte) msg {
	c.t.Helper()
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	w := make(chan msg, 1)
	c.waits[id] = w
	c.mu.Unlock()
	h := map[string]any{"op": op, "id": id}
	for k, v := range fields {
		h[k] = v
	}
	if err := c.sendRaw(h, body); err != nil {
		c.t.Fatalf("%s: send: %v", op, err)
	}
	select {
	case m := <-w:
		return m
	case <-c.closed:
		return msg{h: map[string]any{"ok": false, "error": "_closed"}}
	case <-time.After(15 * time.Second):
		c.t.Fatalf("%s: no answer", op)
	}
	return msg{}
}

func (c *client) must(op string, fields map[string]any, body []byte) msg {
	c.t.Helper()
	m := c.call(op, fields, body)
	if !m.ok() {
		c.t.Fatalf("%s %v: %v", op, fields, m.h)
	}
	return m
}

// next returns the next event matching pred, failing after d.
func (c *client) next(d time.Duration, pred func(msg) bool) msg {
	c.t.Helper()
	timeout := time.After(d)
	for {
		select {
		case m := <-c.events:
			if pred(m) {
				return m
			}
		case <-timeout:
			c.t.Fatalf("event did not arrive within %v", d)
			return msg{}
		}
	}
}

func isRecord(channel, kind string) func(msg) bool {
	return func(m msg) bool {
		return m.str("ev") == "record" && m.str("channel") == channel && m.str("kind") == kind
	}
}

// collect gathers a channel's records until pred says stop, returning the joined body of the kinds asked for.
func (c *client) outputUntil(channel string, d time.Duration, kinds string, contains string) string {
	c.t.Helper()
	var sb strings.Builder
	timeout := time.After(d)
	for {
		select {
		case m := <-c.events:
			if m.str("ev") == "record" && m.str("channel") == channel && strings.Contains(kinds, m.str("kind")) {
				sb.Write(m.body)
				if strings.Contains(sb.String(), contains) {
					return sb.String()
				}
			}
		case <-timeout:
			c.t.Fatalf("%q not seen within %v; got %q", contains, d, sb.String())
		}
	}
}

func waitGone(t *testing.T, pid int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid %d still alive after %v", pid, d)
}

func execKeeper(data string, extra ...string) *exec.Cmd {
	cmd := exec.Command(keeperBin, append([]string{"serve", "--data", data}, extra...)...)
	hideWindow(cmd)
	return cmd
}
