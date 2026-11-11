package main

import "golang.org/x/sys/windows"

func termSize() (int, int) {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Stdout, &info); err != nil {
		return 0, 0
	}
	return int(info.Window.Right-info.Window.Left) + 1, int(info.Window.Bottom-info.Window.Top) + 1
}
