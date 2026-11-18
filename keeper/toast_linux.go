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
	fdoName  = "org.freedesktop.Notifications"
	fdoPath  = dbus.ObjectPath("/org/freedesktop/Notifications")
	fdoIface = "org.freedesktop.Notifications"
	// codeTTL: how long a lingering helper waits for a click after AIB quit (CODE_TTL_MS in server/desktop/toast.ts).
	codeTTL = 12 * time.Hour
)

type dbusFdo struct {
	conn *dbus.Conn
	obj  dbus.BusObject
	sigs chan fdoSignal
}

func connectFdo() (fdoBus, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, err
	}
	if err := conn.AddMatchSignal(dbus.WithMatchObjectPath(fdoPath), dbus.WithMatchInterface(fdoIface)); err != nil {
		conn.Close()
		return nil, err
	}
	raw := make(chan *dbus.Signal, 64)
	conn.Signal(raw)
	b := &dbusFdo{conn: conn, obj: conn.Object(fdoName, fdoPath), sigs: make(chan fdoSignal, 64)}
	go func() {
		defer close(b.sigs)
		for s := range raw { // closed by godbus when the connection ends
			if sig, ok := fdoSignalOf(s); ok {
				b.sigs <- sig
			}
		}
	}()
	return b, nil
}

// fdoSignalOf reads one bus signal of the notification interface.
func fdoSignalOf(s *dbus.Signal) (fdoSignal, bool) {
	if s == nil || s.Path != fdoPath || len(s.Body) < 2 {
		return fdoSignal{}, false
	}
	id, ok := s.Body[0].(uint32)
	if !ok {
		return fdoSignal{}, false
	}
	str, _ := s.Body[1].(string)
	switch s.Name {
	case fdoIface + ".ActionInvoked":
		return fdoSignal{Kind: "action", ID: id, Key: str}, true
	case fdoIface + ".NotificationReplied":
		return fdoSignal{Kind: "reply", ID: id, Text: str}, true
	case fdoIface + ".ActivationToken":
		return fdoSignal{Kind: "token", ID: id, Token: str}, true
	case fdoIface + ".NotificationClosed":
		reason, _ := s.Body[1].(uint32)
		return fdoSignal{Kind: "closed", ID: id, Reason: reason}, true
	}
	return fdoSignal{}, false
}

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
	return fdoDeps{
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
// records this one.
func claimHelper(data string) {
	file := helperPidFile(data)
	if b, err := os.ReadFile(file); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 1 && pid != os.Getpid() && isToastHelper(pid) {
			syscall.Kill(pid, syscall.SIGTERM)
		}
	}
	os.WriteFile(file, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
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
