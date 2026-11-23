/**
 * Subagent worktrees for WSL projects (owner 2026-11-23: subagents in WSL projects get their own worktree, like Claude Code's and
 * Codex's on Windows). subagents/service.ts runs whole here, natively in the distro, over the same `<data>` folder as the chat worktrees
 * (helper/worktrees.ts): its records are `<data>/subagent-worktrees.json`, its worktrees `<data>/worktrees/<repo hash>/sub-<chat>-<n>`
 * (always the distro's own disk, never /mnt), snapshot S (HEAD plus the folder's uncommitted edits), `studio/sub-...` branches and git
 * locks are made by Linux git on Linux paths, and a subagent lands by the same steps as everywhere (worktrees/subagent_land.ts: own
 * commits only, no folder-snapshot files, a clean `-landable` branch when it conflicts).
 *
 * AIB calls these through wsl/subagents.ts. What a hook decides (which Agent call gets a worktree, when it is bound or ended) stays
 * AIB's: it asks for `subagent.prepare` (a worktree for the chat's next subagent), `subagent.bind`, `subagent.end`, then
 * `subagent.land` when the parent is idle, and `subagent.release` once landed. The chat's facts (id, Linux folder, project) come with
 * each call and are checked here; nothing from the channel can point a worktree, or its removal, outside `<data>/worktrees`.
 */
import * as osp from '../../platform/ospath.ts';
import * as wt from '../../worktrees/worktrees.ts';
import * as merge from '../../worktrees/merge.ts';
import { landSubagentWork } from '../../worktrees/subagent_land.ts';
import { ownSubagentPath, type SubagentChat, SubagentWorktrees } from '../../subagents/service.ts';
import { isDict } from '../../core/py.ts';
import { onWindowsDrive } from './worktrees.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';
import type { WslMergeAnswer } from '../contract.ts';

type Json = Record<string, unknown>;

const ID = /^[A-Za-z0-9_-]{1,200}$/;

function absPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !osp.isabs(value)) {
    throw new RpcError(`${name} must be an absolute path`, BAD_PARAMS);
  }
  return osp.normpath(value);
}

function idOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new RpcError(`${name} must be an id`, BAD_PARAMS);
  return value;
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** The chat the call is about, as AIB sent it (checked): its folder and project are Linux paths on the distro's own disk. */
function chatOf(raw: unknown): SubagentChat {
  if (!isDict(raw)) throw new RpcError('chat must be an object', BAD_PARAMS);
  const folder = absPath(raw.folder, 'chat.folder');
  const project = absPath(raw.project, 'chat.project');
  for (const [p, why] of [[folder, 'the chat'], [project, 'the project']]) {
    if (onWindowsDrive(p)) throw new RpcError(`${why} is on a Windows drive: its subagents work in the project folder`, BAD_PARAMS);
  }
  return {
    id: idOf(raw.id, 'chat.id'),
    provider: text(raw.provider, 40),
    lasting: text(raw.lasting, 600),
    folder,
    project,
    hooks: { readOnly: new Set(Array.isArray(raw.readOnly) ? raw.readOnly.filter((x): x is string => typeof x === 'string').slice(0, 200) : []), userWorktreeHook: false },
  };
}

/** A MergeStudio over the states AIB sent: every chat of the folder, by id (a landing holds and checks them); live calls are recorded. */
class StatesStudio implements merge.MergeStudio {
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

/** The `subagent.*` helper methods over one SubagentWorktrees rooted in `data` (the Linux keeper's data folder). */
export function subagentMethods(data: string): Handlers {
  const chats = new Map<string, SubagentChat>();
  const root = new wt.Registry(data).root;
  const service = new SubagentWorktrees(data, root, (id) => chats.get(id) ?? null);
  const remember = (raw: unknown): SubagentChat => {
    const chat = chatOf(raw);
    chats.set(chat.id, chat);
    return chat;
  };
  return {
    /** A worktree for the chat's next subagent: {record} (state prepared) or {deny} (why not: the cap, a project too big for a snapshot). */
    'subagent.prepare': async (p) => {
      const chat = remember(p.chat);
      const m = isDict(p.meta) ? p.meta : {};
      const out = await service.prepareFor(chat, {
        toolUseId: text(m.toolUseId, 200),
        agentType: text(m.agentType, 200) || 'general-purpose',
        description: text(m.description, 300),
        background: m.background === true,
      });
      return 'deny' in out ? { deny: out.deny } : { record: { ...out } };
    },

    /** The subagent `agentId` starts: the chat's prepared worktree is bound to it (Claude's WorktreeCreate, as the hook route does). */
    'subagent.bind': async (p) => {
      const chat = remember(p.chat);
      const record = await service.bindAgent(chat.id, idOf(p.agentId, 'agentId'), text(p.agentType, 200));
      return { record: record ? { ...record } : null };
    },

    /** The subagent `agentId` ended: its record is done and waits for landing. */
    'subagent.end': async (p) => {
      const chat = remember(p.chat);
      await service.agentEnded(chat.id, idOf(p.agentId, 'agentId'));
      return { ok: true };
    },

    /** One hook call as the Windows route gets it (event: pre-tool, worktree-create, post-agent, subagent-stop): {status, body, type}. */
    'subagent.hook': async (p) => {
      const chat = remember(p.chat);
      const event = str(p, 'event');
      if (!['pre-tool', 'worktree-create', 'post-agent', 'subagent-stop'].includes(event)) throw new RpcError('event is not a hook event', BAD_PARAMS);
      return { ...(await service.hook(event, chat.id, isDict(p.body) ? p.body : {})) };
    },

    /** The records of one chat (every chat when none is named): what AIB mirrors to track and land them. */
    'subagent.records': (p) => {
      const chat = p.chat === undefined ? null : idOf(p.chat, 'chat');
      return { records: (chat ? service.ofChat(chat) : service.all()).map((r) => ({ ...r })) };
    },

    /** The chat closed: its spare and unused prepared worktrees go; bound ones stay for landing. */
    'subagent.chatClosed': async (p) => {
      const id = idOf(p.chat, 'chat');
      await service.chatClosed(id);
      chats.delete(id);
      return { ok: true };
    },

    /**
     * Land the subagent `id` on `target` (the folder's branch) by the steps every subagent lands by. AIB holds the folder's chats first
     * and sends their states (`states`, by chat id) with the ids it holds (`held`). An outcome is an answer, not an error:
     * {state: 'merged' | 'empty' | 'scratch' | 'refused' | 'conflicts', ...} as swarm/service.ts #landSubagent reports it.
     */
    'subagent.land': async (p) => {
      const id = idOf(p.id, 'id');
      const rec = service.all().find((r) => r.id === id);
      if (!rec) return { outcome: { state: 'refused', code: 'gone', message: 'its worktree is gone' }, journal: [], actions: [] };
      if (!ownSubagentPath(root, rec) || !rec.folder) throw new RpcError("that is not one of AIB's subagent worktrees", BAD_PARAMS);
      const target = str(p, 'target');
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(target) || target.startsWith('-')) throw new RpcError('target must be a branch name', BAD_PARAMS);
      const held = Array.isArray(p.held) ? p.held.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 50) : [];
      const landKept = Array.isArray(p.landKept) ? p.landKept.filter((x): x is string => typeof x === 'string' && x.length < 4096).slice(0, 500) : null;
      const studio = new StatesStudio(data, isDict(p.states) ? p.states : {});
      const journal: { stage: string; data: Json }[] = [];
      const outcome = await landSubagentWork(
        studio,
        {
          scratchDir: data,
          path: rec.path,
          folder: rec.folder,
          target,
          branch: rec.branch,
          parent: idOf(p.parent, 'parent'),
          key: `subagent:${rec.id}`,
          title: text(p.title, 500),
          start: rec.snapshot,
          held,
          landKept,
          landScratch: p.landScratch === true,
        },
        (stage, d) => {
          journal.push({ stage, data: { ...d } });
        },
      );
      return { outcome, journal, actions: studio.actions };
    },

    /** Landed (or nothing to land, or discarded): the worktree, its branch and the record go. 'removed' | 'kept' | 'running' | 'gone'. */
    'subagent.release': async (p) => ({ outcome: await service.release(idOf(p.id, 'id')) }),
  };
}

/** At the helper's start: spares and unused prepared worktrees of chats that are gone are removed. Never throws. */
export async function subagentStartup(data: string): Promise<void> {
  try {
    const registry = new wt.Registry(data);
    try {
      Deno.statSync(osp.join(data, 'subagent-worktrees.json'));
    } catch {
      return;
    }
    await new SubagentWorktrees(data, registry.root, () => null).sweep();
  } catch (error) {
    console.error(`AIB-wsl-helper: cleaning up subagent worktrees failed (${error instanceof Error ? error.message : error})`);
  }
}
