/**
 * Merge for the worktree per chat of WSL projects (docs/wsl/design.md section 4 phase 2, section 5 item 1): worktrees/merge.ts runs
 * whole here, natively in the distro, over the same `<data>` folder as the worktree registry (helper/worktrees.ts). So the repository
 * lock, the chat's worktree lock, the "sync paused" lock and the clash records (`<data>/worktree-clashes.json`) are all in the distro,
 * next to the worktrees they guard, and every git step (commit, bring main in, replay, stash and re-apply the user's edits in the main
 * checkout, fast-forward, reset the copy) runs with Linux git on Linux paths. Nothing in merge.ts is changed for this.
 *
 * merge.ts asks its MergeStudio for the chat's state and posts to the chat through it. Here the state is what AIB sent with the call
 * (its `cwd` the worktree's Linux path), and the posts are recorded and handed back to AIB in order (`actions`), which posts them to
 * the chat exactly as merge.ts would on Windows. A conflict prompt merge.ts must get accepted is marked `must`, with the line AIB
 * refuses with when the chat does not take it. Live sync does not run for WSL chats: the user base stays the snapshot until a merge
 * moves it, so a merge lands the chat's own commits, and the user's uncommitted edits in the main checkout are stashed and put back
 * as on Windows (never overwritten; a clash keeps them in the named stash).
 */
import * as osp from '../../platform/ospath.ts';
import * as merge from '../../worktrees/merge.ts';
import { isDict } from '../../core/py.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';
import type { WslMergeAnswer } from '../contract.ts';

type Action = WslMergeAnswer['actions'][number];

/** A MergeStudio over the state AIB sent; every live call is recorded (and accepted) for AIB to make. */
export class RecordingStudio implements merge.MergeStudio {
  readonly actions: Action[] = [];
  constructor(readonly stateDir: string, readonly state: Record<string, unknown>) {}

  liveState(_chatId: string): unknown {
    return { ...this.state };
  }

  liveCall(op: string, payload: Record<string, unknown>): [number, unknown] {
    this.actions.push({ op, payload: { ...payload } });
    return [200, op === 'queue' ? { queued: false } : { ok: true }];
  }
}

function chatId(params: Record<string, unknown>): string {
  const id = str(params, 'chat');
  if (!id || id.length > 200) throw new RpcError('chat must be a chat id', BAD_PARAMS);
  return id;
}

/** The chat's public state as AIB sent it; its cwd must be an absolute Linux path (the worktree, or the folder it works in). */
function stateOf(params: Record<string, unknown>): Record<string, unknown> {
  const state = params.state;
  if (!isDict(state)) throw new RpcError('state must be an object', BAD_PARAMS);
  const cwd = state.cwd;
  if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || cwd.includes('\0') || !osp.isabs(cwd)) {
    throw new RpcError('state.cwd must be an absolute path', BAD_PARAMS);
  }
  return { ...state, cwd: osp.normpath(cwd) };
}

/** Marks the conflict prompts merge.ts needs accepted (state 'conflicts'), with the line it refuses with otherwise. */
function marked(actions: Action[], result: Record<string, unknown> | undefined): Action[] {
  if (!result || result.state !== 'conflicts') return actions;
  return actions.map((a) => {
    if (a.op !== 'prompt') return a;
    const text = typeof a.payload.text === 'string' ? a.payload.text : '';
    const fail = text.startsWith('Merging stopped:')
      ? 'Could not ask the chat to rework its change: '
      : 'Could not ask the chat to resolve the conflicts: ';
    return { ...a, must: true, fail };
  });
}

async function answer(studio: RecordingStudio, work: () => Promise<Record<string, unknown>>): Promise<WslMergeAnswer> {
  try {
    const result = await work();
    return { result, actions: marked(studio.actions, result) };
  } catch (error) {
    if (error instanceof merge.Refused) {
      return { refused: { message: error.message, code: error.code, status: error.status, extra: { ...error.extra } }, actions: studio.actions };
    }
    throw error;
  }
}

/** The `merge.*` helper methods over `data` (the Linux keeper's data folder: the worktree registry's folder). */
export function mergeMethods(data: string): Handlers {
  const studio = (p: Record<string, unknown>) => new RecordingStudio(data, stateOf(p));
  return {
    'merge.status': async (p) => {
      const id = chatId(p);
      return { result: await merge.status(studio(p), id) };
    },

    /** The Merge itself: the agent's merge_into_project (fromTool), or the page's direct merge route. */
    'merge.run': async (p) => {
      const id = chatId(p), s = studio(p);
      const title = str(p, 'title', true).slice(0, 500);
      return await answer(s, () => p.fromTool === true ? merge.mergeFromTool(s, id) : merge.merge(s, id, title, false));
    },

    /** The Merge button: the checks of requestMerge here; the queued message is AIB's to send (`actions`). */
    'merge.request': async (p) => {
      const id = chatId(p), s = studio(p);
      const blocked = str(p, 'blocked', true).slice(0, 500);
      return await answer(s, () => merge.requestMerge(s, id, { blocked: () => blocked }));
    },

    'merge.resolveClash': async (p) => {
      const id = chatId(p), s = studio(p);
      return await answer(s, () => merge.resolveClash(s, id, str(p, 'action'), p.fromTool === true));
    },

    /** The amber line of a WSL project folder (its Linux path): an unresolved clash after a merge. Read only. */
    'merge.clashStatus': async (p) => {
      const project = str(p, 'project');
      if (!project || project.length > 4096 || !osp.isabs(project)) throw new RpcError('project must be an absolute path', BAD_PARAMS);
      return { result: await merge.clashStatus({ stateDir: data }, osp.normpath(project)) };
    },
  };
}
