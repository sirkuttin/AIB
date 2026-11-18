// Package fakenotify is a stand-in org.freedesktop.Notifications server for tests: it records every Notify and CloseNotification
// and fires ActionInvoked, NotificationReplied, ActivationToken and NotificationClosed when told. Only ever on a private session
// bus (dbus-run-session), so nothing reaches a real desktop.
package fakenotify

import (
	"sort"
	"sync"

	"github.com/godbus/dbus/v5"
)

const (
	Name  = "org.freedesktop.Notifications"
	Path  = dbus.ObjectPath("/org/freedesktop/Notifications")
	Iface = "org.freedesktop.Notifications"
)

// Call is one Notify, with its hints as plain values.
type Call struct {
	ID         uint32         `json:"id"`
	AppName    string         `json:"appName"`
	ReplacesID uint32         `json:"replacesId"`
	Icon       string         `json:"icon"`
	Summary    string         `json:"summary"`
	Body       string         `json:"body"`
	Actions    []string       `json:"actions"`
	Hints      map[string]any `json:"hints"`
	Timeout    int32          `json:"timeout"`
}

type Server struct {
	conn   *dbus.Conn
	caps   []string
	mu     sync.Mutex
	next   uint32
	calls  []Call
	closed []uint32
	// OnNotify / OnClose are called for each Notify / CloseNotification (after it is recorded).
	OnNotify func(Call)
	OnClose  func(id uint32)
}

// busObj is what is exported on the bus (only methods ending in *dbus.Error are).
type busObj struct{ s *Server }

func (o busObj) GetCapabilities() ([]string, *dbus.Error) { return o.s.caps, nil }

func (o busObj) GetServerInformation() (string, string, string, string, *dbus.Error) {
	return "fakenotify", "AIB tests", "1", "1.2", nil
}

func (o busObj) Notify(app string, replaces uint32, icon, summary, body string, actions []string, hints map[string]dbus.Variant,
	timeout int32) (uint32, *dbus.Error) {
	s := o.s
	s.mu.Lock()
	id := replaces
	if id == 0 {
		s.next++
		id = s.next
	}
	plain := map[string]any{}
	for k, v := range hints {
		plain[k] = v.Value()
	}
	c := Call{ID: id, AppName: app, ReplacesID: replaces, Icon: icon, Summary: summary, Body: body, Actions: actions, Hints: plain, Timeout: timeout}
	s.calls = append(s.calls, c)
	fn := s.OnNotify
	s.mu.Unlock()
	if fn != nil {
		fn(c)
	}
	return id, nil
}

func (o busObj) CloseNotification(id uint32) *dbus.Error {
	s := o.s
	s.mu.Lock()
	s.closed = append(s.closed, id)
	fn := s.OnClose
	s.mu.Unlock()
	s.emit("NotificationClosed", id, uint32(3)) // 3: closed by CloseNotification
	if fn != nil {
		fn(id)
	}
	return nil
}

// Start owns org.freedesktop.Notifications on conn.
func Start(conn *dbus.Conn, caps []string) (*Server, error) {
	s := &Server{conn: conn, caps: caps}
	if err := conn.Export(busObj{s}, Path, Iface); err != nil {
		return nil, err
	}
	reply, err := conn.RequestName(Name, dbus.NameFlagDoNotQueue)
	if err != nil {
		return nil, err
	}
	if reply != dbus.RequestNameReplyPrimaryOwner {
		return nil, dbus.ErrClosed
	}
	return s, nil
}

func (s *Server) emit(member string, args ...interface{}) error {
	return s.conn.Emit(Path, Iface+"."+member, args...)
}

// Invoke is a click: the activation token first (when given), then ActionInvoked, then the notification closes (reason 2).
func (s *Server) Invoke(id uint32, key, token string) error {
	if token != "" {
		if err := s.emit("ActivationToken", id, token); err != nil {
			return err
		}
	}
	if err := s.emit("ActionInvoked", id, key); err != nil {
		return err
	}
	return s.emit("NotificationClosed", id, uint32(2))
}

// Reply is a KDE inline reply.
func (s *Server) Reply(id uint32, text string) error { return s.emit("NotificationReplied", id, text) }

// Dismiss is the person closing it (reason 2).
func (s *Server) Dismiss(id uint32) error { return s.emit("NotificationClosed", id, uint32(2)) }

func (s *Server) Calls() []Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Call(nil), s.calls...)
}

func (s *Server) Closed() []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]uint32(nil), s.closed...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
