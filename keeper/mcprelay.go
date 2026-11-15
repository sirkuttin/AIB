package main

// AIB-keeper mcp-relay --socket <path> (keeper 1.5.0, WSL): the listening end of the MCP tunnel, run by the WSL helper as its child.
//
// Agents in a WSL distro cannot reach AIB's tool endpoint on Windows 127.0.0.1, so their `mcp-forward --helper-socket <path>`
// forwarders post each message to this unix socket instead. The helper (a Deno program) cannot listen on a unix socket whose path
// is not fixed at build time, so this small relay listens for it and passes everything on over its own stdin and stdout, one JSON
// line each; the helper hands each request to AIB over the helper channel and writes the answer back:
//
//	stdout {"ready":true,"socket":"<path>"}       once, when the socket listens (0600, its folder 0700)
//	stdout {"c":N,"req":{...}}                     a forwarder's request line (connection N), passed on unchanged
//	stdout {"c":N,"gone":true}                     connection N closed before it got its answer
//	stdin  {"c":N,"res":{...}}                     the answer for connection N: written to it as one line, then it is closed
//
// The relay knows nothing of MCP or AIB. A request line that is not a JSON object, or longer than relayMaxLine, is answered here
// with an error status and never passed on. stdin's end (the helper exited) ends the relay: every connection is closed and the
// socket removed, unless another relay has replaced it in the meantime (a helper being swapped for a newer one).

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	relayMaxLine  = 16 << 20 // a publish carries a whole page as content
	relayMaxConns = 64
)

type relay struct {
	out   io.Writer
	outMu sync.Mutex
	mu    sync.Mutex
	conns map[int64]net.Conn
	next  int64
}

func mcpRelayMain(args []string) int {
	if len(args) != 2 || args[0] != "--socket" || args[1] == "" {
		fmt.Fprintln(os.Stderr, "usage: AIB-keeper mcp-relay --socket <unix socket path>")
		return 2
	}
	path := args[1]
	l, err := relayListen(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "AIB-keeper mcp-relay:", err)
		return 1
	}
	mine, _ := os.Lstat(path)
	r := &relay{out: os.Stdout, conns: map[int64]net.Conn{}}
	go r.serve(l)
	r.emit(map[string]any{"ready": true, "socket": path})
	r.answers(os.Stdin)
	l.Close()
	r.closeAll()
	if now, err := os.Lstat(path); err == nil && mine != nil && os.SameFile(mine, now) {
		os.Remove(path) // ours still: no newer relay took the path over
	}
	return 0
}

// relayListen listens on path: an absolute path under 100 bytes (the unix socket limit, with room), its folder made 0700, a stale
// socket there replaced (a relay that is still running keeps serving the connections it has; new ones come here).
func relayListen(path string) (net.Listener, error) {
	if !filepath.IsAbs(path) || len(path) >= maxUnixSocketLen {
		return nil, fmt.Errorf("the socket path must be absolute and shorter than %d bytes: %q", maxUnixSocketLen, path)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	os.Chmod(dir, 0o700)
	if st, err := os.Lstat(path); err == nil {
		if st.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s is there and is not a socket", path)
		}
		os.Remove(path)
	}
	l, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if ul, ok := l.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false) // removed by mcpRelayMain, and only while it is still ours
	}
	if err := os.Chmod(path, 0o600); err != nil {
		l.Close()
		return nil, err
	}
	return l, nil
}

func (r *relay) emit(v any) {
	line, _ := json.Marshal(v)
	r.outMu.Lock()
	defer r.outMu.Unlock()
	r.out.Write(append(line, '\n'))
}

func (r *relay) serve(l net.Listener) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		r.mu.Lock()
		if len(r.conns) >= relayMaxConns {
			r.mu.Unlock()
			replyAndClose(c, map[string]any{"status": 503, "error": "Too many AIB tool calls at once in this distro; try again in a moment."})
			continue
		}
		r.next++
		id := r.next
		r.conns[id] = c
		r.mu.Unlock()
		go r.take(id, c)
	}
}

// take reads connection id's one request line and passes it on, then watches for the connection closing before its answer.
func (r *relay) take(id int64, c net.Conn) {
	reader := bufio.NewReaderSize(c, 64<<10)
	c.SetReadDeadline(time.Now().Add(30 * time.Second)) // the forwarder writes its line at once
	line, err := readLine(reader)
	c.SetReadDeadline(time.Time{})
	var req map[string]any
	switch {
	case len(bytes.TrimSpace(line)) == 0:
		r.drop(id)
		return
	case err != nil && err != io.EOF:
		r.drop(id)
		return
	case len(line) > relayMaxLine:
		if r.forget(id) {
			replyAndClose(c, map[string]any{"status": 413, "error": fmt.Sprintf("The message is larger than the WSL tunnel takes (%d MB)", relayMaxLine>>20)})
		}
		return
	case json.Unmarshal(line, &req) != nil:
		if r.forget(id) {
			replyAndClose(c, map[string]any{"status": 400, "error": "The tunnel takes one JSON object per line"})
		}
		return
	}
	r.emit(map[string]any{"c": id, "req": json.RawMessage(line)})
	// Anything more from the forwarder, or its end, means it is gone (it waits for one answer line and writes nothing else).
	io.Copy(io.Discard, reader)
	if r.forget(id) {
		c.Close()
		r.emit(map[string]any{"c": id, "gone": true})
	}
}

// answers writes each answer line from in to its connection, until in ends.
func (r *relay) answers(in io.Reader) {
	reader := bufio.NewReaderSize(in, 64<<10)
	for {
		line, err := readLine(reader)
		if len(bytes.TrimSpace(line)) > 0 {
			var msg struct {
				C   int64           `json:"c"`
				Res json.RawMessage `json:"res"`
			}
			if json.Unmarshal(line, &msg) == nil && len(msg.Res) > 0 {
				r.mu.Lock()
				c := r.conns[msg.C]
				delete(r.conns, msg.C)
				r.mu.Unlock()
				if c != nil {
					c.SetWriteDeadline(time.Now().Add(30 * time.Second))
					c.Write(append(bytes.TrimRight(msg.Res, "\r\n"), '\n'))
					c.Close()
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// forget takes connection id out of the table; false when an answer already took it.
func (r *relay) forget(id int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.conns[id]; !ok {
		return false
	}
	delete(r.conns, id)
	return true
}

func (r *relay) drop(id int64) {
	r.mu.Lock()
	c := r.conns[id]
	delete(r.conns, id)
	r.mu.Unlock()
	if c != nil {
		c.Close()
	}
}

func (r *relay) closeAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, c := range r.conns {
		c.Close()
		delete(r.conns, id)
	}
}

func replyAndClose(c net.Conn, v any) {
	line, _ := json.Marshal(v)
	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	c.Write(append(line, '\n'))
	c.Close()
}
