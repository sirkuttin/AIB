package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func frame(t testing.TB, h map[string]any, body []byte) []byte {
	f, err := encodeFrame(h, body)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// The decoder never panics, never allocates past the limits, and round-trips what it accepts.
func FuzzReadFrame(f *testing.F) {
	f.Add(frame(f, map[string]any{"op": "hello", "token": "x"}, nil))
	f.Add(frame(f, map[string]any{"op": "write", "channel": "a", "epoch": 1}, []byte("data")))
	f.Add([]byte("GET / HTTP/1.1\r\n\r\n"))
	f.Add([]byte{0xff, 0xff, 0xff, 0xff})
	f.Add([]byte{1, 0, 0, 0, '{', 0xff, 0xff, 0xff, 0x7f})
	f.Fuzz(func(t *testing.T, in []byte) {
		r := bytes.NewReader(in)
		for {
			h, b, err := readFrame(r)
			if err != nil {
				return
			}
			if len(h) == 0 || len(h) > maxHeader || len(b) > maxBody {
				t.Fatalf("limits not enforced: %d %d", len(h), len(b))
			}
			var buf bytes.Buffer
			binary.Write(&buf, binary.LittleEndian, uint32(len(h)))
			buf.Write(h)
			binary.Write(&buf, binary.LittleEndian, uint32(len(b)))
			buf.Write(b)
			h2, b2, err := readFrame(&buf)
			if err != nil || !bytes.Equal(h, h2) || !bytes.Equal(b, b2) {
				t.Fatal("round trip")
			}
		}
	})
}

// The journal record decoder never panics on garbage.
func FuzzDecodeRecord(f *testing.F) {
	f.Add(encodeRecord(nil, &record{Kind: kindOut, Seq: 1, Time: 5, Data: []byte("hi")}))
	f.Add([]byte{0xff, 0xff, 0xff, 0xff, 1})
	f.Fuzz(func(t *testing.T, in []byte) {
		br := bufio.NewReader(bytes.NewReader(in))
		for {
			if _, _, err := decodeRecord(br, false); err != nil {
				return
			}
		}
	})
}

var fuzzKeeper *keeper

// A whole connection of arbitrary bytes after a valid hello: the keeper answers or closes, never panics or hangs.
// Spawning is off in this keeper, so no input can start a program.
func FuzzServe(f *testing.F) {
	if fuzzKeeper == nil {
		k, err := newKeeper(options{data: f.TempDir(), noSpawn: true, exitAfter: time.Hour, orphanAfter: time.Hour})
		if err != nil {
			f.Fatal(err)
		}
		fuzzKeeper = k
		f.Cleanup(func() { k.stop("test"); fuzzKeeper = nil })
		// A real channel to aim ops at, with an ended process and a journal.
		j, _ := openJournal(k.dir+"/channels/c", 4096, 1<<20)
		j.append(kindOut, []byte("out"))
		k.channels["c"] = &channel{k: k, id: "c", kind: "pipe", j: j, once: map[string]struct{}{}, epoch: 1}
	}
	k := fuzzKeeper
	seed := func(frames ...[]byte) []byte { return bytes.Join(frames, nil) }
	f.Add(seed(frame(f, map[string]any{"op": "list", "id": 1}, nil)))
	f.Add(seed(frame(f, map[string]any{"op": "attach", "id": 1, "channel": "c", "from": 0}, nil),
		frame(f, map[string]any{"op": "claim", "id": 2, "channel": "c"}, nil),
		frame(f, map[string]any{"op": "write", "id": 3, "channel": "c", "epoch": 2, "once": "k"}, []byte("x")),
		frame(f, map[string]any{"op": "note", "id": 4, "channel": "c", "epoch": 2}, []byte("{}")),
		frame(f, map[string]any{"op": "truncate", "id": 5, "channel": "c", "epoch": 2, "before": 1}, nil)))
	f.Add(seed(frame(f, map[string]any{"op": "spawn", "id": 1, "command": "x", "args": []string{"y"}, "pty": map[string]int{"cols": 1, "rows": 1}}, nil)))
	f.Add(seed(frame(f, map[string]any{"op": "resize", "id": 1, "channel": "c", "epoch": 1, "cols": -1}, nil),
		frame(f, map[string]any{"op": "zzz", "id": "s"}, nil)))
	f.Add([]byte{0, 0, 1, 0, 0})
	f.Fuzz(func(t *testing.T, in []byte) {
		server, cl := net.Pipe()
		done := make(chan struct{})
		go func() { k.serve(server); close(done) }()
		go io.Copy(io.Discard, cl)
		hello := frame(t, map[string]any{"op": "hello", "token": k.token, "min": 1, "max": 1}, nil)
		cl.SetWriteDeadline(time.Now().Add(2 * time.Second))
		cl.Write(hello)
		cl.Write(in)
		cl.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("serve did not return after the client closed")
		}
	})
}
