//go:build windows

package wintoast

import (
	"crypto/rand"
	"encoding/hex"
	"testing"

	"golang.org/x/sys/windows/registry"
)

// The registry writes, under a throwaway HKCU\Software\AIB-test-<random>\Classes base (never Software\Classes, never AIB's app id),
// removed at the end. Nothing is shown.
func TestRegisterReadUnregister(t *testing.T) {
	b := make([]byte, 6)
	rand.Read(b)
	root := `Software\AIB-test-` + hex.EncodeToString(b)
	base := root + `\Classes`
	t.Cleanup(func() {
		registry.DeleteKey(registry.CURRENT_USER, base+`\AppUserModelId`)
		registry.DeleteKey(registry.CURRENT_USER, base+`\CLSID`)
		registry.DeleteKey(registry.CURRENT_USER, base)
		registry.DeleteKey(registry.CURRENT_USER, root)
		if k, err := registry.OpenKey(registry.CURRENT_USER, root, registry.QUERY_VALUE); err == nil {
			k.Close()
			t.Errorf("left %s behind", root)
		}
	})
	app := App{
		AppID:       "AIB.Test." + hex.EncodeToString(b[:3]),
		DisplayName: "AIB",
		IconPath:    `C:\data\toast-icon.png`,
		CLSID:       "{11111111-2222-3333-4444-555555555555}",
		Command:     `"C:\AIB\AIB-keeper.exe" toast --clsid {11111111-2222-3333-4444-555555555555} --data "C:\d"`,
	}
	if err := Register(base, App{AppID: `bad\id`, DisplayName: "x", CLSID: app.CLSID}); err == nil {
		t.Fatal("a backslash in the app id must be refused")
	}
	if err := Register(base, App{AppID: "x", DisplayName: "x", CLSID: "nope"}); err == nil {
		t.Fatal("a bad CLSID must be refused")
	}
	if err := Register(base, app); err != nil {
		t.Fatal(err)
	}
	// rewritten at every start: a moved build updates the command
	app.Command = `"D:\AIB\AIB-keeper.exe" toast --clsid {11111111-2222-3333-4444-555555555555} --data "C:\d"`
	if err := Register(base, app); err != nil {
		t.Fatal(err)
	}
	got, err := Read(base, app.AppID, app.CLSID)
	if err != nil {
		t.Fatal(err)
	}
	if got != app {
		t.Fatalf("read back %+v, want %+v", got, app)
	}
	if err := Unregister(base, app.AppID, app.CLSID); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(base, app.AppID, app.CLSID); err == nil {
		t.Fatal("still registered")
	}
	if err := Unregister(base, app.AppID, app.CLSID); err != nil {
		t.Fatalf("unregister twice: %v", err)
	}
}
