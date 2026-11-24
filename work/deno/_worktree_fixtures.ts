/**
 * Temp git repos and a fake studio for the worktree tests (work/deno/worktrees_test.ts, worktree_merge*_test.ts, worktree_sync*_test.ts), as
 * work/test_worktree_chat.py builds them: a repo with tracked.txt and a .gitignore, a temp state folder. Only temp folders.
 */
import { pathOf } from '../../app/server/state/paths.ts';
import { dirname } from '../../app/server/platform/ospath.ts';
import type { MergeHost } from '../../app/server/worktrees/merge.ts';
import { WORK } from './_work.ts';
import { lockHelperArgs } from './_fakes.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';

/** Fixed git dates: identical repos give byte-identical commits. */
export const FIXED_DATES = { GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };

export function setFixedDates(on: boolean): void {
  for (const [k, v] of Object.entries(FIXED_DATES)) {
    on ? Deno.env.set(k, v) : Deno.env.delete(k);
  }
}

/** run_git as the old tests did: identity t, autocrlf off; throws on failure; stdout with universal newlines. */
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

/** Path.read_text(): universal newlines, as the old tests read files. */
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

/** A temp folder (resolved) with state/ and a repo proj/; removed by dispose. */
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
export class FakeAib implements MergeHost {
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

/** The two lock files a merge or a live sync takes for a worktree: the project's pause flag and the worktree's own lock. */
function lockPaths(state: string, project: string, record: Record<string, unknown>): { pause: string; worktree: string } {
  return {
    pause: wt.pauseLock(state, project, 0).path,
    worktree: wt.worktreeLock(state, record as unknown as wt.WorktreeRecord, 0).path,
  };
}

/** Another process (work/fakes/lock_helper.ts, no AIB code) takes the lock on `path` and keeps it until stdin closes. */
async function holdOne(path: string): Promise<() => Promise<void>> {
  const child = new Deno.Command(Deno.execPath(), { args: lockHelperArgs('hold', path), stdin: 'piped', stdout: 'piped' }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  if (!value?.includes('locked')) throw new Error(`the lock helper did not lock ${path}: ${value}`);
  return async () => {
    await child.stdin.close();
    reader.releaseLock();
    await child.stdout.cancel().catch(() => {});
    await child.status;
  };
}

/** Another process holds the project's pause lock and the worktree's lock; resolves once it holds both. release() lets them go. */
export async function foreignHolds(
  state: string,
  project: string,
  record: Record<string, unknown>,
): Promise<{ release: () => Promise<void> }> {
  const paths = lockPaths(state, project, record);
  const releasePause = await holdOne(paths.pause);
  const releaseWorktree = await holdOne(paths.worktree);
  return { release: async () => (await releaseWorktree(), await releasePause()) };
}

/** Whether another process can take a lock on `path` within `seconds`. */
async function foreignCanLock(path: string, seconds: number): Promise<boolean> {
  const out = await new Deno.Command(Deno.execPath(), { args: lockHelperArgs('try', path, String(seconds)), stdout: 'piped' }).output();
  return new TextDecoder().decode(out.stdout).trim() === 'yes';
}

/**
 * What another process sees of the two locks: {pause, worktree, paused}. 'probe' looks once; 'settle' waits up to 60 s for each to
 * be free (a merge still holding them). paused is true while the pause lock is held (the "sync paused" flag).
 */
export async function foreignProbe(state: string, project: string, record: Record<string, unknown>, mode: 'probe' | 'settle') {
  const paths = lockPaths(state, project, record);
  const seconds = mode === 'settle' ? 60 : 0.05;
  const pause = (await foreignCanLock(paths.pause, seconds)) ? 'free' : 'held';
  const worktree = (await foreignCanLock(paths.worktree, seconds)) ? 'free' : 'held';
  const paused = !(await foreignCanLock(paths.pause, mode === 'settle' ? 60 : 0.05));
  return { pause, worktree, paused };
}
