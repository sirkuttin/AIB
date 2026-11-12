package main

// AIB-keeper mcp-forward <address file>: a stdio-to-HTTP forwarder for an MCP server (design 3.7).
//
// Agents start their MCP servers as child processes from a command line fixed when the chat started. If that command were AIB's own
// program, a running chat would keep the old version's files busy after an update (Windows cannot delete a running exe, so the
// update's .old-* files stayed). The keeper's program lives in its own folder that updates never touch, so AIB gives agents in the
// keeper this forwarder instead, and the tool's logic stays in AIB, where it updates with AIB, even for running chats.
//
// It is generic and knows nothing of what it forwards:
//   - every line on stdin (one JSON-RPC message, MCP's stdio framing) is POSTed as application/json to the URL in <address file>
//     ({"url":"http://127.0.0.1:<port>/<path>", ...}; read again for every message, so a new AIB on another port is found);
//   - the headers come from MCP_FORWARD_HEADERS (a JSON object of name -> value, set by AIB in the MCP entry's env);
//   - a 200 reply's body is written to stdout as one line; a 202 (a notification or a response) writes nothing;
//   - while AIB cannot be reached (no file, or nothing listens: an AIB restart or an update switch), it tries again for up to 15 s.
//     Only a refused or failed connection is retried, never a message that may have been delivered, so nothing runs twice. A request
//     that still cannot be delivered gets an error with its id: a tools/call a tool result with isError (so the model reads it and
//     can try again later), anything else a JSON-RPC error.
//   - an address file that says {"closed":true} (the person quit AIB while its chats keep running in the keeper) is answered at
//     once with "AIB is closed" (keeper 1.3.0), no 15 s wait: nobody is about to come back.
//   - only loopback http URLs are used; no proxy.
//
// It never runs inside a serving keeper (the keeper itself still contains no HTTP), and the keeper's serve path never calls it.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	forwardRetryFor = 15 * time.Second
	forwardMaxLine  = 64 << 20
)

type forwarder struct {
	addressFile string
	headers     map[string]string
	client      *http.Client
	retryFor    time.Duration
	out         io.Writer
	outMu       sync.Mutex
}

func mcpForwardMain(args []string) int {
	if len(args) == 1 && args[0] == "--check" {
		fmt.Println("mcp-forward 1")
		return 0
	}
	if len(args) != 1 || args[0] == "" {
		fmt.Fprintln(os.Stderr, "usage: AIB-keeper mcp-forward <address file>")
		return 2
	}
	f, err := newForwarder(args[0], os.Getenv("MCP_FORWARD_HEADERS"), os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "AIB-keeper mcp-forward:", err)
		return 2
	}
	f.run(os.Stdin)
	return 0
}

func newForwarder(addressFile, headersJSON string, out io.Writer) (*forwarder, error) {
	headers := map[string]string{}
	if headersJSON != "" {
		if err := json.Unmarshal([]byte(headersJSON), &headers); err != nil {
			return nil, fmt.Errorf("MCP_FORWARD_HEADERS is not a JSON object of strings: %w", err)
		}
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext, MaxIdleConns: 4}
	return &forwarder{addressFile: addressFile, headers: headers, client: &http.Client{Transport: transport}, retryFor: forwardRetryFor, out: out}, nil
}

// run forwards every line of in until it ends, each in its own goroutine (MCP clients may have several requests out at once), and
// returns when every answer is written.
func (f *forwarder) run(in io.Reader) {
	reader := bufio.NewReaderSize(in, 64<<10)
	var wg sync.WaitGroup
	for {
		line, err := readLine(reader)
		if len(bytes.TrimSpace(line)) > 0 {
			wg.Add(1)
			go func(message []byte) {
				defer wg.Done()
				if reply := f.forward(message); reply != nil {
					f.write(reply)
				}
			}(line)
		}
		if err != nil {
			break
		}
	}
	wg.Wait()
}

// readLine returns one line without its line break. A line longer than forwardMaxLine is dropped whole.
func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(buf)+len(part) <= forwardMaxLine {
			buf = append(buf, part...)
		} else {
			buf = buf[:0:0]
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimRight(buf, "\r\n"), err
	}
}

func (f *forwarder) write(line []byte) {
	f.outMu.Lock()
	defer f.outMu.Unlock()
	f.out.Write(append(bytes.TrimRight(line, "\r\n"), '\n'))
}

// errAIBClosed: the address file says AIB was closed on purpose; no point waiting for it.
var errAIBClosed = errors.New("AIB is closed")

// endpoint reads the address file: a loopback http URL, or an error (missing, unreadable, closed, or not loopback).
func (f *forwarder) endpoint() (string, error) {
	raw, err := os.ReadFile(f.addressFile)
	if err != nil {
		return "", err
	}
	var doc struct {
		URL    string `json:"url"`
		Closed bool   `json:"closed"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	if doc.Closed {
		return "", errAIBClosed
	}
	u, err := url.Parse(doc.URL)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return "", fmt.Errorf("not a loopback http URL: %q", doc.URL)
	}
	return doc.URL, nil
}

// forward delivers one message and returns the line to write back (nil: nothing).
func (f *forwarder) forward(message []byte) []byte {
	var head struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	_ = json.Unmarshal(message, &head)
	isRequest := head.Method != "" && len(head.ID) > 0 && string(head.ID) != "null"
	deadline := time.Now().Add(f.retryFor)
	var lastErr error
	for {
		target, err := f.endpoint()
		if err == nil {
			var status int
			var body []byte
			status, body, err = f.post(target, message)
			if err == nil {
				switch {
				case status == http.StatusAccepted:
					return nil
				case status == http.StatusOK && len(bytes.TrimSpace(body)) > 0:
					return body
				case !isRequest:
					return nil
				default:
					return rpcError(head.ID, fmt.Sprintf("AIB answered HTTP %d: %s", status, clip(string(body), 300)))
				}
			}
			if !notDelivered(err) {
				if !isRequest {
					return nil
				}
				return rpcError(head.ID, "The connection to AIB broke while it handled this request: "+err.Error())
			}
		}
		lastErr = err
		if errors.Is(err, errAIBClosed) || time.Now().After(deadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if !isRequest {
		return nil
	}
	if errors.Is(lastErr, errAIBClosed) {
		return unavailable(head.ID, head.Method, "AIB is closed, so this tool cannot answer now. Your chat keeps running; try again later, once AIB is open again.")
	}
	return unavailable(head.ID, head.Method, "AIB is not running, so this tool cannot answer now ("+lastErr.Error()+"). Try again later, once AIB runs.")
}

// unavailable answers a request AIB could not take: a tools/call gets a tool result with isError (MCP: tool errors go in the result,
// where the model sees them and can retry), anything else a JSON-RPC error.
func unavailable(id json.RawMessage, method, message string) []byte {
	if method != "tools/call" {
		return rpcError(id, message)
	}
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
		"content": []map[string]any{{"type": "text", "text": message}}, "isError": true}})
	return out
}

func (f *forwarder) post(target string, message []byte) (int, []byte, error) {
	req, err := http.NewRequest(http.MethodPost, target, bytes.NewReader(message))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for name, value := range f.headers {
		req.Header.Set(name, value)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, forwardMaxLine))
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, body, nil
}

// notDelivered: the message certainly never reached AIB (the connection could not be made), so sending it again is safe.
func notDelivered(err error) bool {
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		return true
	}
	return strings.Contains(err.Error(), "connection refused") || strings.Contains(err.Error(), "actively refused")
}

func rpcError(id json.RawMessage, message string) []byte {
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32000, "message": message}})
	return out
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
