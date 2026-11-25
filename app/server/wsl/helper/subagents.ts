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
import { keepWork, workDiff, workStatus } from '../../worktrees/subagent_work.ts';
import { deny, ownSubagentPath, type SubagentChat, SubagentWorktrees } from '../../subagents/service.ts';
import { claudeConfigDir, readClaudeSetup, subagentsOffSettings } from '../../subagents/claude_config.ts';
import * as codexSub from '../../subagents/codex.ts';
import { isCodexFamily } from '../../agents/claude_family.ts';
import { isDict } from '../../core/py.ts';
import { onWindowsDrive } from './worktrees.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';
import { ProcessReaper } from '../../subagents/reap.ts';
import type { WslMergeAnswer, WslReap } from '../contract.ts';

type Json = Record<string, unknown>;

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const CLAUDE_EVENTS = ['pre-tool', 'pre-shell', 'worktree-create', 'post-agent', 'subagent-stop'];
const CODEX_EVENTS = ['codex-pre-tool', 'codex-subagent-start', 'codex-subagent-stop'];

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
  const id = idOf(raw.id, 'chat.id');
  const configDir = typeof raw.configDir === 'string' && raw.configDir && osp.isabs(raw.configDir) && raw.configDir.length < 4096 && !raw.configDir.includes('\0')
    ? osp.normpath(raw.configDir)
    : '';
  const chat: SubagentChat = {
    id,
    provider: text(raw.provider, 40),
    lasting: text(raw.lasting, 600),
    folder,
    project,
    hooks: {
      readOnly: new Set(Array.isArray(raw.readOnly) ? raw.readOnly.filter((x): x is string => typeof x === 'string').slice(0, 200) : []),
      userWorktreeHook: raw.userWorktreeHook === true,
      ...(configDir ? { configDir } : {}),
      ...(raw.shellTag === true ? { shellTag: true } : {}),
    },
  };
  return chat;
}

/** The Codex chat's own subagent folder, `<root>/<repo hash>/.cx-<chat>`: named here, never taken from the channel. */
function codexFolderOf(root: string, chat: SubagentChat): string {
  return codexSub.subagentFolder(root, chat.project, chat.id);
}

/** A MergeStudio over the states AIB sent: every chat of the folder, by id (a landing holds and checks them); live calls are recorded. */
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

/** The `subagent.*` helper methods over one SubagentWorktrees rooted in `data` (the Linux keeper's data folder). */
export function subagentMethods(data: string): Handlers {
  const chats = new Map<string, SubagentChat>();
  const root = new wt.Registry(data).root;
  const service = new SubagentWorktrees(data, root, (id) => chats.get(id) ?? null);
  service.inlineWaitMs = 0; // the swarm (landing outcomes) is AIB's, not the distro's: a WSL chat is told by the swarm's steer-lane line
  // what a finished subagent left running is shut down HERE, over the distro's own /proc (subagents/reap.ts); AIB reads what was
  // done through `subagent.reaps` and posts the line in the parent chat (a restarted helper forgets old reports: only the line is lost)
  service.reaper = new ProcessReaper();
  const reaps: WslReap[] = [];
  const run = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  let counter = 0;
  service.onReaped = (chatId, who, killed, calls, why) => {
    reaps.push({ key: `${run}-${++counter}`, chat: chatId, at: Date.now() / 1000, why, killed, calls: calls.slice(0, 200), who: who ? { description: who.description ?? '', agentType: who.agentType ?? '' } : null });
    while (reaps.length > 100) reaps.shift();
  };
  const remember = (raw: unknown): SubagentChat => {
    const chat = chatOf(raw);
    if (isDict(raw) && raw.codexFolder === true && isCodexFamily(chat.provider)) {
      // a Codex chat's subagent worktrees go in its own folder (a writable root of its sandbox), made here, named here
      chat.subFolder = codexFolderOf(root, chat);
      Deno.mkdirSync(chat.subFolder, { recursive: true });
    }
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

    /**
     * One hook call as the Windows route gets it (event: pre-tool, worktree-create, post-agent, subagent-stop; or a Codex chat's
     * codex-pre-tool, codex-subagent-start, codex-subagent-stop): {status, body, type}. Never throws for the hook's own failure: its
     * answer is the refusal (a pre-tool deny, a 500 that the forwarder turns into "AIB is restarting").
     */
    'subagent.hook': async (p) => {
      const chat = remember(p.chat);
      const event = str(p, 'event');
      const body = isDict(p.body) ? p.body : {};
      if (CODEX_EVENTS.includes(event)) {
        if (!isCodexFamily(chat.provider)) return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
        try {
          return { ...(await codexSub.codexHook(service, event, chat, body)) };
        } catch (error) {
          return event === 'codex-pre-tool'
            ? { ...deny(`AIB couldn't check this call against the subagent's worktree: ${error instanceof Error ? error.message : error}`) }
            : { status: 500, body: 'AIB could not answer this hook', type: 'text/plain' };
        }
      }
      if (!CLAUDE_EVENTS.includes(event)) throw new RpcError('event is not a hook event', BAD_PARAMS);
      return { ...(await service.hook(event, chat.id, body)) };
    },

    /**
     * What AIB reads of the distro's own agent setup for a chat (it can't read the distro's files): is the folder a git project with a
     * commit, which agent types are read-only, whether the user's own settings turn hooks off or make their own worktree. Claude
     * reads Claude Code's settings tiers and managed files, Codex its config.toml files and requirements; both natively here, as
     * on Windows. `deny` is the per-session permission rules AIB gives a Claude chat whose hooks are off.
     */
    'subagent.setup': async (p) => {
      const agent = str(p, 'agent');
      if (agent !== 'claude' && agent !== 'codex') throw new RpcError('agent must be claude or codex', BAD_PARAMS);
      const project = absPath(p.project, 'project');
      const folder = absPath(p.folder ?? p.project, 'folder');
      for (const [path, why] of [[project, 'the project'], [folder, 'the chat']]) {
        if (onWindowsDrive(path)) throw new RpcError(`${why} is on a Windows drive: its subagents work in the project folder`, BAD_PARAMS);
      }
      const env: Record<string, string> = { ...Deno.env.toObject() };
      if (isDict(p.env)) {
        for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_CONFIG']) {
          const v = (p.env as Json)[name];
          if (typeof v === 'string' && v.length < 200_000 && !v.includes('\0')) env[name] = v;
        }
      }
      let git = '';
      if (p.aibWorktree !== true) {
        const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
        if (top.returncode !== 0 || !wt.same(top.stdout.trim(), folder)) git = 'not a git project';
        else if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) git = 'the repository has no commits yet';
      }
      if (agent === 'codex') {
        const setup = codexSub.readCodexSetup(project, env, 'linux');
        // the chat's own folder for its subagents' worktrees (a writable root of its sandbox): named and made here
        let subFolder = '';
        if (typeof p.chatId === 'string' && ID.test(p.chatId) && !git && !setup.hooksOff && !setup.configError) {
          subFolder = codexSub.subagentFolder(root, project, p.chatId);
          Deno.mkdirSync(subFolder, { recursive: true });
        }
        return {
          git,
          readOnly: [],
          userWorktreeHook: '',
          hooksOff: setup.hooksOff,
          configError: setup.configError,
          configDir: codexSub.codexHome(env),
          deny: null,
          config: setup.config,
          subFolder,
        };
      }
      const setup = readClaudeSetup(project, env);
      return {
        git,
        readOnly: setup.readOnly,
        userWorktreeHook: setup.userWorktreeHook,
        hooksOff: setup.hooksOff,
        configError: '',
        configDir: claudeConfigDir(env),
        deny: setup.hooksOff ? subagentsOffSettings(project, env, setup.readOnly) : null,
        config: null,
        subFolder: '',
      };
    },

    /**
     * What the parent's own ACP stream says of its subagents (never forged by an agent's hook calls), handed on by AIB as the Windows
     * service gets it: claudeTool, acpEnded, reconcileEnded, turnEnded, turnCancelled.
     */
    'subagent.event': async (p) => {
      const chat = remember(p.chat);
      const op = str(p, 'op');
      const a = isDict(p.args) ? p.args : {};
      const s = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
      switch (op) {
        case 'claudeTool':
          await service.claudeTool(chat.id, s(a.tool, 100), s(a.toolUseId, 200), isDict(a.input) ? a.input : {}, s(a.status, 40), s(a.agentId, 64));
          break;
        case 'acpEnded':
          await service.acpEnded(chat.id, s(a.agentId, 64), a.how === null ? null : s(a.how, 40));
          break;
        case 'reconcileEnded': {
          const ended = new Map<string, string>();
          for (const row of Array.isArray(a.ended) ? a.ended.slice(0, 500) : []) {
            if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string') ended.set(row[0].slice(0, 64), row[1].slice(0, 40));
          }
          await service.reconcileEnded(chat.id, ended);
          break;
        }
        case 'noteTask': // Claude Code's background task id of a call: a TaskStop of the task finds the call's processes
          service.noteTask(chat.id, s(a.task, 200), s(a.callId, 200));
          break;
        case 'turnEnded':
          await service.turnEnded(chat.id);
          break;
        case 'turnCancelled':
          await service.turnCancelled(chat.id, s(a.provider, 40));
          break;
        default:
          throw new RpcError('op is not a subagent event', BAD_PARAMS);
      }
      return { ok: true };
    },

    /** The branch the subagent's folder is on (what its work lands on), '' when the folder is on none. */
    'subagent.folderBranch': async (p) => {
      const rec = service.all().find((r) => r.id === idOf(p.id, 'id'));
      if (!rec || !rec.folder || !ownSubagentPath(root, rec)) return { branch: '' };
      return { branch: (await wt.git(['symbolic-ref', '--short', '-q', 'HEAD'], rec.folder, { check: false })).stdout.trim() };
    },

    /** The records of one chat (every chat when none is named): what AIB mirrors to track and land them. */
    'subagent.records': (p) => {
      const chat = p.chat === undefined ? null : idOf(p.chat, 'chat');
      return { records: (chat ? service.ofChat(chat) : service.all()).map((r) => ({ ...r })) };
    },

    /** Which of the chat's background calls have no tagged process left (subagents/service.ts callsGone, over the distro's /proc). */
    'subagent.ownWaiting': (p) => ({ waiting: service.ownWaiting(remember(p.chat).id) }),

    'subagent.callsGone': async (p) => {
      const chat = remember(p.chat);
      const calls = (Array.isArray(p.calls) ? p.calls : []).slice(0, 200).filter((c): c is string => typeof c === 'string' && ID.test(c));
      const status = await service.callsStatus(chat.id, calls);
      return { gone: status.gone, alive: status.alive };
    },

    /** What this helper shut down (a finished subagent's processes, a stopped call's), oldest first. */
    'subagent.reaps': () => ({ reaps: reaps.map((r) => ({ ...r })) }),

    /** The chat closed: its spare and unused prepared worktrees go; bound ones stay for landing. */
    'subagent.chatClosed': async (p) => {
      const id = idOf(p.chat, 'chat');
      await service.chatClosed(id);
      const sub = chats.get(id)?.subFolder;
      if (sub) codexSub.removeSubagentFolder(sub); // a Codex chat's own folder, when empty (a worktree still in it is landing's)
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
      const aib = new StatesHost(data, isDict(p.states) ? p.states : {});
      const journal: { stage: string; data: Json }[] = [];
      const outcome = await landSubagentWork(
        aib,
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
          own: rec,
        },
        (stage, d) => {
          journal.push({ stage, data: { ...d } });
        },
      );
      return { outcome, journal, actions: aib.actions };
    },

    /** Unlanded work handed to the main agent: its files, a patch of it, or a branch that keeps it (worktrees/subagent_work.ts). */
    'subagent.work': async (p) => {
      const id = idOf(p.id, 'id');
      const rec = service.all().find((r) => r.id === id);
      if (!rec || !rec.folder || !ownSubagentPath(root, rec)) return { files: [], landed: false, target: '' };
      const spec = { path: rec.path, folder: rec.folder, start: rec.snapshot, branch: rec.branch, title: String(rec.description ?? ''), scratchDir: data };
      const op = str(p, 'op');
      if (op === 'diff') return { landed: false, ...(await workDiff(spec, `${data}/handoff/${id}.patch`)) };
      if (op === 'keep') {
        const kept = await keepWork(spec, typeof p.name === 'string' && p.name ? p.name : rec.slug);
        return { files: [], landed: false, target: '', branch: kept.branch };
      }
      return await workStatus(spec);
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
