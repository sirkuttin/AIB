package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// No real toast and no registry write here: every OS call is a fake (the registry itself: wintoast/registry_windows_test.go).

type fakeToaster struct {
	mu      sync.Mutex
	shown   []string
	removed []string
	fail    error
	closed  bool
}

func (f *fakeToaster) Show(xml, tag, group string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return f.fail
	}
	f.shown = append(f.shown, tag+"|"+group+"|"+xml)
	return nil
}
func (f *fakeToaster) Remove(tag, group string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, tag+"|"+group)
	return nil
}
func (f *fakeToaster) Close() { f.closed = true }

type fakeOS struct {
	t        *fakeToaster
	apps     []toastApp
	click    func(string, map[string]string)
	revoked  bool
	launched []string
	regErr   error
}

func (f *fakeOS) deps() toastDeps {
	return toastDeps{
		exe: `C:\Program Files\AIB\AIB-keeper.exe`,
		register: func(a toastApp) error {
			if f.regErr != nil {
				return f.regErr
			}
			f.apps = append(f.apps, a)
			return nil
		},
		open: func(string) (toaster, error) { return f.t, nil },
		activator: func(clsid string, fn func(string, map[string]string)) (func(), error) {
			f.click = fn
			return func() { f.revoked = true }, nil
		},
		launch: func(p string) error { f.launched = append(f.launched, p); return nil },
		now:    time.Now,
	}
}

type pipeHelper struct {
	in  *io.PipeWriter
	out *bufio.Scanner
	ret chan int
}

func startHelper(t *testing.T, f *fakeOS) *pipeHelper {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h := &pipeHelper{in: inW, out: bufio.NewScanner(outR), ret: make(chan int, 1)}
	go func() { h.ret <- serveToast(inR, outW, f.deps()); outW.Close() }()
	return h
}

func (h *pipeHelper) send(t *testing.T, m map[string]any) {
	b, _ := json.Marshal(m)
	if _, err := h.in.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
}

func (h *pipeHelper) next(t *testing.T) toastMsg {
	if !h.out.Scan() {
		t.Fatal("helper closed its output")
	}
	var m toastMsg
	if err := json.Unmarshal(h.out.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

var reg = map[string]any{"op": "register", "appId": "AIB.Test.x", "name": "AIB", "icon": `C:\d\toast-icon.png`,
	"clsid": "{11111111-2222-3333-4444-555555555555}", "data": `C:\Users\me\App Data\AIB`, "launch": `C:\Program Files\AIB\AIB.exe`}

func TestToastServeRegisterShowRemoveClick(t *testing.T) {
	f := &fakeOS{t: &fakeToaster{}}
	h := startHelper(t, f)
	h.send(t, map[string]any{"op": "show", "id": "1", "tag": "c", "xml": "<toast/>"})
	if m := h.next(t); m.Op != "failed" || m.ID != "1" {
		t.Fatalf("show before register: %+v", m)
	}
	h.send(t, reg)
	if m := h.next(t); m.Op != "ready" {
		t.Fatalf("register: %+v", m)
	}
	if len(f.apps) != 1 {
		t.Fatal("registry not written")
	}
	a := f.apps[0]
	want := `"C:\Program Files\AIB\AIB-keeper.exe" toast --app-id AIB.Test.x --clsid {11111111-2222-3333-4444-555555555555} --data "C:\Users\me\App Data\AIB" --launch "C:\Program Files\AIB\AIB.exe"`
	if a.Command != want || a.AppID != "AIB.Test.x" || a.DisplayName != "AIB" || a.IconPath != `C:\d\toast-icon.png` {
		t.Fatalf("app: %+v", a)
	}
	// the command line Windows runs (plus -Embedding) parses back to the same options
	o, err := parseToastArgs([]string{"--app-id", "AIB.Test.x", "--clsid", "{11111111-2222-3333-4444-555555555555}", "--data", `C:\Users\me\App Data\AIB`, "--launch", `C:\Program Files\AIB\AIB.exe`, "-Embedding"})
	if err != nil || !o.embedding || o.data != `C:\Users\me\App Data\AIB` || o.appID != "AIB.Test.x" {
		t.Fatalf("parse: %+v %v", o, err)
	}
	h.send(t, map[string]any{"op": "show", "id": "2", "tag": "claude:abc", "group": "aib", "xml": "<toast>x</toast>"})
	if m := h.next(t); m.Op != "shown" || m.ID != "2" {
		t.Fatalf("show: %+v", m)
	}
	if f.t.shown[0] != "claude:abc|aib|<toast>x</toast>" {
		t.Fatalf("shown: %v", f.t.shown)
	}
	go f.click("act=allow&chat=claude:abc&n=abcd", map[string]string{"reply": "hi"})
	if m := h.next(t); m.Op != "activated" || m.Args != "act=allow&chat=claude:abc&n=abcd" || m.Inputs["reply"] != "hi" {
		t.Fatalf("activated: %+v", m)
	}
	h.send(t, map[string]any{"op": "remove", "tag": "claude:abc", "group": "aib"})
	if m := h.next(t); m.Op != "removed" || m.Tag != "claude:abc" {
		t.Fatalf("remove: %+v", m)
	}
	f.t.fail = errors.New("HRESULT 0x80070490")
	h.send(t, map[string]any{"op": "show", "id": "3", "tag": "c", "xml": "<toast/>"})
	if m := h.next(t); m.Op != "failed" || !strings.Contains(m.Error, "0x80070490") {
		t.Fatalf("failed show: %+v", m)
	}
	h.in.Close()
	if code := <-h.ret; code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !f.revoked || !f.t.closed {
		t.Fatal("stdin closed: the class object is revoked and the toaster closed")
	}
}

func TestToastServeRegistryErrorAndBadInput(t *testing.T) {
	f := &fakeOS{t: &fakeToaster{}, regErr: errors.New("access denied")}
	h := startHelper(t, f)
	h.send(t, map[string]any{"op": "register", "appId": "A"})
	if m := h.next(t); m.Op != "error" {
		t.Fatalf("incomplete register: %+v", m)
	}
	h.send(t, reg)
	if m := h.next(t); m.Op != "error" || !strings.Contains(m.Error, "registry") {
		t.Fatalf("registry error: %+v", m)
	}
	h.in.Write([]byte("not json\n"))
	if m := h.next(t); m.Op != "error" {
		t.Fatalf("bad line: %+v", m)
	}
	h.in.Close()
	<-h.ret
}

func TestToastArgs(t *testing.T) {
	if _, err := parseToastArgs([]string{"-Embedding"}); err == nil {
		t.Fatal("-Embedding without --clsid/--data must fail")
	}
	o, err := parseToastArgs([]string{"--clsid", "{x}", "--data", "d", "/Embedding"})
	if err != nil || !o.embedding {
		t.Fatalf("/Embedding: %+v %v", o, err)
	}
	o, err = parseToastArgs(nil)
	if err != nil || o.embedding {
		t.Fatalf("plain: %+v %v", o, err)
	}
	if _, err := parseToastArgs([]string{"--nope"}); err == nil {
		t.Fatal("unknown flag accepted")
	}
}

func TestToastEmbeddingWritesInboxAndStartsAIB(t *testing.T) {
	dir := t.TempDir()
	f := &fakeOS{}
	o := toastOpts{clsid: "{c}", data: dir, launch: `C:\AIB\AIB.exe`, embedding: true}
	done := make(chan int, 1)
	d := f.deps()
	ready := make(chan struct{})
	act := d.activator
	d.activator = func(c string, fn func(string, map[string]string)) (func(), error) {
		r, err := act(c, fn)
		close(ready)
		return r, err
	}
	go func() { done <- embedToast(d, o, 5*time.Second, 200*time.Millisecond) }()
	<-ready
	f.click("act=allow&chat=claude:abc&n=1", nil)
	f.click("act=reply&chat=claude:def&n=2", map[string]string{"reply": "yes"})
	if code := <-done; code != 0 {
		t.Fatalf("exit %d", code)
	}
	b, err := os.ReadFile(filepath.Join(dir, "toast-inbox.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"args":"act=allow\u0026chat=claude:abc\u0026n=1"`) || !strings.Contains(lines[1], `"reply":"yes"`) {
		t.Fatalf("inbox: %s", b)
	}
	if len(f.launched) != 1 || f.launched[0] != `C:\AIB\AIB.exe` || !f.revoked {
		t.Fatalf("launched %v revoked %v", f.launched, f.revoked)
	}
}

func TestToastEmbeddingNoClick(t *testing.T) {
	f := &fakeOS{}
	if code := embedToast(f.deps(), toastOpts{clsid: "{c}", data: t.TempDir()}, 100*time.Millisecond, 50*time.Millisecond); code != 1 {
		t.Fatalf("no click: exit %d", code)
	}
	if len(f.launched) != 0 {
		t.Fatal("nothing to start without a click")
	}
}
