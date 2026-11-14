//go:build linux || darwin

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func hideWindow(*exec.Cmd) {}

func processAlive(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return false
	}
	// A zombie is dead for our purposes.
	if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
		f := strings.Fields(string(b))
		return len(f) < 3 || f[2] != "Z"
	}
	return true
}
