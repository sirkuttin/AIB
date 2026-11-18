//go:build linux

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"
)

// fdoToasts: on Linux `AIB-keeper toast` talks to org.freedesktop.Notifications (toast_fdo.go).
const fdoToasts = true

// The Windows toast layer does not exist here (toast.go's -Embedding path is never reached: toastMain goes to fdoMain).
func realToastDeps() (toastDeps, error) {
	return toastDeps{}, errors.New("toasts are Windows only")
}

const (
	fdoPath = dbus.ObjectPath(fdoPathStr)
	// codeTTL: how long a lingering helper waits for a click after AIB quit (CODE_TTL_MS in server/desktop/toast.ts).
	codeTTL = 12 * time.Hour
)

type dbusFdo struct {
	conn *dbus.Conn
	obj  dbus.BusObject
	sigs chan fdoSignal
	gate fdoGate
	// the queue between godbus' reader (fdoSignalQueue.DeliverSignal must never block it) and sigs
	mu    sync.Mutex
	queue []fdoSignal
	wake  chan struct{}
	done  bool
}

// fdoSignalQueue is the connection's signal handler: it runs on godbus' reader, in message order, so an owner change is in the
// gate before the reply of any call made after it is seen (a Notify answered by a restarted server gets the new generation).
type fdoSignalQueue struct{ b *dbusFdo }

func (q fdoSignalQueue) DeliverSignal(iface, member string, s *dbus.Signal) {
	if s == nil {
		return
	}
	sig, ok := q.b.gate.read(s.Sender, string(s.Path), s.Name, s.Body)
	if !ok {
		return
	}
	b := q.b
	b.mu.Lock()
	if !b.done {
		b.queue = append(b.queue, sig)
	}
	b.mu.Unlock()
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

// Terminate: godbus closed the connection (Close, or the bus went away).
func (q fdoSignalQueue) Terminate() {
	q.b.mu.Lock()
	q.b.done = true
	q.b.mu.Unlock()
	select {
	case q.b.wake <- struct{}{}:
	default:
	}
}

func (b *dbusFdo) pump() {
	defer close(b.sigs)
	for range b.wake {
		for {
			b.mu.Lock()
			if len(b.queue) == 0 {
				done := b.done
				b.mu.Unlock()
				if done {
					return
				}
				break
			}
			sig := b.queue[0]
			b.queue = b.queue[1:]
			b.mu.Unlock()
			b.sigs <- sig
		}
	}
}

// connectFdo: the notification signals are matched with sender=org.freedesktop.Notifications (the bus routes only the owner's),
// and every signal's sender is checked against the owner's unique name too (fdoGate), since a signal sent straight to this
// connection (with a destination) skips match rules. The owner is resolved after the NameOwnerChanged match is in place, so no
// change is missed in between.
func connectFdo() (fdoBus, error) {
	b := &dbusFdo{sigs: make(chan fdoSignal, 64), wake: make(chan struct{}, 1)}
	conn, err := dbus.ConnectSessionBus(dbus.WithSignalHandler(fdoSignalQueue{b}))
	if err != nil {
		return nil, err
	}
	b.conn, b.obj = conn, conn.Object(fdoName, fdoPath)
	go b.pump()
	for _, rule := range [][]dbus.MatchOption{
		{dbus.WithMatchSender(dbusName), dbus.WithMatchObjectPath(dbusPath), dbus.WithMatchInterface(dbusName),
			dbus.WithMatchMember("NameOwnerChanged"), dbus.WithMatchArg(0, fdoName)},
		{dbus.WithMatchSender(fdoName), dbus.WithMatchObjectPath(fdoPath), dbus.WithMatchInterface(fdoIface)},
	} {
		if err := conn.AddMatchSignal(rule...); err != nil {
			conn.Close()
			return nil, err
		}
	}
	gen := b.gate.Gen()
	var owner string
	if err := conn.BusObject().Call(dbusName+".GetNameOwner", 0, fdoName).Store(&owner); err == nil {
		// none yet (not started): it comes with NameOwnerChanged, e.g. when GetCapabilities starts it
		b.gate.initOwner(gen, owner)
	}
	return b, nil
}

func (b *dbusFdo) Gen() uint64 { return b.gate.Gen() }

func (b *dbusFdo) call(method string, args ...interface{}) *dbus.Call {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return b.obj.CallWithContext(ctx, fdoIface+"."+method, 0, args...)
}

func (b *dbusFdo) Caps() ([]string, error) {
	var caps []string
	err := b.call("GetCapabilities").Store(&caps)
	return caps, err
}

func (b *dbusFdo) Notify(n fdoNote) (uint32, error) {
	hints := map[string]dbus.Variant{
		"urgency": dbus.MakeVariant(n.Urgency),
	}
	if n.DesktopEntry != "" {
		hints["desktop-entry"] = dbus.MakeVariant(n.DesktopEntry)
	}
	if n.SuppressSound {
		hints["suppress-sound"] = dbus.MakeVariant(true)
	}
	if n.Icon != "" {
		hints["image-path"] = dbus.MakeVariant(n.Icon)
	}
	if n.ReplyHint != "" {
		hints["x-kde-reply-placeholder-text"] = dbus.MakeVariant(n.ReplyHint)
	}
	actions := n.Actions
	if actions == nil {
		actions = []string{}
	}
	var id uint32
	err := b.call("Notify", n.AppName, n.ReplacesID, n.Icon, n.Title, n.Body, actions, hints, int32(-1)).Store(&id)
	return id, err
}

func (b *dbusFdo) CloseNote(id uint32) error { return b.call("CloseNotification", id).Err }

func (b *dbusFdo) Signals() <-chan fdoSignal { return b.sigs }

func (b *dbusFdo) Close() { b.conn.Close() }

func realFdoDeps() (fdoDeps, error) {
	// Its own session: AIB quitting (a terminal's Ctrl+C, a closed process group) leaves a helper that still waits for a click.
	syscall.Setsid()
	signal.Ignore(syscall.SIGPIPE, syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM)
	stop := make(chan struct{})
	go func() { <-term; close(stop) }()
	return fdoDeps{
		stop:    stop,
		connect: connectFdo,
		launch:  launchAIB,
		claim:   claimHelper,
		release: releaseHelper,
		now:     time.Now,
		linger:  codeTTL,
		settle:  1500 * time.Millisecond,
	}, nil
}

// launchAIB starts AIB detached for a click made while it was quit. The activation token lets the new window take the focus on
// Wayland (GTK 3 reads DESKTOP_STARTUP_ID; XDG_ACTIVATION_TOKEN for toolkits that read that).
func launchAIB(program, token string) error {
	cmd := exec.Command(program)
	env := make([]string, 0, len(os.Environ())+2)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "XDG_ACTIVATION_TOKEN=") || strings.HasPrefix(kv, "DESKTOP_STARTUP_ID=") ||
			strings.HasPrefix(kv, "DENO_SERVE_ADDRESS=") {
			continue
		}
		env = append(env, kv)
	}
	if token != "" {
		env = append(env, "XDG_ACTIVATION_TOKEN="+token, "DESKTOP_STARTUP_ID="+token)
	}
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func helperPidFile(data string) string { return filepath.Join(data, "toast-helper.pid") }

// claimHelper stops a helper that still lingers from an earlier AIB (only if that pid really is an `AIB-keeper toast`) and
// records this one. This one's pid is written before the old one is signalled: the old one removes the file on SIGTERM only while
// it still names the old one, so it never removes this one's.
func claimHelper(data string) {
	file := helperPidFile(data)
	old := 0
	if b, err := os.ReadFile(file); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 1 && pid != os.Getpid() && isToastHelper(pid) {
			old = pid
		}
	}
	os.WriteFile(file, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
	if old != 0 {
		syscall.Kill(old, syscall.SIGTERM)
	}
}

func isToastHelper(pid int) bool {
	cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		return false
	}
	args := bytes.Split(bytes.TrimRight(cmdline, "\x00"), []byte{0})
	return len(args) >= 2 && string(args[1]) == "toast" && strings.Contains(filepath.Base(string(args[0])), "keeper")
}

func releaseHelper(data string) {
	file := helperPidFile(data)
	if b, err := os.ReadFile(file); err == nil && strings.TrimSpace(string(b)) == strconv.Itoa(os.Getpid()) {
		os.Remove(file)
	}
}
