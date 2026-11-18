//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detachProcess: a new session, so the process leaves its parent's process group and is reparented when the parent exits.
func detachProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
