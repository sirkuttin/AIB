/**
 * Shared by worktree_sync_test.ts and worktree_sync_interop_test.ts (one file split in two so the halves run in parallel): a
 * project with worktree chats over a fake studio, and the small helpers both use. Only temp folders.
 */
import { commit, read, runGit, Sandbox, write } from './_worktree_fixtures.ts';
import * as wt from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import * as sync from '../../outputs/agent-studio/server/worktrees/sync.ts';

export const { LiveSync, ProjectSync } = sync;

export const LINES = 'a\nb\nc\nd\ne\nf\n';
export const USER_EDIT = 'A-user\nb\nc\nd\ne\nf\n';
export const CHAT_EDIT = 'a\nb\nc\nd\ne\nf-chat\n';
export const BOTH = 'A-user\nb\nc\nd\ne\nf-chat\n';
export const WIN = Deno.build.os === 'windows';

export class Conn implements sync.SyncConnection {
  closed = false;
  worktree: unknown = true;
  state: Record<string, unknown> = { state: 'ready', busy: false };
  constructor(readonly cwd: string) {}
  public(): unknown {
    return { ...this.state };
  }
}

export interface Ctx {
  box: Sandbox;
  manager: wt.Manager;
  live: sync.LiveSync;
  studio: sync.SyncStudio & { flag: { on: boolean }; connections: Map<string, Conn> };
  conns: Conn[];
  wts: string[];
  keys: string[];
  ps: sync.ProjectSync;
  scan: () => Promise<void>;
  /** Two scans in a row: whatever changed is stable and synced. */
  settle: () => Promise<void>;
  record: (n?: number) => wt.WorktreeRecord & { key: string };
}

export function text(folder: string, name: string): string | null {
  try {
    return read(folder, name);
  } catch {
    return null;
  }
}

export function exists(path: string): boolean {
  return wt.lexists(path);
}

/** A project with f.txt (and, for G3, bin.dat and g.txt) and `chats` worktree chats; a LiveSync over a fake studio (no watcher). */
export async function setup(box: Sandbox, chats = 1, g3 = false, setupProject?: (project: string) => void): Promise<Ctx> {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  commit(box.project, 'f.txt', LINES, 'add f');
  if (g3) {
    write(box.project, 'bin.dat', new Uint8Array([0, 98, 97, 115, 101, 0]));
    write(box.project, 'g.txt', 'g1\ng2\n');
    runGit(box.project, 'add', '-A');
    runGit(box.project, 'commit', '-q', '-m', 'binary and g');
  }
  setupProject?.(box.project);
  const manager = new wt.Manager(box.state);
  const conns: Conn[] = [], wts: string[] = [], keys: string[] = [];
  for (let n = 0; n < chats; n++) {
    const key = String(n).repeat(32);
    const plan = (await manager.plan(box.project, key))!;
    await manager.create(plan);
    conns.push(new Conn(plan.path));
    wts.push(plan.path);
    keys.push(key);
  }
  const studio = {
    stateDir: box.state,
    worktrees: manager,
    flag: { on: true },
    settings: { worktreePerChat: () => studio.flag.on },
    connections: new Map(conns.map((c, i) => [`c${i}`, c])),
  };
  const live = new LiveSync(studio, 0.05, 0.2, false);
  const ps = new ProjectSync(live, box.project);
  const scan = () => ps.lock.run(() => ps.scan());
  const ctx: Ctx = {
    box,
    manager,
    live,
    studio,
    conns,
    wts,
    keys,
    ps,
    scan,
    settle: async () => {
      await scan();
      await scan();
    },
    record: (n = 0) => ({ ...manager.registry.get(keys[n])!, key: keys[n] }),
  };
  await scan(); // the baseline
  return ctx;
}

export async function until(check: () => unknown | Promise<unknown>, what: string, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export const show = (ctx: Ctx, spec: string) => runGit(ctx.box.project, 'show', spec);
export const touched = async (ctx: Ctx, n = 0) => (await wt.touchedPaths(ctx.wts[n], wt.diffBase(ctx.record(n)))).length;
export const note = (ctx: Ctx, n = 0) => ctx.live.contextFor(ctx.conns[n])?.[0] ?? '';
export const list = (value: unknown) => (Array.isArray(value) ? value : []);
