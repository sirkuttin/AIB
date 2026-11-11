package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// process is one spawned child and its whole tree (Windows Job Object, POSIX process group).
type process interface {
	Pid() int
	Write(p []byte) error // to stdin, or the pty's input
	CloseStdin() error
	Resize(cols, rows int) error
	Signal(name string) error
	Kill() error // the whole tree
	// Wait returns once the main process has exited and all its output was delivered. Whatever it left running is killed.
	Wait() (code int)
}

type spawnSpec struct {
	Command string
	Args    []string
	Cwd     string
	Env     []string // nil: the keeper's own environment
	CmdLine string   // Windows only: the exact command line, passed to CreateProcess unchanged
	Pty     *ptySize
}

var errUnsupportedOp = errors.New("unsupported on this platform")

const stdinQueueMax = 32 << 20

// channel is one spawned child (or an ended one, kept for its journal).
type channel struct {
	k       *keeper
	id      string
	kind    string // "pipe" or "pty"
	command string
	args    []string
	cwd     string
	label   string
	created int64
	j       *journal

	mu       sync.Mutex
	pid      int
	proc     process
	epoch    uint64
	owner    *conn
	once     map[string]struct{}
	live     bool
	ended    int64
	exitCode *int
	reason   string // why it ended: exit, killed, shutdown, orphaned, keeper_lost

	stdin       chan []byte // nil entry = close stdin
	stdinBytes  atomic.Int64
	stdinClosed bool
}

// channelInfo is what list returns, and what channels.json stores.
type channelInfo struct {
	Channel  string   `json:"channel"`
	Kind     string   `json:"kind"`
	Pid      int      `json:"pid"`
	Command  string   `json:"command"`
	Args     []string `json:"args,omitempty"`
	Cwd      string   `json:"cwd,omitempty"`
	Label    string   `json:"label,omitempty"`
	Created  int64    `json:"created"`
	Live     bool     `json:"live"`
	Ended    int64    `json:"ended,omitempty"`
	ExitCode *int     `json:"exitCode"`
	Reason   string   `json:"reason,omitempty"`
	Epoch    uint64   `json:"epoch"`
	First    uint64   `json:"first"`
	Last     uint64   `json:"last"`
	Owner    bool     `json:"owner"`
}

func (ch *channel) info(c *conn) channelInfo {
	first, last := ch.j.bounds()
	ch.mu.Lock()
	defer ch.mu.Unlock()
	return channelInfo{
		Channel: ch.id, Kind: ch.kind, Pid: ch.pid, Command: ch.command, Args: ch.args, Cwd: ch.cwd, Label: ch.label, Created: ch.created,
		Live: ch.live, Ended: ch.ended, ExitCode: ch.exitCode, Reason: ch.reason, Epoch: ch.epoch, First: first, Last: last,
		Owner: c != nil && ch.owner == c,
	}
}

func validChannelID(id string) bool {
	if id == "" || len(id) > 64 || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func envList(env map[string]string) []string {
	if env == nil {
		return nil
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func validSpec(s *spawnSpec) error {
	bad := func(v string) bool { return strings.ContainsRune(v, 0) }
	if s.Command == "" || bad(s.Command) || bad(s.Cwd) || bad(s.CmdLine) {
		return errors.New("command missing or contains NUL")
	}
	for _, a := range s.Args {
		if bad(a) {
			return errors.New("argument contains NUL")
		}
	}
	for _, e := range s.Env {
		k, _, _ := strings.Cut(e, "=")
		if bad(e) || k == "" {
			return errors.New("bad environment entry")
		}
	}
	if s.Pty != nil && (s.Pty.Cols <= 0 || s.Pty.Rows <= 0 || s.Pty.Cols > 0x7fff || s.Pty.Rows > 0x7fff) {
		return errors.New("bad pty size")
	}
	return nil
}

// start spawns the process and its reader, stdin writer and waiter. The channel is registered by the caller.
func (ch *channel) start(spec spawnSpec) error {
	onData := func(k kind, b []byte) {
		ch.j.append(k, b)
	}
	var p process
	var err error
	if spec.Pty != nil {
		p, err = startPty(spec, onData)
	} else {
		p, err = startPipe(spec, onData)
	}
	if err != nil {
		return err
	}
	ch.mu.Lock()
	ch.proc = p
	ch.pid = p.Pid()
	ch.live = true
	ch.stdin = make(chan []byte, 4096)
	ch.mu.Unlock()
	go ch.writeLoop(p)
	go ch.waitLoop(p)
	return nil
}

func (ch *channel) writeLoop(p process) {
	for b := range ch.stdin {
		if b == nil {
			p.CloseStdin()
			continue
		}
		ch.stdinBytes.Add(-int64(len(b)))
		p.Write(b) // a failed write means the child is gone; the waiter records that
	}
}

func (ch *channel) waitLoop(p process) {
	code := p.Wait()
	ch.mu.Lock()
	reason := ch.reason
	if reason == "" {
		reason = "exit"
	}
	ch.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"code": code, "reason": reason})
	ch.j.append(kindExit, body)
	ch.j.flush(true)
	ch.mu.Lock()
	ch.live = false
	ch.ended = time.Now().UnixMilli()
	ch.exitCode = &code
	ch.reason = reason
	ch.proc = nil
	close(ch.stdin)
	ch.mu.Unlock()
	ch.k.channelChanged()
}

// checkOwner: mutating ops need the current epoch AND the connection that claimed it. Call with ch.mu held.
func (ch *channel) checkOwnerLocked(c *conn, epoch uint64) bool {
	return ch.epoch != 0 && epoch == ch.epoch && ch.owner == c
}

// claim makes c the only writer. It returns the new epoch and the connection that lost the channel, if any.
func (ch *channel) claim(c *conn) (uint64, *conn) {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	ch.epoch++
	prev := ch.owner
	ch.owner = c
	if prev == c {
		prev = nil
	}
	return ch.epoch, prev
}

// write queues bytes for the child's stdin and records them. It never blocks on the child.
func (ch *channel) write(c *conn, epoch uint64, once string, data []byte) (uint64, string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if !ch.checkOwnerLocked(c, epoch) {
		return 0, errFenced
	}
	if !ch.live || ch.stdinClosed {
		return 0, errEnded
	}
	if once != "" {
		if _, used := ch.once[once]; used {
			return 0, errDuplicate
		}
	}
	if len(data) == 0 {
		return 0, errBadRequest
	}
	if ch.stdinBytes.Load()+int64(len(data)) > stdinQueueMax {
		return 0, errBusy
	}
	select {
	case ch.stdin <- data:
	default:
		return 0, errBusy
	}
	ch.stdinBytes.Add(int64(len(data)))
	if once != "" {
		ch.once[once] = struct{}{}
	}
	seq, err := ch.j.append(kindIn, data) // under ch.mu, so `in` records are in stdin order
	if err != nil {
		return 0, errFailed
	}
	return seq, ""
}

func (ch *channel) note(c *conn, epoch uint64, once string, data []byte) (uint64, string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if !ch.checkOwnerLocked(c, epoch) {
		return 0, errFenced
	}
	if once != "" {
		if _, used := ch.once[once]; used {
			return 0, errDuplicate
		}
	}
	seq, err := ch.j.append(kindNote, data)
	if err != nil {
		return 0, errFailed
	}
	if once != "" {
		ch.once[once] = struct{}{}
	}
	return seq, ""
}

func (ch *channel) closeStdin(c *conn, epoch uint64) string {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if !ch.checkOwnerLocked(c, epoch) {
		return errFenced
	}
	if !ch.live {
		return errEnded
	}
	if ch.kind == "pty" {
		return errUnsupported
	}
	if !ch.stdinClosed {
		select {
		case ch.stdin <- nil: // after the queued writes
			ch.stdinClosed = true
		default:
			return errBusy
		}
	}
	return ""
}

func (ch *channel) resize(c *conn, epoch uint64, once string, cols, rows int) (uint64, string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if !ch.checkOwnerLocked(c, epoch) {
		return 0, errFenced
	}
	if !ch.live {
		return 0, errEnded
	}
	if once != "" {
		if _, used := ch.once[once]; used {
			return 0, errDuplicate
		}
	}
	if ch.kind != "pty" {
		return 0, errUnsupported
	}
	if cols <= 0 || rows <= 0 || cols > 0x7fff || rows > 0x7fff {
		return 0, errBadRequest
	}
	if err := ch.proc.Resize(cols, rows); err != nil {
		return 0, errFailed
	}
	if once != "" {
		ch.once[once] = struct{}{}
	}
	body, _ := json.Marshal(ptySize{Cols: cols, Rows: rows})
	seq, _ := ch.j.append(kindResize, body)
	return seq, ""
}

func (ch *channel) signal(c *conn, epoch uint64, name string) string {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if !ch.checkOwnerLocked(c, epoch) {
		return errFenced
	}
	if !ch.live {
		return errEnded
	}
	if err := ch.proc.Signal(name); err != nil {
		if errors.Is(err, errUnsupportedOp) {
			return errUnsupported
		}
		return errBadRequest
	}
	return ""
}

// kill ends the whole tree. reason goes into the exit record. Safe to call on an ended channel.
func (ch *channel) kill(reason string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if !ch.live || ch.proc == nil {
		return
	}
	if ch.reason == "" {
		ch.reason = reason
	}
	ch.proc.Kill()
}

func (ch *channel) isLive() bool {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	return ch.live
}

// ---- the channel index (channels.json) ---------------------------------------------------------------------------------

func (k *keeper) saveIndex() {
	k.indexMu.Lock()
	defer k.indexMu.Unlock()
	var list []channelInfo
	for _, ch := range k.channelList() {
		info := ch.info(nil)
		info.Epoch, info.First, info.Last, info.Owner = 0, 0, 0, false
		list = append(list, info)
	}
	if list == nil {
		list = []channelInfo{}
	}
	b, _ := json.MarshalIndent(list, "", " ")
	writeFileAtomic(filepath.Join(k.dir, "channels.json"), b)
}

// loadIndex reopens the journals of an earlier keeper. Channels that were live when it stopped get an exit record with
// reason "keeper_lost": their processes died with it (Job Object), and nothing may ever be resent to them.
func (k *keeper) loadIndex() error {
	b, err := os.ReadFile(filepath.Join(k.dir, "channels.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var list []channelInfo
	if err := json.Unmarshal(b, &list); err != nil {
		k.logf("channels.json unreadable, starting empty: %v", err)
		return nil
	}
	for _, info := range list {
		if !validChannelID(info.Channel) {
			continue
		}
		j, err := openJournal(filepath.Join(k.dir, "channels", info.Channel), k.opts.segBytes, k.opts.maxChannelBytes)
		if err != nil {
			k.logf("journal %s: %v", info.Channel, err)
			continue
		}
		ch := &channel{k: k, id: info.Channel, kind: info.Kind, command: info.Command, args: info.Args, cwd: info.Cwd, label: info.Label,
			created: info.Created, j: j, pid: info.Pid, once: map[string]struct{}{}, ended: info.Ended,
			exitCode: info.ExitCode, reason: info.Reason}
		if info.Ended == 0 {
			body, _ := json.Marshal(map[string]any{"code": nil, "reason": "keeper_lost"})
			j.append(kindExit, body)
			j.flush(true)
			ch.ended = time.Now().UnixMilli()
			ch.reason = "keeper_lost"
		}
		k.channels[ch.id] = ch
	}
	return nil
}
