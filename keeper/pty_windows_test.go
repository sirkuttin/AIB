package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// AIB starts the keeper with CREATE_NEW_PROCESS_GROUP, which makes a process (and its children) ignore Ctrl+C. A terminal shell in
// the keeper must still stop a command on Ctrl+C.
func TestPtyCtrlCReachesShellInNewProcessGroup(t *testing.T) {
	data := t.TempDir()
	k := startKeeperWith(t, data, func(cmd *exec.Cmd) { cmd.SysProcAttr.CreationFlags |= 0x00000200 }) // CREATE_NEW_PROCESS_GROUP
	c := dial(t, k)
	cmd := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	c.must("spawn", map[string]any{"channel": "c", "command": cmd, "args": []string{"/Q"}, "pty": map[string]int{"cols": 100, "rows": 30}}, nil)
	c.must("attach", map[string]any{"channel": "c"}, nil)
	c.outputUntil("c", 10*time.Second, "out", ">")
	c.must("write", map[string]any{"channel": "c", "epoch": 1}, []byte("ping -n 60 127.0.0.1 >nul\r"))
	time.Sleep(700 * time.Millisecond)
	c.must("write", map[string]any{"channel": "c", "epoch": 1}, []byte("\x03"))
	c.must("write", map[string]any{"channel": "c", "epoch": 1}, []byte("echo back-at-prompt\r"))
	c.outputUntil("c", 8*time.Second, "out", "back-at-prompt\r\n") // without Ctrl+C the echo would wait a minute for ping
}
