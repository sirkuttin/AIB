//go:build !windows

package main

import "errors"

// Toasts with buttons are a Windows feature; elsewhere AIB keeps its own notifications (server/desktop/notify.ts).
func realToastDeps() (toastDeps, error) {
	return toastDeps{}, errors.New("toasts are Windows only")
}
