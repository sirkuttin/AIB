#!/bin/bash
# The computer page's phase 4 scripts (remote-windows.js, remote-auth.js offline, window-context.js) in WebKitGTK, Safari's engine,
# headless: run from Windows with  wsl.exe -d Ubuntu -- bash <repo>/work/remote_pc_webkit/run.sh  (needs python3-gi, gir1.2-webkit2-4.1
# and xvfb). Xvfb's display only, never WSLg's: no window on the screen. Exit 0 when every check passes.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11
set -o pipefail
timeout 150 xvfb-run -a python3 work/remote_pc_webkit/run.py "$REPO" 2>&1 | grep -v -i -E "gtk-warning|dbind|libEGL|MESA|Gdk-WARNING"
