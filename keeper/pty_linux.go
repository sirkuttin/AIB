package main

import (
	"os"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

// openPty opens a new pseudo-terminal master and returns it with the slave's path.
func openPty() (*os.File, string, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, "", err
	}
	fd := int(master.Fd())
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil { // unlockpt
		master.Close()
		return nil, "", err
	}
	n, err := unix.IoctlGetUint32(fd, unix.TIOCGPTN) // ptsname
	if err != nil {
		master.Close()
		return nil, "", err
	}
	return master, "/dev/pts/" + strconv.FormatUint(uint64(n), 10), nil
}

func setPdeathsig(a *syscall.SysProcAttr) { a.Pdeathsig = syscall.SIGKILL }
