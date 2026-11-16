// P0b probe: a prototype of the keeper forwarder's planned `hook <event>` mode, to measure what one command-hook call costs with a
// Go console program (the keeper is Go) and to check the fail-closed exit.
//
//	go build -o <scratch>/fwd.exe work/p0b_forwarder.go
//	fwd.exe <address-file> <event>      (stdin: the hook JSON)
//
// It reads the AIB address (one line, http://127.0.0.1:<port>) from <address-file>, POSTs stdin to <address>/hooks/<event> with a
// 10 s timeout, prints the answer on stdout and exits 0. When the file is missing, the connection fails, the status is not 2xx or
// the answer is late, it exits 2 with "AIB is restarting; try the subagent again in a moment." on stderr (pre-tool and
// worktree-create) or exits 0 with nothing (any other event: fail open).
package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: fwd <address-file> <event>")
		os.Exit(1)
	}
	event := os.Args[2]
	closed := event == "pre-tool" || event == "worktree-create"
	fail := func() {
		if closed {
			fmt.Fprint(os.Stderr, "AIB is restarting; try the subagent again in a moment.")
			os.Exit(2)
		}
		os.Exit(0)
	}
	body, _ := io.ReadAll(os.Stdin)
	addr, err := os.ReadFile(os.Args[1])
	if err != nil {
		fail()
	}
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("POST", strings.TrimSpace(string(addr))+"/hooks/"+event, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-aib-hook-key", os.Getenv("AIB_HOOK_KEY"))
	res, err := client.Do(req)
	if err != nil {
		fail()
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		fail()
	}
	os.Stdout.Write(out)
}
