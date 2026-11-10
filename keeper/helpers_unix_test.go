//go:build linux || darwin

package main

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

func hideWindow(*exec.Cmd) {}

func processAlive(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return false
	}
	// A zombie is dead for our purposes.
	if b, err := os.ReadFile("/proc/" + itoa(pid) + "/stat"); err == nil {
		f := strings.Fields(string(b))
		return len(f) < 3 || f[2] != "Z"
	}
	return true
}

func itoa(n int) string {
	b := []byte{}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
