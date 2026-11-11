package main

import (
	"bytes"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	tiocptygrant = 0x20007454
	tiocptyunlk  = 0x20007452
)

func ioctl(fd int, req uint, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(req), arg); e != 0 {
		return e
	}
	return nil
}

// openPty opens a new pseudo-terminal master and returns it with the slave's path (grantpt, unlockpt, ptsname).
func openPty() (*os.File, string, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, "", err
	}
	fd := int(master.Fd())
	var name [128]byte
	if err := ioctl(fd, tiocptygrant, 0); err != nil {
		master.Close()
		return nil, "", err
	}
	if err := ioctl(fd, tiocptyunlk, 0); err != nil {
		master.Close()
		return nil, "", err
	}
	if err := ioctl(fd, unix.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); err != nil {
		master.Close()
		return nil, "", err
	}
	if i := bytes.IndexByte(name[:], 0); i >= 0 {
		return master, string(name[:i]), nil
	}
	master.Close()
	return nil, "", syscall.EINVAL
}

func setPdeathsig(*syscall.SysProcAttr) {}
