package main

// AIB-keeper bridge --data D [--hold] [-- serve flags]: the stdio end of a keeper in a WSL distro (PROTOCOL.md section 10). A keeper it
// starts gets --orphan-grace 2h (bridgeOrphanGrace) before the extra serve flags.
//
// AIB runs `wsl.exe --distribution D --cd ~ --exec <ver>/AIB-keeper bridge --data <linuxData>` and talks keeper frames over that
// process's stdin and stdout. The bridge finds the distro's keeper (keeper.json, then a dial of its unix socket), starts one if there
// is none (`serve --unix-only`, detached with setsid, so it outlives the wsl.exe that started it), writes one BRIDGE_MAGIC line and
// one preamble line (the keeper's token travels only here, never in argv or env), then copies bytes both ways until either side ends.
// Anything wsl.exe prints first is before the magic line, so AIB can skip it.
//
// With --hold the bridge is the keep-alive: it says hello itself (client "AIB WSL hold"), so the keeper never runs its orphan rules
// while it is there, and it blocks on stdin. It exits when stdin ends, or when nothing but AIB's own channels (labels wsl-helper,
// wsl-hold) is live and no other client is connected, so a distro with no work left can idle out.
//
// It knows nothing of what it carries: no frames are read in plain bridge mode.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const (
	bridgeMagic      = "AIB-BRIDGE-1"
	bridgeStartWait  = 10 * time.Second
	holdClient       = "AIB WSL hold"
	maxUnixSocketLen = 100
	// bridgeOrphanGrace: how long the keeper a bridge starts keeps live channels with no client at all. It outlasts any AIB restart,
	// crash and tray relaunch, update, test-build swap or an older AIB that dropped the keep-alive, yet a distro whose AIB never comes
	// back does not keep agents (and the WSL VM's memory) up overnight.
	bridgeOrphanGrace = 2 * time.Hour
)

type bridgeOptions struct {
	data      string
	hold      bool
	poll      time.Duration
	grace     time.Duration
	serveArgs []string
}

type keeperInfo struct {
	Pid       int    `json:"pid"`
	Protocol  int    `json:"protocol"`
	Keeper    string `json:"keeper"`
	Transport string `json:"transport"`
	Address   string `json:"address"`
	Token     string `json:"token"`
	// OrphanStopAt: keeper 1.6.0, while live channels have had no client: when they stop (Unix ms; 0 otherwise). The bridge reads
	// keeper.json before its own client says hello, so the preamble can tell AIB how close the channels came.
	OrphanStopAt int64 `json:"orphanStopAt"`
}

func bridgeMain(args []string) int {
	var serveArgs []string
	for i, a := range args {
		if a == "--" {
			args, serveArgs = args[:i], args[i+1:]
			break
		}
	}
	fs := flag.NewFlagSet("AIB-keeper bridge", flag.ContinueOnError)
	var o bridgeOptions
	fs.StringVar(&o.data, "data", "", "the keeper's data folder (required)")
	fs.BoolVar(&o.hold, "hold", false, "keep-alive: hello as a client, block on stdin, exit when only AIB's own channels are live")
	fs.DurationVar(&o.poll, "poll", 2*time.Second, "--hold: how often to look at the keeper's channels")
	fs.DurationVar(&o.grace, "grace", 10*time.Second, "--hold: how long nothing but AIB's own channels must be live before exiting")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if o.data == "" {
		fmt.Fprintln(os.Stderr, "AIB-keeper bridge: --data is required")
		return 2
	}
	o.serveArgs = serveArgs
	nc, info, err := bridgeConnect(o)
	if err != nil {
		fmt.Fprintln(os.Stderr, "AIB-keeper bridge:", err)
		return 1
	}
	defer nc.Close()
	if err := writePreamble(os.Stdout, info); err != nil {
		return 1
	}
	if o.hold {
		return runHold(nc, info, o, os.Stdin)
	}
	splice(nc, os.Stdin, os.Stdout)
	return 0
}

// bridgeConnect dials the data folder's keeper, starting one (detached, unix socket only) when there is none.
func bridgeConnect(o bridgeOptions) (net.Conn, keeperInfo, error) {
	data, err := filepath.Abs(o.data)
	if err != nil {
		return nil, keeperInfo{}, err
	}
	infoPath := filepath.Join(data, "keeper", "keeper.json")
	if nc, info, err := dialInfo(infoPath); err == nil {
		return nc, info, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, keeperInfo{}, err
	}
	// The Linux keeper cannot start AIB again, so its channels wait bridgeOrphanGrace for a client (PROTOCOL.md section 6); the
	// environment (tests) or an --orphan-grace among the extra serve flags (the last one wins) says otherwise.
	grace := envDuration(orphanGraceEnv, bridgeOrphanGrace)
	args := append([]string{"serve", "--data", data, "--unix-only", "--orphan-grace", grace.String()}, o.serveArgs...)
	cmd, err := startDetached(func() *exec.Cmd { return exec.Command(exe, args...) })
	if err != nil {
		return nil, keeperInfo{}, fmt.Errorf("start the keeper: %w", err)
	}
	exited := make(chan int, 1)
	go func() {
		cmd.Wait()
		exited <- cmd.ProcessState.ExitCode()
	}()
	deadline := time.Now().Add(bridgeStartWait)
	lost := false // exit code 3: another keeper won the start race; its keeper.json is the one to wait for
	for time.Now().Before(deadline) {
		if nc, info, err := dialInfo(infoPath); err == nil {
			return nc, info, nil
		}
		select {
		case code := <-exited:
			if code != 3 {
				return nil, keeperInfo{}, fmt.Errorf("the keeper exited at start (code %d); see %s", code, filepath.Join(data, "keeper", "keeper.log"))
			}
			lost = true
		case <-time.After(20 * time.Millisecond):
		}
	}
	if lost {
		return nil, keeperInfo{}, errors.New("another keeper holds the data folder but does not answer")
	}
	return nil, keeperInfo{}, errors.New("the keeper did not start in time")
}

func dialInfo(path string) (net.Conn, keeperInfo, error) {
	var info keeperInfo
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, info, err
	}
	if err := json.Unmarshal(b, &info); err != nil || info.Token == "" || info.Address == "" {
		return nil, info, errors.New("keeper.json is incomplete")
	}
	if info.Transport != "unix" {
		return nil, info, errors.New("the keeper does not listen on a unix socket")
	}
	nc, err := net.DialTimeout("unix", info.Address, 2*time.Second)
	return nc, info, err
}

func writePreamble(w io.Writer, info keeperInfo) error {
	home := os.Getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	m := map[string]any{"ev": "bridge", "bridge": 1, "keeper": info.Keeper, "pid": info.Pid, "token": info.Token,
		"home": home, "uid": os.Getuid(), "arch": runtime.GOARCH}
	if info.OrphanStopAt > 0 {
		m["orphanStopAt"] = info.OrphanStopAt
	}
	pre, _ := json.Marshal(m)
	_, err := w.Write([]byte(bridgeMagic + "\n" + string(pre) + "\n"))
	return err
}

// splice copies both ways until either side ends.
func splice(nc net.Conn, in io.Reader, out io.Writer) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(nc, in); done <- struct{}{} }()
	go func() { io.Copy(out, nc); done <- struct{}{} }()
	<-done
}

// runHold says hello, then waits for stdin to end or for the keeper to have nothing but AIB's own channels live and no other client.
func runHold(nc net.Conn, info keeperInfo, o bridgeOptions, in io.Reader) int {
	id := 0
	call := func(h map[string]any) (map[string]any, error) {
		id++
		h["id"] = id
		f, err := encodeFrame(h, nil)
		if err != nil {
			return nil, err
		}
		nc.SetDeadline(time.Now().Add(15 * time.Second))
		if _, err := nc.Write(f); err != nil {
			return nil, err
		}
		for {
			hb, _, err := readFrame(nc)
			if err != nil {
				return nil, err
			}
			var r map[string]any
			if json.Unmarshal(hb, &r) != nil {
				return nil, errors.New("bad reply")
			}
			if re, ok := r["re"].(float64); ok && int(re) == id {
				if ok, _ := r["ok"].(bool); !ok {
					return r, fmt.Errorf("%s: %v", h["op"], r["error"])
				}
				return r, nil
			}
		}
	}
	if _, err := call(map[string]any{"op": "hello", "token": info.Token, "min": protocolVersion, "max": protocolVersion, "client": holdClient}); err != nil {
		fmt.Fprintln(os.Stderr, "AIB-keeper bridge --hold:", err)
		return 1
	}
	stdinDone := make(chan struct{})
	go func() { io.Copy(io.Discard, in); close(stdinDone) }()
	var idleSince time.Time
	tick := time.NewTicker(o.poll)
	defer tick.Stop()
	for {
		select {
		case <-stdinDone:
			return 0
		case <-tick.C:
		}
		list, err := call(map[string]any{"op": "list"})
		if err != nil {
			return 0 // the keeper is gone: nothing left to hold
		}
		status, err := call(map[string]any{"op": "status"})
		if err != nil {
			return 0
		}
		if holdNeeded(list, status) {
			idleSince = time.Time{}
			continue
		}
		if idleSince.IsZero() {
			idleSince = time.Now()
		}
		if time.Since(idleSince) >= o.grace {
			return 0
		}
	}
}

// holdNeeded: a live channel that is not AIB's own (an agent, a terminal), or a client other than a hold (AIB is there).
func holdNeeded(list, status map[string]any) bool {
	channels, _ := list["channels"].([]any)
	for _, c := range channels {
		ch, _ := c.(map[string]any)
		if live, _ := ch["live"].(bool); live && !ownChannel(ch) {
			return true
		}
	}
	clients, _ := status["clients"].([]any)
	for _, c := range clients {
		if name, _ := c.(string); name != holdClient {
			return true
		}
	}
	return false
}

func ownChannel(ch map[string]any) bool {
	label, _ := ch["label"].(string)
	return internalKind(label) != ""
}
