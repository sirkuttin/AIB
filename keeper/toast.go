package main

// AIB-keeper toast: Windows toasts with buttons (Inbox v3.1 phase 4, aib-shared/designs/inbox-v31 section 3). Never part of a serving
// keeper; the keeper's own protocol is untouched. The keeper binary is GUI-subsystem on Windows, so this never has a console.
// On Linux the same subcommand is the D-Bus notification helper instead (toast_fdo.go: same clicks, plain fields, no registry).
//
// Two ways it runs:
//
//	AIB-keeper toast              the AIB server starts it once, hidden, and talks JSON lines over stdin/stdout:
//	                                -> {"op":"register","appId","name","icon","clsid","data","launch"}   (first; writes HKCU keys)
//	                                <- {"op":"ready"} | {"op":"error","error"}
//	                                -> {"op":"show","id","tag","group","xml"}  <- {"op":"shown","id"} | {"op":"failed","id","error"}
//	                                -> {"op":"remove","tag","group"}           <- {"op":"removed","tag"}
//	                                <- {"op":"activated","args","inputs"}      a click (the helper is the COM class object meanwhile)
//	                              stdin closed: it revokes its class object and exits.
//	AIB-keeper toast --app-id A --clsid C --data D --launch L -Embedding
//	                              Windows starts this from LocalServer32 for a click while no helper runs (AIB fully quit). The click
//	                              is appended to D/toast-inbox.jsonl and L (AIB.exe) is started; AIB applies it after start-up, and
//	                              only if that request is still open (the one-time code is checked there, never here).
//
// The registry keys (only HKCU, never admin), written at every AIB start: Software\Classes\AppUserModelId\<appId> {DisplayName,
// IconUri, CustomActivator} and Software\Classes\CLSID\<clsid>\LocalServer32 = the -Embedding command line above (without the flag).

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// toastApp mirrors wintoast.App (kept here so this file builds on every OS).
type toastApp struct {
	AppID, DisplayName, IconPath, CLSID, Command string
}

type toaster interface {
	Show(xml, tag, group string) error
	Remove(tag, group string) error
	Close()
}

// toastDeps is the OS layer; tests pass fakes (toast_test.go), Windows the real one (toast_windows.go).
type toastDeps struct {
	exe       string
	register  func(toastApp) error
	open      func(appID string) (toaster, error)
	activator func(clsid string, fn func(args string, inputs map[string]string)) (revoke func(), err error)
	launch    func(program string) error
	now       func() time.Time
}

type toastMsg struct {
	Op     string            `json:"op"`
	ID     string            `json:"id,omitempty"`
	Tag    string            `json:"tag,omitempty"`
	Group  string            `json:"group,omitempty"`
	XML    string            `json:"xml,omitempty"`
	AppID  string            `json:"appId,omitempty"`
	Name   string            `json:"name,omitempty"`
	Icon   string            `json:"icon,omitempty"`
	CLSID  string            `json:"clsid,omitempty"`
	Data   string            `json:"data,omitempty"`
	Launch string            `json:"launch,omitempty"`
	Error  string            `json:"error,omitempty"`
	Args   string            `json:"args,omitempty"`
	Inputs map[string]string `json:"inputs,omitempty"`
}

type toastOpts struct {
	appID, clsid, data, launch string
	embedding                  bool
}

func parseToastArgs(args []string) (toastOpts, error) {
	fs := flag.NewFlagSet("AIB-keeper toast", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var o toastOpts
	fs.StringVar(&o.appID, "app-id", "", "the AUMID")
	fs.StringVar(&o.clsid, "clsid", "", "the click handler's COM class")
	fs.StringVar(&o.data, "data", "", "AIB's data folder (toast-inbox.jsonl)")
	fs.StringVar(&o.launch, "launch", "", "AIB's program, started after a click while AIB is closed")
	fs.BoolVar(&o.embedding, "Embedding", false, "started by COM for a click")
	fs.BoolVar(&o.embedding, "embedding", false, "started by COM for a click")
	// COM may also pass /Embedding
	norm := make([]string, 0, len(args))
	for _, a := range args {
		if strings.EqualFold(a, "/Embedding") {
			a = "-Embedding"
		}
		norm = append(norm, a)
	}
	if err := fs.Parse(norm); err != nil {
		return o, err
	}
	if o.embedding && (o.clsid == "" || o.data == "") {
		return o, errors.New("-Embedding needs --clsid and --data")
	}
	return o, nil
}

// quoteArg quotes one command-line argument the way Windows splits it (CommandLineToArgvW; syscall.EscapeArg's rules, which
// only exist in the Windows build of syscall).
func quoteArg(s string) string {
	if s == "" {
		return `""`
	}
	if !strings.ContainsAny(s, " \t\"") {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '\\':
			slashes++
		case '"':
			b.WriteString(strings.Repeat(`\`, slashes+1))
			slashes = 0
		default:
			slashes = 0
		}
		b.WriteByte(c)
	}
	b.WriteString(strings.Repeat(`\`, slashes))
	b.WriteByte('"')
	return b.String()
}

// toastCommand is LocalServer32's command line: Windows starts it (adding -Embedding) for a click while no helper runs.
func toastCommand(exe string, m toastMsg) string {
	parts := []string{`"` + exe + `"`, "toast", "--app-id", quoteArg(m.AppID), "--clsid", quoteArg(m.CLSID), "--data", quoteArg(m.Data)}
	if m.Launch != "" {
		parts = append(parts, "--launch", quoteArg(m.Launch))
	}
	return strings.Join(parts, " ")
}

func toastMain(args []string) int {
	if fdoToasts {
		return fdoMain() // Linux: org.freedesktop.Notifications (toast_fdo.go)
	}
	o, err := parseToastArgs(args)
	if err != nil {
		return 2
	}
	deps, err := realToastDeps()
	if err != nil {
		os.Stdout.WriteString(`{"op":"error","error":` + jsonString(err.Error()) + "}\n")
		return 1
	}
	if o.embedding {
		return embedToast(deps, o, 30*time.Second, 1500*time.Millisecond)
	}
	return serveToast(os.Stdin, os.Stdout, deps)
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// serveToast runs the stdio helper until r ends.
func serveToast(r io.Reader, w io.Writer, d toastDeps) int {
	var wmu sync.Mutex
	send := func(m toastMsg) {
		b, _ := json.Marshal(m)
		wmu.Lock()
		w.Write(append(b, '\n'))
		wmu.Unlock()
	}
	var t toaster
	var revoke func()
	defer func() {
		if revoke != nil {
			revoke()
		}
		if t != nil {
			t.Close()
		}
	}()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		var m toastMsg
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			send(toastMsg{Op: "error", Error: "bad message"})
			continue
		}
		switch m.Op {
		case "register":
			if t != nil {
				send(toastMsg{Op: "ready"})
				continue
			}
			if m.AppID == "" || m.CLSID == "" || m.Data == "" {
				send(toastMsg{Op: "error", Error: "register needs appId, clsid and data"})
				continue
			}
			app := toastApp{AppID: m.AppID, DisplayName: m.Name, IconPath: m.Icon, CLSID: m.CLSID, Command: toastCommand(d.exe, m)}
			if app.DisplayName == "" {
				app.DisplayName = "AIB"
			}
			if err := d.register(app); err != nil {
				send(toastMsg{Op: "error", Error: "registry: " + err.Error()})
				continue
			}
			rv, err := d.activator(m.CLSID, func(args string, inputs map[string]string) {
				send(toastMsg{Op: "activated", Args: args, Inputs: inputs})
			})
			if err != nil {
				send(toastMsg{Op: "error", Error: "activator: " + err.Error()})
				continue
			}
			tt, err := d.open(m.AppID)
			if err != nil {
				rv()
				send(toastMsg{Op: "error", Error: "toasts: " + err.Error()})
				continue
			}
			t, revoke = tt, rv
			send(toastMsg{Op: "ready"})
		case "show":
			if t == nil {
				send(toastMsg{Op: "failed", ID: m.ID, Error: "not registered"})
				continue
			}
			if err := t.Show(m.XML, m.Tag, m.Group); err != nil {
				send(toastMsg{Op: "failed", ID: m.ID, Error: err.Error()})
				continue
			}
			send(toastMsg{Op: "shown", ID: m.ID})
		case "remove":
			if t != nil {
				t.Remove(m.Tag, m.Group) // best effort: it may be gone already
			}
			send(toastMsg{Op: "removed", Tag: m.Tag})
		default:
			send(toastMsg{Op: "error", Error: "unknown op"})
		}
	}
	return 0
}

// toastInbox is the file a click lands in while AIB is closed (one JSON line each; AIB reads and empties it).
func toastInbox(data string) string { return filepath.Join(data, "toast-inbox.jsonl") }

type inboxLine struct {
	Args   string            `json:"args"`
	Inputs map[string]string `json:"inputs,omitempty"`
	At     int64             `json:"at"`
}

// embedToast is the -Embedding run: take the clicks Windows hands over, write them for AIB, start AIB, exit.
func embedToast(d toastDeps, o toastOpts, wait, settle time.Duration) int {
	clicks := make(chan inboxLine, 8)
	revoke, err := d.activator(o.clsid, func(args string, inputs map[string]string) {
		select {
		case clicks <- inboxLine{Args: args, Inputs: inputs, At: d.now().UnixMilli()}:
		default:
		}
	})
	if err != nil {
		return 1
	}
	defer revoke()
	deadline := time.After(wait)
	got := 0
	for {
		var timer <-chan time.Time
		if got > 0 {
			timer = time.After(settle)
		}
		select {
		case c := <-clicks:
			if err := appendInbox(o.data, c); err == nil {
				got++
				if got == 1 && o.launch != "" {
					d.launch(o.launch)
				}
			}
		case <-timer:
			return 0
		case <-deadline:
			if got == 0 {
				return 1
			}
			return 0
		}
	}
}

func appendInbox(data string, c inboxLine) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(toastInbox(data), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func launchDetached(program string) error {
	cmd := exec.Command(program)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
