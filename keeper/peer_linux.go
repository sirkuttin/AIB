//go:build linux

package main

import (
	"errors"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// The peer check (keeper 1.7.0). On Linux keeper.json holds the hello token in a 0600 file, which every process of this user can
// read, the agents the keeper runs included. So every process a channel starts carries a mark, and a hello over the unix socket from
// a marked process is refused (bad_peer).
//
// The mark: the channel's hard RLIMIT_MSGQUEUE (bytes of POSIX message queues) is set one below the keeper's own right after the
// spawn. Every child inherits its limits, through fork, exec, setsid, nohup or a double fork, and an unprivileged process can lower
// a hard limit but never raise it, so nothing an agent starts can take the mark off. One byte less of message queue changes nothing
// for any program. What still gets past: a process the user's service manager or an older process starts for the agent
// (systemd-run --user, cron, at, an already running tmux server), and the moment between the spawn and the mark (the agent's own
// start-up takes far longer than that before it runs anything).
const markResource = unix.RLIMIT_MSGQUEUE

// markUnderKeeper puts the mark on a channel's process (best effort: a process that is already gone needs none).
func markUnderKeeper(pid int) {
	if pid <= 0 {
		return
	}
	var own unix.Rlimit
	if err := unix.Getrlimit(markResource, &own); err != nil || own.Max == 0 {
		return
	}
	var lim unix.Rlimit
	if err := unix.Prlimit(pid, markResource, nil, &lim); err != nil {
		return
	}
	mark := own.Max - 1
	if own.Max == unix.RLIM_INFINITY {
		mark = 1 << 62
	}
	if lim.Max > mark {
		lim.Max = mark
	}
	if lim.Cur > lim.Max {
		lim.Cur = lim.Max
	}
	unix.Prlimit(pid, markResource, &lim, nil)
}

// marked: true when pid carries the mark (its hard limit is below the keeper's own).
func marked(pid int) bool {
	var own, lim unix.Rlimit
	if err := unix.Getrlimit(markResource, &own); err != nil {
		return false
	}
	if err := unix.Prlimit(pid, markResource, nil, &lim); err != nil {
		return true // a process of this user whose limits cannot be read: not trusted
	}
	return lim.Max < own.Max
}

// peerCred: the peer's credentials from SO_PEERCRED.
func peerCred(nc net.Conn) (*unix.Ucred, error) {
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return nil, nil
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return nil, err
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) { cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) }); err != nil {
		return nil, err
	}
	if credErr != nil {
		return nil, credErr
	}
	if cred == nil {
		return nil, errors.New("no credentials")
	}
	return cred, nil
}

// peerUID: the peer's user id (checked at accept time, peer.go).
func peerUID(nc net.Conn) (uint32, bool, error) {
	if _, ok := nc.(*net.UnixConn); !ok {
		return 0, false, nil
	}
	cred, err := peerCred(nc)
	if err != nil {
		return 0, true, err
	}
	return cred.Uid, true, nil
}

// peerRefusal: why this connection may not say hello ("" = it may).
func (k *keeper) peerRefusal(nc net.Conn) string {
	if _, ok := nc.(*net.UnixConn); !ok {
		return ""
	}
	cred, err := peerCred(nc)
	if err != nil {
		return "the peer of the connection cannot be read"
	}
	if why := peerUIDRefusal(cred.Uid, nil, uint32(os.Getuid())); why != "" {
		return why
	}
	if marked(int(cred.Pid)) {
		return "the process runs under one of the keeper's channels"
	}
	return ""
}
