//go:build windows

package main

import (
	"os"
	"time"

	"aib.dev/keeper/wintoast"
)

type winToaster struct{ t *wintoast.Toaster }

func (w winToaster) Show(xml, tag, group string) error { return w.t.Show(xml, tag, group, false) }
func (w winToaster) Remove(tag, group string) error    { return w.t.Remove(tag, group) }
func (w winToaster) Close()                            { w.t.Close() }

func realToastDeps() (toastDeps, error) {
	exe, err := os.Executable()
	if err != nil {
		return toastDeps{}, err
	}
	return toastDeps{
		exe: exe,
		register: func(a toastApp) error {
			return wintoast.Register(wintoast.Classes, wintoast.App{
				AppID: a.AppID, DisplayName: a.DisplayName, IconPath: a.IconPath, CLSID: a.CLSID, Command: a.Command,
			})
		},
		open: func(appID string) (toaster, error) {
			t, err := wintoast.NewToaster(appID)
			if err != nil {
				return nil, err
			}
			return winToaster{t}, nil
		},
		activator: func(clsid string, fn func(string, map[string]string)) (func(), error) {
			return wintoast.RegisterActivator(clsid, func(a wintoast.Activation) { fn(a.Args, a.Inputs) })
		},
		launch: launchDetached,
		now:    time.Now,
	}, nil
}
