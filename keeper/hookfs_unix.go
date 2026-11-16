//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"syscall"
)

// isReparsePoint: a symlink (or anything else that is not a plain directory entry).
func isReparsePoint(fi os.FileInfo) bool { return fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 }

// pidAlive: the process runs (one we may not signal counts as running).
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
