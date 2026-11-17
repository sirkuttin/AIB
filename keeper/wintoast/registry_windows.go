//go:build windows

package wintoast

import (
	"errors"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// Classes is the per-user classes key: HKCU\Software\Classes. Tests pass their own base under a throwaway key.
const Classes = `Software\Classes`

// App is what Windows needs to know about a toast-sending app with no installer.
type App struct {
	AppID       string // the AUMID, e.g. "AIB.Studio"
	DisplayName string // the name on each toast
	IconPath    string // a PNG file (IconUri)
	CLSID       string // "{...}": the COM class whose LocalServer32 handles clicks
	Command     string // LocalServer32: the full command line Windows starts for a click with no handler running
}

// Keys are the two keys App writes, relative to the classes base.
func (a App) Keys() (aumid, clsid string) {
	return `AppUserModelId\` + a.AppID, `CLSID\` + a.CLSID
}

func (a App) valid() error {
	if a.AppID == "" || strings.ContainsAny(a.AppID, `\/`) || a.DisplayName == "" {
		return errors.New("toast app: bad app id or name")
	}
	if len(a.CLSID) != 38 || a.CLSID[0] != '{' || a.CLSID[37] != '}' {
		return errors.New("toast app: bad CLSID")
	}
	return nil
}

// Register writes (or rewrites) the app's keys under HKCU\<base>. Only the current user's hive; never needs admin.
func Register(base string, a App) error {
	if err := a.valid(); err != nil {
		return err
	}
	aumid, clsid := a.Keys()
	k, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\`+aumid, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.SetStringValue("DisplayName", a.DisplayName); err != nil {
		return err
	}
	if a.IconPath != "" {
		if err := k.SetStringValue("IconUri", a.IconPath); err != nil {
			return err
		}
	}
	if err := k.SetStringValue("CustomActivator", a.CLSID); err != nil {
		return err
	}
	if a.Command == "" {
		return nil
	}
	c, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\`+clsid+`\LocalServer32`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer c.Close()
	return c.SetStringValue("", a.Command)
}

// Read reads back what Register wrote (tests, and the helper's "already up to date" check).
func Read(base string, appID, clsid string) (App, error) {
	a := App{AppID: appID, CLSID: clsid}
	k, err := registry.OpenKey(registry.CURRENT_USER, base+`\AppUserModelId\`+appID, registry.QUERY_VALUE)
	if err != nil {
		return a, err
	}
	defer k.Close()
	a.DisplayName, _, _ = k.GetStringValue("DisplayName")
	a.IconPath, _, _ = k.GetStringValue("IconUri")
	if v, _, err := k.GetStringValue("CustomActivator"); err == nil && !strings.EqualFold(v, clsid) {
		a.CLSID = v
	}
	if c, err := registry.OpenKey(registry.CURRENT_USER, base+`\CLSID\`+clsid+`\LocalServer32`, registry.QUERY_VALUE); err == nil {
		a.Command, _, _ = c.GetStringValue("")
		c.Close()
	}
	return a, nil
}

// Unregister deletes the app's keys (tests and the registry check; AIB itself keeps its keys).
func Unregister(base string, appID, clsid string) error {
	var first error
	note := func(err error) {
		if err != nil && !errors.Is(err, registry.ErrNotExist) && first == nil {
			first = err
		}
	}
	note(registry.DeleteKey(registry.CURRENT_USER, base+`\AppUserModelId\`+appID))
	if clsid != "" {
		note(registry.DeleteKey(registry.CURRENT_USER, base+`\CLSID\`+clsid+`\LocalServer32`))
		note(registry.DeleteKey(registry.CURRENT_USER, base+`\CLSID\`+clsid))
	}
	return first
}

// ForgetSettings deletes the per-app notification settings key Windows itself adds once an app has shown a toast
// (HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AUMID>). For test app ids only.
func ForgetSettings(appID string) error {
	err := registry.DeleteKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\`+appID)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	return err
}
