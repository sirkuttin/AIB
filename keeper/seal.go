package main

import (
	"fmt"
	"os"
)

const sealPrefix = "dpapi:v1:"

// Purposes: each sealed secret has its own entropy, so a value sealed for one use never opens as another.
const (
	sealKeeperToken   = "keeper-token"
	sealForwardHeader = "mcp-forward-headers"
	sealHookKey       = "hook-key"
)

func sealEntropy(purpose string) []byte { return []byte("AIB sealed secret v1\x00" + purpose) }

// checkLine: a forwarder's `--check` answer. " sealed" (keeper 1.7.0) tells AIB it may hand this program DPAPI-sealed keys; AIB
// only ever looked at the start of the line, so older AIBs still read it as before.
func checkLine(base string) string {
	if canSeal {
		return base + " sealed"
	}
	return base
}

// openedEnv: an environment variable a forwarder gets from AIB through the agent, opened when AIB sealed it (DPAPI, Windows). A
// value that cannot be opened is dropped: the forwarder then sends no key, and AIB refuses the call, as with a wrong key.
func openedEnv(purpose, name string) string {
	v, err := openSealed(purpose, os.Getenv(name))
	if err != nil {
		fmt.Fprintf(os.Stderr, "AIB-keeper: %s: %v\n", name, err)
		return ""
	}
	return v
}

// infoToken: the hello token of a keeper.json (as a map): "tokenSealed" (keeper 1.7.0 on Windows) or "token".
func infoToken(info map[string]any) string {
	if s, ok := info["tokenSealed"].(string); ok && s != "" {
		if t, err := openSealed(sealKeeperToken, s); err == nil {
			return t
		}
		return ""
	}
	t, _ := info["token"].(string)
	return t
}
