"""A fake npm-cli.js for the installer tests (run as `python fake_npm.py <npm arguments>`; the test passes python as "node"). Never touches the network.

FAKE_NPM_MODE: ok (default), slow (writes files for FAKE_NPM_DELAY seconds first), hang (starts a grandchild, then waits for ever), fail (npm-style error).
FAKE_NPM_LOG: a file every run appends its arguments to. FAKE_NPM_CHILD: where hang mode writes its grandchild's pid."""
import json
import os
import pathlib
import subprocess
import sys
import time

args = sys.argv[1:]
log = os.environ.get('FAKE_NPM_LOG')
if log:
    with open(log, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps({'args': args, 'cwd': os.getcwd(), 'pid': os.getpid()}) + '\n')
prefix = pathlib.Path(args[args.index('--prefix') + 1]) if '--prefix' in args else pathlib.Path.cwd()
manifest = json.loads((prefix / 'package.json').read_text(encoding='utf-8'))
package, version = next(iter(manifest['dependencies'].items()))
mode = os.environ.get('FAKE_NPM_MODE', 'ok')
folder = prefix / 'node_modules' / pathlib.Path(*package.split('/'))


def write_package(bin_value='dist/index.js'):
    (folder / 'dist').mkdir(parents=True, exist_ok=True)
    (folder / 'package.json').write_text(json.dumps({'name': package, 'version': os.environ.get('FAKE_NPM_VERSION', version), 'bin': {'adapter': bin_value}}), encoding='utf-8')
    (folder / 'dist' / 'index.js').write_text('// fake adapter\n', encoding='utf-8')


if mode == 'fail':
    print('npm error code ENOTFOUND', file=sys.stderr)
    print('npm error network request to https://registry.npmjs.org failed', file=sys.stderr)
    sys.exit(1)
if mode in ('hang', 'slow'):
    (folder / 'dist').mkdir(parents=True, exist_ok=True)
    (folder / 'dist' / 'partial.bin').write_bytes(b'x' * 200000)   # a half-made install
if mode == 'hang':
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])
    if os.environ.get('FAKE_NPM_CHILD'):
        pathlib.Path(os.environ['FAKE_NPM_CHILD']).write_text(str(child.pid), encoding='utf-8')
    time.sleep(300)
if mode == 'slow':
    time.sleep(float(os.environ.get('FAKE_NPM_DELAY', '2')))
write_package()
