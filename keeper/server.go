package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	helloTimeout = 10 * time.Second
	writeTimeout = 30 * time.Second
)

// conn is one client connection.
type conn struct {
	k      *keeper
	nc     net.Conn
	wmu    sync.Mutex
	authed bool
	client string

	smu  sync.Mutex
	subs map[string]*sub

	closeOnce sync.Once
	done      chan struct{}
}

// sub follows one channel for one connection: records from a seq on, then live.
type sub struct {
	ch     *channel
	cursor uint64
	stop   chan struct{}
}

func (c *conn) send(header map[string]any, body []byte) error {
	frame, err := encodeFrame(header, body)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.nc.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := c.nc.Write(frame); err != nil {
		c.close() // a client that does not read for 30 s is dropped; it can attach again from any seq
		return err
	}
	return nil
}

func (c *conn) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		c.nc.Close()
		c.smu.Lock()
		for id, s := range c.subs {
			close(s.stop)
			delete(c.subs, id)
		}
		c.smu.Unlock()
		c.k.dropConn(c)
	})
}

func reply(req *request, fields map[string]any) map[string]any {
	h := map[string]any{"ok": true}
	if len(req.ID) > 0 {
		h["re"] = req.ID
	}
	for k, v := range fields {
		h[k] = v
	}
	return h
}

func fail(req *request, code, message string, fields map[string]any) map[string]any {
	h := map[string]any{"ok": false, "error": code}
	if message != "" {
		h["message"] = message
	}
	if req != nil && len(req.ID) > 0 {
		h["re"] = req.ID
	}
	for k, v := range fields {
		h[k] = v
	}
	return h
}

// serve runs one connection until it closes. The first frame must be hello with the token, within helloTimeout.
func (k *keeper) serve(nc net.Conn) {
	c := &conn{k: k, nc: nc, subs: map[string]*sub{}, done: make(chan struct{})}
	defer c.close()
	nc.SetReadDeadline(time.Now().Add(helloTimeout))
	for {
		hb, body, err := readFrame(nc)
		if err != nil {
			if errors.Is(err, errFrame) {
				c.send(fail(nil, errBadRequest, err.Error(), nil), nil)
			}
			return
		}
		var req request
		if err := json.Unmarshal(hb, &req); err != nil || len(req.ID) > 256 {
			c.send(fail(nil, errBadRequest, "header is not a valid JSON object", nil), nil)
			return
		}
		if !c.authed {
			if req.Op != "hello" {
				c.send(fail(&req, errNotAuth, "hello first", nil), nil)
				return
			}
			if !c.hello(&req) {
				return
			}
			nc.SetReadDeadline(time.Time{})
			continue
		}
		c.dispatch(&req, body)
	}
}

func (c *conn) hello(req *request) bool {
	if subtle.ConstantTimeCompare([]byte(req.Token), []byte(c.k.token)) != 1 {
		time.Sleep(200 * time.Millisecond)
		c.send(fail(req, errBadToken, "", nil), nil)
		return false
	}
	max := req.Max
	if max == 0 {
		max = req.Min
	}
	if req.Min > protocolVersion || (max != 0 && max < protocolVersion) {
		c.send(fail(req, errUnsupportedVer, "", map[string]any{"protocol": protocolVersion}), nil)
		return false
	}
	c.authed = true
	if len(req.Client) > 200 {
		req.Client = req.Client[:200]
	}
	c.client = req.Client
	if !c.k.addConn(c) {
		c.send(fail(req, errShuttingDown, "", nil), nil)
		return false
	}
	c.send(reply(req, map[string]any{"protocol": protocolVersion, "keeper": keeperVersion, "features": features, "pid": c.k.pid}), nil)
	return true
}

func (c *conn) dispatch(req *request, body []byte) {
	k := c.k
	switch req.Op {
	case "hello":
		c.send(fail(req, errBadRequest, "already authenticated", nil), nil)
	case "list":
		list := []channelInfo{}
		for _, ch := range k.channelList() {
			list = append(list, ch.info(c))
		}
		c.send(reply(req, map[string]any{"channels": list}), nil)
	case "status":
		c.send(reply(req, k.status()), nil)
	case "spawn":
		c.spawn(req)
	case "attach":
		c.attach(req)
	case "detach":
		c.smu.Lock()
		if s, ok := c.subs[req.Channel]; ok {
			close(s.stop)
			delete(c.subs, req.Channel)
		}
		c.smu.Unlock()
		c.send(reply(req, nil), nil)
	case "claim":
		ch := k.channel(req.Channel)
		if ch == nil {
			c.send(fail(req, errNoChannel, "", nil), nil)
			return
		}
		epoch, prev := ch.claim(c)
		if prev != nil {
			prev.send(map[string]any{"ev": "fenced", "channel": ch.id, "epoch": epoch}, nil)
		}
		c.send(reply(req, map[string]any{"epoch": epoch}), nil)
	case "write", "note", "closeStdin", "resize", "signal", "kill", "truncate":
		c.channelOp(req, body)
	case "setOrphanCommand":
		if req.Orphan != nil && req.Orphan.Command == "" {
			c.send(fail(req, errBadRequest, "orphan.command is empty", nil), nil)
			return
		}
		k.setOrphan(req.Orphan)
		c.send(reply(req, nil), nil)
	case "shutdown":
		if k.liveCount() > 0 && !req.Force {
			c.send(fail(req, errBusy, "channels are live; use force", map[string]any{"live": k.liveCount()}), nil)
			return
		}
		c.send(reply(req, nil), nil)
		go k.stop("shutdown")
	default:
		c.send(fail(req, errUnknownOp, req.Op, nil), nil)
	}
}

func (c *conn) channelOp(req *request, body []byte) {
	ch := c.k.channel(req.Channel)
	if ch == nil {
		c.send(fail(req, errNoChannel, "", nil), nil)
		return
	}
	var seq uint64
	var code string
	extra := map[string]any{}
	switch req.Op {
	case "write":
		seq, code = ch.write(c, req.Epoch, req.Once, body)
	case "note":
		seq, code = ch.note(c, req.Epoch, req.Once, body)
	case "closeStdin":
		code = ch.closeStdin(c, req.Epoch)
	case "resize":
		seq, code = ch.resize(c, req.Epoch, req.Once, req.Cols, req.Rows)
	case "signal":
		code = ch.signal(c, req.Epoch, req.Signal)
	case "kill":
		ch.mu.Lock()
		ok := ch.checkOwnerLocked(c, req.Epoch)
		ch.mu.Unlock()
		if !ok {
			code = errFenced
		} else {
			ch.kill("killed")
		}
	case "truncate":
		ch.mu.Lock()
		ok := ch.checkOwnerLocked(c, req.Epoch)
		live := ch.live
		ch.mu.Unlock()
		if !ok {
			code = errFenced
			break
		}
		_, last := ch.j.bounds()
		if !live && req.Before > last {
			c.k.removeChannel(ch)
			extra["removed"] = true
			break
		}
		extra["first"] = ch.j.truncate(req.Before)
	}
	if code != "" {
		f := map[string]any{}
		if code == errFenced {
			ch.mu.Lock()
			f["epoch"] = ch.epoch
			ch.mu.Unlock()
		}
		c.send(fail(req, code, "", f), nil)
		return
	}
	if seq != 0 {
		extra["seq"] = seq
	}
	c.send(reply(req, extra), nil)
}

func (c *conn) spawn(req *request) {
	k := c.k
	id := req.Channel
	if id == "" {
		var b [8]byte
		rand.Read(b[:])
		id = "ch-" + hex.EncodeToString(b[:])
	}
	if !validChannelID(id) {
		c.send(fail(req, errBadRequest, "channel ids are 1-64 of [A-Za-z0-9._-]", nil), nil)
		return
	}
	kindName := "pipe"
	if req.Pty != nil {
		kindName = "pty"
	}
	spec := spawnSpec{Command: req.Command, Args: req.Args, Cwd: req.Cwd, Env: envList(req.Env), CmdLine: req.WindowsCommandLine, Pty: req.Pty}
	if err := validSpec(&spec); err != nil {
		c.send(fail(req, errBadRequest, err.Error(), nil), nil)
		return
	}
	if len(req.Label) > maxLabel || strings.ContainsRune(req.Label, 0) {
		c.send(fail(req, errBadRequest, "label is longer than 16 KiB or contains NUL", nil), nil)
		return
	}
	segBytes, maxBytes := k.opts.segBytes, k.opts.maxChannelBytes
	if req.Scrollback != 0 {
		// A bounded journal (terminals): at least the newest `scrollback` bytes of records are kept, at most about a quarter more,
		// in segments of a quarter of it. The client chose the bound at spawn; the keeper only applies it.
		if req.Scrollback < minScrollback || req.Scrollback > maxScrollback {
			c.send(fail(req, errBadRequest, "scrollback must be 64 KiB..256 MiB", nil), nil)
			return
		}
		segBytes = req.Scrollback / 4
		maxBytes = req.Scrollback + segBytes
	}
	if k.opts.noSpawn {
		c.send(fail(req, errSpawnFailed, "spawning is off", nil), nil)
		return
	}
	k.spawnMu.Lock()
	defer k.spawnMu.Unlock()
	if existing := k.channel(id); existing != nil {
		c.send(fail(req, errExists, "", map[string]any{"info": existing.info(c)}), nil)
		return
	}
	if k.isStopping() {
		c.send(fail(req, errShuttingDown, "", nil), nil)
		return
	}
	j, err := openJournal(filepath.Join(k.dir, "channels", id), segBytes, maxBytes)
	if err != nil {
		c.send(fail(req, errFailed, err.Error(), nil), nil)
		return
	}
	ch := &channel{k: k, id: id, kind: kindName, command: req.Command, args: req.Args, cwd: req.Cwd, label: req.Label,
		created: time.Now().UnixMilli(), j: j, once: map[string]struct{}{}, epoch: 1, owner: c}
	if err := ch.start(spec); err != nil {
		j.remove()
		c.send(fail(req, errSpawnFailed, err.Error(), nil), nil)
		return
	}
	k.addChannel(ch)
	c.send(reply(req, map[string]any{"channel": id, "pid": ch.pid, "epoch": uint64(1), "kind": kindName}), nil)
}

func (c *conn) attach(req *request) {
	ch := c.k.channel(req.Channel)
	if ch == nil {
		c.send(fail(req, errNoChannel, "", nil), nil)
		return
	}
	first, last := ch.j.bounds()
	from := req.From
	if from == 0 {
		from = 1
	}
	s := &sub{ch: ch, cursor: from, stop: make(chan struct{})}
	c.smu.Lock()
	if old, ok := c.subs[ch.id]; ok {
		close(old.stop)
	}
	c.subs[ch.id] = s
	c.smu.Unlock()
	c.send(reply(req, map[string]any{"channel": ch.id, "first": first, "last": last, "live": ch.isLive()}), nil)
	go c.pump(s)
}

// pump sends a channel's records from the cursor on, then follows it live. A slow client only slows its own pump.
func (c *conn) pump(s *sub) {
	var pos readPos
	live := false
	for {
		select {
		case <-s.stop:
			return
		case <-c.done:
			return
		default:
		}
		wait := s.ch.j.wait()
		first, _ := s.ch.j.bounds()
		if s.cursor < first {
			c.send(map[string]any{"ev": "gap", "channel": s.ch.id, "from": s.cursor, "next": first}, nil)
			s.cursor = first
		}
		recs, err := s.ch.j.readFrom(s.cursor, readMax, &pos)
		if err != nil && len(recs) == 0 {
			if c.k.channel(s.ch.id) == nil {
				c.send(map[string]any{"ev": "removed", "channel": s.ch.id}, nil)
				return
			}
			time.Sleep(50 * time.Millisecond) // a segment went away under us; read again from the new first seq
			continue
		}
		for i := range recs {
			r := &recs[i]
			if c.send(map[string]any{"ev": "record", "channel": s.ch.id, "seq": r.Seq, "kind": r.Kind.String(), "time": r.Time}, r.Data) != nil {
				return
			}
			s.cursor = r.Seq + 1
		}
		if len(recs) > 0 {
			continue
		}
		if !live {
			live = true
			c.send(map[string]any{"ev": "live", "channel": s.ch.id, "seq": s.cursor - 1}, nil)
		}
		select {
		case <-wait:
		case <-s.stop:
			return
		case <-c.done:
			return
		}
		if c.k.channel(s.ch.id) == nil {
			c.send(map[string]any{"ev": "removed", "channel": s.ch.id}, nil)
			return
		}
	}
}
