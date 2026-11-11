package main

// Windows children. Every child is created suspended with CREATE_NO_WINDOW (pipes) or on a pseudo console (ptys), put in
// its own Job Object with KILL_ON_JOB_CLOSE, then resumed. So:
//   - no child, and nothing a child starts on its console, ever shows a window (CREATE_NO_WINDOW gives the child a console
//     without one, which its own console children inherit; a ConPTY console is headless);
//   - kill = TerminateJobObject: the whole tree, also after the main process exited;
//   - if the keeper dies, Windows closes its job handles and every child dies with it (no orphans).

import (
	"errors"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	createSuspended        = 0x00000004
	createNoWindow         = 0x08000000
	detachedProcess        = 0x00000008
	createNewProcessGroup  = 0x00000200
	createBreakawayFromJob = 0x01000000
	createUnicodeEnv       = 0x00000400
	startfUseStdHandles    = 0x00000100
)

var useUnixSocket = false

var (
	ntdll                         = windows.NewLazySystemDLL("ntdll.dll")
	procNtResumeProcess           = ntdll.NewProc("NtResumeProcess")
	kernel32                      = windows.NewLazySystemDLL("kernel32.dll")
	procUpdateProcThreadAttribute = kernel32.NewProc("UpdateProcThreadAttribute")
)

func newJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

// winTree is the part both kinds of child share: the job, the process handle and the exit code.
type winTree struct {
	pid     int
	process windows.Handle
	jobMu   sync.Mutex
	job     windows.Handle
}

func (t *winTree) Pid() int { return t.pid }

func (t *winTree) Kill() error {
	t.jobMu.Lock()
	defer t.jobMu.Unlock()
	if t.job != 0 {
		return windows.TerminateJobObject(t.job, 1)
	}
	return nil
}

func (t *winTree) Signal(string) error { return errUnsupportedOp }

// waitExit waits for the main process and returns its exit code.
func (t *winTree) waitExit() int {
	windows.WaitForSingleObject(t.process, windows.INFINITE)
	var code uint32
	windows.GetExitCodeProcess(t.process, &code)
	return int(int32(code))
}

// finish kills whatever the main process left running and releases the job and process handles.
func (t *winTree) finish() {
	t.jobMu.Lock()
	if t.job != 0 {
		windows.TerminateJobObject(t.job, 1)
		windows.CloseHandle(t.job)
		t.job = 0
	}
	t.jobMu.Unlock()
	windows.CloseHandle(t.process)
}

// waitDone waits for a reader to finish, at most d.
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
	winTree
	cmd     *exec.Cmd
	stdin   *os.File
	inMu    sync.Mutex
	outDone chan struct{}
	errDone chan struct{}
}

func startPipe(spec spawnSpec, onData func(kind, []byte)) (process, error) {
	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = spec.Env
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow | createSuspended, HideWindow: true, CmdLine: spec.CmdLine}
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
	pid := cmd.Process.Pid
	fail := func(err error) (process, error) {
		cmd.Process.Kill()
		cmd.Wait()
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, err
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_SUSPEND_RESUME|
		windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return fail(err)
	}
	job, err := newJob()
	if err != nil {
		windows.CloseHandle(h)
		return fail(err)
	}
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(job)
		windows.CloseHandle(h)
		return fail(err)
	}
	if r, _, _ := procNtResumeProcess.Call(uintptr(h)); r != 0 {
		windows.TerminateJobObject(job, 1)
		windows.CloseHandle(job)
		windows.CloseHandle(h)
		return fail(errors.New("could not resume the new process"))
	}
	p := &pipeProc{winTree: winTree{pid: pid, process: h, job: job}, cmd: cmd, stdin: inW,
		outDone: make(chan struct{}), errDone: make(chan struct{})}
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
	p.cmd.Wait() // releases os/exec's handle; the pipes are plain files, so this does not wait for them
	// Output still in the pipes arrives now. A grandchild holding them open is killed with the rest of the tree.
	both := func(d time.Duration) bool { return waitDone(p.outDone, d) && waitDone(p.errDone, d) }
	if !both(2 * time.Second) {
		p.Kill()
		both(2 * time.Second)
	}
	p.finish()
	p.CloseStdin()
	return code
}

// ---- ConPTY ------------------------------------------------------------------------------------------------------------

type conPty struct {
	winTree
	hpc     windows.Handle
	pcMu    sync.Mutex
	pcOpen  bool
	in      *os.File
	inMu    sync.Mutex
	out     *os.File
	outDone chan struct{}
}

func coord(cols, rows int) windows.Coord { return windows.Coord{X: int16(cols), Y: int16(rows)} }

// envBlock is a UTF-16 environment block, sorted case-insensitively as Windows expects.
func envBlock(env []string) []uint16 {
	if env == nil {
		env = os.Environ()
	}
	sorted := append([]string(nil), env...)
	sort.Slice(sorted, func(a, b int) bool { return strings.ToUpper(sorted[a]) < strings.ToUpper(sorted[b]) })
	var out []uint16
	for _, e := range sorted {
		if strings.HasPrefix(e, "=") { // per-drive cwd entries
			continue
		}
		out = append(out, utf16.Encode([]rune(e))...)
		out = append(out, 0)
	}
	if len(out) == 0 {
		out = append(out, 0)
	}
	return append(out, 0)
}

func startPty(spec spawnSpec, onData func(kind, []byte)) (process, error) {
	path, err := exec.LookPath(spec.Command)
	if err != nil {
		return nil, err
	}
	cmdLine := spec.CmdLine
	if cmdLine == "" {
		cmdLine = windows.ComposeCommandLine(append([]string{path}, spec.Args...))
	}
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, err
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return nil, err
	}
	var hpc windows.Handle
	err = windows.CreatePseudoConsole(coord(spec.Pty.Cols, spec.Pty.Rows), inR, outW, 0, &hpc)
	windows.CloseHandle(inR) // the console host holds its own copies
	windows.CloseHandle(outW)
	if err != nil {
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, err
	}
	in := os.NewFile(uintptr(inW), "pty-in")
	out := os.NewFile(uintptr(outR), "pty-out")
	cleanup := func() {
		in.Close()
		go func() { windows.ClosePseudoConsole(hpc) }() // may wait for its output to be read
		go func() { drainFile(out); out.Close() }()
	}
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		cleanup()
		return nil, err
	}
	defer attrs.Delete()
	// lpValue is the HPCON itself, not a pointer to it.
	if r, _, e := procUpdateProcThreadAttribute.Call(uintptr(unsafe.Pointer(attrs.List())), 0,
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(hpc), unsafe.Sizeof(hpc), 0, 0); r == 0 {
		cleanup()
		return nil, e
	}
	var si windows.StartupInfoEx
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = startfUseStdHandles // no std handles of ours: the child must use the pseudo console
	si.ProcThreadAttributeList = attrs.List()
	cl, err := windows.UTF16PtrFromString(cmdLine)
	if err != nil {
		cleanup()
		return nil, err
	}
	var cwd *uint16
	if spec.Cwd != "" {
		if cwd, err = windows.UTF16PtrFromString(spec.Cwd); err != nil {
			cleanup()
			return nil, err
		}
	}
	env := envBlock(spec.Env)
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(nil, cl, nil, nil, false,
		windows.EXTENDED_STARTUPINFO_PRESENT|createSuspended|createUnicodeEnv, &env[0], cwd, &si.StartupInfo, &pi); err != nil {
		cleanup()
		return nil, err
	}
	job, err := newJob()
	if err == nil {
		if err = windows.AssignProcessToJobObject(job, pi.Process); err != nil {
			windows.CloseHandle(job)
		}
	}
	if err != nil {
		windows.TerminateProcess(pi.Process, 1)
		windows.CloseHandle(pi.Thread)
		windows.CloseHandle(pi.Process)
		cleanup()
		return nil, err
	}
	windows.ResumeThread(pi.Thread)
	windows.CloseHandle(pi.Thread)
	p := &conPty{winTree: winTree{pid: int(pi.ProcessId), process: pi.Process, job: job}, hpc: hpc, pcOpen: true,
		in: in, out: out, outDone: make(chan struct{})}
	go readLoop(out, kindOut, onData, p.outDone)
	return p, nil
}

func drainFile(f *os.File) {
	buf := make([]byte, 4096)
	for {
		if _, err := f.Read(buf); err != nil {
			return
		}
	}
}

func (p *conPty) Write(b []byte) error {
	p.inMu.Lock()
	defer p.inMu.Unlock()
	if p.in == nil {
		return os.ErrClosed
	}
	_, err := p.in.Write(b)
	return err
}

func (p *conPty) CloseStdin() error { return errUnsupportedOp }

func (p *conPty) Resize(cols, rows int) error {
	p.pcMu.Lock()
	defer p.pcMu.Unlock()
	if !p.pcOpen {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(p.hpc, coord(cols, rows))
}

func (p *conPty) closeConsole() {
	p.pcMu.Lock()
	open := p.pcOpen
	p.pcOpen = false
	p.pcMu.Unlock()
	if open {
		windows.ClosePseudoConsole(p.hpc) // the output pipe breaks once the console host has flushed and gone
	}
}

func (p *conPty) Wait() int {
	code := p.waitExit()
	p.finish() // whatever the shell left running
	done := make(chan struct{})
	go func() { p.closeConsole(); close(done) }()
	waitDone(p.outDone, 5*time.Second)
	p.out.Close()
	waitDone(done, 5*time.Second)
	p.inMu.Lock()
	p.in.Close()
	p.in = nil
	p.inMu.Unlock()
	return code
}

// ---- the orphan command, file lock, permissions ---------------------------------------------------------------------------

// startDetached starts a command that outlives the keeper: no job of ours, its own process group, no console window.
// It asks to break away from the job the keeper itself runs in; if that job does not allow it, it starts without.
func startDetached(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	flags := uint32(detachedProcess | createNewProcessGroup | createNoWindow)
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags | createBreakawayFromJob}
	if err := cmd.Start(); err == nil {
		return cmd, nil
	}
	cmd = newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
	return cmd, cmd.Start()
}

type fileLock struct{ f *os.File }

func (l *fileLock) Close() error { return l.f.Close() } // closing the handle releases the lock

func lockFile(path string) (*fileLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	var ol windows.Overlapped
	if err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &ol); err != nil {
		f.Close()
		return nil, errLocked
	}
	return &fileLock{f}, nil
}

func userSID() (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

// restrict replaces the DACL with one entry: this user, full control; nothing inherited (icacls /inheritance:r /grant:r).
func restrict(path string, inherit bool) error {
	sid, err := userSID()
	if err != nil {
		return err
	}
	flags := ""
	if inherit {
		flags = "OICI"
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + sid + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func restrictDir(path string) error  { return restrict(path, true) }
func restrictFile(path string) error { return restrict(path, false) }

// openShared opens a file for reading that may be deleted (truncate) or appended to while open.
func openShared(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		if err == windows.ERROR_FILE_NOT_FOUND || err == windows.ERROR_PATH_NOT_FOUND {
			return nil, &os.PathError{Op: "open", Path: path, Err: os.ErrNotExist}
		}
		return nil, err
	}
	return os.NewFile(uintptr(h), path), nil
}

// notifyStop: a GUI-subsystem program gets no console signals; AIB stops the keeper with the shutdown op.
func notifyStop(*keeper) {}
