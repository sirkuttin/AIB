//go:build !windows

package main

import (
	"errors"
	"strings"
)

// canSeal: no DPAPI here. keeper.json keeps its token in a 0600 file, and the keeper refuses a hello from any process that runs
// under one of its channels (peer_linux.go), so an agent that reads the token still cannot use it.
const canSeal = false

func sealText(purpose, plain string) (string, error) { return plain, nil }

func openSealed(purpose, stored string) (string, error) {
	if strings.HasPrefix(stored, sealPrefix) {
		return "", errors.New("a DPAPI-sealed value can only be opened on Windows")
	}
	return stored, nil
}
