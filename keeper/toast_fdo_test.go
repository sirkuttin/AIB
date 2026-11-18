package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The Linux notification helper's logic with a fake bus (no D-Bus, runs on every OS). The real bus against a fake notification
// server: toast_linux_test.go and work/deno/linux_notify_wsl_e2e_test.ts.

type fakeFdo struct {
	mu      sync.Mutex
	caps    []string
	capsErr error
	notes   []fdoNote
	closed  []uint32
	next    uint32
	sigs    chan fdoSignal
	shut    bool
	gen     uint64
}

func newFakeFdo(caps ...string) *fakeFdo {
	return &fakeFdo{caps: caps, next: 100, sigs: make(chan fdoSignal, 16)}
}

func (f *fakeFdo) Caps() ([]string, error) { return f.caps, f.capsErr }
func (f *fakeFdo) Gen() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gen
}
func (f *fakeFdo) Notify(n fdoNote) (uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notes = append(f.notes, n)
	if n.ReplacesID != 0 {
		return n.ReplacesID, nil
	}
	f.next++
	return f.next, nil
}
func (f *fakeFdo) CloseNote(id uint32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = append(f.closed, id)
	return nil
}
func (f *fakeFdo) Signals() <-chan fdoSignal { return f.sigs }
func (f *fakeFdo) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shut = true
}
func (f *fakeFdo) last() fdoNote {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.notes[len(f.notes)-1]
}
func (f *fakeFdo) closedIDs() []uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]uint32(nil), f.closed...)
}

type fdoRun struct {
	in       *io.PipeWriter
	out      *bufio.Scanner
	ret      chan int
	bus      *fakeFdo
	mu       sync.Mutex
	launched []string
	claimed  []string
	released []string
	stop     chan struct{}
}

func startFdo(t *testing.T, bus *fakeFdo, linger time.Duration) *fdoRun {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	r := &fdoRun{in: inW, out: bufio.NewScanner(outR), ret: make(chan int, 1), bus: bus, stop: make(chan struct{})}
	d := fdoDeps{
		connect: func() (fdoBus, error) {
			if bus == nil {
				return nil, errors.New("no bus")
			}
			return bus, nil
		},
		launch: func(p, tok string) error {
			r.mu.Lock()
			r.launched = append(r.launched, p+"|"+tok)
			r.mu.Unlock()
			return nil
		},
		claim:   func(d string) { r.mu.Lock(); r.claimed = append(r.claimed, d); r.mu.Unlock() },
		release: func(d string) { r.mu.Lock(); r.released = append(r.released, d); r.mu.Unlock() },
		now:     func() time.Time { return time.UnixMilli(1234) },
		linger:  linger,
		settle:  30 * time.Millisecond,
		stop:    r.stop,
	}
	go func() {
		r.ret <- serveFdo(inR, outW, d)
		outW.Close()
	}()
	t.Cleanup(func() { inW.Close() })
	return r
}

func (r *fdoRun) send(t *testing.T, m map[string]any) {
	t.Helper()
	b, _ := json.Marshal(m)
	if _, err := r.in.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
}

func (r *fdoRun) read(t *testing.T) fdoMsg {
	t.Helper()
	done := make(chan fdoMsg, 1)
	go func() {
		var m fdoMsg
		if r.out.Scan() {
			json.Unmarshal(r.out.Bytes(), &m)
		}
		done <- m
	}()
	select {
	case m := <-done:
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("no answer from the helper")
		return fdoMsg{}
	}
}

func (r *fdoRun) exit(t *testing.T) int {
	t.Helper()
	select {
	case c := <-r.ret:
		return c
	case <-time.After(3 * time.Second):
		t.Fatal("the helper did not exit")
		return -1
	}
}

func register(t *testing.T, r *fdoRun, data string) fdoMsg {
	r.send(t, map[string]any{"op": "register", "name": "AIB", "icon": "/x/icon.png", "data": data, "launch": "/usr/bin/aib", "desktop": "dev.aib.app"})
	return r.read(t)
}

func actionPairs(n fdoNote) [][2]string {
	var out [][2]string
	for i := 0; i+1 < len(n.Actions); i += 2 {
		out = append(out, [2]string{n.Actions[i], n.Actions[i+1]})
	}
	return out
}

const allowArgs = "act=allow&chat=claude%3As1&n=CODE"
const denyArgs = "act=deny&chat=claude%3As1&n=CODE"
const openArgs = "act=open&chat=claude%3As1"

func TestFdoButtonsClicksAndRemove(t *testing.T) {
	bus := newFakeFdo("actions", "body", "persistence")
	r := startFdo(t, bus, time.Second)
	if m := register(t, r, t.TempDir()); m.Op != "ready" {
		t.Fatalf("register: %+v", m)
	}
	r.send(t, map[string]any{"op": "show", "id": "1", "tag": "t1", "title": "Payments", "body": "npm install", "default": openArgs,
		"buttons": []map[string]string{{"label": "Allow", "args": allowArgs}, {"label": "Deny", "args": denyArgs}}})
	if m := r.read(t); m.Op != "shown" || m.ID != "1" {
		t.Fatalf("show: %+v", m)
	}
	n := bus.last()
	if want := [][2]string{{"default", "Open"}, {"b0", "Allow"}, {"b1", "Deny"}}; !reflect.DeepEqual(actionPairs(n), want) {
		t.Fatalf("actions %v", actionPairs(n))
	}
	if n.AppName != "AIB" || n.Title != "Payments" || n.Body != "npm install" || n.DesktopEntry != "dev.aib.app" || n.Icon != "/x/icon.png" ||
		n.Urgency != 1 || n.SuppressSound || n.ReplacesID != 0 {
		t.Fatalf("note %+v", n)
	}
	// the activation token comes first, then the click
	bus.sigs <- fdoSignal{Kind: "token", ID: 101, Token: "tok-1"}
	bus.sigs <- fdoSignal{Kind: "action", ID: 101, Key: "b0"}
	if m := r.read(t); m.Op != "activated" || m.Args != allowArgs || m.Token != "tok-1" {
		t.Fatalf("allow click: %+v", m)
	}
	bus.sigs <- fdoSignal{Kind: "action", ID: 101, Key: "default"}
	if m := r.read(t); m.Op != "activated" || m.Args != openArgs {
		t.Fatalf("body click: %+v", m)
	}
	// another app's notification, or an unknown key: nothing
	bus.sigs <- fdoSignal{Kind: "action", ID: 999, Key: "default"}
	bus.sigs <- fdoSignal{Kind: "action", ID: 101, Key: "b7"}
	// the same chat again replaces its notification
	r.send(t, map[string]any{"op": "show", "id": "2", "tag": "t1", "title": "Payments", "body": "again", "default": openArgs, "silent": true})
	if m := r.read(t); m.Op != "shown" {
		t.Fatalf("show 2: %+v", m)
	}
	if n := bus.last(); n.ReplacesID != 101 || n.Urgency != 0 || !n.SuppressSound {
		t.Fatalf("replace/silent: %+v", n)
	}
	// answered elsewhere: CloseNotification
	r.send(t, map[string]any{"op": "remove", "tag": "t1"})
	if m := r.read(t); m.Op != "removed" || m.Tag != "t1" {
		t.Fatalf("remove: %+v", m)
	}
	if got := bus.closedIDs(); !reflect.DeepEqual(got, []uint32{101}) {
		t.Fatalf("closed %v", got)
	}
	// removing an unknown tag closes nothing
	r.send(t, map[string]any{"op": "remove", "tag": "nope"})
	r.read(t)
	if got := bus.closedIDs(); len(got) != 1 {
		t.Fatalf("closed %v", got)
	}
	r.in.Close()
	if c := r.exit(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
}

func TestFdoReplyInlineOrOpen(t *testing.T) {
	replyArgs := "act=reply&chat=claude%3As1&n=CODE"
	replyOpen := "act=open&chat=claude%3As1&to=chat"
	show := map[string]any{"op": "show", "id": "1", "tag": "t", "title": "Docs", "body": "Done?", "default": openArgs,
		"buttons": []map[string]string{{"label": "Send", "args": replyArgs, "input": "reply"}}, "reply": "Reply", "replyOpen": replyOpen}

	// KDE: inline reply; its text comes back as inputs.reply
	kde := newFakeFdo("actions", "body", "inline-reply")
	r := startFdo(t, kde, time.Second)
	register(t, r, t.TempDir())
	r.send(t, show)
	r.read(t)
	n := kde.last()
	if want := [][2]string{{"default", "Open"}, {"inline-reply", "Reply"}}; !reflect.DeepEqual(actionPairs(n), want) || n.ReplyHint != "Reply" {
		t.Fatalf("kde note %v %q", actionPairs(n), n.ReplyHint)
	}
	kde.sigs <- fdoSignal{Kind: "reply", ID: 101, Text: "ship it"}
	if m := r.read(t); m.Op != "activated" || m.Args != replyArgs || m.Inputs["reply"] != "ship it" {
		t.Fatalf("reply: %+v", m)
	}

	// GNOME: no inline reply; Reply is an Open button that opens the chat
	gnome := newFakeFdo("actions", "body", "persistence")
	g := startFdo(t, gnome, time.Second)
	register(t, g, t.TempDir())
	g.send(t, show)
	g.read(t)
	n = gnome.last()
	if want := [][2]string{{"default", "Open"}, {"b0", "Open"}}; !reflect.DeepEqual(actionPairs(n), want) || n.ReplyHint != "" {
		t.Fatalf("gnome note %v", actionPairs(n))
	}
	gnome.sigs <- fdoSignal{Kind: "action", ID: 101, Key: "b0"}
	if m := g.read(t); m.Op != "activated" || m.Args != replyOpen || len(m.Inputs) != 0 {
		t.Fatalf("gnome open: %+v", m)
	}
	// a stray NotificationReplied on GNOME's notification does nothing
	gnome.sigs <- fdoSignal{Kind: "reply", ID: 101, Text: "x"}
	gnome.sigs <- fdoSignal{Kind: "action", ID: 101, Key: "default"}
	if m := g.read(t); m.Args != openArgs {
		t.Fatalf("expected the body click next, got %+v", m)
	}
}

// Body and title: escaped where the server reads markup (titles carry agent-made chat names), raw where it does not.
func TestFdoBodyMarkupEscaped(t *testing.T) {
	text := `run <a href="x">rm</a> & "go"`
	for _, tc := range []struct {
		caps             []string
		wantBody, wantTi string
	}{
		{[]string{"actions", "body", "body-markup"}, `run &lt;a href=&quot;x&quot;&gt;rm&lt;/a&gt; &amp; &quot;go&quot;`, "&lt;b&gt;T&lt;/b&gt; &amp; co"},
		{[]string{"actions", "body"}, text, "<b>T</b> & co"},
	} {
		bus := newFakeFdo(tc.caps...)
		r := startFdo(t, bus, time.Second)
		register(t, r, t.TempDir())
		r.send(t, map[string]any{"op": "show", "id": "1", "tag": "t", "title": "<b>T</b> & co", "body": text, "default": openArgs})
		r.read(t)
		if n := bus.last(); n.Body != tc.wantBody || n.Title != tc.wantTi {
			t.Fatalf("caps %v: body %q title %q", tc.caps, n.Body, n.Title)
		}
	}
}

// Only the owner of org.freedesktop.Notifications may click: any other bus client's ActionInvoked / NotificationReplied /
// NotificationClosed / ActivationToken is dropped (and logged); NameOwnerChanged counts only from the bus itself; a new owner is a
// reset (review finding 2).
func TestFdoGateOnlyTheNotificationServer(t *testing.T) {
	var logs []string
	old := fdoLog
	fdoLog = func(f string, a ...any) { logs = append(logs, f) }
	defer func() { fdoLog = old }()
	g := &fdoGate{}
	g.setOwner(":1.5")
	act := []any{uint32(7), "b0"}
	if s, ok := g.read(":1.5", fdoPathStr, fdoIface+".ActionInvoked", act); !ok || s != (fdoSignal{Kind: "action", ID: 7, Key: "b0"}) {
		t.Fatalf("the server's click: %+v %v", s, ok)
	}
	for _, c := range []struct {
		name string
		body []any
	}{
		{"ActionInvoked", act},
		{"NotificationReplied", []any{uint32(7), "rm -rf"}},
		{"NotificationClosed", []any{uint32(7), uint32(2)}},
		{"ActivationToken", []any{uint32(7), "tok"}},
	} {
		for _, sender := range []string{":1.9", "", fdoName} {
			if s, ok := g.read(sender, fdoPathStr, fdoIface+"."+c.name, c.body); ok {
				t.Fatalf("%s from %q let through: %+v", c.name, sender, s)
			}
		}
	}
	if len(logs) != 12 {
		t.Fatalf("logged %d: %v", len(logs), logs)
	}
	// a forged NameOwnerChanged (a client, not the bus) does not move the owner
	if _, ok := g.read(":1.9", dbusPath, dbusName+".NameOwnerChanged", []any{fdoName, ":1.5", ":1.9"}); ok || g.currentOwner() != ":1.5" {
		t.Fatalf("forged owner change: %q", g.currentOwner())
	}
	// another name's change: nothing
	if _, ok := g.read(dbusName, dbusPath, dbusName+".NameOwnerChanged", []any{"org.other", "", ":1.9"}); ok || g.currentOwner() != ":1.5" {
		t.Fatal("another name moved the owner")
	}
	// the notification server restarts: gone (reset), back under a new name (reset); the old name's clicks are dropped
	if s, ok := g.read(dbusName, dbusPath, dbusName+".NameOwnerChanged", []any{fdoName, ":1.5", ""}); !ok || s != (fdoSignal{Kind: "reset", Gen: 1}) {
		t.Fatalf("gone: %+v %v", s, ok)
	}
	if _, ok := g.read(":1.5", fdoPathStr, fdoIface+".ActionInvoked", act); ok {
		t.Fatal("a click with no server")
	}
	if s, ok := g.read(dbusName, dbusPath, dbusName+".NameOwnerChanged", []any{fdoName, "", ":1.12"}); !ok || s != (fdoSignal{Kind: "reset", Gen: 2}) {
		t.Fatalf("new owner: %+v %v", s, ok)
	}
	if _, ok := g.read(dbusName, dbusPath, dbusName+".NameOwnerChanged", []any{fdoName, "", ":1.12"}); ok {
		t.Fatal("the same owner again is no reset")
	}
	if _, ok := g.read(":1.5", fdoPathStr, fdoIface+".ActionInvoked", act); ok {
		t.Fatal("the old server's click")
	}
	if _, ok := g.read(":1.12", fdoPathStr, fdoIface+".ActionInvoked", act); !ok {
		t.Fatal("the new server's click")
	}
	// no owner known yet: everything is dropped
	if _, ok := (&fdoGate{}).read(":1.5", fdoPathStr, fdoIface+".ActionInvoked", act); ok {
		t.Fatal("no owner")
	}
	// wrong path or shape: not a signal
	if _, ok := g.read(":1.12", "/other", fdoIface+".ActionInvoked", act); ok {
		t.Fatal("other path")
	}
	// GetNameOwner's answer does not overwrite an owner change seen while it was on its way
	g2 := &fdoGate{}
	gen := g2.Gen()
	g2.read(dbusName, dbusPath, dbusName+".NameOwnerChanged", []any{fdoName, ":1.5", ":1.20"})
	g2.initOwner(gen, ":1.5")
	if g2.currentOwner() != ":1.20" {
		t.Fatalf("owner %q", g2.currentOwner())
	}
	g3 := &fdoGate{}
	g3.initOwner(g3.Gen(), ":1.5")
	if g3.currentOwner() != ":1.5" {
		t.Fatalf("owner %q", g3.currentOwner())
	}
}

// A reset (the notification server restarted): every id this helper had is forgotten, so the new server's ids (counted from 1
// again) are not mistaken for the old ones; a note of the same chat is shown fresh, not as a replacement.
func TestFdoResetForgetsEveryNote(t *testing.T) {
	bus := newFakeFdo("actions", "body")
	r := startFdo(t, bus, time.Second)
	register(t, r, t.TempDir())
	r.send(t, map[string]any{"op": "show", "id": "1", "tag": "t1", "title": "x", "default": openArgs,
		"buttons": []map[string]string{{"label": "Allow", "args": allowArgs}}})
	r.read(t)
	bus.sigs <- fdoSignal{Kind: "reset", Gen: 1}
	bus.sigs <- fdoSignal{Kind: "action", ID: 101, Key: "b0"} // the new server's 101 is not AIB's
	r.send(t, map[string]any{"op": "show", "id": "2", "tag": "t1", "title": "x", "default": openArgs})
	if m := r.read(t); m.Op != "shown" {
		t.Fatalf("%+v (a click came through after the reset?)", m)
	}
	if n := bus.last(); n.ReplacesID != 0 {
		t.Fatalf("replaces %d after a reset", n.ReplacesID)
	}
	bus.sigs <- fdoSignal{Kind: "action", ID: 102, Key: "default"}
	if m := r.read(t); m.Op != "activated" || m.Args != openArgs {
		t.Fatalf("%+v", m)
	}
	// the server restarts again, and AIB shows a note before the reset reaches the helper: the new server gave that id, so it stays
	bus.mu.Lock()
	bus.gen = 2
	bus.mu.Unlock()
	r.send(t, map[string]any{"op": "show", "id": "3", "tag": "t3", "title": "y", "default": openArgs})
	r.read(t)
	bus.sigs <- fdoSignal{Kind: "reset", Gen: 2}
	bus.sigs <- fdoSignal{Kind: "action", ID: 102, Key: "default"} // gen 1: forgotten
	bus.sigs <- fdoSignal{Kind: "action", ID: 103, Key: "default"} // gen 2: still AIB's
	if m := r.read(t); m.Op != "activated" || m.Args != openArgs {
		t.Fatalf("%+v", m)
	}
	r.send(t, map[string]any{"op": "remove", "tag": "t1"})
	if m := r.read(t); m.Op != "removed" {
		t.Fatalf("only one click came through, then removed: %+v", m)
	}
	if got := bus.closedIDs(); len(got) != 0 {
		t.Fatalf("t1 was forgotten by the reset, nothing to close: %v", got)
	}
}

// SIGTERM (the next AIB's claim): every notification still up is closed and the helper exits, releasing its pid file.
func TestFdoStopClosesNotesAndExits(t *testing.T) {
	bus := newFakeFdo("actions", "body")
	r := startFdo(t, bus, time.Hour)
	data := t.TempDir()
	register(t, r, data)
	for i, tag := range []string{"t1", "t2"} {
		r.send(t, map[string]any{"op": "show", "id": strconv.Itoa(i), "tag": tag, "title": "x", "default": openArgs})
		r.read(t)
	}
	r.in.Close() // AIB quit: it lingers for the clicks
	time.Sleep(50 * time.Millisecond)
	close(r.stop)
	if c := r.exit(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
	got := bus.closedIDs()
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	if !reflect.DeepEqual(got, []uint32{101, 102}) {
		t.Fatalf("closed %v", got)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !reflect.DeepEqual(r.released, []string{data}) {
		t.Fatalf("released %v", r.released)
	}
}

func TestFdoRegisterFailures(t *testing.T) {
	// no session bus
	r := startFdo(t, nil, time.Second)
	if m := register(t, r, t.TempDir()); m.Op != "error" || !strings.Contains(m.Error, "no session bus") {
		t.Fatalf("%+v", m)
	}
	// no notification server on the bus
	none := newFakeFdo()
	none.capsErr = errors.New("org.freedesktop.DBus.Error.ServiceUnknown")
	r = startFdo(t, none, time.Second)
	if m := register(t, r, t.TempDir()); m.Op != "error" || !strings.Contains(m.Error, "no notification server") || !none.shut {
		t.Fatalf("%+v", m)
	}
	// a server without buttons: AIB keeps notify-send
	plain := newFakeFdo("body")
	r = startFdo(t, plain, time.Second)
	if m := register(t, r, t.TempDir()); m.Op != "error" || !strings.Contains(m.Error, "no buttons") {
		t.Fatalf("%+v", m)
	}
	r.send(t, map[string]any{"op": "show", "id": "9", "tag": "t"})
	if m := r.read(t); m.Op != "failed" || m.ID != "9" {
		t.Fatalf("%+v", m)
	}
	// register without a data folder
	r = startFdo(t, newFakeFdo("actions"), time.Second)
	r.send(t, map[string]any{"op": "register"})
	if m := r.read(t); m.Op != "error" {
		t.Fatalf("%+v", m)
	}
}

func TestFdoAIBQuitLingersWritesInboxAndStartsAIB(t *testing.T) {
	data := t.TempDir()
	bus := newFakeFdo("actions", "body")
	r := startFdo(t, bus, 5*time.Second)
	register(t, r, data)
	r.send(t, map[string]any{"op": "show", "id": "1", "tag": "t1", "title": "Payments", "default": openArgs,
		"buttons": []map[string]string{{"label": "Allow", "args": allowArgs}}})
	r.read(t)
	r.in.Close() // AIB quit
	time.Sleep(50 * time.Millisecond)
	select {
	case c := <-r.ret:
		t.Fatalf("exited (%d) while a notification still waits", c)
	default:
	}
	bus.sigs <- fdoSignal{Kind: "token", ID: 101, Token: "tok-9"}
	bus.sigs <- fdoSignal{Kind: "action", ID: 101, Key: "b0"}
	if c := r.exit(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
	b, err := os.ReadFile(filepath.Join(data, "toast-inbox.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var line inboxLine
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(b))), &line); err != nil || line.Args != allowArgs || line.At != 1234 {
		t.Fatalf("inbox %q %v", b, err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !reflect.DeepEqual(r.launched, []string{"/usr/bin/aib|tok-9"}) {
		t.Fatalf("launched %v", r.launched)
	}
	if !reflect.DeepEqual(r.claimed, []string{data}) || !reflect.DeepEqual(r.released, []string{data}) {
		t.Fatalf("pid file: claimed %v released %v", r.claimed, r.released)
	}
}

func TestFdoAIBQuitExitsWhenNothingWaits(t *testing.T) {
	// no notification shown: exits at once
	r := startFdo(t, newFakeFdo("actions"), time.Hour)
	register(t, r, t.TempDir())
	r.in.Close()
	if c := r.exit(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
	// the last notification dismissed: exits, nothing written, nothing started
	data := t.TempDir()
	bus := newFakeFdo("actions")
	r = startFdo(t, bus, time.Hour)
	register(t, r, data)
	r.send(t, map[string]any{"op": "show", "id": "1", "tag": "t1", "title": "x", "default": openArgs})
	r.read(t)
	r.in.Close()
	bus.sigs <- fdoSignal{Kind: "closed", ID: 101, Reason: 2}
	if c := r.exit(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
	if _, err := os.Stat(filepath.Join(data, "toast-inbox.jsonl")); err == nil {
		t.Fatal("an inbox was written")
	}
	if len(r.launched) != 0 {
		t.Fatalf("launched %v", r.launched)
	}
	// the cap: exits after linger even with a notification still open
	bus = newFakeFdo("actions")
	r = startFdo(t, bus, 80*time.Millisecond)
	register(t, r, t.TempDir())
	r.send(t, map[string]any{"op": "show", "id": "1", "tag": "t1", "title": "x", "default": openArgs})
	r.read(t)
	r.in.Close()
	if c := r.exit(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
}

func TestFdoBusGoneEndsTheHelper(t *testing.T) {
	bus := newFakeFdo("actions")
	r := startFdo(t, bus, time.Hour)
	register(t, r, t.TempDir())
	r.send(t, map[string]any{"op": "show", "id": "1", "tag": "t1", "title": "x", "default": openArgs})
	r.read(t)
	close(bus.sigs)
	if c := r.exit(t); c != 1 {
		t.Fatalf("exit %d", c)
	}
}
