//go:build !linux

package main

import "net"

// No peer check here. Windows: keeper.json's token is sealed with DPAPI, so reading the file gives nothing (seal_windows.go).
func markUnderKeeper(pid int) {}

func (k *keeper) peerRefusal(nc net.Conn) string { return "" }
