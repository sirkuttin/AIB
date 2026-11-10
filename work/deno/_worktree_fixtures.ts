/**
 * Temp git repos and a fake studio for the worktree tests (work/deno/worktrees_test.ts, worktree_merge*_test.ts, worktree_sync*_test.ts), as
 * work/test_worktree_chat.py builds them: a repo with tracked.txt and a .gitignore, a temp state folder. Only temp folders.
 */
import { pathOf } from '../../outputs/agent-studio/server/state/paths.ts';
import { dirname } from '../../outputs/agent-studio/server/platform/ospath.ts';
import type { MergeStudio } from '../../outputs/agent-studio/server/worktrees/merge.ts';
import { python, WORK } from './_parity.ts';

/** Fixed git dates: Python and Deno make byte-identical commits from identical repos. */
export const FIXED_DATES = { GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };

export function setFixedDates(on: boolean): void {
  for (const [k, v] of Object.entries(FIXED_DATES)) {
    on ? Deno.env.set(k, v) : Deno.env.delete(k);
  }
}

/** run_git of the Python tests: identity t, autocrlf off; throws on failure; stdout with universal newlines. */
export function runGit(cwd: string, ...args: string[]): string {
  const done = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
    cwd,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\r\n?/g, '\n');
  if (done.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${text(done.stderr)}`);
  }
  return text(done.stdout);
}

/** The same without failing: [code, stdout]. */
export function tryGit(cwd: string, ...args: string[]): [number, string] {
  const done = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  return [done.code, new TextDecoder().decode(done.stdout)];
}

export function write(folder: string, name: string, text: string | Uint8Array): void {
  const path = pathOf(folder, name);
  Deno.mkdirSync(dirname(path), { recursive: true });
  typeof text === 'string' ? Deno.writeTextFileSync(path, text) : Deno.writeFileSync(path, text);
}

/** Path.read_text(): universal newlines, as the Python tests read files. */
export function read(folder: string, name: string): string {
  return Deno.readTextFileSync(pathOf(folder, name)).replace(/\r\n?/g, '\n');
}

export function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function commit(folder: string, name: string, text: string, message = 'work'): void {
  write(folder, name, text);
  runGit(folder, 'add', '-A');
  runGit(folder, 'commit', '-m', message);
}

export function makeRepo(folder: string): string {
  Deno.mkdirSync(folder, { recursive: true });
  runGit(folder, 'init', '-q', '-b', 'main');
  write(folder, 'tracked.txt', 'one\n');
  write(folder, '.gitignore', 'ignored.log\nbuild/\nnode_modules/\n');
  runGit(folder, 'add', '-A');
  runGit(folder, 'commit', '-q', '-m', 'first');
  return folder;
}

/** A temp folder (resolved, as the Python tests' .resolve()) with state/ and a repo proj/; removed by dispose. */
export class Sandbox {
  readonly base: string;
  readonly state: string;
  readonly project: string;

  constructor(repo = true) {
    this.base = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'studio-wt-test-' }));
    this.state = pathOf(this.base, 'state');
    this.project = pathOf(this.base, 'proj');
    if (repo) makeRepo(this.project);
  }

  status(folder = this.project): string {
    return runGit(folder, 'status', '--porcelain=v1', '-uall');
  }

  branches(): string[] {
    return runGit(
      this.project,
      'branch',
      '--list',
      'studio/*',
      '--format=%(refname:short)',
    ).split(/\s+/).filter(Boolean);
  }

  stashes(folder = this.project): string[] {
    return runGit(folder, 'stash', 'list', '--format=%H %gs').split('\n')
      .filter(Boolean);
  }

  [Symbol.dispose](): void {
    try {
      Deno.removeSync(this.base, { recursive: true });
    } catch { /* a file still held: the OS temp cleanup gets it */ }
  }
}

/** A studio for Merge: one or more chats with a public state (ready unless set otherwise); records every live call. */
export class FakeStudio implements MergeStudio {
  readonly calls: [string, Record<string, unknown>][] = [];
  readonly states = new Map<string, Record<string, unknown>>();
  answer: [number, unknown] = [200, {}];

  constructor(readonly stateDir: string) {}

  add(id: string, cwd: string, extra: Record<string, unknown> = {}): void {
    this.states.set(id, { state: 'ready', busy: false, cwd, provider: 'claude', ...extra });
  }

  liveState(id: string): unknown {
    const state = this.states.get(id);
    if (!state) throw new Error(`unknown chat ${id}`);
    return { ...state };
  }

  liveCall(op: string, payload: Record<string, unknown>): [number, unknown] {
    this.calls.push([op, payload]);
    return this.answer;
  }

  notes(): string[] {
    return this.calls.filter(([op]) => op === 'worktree-note').map(([, p]) => p.message as string);
  }

  prompts(): string[] {
    return this.calls.filter(([op]) => op === 'prompt').map(([, p]) => p.text as string);
  }
}

/** Python's HOLDER script of test_worktree_userbase.py: holds or probes the pause and worktree locks from another process. */
export const HOLDER = `
import json, sys
sys.path.insert(0, sys.argv[1])
import worktrees
state, project, record = sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
which = sys.argv[5]
if which == 'hold':
    locks = [worktrees.pause_lock(state, project, 5), worktrees.worktree_lock(state, record, 5)]
    for lock in locks:
        lock.acquire()
    print('held', flush=True)
    sys.stdin.readline()
else:
    import time
    deadline = time.monotonic() + (60 if which == 'settle' else 0)

    def free(make):
        while True:
            lock = make()
            try:
                lock.acquire()
                lock.release()
                return True
            except OSError:
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.05)
    out = {'pause': 'free' if free(lambda: worktrees.pause_lock(state, project, 0)) else 'held',
           'worktree': 'free' if free(lambda: worktrees.worktree_lock(state, record, 0)) else 'held'}
    while True:
        out['paused'] = worktrees.sync_paused(state, project)
        if not out['paused'] or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    print(json.dumps(out), flush=True)
`;

const APP_DIR = new URL('python-reference/', WORK).pathname.replace(/^\/([A-Za-z]:)/, '$1'); // the Python reference

/** Starts the holder in 'hold' mode; resolves once it holds both locks. release() lets it go. */
export async function pythonHolds(
  state: string,
  project: string,
  record: Record<string, unknown>,
): Promise<{ release: () => Promise<void> }> {
  const child = new Deno.Command(python(), {
    args: ['-c', HOLDER, APP_DIR, state, project, JSON.stringify(record), 'hold'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'inherit',
    env: { AGENT_STUDIO_TEST: '1' },
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  while (!text.includes('held')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('holder exited');
    text += value;
  }
  return {
    release: async () => {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode('\n'));
      await writer.close();
      reader.releaseLock();
      await child.stdout.cancel().catch(() => {});
      await child.status;
    },
  };
}

/** Runs the holder in 'probe' (look once) or 'settle' mode: {pause, worktree, paused}. */
export async function pythonProbe(state: string, project: string, record: Record<string, unknown>, mode: 'probe' | 'settle') {
  const done = await new Deno.Command(python(), {
    args: ['-c', HOLDER, APP_DIR, state, project, JSON.stringify(record), mode],
    stdin: 'null',
    stdout: 'piped',
    stderr: 'inherit',
    env: { AGENT_STUDIO_TEST: '1' },
  }).output();
  return JSON.parse(new TextDecoder().decode(done.stdout));
}
