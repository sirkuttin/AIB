/**
 * Subagent worktrees, Antigravity CLI (`agy acp`; aib-shared/research/provider-builder-probe-2026-11-25.md, Antigravity section, every
 * fact there and below run on agy 1.5.11). Owner rule: an agent's own subagent that edits files works in its own git worktree, and AIB
 * lands it. For Antigravity this is AIB-enforced when AIB can give the chat a hooks file (an API key is saved: agy then runs with
 * `--gemini-dir <AIB's own folder>`, and AIB writes <that folder>/config/hooks.json), and asked-for only otherwise (see "Sign-in").
 *
 *   PreToolUse(invoke_subagent)  the main agent starts a subagent. agy has no switch to turn subagents off (permissions.deny of every
 *                                subagent tool name left them offered) and `Workspace` takes only inherit / branch / share, never a
 *                                folder (a path was ignored: the subagent ran in the chat's folder). So AIB cannot point the subagent
 *                                at a worktree it made. It answers `overwrite: {Workspace: "branch"}`: agy then makes a real git
 *                                worktree and branch (<gemini dir>/antigravity-cli/worktrees/<parent conversation>/subagent-<Role>-
 *                                <Type>-<hash>) in the chat's repository and the subagent works there. AIB ADOPTS that worktree
 *                                (service.ts adoptExternal: a record with its path, its branch and the merge base as the start), so
 *                                the normal landing applies. Chosen over deny because the work still gets done in parallel, and over
 *                                an AIB-made worktree because agy gives no way to name one. The cost: agy branches from the last
 *                                COMMIT, so the chat's uncommitted edits are not in the subagent's worktree (the prompt says so).
 *   PreToolUse(define_subagent)  allowed with EnableSubagentTools forced false (no nested subagents).
 *   PreToolUse(run_workflow)     denied: its Python script starts many agents, none of which can be given a worktree.
 *   PreToolUse(swarm)            `add` denied (workers cannot be given a worktree); status, models, model, kill, title pass.
 *   PreToolUse(manage_subagents) passes (list, kill).
 *   SessionStart (a subagent)    its conversation starts with cwd = its worktree: AIB binds the worktree to its conversation id.
 *   PreToolUse(any, a subagent)  a subagent is a call whose cwd lies under <gemini dir>/antigravity-cli/worktrees (agy's folder for them;
 *                                set in AIB_HOOK_SUBROOT; the main agent works in the chat's folder). Its calls:
 *                                  write_file, edit_file   only an absolute Path inside its own worktree; else denied
 *                                  run_command             denied when it names the chat's folder (a heuristic; it starts in its worktree)
 *                                  MCP tools               only studio_artifact's (not merge_into_project / resolve_edit_clash)
 *                                  schedule, any subagent tool   denied (nothing may start later in the folder; no nesting)
 *                                A subagent AIB cannot bind (its worktree is not adoptable) may only use READ_ONLY_TOOLS.
 *   Stop (a subagent)            its loop ended: NO_TOOL_CALL = done (it lands like a helper's work, swarm landing, and the parent is
 *                                told through the steer lane); an error or a cancel = stopped (kept, never landed by itself). A
 *                                message that wakes it again (agy's send_message) runs it again: its next call or Stop continue the record.
 *
 * The hooks reach AIB through the keeper's forwarder (`<keeper> hook agy-<event> <address file>`: keeper/hookforward_agy.go), which
 * passes the main agent's other tools itself, fails closed (a JSON deny) and trusts only AIB's signed, shape-checked answers. agy
 * itself fails a tool call whose hook exits non-zero or prints anything but its JSON, so a broken hook never lets a call through.
 *
 * Where the hooks file goes. agy reads hooks from <gemini dir>/config/hooks.json and from <workspace>/.agents/hooks.json (both tested).
 *   API key saved: AIB runs agy with --gemini-dir <its own folder> (agents/beta_agents.ts withKeyHome), so it writes its own entry
 *   (named `aib-subagents`, the rest of the file kept) there. Nothing is written to ~/.gemini or to the project.
 *   Google sign-in (no key): agy uses the person's ~/.gemini, and the only other place is <project>/.agents/hooks.json, a file in the
 *   user's repository that the agent could edit or delete (its own run_command can). AIB writes neither. The safe choice here: no
 *   enforcement is claimed. The agent is told not to start subagents that edit files (it does that work itself), the chat says so up
 *   front and names the key route, and Activity shows isolation off. (A forced own-copy chat would be enforced, but the owner decided
 *   2026-11-16 that chats work in the project folder.)
 *
 * Windows: agy runs a hook command with `cmd /c`, and cmd strips the quotes of a command that starts with one, so a hook command that
 * starts with a double quote is silently skipped (same on Qwen). The program is written first and bare, forward slashes, the address
 * file bare: neither path can hold a space or a shell sign (agyHookCommand returns null: subagents not isolated, said in the chat).
 *
 * Known gaps: agy's `branch` worktree starts at the last commit; relative climbs in a shell command (`cd ..`) and paths built at run
 * time are not seen (the same class as the other agents'); a subagent killed with manage_subagents loses its worktree (agy deletes it).
 */
import { isDict } from '../core/py.ts';
import { dirname, join } from '../platform/path.ts';
import { denyAgy, type HookAnswer, MAX_PER_CHAT, type SubagentChat, type SubagentWorktrees, TEXTS as SERVICE_TEXTS } from './service.ts';
import { namesFolder } from './codex.ts';
import { inSharedFolder, sharedFolderOf } from './shared_fence.ts';
import { parseJsonc } from './gemini.ts';

type Json = Record<string, unknown>;

/** The name of AIB's entry in hooks.json (the rest of the file is the user's, and kept). */
export const AGY_HOOK_NAME = 'aib-subagents';
/** agy's timeout for each hook, seconds: well above the forwarder's own 10 s deadline. */
export const AGY_HOOK_TIMEOUT_S = 30;
/** [agy event, the forwarder's event]. */
export const AGY_EVENTS: readonly (readonly [string, string])[] = [
  ['PreToolUse', 'agy-pre-tool'],
  ['SessionStart', 'agy-session-start'],
  ['Stop', 'agy-stop'],
];
export const AGY_HOOK_EVENTS = AGY_EVENTS.map(([, forwarded]) => forwarded);

/** Every tool that starts or controls other agents. */
export const SPAWN_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'run_workflow', 'swarm', 'manage_subagents']);
/** The tools that change a file, and the input field that holds the path. */
export const WRITE_TOOLS: Record<string, string> = { write_file: 'Path', edit_file: 'Path' };
/** Tools a subagent AIB has no worktree for may use: every one only reads or talks (an allowlist: an unknown or new tool is denied). */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'search_web',
  'ask_question',
  'manage_task',
  'update_steps',
  'send_message',
  'list_resources',
  'read_resource',
]);

/** True for the Antigravity chats this rule applies to. */
export const isAntigravity = (provider: string): boolean => provider === 'antigravity';

// ---- what AIB writes (never read from the agent) ------------------------------------------------------------------------------

/** The `--gemini-dir` of an agy launch command ('' when it has none: the person's own ~/.gemini). */
export function geminiDirOf(command: readonly string[]): string {
  const at = command.lastIndexOf('--gemini-dir');
  return at >= 0 && at + 1 < command.length ? command[at + 1] : '';
}

/** `join` for a path that may be the distro's (a WSL chat's gemini folder is a Linux path: slashes, whatever the host). */
const joinAs = (
  base: string,
  ...parts: string[]
): string => (base.startsWith('/') ? [base.replace(/\/+$/, ''), ...parts].join('/') : join(base, ...parts));
/** agy's folder for its subagent worktrees under a gemini dir. */
export const worktreesRootOf = (geminiDir: string): string => joinAs(geminiDir, 'antigravity-cli', 'worktrees');

/**
 * The command line of one hook. Program first and bare (a line that starts with a quote is silently skipped by cmd /c), forward
 * slashes, the address file bare as well. Null when a path can't be written that way (a space or a shell sign).
 */
export function agyHookCommand(
  forwarder: string,
  addressFile: string,
  event: string,
  os: string = Deno.build.os,
  viaSocket = false,
): string | null {
  if (os === 'windows') {
    const program = forwarder.replaceAll('\\', '/');
    const file = addressFile.replaceAll('\\', '/');
    const bare = /^[A-Za-z]:\/[^\s"'&|<>^%!(),;=`$@{}*?\\]+$/;
    if (!bare.test(program) || !bare.test(file)) return null;
    return `${program} hook ${event} ${file}`;
  }
  if (/['\r\n]/.test(forwarder + addressFile)) return null;
  return `'${forwarder}' hook ${event} ${viaSocket ? '--helper-socket ' : ''}'${addressFile}'`;
}

/** AIB's entry of hooks.json (PreToolUse grouped by matcher, SessionStart and Stop flat), or null when a command can't be written. */
export function agyHooksEntry(forwarder: string, addressFile: string, os: string = Deno.build.os, viaSocket = false): Json | null {
  const command = (event: string) => agyHookCommand(forwarder, addressFile, event, os, viaSocket);
  const pre = command('agy-pre-tool'), start = command('agy-session-start'), stop = command('agy-stop');
  if (!pre || !start || !stop) return null;
  const handler = (c: string) => ({ type: 'command', command: c, timeout: AGY_HOOK_TIMEOUT_S });
  return {
    PreToolUse: [{ matcher: '*', hooks: [handler(pre)] }],
    SessionStart: [handler(start)],
    Stop: [handler(stop)],
  };
}

/** hooks.json with AIB's entry set (or removed: `entry` null); every other entry is the user's and stays. */
export function mergeHooksJson(existing: Json | null, entry: Json | null): Json {
  const out: Json = { ...(existing ?? {}) };
  if (entry) out[AGY_HOOK_NAME] = entry;
  else delete out[AGY_HOOK_NAME];
  return out;
}

export const hooksFileOf = (geminiDir: string): string => joinAs(geminiDir, 'config', 'hooks.json');

/**
 * Writes (or removes) AIB's entry in <gemini dir>/config/hooks.json: only AIB's own folder, written only when it changes. Returns ''
 * when done, else why not (an unreadable file is never overwritten). Never throws.
 */
export function writeHooksFile(geminiDir: string, entry: Json | null): string {
  const file = hooksFileOf(geminiDir);
  let existing: Json | null = null;
  try {
    const text = Deno.readTextFileSync(file);
    if (text.trim()) {
      const parsed = parseJsonc(text);
      if (!isDict(parsed)) return `${file} is not valid JSON`;
      existing = parsed as Json;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) return `${file} can't be read`;
  }
  if (!existing && !entry) return '';
  const next = JSON.stringify(mergeHooksJson(existing, entry), null, 2) + '\n';
  try {
    let same = false;
    try {
      same = Deno.readTextFileSync(file) === next;
    } catch { /* new */ }
    if (!same) {
      Deno.mkdirSync(dirname(file), { recursive: true });
      Deno.writeTextFileSync(file, next);
    }
    return '';
  } catch (error) {
    return `${file} can't be written (${error instanceof Error ? error.message : error})`;
  }
}

// ---- the system prompt lines and the chat notes -------------------------------------------------------------------------------

/** The rule of a chat whose subagents work in their own worktree (the system prompt, or in front of the next prompt). */
export const ANTIGRAVITY_ISOLATED_PROMPT =
  'Subagents you start with invoke_subagent that edit files work in their own git worktree: AIB makes each one use workspace "branch" ' +
  'whatever you ask for, refuses its file changes outside that worktree (it must use absolute paths inside it), and merges its changes ' +
  "into this folder when it finishes (and tells you which files changed). A subagent starts from this folder's last commit, so edits " +
  "you haven't committed are not in its worktree. Do not merge, cherry-pick or copy files from a subagent's worktree yourself. " +
  'run_workflow, swarm workers and subagents that start subagents are not available.';

/** The rule of a chat AIB can not hold its subagents for (Google sign-in, no git project, hooks unavailable): asked for, not enforced. */
export const ANTIGRAVITY_SUBAGENT_PROMPT =
  'Do not start subagents (invoke_subagent, run_workflow, swarm workers) that edit files: AIB cannot give them their own git worktree ' +
  'in this chat, so they would change this folder directly. Do that work yourself, in this chat. Subagents that only read files are fine.';

/** The chat line of a new chat whose subagents work in their own worktree. */
export const ANTIGRAVITY_ISOLATED_NOTE =
  'Antigravity subagents that edit files work in their own git worktree, and AIB merges their changes into this folder when each one ' +
  "finishes. They start from the last commit, so changes you haven't committed are not in their worktree. run_workflow, swarm workers " +
  'and nested subagents are off.';

/** The chat line when AIB can only ask: why, and the way to get it enforced. */
export const antigravityAskedNote = (why: string): string =>
  `Antigravity's subagents can't be held in their own worktree in this chat: ${why}. AIB asks the agent not to start subagents that ` +
  'edit files and to do that work itself; that is a request, not a guarantee. Check what a subagent changed in Changes.';

/** Why the Google sign-in case is only asked for (said once, up front; names the way to enforced isolation). */
export const SIGNIN_WHY =
  'you are signed in with Google, and AIB can only switch its hooks on through a settings folder of its own, which it ' +
  'uses with an API key (Settings, Antigravity CLI), never your ~/.gemini or your project folder';

// ---- the hook routes ----------------------------------------------------------------------------------------------------------

export const AGY_TEXTS = {
  workflow: "Workflows aren't available in AIB chats, because the agents they start can't get their own git worktree. Start subagents " +
    'with invoke_subagent instead; AIB gives each its own worktree.',
  swarm:
    "Swarm workers aren't available in AIB chats, because they can't get their own git worktree. Start subagents with invoke_subagent " +
    'instead; AIB gives each its own worktree.',
  nested:
    "In AIB, a subagent can't start or manage other agents: they could not have their own worktree. Do the work in this subagent, or " +
    'ask the main agent for another one.',
  schedule: "Subagents can't schedule work in AIB: it could run later in the main folder. Ask the main agent to.",
  noWorktree:
    'AIB has no worktree for this subagent, so it may only read (read_file, search_web) and talk. It cannot run commands or change ' +
    'files. Report what you found; the main agent can run commands and start an editing subagent.',
  write: (wt: string, tool: string) =>
    `This subagent works in its own git worktree, ${wt}. ${tool} needs an absolute Path inside it (e.g. ${join(wt, 'src', 'file.ts')}), ` +
    'never a relative path or the main folder.',
  shell: (wt: string) =>
    `This subagent works in its own git worktree, ${wt}; it can't use the main folder. Run the command in the worktree (relative paths, or absolute ones inside it).`,
  mcp: "Subagents can't use this tool in AIB: it could change files outside the subagent's worktree. Ask the main agent to do it.",
};

const json = (payload: unknown): HookAnswer => ({ status: 200, body: JSON.stringify(payload), type: 'application/json' });
const allow = (): HookAnswer => json({ decision: 'allow' });
const allowWith = (overwrite: Json): HookAnswer => json({ decision: 'allow', overwrite });
const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

/** Lowercased on Windows, separators as backslashes, doubled ones single. */
function canon(text: string): string {
  const t = text.replaceAll('/', '\\').replace(/\\{2,}/g, '\\');
  return Deno.build.os === 'windows' ? t.toLowerCase() : t;
}

/** `path` is an absolute path inside `folder` (no `.` or `..` part). */
export function insideFolder(path: string, folder: string, orIsIt = false): boolean {
  if (!/^([A-Za-z]:[\\/]|\/)/.test(path) || path.includes('\0')) return false;
  if (path.split(/[\\/]/).some((part) => part === '.' || part === '..')) return false;
  const base = canon(folder).replace(/\\+$/, '');
  const here = canon(path).replace(/\\+$/, '');
  return here.startsWith(base + '\\') || (orIsIt && here === base);
}

/** The subagent calls AIB let through and has not seen a record for yet: [chat id] -> the invoke_subagent calls waiting for their worktree. */
interface Pending {
  toolUseId: string;
  role: string;
  type: string;
  prompt: string;
  at: number;
}
const PENDING_S = 15 * 60;
const pending = new Map<string, Pending[]>();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function livePending(chatId: string): Pending[] {
  const list = (pending.get(chatId) ?? []).filter((p) => Date.now() / 1000 - p.at < PENDING_S);
  if (list.length) pending.set(chatId, list);
  else pending.delete(chatId);
  return list;
}

/** The invoke_subagent call that made the worktree folder `leaf` (subagent-<Role>-<Type>-<hash>): by role and type, else the oldest. */
function takePending(chatId: string, leaf: string): Pending | null {
  const list = livePending(chatId);
  if (!list.length) return null;
  const folder = norm(leaf.replace(/^subagent-/, ''));
  const hit = list.find((p) => folder.startsWith(norm(p.role) + norm(p.type))) ?? list[0];
  pending.set(chatId, list.filter((p) => p !== hit));
  return hit;
}

/** Forgets what a chat that is gone left waiting. */
export function forgetChat(chatId: string): void {
  pending.delete(chatId);
}

const leafOf = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/** One key-checked Antigravity hook call of an open chat that was given hooks. Never throws. */
export async function agyHook(service: SubagentWorktrees, event: string, chat: SubagentChat, body: Json): Promise<HookAnswer> {
  const root = chat.agyDir ? worktreesRootOf(chat.agyDir) : '';
  const cwd = str(body.cwd, 1024);
  const sub = !!root && insideFolder(cwd, root);
  switch (event) {
    case 'agy-pre-tool':
      return sub ? await subagentCall(service, chat, root, body) : mainCall(service, chat, body);
    case 'agy-session-start':
      if (sub) await bind(service, chat, root, body);
      return json({});
    case 'agy-stop': {
      if (!sub) return json({});
      const rec = await bind(service, chat, root, body);
      const agentId = str(body.conversationId, 64);
      if (rec) {
        const reason = str(body.terminationReason, 60);
        if (reason === 'NO_TOOL_CALL' || reason === 'TERMINAL_STEP_TYPE' || reason === 'INJECTED_RESPONSE' || !reason) {
          await service.agentEnded(chat.id, agentId);
        } else {
          await service.agentStopped(
            chat.id,
            agentId,
            reason === 'USER_CANCELED' ? 'it was cancelled' : reason === 'ERROR' ? 'it failed' : 'it ran out of steps',
          );
        }
      }
      return json({});
    }
    default:
      return { status: 404, body: 'Not found', type: 'text/plain' };
  }
}

/** The record of the subagent a hook call comes from (adopting its worktree the first time), or null. */
async function bind(service: SubagentWorktrees, chat: SubagentChat, root: string, body: Json) {
  const agentId = str(body.conversationId, 64);
  const cwd = str(body.cwd, 1024);
  const known = service.ofChat(chat.id).find((r) => r.agentId === agentId && !!r.agy);
  if (known?.state === 'running') return known;
  const leaf = leafOf(cwd);
  const call = known ? null : takePending(chat.id, leaf);
  return await service.adoptExternal(chat, {
    agentId,
    path: cwd,
    root,
    agentType: call?.type ?? known?.agentType ?? '',
    description: call ? `${call.role}: ${call.prompt}` : known?.description ?? leaf.replace(/^subagent-/, ''),
    toolUseId: call?.toolUseId ?? known?.toolUseId ?? '',
  });
}

function toolOf(body: Json): { name: string; args: Json; id: string } {
  const call = isDict(body.toolCall) ? body.toolCall as Json : {};
  return { name: str(call.name, 300), args: isDict(call.args) ? call.args as Json : {}, id: str(call.id, 200) };
}

function mainCall(service: SubagentWorktrees, chat: SubagentChat, body: Json): HookAnswer {
  const { name, args, id } = toolOf(body);
  switch (name) {
    case 'invoke_subagent': {
      if (service.slotsInUse(chat.id) + livePending(chat.id).length >= MAX_PER_CHAT) return denyAgy(SERVICE_TEXTS.cap);
      const list = livePending(chat.id);
      list.push({
        toolUseId: id,
        role: str(args.Role, 80),
        type: str(args.TypeName, 80),
        prompt: str(args.Prompt, 70).replace(/\s+/g, ' ').trim(),
        at: Date.now() / 1000,
      });
      pending.set(chat.id, list);
      return allowWith({ Workspace: 'branch' });
    }
    case 'define_subagent':
      return args.EnableSubagentTools === true ? allowWith({ EnableSubagentTools: false }) : allow();
    case 'run_workflow':
      return denyAgy(AGY_TEXTS.workflow);
    case 'swarm':
      return str(args.action, 20) === 'add' ? denyAgy(AGY_TEXTS.swarm) : allow();
    default:
      return allow();
  }
}

async function subagentCall(service: SubagentWorktrees, chat: SubagentChat, root: string, body: Json): Promise<HookAnswer> {
  const { name, args } = toolOf(body);
  if (SPAWN_TOOLS.has(name)) return denyAgy(AGY_TEXTS.nested);
  if (name === 'schedule') return denyAgy(AGY_TEXTS.schedule);
  const rec = await bind(service, chat, root, body);
  if (!rec) return READ_ONLY_TOOLS.has(name) ? allow() : denyAgy(AGY_TEXTS.noWorktree);
  const field = WRITE_TOOLS[name];
  if (field) {
    const path = typeof args[field] === 'string' ? args[field] as string : '';
    // its worktree; or agy's own copy of a workspace the chat has besides the project (its cwd then: nothing there lands)
    const ok = insideFolder(path, rec.path) || (rec.agy?.also ?? []).some((f) => insideFolder(path, f)) ||
      inSharedFolder(path, sharedFolderOf(chat.project)); // or the project's aib-shared/ by its main-folder path (shared_fence.ts)
    return ok ? allow() : denyAgy(AGY_TEXTS.write(rec.path, name));
  }
  if (name === 'run_command') {
    const command = typeof args.CommandLine === 'string' ? args.CommandLine : '';
    return namesFolder(command, [chat.folder, chat.project], rec.path, [sharedFolderOf(chat.project)])
      ? denyAgy(AGY_TEXTS.shell(rec.path))
      : allow();
  }
  if (name.startsWith('mcp_')) {
    const ok = name.startsWith('mcp_studio_artifact_') && !/merge_into_project|resolve_edit_clash/.test(name);
    return ok ? allow() : denyAgy(AGY_TEXTS.mcp);
  }
  return allow();
}
