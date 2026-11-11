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
	"encoding/json"
	"fmt"
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
	}
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
