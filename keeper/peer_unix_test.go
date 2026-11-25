//go:build linux || darwin

package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A real unix socket: the process that connects is this one, so the OS's own credential read (SO_PEERCRED / LOCAL_PEERCRED)
// must say "same user" and the accept-time check must let it through; and the uid it reads is this process's.
func TestConnRefusalSameUserOverRealSocket(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "p.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Skip("no unix socket here:", err)
	}
	defer l.Close()
	type result struct {
		nc  net.Conn
		err error
	}
	got := make(chan result, 1)
	go func() {
		nc, err := l.Accept()
		got <- result{nc, err}
	}()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	r := <-got
	if r.err != nil {
		t.Fatal(r.err)
	}
	defer r.nc.Close()
	uid, checked, err := peerUID(r.nc)
	if !checked || err != nil {
		t.Fatalf("the peer uid was not read: checked=%v err=%v", checked, err)
	}
	if uid != uint32(os.Getuid()) {
		t.Fatalf("peer uid %d, want %d", uid, os.Getuid())
	}
	if why := connRefusal(r.nc); why != "" {
		t.Fatalf("a same-user connection was refused: %s", why)
	}
}

// Another user (needs root and setpriv; skipped otherwise): the socket is opened to everyone, a process of uid 65534 connects and
// sends a hello, and the keeper side closes it at accept time, so the request is never read.
func TestConnRefusalOtherUserNeverReadsARequest(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("needs root to run a process as another user")
	}
	setpriv, err := exec.LookPath("setpriv")
	if err != nil {
		t.Skip("no setpriv")
	}
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3")
	}
	dir := t.TempDir()
	for d := dir; d != "/" && d != "/tmp"; d = filepath.Dir(d) {
		os.Chmod(d, 0o755)
	}
	sock := filepath.Join(dir, "o.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	os.Chmod(sock, 0o666)
	read := make(chan int, 1)
	refusal := make(chan string, 1)
	go func() {
		nc, err := l.Accept()
		if err != nil {
			return
		}
		defer nc.Close()
		why := connRefusal(nc)
		refusal <- why
		if why != "" {
			return // what main.go's accept loop does: close it unread
		}
		buf := make([]byte, 64)
		n, _ := nc.Read(buf)
		read <- n
	}()
	script := "import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])\ns.sendall(b'{\"op\":\"hello\"}')\ns.settimeout(5)\ntry:\n  print(len(s.recv(10)))\nexcept Exception:\n  print('closed')\n"
	out, err := exec.Command(setpriv, "--reuid=65534", "--regid=65534", "--clear-groups", py, "-c", script, sock).CombinedOutput()
	if err != nil {
		t.Fatalf("the other-user client failed: %v: %s", err, out)
	}
	if why := <-refusal; why != "another user" {
		t.Fatalf("refusal %q, want %q", why, "another user")
	}
	select {
	case n := <-read:
		t.Fatalf("the keeper side read %d bytes of a request from another user", n)
	default:
	}
}

// Over TCP there is no peer check at accept time.
func TestConnRefusalIgnoresTCP(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	defer l.Close()
	done := make(chan net.Conn, 1)
	go func() { nc, _ := l.Accept(); done <- nc }()
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	nc := <-done
	defer nc.Close()
	if why := connRefusal(nc); why != "" {
		t.Fatal(why)
	}
}
