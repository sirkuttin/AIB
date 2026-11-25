#!/usr/bin/env bash
# Runs work/deno/secret_service_e2e_test.ts against a real, throwaway gnome-keyring on a private D-Bus session (headless: no window,
# no prompt, no touch of the user's own keyring). Needs: dbus-run-session, gnome-keyring-daemon, secret-tool (libsecret-tools), deno.
# Usage: tools/secret-service-e2e.sh [path-to-deno]
set -eu
DENO="${1:-deno}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export XDG_DATA_HOME="$(mktemp -d /tmp/aib-keyring-XXXXXX)"
trap 'rm -rf "$XDG_DATA_HOME"' EXIT
exec dbus-run-session -- bash -c '
  echo "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  cd "$0/app" && "$1" test -A ../work/deno/secret_service_e2e_test.ts
' "$HERE" "$DENO"
