//go:build !windows

package main

import "golang.org/x/sys/unix"

func termSize() (int, int) {
	ws, err := unix.IoctlGetWinsize(0, unix.TIOCGWINSZ)
	if err != nil {
		return 0, 0
	}
	return int(ws.Col), int(ws.Row)
}
