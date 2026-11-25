//go:build darwin

package main

import (
	"errors"
	"net"

	"golang.org/x/sys/unix"
)

// macOS: the peer's user id from LOCAL_PEERCRED (what getpeereid(3) reads), checked at accept time (peer.go). The Linux channel mark
// (RLIMIT_MSGQUEUE) has no macOS counterpart, so a process of the same user still passes: the token in keeper.json guards that.
func markUnderKeeper(pid int) {}

func peerUID(nc net.Conn) (uint32, bool, error) {
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return 0, false, nil
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, true, err
	}
	var cred *unix.Xucred
	var credErr error
	if err := raw.Control(func(fd uintptr) { cred, credErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED) }); err != nil {
		return 0, true, err
	}
	if credErr != nil {
		return 0, true, credErr
	}
	if cred == nil {
		return 0, true, errors.New("no credentials")
	}
	return cred.Uid, true, nil
}

// peerRefusal: why this connection may not say hello ("" = it may). Same user only.
func (k *keeper) peerRefusal(nc net.Conn) string { return connRefusal(nc) }
