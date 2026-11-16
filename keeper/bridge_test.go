//go:build linux

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// bridgeProc is one `AIB-keeper bridge` with its stdio, as AIB's transport wsl.exe would see it.
type bridgeProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	out    *bufio.Reader
	exited chan struct{}
	pre    map[string]any
}

func startBridge(t *testing.T, data string, extra ...string) *bridgeProc {
	t.Helper()
	cmd := exec.Command(keeperBin, append([]string{"bridge", "--data", data}, extra...)...)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	b := &bridgeProc{cmd: cmd, stdin: stdin, out: bufio.NewReader(stdout), exited: make(chan struct{})}
	go func() { cmd.Wait(); close(b.exited) }()
	t.Cleanup(func() {
		stdin.Close()
		select {
		case <-b.exited:
		case <-time.After(3 * time.Second):
			cmd.Process.Kill()
			<-b.exited
		}
	})
	t.Cleanup(func() { stopKeeperIn(data) }) // runs first: the keeper the bridge started is detached, so it is ours to stop
	return b
}

// preamble reads the magic line and the preamble line.
func (b *bridgeProc) preamble(t *testing.T) map[string]any {
	t.Helper()
	got := make(chan error, 1)
	go func() {
		magic, err := b.out.ReadString('\n')
		if err == nil && magic != bridgeMagic+"\n" {
			err = io.ErrUnexpectedEOF
		}
		if err == nil {
			var line string
			if line, err = b.out.ReadString('\n'); err == nil {
				err = json.Unmarshal([]byte(line), &b.pre)
			}
		}
		got <- err
	}()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("preamble: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no preamble")
	}
	return b.pre
}

// call sends one frame over the bridge's stdin and reads frames from its stdout until the reply.
func (b *bridgeProc) call(t *testing.T, h map[string]any) map[string]any {
	t.Helper()
	f, _ := encodeFrame(h, nil)
	if _, err := b.stdin.Write(f); err != nil {
		t.Fatal(err)
	}
	for {
		hb, _, err := readFrame(b.out)
		if err != nil {
			t.Fatalf("%v: %v", h["op"], err)
		}
		var r map[string]any
		json.Unmarshal(hb, &r)
		if r["re"] == float64(h["id"].(int)) {
			return r
		}
	}
}

func (b *bridgeProc) waitExit(d time.Duration) bool {
	select {
	case <-b.exited:
		return true
	case <-time.After(d):
		return false
	}
}

// shortTemp: t.TempDir() holds the test's name, which can push keeper.sock past the unix socket limit (--unix-only refuses that).
func shortTemp(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "kb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func readInfo(t *testing.T, data string) keeperInfo {
	t.Helper()
	var info keeperInfo
	b, err := os.ReadFile(filepath.Join(data, "keeper", "keeper.json"))
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(b, &info)
	return info
}

func stopKeeperIn(data string) {
	b, err := os.ReadFile(filepath.Join(data, "keeper", "keeper.json"))
	if err != nil {
		return
	}
	var info keeperInfo
	if json.Unmarshal(b, &info) == nil && info.Pid > 0 {
		syscall.Kill(info.Pid, syscall.SIGKILL)
		waitGoneQuiet(info.Pid, 5*time.Second)
	}
}

func waitGoneQuiet(pid int, d time.Duration) {
	for deadline := time.Now().Add(d); time.Now().Before(deadline) && processAlive(pid); {
		time.Sleep(20 * time.Millisecond)
	}
}

// dialData is a protocol client of the keeper in data, found as AIB's bridge finds it.
func dialData(t *testing.T, data string) *client {
	t.Helper()
	info := readInfo(t, data)
	nc, err := net.Dial("unix", info.Address)
	if err != nil {
		t.Fatal(err)
	}
	c := newClient(t, nc)
	if r := c.call("hello", map[string]any{"token": info.Token, "min": 1, "max": 1, "client": "test"}, nil); !r.ok() {
		t.Fatalf("hello: %v", r.h)
	}
	return c
}

func TestBridgeStartsAKeeperAndCarriesFrames(t *testing.T) {
	data := shortTemp(t)
	b := startBridge(t, data)
	pre := b.preamble(t)
	info := readInfo(t, data)
	if pre["ev"] != "bridge" || pre["bridge"] != float64(1) || pre["token"] != info.Token || int(pre["pid"].(float64)) != info.Pid ||
		pre["keeper"] != keeperVersion || pre["home"] != os.Getenv("HOME") || int(pre["uid"].(float64)) != os.Getuid() || pre["arch"] == "" {
		t.Fatalf("preamble %v, keeper.json %+v", pre, info)
	}
	if info.Transport != "unix" || info.Pid == b.cmd.Process.Pid {
		t.Fatalf("keeper.json %+v", info)
	}
	r := b.call(t, map[string]any{"op": "hello", "id": 1, "token": pre["token"], "min": 1, "max": 1, "client": "AIB test"})
	if r["ok"] != true || r["keeper"] != keeperVersion {
		t.Fatalf("hello over the bridge: %v", r)
	}
	r = b.call(t, map[string]any{"op": "spawn", "id": 2, "channel": "a1", "command": agentBin, "args": []string{"echo"}})
	if r["ok"] != true {
		t.Fatalf("spawn: %v", r)
	}
	// The bridge dies with its stdin (AIB gone, or wsl.exe killed); the keeper, started detached, keeps the agent.
	b.stdin.Close()
	if !b.waitExit(5 * time.Second) {
		t.Fatal("the bridge did not exit at stdin EOF")
	}
	if !processAlive(info.Pid) {
		t.Fatal("the keeper died with the bridge")
	}
	c := dialData(t, data)
	if ch := c.must("list", nil, nil).h["channels"].([]any); len(ch) != 1 || ch[0].(map[string]any)["live"] != true {
		t.Fatalf("list after the bridge left: %v", ch)
	}
}

// keeper 1.6.0: a keeper the bridge starts keeps live channels 2 h without a client (--orphan-grace); extra serve flags override it.
func TestBridgeStartsTheKeeperWithTheOrphanGrace(t *testing.T) {
	for _, tc := range []struct {
		extra []string
		want  float64
	}{{nil, 7200}, {[]string{"--", "--orphan-grace", "5s"}, 5}} {
		data := shortTemp(t)
		startBridge(t, data, tc.extra...).preamble(t)
		c := dialData(t, data)
		if g := c.must("status", nil, nil).h["orphanGrace"]; g != tc.want {
			t.Fatalf("bridge %v: status orphanGrace %v, want %v", tc.extra, g, tc.want)
		}
		c.must("spawn", map[string]any{"channel": "agent", "command": agentBin, "args": []string{"sleep"}}, nil)
		c.nc.Close()
		// no client now (a bridge that has not said hello is none): the next bridge's preamble says when the agent would stop
		time.Sleep(300 * time.Millisecond)
		pre := startBridge(t, data).preamble(t)
		if at, _ := pre["orphanStopAt"].(float64); at < float64(time.Now().UnixMilli()) {
			t.Fatalf("bridge %v: preamble orphanStopAt %v", tc.extra, pre["orphanStopAt"])
		}
	}
}

func TestBridgesShareOneKeeper(t *testing.T) {
	data := shortTemp(t)
	pids := make([]float64, 4)
	bridges := make([]*bridgeProc, len(pids))
	for i := range bridges {
		bridges[i] = startBridge(t, data) // all at once: the start race (exit code 3 for the losers) must end in one keeper
	}
	for i, b := range bridges {
		pids[i] = b.preamble(t)["pid"].(float64)
	}
	for _, p := range pids[1:] {
		if p != pids[0] {
			t.Fatalf("keeper pids %v: more than one keeper", pids)
		}
	}
	later := startBridge(t, data)
	if later.preamble(t)["pid"].(float64) != pids[0] {
		t.Fatal("a later bridge started its own keeper")
	}
}

func TestBridgeRestartsAKeeperAfterACrash(t *testing.T) {
	data := shortTemp(t)
	first := startBridge(t, data).preamble(t)
	pid := int(first["pid"].(float64))
	syscall.Kill(pid, syscall.SIGKILL)
	waitGoneQuiet(pid, 5*time.Second)
	second := startBridge(t, data).preamble(t) // keeper.json and keeper.sock are stale: the dial fails, a new keeper starts
	if int(second["pid"].(float64)) == pid || second["token"] == first["token"] {
		t.Fatalf("stale keeper.json was used: %v", second)
	}
}

func TestUnixOnlyRefusesALongSocketPath(t *testing.T) {
	data := filepath.Join(t.TempDir(), strings.Repeat("d", 100))
	cmd := execKeeper(data, "--unix-only")
	err := cmd.Run()
	if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 1 {
		t.Fatalf("serve --unix-only with a %d-byte socket path: %v", len(data)+20, err)
	}
	if _, err := os.Stat(filepath.Join(data, "keeper", "keeper.json")); err == nil {
		t.Fatal("keeper.json written")
	}
}

func TestHoldLastsWhileAgentsOrAIBAreThere(t *testing.T) {
	data := shortTemp(t)
	hold := startBridge(t, data, "--hold", "--poll", "50ms", "--grace", "300ms")
	hold.preamble(t)
	c := dialData(t, data)
	c.must("spawn", map[string]any{"channel": "helper", "command": agentBin, "args": []string{"sleep"}, "label": `{"aib":"wsl-helper","v":"1"}`}, nil)
	c.must("spawn", map[string]any{"channel": "agent", "command": agentBin, "args": []string{"sleep"}}, nil)
	if st := c.must("status", nil, nil); !strings.Contains(strings.Join(anyStrings(st.h["clients"]), ","), holdClient) {
		t.Fatalf("the hold is not a client: %v", st.h)
	}
	c.nc.Close()
	if hold.waitExit(time.Second) {
		t.Fatal("the hold left while an agent was live")
	}
	c2 := dialData(t, data)
	epoch := c2.must("claim", map[string]any{"channel": "agent"}, nil).num("epoch")
	c2.must("kill", map[string]any{"channel": "agent", "epoch": epoch}, nil)
	if hold.waitExit(time.Second) {
		t.Fatal("the hold left while a client (AIB) was connected")
	}
	c2.nc.Close()
	if !hold.waitExit(5 * time.Second) {
		t.Fatal("the hold did not leave with only the helper live and no client")
	}
	if code := hold.cmd.ProcessState.ExitCode(); code != 0 {
		t.Fatalf("hold exit code %d", code)
	}
}

func TestHoldEndsWithStdin(t *testing.T) {
	data := shortTemp(t)
	hold := startBridge(t, data, "--hold", "--poll", "50ms", "--grace", "1h")
	hold.preamble(t)
	hold.stdin.Close()
	if !hold.waitExit(3 * time.Second) {
		t.Fatal("the hold did not exit at stdin EOF")
	}
}

func anyStrings(v any) []string {
	list, _ := v.([]any)
	out := []string{}
	for _, x := range list {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
