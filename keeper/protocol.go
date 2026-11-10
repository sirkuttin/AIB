// AIB keeper: holds agent processes and terminals, records both directions of their traffic, and serves the record to AIB.
// PROTOCOL.md (next to this file) is the wire contract.
//
// THE CONSTITUTION. Every keeper version keeps these rules, forever:
//
//  1. Operations and header fields are only ever ADDED. Nothing is renamed, removed or given a new meaning. Unknown header
//     fields are ignored. An unknown op is answered {"ok":false,"error":"unknown_op"}; it never closes the connection.
//  2. A feature is advertised in hello's "features"; AIB checks for it before using it.
//  3. The protocol number (1) never changes. A keeper that must break it is a new program installed next to this one.
//  4. AIB carries the compatibility burden, not the keeper: every AIB version must drive every released keeper.
//  5. Limits are fixed and checked first: header <= 64 KiB, body <= 16 MiB. A bad frame closes only that connection.
//
// The keeper must never contain: JSON or ACP parsing of agent traffic, knowledge of chats, sessions, prompts or settings,
// HTTP, a UI, or agent-specific code. Test for anything proposed for it: "would this ever change when AIB gets a feature?"
// If yes, it belongs in AIB.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	protocolVersion = 1
	keeperVersion   = "1.0.0"
	maxHeader       = 64 << 10
	maxBody         = 16 << 20
)

// features are advertised in hello. Additions only.
var features = []string{"pty", "notes", "truncate", "orphan", "signal", "once", "channel-ids"}

var errFrame = errors.New("bad frame")

// readFrame reads one [u32le headerLength][header JSON][u32le bodyLength][body] frame. The limits are checked before any
// allocation, so a hostile length costs nothing.
func readFrame(r io.Reader) (header, body []byte, err error) {
	var n [4]byte
	if _, err = io.ReadFull(r, n[:]); err != nil {
		return nil, nil, err
	}
	hl := binary.LittleEndian.Uint32(n[:])
	if hl == 0 || hl > maxHeader {
		return nil, nil, fmt.Errorf("%w: header length %d", errFrame, hl)
	}
	header = make([]byte, hl)
	if _, err = io.ReadFull(r, header); err != nil {
		return nil, nil, err
	}
	if _, err = io.ReadFull(r, n[:]); err != nil {
		return nil, nil, err
	}
	bl := binary.LittleEndian.Uint32(n[:])
	if bl > maxBody {
		return nil, nil, fmt.Errorf("%w: body length %d", errFrame, bl)
	}
	if bl > 0 {
		body = make([]byte, bl)
		if _, err = io.ReadFull(r, body); err != nil {
			return nil, nil, err
		}
	}
	return header, body, nil
}

// encodeFrame builds one frame. header is marshalled to JSON.
func encodeFrame(header any, body []byte) ([]byte, error) {
	h, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	if len(h) > maxHeader || len(body) > maxBody {
		return nil, fmt.Errorf("%w: frame too large", errFrame)
	}
	out := make([]byte, 0, 8+len(h)+len(body))
	out = binary.LittleEndian.AppendUint32(out, uint32(len(h)))
	out = append(out, h...)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(body)))
	out = append(out, body...)
	return out, nil
}

// request is every field any op reads. Unknown fields are ignored (constitution rule 1).
type request struct {
	Op     string          `json:"op"`
	ID     json.RawMessage `json:"id,omitempty"`
	Token  string          `json:"token"`
	Min    int             `json:"min"`
	Max    int             `json:"max"`
	Client string          `json:"client"`

	Channel            string            `json:"channel"`
	Command            string            `json:"command"`
	Args               []string          `json:"args"`
	Cwd                string            `json:"cwd"`
	Env                map[string]string `json:"env"`
	WindowsCommandLine string            `json:"windowsCommandLine"`
	Pty                *ptySize          `json:"pty"`

	From   uint64 `json:"from"`
	Epoch  uint64 `json:"epoch"`
	Once   string `json:"once"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
	Signal string `json:"signal"`
	Before uint64 `json:"before"`
	Force  bool   `json:"force"`

	Orphan *orphanCommand `json:"orphan"`
}

type ptySize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

// orphanCommand is what the keeper runs when no client has been attached for a while (normally "start AIB headless").
type orphanCommand struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// Error codes. Additions only.
const (
	errUnknownOp      = "unknown_op"
	errBadRequest     = "bad_request"
	errNotAuth        = "not_authenticated"
	errBadToken       = "bad_token"
	errUnsupportedVer = "unsupported_protocol"
	errNoChannel      = "no_channel"
	errExists         = "exists"
	errEnded          = "ended"
	errFenced         = "fenced"
	errDuplicate      = "duplicate"
	errBusy           = "busy"
	errSpawnFailed    = "spawn_failed"
	errUnsupported    = "unsupported"
	errFailed         = "failed"
	errShuttingDown   = "shutting_down"
)

type kind byte

const (
	kindOut    kind = 1
	kindErr    kind = 2
	kindIn     kind = 3
	kindNote   kind = 4
	kindExit   kind = 5
	kindResize kind = 6
)

var kindNames = map[kind]string{kindOut: "out", kindErr: "err", kindIn: "in", kindNote: "note", kindExit: "exit", kindResize: "resize"}

func (k kind) String() string {
	if s, ok := kindNames[k]; ok {
		return s
	}
	return fmt.Sprintf("kind%d", byte(k))
}
