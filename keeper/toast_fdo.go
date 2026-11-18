package main

// AIB-keeper toast on Linux: notifications with buttons through org.freedesktop.Notifications on the session bus (the design:
// aib-shared/research/linux-notify-and-update.md, question 1). The same helper and the same one-time codes as the Windows toasts
// (toast.go); only the OS layer differs. This file is the logic, with the bus behind fdoBus, so it is tested on every OS with a fake
// (toast_fdo_test.go); toast_linux.go is the real bus (godbus), tested against a fake notification server in WSL.
//
// JSON lines over stdin/stdout, as on Windows, but with plain fields instead of toast XML:
//
//	-> {"op":"register","name","icon","data","launch","desktop"}     <- {"op":"ready","caps":[...]} | {"op":"error","error"}
//	-> {"op":"show","id","tag","title","body","default","buttons":[{"label","args","input"}],"reply","replyOpen","silent"}
//	                                                                  <- {"op":"shown","id"} | {"op":"failed","id","error"}
//	-> {"op":"remove","tag"}                                          <- {"op":"removed","tag"}   (CloseNotification)
//	<- {"op":"activated","args","inputs","token"}                     a body click (the `default` action), a button, a reply
//
// A button with "input" is the reply box: where the server advertises `inline-reply` (KDE, swaync) it becomes the KDE inline reply
// (its text comes back in NotificationReplied as inputs.reply); elsewhere (GNOME) it is an Open button with the "replyOpen" args.
// register fails when no notification server answers or it has no `actions`: AIB then uses notify-send, as before.
//
// AIB fully quit (the Linux side of Windows' -Embedding): stdin ends but the helper stays while a notification it showed is still
// open, for at most fdoDeps.linger (CODE_TTL_MS, 12 h). A click then goes to <data>/toast-inbox.jsonl (the same file and format
// as on Windows) and AIB's program is started with the click's activation token; the helper exits a moment later. A helper that
// lingers from an earlier AIB is stopped by the next one's register (<data>/toast-helper.pid).

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// fdoNote is one Notify call (org.freedesktop.Notifications, spec 1.2).
type fdoNote struct {
	ReplacesID    uint32
	AppName       string
	Icon          string
	Title, Body   string
	Actions       []string // key, label, key, label, ...
	DesktopEntry  string
	Urgency       byte // 0 low (silent), 1 normal
	SuppressSound bool
	ReplyHint     string // x-kde-reply-placeholder-text, only with an inline-reply action
}

// fdoSignal is one signal from the notification server: "action" (ActionInvoked), "reply" (NotificationReplied), "closed"
// (NotificationClosed) or "token" (ActivationToken).
type fdoSignal struct {
	Kind   string
	ID     uint32
	Key    string // the action's key
	Text   string // the reply's text
	Token  string
	Reason uint32
}

type fdoBus interface {
	Caps() ([]string, error)
	Notify(fdoNote) (uint32, error)
	CloseNote(id uint32) error
	// Signals ends (is closed) when the bus connection goes.
	Signals() <-chan fdoSignal
	Close()
}

type fdoDeps struct {
	connect func() (fdoBus, error)
	// launch starts AIB's program detached, with the click's activation token (empty when the server sent none).
	launch func(program, token string) error
	// claim stops a helper that lingers from an earlier AIB and records this one (<data>/toast-helper.pid); release forgets it.
	claim   func(data string)
	release func(data string)
	now     func() time.Time
	linger  time.Duration
	settle  time.Duration
}

type toastButton struct {
	Label string `json:"label"`
	Args  string `json:"args"`
	Input string `json:"input,omitempty"`
}

type fdoMsg struct {
	Op        string            `json:"op"`
	ID        string            `json:"id,omitempty"`
	Tag       string            `json:"tag,omitempty"`
	Title     string            `json:"title,omitempty"`
	Body      string            `json:"body,omitempty"`
	Default   string            `json:"default,omitempty"`
	Buttons   []toastButton     `json:"buttons,omitempty"`
	Reply     string            `json:"reply,omitempty"`
	ReplyOpen string            `json:"replyOpen,omitempty"`
	Silent    bool              `json:"silent,omitempty"`
	Name      string            `json:"name,omitempty"`
	Icon      string            `json:"icon,omitempty"`
	Data      string            `json:"data,omitempty"`
	Launch    string            `json:"launch,omitempty"`
	Desktop   string            `json:"desktop,omitempty"`
	Caps      []string          `json:"caps,omitempty"`
	Error     string            `json:"error,omitempty"`
	Args      string            `json:"args,omitempty"`
	Inputs    map[string]string `json:"inputs,omitempty"`
	Token     string            `json:"token,omitempty"`
}

// fdoLive is one notification on screen: what each of its action keys means.
type fdoLive struct {
	tag   string
	def   string
	keys  map[string]string // action key -> click args
	reply string            // the reply button's args (inline reply)
}

type fdoServer struct {
	d       fdoDeps
	send    func(fdoMsg)
	bus     fdoBus
	reg     fdoMsg
	caps    map[string]bool
	byTag   map[string]uint32
	live    map[uint32]*fdoLive
	tokens  map[uint32]string
	stdin   bool // AIB is still there
	clicked int  // clicks written to the inbox while lingering
}

// serveFdo runs the helper until AIB is gone and nothing waits for a click any more.
func serveFdo(r io.Reader, w io.Writer, d fdoDeps) int {
	var wmu sync.Mutex
	gone := false
	s := &fdoServer{d: d, byTag: map[string]uint32{}, live: map[uint32]*fdoLive{}, tokens: map[uint32]string{}, stdin: true}
	s.send = func(m fdoMsg) {
		wmu.Lock()
		defer wmu.Unlock()
		if gone {
			return // AIB quit: never write to a closed pipe
		}
		b, _ := json.Marshal(m)
		if _, err := w.Write(append(b, '\n')); err != nil {
			gone = true
		}
	}
	lines := make(chan []byte)
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			lines <- append([]byte(nil), sc.Bytes()...)
		}
		close(lines)
	}()
	defer func() {
		if s.bus != nil {
			s.bus.Close()
		}
		if s.reg.Data != "" && d.release != nil {
			d.release(s.reg.Data)
		}
	}()
	var sigs <-chan fdoSignal
	var limit, settle <-chan time.Time
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				lines = nil
				wmu.Lock()
				gone = true
				wmu.Unlock()
				s.stdin = false
				if !s.waiting() {
					return 0
				}
				limit = time.After(d.linger)
				continue
			}
			s.handle(line)
			if s.bus != nil && sigs == nil {
				sigs = s.bus.Signals()
			}
		case sig, ok := <-sigs:
			if !ok {
				return 1 // the bus went away
			}
			s.signal(sig)
			if !s.stdin {
				if s.clicked > 0 && settle == nil {
					settle = time.After(d.settle)
				}
				if s.clicked == 0 && !s.waiting() {
					return 0
				}
			}
		case <-limit:
			return 0
		case <-settle:
			return 0
		}
	}
}

// waiting: after AIB quit, is there anything a click could still come from?
func (s *fdoServer) waiting() bool {
	return s.bus != nil && s.reg.Data != "" && len(s.live) > 0
}

func (s *fdoServer) handle(line []byte) {
	var m fdoMsg
	if json.Unmarshal(line, &m) != nil {
		s.send(fdoMsg{Op: "error", Error: "bad message"})
		return
	}
	switch m.Op {
	case "register":
		s.register(m)
	case "show":
		if s.bus == nil {
			s.send(fdoMsg{Op: "failed", ID: m.ID, Error: "not registered"})
			return
		}
		if err := s.show(m); err != nil {
			s.send(fdoMsg{Op: "failed", ID: m.ID, Error: err.Error()})
			return
		}
		s.send(fdoMsg{Op: "shown", ID: m.ID})
	case "remove":
		if id, ok := s.byTag[m.Tag]; ok && s.bus != nil {
			s.bus.CloseNote(id) // best effort: it may be gone already
			delete(s.byTag, m.Tag)
			delete(s.live, id)
		}
		s.send(fdoMsg{Op: "removed", Tag: m.Tag})
	default:
		s.send(fdoMsg{Op: "error", Error: "unknown op"})
	}
}

func (s *fdoServer) register(m fdoMsg) {
	if s.bus != nil {
		s.send(fdoMsg{Op: "ready", Caps: s.capList()})
		return
	}
	if m.Data == "" {
		s.send(fdoMsg{Op: "error", Error: "register needs data"})
		return
	}
	bus, err := s.d.connect()
	if err != nil {
		s.send(fdoMsg{Op: "error", Error: "no session bus: " + err.Error()})
		return
	}
	caps, err := bus.Caps()
	if err != nil {
		bus.Close()
		s.send(fdoMsg{Op: "error", Error: "no notification server: " + err.Error()})
		return
	}
	s.caps = map[string]bool{}
	for _, c := range caps {
		s.caps[c] = true
	}
	if !s.caps["actions"] {
		bus.Close()
		s.send(fdoMsg{Op: "error", Error: "the notification server shows no buttons"})
		return
	}
	if m.Name == "" {
		m.Name = "AIB"
	}
	s.bus, s.reg = bus, m
	if s.d.claim != nil {
		s.d.claim(m.Data)
	}
	s.send(fdoMsg{Op: "ready", Caps: s.capList()})
}

func (s *fdoServer) capList() []string {
	out := make([]string, 0, len(s.caps))
	for c := range s.caps {
		out = append(out, c)
	}
	return out
}

func (s *fdoServer) show(m fdoMsg) error {
	live := &fdoLive{tag: m.Tag, def: m.Default, keys: map[string]string{}}
	n := fdoNote{
		AppName:      s.reg.Name,
		Icon:         s.reg.Icon,
		Title:        m.Title,
		Body:         m.Body,
		DesktopEntry: s.reg.Desktop,
		Urgency:      1,
	}
	if s.caps["body-markup"] {
		n.Body = markupEscape(m.Body) // the server reads the body as markup: an agent's text never becomes a tag or a link
	}
	if m.Silent {
		n.Urgency, n.SuppressSound = 0, true
	}
	if m.Default != "" {
		n.Actions = append(n.Actions, "default", "Open") // a body click; GNOME and KDE draw no button for it
	}
	for i, b := range m.Buttons {
		if i >= 3 {
			break // GNOME shows three at most
		}
		if b.Input != "" {
			if s.caps["inline-reply"] {
				n.Actions = append(n.Actions, "inline-reply", "Reply")
				n.ReplyHint = m.Reply
				if n.ReplyHint == "" {
					n.ReplyHint = "Reply"
				}
				live.reply = b.Args
				continue
			}
			if m.ReplyOpen == "" {
				continue
			}
			b = toastButton{Label: "Open", Args: m.ReplyOpen}
		}
		key := "b" + strconv.Itoa(i)
		n.Actions = append(n.Actions, key, b.Label)
		live.keys[key] = b.Args
	}
	if old, ok := s.byTag[m.Tag]; ok {
		n.ReplacesID = old
	}
	id, err := s.bus.Notify(n)
	if err != nil {
		return err
	}
	if n.ReplacesID != 0 && n.ReplacesID != id {
		delete(s.live, n.ReplacesID)
	}
	s.byTag[m.Tag] = id
	s.live[id] = live
	return nil
}

func (s *fdoServer) signal(sig fdoSignal) {
	switch sig.Kind {
	case "token":
		if _, ok := s.live[sig.ID]; ok {
			s.tokens[sig.ID] = sig.Token
		}
	case "action":
		l := s.live[sig.ID]
		if l == nil {
			return // another app's notification, or one already done
		}
		args := l.keys[sig.Key]
		if sig.Key == "default" {
			args = l.def
		}
		if args == "" {
			return
		}
		s.click(sig.ID, args, nil)
	case "reply":
		l := s.live[sig.ID]
		if l == nil || l.reply == "" {
			return
		}
		s.click(sig.ID, l.reply, map[string]string{"reply": sig.Text})
	case "closed":
		if l := s.live[sig.ID]; l != nil {
			if s.byTag[l.tag] == sig.ID {
				delete(s.byTag, l.tag)
			}
			delete(s.live, sig.ID)
		}
		delete(s.tokens, sig.ID)
	}
}

func (s *fdoServer) click(id uint32, args string, inputs map[string]string) {
	token := s.tokens[id]
	if s.stdin {
		s.send(fdoMsg{Op: "activated", Args: args, Inputs: inputs, Token: token})
		return
	}
	// AIB is gone: the click waits in the inbox file and AIB is started (once)
	if err := appendInbox(s.reg.Data, inboxLine{Args: args, Inputs: inputs, At: s.d.now().UnixMilli()}); err != nil {
		return
	}
	s.clicked++
	if s.clicked == 1 && s.reg.Launch != "" && s.d.launch != nil {
		s.d.launch(s.reg.Launch, token)
	}
}

func markupEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(s)
}

// fdoMain is `AIB-keeper toast` on Linux.
func fdoMain() int {
	d, err := realFdoDeps()
	if err != nil {
		os.Stdout.WriteString(`{"op":"error","error":` + jsonString(err.Error()) + "}\n")
		return 1
	}
	return serveFdo(os.Stdin, os.Stdout, d)
}
