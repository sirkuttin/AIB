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
//	stdin closed: exits.
package main

import (
	"bufio"
	"encoding/json"
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
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		emit(map[string]any{"ev": "error", "error": err.Error()})
		os.Exit(1)
	}
	s, err := fakenotify.Start(conn, strings.Split(*caps, ","))
	if err != nil {
		emit(map[string]any{"ev": "error", "error": err.Error()})
		os.Exit(1)
	}
	s.OnNotify = func(c fakenotify.Call) { emit(map[string]any{"ev": "notify", "call": c}) }
	s.OnClose = func(id uint32) { emit(map[string]any{"ev": "close", "id": id}) }
	emit(map[string]any{"ev": "ready", "address": os.Getenv("DBUS_SESSION_BUS_ADDRESS")})
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var m struct {
			Op    string `json:"op"`
			ID    uint32 `json:"id"`
			Key   string `json:"key"`
			Token string `json:"token"`
			Text  string `json:"text"`
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
		}
		ok := err == nil
		emit(map[string]any{"ev": "done", "op": m.Op, "ok": ok})
	}
}
