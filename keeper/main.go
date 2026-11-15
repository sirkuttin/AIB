package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type options struct {
	data            string
	port            int
	orphanAfter     time.Duration
	orphanRetry     time.Duration
	orphanTries     int
	orphanGrace     time.Duration // > 0: live channels without a client stop only after this long (the Linux keeper: 2h from the bridge)
	exitAfter       time.Duration
	flushEvery      time.Duration
	segBytes        int64
	maxChannelBytes int64
	noSpawn         bool // fuzzing: never start a process
	unixOnly        bool // WSL: never fall back to TCP (WSL forwards Linux loopback listeners to Windows)
}

type keeper struct {
	opts  options
	dir   string // <data>/keeper
	token string
	pid   int
	log   *log.Logger

	mu       sync.Mutex
	channels map[string]*channel
	conns    map[*conn]struct{}
	orphan   *orphanCommand
	held     bool // the last AIB left on purpose (hold op): no orphan restart, no orphan give-up, until a client claims or spawns
	// orphanSince: --orphan-grace only: when the current stretch with live work and no client began (zero: none). In keeper.json.
	orphanSince time.Time
	clientLeft  time.Time // when an authenticated client last left (a client that came and went between two monitor looks)
	stopping    bool
	changed     chan struct{}

	spawnMu  sync.Mutex
	indexMu  sync.Mutex
	listener net.Listener
	info     map[string]any
	lock     io.Closer
	logFile  io.Writer
	started  time.Time
	stopped  chan struct{}
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Printf("AIB keeper %s, protocol %d\n", keeperVersion, protocolVersion)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "mcp-forward" {
		os.Exit(mcpForwardMain(os.Args[2:])) // design 3.7: never part of a serving keeper (mcpforward.go)
	}
	if len(os.Args) > 1 && os.Args[1] == "mcp-relay" {
		os.Exit(mcpRelayMain(os.Args[2:])) // WSL: the MCP tunnel's socket, run by the WSL helper (mcprelay.go)
	}
	if len(os.Args) > 1 && os.Args[1] == "bridge" {
		os.Exit(bridgeMain(os.Args[2:])) // WSL: the stdio end of this distro's keeper (bridge.go)
	}
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	fs := flag.NewFlagSet("AIB-keeper", flag.ContinueOnError)
	var o options
	var orphan string
	fs.StringVar(&o.data, "data", "", "AIB's data folder; the keeper uses <data>/keeper (required)")
	fs.IntVar(&o.port, "port", 0, "loopback TCP port (Windows, or where a unix socket path is too long); 0 = any free port")
	fs.StringVar(&orphan, "orphan-command", "", `JSON {"command":..,"args":[..],"cwd":..,"env":{..}} run when no client is attached`)
	fs.DurationVar(&o.orphanAfter, "orphan-after", 5*time.Second, "run the orphan command after this long with live channels and no client")
	fs.DurationVar(&o.orphanRetry, "orphan-retry", 10*time.Second, "time between orphan command attempts")
	fs.IntVar(&o.orphanTries, "orphan-tries", 3, "attempts before the keeper stops its channels and exits")
	fs.DurationVar(&o.orphanGrace, "orphan-grace", envDuration(orphanGraceEnv, 0),
		"> 0: live channels with no client stop only after this long without one (0: after the orphan attempts; env "+orphanGraceEnv+")")
	fs.DurationVar(&o.exitAfter, "exit-after", 10*time.Second, "exit after this long with no live channel and no client")
	fs.DurationVar(&o.flushEvery, "flush", 200*time.Millisecond, "journal flush and fsync interval")
	fs.Int64Var(&o.segBytes, "segment-bytes", 16<<20, "journal segment size")
	fs.Int64Var(&o.maxChannelBytes, "max-channel-bytes", 2<<30, "per-channel journal cap; the oldest segment goes past it")
	fs.BoolVar(&o.unixOnly, "unix-only", false, "listen on the unix socket only: exit 1 where there is none or its path is too long")
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}
	if o.data == "" {
		fmt.Fprintln(os.Stderr, "AIB-keeper: --data is required")
		os.Exit(2)
	}
	allowCtrlC()
	k, err := newKeeper(o)
	if err != nil {
		fmt.Fprintln(os.Stderr, "AIB-keeper:", err)
		if errors.Is(err, errLocked) {
			os.Exit(3)
		}
		os.Exit(1)
	}
	if orphan != "" {
		var oc orphanCommand
		if err := json.Unmarshal([]byte(orphan), &oc); err != nil || oc.Command == "" {
			k.logf("bad --orphan-command: %v", err)
			fmt.Fprintln(os.Stderr, "AIB-keeper: bad --orphan-command")
			os.Exit(2)
		}
		k.orphan = &oc
	}
	if err := k.listen(); err != nil {
		k.logf("listen: %v", err)
		fmt.Fprintln(os.Stderr, "AIB-keeper:", err)
		os.Exit(1)
	}
	k.writeInfo()
	k.logf("keeper %s (protocol %d) pid %d listening on %v", keeperVersion, protocolVersion, k.pid, k.info["address"])
	go k.accept()
	go k.monitor()
	notifyStop(k)
	<-k.stopped
	os.Exit(0)
}

var errLocked = errors.New("another keeper holds this data folder")

// orphanGraceEnv overrides --orphan-grace's default (serve) and the grace the bridge gives a keeper it starts (tests, manual runs).
const orphanGraceEnv = "AIB_KEEPER_ORPHAN_GRACE"

// envDuration: the environment variable as a Go duration ("90s", "2h"), else def (unset, unparsable or negative).
func envDuration(name string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(os.Getenv(name)); err == nil && d >= 0 {
		return d
	}
	return def
}

func newKeeper(o options) (*keeper, error) {
	if o.segBytes < 1024 {
		o.segBytes = 1024
	}
	if o.maxChannelBytes < 2*o.segBytes {
		o.maxChannelBytes = 2 * o.segBytes
	}
	if o.flushEvery <= 0 {
		o.flushEvery = 200 * time.Millisecond
	}
	if o.orphanTries <= 0 {
		o.orphanTries = 3
	}
	data, err := filepath.Abs(o.data)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(data, "keeper")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := restrictDir(dir); err != nil {
		return nil, fmt.Errorf("restrict %s to this user: %w", dir, err)
	}
	lock, err := lockFile(filepath.Join(dir, "keeper.lock"))
	if err != nil {
		return nil, err
	}
	var tok [32]byte
	if _, err := rand.Read(tok[:]); err != nil {
		return nil, err
	}
	logFile := openLog(filepath.Join(dir, "keeper.log"))
	k := &keeper{opts: o, dir: dir, token: hex.EncodeToString(tok[:]), pid: os.Getpid(), log: log.New(logFile, "", log.LstdFlags|log.Lmicroseconds),
		channels: map[string]*channel{}, conns: map[*conn]struct{}{}, changed: make(chan struct{}, 1), lock: lock,
		started: time.Now(), stopped: make(chan struct{}), logFile: logFile}
	if err := k.loadIndex(); err != nil {
		lock.Close()
		return nil, err
	}
	k.saveIndex()
	return k, nil
}

func openLog(path string) io.Writer {
	if fi, err := os.Stat(path); err == nil && fi.Size() > 1<<20 {
		os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return io.Discard
	}
	return f
}

func (k *keeper) logf(format string, args ...any) { k.log.Printf(format, args...) }

func (k *keeper) listen() error {
	sock := filepath.Join(k.dir, "keeper.sock")
	if k.opts.unixOnly && (!useUnixSocket || len(sock) >= maxUnixSocketLen) {
		return fmt.Errorf("--unix-only: no unix socket here, or %s is %d bytes (the limit is %d)", sock, len(sock), maxUnixSocketLen-1)
	}
	if useUnixSocket && len(sock) < maxUnixSocketLen {
		os.Remove(sock) // stale: we hold the lock, so no keeper is using it
		l, err := net.Listen("unix", sock)
		if err != nil {
			return err
		}
		os.Chmod(sock, 0o600)
		k.listener = l
		k.info = map[string]any{"transport": "unix", "address": sock}
		return nil
	}
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(k.opts.port)))
	if err != nil {
		return err
	}
	k.listener = l
	k.info = map[string]any{"transport": "tcp", "address": l.Addr().String()}
	return nil
}

// writeInfo writes <data>/keeper/keeper.json (user-only). Written after the socket listens: its presence means "ready".
func (k *keeper) writeInfo() {
	k.mu.Lock()
	info := map[string]any{"pid": k.pid, "protocol": protocolVersion, "keeper": keeperVersion, "token": k.token,
		"started": k.started.UnixMilli(), "orphanCommand": k.orphan, "held": k.held}
	if g := k.opts.orphanGrace; g > 0 { // only with --orphan-grace: a keeper without it writes exactly what it always did
		info["orphanGrace"] = int64(g / time.Second)
		if !k.orphanSince.IsZero() {
			info["orphanSince"] = k.orphanSince.UnixMilli()
			info["orphanStopAt"] = k.orphanSince.Add(g).UnixMilli()
		}
	}
	for key, v := range k.info {
		info[key] = v
	}
	k.mu.Unlock()
	b, _ := json.MarshalIndent(info, "", " ")
	if err := writeFileAtomic(filepath.Join(k.dir, "keeper.json"), b); err != nil {
		k.logf("keeper.json: %v", err)
	}
}

// writeFileAtomic writes a user-only file through a temp file and a rename.
func writeFileAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	f.Close()
	if err == nil {
		err = restrictFile(tmp)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

func (k *keeper) accept() {
	for {
		nc, err := k.listener.Accept()
		if err != nil {
			if k.isStopping() {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if tcp, ok := nc.RemoteAddr().(*net.TCPAddr); ok && !tcp.IP.IsLoopback() {
			nc.Close()
			continue
		}
		go k.serve(nc)
	}
}

// ---- state -----------------------------------------------------------------------------------------------------------------

func (k *keeper) channel(id string) *channel {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.channels[id]
}

func (k *keeper) channelList() []*channel {
	k.mu.Lock()
	list := make([]*channel, 0, len(k.channels))
	for _, ch := range k.channels {
		list = append(list, ch)
	}
	k.mu.Unlock()
	sort.Slice(list, func(a, b int) bool {
		if list[a].created != list[b].created {
			return list[a].created < list[b].created
		}
		return list[a].id < list[b].id
	})
	return list
}

func (k *keeper) addChannel(ch *channel) {
	k.mu.Lock()
	k.channels[ch.id] = ch
	k.mu.Unlock()
	k.channelChanged()
}

func (k *keeper) removeChannel(ch *channel) {
	k.mu.Lock()
	delete(k.channels, ch.id)
	k.mu.Unlock()
	ch.j.remove()
	k.saveIndex()
}

func (k *keeper) channelChanged() {
	k.saveIndex()
	select {
	case k.changed <- struct{}{}:
	default:
	}
}

func (k *keeper) liveCount() int {
	n := 0
	for _, ch := range k.channelList() {
		if ch.isLive() {
			n++
		}
	}
	return n
}

// internalKind: "wsl-hold" or "wsl-helper" for AIB's own WSL channels (spawn label {"aib":"wsl-hold",...} / {"aib":"wsl-helper",...},
// PROTOCOL.md section 10), "" for anything else (an agent, a terminal, no label).
func internalKind(label string) string {
	if !strings.HasPrefix(label, "{") {
		return ""
	}
	var l struct {
		Aib string `json:"aib"`
	}
	if json.Unmarshal([]byte(label), &l) != nil {
		return ""
	}
	if l.Aib == "wsl-hold" || l.Aib == "wsl-helper" {
		return l.Aib
	}
	return ""
}

// liveWork: the live channels that are work (agents, terminals), and the live WSL keep-alives. AIB's own channels are not work: a
// keep-alive or a helper alone never starts AIB again (V1) nor is stopped as orphaned. A keep-alive still keeps the keeper from its
// idle exit (V2), since it holds a distro's agents; it ends by itself once its distro has no work left (bridge --hold). A helper
// alone keeps nothing: it holds no state.
func (k *keeper) liveWork() (work, holds int) {
	for _, ch := range k.channelList() {
		if !ch.isLive() {
			continue
		}
		switch internalKind(ch.label) {
		case "":
			work++
		case "wsl-hold":
			holds++
		}
	}
	return work, holds
}

func (k *keeper) addConn(c *conn) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.stopping {
		return false
	}
	k.conns[c] = struct{}{}
	return true
}

func (k *keeper) dropConn(c *conn) {
	k.mu.Lock()
	if _, ok := k.conns[c]; ok {
		k.clientLeft = time.Now()
	}
	delete(k.conns, c)
	k.mu.Unlock()
	for _, ch := range k.channelList() {
		ch.mu.Lock()
		if ch.owner == c {
			ch.owner = nil // the epoch stays; a new client claims
		}
		ch.mu.Unlock()
	}
}

func (k *keeper) clientCount() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.conns)
}

func (k *keeper) isStopping() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.stopping
}

func (k *keeper) setOrphan(o *orphanCommand) {
	k.mu.Lock()
	k.orphan = o
	k.mu.Unlock()
	k.writeInfo()
}

// hold: the client that sends it is leaving on purpose (the person quit AIB with work running) and the channels are to wait for
// the next AIB, however long that takes: no orphan command and no "orphaned" stop meanwhile. It ends when a client claims or spawns
// a channel (an AIB taking over, or starting work of its own); a client that only looks (hello, list, attach, status) leaves it.
func (k *keeper) hold() {
	k.mu.Lock()
	k.held = true
	k.mu.Unlock()
	k.logf("hold: the client is leaving on purpose; no orphan restart until an AIB takes a channel")
	k.writeInfo()
}

func (k *keeper) isHeld() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.held
}

// unhold: a client claimed or spawned a channel (an AIB is back).
func (k *keeper) unhold() {
	k.mu.Lock()
	was := k.held
	k.held = false
	k.mu.Unlock()
	if was {
		k.logf("hold: a client is back; the hold ends")
		k.writeInfo()
	}
}

func (k *keeper) status() map[string]any {
	k.mu.Lock()
	clients := []string{}
	for c := range k.conns {
		clients = append(clients, c.client)
	}
	orphan := k.orphan
	held := k.held
	addr := k.info["address"]
	k.mu.Unlock()
	sort.Strings(clients)
	st := map[string]any{"keeper": keeperVersion, "protocol": protocolVersion, "pid": k.pid, "started": k.started.UnixMilli(),
		"dir": k.dir, "address": addr, "live": k.liveCount(), "channels": len(k.channelList()), "clients": clients,
		"orphanCommand": orphan, "held": held}
	if g := k.opts.orphanGrace; g > 0 {
		st["orphanGrace"] = int64(g / time.Second)
	}
	return st
}

// setOrphanSince records (or with the zero time clears) the start of a stretch with live work and no client, in keeper.json.
func (k *keeper) setOrphanSince(t time.Time) {
	k.mu.Lock()
	k.orphanSince = t
	k.mu.Unlock()
	k.writeInfo()
}

func (k *keeper) hasOrphanCommand() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.orphan != nil
}

// ---- timers: journal flush, orphan restart (rule V1), idle exit (rule V2) ---------------------------------------------------

func (k *keeper) monitor() {
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	lastFlush := time.Now()
	var noClientSince, quietSince, lastAttempt time.Time
	attempts := 0
	announced := false // --orphan-grace: the start of the current stretch without a client was logged
	for {
		select {
		case <-tick.C:
		case <-k.changed:
		case <-k.stopped:
			return
		}
		now := time.Now()
		if now.Sub(lastFlush) >= k.opts.flushEvery {
			lastFlush = now
			for _, ch := range k.channelList() {
				ch.j.flush(true)
			}
		}
		if k.isStopping() {
			continue
		}
		live, holds := k.liveWork()
		clients := k.clientCount()
		if clients > 0 {
			if announced { // --orphan-grace: the story in keeper.log
				announced = false
				k.logf("a client is back after %v without one; every channel kept running", now.Sub(noClientSince).Round(time.Second))
				k.setOrphanSince(time.Time{})
			}
			noClientSince, attempts = time.Time{}, 0
		} else if noClientSince.IsZero() {
			noClientSince = now
		}
		if live == 0 && holds == 0 && clients == 0 {
			if quietSince.IsZero() {
				quietSince = now
			}
			if now.Sub(quietSince) >= k.opts.exitAfter {
				k.logf("no live work and no client for %v: exiting", k.opts.exitAfter)
				go k.stop("idle")
				continue
			}
		} else {
			quietSince = time.Time{}
		}
		if k.isHeld() {
			attempts, lastAttempt = 0, time.Time{} // held: the channels wait for the next AIB, however long
			continue
		}
		if grace := k.opts.orphanGrace; grace > 0 {
			// The Linux keeper (the bridge starts it with --orphan-grace): nothing can start AIB again from in here, so the channels
			// wait for a client for the whole grace, counted from the moment the last one left (a hold counts as one); a client
			// coming back ends the stretch, and the next one starts the grace from zero. An orphan command, if one was set, still
			// runs at most --orphan-tries times meanwhile.
			k.mu.Lock()
			left := k.clientLeft
			k.mu.Unlock()
			if clients == 0 && left.After(noClientSince) {
				// a client came and went between two looks (a status probe, a reconnect that failed): the grace starts again
				if announced {
					announced = false
					k.logf("a client came and went after %v without one; every channel kept running", left.Sub(noClientSince).Round(time.Second))
					k.setOrphanSince(time.Time{})
				}
				noClientSince, attempts = left, 0
			}
			if live == 0 || clients > 0 {
				continue
			}
			away := now.Sub(noClientSince)
			if !announced {
				announced = true
				k.logf("no client: keeping %d live channels; they stop after %v without a client", live, grace)
				k.setOrphanSince(noClientSince)
			}
			if away >= grace {
				k.logf("no client for %v: stopping %d channels and exiting", grace, live)
				go k.stop("orphaned")
				continue
			}
			if attempts < k.opts.orphanTries && k.hasOrphanCommand() && away >= k.opts.orphanAfter && now.Sub(lastAttempt) >= k.opts.orphanRetry {
				attempts++
				lastAttempt = now
				k.runOrphan(attempts)
			}
			continue
		}
		if live > 0 && clients == 0 && now.Sub(noClientSince) >= k.opts.orphanAfter && now.Sub(lastAttempt) >= k.opts.orphanRetry {
			if attempts >= k.opts.orphanTries {
				k.logf("no client after %d orphan command attempts: stopping %d channels and exiting", attempts, live)
				go k.stop("orphaned")
				continue
			}
			attempts++
			lastAttempt = now
			k.runOrphan(attempts)
		}
	}
}

func (k *keeper) runOrphan(attempt int) {
	k.mu.Lock()
	o := k.orphan
	k.mu.Unlock()
	if o == nil {
		k.logf("orphan attempt %d: no orphan command set", attempt)
		return
	}
	cmd, err := startDetached(func() *exec.Cmd {
		cmd := exec.Command(o.Command, o.Args...)
		cmd.Dir = o.Cwd
		if o.Env != nil {
			cmd.Env = envList(o.Env)
		}
		return cmd
	})
	if err != nil {
		k.logf("orphan attempt %d: %v", attempt, err)
		return
	}
	k.logf("orphan attempt %d: started %s (pid %d)", attempt, o.Command, cmd.Process.Pid)
	go cmd.Wait() // reap; it is not ours to keep
}

// stop kills every live channel (reason goes into each exit record), flushes the journals and exits.
func (k *keeper) stop(reason string) {
	k.mu.Lock()
	if k.stopping {
		k.mu.Unlock()
		return
	}
	k.stopping = true
	conns := make([]*conn, 0, len(k.conns))
	for c := range k.conns {
		conns = append(conns, c)
	}
	k.mu.Unlock()
	k.logf("stopping (%s)", reason)
	if k.listener != nil {
		k.listener.Close()
	}
	for _, ch := range k.channelList() {
		ch.kill(reason)
	}
	deadline := time.Now().Add(5 * time.Second)
	for k.liveCount() > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	for _, c := range conns {
		c.close()
	}
	k.saveIndex()
	for _, ch := range k.channelList() {
		ch.j.close()
	}
	os.Remove(filepath.Join(k.dir, "keeper.json"))
	if k.info != nil && k.info["transport"] == "unix" {
		os.Remove(k.info["address"].(string))
	}
	k.lock.Close()
	k.logf("stopped")
	if f, ok := k.logFile.(io.Closer); ok {
		f.Close()
	}
	close(k.stopped)
}
