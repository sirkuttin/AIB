//go:build linux || darwin

package main

// POSIX children. Each child leads its own process group (pipes: setpgid; ptys: setsid, with the pty as its controlling
// terminal), so kill = SIGKILL to the group. If the keeper dies, an agent gets EOF on stdin and exits (ACP adapters do), and
// on Linux the direct child also gets SIGKILL from the kernel (Pdeathsig).

import (
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

var useUnixSocket = true

type unixTree struct {
	cmd *exec.Cmd
	pid int
}

func (t *unixTree) Pid() int { return t.pid }

func (t *unixTree) Kill() error {
	err := syscall.Kill(-t.pid, syscall.SIGKILL)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

var signals = map[string]syscall.Signal{
	"interrupt": syscall.SIGINT, "terminate": syscall.SIGTERM, "hangup": syscall.SIGHUP, "kill": syscall.SIGKILL,
	"quit": syscall.SIGQUIT, "user1": syscall.SIGUSR1, "user2": syscall.SIGUSR2,
}

func (t *unixTree) Signal(name string) error {
	sig, ok := signals[name]
	if !ok {
		return os.ErrInvalid
	}
	err := syscall.Kill(-t.pid, sig)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

func (t *unixTree) waitExit() int {
	err := t.cmd.Wait()
	if t.cmd.ProcessState == nil {
		if err != nil {
			return -1
		}
		return 0
	}
	if ws, ok := t.cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return t.cmd.ProcessState.ExitCode()
}

func waitDone(done <-chan struct{}, d time.Duration) bool {
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

func readLoop(r *os.File, k kind, onData func(kind, []byte), done chan struct{}) {
	defer close(done)
	buf := make([]byte, 64<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			onData(k, buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// ---- pipes -------------------------------------------------------------------------------------------------------------

type pipeProc struct {
	unixTree
	stdin   *os.File
	inMu    sync.Mutex
	outDone chan struct{}
	errDone chan struct{}
}

func startPipe(spec spawnSpec, onData func(kind, []byte)) (process, error) {
	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = spec.Env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	setPdeathsig(cmd.SysProcAttr)
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return nil, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	err = cmd.Start()
	inR.Close()
	outW.Close()
	errW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}
	p := &pipeProc{unixTree: unixTree{cmd: cmd, pid: cmd.Process.Pid}, stdin: inW, outDone: make(chan struct{}), errDone: make(chan struct{})}
	go readLoop(outR, kindOut, onData, p.outDone)
	go readLoop(errR, kindErr, onData, p.errDone)
	go func() { <-p.outDone; outR.Close() }()
	go func() { <-p.errDone; errR.Close() }()
	return p, nil
}

func (p *pipeProc) Write(b []byte) error {
	p.inMu.Lock()
	defer p.inMu.Unlock()
	if p.stdin == nil {
		return os.ErrClosed
	}
	_, err := p.stdin.Write(b)
	return err
}

func (p *pipeProc) CloseStdin() error {
	p.inMu.Lock()
	defer p.inMu.Unlock()
	if p.stdin == nil {
		return nil
	}
	err := p.stdin.Close()
	p.stdin = nil
	return err
}

func (p *pipeProc) Resize(int, int) error { return errUnsupportedOp }

func (p *pipeProc) Wait() int {
	code := p.waitExit()
	both := func(d time.Duration) bool { return waitDone(p.outDone, d) && waitDone(p.errDone, d) }
	if !both(2 * time.Second) {
		p.Kill()
		both(2 * time.Second)
	}
	p.Kill() // whatever it left running in its group
	p.CloseStdin()
	return code
}

// ---- pty ---------------------------------------------------------------------------------------------------------------

type unixPty struct {
	unixTree
	master  *os.File
	inMu    sync.Mutex
	closed  bool
	outDone chan struct{}
}

func startPty(spec spawnSpec, onData func(kind, []byte)) (process, error) {
	master, slaveName, err := openPty()
	if err != nil {
		return nil, err
	}
	if err := unix.IoctlSetWinsize(int(master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(spec.Pty.Cols), Row: uint16(spec.Pty.Rows)}); err != nil {
		master.Close()
		return nil, err
	}
	slave, err := os.OpenFile(slaveName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		return nil, err
	}
	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = spec.Env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	err = cmd.Start()
	slave.Close()
	if err != nil {
		master.Close()
		return nil, err
	}
	p := &unixPty{unixTree: unixTree{cmd: cmd, pid: cmd.Process.Pid}, master: master, outDone: make(chan struct{})}
	go readLoop(master, kindOut, onData, p.outDone)
	return p, nil
}

func (p *unixPty) Write(b []byte) error {
	p.inMu.Lock()
	defer p.inMu.Unlock()
	if p.closed {
		return os.ErrClosed
	}
	_, err := p.master.Write(b)
	return err
}

func (p *unixPty) CloseStdin() error { return errUnsupportedOp }

func (p *unixPty) Resize(cols, rows int) error {
	p.inMu.Lock()
	defer p.inMu.Unlock()
	if p.closed {
		return os.ErrClosed
	}
	return unix.IoctlSetWinsize(int(p.master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
}

func (p *unixPty) Wait() int {
	code := p.waitExit()
	if !waitDone(p.outDone, 2*time.Second) {
		p.Kill() // a background job still holds the terminal
		waitDone(p.outDone, 2*time.Second)
	}
	p.Kill()
	p.inMu.Lock()
	p.closed = true
	p.master.Close()
	p.inMu.Unlock()
	return code
}

// ---- the orphan command, file lock, permissions ---------------------------------------------------------------------------

func startDetached(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd, cmd.Start()
}

type fileLock struct{ f *os.File }

func (l *fileLock) Close() error { return l.f.Close() }

func lockFile(path string) (*fileLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, errLocked
	}
	return &fileLock{f}, nil
}

func restrictDir(path string) error  { return os.Chmod(path, 0o700) }
func restrictFile(path string) error { return os.Chmod(path, 0o600) }

func openShared(path string) (*os.File, error) { return os.Open(path) }

// notifyStop: SIGTERM, SIGINT and SIGHUP stop the keeper cleanly (its channels are killed and recorded as "shutdown").
func notifyStop(k *keeper) {
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	signal.Ignore(syscall.SIGPIPE)
	go func() {
		<-c
		k.stop("shutdown")
	}()
}

// allowCtrlC: nothing to do on POSIX (a pty's foreground group gets SIGINT from the line discipline).
func allowCtrlC() {}
