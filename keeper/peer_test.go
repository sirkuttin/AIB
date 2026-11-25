package main

import (
	"errors"
	"testing"
)

// The decision, with injected credentials (macOS cannot run here: this is the logic its LOCAL_PEERCRED read feeds).
func TestPeerUIDRefusal(t *testing.T) {
	cases := []struct {
		name string
		uid  uint32
		err  error
		own  uint32
		want string
	}{
		{"same user", 501, nil, 501, ""},
		{"root is another user", 0, nil, 501, "another user"},
		{"other user", 502, nil, 501, "another user"},
		{"unreadable peer", 501, errors.New("EINVAL"), 501, "the peer of the connection cannot be read"},
		{"unreadable peer is refused even when the uid looks right", 0, errors.New("x"), 0, "the peer of the connection cannot be read"},
	}
	for _, c := range cases {
		if got := peerUIDRefusal(c.uid, c.err, c.own); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
