//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFilePermissions(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data)
	c := dial(t, k)
	spawnEcho(t, c, "perm")
	dir := filepath.Join(data, "keeper")
	want := map[string]os.FileMode{dir: 0o700, filepath.Join(dir, "keeper.json"): 0o600, filepath.Join(dir, "keeper.sock"): 0o600,
		filepath.Join(dir, "channels", "perm"): 0o700, filepath.Join(dir, "channels", "perm", segName(1)): 0o600}
	for p, m := range want {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm()&^m != 0 {
			t.Fatalf("%s: mode %v, want at most %v", p, fi.Mode().Perm(), m)
		}
	}
}
