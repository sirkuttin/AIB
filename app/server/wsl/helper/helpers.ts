/**
 * Helpers (swarm builders: other agents' chats, each in its own worktree) for WSL projects, the distro's side (owner 2026-11-25:
 * "make AIB helpers work in WSL projects"). A helper's chat is an ordinary WSL chat: its worktree is a `worktree.*` record
 * (kind 'helper', branch studio/helper-...), made by helper/worktrees.ts. What the swarm (swarm/service.ts) does to a helper's
 * worktree with git on Windows paths it asks for here, with Linux git on Linux paths:
 *
 *   helper.keep     stop: the worktree's uncommitted work is committed on its branch; how many commits it has over its start
 *   helper.land     a closed helper's work lands from its record (worktrees/subagent_land.ts, as a subagent's does)
 *   helper.facts    what the swarm reads: branch tips, dirty files, the target branch, the report's counts, files a landing changed
 *   helper.work     unlanded work (worktrees/subagent_work.ts): status, a patch, or the work kept on studio/discarded/<name>
 *   helper.branch   drop a helper's branch (or its `-landable` branch) once its work is in the target
 *   helper.apply    Undo / Merge again (swarm/undo.ts applyChange)
 *
 * An open helper's own landing is `merge.run` with `held`/`builder` (helper/merge.ts). Every call names the worktree by its registry
 * key (the record AIB's own manager made: its branch must be a studio/helper- one) or the project's Linux path; nothing from the channel
 * can point git, a branch name or a removal outside those. All of it runs in the one helper process, so the repository lock
 * (worktrees/merge.ts repoLock) is the same one a merge and a subagent landing take: one landing at a time per project folder.
 */
import * as osp from '../../platform/ospath.ts';
import * as wt from '../../worktrees/worktrees.ts';
import * as merge from '../../worktrees/merge.ts';
import { landSubagentWork } from '../../worktrees/subagent_land.ts';
import { keepWork, workDiff, workStatus } from '../../worktrees/subagent_work.ts';
import { applyChange } from '../../swarm/undo.ts';
import { isDict } from '../../core/py.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';
import { onWindowsDrive } from './worktrees.ts';
import type { WslMergeAnswer } from '../contract.ts';

type Json = Record<string, unknown>;

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const HELPER_BRANCH = /^studio\/helper-[A-Za-z0-9_-]{1,8}(-\d{1,6})?(-landable)?$/;
const REV = /^[0-9a-f]{7,64}$/;
const TARGET = /^[A-Za-z0-9._/-]{1,200}$/;

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

function absPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !osp.isabs(value)) {
    throw new RpcError(`${name} must be an absolute path`, BAD_PARAMS);
  }
  const path = osp.normpath(value);
  if (onWindowsDrive(path)) throw new RpcError(`${name} is on a Windows drive`, BAD_PARAMS);
  return path;
}

const nul = (t: string) => t.split('\0').filter(Boolean);

/** A MergeStudio over the states AIB sent (every chat of the folder AIB holds, by id); live calls are recorded. */
class StatesHost implements merge.MergeHost {
  readonly actions: WslMergeAnswer['actions'] = [];
  constructor(readonly stateDir: string, readonly states: Json) {}
  liveState(chatId: string): unknown {
    const s = this.states[chatId];
    return isDict(s) ? { ...s } : null;
  }
  liveCall(op: string, payload: Json): [number, unknown] {
    this.actions.push({ op, payload: { ...payload } });
    return [200, op === 'queue' ? { queued: false } : { ok: true }];
  }
}

export function helperMethods(data: string): Handlers {
  const registry = new wt.Registry(data);

  /** The helper worktree record of `key`: AIB's own, a studio/helper- branch. */
  const recordOf = (p: Json, required = true) => {
    const key = str(p, 'key', !required);
    if (!key) return null;
    if (!KEY.test(key)) throw new RpcError('key is not a worktree key', BAD_PARAMS);
    const record = registry.get(key);
    if (!record) return null;
    const branch = String(record.branch ?? '');
    if (!HELPER_BRANCH.test(branch) || !osp.isabs(String(record.path ?? '')) || !osp.isabs(String(record.project ?? ''))) {
      throw new RpcError("that is not one of AIB's helper worktrees", BAD_PARAMS);
    }
    return {
      key,
      path: osp.normpath(String(record.path)),
      project: osp.normpath(String(record.project)),
      branch,
      start: String(record.snapshot ?? ''),
      base: String(record.base ?? ''),
      landOn: String(record.landOn ?? ''),
      record,
    };
  };

  /** Commit what is uncommitted in the worktree; returns how many commits its branch has over its start. */
  const keepCommit = async (path: string, start: string, message: string): Promise<number> => {
    if ((await merge.porcelainPaths(path)).size) {
      await wt.git(['add', '-A'], path);
      await wt.unstageLineEndingOnly(path, 'HEAD'); // line-ending churn is not the helper's work
      const staged = await wt.git(['diff', '--cached', '--name-only'], path, { check: false });
      if (staged.stdout.trim()) await merge.gitc(['commit', '-q', '-m', message], path, { check: false });
    }
    const count = await wt.git(['rev-list', '--count', `${start}..HEAD`], path, { check: false });
    return Number(count.stdout.trim()) || 0;
  };

  return {
    /** Stop: the work is committed on the helper's branch. {commits}. */
    'helper.keep': async (p) => {
      const r = recordOf(p);
      if (!r || !wt.lexists(r.path)) return { commits: 0 };
      return { commits: await keepCommit(r.path, r.start, text(p.message, 300) || 'AIB: helper work kept') };
    },

    /**
     * A closed helper's work lands from its recorded worktree and branch, as a subagent's does (swarm/service.ts #landByRecord): its
     * uncommitted work is committed first, every file lands (a helper's job is the files it was given). {outcome, journal, actions,
     * counted, branchTip}; a refusal, a conflict (with a `-landable` branch) and a dirty file are answers, not errors.
     */
    'helper.land': async (p) => {
      const r = recordOf(p);
      if (!r || !wt.lexists(r.path)) {
        return {
          outcome: { state: 'refused', code: 'gone', message: 'its worktree is gone' },
          journal: [],
          actions: [],
          counted: 0,
          branchTip: '',
        };
      }
      const target = str(p, 'target');
      if (!TARGET.test(target) || target.startsWith('-')) throw new RpcError('target must be a branch name', BAD_PARAMS);
      const id = str(p, 'id');
      if (!ID.test(id)) throw new RpcError('id must be an id', BAD_PARAMS);
      const held = Array.isArray(p.held) ? p.held.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 50) : [];
      const aib = new StatesHost(data, isDict(p.states) ? p.states : {});
      const journal: { stage: string; data: Json }[] = [];
      await keepCommit(r.path, r.start, 'AIB: helper work kept');
      const outcome = await landSubagentWork(
        aib,
        {
          scratchDir: data,
          path: r.path,
          folder: r.project,
          target,
          branch: r.branch,
          parent: str(p, 'parent'),
          key: `helper:${id}`,
          title: text(p.title, 500),
          start: r.start,
          held,
          landKept: null,
          landScratch: true,
        },
        (stage, d) => {
          journal.push({ stage, data: { ...d } });
        },
      );
      let counted = 0, branchTip = '';
      if (outcome.state === 'merged') {
        counted = Number((await wt.git(['rev-list', '--count', `${r.start}..HEAD`], r.path, { check: false })).stdout.trim()) || 0;
        branchTip = await merge.rev(r.path, 'HEAD').catch(() => '');
      }
      return { outcome, journal, actions: aib.actions, counted, branchTip };
    },

    /**
     * What the swarm reads of a helper's repository (read only). `key` names the worktree record; without one (its record is gone)
     * `project`, `branch` and `path` say where to look. Everything that does not apply is absent or empty.
     */
    'helper.facts': async (p) => {
      const r = recordOf(p, false);
      const project = r ? r.project : absPath(p.project, 'project');
      const branch = r ? r.branch : text(p.branch, 100);
      if (!HELPER_BRANCH.test(branch)) throw new RpcError('branch is not a helper branch', BAD_PARAMS);
      const path = r ? r.path : p.path ? absPath(p.path, 'path') : '';
      const start = text(p.start, 64) || r?.start || '';
      const out: Json = { projectExists: wt.lexists(project), worktreeExists: !!path && wt.lexists(path), record: !!r };
      if (!out.projectExists) return out;
      const tip = (ref: string) => merge.rev(project, ref);
      const branchTip = await tip(`refs/heads/${branch}`);
      const landableTip = HELPER_BRANCH.test(`${branch}-landable`) ? await tip(`refs/heads/${branch}-landable`) : '';
      Object.assign(out, { branchTip, landableTip });
      const base = r?.base || text(p.base, 100);
      const asked = text(p.target, 200);
      const target = asked && TARGET.test(asked) && !asked.startsWith('-')
        ? asked
        : r
        ? await merge.targetBranch(project, base || 'main', r.record)
        : await wt.mainBranch(project, base || 'main');
      const targetTip = await tip(`refs/heads/${target}`);
      Object.assign(out, { target, targetTip });
      if (branchTip && targetTip) out.branchInTarget = await merge.isAncestor(project, branchTip, `refs/heads/${target}`);
      if (landableTip && targetTip) out.landableInTarget = await merge.isAncestor(project, landableTip, `refs/heads/${target}`);
      const landed = text(p.landed, 64);
      if (landed && REV.test(landed) && branchTip) {
        out.sameTreeAsLanded = (await wt.git(['diff', '--quiet', landed, branchTip], project, { check: false })).returncode === 0;
      }
      if (landed && REV.test(landed) && targetTip) out.landedInTarget = await merge.isAncestor(project, landed, `refs/heads/${target}`);
      const tipBefore = text(p.tipBefore, 64);
      if (landed && tipBefore && REV.test(landed) && REV.test(tipBefore)) {
        out.changed = nul((await wt.git(['diff', '--name-only', '-z', tipBefore, landed], project, { check: false })).stdout);
        out.commitsBetween =
          Number((await wt.git(['rev-list', '--count', `${tipBefore}..${landed}`], project, { check: false })).stdout.trim()) || 0;
      }
      if (landed && REV.test(landed)) out.parentOfLanded = await tip(`${landed}~${Math.max(1, Math.min(1000, Number(p.commits) || 1))}`);
      out.folderBranch = (await wt.git(['symbolic-ref', '--short', '-q', 'HEAD'], project, { check: false })).stdout.trim();
      if (out.worktreeExists && path) {
        out.headTip = await merge.rev(path, 'HEAD').catch(() => '');
        out.dirty = (await merge.porcelainPaths(path)).size;
        if (start && REV.test(start)) {
          let insertions = 0, deletions = 0;
          const files = await wt.touchedPaths(path, start);
          for (const line of (await wt.git(['diff', '--numstat', start], path, { check: false })).stdout.split(/\r?\n/)) {
            const [a, d] = line.split('\t');
            insertions += Number(a) || 0;
            deletions += Number(d) || 0;
          }
          const commits = Number((await wt.git(['rev-list', '--count', `${start}..HEAD`], path, { check: false })).stdout.trim()) || 0;
          Object.assign(out, { files, insertions, deletions, commits });
        }
      }
      return out;
    },

    /** Unlanded work (worktrees/subagent_work.ts): `status`, `diff` (a patch file in the data folder) or `keep` (on studio/discarded/<name>). */
    'helper.work': async (p) => {
      const r = recordOf(p);
      if (!r || !wt.lexists(r.path) || !wt.lexists(r.project)) return { files: [], landed: false, target: '' };
      const spec = { path: r.path, folder: r.project, start: r.start, branch: r.branch, title: text(p.title, 300), scratchDir: data };
      const op = str(p, 'op');
      const landable = (await merge.rev(r.project, `refs/heads/${r.branch}-landable`)) ? `${r.branch}-landable` : '';
      if (op === 'diff') return { landed: false, landable, ...(await workDiff(spec, `${data}/handoff/${str(p, 'id')}.patch`)) };
      if (op === 'keep') {
        const kept = await keepWork(spec, text(p.name, 80) || r.key);
        return { files: [], landed: false, target: '', branch: kept.branch };
      }
      return { ...(await workStatus(spec)), landable };
    },

    /** Drop a helper's branch (or its `-landable` branch) in `project`. The swarm checked its work is in the target. */
    'helper.branch': async (p) => {
      const project = absPath(p.project, 'project');
      const branch = str(p, 'branch');
      if (!HELPER_BRANCH.test(branch)) throw new RpcError('branch is not a helper branch', BAD_PARAMS);
      if (!wt.lexists(project)) return { dropped: false };
      const done = await wt.git(['branch', '-D', branch], project, { check: false });
      return { dropped: done.returncode === 0 };
    },

    /** Undo / Merge again of a helper's merge: one commit on the target (swarm/undo.ts), built and moved under the repository lock. */
    'helper.apply': async (p) => {
      const project = absPath(p.project, 'project');
      const branch = str(p, 'branch');
      if (!TARGET.test(branch) || branch.startsWith('-')) throw new RpcError('branch must be a branch name', BAD_PARAMS);
      const [from, to] = [str(p, 'from'), str(p, 'to')];
      for (const rev of [from, to]) if (!/^[0-9a-f]{7,64}(\^)?$/.test(rev)) throw new RpcError('from and to must be commits', BAD_PARAMS);
      const held = Array.isArray(p.held) ? p.held.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 50) : [];
      const aib = new StatesHost(data, isDict(p.states) ? p.states : {});
      const outcome = await applyChange(data, project, branch, from, to, text(p.message, 500) || 'AIB: helper change', {
        noStash: p.noStash === true,
        host: aib,
        held,
        title: text(p.title, 500),
      });
      return { outcome: { ...outcome }, actions: aib.actions };
    },
  };
}
