"""Runs the Python suites with one process per test module (contract) or per test class (worktree end to end), several at a time.

    python work/run_parallel.py contract     work/contract/test_*.py, one process per file
    python work/run_parallel.py e2e          work/test_worktree_e2e.py, one process per test class
    options: --jobs N (default 8), --serial (one process, the plain unittest run)

Every process is a plain `python -m unittest <name>` and gets its own temp state folder (AGENT_STUDIO_STATE_DIR is not passed
on, so _isolation.py makes a fresh one), its own servers on free ports and its own temp repos, as when it runs alone. A class
or module already shares its servers between its own tests; this only stops classes from waiting on each other.
AIB_SERVER, AIB_DENO and the rest of the environment are passed on. Exit code 1 if any process failed.
"""
import ast
import concurrent.futures
import os
import pathlib
import subprocess
import sys
import time

WORK = pathlib.Path(__file__).resolve().parent
SUITES = {'contract': WORK / 'contract', 'e2e': WORK}
# Run on their own after the others: test_d_origin checks the artifact origin is on the Studio port + 1, and Windows hands out
# ephemeral ports almost in sequence, so a server started at the same moment often holds that port (the origin then, correctly,
# falls back to another one and the check fails).
ALONE = {'test_contract_artifacts'}


def contract_names():
    return sorted(p.stem for p in (WORK / 'contract').glob('test_*.py'))


def e2e_names():
    """The classes of test_worktree_e2e.py that define test_ methods, read without importing the file."""
    tree = ast.parse((WORK / 'test_worktree_e2e.py').read_text(encoding='utf-8'))
    return [f'test_worktree_e2e.{node.name}' for node in tree.body if isinstance(node, ast.ClassDef) and any(
        isinstance(n, ast.FunctionDef) and n.name.startswith('test') for n in node.body)]


def run(name, cwd):
    env = {k: v for k, v in os.environ.items() if k != 'AGENT_STUDIO_STATE_DIR'}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    started = time.monotonic()
    done = subprocess.run([sys.executable, '-X', 'utf8', '-m', 'unittest', name], cwd=str(cwd), env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    output = done.stdout.decode('utf-8', 'replace')
    summary = next((line for line in reversed(output.splitlines()) if line.startswith(('OK', 'FAILED'))), f'exit code {done.returncode}')
    ran = next((line for line in reversed(output.splitlines()) if line.startswith('Ran ')), '')
    return name, done.returncode == 0, time.monotonic() - started, f'{ran}  {summary}', output


def main(argv):
    suite = argv[0] if argv and not argv[0].startswith('--') else None
    if suite not in SUITES:
        raise SystemExit(__doc__)
    jobs = int(argv[argv.index('--jobs') + 1]) if '--jobs' in argv else 8
    cwd = SUITES[suite]
    if '--serial' in argv:
        target = ['discover', '-s', '.'] if suite == 'contract' else ['test_worktree_e2e']
        return subprocess.call([sys.executable, '-X', 'utf8', '-m', 'unittest', *target], cwd=str(cwd))
    names = contract_names() if suite == 'contract' else e2e_names()
    started = time.monotonic()
    print(f'{len(names)} {suite} groups, {jobs} at a time', flush=True)
    failed = []

    def report(name, ok, seconds, summary, output):
        print(f'{"ok    " if ok else "FAILED"} {seconds:6.1f} s  {name}  {summary}', flush=True)
        if not ok:
            failed.append(name)
            print(f'\n----- {name} -----\n{output}\n----- end of {name} -----\n', flush=True)

    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        for result in pool.map(lambda n: run(n, cwd), [n for n in names if n not in ALONE]):
            report(*result)
    for name in [n for n in names if n in ALONE]:
        report(*run(name, cwd))
    print(f'\n{"FAILED" if failed else "ok"} | {len(names)} groups | {len(failed)} failed | {time.monotonic() - started:.0f} s')
    for name in failed:
        print(f'  failed: {name}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
