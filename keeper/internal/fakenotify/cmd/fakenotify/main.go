// fakenotify: a fake org.freedesktop.Notifications server driven over stdin/stdout, for the WSL e2e
// (work/deno/linux_notify_wsl_e2e_test.ts). Run it under dbus-run-session so it only ever owns a private bus.
//
//	fakenotify -caps actions,body,inline-reply
//	<- {"ev":"ready","address":"<DBUS_SESSION_BUS_ADDRESS>"}
//	<- {"ev":"notify","call":{...}}            each Notify
//	<- {"ev":"close","id":N}                   each CloseNotification
//	-> {"op":"invoke","id":N,"key":"b0","token":"t"}   ActivationToken, ActionInvoked, NotificationClosed
//	-> {"op":"reply","id":N,"text":"..."}              NotificationReplied
//	-> {"op":"dismiss","id":N}                         NotificationClosed (reason 2)
//	-> {"op":"rogue","member":"ActionInvoked","id":N,"key":"b0","text":"...","token":"t","unicast":true}
//	                                                   another bus client (not the server) fakes that signal: broadcast, or
//	                                                   with unicast sent straight to the last Notify caller (AIB's helper)
//	-> {"op":"restart"}                                the server gives up the name and a new connection takes it (ids from 1)
//	stdin closed: exits.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strings"
	"sync"

	"aib.dev/keeper/internal/fakenotify"
	"github.com/godbus/dbus/v5"
)

func main() {
	caps := flag.String("caps", "actions,body", "the capabilities GetCapabilities answers")
	flag.Parse()
	var mu sync.Mutex
	out := json.NewEncoder(os.Stdout)
	emit := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		out.Encode(v)
	}
	fail := func(err error) {
		emit(map[string]any{"ev": "error", "error": err.Error()})
		os.Exit(1)
	}
	start := func() (*dbus.Conn, *fakenotify.Server, error) {
		conn, err := dbus.ConnectSessionBus()
		if err != nil {
			return nil, nil, err
		}
		s, err := fakenotify.Start(conn, strings.Split(*caps, ","))
		if err != nil {
			conn.Close()
			return nil, nil, err
		}
		s.OnNotify = func(c fakenotify.Call) { emit(map[string]any{"ev": "notify", "call": c}) }
		s.OnClose = func(id uint32) { emit(map[string]any{"ev": "close", "id": id}) }
		return conn, s, nil
	}
	conn, s, err := start()
	if err != nil {
		fail(err)
	}
	var rogue *dbus.Conn
	emit(map[string]any{"ev": "ready", "address": os.Getenv("DBUS_SESSION_BUS_ADDRESS")})
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var m struct {
			Op      string `json:"op"`
			ID      uint32 `json:"id"`
			Key     string `json:"key"`
			Token   string `json:"token"`
			Text    string `json:"text"`
			Member  string `json:"member"`
			Unicast bool   `json:"unicast"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		var err error
		switch m.Op {
		case "invoke":
			err = s.Invoke(m.ID, m.Key, m.Token)
		case "reply":
			err = s.Reply(m.ID, m.Text)
		case "dismiss":
			err = s.Dismiss(m.ID)
		case "rogue":
			if rogue == nil {
				rogue, err = dbus.ConnectSessionBus()
				if err != nil {
					break
				}
			}
			dest := ""
			if m.Unicast {
				dest = s.Client()
			}
			var args []interface{}
			switch m.Member {
			case "ActionInvoked":
				args = []interface{}{m.ID, m.Key}
			case "NotificationReplied":
				args = []interface{}{m.ID, m.Text}
			case "ActivationToken":
				args = []interface{}{m.ID, m.Token}
			case "NotificationClosed":
				args = []interface{}{m.ID, uint32(2)}
			default:
				err = errors.New("unknown member")
			}
			if err == nil {
				err = fakenotify.Rogue(rogue, dest, m.Member, args...)
			}
		case "restart":
			s.Stop()
			conn.Close()
			var c2 *dbus.Conn
			var s2 *fakenotify.Server
			if c2, s2, err = start(); err == nil {
				conn, s = c2, s2
			}
		}
		ok := err == nil
		emit(map[string]any{"ev": "done", "op": m.Op, "ok": ok})
	}
}
