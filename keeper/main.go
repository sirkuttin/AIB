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
	"sync"
	"time"
)

type options struct {
	data            string
	port            int
	orphanAfter     time.Duration
	orphanRetry     time.Duration
	orphanTries     int
	exitAfter       time.Duration
	flushEvery      time.Duration
	segBytes        int64
	maxChannelBytes int64
	noSpawn         bool // fuzzing: never start a process
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
	stopping bool
	changed  chan struct{}

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
	fs.DurationVar(&o.exitAfter, "exit-after", 10*time.Second, "exit after this long with no live channel and no client")
	fs.DurationVar(&o.flushEvery, "flush", 200*time.Millisecond, "journal flush and fsync interval")
	fs.Int64Var(&o.segBytes, "segment-bytes", 16<<20, "journal segment size")
	fs.Int64Var(&o.maxChannelBytes, "max-channel-bytes", 2<<30, "per-channel journal cap; the oldest segment goes past it")
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
	if useUnixSocket && len(sock) < 100 {
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
	return map[string]any{"keeper": keeperVersion, "protocol": protocolVersion, "pid": k.pid, "started": k.started.UnixMilli(),
		"dir": k.dir, "address": addr, "live": k.liveCount(), "channels": len(k.channelList()), "clients": clients,
		"orphanCommand": orphan, "held": held}
}

// ---- timers: journal flush, orphan restart (rule V1), idle exit (rule V2) ---------------------------------------------------

func (k *keeper) monitor() {
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	lastFlush := time.Now()
	var noClientSince, quietSince, lastAttempt time.Time
	attempts := 0
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
		live, clients := k.liveCount(), k.clientCount()
		if clients > 0 {
			noClientSince, attempts = time.Time{}, 0
		} else if noClientSince.IsZero() {
			noClientSince = now
		}
		if live == 0 && clients == 0 {
			if quietSince.IsZero() {
				quietSince = now
			}
			if now.Sub(quietSince) >= k.opts.exitAfter {
				k.logf("no live channel and no client for %v: exiting", k.opts.exitAfter)
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
