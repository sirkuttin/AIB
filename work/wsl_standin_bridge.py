#!/usr/bin/env python3
"""A stand-in for `AIB-keeper bridge` (keeper/bridge.go, Track A) for work/deno/wsl_reconnect_e2e_test.ts, until that lands.

Installed as <root>/<ver>/AIB-keeper next to the real keeper (built for Linux from keeper/) as AIB-keeper-real. Any command but
`bridge` runs the real keeper. `bridge --data D [--hold]` does what docs/wsl/design.md section 3 says the bridge does: read
D/keeper/keeper.json; when its pid is dead or the socket does not answer, start `serve --data D` detached (its own session, so it
outlives this bridge and the wsl.exe that started it) and wait for it; print BRIDGE_MAGIC and the one-line preamble; then splice
stdin/stdout and the keeper's unix socket until either side ends. `--hold` only blocks on stdin (no hello: a stand-in).
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time

MAGIC = b'AIB-BRIDGE-1\n'


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    real = os.path.join(here, 'AIB-keeper-real')
    args = sys.argv[1:]
    if not args or args[0] != 'bridge':
        os.execv(real, [real] + args)
    data = args[args.index('--data') + 1]
    info_path = os.path.join(data, 'keeper', 'keeper.json')

    def read_info():
        try:
            with open(info_path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def dial(info):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(info['address'])
        return s

    info, sock = read_info(), None
    if info and alive(info.get('pid', 0)):
        try:
            sock = dial(info)
        except OSError:
            sock = None
    if sock is None:
        os.makedirs(data, mode=0o700, exist_ok=True)
        log = open(os.path.join(data, 'serve.log'), 'ab')
        subprocess.Popen([real, 'serve', '--data', data, '--exit-after', '20s', '--orphan-after', '60s'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
        deadline = time.time() + 15
        while time.time() < deadline and sock is None:
            time.sleep(0.05)
            info = read_info()
            if info and alive(info.get('pid', 0)):
                try:
                    sock = dial(info)
                except OSError:
                    sock = None
        if sock is None:
            sys.stderr.write('stand-in bridge: the keeper did not start\n')
            sys.exit(1)
    out = sys.stdout.buffer
    preamble = {'ev': 'bridge', 'bridge': 1, 'keeper': info.get('keeper', ''), 'pid': info['pid'], 'token': info['token'],
                'home': os.environ.get('HOME', ''), 'uid': os.getuid(), 'arch': os.uname().machine}
    out.write(MAGIC + json.dumps(preamble).encode() + b'\n')
    out.flush()
    if '--hold' in args:
        sys.stdin.buffer.read()
        return

    def up():
        try:
            while True:
                chunk = os.read(0, 65536)
                if not chunk:
                    break
                sock.sendall(chunk)
        except OSError:
            pass
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=up, daemon=True).start()
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            os.write(1, chunk)
    except OSError:
        pass


if __name__ == '__main__':
    main()
