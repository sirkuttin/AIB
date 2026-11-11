package main

import (
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Every ACE on the keeper folder, keeper.json and a journal is this user's, and nothing is inherited from above.
func TestFilePermissions(t *testing.T) {
	data := t.TempDir()
	k := startKeeper(t, data)
	c := dial(t, k)
	spawnEcho(t, c, "perm")
	sid, err := userSID()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(data, "keeper")
	for _, p := range []string{dir, filepath.Join(dir, "keeper.json"), filepath.Join(dir, "channels.json"),
		filepath.Join(dir, "channels", "perm", segName(1))} {
		sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(p, err)
		}
		s := sd.String()
		dacl := s[strings.Index(s, "D:"):]
		if p == dir || strings.HasSuffix(p, "keeper.json") {
			if !strings.HasPrefix(dacl, "D:P") {
				t.Fatalf("%s: DACL not protected: %s", p, dacl)
			}
		}
		aces := strings.Split(dacl, "(")[1:]
		if len(aces) == 0 {
			t.Fatalf("%s: no ACE: %s", p, dacl)
		}
		for _, ace := range aces {
			if !strings.HasSuffix(strings.TrimSuffix(ace, ")"), ";"+sid) {
				t.Fatalf("%s: ACE for someone else: %s", p, dacl)
			}
		}
	}
}
