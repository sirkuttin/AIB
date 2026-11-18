//go:build windows

package main

import (
	"encoding/base64"
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// canSeal: secrets the keeper keeps at rest (keeper.json's token) and the keys AIB hands to forwarders through an agent
// (MCP_FORWARD_HEADERS, AIB_HOOK_KEY) are sealed with DPAPI for this Windows user, so a program that only reads files (an agent's
// file tool, `type`, `cat`) gets nothing it can use. The same form as AIB's server/state/sealed.ts.
const canSeal = true

func dataBlob(b []byte) *windows.DataBlob {
	if len(b) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

func takeDataBlob(out *windows.DataBlob) []byte {
	if out.Data == nil {
		return nil
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
}

// sealText: "dpapi:v1:<base64>" of plain, sealed for this Windows user with the purpose's entropy.
func sealText(purpose, plain string) (string, error) {
	var out windows.DataBlob
	if err := windows.CryptProtectData(dataBlob([]byte(plain)), nil, dataBlob(sealEntropy(purpose)), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return "", err
	}
	return sealPrefix + base64.StdEncoding.EncodeToString(takeDataBlob(&out)), nil
}

// openSealed: the plain text of a sealed value; a value without the prefix is returned as it is (an older AIB's plain key).
func openSealed(purpose, stored string) (string, error) {
	if !strings.HasPrefix(stored, sealPrefix) {
		return stored, nil
	}
	raw, err := base64.StdEncoding.DecodeString(stored[len(sealPrefix):])
	if err != nil {
		return "", errors.New("the sealed value is damaged")
	}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(dataBlob(raw), nil, dataBlob(sealEntropy(purpose)), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return "", errors.New("Windows could not open the sealed value for this user")
	}
	b := takeDataBlob(&out)
	s := string(b)
	for i := range b {
		b[i] = 0
	}
	return s, nil
}
