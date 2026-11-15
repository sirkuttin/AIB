/**
 * The worktree per chat for WSL projects (docs/wsl/design.md section 4 phase 2, section 5 item 3): worktrees/worktrees.ts runs whole
 * here, natively in the distro, with Linux path rules. Its registry is `<data>/studio-worktrees.json` and its root `<data>/worktrees`
 * (data = the Linux keeper's data folder of this Windows AIB, `~/.aib-server/data-<hash>`), so the records live next to the keeper
 * that holds the chats and survive any AIB restart; the "only inside the root" checks of Manager compare real Linux paths,
 * case-sensitively, and a worktree is always on the distro's own disk, next to its repository's distro (never under /mnt/c).
 *
 * AIB calls these through its WSL host (wsl/worktrees.ts). Paths in and out are Linux paths; AIB turns them into refs.
 */
import * as osp from '../../platform/ospath.ts';
import * as wt from '../../worktrees/worktrees.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';

import type { WorktreePlanJson as PlanJson } from '../contract.ts';

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const SLUG = /^(chat|helper)-[A-Za-z0-9_-]{1,8}(-\d{1,6})?$/;

export function planJson(plan: wt.Plan): PlanJson {
  return {
    project: plan.project,
    base: plan.base,
    key: plan.key,
    slug: plan.slug,
    branch: plan.branch,
    path: plan.path,
    folderBranch: plan.folderBranch,
    note: plan.note,
  };
}

/** /mnt/<drive>/…: WSL's view of a Windows drive. */
export function onWindowsDrive(path: string): boolean {
  return /^\/mnt\/[A-Za-z](\/|$)/.test(path);
}

function absPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !osp.isabs(value)) {
    throw new RpcError(`${name} must be an absolute path`, BAD_PARAMS);
  }
  return osp.normpath(value);
}

function key(params: Record<string, unknown>): string {
  const k = str(params, 'key');
  if (!KEY.test(k)) throw new RpcError('key is not a worktree key', BAD_PARAMS);
  return k;
}

function session(params: Record<string, unknown>): string | null {
  const s = str(params, 'session', true);
  if (s.length > 600) throw new RpcError('session is too long', BAD_PARAMS);
  return s || null;
}

/**
 * The Plan AIB sends back for create(), rebuilt and checked against what plan() would have made: the folder must be exactly
 * <root>/<repo hash>/<slug> and the branch studio/<slug>, so nothing from the channel can point a worktree (or its later removal)
 * anywhere else.
 */
export function planFrom(manager: wt.Manager, raw: unknown): wt.Plan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RpcError('plan must be an object', BAD_PARAMS);
  const p = raw as Record<string, unknown>;
  const text = (name: string, max = 255) => {
    const v = p[name];
    if (typeof v !== 'string' || v.length > max || v.includes('\0') || v.includes('\n')) throw new RpcError(`plan.${name} must be a string`, BAD_PARAMS);
    return v;
  };
  const project = absPath(p.project, 'plan.project');
  const slug = text('slug'), k = text('key'), branch = text('branch'), base = text('base'), folderBranch = text('folderBranch');
  const note = text('note', 2000);
  if (!SLUG.test(slug) || !KEY.test(k) || branch !== `studio/${slug}` || !base) throw new RpcError('plan is not a worktree plan', BAD_PARAMS);
  const path = absPath(p.path, 'plan.path');
  const expected = osp.join(manager.registry.root, wt.repoHash(project), slug);
  if (path !== expected) throw new RpcError("plan.path is not inside AIB's worktrees folder", BAD_PARAMS);
  return new wt.Plan(project, base, k, slug, branch, path, folderBranch, note);
}

/** A record as AIB sees it: the registry fields plus its key ({} fields that are not plain JSON are dropped by the channel anyway). */
function recordOut(record: (wt.WorktreeRecord & { key: string }) | null): Record<string, unknown> | null {
  return record ? { ...record } : null;
}

/** The `worktree.*` helper methods over one Manager rooted in `data` (the Linux keeper's data folder). */
export function worktreeMethods(data: string): Handlers {
  const manager = new wt.Manager(data);
  const recordOf = (params: Record<string, unknown>) => {
    const k = key(params);
    const record = manager.registry.get(k);
    return record ? { k, record } : null;
  };
  return {
    'worktree.plan': async (p) => {
      const project = absPath(p.project, 'project');
      const kind = p.kind === 'helper' ? 'helper' : 'chat';
      const asked = str(p, 'key', true);
      if (asked && !KEY.test(asked)) throw new RpcError('key is not a worktree key', BAD_PARAMS);
      // never a worktree across WSL's mount of a Windows drive (9P: slow, and git's file modes and case rules differ there)
      for (const [folder, why] of [[project, 'the project is on a Windows drive'], [manager.registry.root, "AIB's data folder is on a Windows drive"]]) {
        if (onWindowsDrive(folder)) return { plan: null, reason: why };
      }
      const { plan, reason } = await manager.planWithReason(project, asked || null, kind);
      return { plan: plan ? planJson(plan) : null, reason };
    },

    'worktree.create': async (p) => {
      const plan = planFrom(manager, p.plan);
      try {
        await manager.create(plan);
      } catch (error) {
        if (error instanceof wt.Fallback) throw new RpcError(error.message, undefined, { code: 'fallback' });
        throw error;
      }
      return { note: plan.note };
    },

    'worktree.discard': async (p) => {
      await manager.discard(key(p));
      return { ok: true };
    },

    'worktree.setSession': async (p) => {
      const provider = str(p, 'provider'), sessionId = str(p, 'sessionId');
      if (!/^[a-z0-9_-]{1,40}$/.test(provider) || !sessionId || sessionId.length > 512) throw new RpcError('provider and sessionId', BAD_PARAMS);
      await manager.setSession(key(p), provider, sessionId);
      return { ok: true };
    },

    /** The finished record of the worktree at `path`, else the only one of the saved chat `session` ('provider:sessionId'). */
    'worktree.find': (p) => {
      const path = p.path === undefined || p.path === '' ? null : absPath(p.path, 'path');
      return { record: recordOut(manager.registry.find(path, session(p))) };
    },

    'worktree.isRemoved': (p) => ({ removed: manager.isRemoved(absPath(p.workspace, 'workspace'), session(p)) }),

    /** The folder of a recorded worktree, made again from its branch when it was deleted outside AIB (error code 'gone'). */
    'worktree.ensure': async (p) => {
      const found = recordOf(p);
      if (!found) throw new RpcError(wt.GONE_MESSAGE, undefined, { code: 'gone' });
      try {
        return { path: await manager.ensure(found.record) };
      } catch (error) {
        if (error instanceof wt.WorktreeGone) throw new RpcError(error.message, undefined, { code: 'gone' });
        throw error;
      }
    },

    /** Discard (confirmed: --force) or the silent removal of an unchanged worktree; 'removed', 'pending' or 'gone'. */
    'worktree.remove': async (p) => ({ outcome: await manager.remove(key(p), p.confirmed === true) }),

    'worktree.hasChanges': async (p) => {
      const found = recordOf(p);
      return { changes: found ? await manager.hasChanges(found.record) : false };
    },
  };
}

/**
 * At the helper's start, what a Windows AIB does at its own start: worktrees an earlier helper died in the middle of making are
 * removed, pending removals are retried, and `git worktree prune` runs for the projects with worktrees. Nothing happens when this
 * data folder has no registry yet. Never throws.
 */
export async function worktreeStartup(data: string): Promise<void> {
  try {
    const manager = new wt.Manager(data);
    try {
      Deno.statSync(manager.registry.path);
    } catch {
      return;
    }
    await manager.cleanupIncomplete();
    await manager.retryPending();
  } catch (error) {
    console.error(`AIB-wsl-helper: cleaning up worktrees failed (${error instanceof Error ? error.message : error})`);
  }
}
