//go:build linux

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"aib.dev/keeper/internal/fakenotify"
	"github.com/godbus/dbus/v5"
)

// The real bus layer (godbus) against a fake notification server, on a private session bus only: run under dbus-run-session with
// AIB_FDO_BUS_TEST=1 (work/deno/linux_notify_wsl_e2e_test.ts does, in WSL). Skipped otherwise, so it never talks to a real desktop.

func fdoBusOrSkip(t *testing.T, caps ...string) *fakenotify.Server {
	t.Helper()
	if os.Getenv("AIB_FDO_BUS_TEST") != "1" || os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		t.Skip("needs a private session bus (dbus-run-session, AIB_FDO_BUS_TEST=1)")
	}
	conn, err := dbus.ConnectSessionBus() // its own connection (not the shared SessionBus)
	if err != nil {
		t.Fatal(err)
	}
	s, err := fakenotify.Start(conn, caps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return s
}

func fdoWait(t *testing.T, what string, ok func() bool) {
	t.Helper()
	end := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(end) {
			t.Fatalf("timed out: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDbusFdoNotifyHintsSignals(t *testing.T) {
	srv := fdoBusOrSkip(t, "actions", "body", "inline-reply")
	bus, err := connectFdo()
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	caps, err := bus.Caps()
	if err != nil || !reflect.DeepEqual(caps, []string{"actions", "body", "inline-reply"}) {
		t.Fatalf("caps %v %v", caps, err)
	}
	id, err := bus.Notify(fdoNote{AppName: "AIB", Icon: "/x/i.png", Title: "T", Body: "B", Actions: []string{"default", "Open", "inline-reply", "Reply"},
		DesktopEntry: "dev.aib.app", Urgency: 0, SuppressSound: true, ReplyHint: "Reply"})
	if err != nil || id == 0 {
		t.Fatalf("notify %d %v", id, err)
	}
	c := srv.Calls()[0]
	if c.AppName != "AIB" || c.Summary != "T" || c.Body != "B" || c.Icon != "/x/i.png" || c.Timeout != -1 {
		t.Fatalf("call %+v", c)
	}
	want := map[string]any{"desktop-entry": "dev.aib.app", "urgency": byte(0), "suppress-sound": true, "image-path": "/x/i.png",
		"x-kde-reply-placeholder-text": "Reply"}
	if !reflect.DeepEqual(c.Hints, want) {
		t.Fatalf("hints %#v", c.Hints)
	}
	srv.Invoke(id, "default", "tok")
	srv.Reply(id, "hello")
	var got []fdoSignal
	for len(got) < 4 {
		select {
		case s := <-bus.Signals():
			got = append(got, s)
		case <-time.After(3 * time.Second):
			t.Fatalf("signals so far %+v", got)
		}
	}
	wantSigs := []fdoSignal{{Kind: "token", ID: id, Token: "tok"}, {Kind: "action", ID: id, Key: "default"}, {Kind: "closed", ID: id, Reason: 2},
		{Kind: "reply", ID: id, Text: "hello"}}
	if !reflect.DeepEqual(got, wantSigs) {
		t.Fatalf("signals %+v", got)
	}
	if err := bus.CloseNote(id); err != nil {
		t.Fatal(err)
	}
	fdoWait(t, "CloseNotification", func() bool { return len(srv.Closed()) == 1 })
}

// The whole helper on the real bus: a click while AIB runs comes back on stdout; after AIB quit, a click lands in the inbox file
// and AIB's program is started with the token.
func TestFdoHelperOnRealBus(t *testing.T) {
	srv := fdoBusOrSkip(t, "actions", "body")
	data := t.TempDir()
	marker := filepath.Join(data, "started")
	prog := filepath.Join(data, "aib")
	os.WriteFile(prog, []byte("#!/bin/sh\necho \"$XDG_ACTIVATION_TOKEN $DESKTOP_STARTUP_ID\" > "+marker+"\n"), 0o755)
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	d := fdoDeps{connect: connectFdo, launch: launchAIB, claim: claimHelper, release: releaseHelper, now: time.Now, linger: time.Minute,
		settle: 100 * time.Millisecond}
	ret := make(chan int, 1)
	go func() { ret <- serveFdo(inR, outW, d); outW.Close() }()
	lines := make(chan fdoMsg, 16)
	go func() {
		dec := json.NewDecoder(outR)
		for {
			var m fdoMsg
			if dec.Decode(&m) != nil {
				close(lines)
				return
			}
			lines <- m
		}
	}()
	read := func() fdoMsg {
		select {
		case m := <-lines:
			return m
		case <-time.After(3 * time.Second):
			t.Fatal("no answer")
			return fdoMsg{}
		}
	}
	send := func(m map[string]any) { b, _ := json.Marshal(m); inW.Write(append(b, '\n')) }
	send(map[string]any{"op": "register", "name": "AIB", "data": data, "launch": prog, "desktop": "dev.aib.app"})
	if m := read(); m.Op != "ready" {
		t.Fatalf("%+v", m)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "toast-helper.pid")); strings.TrimSpace(string(b)) == "" {
		t.Fatal("no pid file")
	}
	send(map[string]any{"op": "show", "id": "1", "tag": "t", "title": "x", "default": openArgs,
		"buttons": []map[string]string{{"label": "Allow", "args": allowArgs}}})
	if m := read(); m.Op != "shown" {
		t.Fatalf("%+v", m)
	}
	id := srv.Calls()[0].ID
	srv.Invoke(id, "b0", "")
	if m := read(); m.Op != "activated" || m.Args != allowArgs {
		t.Fatalf("%+v", m)
	}
	send(map[string]any{"op": "show", "id": "2", "tag": "t2", "title": "y", "default": openArgs})
	read()
	id2 := srv.Calls()[1].ID
	inW.Close() // AIB quit
	time.Sleep(100 * time.Millisecond)
	srv.Invoke(id2, "default", "tok-7")
	select {
	case c := <-ret:
		if c != 0 {
			t.Fatalf("exit %d", c)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the helper did not exit after the click")
	}
	b, _ := os.ReadFile(filepath.Join(data, "toast-inbox.jsonl"))
	var line inboxLine
	if json.Unmarshal(b, &line) != nil || line.Args != openArgs {
		t.Fatalf("inbox %q", b)
	}
	fdoWait(t, "AIB started", func() bool { _, err := os.Stat(marker); return err == nil })
	if b, _ := os.ReadFile(marker); strings.TrimSpace(string(b)) != "tok-7 tok-7" {
		t.Fatalf("token %q", b)
	}
	if _, err := os.Stat(filepath.Join(data, "toast-helper.pid")); err == nil {
		t.Fatal("pid file left")
	}
}

// Review finding 2 on the real bus: another client's ActionInvoked / NotificationReplied / NotificationClosed / ActivationToken
// (broadcast, and sent straight to the helper's connection, which match rules do not filter) never come through; the server's do.
// A forged NameOwnerChanged moves nothing. A restarted notification server is a reset, and from then on only the new owner counts.
func TestFdoBusOnlyTheServerCanClick(t *testing.T) {
	srv := fdoBusOrSkip(t, "actions", "body")
	var mu sync.Mutex
	var logs []string
	old := fdoLog
	fdoLog = func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() }
	defer func() { fdoLog = old }()
	bus, err := connectFdo()
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	if _, err := bus.Caps(); err != nil {
		t.Fatal(err)
	}
	id, err := bus.Notify(fdoNote{AppName: "AIB", Title: "T", Actions: []string{"b0", "Allow"}})
	if err != nil {
		t.Fatal(err)
	}
	rogue, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Fatal(err)
	}
	defer rogue.Close()
	helper := srv.Client()
	for _, dest := range []string{"", helper} {
		fakenotify.Rogue(rogue, dest, "ActivationToken", id, "evil")
		fakenotify.Rogue(rogue, dest, "ActionInvoked", id, "b0")
		fakenotify.Rogue(rogue, dest, "NotificationReplied", id, "rm -rf ~")
		fakenotify.Rogue(rogue, dest, "NotificationClosed", id, uint32(2))
	}
	forged := &dbus.Message{Type: dbus.TypeSignal, Headers: map[dbus.HeaderField]dbus.Variant{
		dbus.FieldPath: dbus.MakeVariant(dbus.ObjectPath(dbusPath)), dbus.FieldInterface: dbus.MakeVariant(dbusName),
		dbus.FieldMember: dbus.MakeVariant("NameOwnerChanged"), dbus.FieldDestination: dbus.MakeVariant(helper),
		dbus.FieldSignature: dbus.MakeVariant(dbus.SignatureOf("", "", "")),
	}, Body: []interface{}{fdoName, "", rogue.Names()[0]}}
	if err := rogue.Send(forged, nil).Err; err != nil {
		t.Fatal(err)
	}
	fakenotify.Rogue(rogue, helper, "ActionInvoked", id, "b0")
	srv.Invoke(id, "b0", "")
	next := func() fdoSignal {
		select {
		case s := <-bus.Signals():
			return s
		case <-time.After(3 * time.Second):
			t.Fatal("no signal")
			return fdoSignal{}
		}
	}
	if s := next(); s != (fdoSignal{Kind: "action", ID: id, Key: "b0"}) {
		t.Fatalf("the first signal through is %+v, not the server's click", s)
	}
	if s := next(); s.Kind != "closed" {
		t.Fatalf("%+v", s)
	}
	mu.Lock()
	n := len(logs)
	mu.Unlock()
	// logged: the four sent straight to the helper, the forged owner change and the click after it. The broadcasts never reach
	// the helper at all: the bus routes only the owner's (sender= in the match rule).
	if n != 6 {
		t.Fatalf("dropped and logged %d: %v", n, logs)
	}

	// the notification server restarts: gone, then a new owner (each a reset); the old connection's clicks no longer count
	srv.Stop()
	conn2, err := dbus.ConnectSessionBus()
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	srv2, err := fakenotify.Start(conn2, []string{"actions", "body"})
	if err != nil {
		t.Fatal(err)
	}
	if s := next(); s.Kind != "reset" {
		t.Fatalf("%+v", s)
	}
	if s := next(); s.Kind != "reset" {
		t.Fatalf("%+v", s)
	}
	id2, err := bus.Notify(fdoNote{AppName: "AIB", Title: "T", Actions: []string{"b0", "Allow"}})
	if err != nil || srv2.Calls()[0].ID != id2 {
		t.Fatalf("notify after the restart: %d %v", id2, err)
	}
	srv.Invoke(id2, "b0", "") // the old server's connection, still on the bus
	srv2.Invoke(id2, "b0", "")
	if s := next(); s != (fdoSignal{Kind: "action", ID: id2, Key: "b0"}) {
		t.Fatalf("%+v", s)
	}
}
