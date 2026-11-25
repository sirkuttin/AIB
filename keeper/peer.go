package main

import (
	"net"
	"os"
)

// The same-user peer check, shared by every platform that has one (Linux: SO_PEERCRED, macOS: LOCAL_PEERCRED). It runs when the
// connection is accepted, before a single byte of any request is read: a process of another user gets the socket closed on it.
// The socket file is 0600 and its folder 0700, so another user cannot normally reach it; this is the second lock, in case a folder
// is made readable or the socket is handed on.

// peerUIDRefusal: why a peer with this uid may not connect to a keeper run by `own` ("" = it may). A uid that could not be read is
// refused: a connection that cannot be identified is not trusted.
func peerUIDRefusal(uid uint32, uidErr error, own uint32) string {
	if uidErr != nil {
		return "the peer of the connection cannot be read"
	}
	if uid != own {
		return "another user"
	}
	return ""
}

// connRefusal: why this freshly accepted connection is closed unread ("" = serve it). Only unix sockets are checked (the TCP
// fallback is loopback, and Windows seals the token instead).
func connRefusal(nc net.Conn) string {
	if _, ok := nc.(*net.UnixConn); !ok {
		return ""
	}
	uid, checked, err := peerUID(nc)
	if !checked {
		return ""
	}
	return peerUIDRefusal(uid, err, uint32(os.Getuid()))
}
