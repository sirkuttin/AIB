//go:build !linux

package main

import "errors"

// fdoToasts: `AIB-keeper toast` talks to org.freedesktop.Notifications (Linux only; toast_fdo.go).
const fdoToasts = false

func realFdoDeps() (fdoDeps, error) {
	return fdoDeps{}, errors.New("D-Bus notifications are Linux only")
}
