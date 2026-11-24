package main

// AIB-keeper hook <event> --helper-socket <unix socket> (keeper 1.8.0, WSL): the hook forwarder for an agent inside a WSL distro,
// where Windows 127.0.0.1 and AIB's address file cannot be reached. The hook goes to the WSL helper's tunnel socket (the same one
// `mcp-forward --helper-socket` uses; mcprelay.go serves it), which hands it to AIB over the helper channel.
//
// One connection per call: one request line {"headers":{...},"body":"<the hook's input>"} and one answer line {"status":200,"body":
// "<envelope>"}. The headers are the HTTP form's (key, chat, nonce) plus X-Studio-Hook-Event. AIB's answer to the hook comes inside
// the tunnel's body, as an envelope {"status":N,"body":"<text>","proof":"<hex>"}, because the tunnel carries no headers back; the proof
// is the same HMAC as the HTTP form's and is checked by the same code (hookforward.go run), so a wrong or missing proof blocks.
// A tunnel answer that is not 200 (AIB away, closed, too many calls) is "AIB is restarting", as an unreachable AIB is on Windows.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

const hookEventHeader = "X-Studio-Hook-Event"

// postSocket delivers the hook input over the helper's tunnel socket, trying again while the socket cannot be dialed (the helper is
// starting), until the deadline. A message that was written is never sent twice.
func (h *hookForwarder) postSocket(ctx context.Context, input []byte, nonce string) (int, []byte, string, error) {
	line, err := json.Marshal(map[string]any{
		"headers": map[string]string{
			hookKeyHeader:   h.key,
			hookChatHeader:  h.chat,
			hookNonceHeader: nonce,
			hookEventHeader: h.event,
		},
		"body": string(input),
	})
	if err != nil {
		return 0, nil, "", err
	}
	for {
		conn, derr := net.DialTimeout("unix", h.socket, 2*time.Second)
		if derr == nil {
			return h.exchange(ctx, conn, line)
		}
		select {
		case <-ctx.Done():
			return 0, nil, "", derr
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (h *hookForwarder) exchange(ctx context.Context, conn net.Conn, line []byte) (int, []byte, string, error) {
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		return 0, nil, "", fmt.Errorf("the WSL helper's tunnel broke: %w", err)
	}
	answer, err := readLine(bufio.NewReaderSize(conn, 64<<10))
	if len(bytes.TrimSpace(answer)) == 0 {
		if err == nil {
			err = errors.New("the WSL helper's tunnel closed without an answer")
		}
		return 0, nil, "", err
	}
	var tunnel struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
		Error  string `json:"error"`
	}
	if json.Unmarshal(answer, &tunnel) != nil || tunnel.Status != http.StatusOK {
		return 0, nil, "", fmt.Errorf("the WSL helper's tunnel answered %d: %s", tunnel.Status, clip(tunnel.Error+tunnel.Body, 200))
	}
	var env struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
		Proof  string `json:"proof"`
	}
	if json.Unmarshal([]byte(tunnel.Body), &env) != nil || env.Status == 0 {
		return 0, nil, "", errors.New("AIB's answer through the tunnel is not a hook answer")
	}
	return env.Status, []byte(env.Body), env.Proof, nil
}
