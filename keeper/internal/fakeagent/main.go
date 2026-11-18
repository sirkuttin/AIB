// fakeagent is the keeper tests' child process. Modes:
//
//	echo            prints {"ready":pid}, then for each stdin line: {"echo":"<line>"} on stdout and err:<line> on stderr.
//	                Special lines: "size" prints SIZE <cols>x<rows> (the terminal's size), "exit N" exits with N.
//	                On a pty it prints ECHO <line> instead of JSON (easier to find in terminal output).
//	tree            starts `fakeagent sleep` as a child, prints {"child":pid,"grandchild":pid}, then behaves like echo.
//	sleep           sleeps forever.
//	spam N          writes N lines of 100 bytes to stdout, then exits 0.
//	touch FILE      appends a line to FILE and exits (the orphan command in tests).
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "sleep":
		for {
			time.Sleep(time.Hour)
		}
	case "spam":
		n, _ := strconv.Atoi(os.Args[2])
		w := bufio.NewWriter(os.Stdout)
		for i := 0; i < n; i++ {
			fmt.Fprintf(w, "%08d %s\n", i, strings.Repeat("x", 90))
		}
		w.Flush()
	case "touch":
		f, err := os.OpenFile(os.Args[2], os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err == nil {
			fmt.Fprintf(f, "started %d\n", os.Getpid())
			f.Close()
		}
	case "tree":
		child := exec.Command(os.Args[0], "sleep")
		if err := child.Start(); err != nil {
			fmt.Println(`{"error":"could not start grandchild"}`)
			os.Exit(1)
		}
		b, _ := json.Marshal(map[string]int{"child": os.Getpid(), "grandchild": child.Process.Pid})
		fmt.Println(string(b))
		echo(false)
	case "echo":
		echo(len(os.Args) > 2 && os.Args[2] == "pty")
	case "steal":
		steal(os.Args[2], len(os.Args) > 3 && os.Args[3] == "detach")
	}
}

// steal FILE [detach]: what an agent with a shell could try (security item 7). After a moment (the keeper marks its channel's
// process right after the spawn) it reads keeper.json like any file, takes whatever "token" it finds, dials the keeper and says
// hello; prints {"stole":<the answer's header>}. With "detach" it first starts itself again as a process that leaves its parent
// (Unix: a new session), and that one does the reading.
func steal(file string, detach bool) {
	if detach {
		cmd := exec.Command(os.Args[0], "steal", file)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		detachProcess(cmd)
		if err := cmd.Start(); err != nil {
			fmt.Println(`{"stole":{"error":"could not start"}}`)
		}
		return // the parent leaves at once; the other one carries on without it
	}
	time.Sleep(300 * time.Millisecond)
	var info struct {
		Transport, Address, Token string
	}
	b, err := os.ReadFile(file)
	if err == nil {
		err = json.Unmarshal(b, &info)
	}
	if err != nil {
		fmt.Printf("{\"stole\":{\"error\":%q}}\n", err.Error())
		return
	}
	nc, err := net.Dial(info.Transport, info.Address)
	if err != nil {
		fmt.Printf("{\"stole\":{\"error\":%q}}\n", err.Error())
		return
	}
	defer nc.Close()
	head, _ := json.Marshal(map[string]any{"op": "hello", "id": 1, "token": info.Token, "min": 1, "max": 1, "client": "agent"})
	frame := make([]byte, 8+len(head))
	binary.LittleEndian.PutUint32(frame[0:], uint32(len(head)))
	copy(frame[4:], head)
	binary.LittleEndian.PutUint32(frame[4+len(head):], 0)
	nc.Write(frame)
	nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	var size [4]byte
	if _, err := io.ReadFull(nc, size[:]); err != nil {
		fmt.Printf("{\"stole\":{\"error\":%q}}\n", err.Error())
		return
	}
	answer := make([]byte, binary.LittleEndian.Uint32(size[:]))
	io.ReadFull(nc, answer)
	fmt.Printf("{\"stole\":%s}\n", answer)
}

func echo(pty bool) {
	fmt.Printf("{\"ready\":%d}\n", os.Getpid())
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		switch {
		case line == "size":
			cols, rows := termSize()
			fmt.Printf("SIZE %dx%d\n", cols, rows)
		case strings.HasPrefix(line, "exit "):
			code, _ := strconv.Atoi(strings.TrimPrefix(line, "exit "))
			os.Exit(code)
		case pty:
			fmt.Printf("ECHO %s\n", line)
		default:
			b, _ := json.Marshal(map[string]string{"echo": line})
			fmt.Println(string(b))
			fmt.Fprintf(os.Stderr, "err:%s\n", line)
		}
	}
}
