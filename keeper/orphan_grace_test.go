package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// keeper 1.6.0 --orphan-grace (PROTOCOL.md section 6): the Linux keeper (the bridge starts it with 2h) cannot start AIB again, so
// live channels with no client wait for the whole grace, not the ~35 s of the orphan attempts. These tests use a short grace and
// short orphan timings: the old give-up point (orphan-after + tries * retry + retry) is well inside the grace.

func keeperLog(data string) string {
	b, _ := os.ReadFile(filepath.Join(data, "keeper", "keeper.log"))
	return string(b)
}

func keeperJSON(t *testing.T, data string) map[string]any {
	t.Helper()
	var info map[string]any
	b, _ := os.ReadFile(filepath.Join(data, "keeper", "keeper.json"))
	json.Unmarshal(b, &info)
	return info
}

// The incident: the last client goes (an older AIB stopped the keep-alive). Past the old 35 s equivalent the agents still run; only the
// grace's end stops them, with the log telling the story.
func TestOrphanGraceKeepsChannelsPastTheOldWindow(t *testing.T) {
	data := t.TempDir()
	// old rules here: give up ~300 ms after the client left (orphan-after 100ms, 2 tries 100ms apart, then 100ms)
	k := startKeeper(t, data, "--orphan-after", "100ms", "--orphan-retry", "100ms", "--orphan-tries", "2", "--orphan-grace", "3s")
	c := dial(t, k)
	if g := c.must("status", nil, nil).h["orphanGrace"]; g != float64(3) {
		t.Fatalf("status orphanGrace %v", g)
	}
	spawnEcho(t, c, "agent", "tree")
	c.must("attach", map[string]any{"channel": "agent"}, nil)
	child, grand := readTree(t, c, "agent")
	left := time.Now()
	c.nc.Close()
	if k.waitExit(1500 * time.Millisecond) {
		t.Fatal("the keeper gave up inside the grace")
	}
	if !processAlive(child) || !processAlive(grand) {
		t.Fatal("an agent was stopped inside the grace")
	}
	info := keeperJSON(t, data)
	since, _ := info["orphanSince"].(float64)
	stopAt, _ := info["orphanStopAt"].(float64)
	if info["orphanGrace"] != float64(3) || since == 0 || int64(stopAt-since) != 3000 {
		t.Fatalf("keeper.json during the grace: %v", info)
	}
	log := keeperLog(data)
	if !strings.Contains(log, "no client: keeping 1 live channels; they stop after 3s without a client") {
		t.Fatalf("no start-of-grace line:\n%s", log)
	}
	if strings.Contains(log, "orphan attempt") {
		t.Fatalf("orphan attempts ran with no orphan command:\n%s", log)
	}
	if !k.waitExit(6 * time.Second) {
		t.Fatal("the keeper did not stop its channels when the grace ended")
	}
	if away := time.Since(left); away < 3*time.Second {
		t.Fatalf("stopped after %v, before the 3 s grace", away)
	}
	waitGone(t, child, 3*time.Second)
	waitGone(t, grand, 3*time.Second)
	if log := keeperLog(data); !strings.Contains(log, "no client for 3s: stopping 1 channels and exiting") {
		t.Fatalf("no end-of-grace line:\n%s", log)
	}
	k2 := startKeeper(t, data)
	l := dial(t, k2).must("list", nil, nil).h["channels"].([]any)[0].(map[string]any)
	if l["reason"] != "orphaned" {
		t.Fatalf("reason %v", l)
	}
}

// The grace restarts each time a client comes and goes; a client of any kind counts (a connected hold bridge is just a client named
// "AIB WSL hold"), however long it stays. The env variable sets the grace when the flag is not given.
func TestOrphanGraceRestartsWithEachClient(t *testing.T) {
	data := t.TempDir()
	k := startKeeperWith(t, data, func(cmd *exec.Cmd) { cmd.Env = append(os.Environ(), orphanGraceEnv+"=2s") },
		"--orphan-after", "100ms", "--orphan-retry", "100ms", "--orphan-tries", "1")
	c := dial(t, k)
	if g := c.must("status", nil, nil).h["orphanGrace"]; g != float64(2) {
		t.Fatalf("status orphanGrace from %s: %v", orphanGraceEnv, g)
	}
	spawnEcho(t, c, "agent")
	c.nc.Close()
	time.Sleep(1300 * time.Millisecond)
	// a hold comes and stays past the grace: never stopped while it is there
	hold := newClient(t, rawDial(t, k))
	hold.must("hello",map[string]any{"token": k.info["token"], "min": 1, "max": 1, "client": holdClient}, nil)
	if k.waitExit(2500 * time.Millisecond) {
		t.Fatal("the keeper stopped while a hold was connected")
	}
	if _, ok := keeperJSON(t, data)["orphanSince"]; ok {
		t.Fatal("keeper.json still shows an orphan stretch while a client is there")
	}
	hold.nc.Close()
	left := time.Now()
	// the grace starts again from zero: 1.3 s after the hold left is past 2 s since the first client left, still alive
	if k.waitExit(1300 * time.Millisecond) {
		t.Fatal("the grace did not start again when the hold left")
	}
	look := dial(t, k)
	if l := look.must("list", nil, nil).h["channels"].([]any)[0].(map[string]any); l["live"] != true {
		t.Fatalf("channel stopped: %v", l)
	}
	look.nc.Close()
	left = time.Now()
	if !k.waitExit(5 * time.Second) {
		t.Fatal("the keeper did not stop its channels after the grace")
	}
	if away := time.Since(left); away < 2*time.Second {
		t.Fatalf("stopped %v after the last client, before the 2 s grace", away)
	}
	if log := keeperLog(data); strings.Count(log, "a client is back after")+strings.Count(log, "a client came and went") != 2 || strings.Count(log, "no client: keeping 1 live channels") != 3 {
		t.Fatalf("keeper.log does not tell the story:\n%s", log)
	}
}

// With an orphan command (not the Linux keeper's case) the attempts still run, at most --orphan-tries times; the stop waits for the
// grace. Without --orphan-grace nothing changes: no orphanGrace field anywhere (the Windows keeper's status and keeper.json as before).
func TestOrphanGraceWithAnOrphanCommandAndWithout(t *testing.T) {
	data := t.TempDir()
	marker := filepath.Join(t.TempDir(), "orphan.txt")
	oc, _ := json.Marshal(orphanCommand{Command: agentBin, Args: []string{"touch", marker}})
	k := startKeeper(t, data, "--orphan-command", string(oc), "--orphan-after", "100ms", "--orphan-retry", "100ms", "--orphan-tries", "2",
		"--orphan-grace", "2s")
	c := dial(t, k)
	spawnEcho(t, c, "agent")
	c.nc.Close()
	if k.waitExit(1200 * time.Millisecond) {
		t.Fatal("gave up after the orphan attempts, inside the grace")
	}
	if b, _ := os.ReadFile(marker); strings.Count(string(b), "started") != 2 {
		t.Fatalf("orphan command runs: %q", b)
	}
	if !k.waitExit(5 * time.Second) {
		t.Fatal("did not stop after the grace")
	}

	plain := t.TempDir()
	k2 := startKeeper(t, plain)
	c2 := dial(t, k2)
	if _, ok := c2.must("status", nil, nil).h["orphanGrace"]; ok {
		t.Fatal("status has orphanGrace without --orphan-grace")
	}
	if _, ok := keeperJSON(t, plain)["orphanGrace"]; ok {
		t.Fatal("keeper.json has orphanGrace without --orphan-grace")
	}
}
