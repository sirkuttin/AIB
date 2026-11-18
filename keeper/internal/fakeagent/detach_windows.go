//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// detachProcess: a process of its own (no shared console group).
func detachProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x08000000} // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
}
