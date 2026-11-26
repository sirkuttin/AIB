/**
 * Subagent worktrees, Qwen Code (aib-shared/research/provider-builder-probe-2026-11-25.md, Qwen section: every fact below was run on
 * Qwen Code 0.27.2 over ACP; provider-builders-vet-2026-11-25.md step 1). Owner rule: an agent's own subagent that edits files works in
 * its own git worktree, and AIB lands it. For Qwen this is AIB-enforced, the way it is for Claude Code:
 *
 *   PreToolUse(agent)          the main agent starts a subagent. Hooks and deny rules see the tool as `agent` although the model
 *                              reaches it through tool_search and tool_call. AIB prepares a worktree (subagents/service.ts prepareFor:
 *                              the same snapshot, branch, cap and spare as Claude's) and answers with updatedInput = the call plus
 *                              `working_dir` = that worktree (Qwen runs the subagent there: its shell starts in it). Denied: forks
 *                              (they share the parent's folder and take no working_dir), a subagent starting a subagent, the external
 *                              executors (claude-code, codex: their own tool calls bypass these hooks), and any call with no worktree.
 *                              `Explore` (and the other types the chat lists as read-only) passes untouched: see "Explore" below.
 *   SubagentStart              binds the prepared worktree to the subagent's agent_id (`<type>-<the call's id>`) and tells the subagent,
 *                              in additionalContext, where it works.
 *   PreToolUse(any, agent_id)  the subagent's own calls (every one carries its agent_id):
 *                                write_file, edit, notebook_edit   only an absolute path inside its worktree; else denied
 *                                run_shell_command                 denied when it names the main folder or runs `directory` outside
 *                                                                  the worktree (a heuristic; its folder is the worktree already)
 *                                MCP tools   only studio_artifact's (not merge_into_project / resolve_edit_clash); others may write
 *                                            anywhere, so they are denied
 *                                agent       denied (no nesting)
 *                              A subagent AIB has no worktree for (Explore) may only use the read-only tools of READ_ONLY_TOOLS.
 *   SubagentStop               done: it lands like a helper's work (swarm landing), and the parent is told through the steer lane.
 *
 * Explore. Qwen's read-only `Explore` subagent can still run shell commands (probe item 5: its run_shell_command wrote a file), so
 * "read-only" is only its own claim. AIB takes the safe choice that costs nothing: Explore runs in the project folder with the read
 * tools only (read_file, glob, grep_search, list_directory, web, report_findings, ...); its shell, its file writes and its MCP tools are
 * denied through the same agent_id hook. A worktree per research call would cost a snapshot, a branch and a landing for no change at
 * all, and a denied shell costs only `git log`-style research, which the main agent can run.
 *
 * The hooks reach AIB through the keeper's forwarder (`<keeper> hook qwen-<event> <address file>`: keeper/hookforward_qwen.go), which
 * fails closed (exit 2 and a JSON deny) and trusts only AIB's signed, shape-checked answers. They reach Qwen as a SYSTEM settings file
 * AIB owns (<state>/qwen/<chat>/settings.json, named by QWEN_CODE_SYSTEM_SETTINGS_PATH): system hooks run beside the user's, need no
 * folder approval, and nothing is written to ~/.qwen. The user's own system settings file, when there is one, is merged into it.
 *
 * Hooks off (disableAllHooks in a settings tier, QWEN_CODE_SAFE_MODE) or unavailable (an older keeper program, a path a hook command
 * can't hold, no keeper): the chat's subagents are turned off instead (`permissions.deny: ["agent"]` in the same file), never left to
 * edit the folder, and the chat says so.
 *
 * Windows: Qwen runs a hook command with `cmd.exe /d /s /c <command>` (Git Bash when it runs in one), and cmd strips the quotes of a
 * command that starts with one, so a hook command that starts with a double quote is silently skipped (probe item 3: no hook ran and
 * nothing was logged). The program is therefore written first and bare, with forward slashes (cmd and bash both run them), and the
 * address file bare too (Node escapes inner quotes for cmd.exe, so a quoted file reached the program with the quotes in it, seen on
 * 0.27.2): neither path can hold a space or a shell sign (qwenHookCommand returns null: subagents off).
 *
 * Known gaps (the same class as Codex's): relative climbs in a shell command (`cd ..`) and paths built at run time are not seen; a
 * skill that forks, and Qwen's team and arena features, are not covered.
 */
import { isDict } from '../core/py.ts';
import { dirname, join } from '../platform/path.ts';
import { pathOf } from '../state/paths.ts';
import { deny, type HookAnswer, type SubagentChat, type SubagentWorktrees } from './service.ts';
import { namesFolder } from './codex.ts';
import { inSharedFolder, sharedFolderOf } from './shared_fence.ts';
import { parseJsonc } from './gemini.ts';

type Json = Record<string, unknown>;

/** Qwen's timeout for each hook, seconds: well above the forwarder's own 10 s deadline. */
export const QWEN_HOOK_TIMEOUT_S = 30;

/** [Qwen event, the forwarder's event]. */
export const QWEN_EVENTS: readonly (readonly [string, string])[] = [
  ['PreToolUse', 'qwen-pre-tool'],
  ['SubagentStart', 'qwen-subagent-start'],
  ['SubagentStop', 'qwen-subagent-stop'],
];
export const QWEN_HOOK_EVENTS = QWEN_EVENTS.map(([, forwarded]) => forwarded);

/** Subagent types the forwarder passes without a worktree (AIB_HOOK_READONLY): they get the read tools only (READ_ONLY_TOOLS). */
export const QWEN_READ_ONLY_TYPES = ['Explore'];
/** Qwen tools a subagent without a worktree may use: every one only reads (an allowlist: an unknown or new tool is denied). */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'glob',
  'grep_search',
  'list_directory',
  'web_fetch',
  'web_search',
  'tool_search',
  'read_mcp_resource',
  'report_findings',
  'zoom_image',
  'todo_write',
  'lsp',
]);
/** The tools that change a file, and the input field that holds the path. */
export const WRITE_TOOLS: Record<string, string> = { write_file: 'file_path', edit: 'file_path', notebook_edit: 'notebook_path' };
/** Permission deny rules AIB always sends: the executors that run another agent outside these hooks. */
export const ALWAYS_DENY = ['Agent(claude-code)', 'Agent(codex)'];

/**
 * The command line of one hook. The program first and bare (a line that starts with a quote is silently skipped by cmd.exe on
 * Windows, see the file comment), forward slashes, the address file bare as well. `|| exit 2` makes a program that is missing or
 * broken block the call too (cmd, bash and PowerShell 7 all read it). Null when a path can't be written that way (a space or a shell
 * sign: cmd.exe would split or expand it).
 */
export function qwenHookCommand(
  forwarder: string,
  addressFile: string,
  event: string,
  os: string = Deno.build.os,
  viaSocket = false,
): string | null {
  if (os === 'windows') {
    const program = forwarder.replaceAll('\\', '/');
    const file = addressFile.replaceAll('\\', '/');
    // Neither is quoted: Node passes the command to cmd.exe as one argument with its inner quotes escaped (\"), and the program then
    // read the address file as "\"C:/...\"" (seen on 0.27.2: the hook could not open it). So both paths hold no space or sign at all.
    const bare = /^[A-Za-z]:\/[^\s"'&|<>^%!(),;=`$@{}*?\\]+$/;
    if (!bare.test(program) || !bare.test(file)) return null;
    return `${program} hook ${event} ${file} || exit 2`;
  }
  if (/['\r\n]/.test(forwarder + addressFile)) return null;
  // viaSocket (a WSL chat): the helper's tunnel socket instead of an address file. Starts with a quote: bash, not cmd.exe.
  return `'${forwarder}' hook ${event} ${viaSocket ? '--helper-socket ' : ''}'${addressFile}' || exit 2`;
}

/** The `hooks` AIB adds (one entry per event, no matcher: every tool), or null when a command can't be written. */
export function qwenHooks(forwarder: string, addressFile: string, os: string = Deno.build.os, viaSocket = false): Json | null {
  const out: Json = {};
  for (const [event, forwarded] of QWEN_EVENTS) {
    const command = qwenHookCommand(forwarder, addressFile, forwarded, os, viaSocket);
    if (!command) return null;
    out[event] = [{ hooks: [{ type: 'command', command, timeout: QWEN_HOOK_TIMEOUT_S }] }];
  }
  return out;
}

/** What AIB adds to Qwen's system settings: its hooks (null: none, subagents off) and the permission deny rules. */
export interface QwenFragment {
  hooks: Json | null;
  deny: string[];
}

/** The fragment of a chat with hooks on: AIB's hooks, and the executors Qwen runs outside them denied. */
export const onFragment = (hooks: Json): QwenFragment => ({ hooks, deny: [...ALWAYS_DENY] });
/** The fragment of a chat whose subagents are off: no hooks, the whole `agent` tool denied (it takes Explore with it: see the file comment). */
export const offFragment = (): QwenFragment => ({ hooks: null, deny: [...ALWAYS_DENY, 'agent'] });

/** The user's own system settings with the fragment merged in (their hooks run first in each event; their deny rules stay). */
export function mergeSystemSettings(theirs: Json | null, fragment: QwenFragment): Json {
  const out: Json = { ...(theirs ?? {}) };
  if (fragment.hooks) {
    const their = isDict(out.hooks) ? out.hooks as Json : {};
    const hooks: Json = { ...their };
    for (const [event, groups] of Object.entries(fragment.hooks)) {
      hooks[event] = [...(Array.isArray(their[event]) ? their[event] as unknown[] : []), ...(groups as unknown[])];
    }
    out.hooks = hooks;
  }
  const permissions: Json = isDict(out.permissions) ? { ...(out.permissions as Json) } : {};
  const deny = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  permissions.deny = [...new Set([...deny, ...fragment.deny])];
  out.permissions = permissions;
  return out;
}

// ---- what AIB reads of the user's Qwen setup (never written) ------------------------------------------------------------------

export interface QwenSetup {
  /** Why hooks are off ('' when on). */
  hooksOff: string;
  /** The user's system settings file's content (null: none, or unreadable: see systemError). */
  system: Json | null;
  /** Why the user's system settings can't be merged ('' when fine): AIB would drop their settings, so the chat's subagents go off. */
  systemError: string;
}

/** The Qwen config folder the agent will use: its QWEN_HOME, else <home>/.qwen. */
export function qwenHome(env: Record<string, string | undefined>): string {
  if (env.QWEN_HOME) return env.QWEN_HOME;
  return join(env.USERPROFILE || env.HOME || '', '.qwen');
}

/** Qwen's system settings file (QWEN_CODE_SYSTEM_SETTINGS_PATH overrides the default folder). */
export function systemSettingsPath(env: Record<string, string | undefined>, os: string = Deno.build.os): string {
  if (env.QWEN_CODE_SYSTEM_SETTINGS_PATH) return env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
  if (os === 'windows') return join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'qwen-code', 'settings.json');
  if (os === 'darwin') return '/Library/Application Support/QwenCode/settings.json';
  return '/etc/qwen-code/settings.json';
}

function systemDefaultsPath(env: Record<string, string | undefined>, os: string): string {
  if (env.QWEN_CODE_SYSTEM_DEFAULTS_PATH) return env.QWEN_CODE_SYSTEM_DEFAULTS_PATH;
  if (os === 'windows') return join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'qwen-code', 'system-defaults.json');
  if (os === 'darwin') return '/Library/Application Support/QwenCode/system-defaults.json';
  return '/etc/qwen-code/system-defaults.json';
}

/** [content, '' | why unreadable]: a missing file is `[null, '']`. */
function readSettings(path: string): [Json | null, string] {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? [null, ''] : [null, `${path} can't be read`];
  }
  if (!text.trim()) return [{}, ''];
  const parsed = parseJsonc(text);
  return isDict(parsed) ? [parsed as Json, ''] : [null, `${path} is not valid JSON`];
}

const truthy = (v: string | undefined) => !!v && !/^(0|false|no|off)?$/i.test(v.trim());

/** What AIB needs to know of the user's Qwen setup for a chat in `cwd`. Reads only; never throws. */
export function readQwenSetup(cwd: string, env: Record<string, string | undefined>, os: string = Deno.build.os): QwenSetup {
  let hooksOff = '';
  if (truthy(env.QWEN_CODE_SAFE_MODE)) hooksOff = 'QWEN_CODE_SAFE_MODE is on';
  else if (truthy(env.QWEN_CODE_SIMPLE)) hooksOff = 'QWEN_CODE_SIMPLE is on';
  const [system, systemError] = readSettings(systemSettingsPath(env, os));
  const tiers: [string, Json | null][] = [
    ['your Qwen settings', readSettings(join(qwenHome(env), 'settings.json'))[0]],
    ["the project's .qwen/settings.json", readSettings(join(cwd, '.qwen', 'settings.json'))[0]],
    ['the system Qwen settings', system],
    ['the system defaults', readSettings(systemDefaultsPath(env, os))[0]],
  ];
  for (const [where, s] of tiers) if (!hooksOff && s && s.disableAllHooks === true) hooksOff = `disableAllHooks is on in ${where}`;
  return { hooksOff, system, systemError };
}

/** Where a chat's settings file goes: <state>/qwen/<chat>/settings.json (AIB's own folder). */
export function settingsFileOf(stateDir: string, chatId: string): string {
  return pathOf(stateDir, 'qwen', chatId, 'settings.json');
}

/** Writes the chat's system settings file (the same bytes on every reopen) and returns its path. */
export function writeSettingsFile(file: string, settings: Json): string {
  Deno.mkdirSync(dirname(file), { recursive: true });
  Deno.writeTextFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

/** The chat is gone: its settings folder goes. Never throws. */
export function removeSettings(stateDir: string, chatId: string): void {
  try {
    Deno.removeSync(pathOf(stateDir, 'qwen', chatId), { recursive: true });
  } catch { /* gone */ }
}

/**
 * At start (and after the keeper's running chats are known): the settings folders of chats that are not open here and not running in
 * the keeper, and older than `minAgeS`, go. A chat's file is NOT removed when AIB lets go of it: a keeper-held chat that restarts its
 * agent (new tools) reads the same file again, and without it the agent would start with no hooks and `agent` not denied. Never throws.
 */
export function sweepSettings(stateDir: string, keep: Set<string>, minAgeS = 3600): number {
  let removed = 0;
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(pathOf(stateDir, 'qwen'))];
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory || !/^[0-9a-f]{32}$/.test(e.name) || keep.has(e.name)) continue;
    const dir = pathOf(stateDir, 'qwen', e.name);
    try {
      const st = Deno.lstatSync(dir);
      if (st.isSymlink || (st.mtime && Date.now() - st.mtime.getTime() < minAgeS * 1000)) continue;
      Deno.removeSync(dir, { recursive: true });
      removed++;
    } catch { /* in use, or gone */ }
  }
  return removed;
}

// ---- the system prompt lines and the chat notes -------------------------------------------------------------------------------

export const QWEN_SUBAGENT_PROMPT =
  'Subagents you start with the agent tool that edit files work in their own git worktree: AIB sets their ' +
  'working folder, refuses their file changes outside it (they must use absolute paths inside it), and merges their changes into this folder ' +
  "when each one finishes (and tells you which files changed). Do not merge, cherry-pick or copy files from a subagent's worktree yourself. " +
  'The read-only Explore subagent runs in this folder with read tools only: it has no shell. Forks, and subagents that start subagents, ' +
  'are not available.';

export const QWEN_SUBAGENTS_OFF_PROMPT =
  'In this chat, subagents (the agent tool) are turned off, because AIB could not give them their own ' +
  'git worktree. Do the work yourself.';

/** The chat line of a new chat whose subagents work in their own worktree. */
export const QWEN_SUBAGENT_NOTE = 'Qwen subagents that edit files work in their own git worktree, and AIB merges their changes into this ' +
  'folder when each one finishes. The read-only Explore subagent runs here with read tools only: it can search and read, not run commands. ' +
  'Forks and nested subagents are off.';

export const qwenOffNote = (why: string) =>
  `Subagents are off in this Qwen chat: ${why}, so AIB can't give them their own worktree. Qwen's agent tool is turned off ` +
  '(its read-only Explore subagent too: it can still run commands).';

// ---- the hook routes ----------------------------------------------------------------------------------------------------------

export const QWEN_TEXTS = {
  fork: "In AIB, a fork subagent can't work in its own worktree (it shares this folder). Start a named subagent instead " +
    '(subagent_type "general-purpose"); AIB gives it its own worktree.',
  nested: "In AIB, a subagent can't start another subagent: it could not have its own worktree. Do the work in this subagent, or ask the " +
    'main agent for another one.',
  noWorktree: 'AIB has no worktree for this subagent, so it may only read (read_file, glob, grep_search, list_directory, web tools). ' +
    'It cannot run commands or change files. Report what you found; the main agent can run commands and start an editing subagent.',
  write: (wt: string, file: string) =>
    `This subagent works in its own git worktree, ${wt}. Use ${file} style absolute paths inside it (e.g. ${
      join(wt, 'src', 'file.ts')
    }), ` +
    'never a relative path or the main folder.',
  shell: (wt: string) =>
    `This subagent works in its own git worktree, ${wt}; it can't use the main folder. Run the command in the worktree (relative paths, or absolute ones inside it).`,
  mcp: "Subagents can't use this tool in AIB: it could change files outside the subagent's worktree. Ask the main agent to do it.",
  context: (wt: string, folder: string) =>
    `AIB gave you your own git worktree: ${wt}. Work only there: your shell starts in it, and write_file, edit and notebook_edit need ` +
    `absolute paths inside it. Never touch the main folder, ${folder}: AIB merges your work into it when you finish.`,
};

const json = (payload: unknown): HookAnswer => ({ status: 200, body: JSON.stringify(payload), type: 'application/json' });
const pass = (): HookAnswer => json({});
const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
/** Forward slashes (Qwen and git read them on every system). */
const forward = (p: string) => p.replaceAll('\\', '/');

/** Lowercased on Windows, separators as backslashes, doubled ones single. */
function canon(text: string): string {
  const t = text.replaceAll('/', '\\').replace(/\\{2,}/g, '\\');
  return Deno.build.os === 'windows' ? t.toLowerCase() : t;
}

/** `path` is an absolute path inside `worktree` (no `.` or `..` part). */
export function insideWorktree(path: string, worktree: string, orIsIt = false): boolean {
  if (!/^([A-Za-z]:[\\/]|\/)/.test(path) || path.includes('\0')) return false;
  if (path.split(/[\\/]/).some((part) => part === '.' || part === '..')) return false;
  const base = canon(worktree).replace(/\\+$/, '');
  const here = canon(path).replace(/\\+$/, '');
  return here.startsWith(base + '\\') || (orIsIt && here === base);
}

/** One key-checked Qwen hook call of an open chat that was given hooks. Never throws. */
export async function qwenHook(service: SubagentWorktrees, event: string, chat: SubagentChat, body: Json): Promise<HookAnswer> {
  const agentId = str(body.agent_id, 200);
  switch (event) {
    case 'qwen-pre-tool':
      return agentId ? await subagentCall(service, chat, agentId, body) : await mainCall(service, chat, body);
    case 'qwen-subagent-start': {
      if (!agentId) return pass();
      const rec = await service.bindByCall(chat.id, agentId, str(body.agent_type));
      if (!rec) return pass(); // Explore, or a call AIB did not prepare: its calls are limited (QWEN_TEXTS.noWorktree)
      return json({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: QWEN_TEXTS.context(rec.path, chat.folder) } });
    }
    case 'qwen-subagent-stop':
      await service.agentEnded(chat.id, agentId);
      return pass();
    default:
      return { status: 404, body: 'Not found', type: 'text/plain' };
  }
}

const isAgentTool = (tool: string) => tool.toLowerCase() === 'agent';

async function mainCall(service: SubagentWorktrees, chat: SubagentChat, body: Json): Promise<HookAnswer> {
  if (!isAgentTool(str(body.tool_name, 100))) return pass(); // the forwarder passes these itself
  const input = isDict(body.tool_input) ? body.tool_input as Json : {};
  return await agentCall(service, chat, body, input);
}

/** The `agent` tool: an isolated call (working_dir = a prepared worktree), or a refusal. Read-only types never get here (the forwarder passes them). */
async function agentCall(service: SubagentWorktrees, chat: SubagentChat, body: Json, input: Json): Promise<HookAnswer> {
  const type = str(input.subagent_type, 200);
  if (type === 'fork') return deny(QWEN_TEXTS.fork);
  const callId = str(body.tool_call_id, 200) || str(body.tool_use_id, 200);
  if (!callId) return deny('AIB could not tell which call this is, so it could not give the subagent a worktree.');
  const outcome = await service.prepareFor(chat, {
    toolUseId: callId,
    agentType: type || 'general-purpose',
    description: str(input.description, 300),
    background: input.run_in_background === true,
  });
  if ('deny' in outcome) return deny(outcome.deny);
  return json({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: "AIB: the subagent's own worktree",
      updatedInput: { ...input, working_dir: forward(outcome.path) },
    },
  });
}

async function subagentCall(service: SubagentWorktrees, chat: SubagentChat, agentId: string, body: Json): Promise<HookAnswer> {
  const tool = str(body.tool_name, 300);
  const input = isDict(body.tool_input) ? body.tool_input as Json : {};
  if (isAgentTool(tool)) return deny(QWEN_TEXTS.nested);
  const rec = service.runningAgent(chat.id, agentId) ?? await service.bindByCall(chat.id, agentId, str(body.agent_type));
  if (!rec) return READ_ONLY_TOOLS.has(tool) ? pass() : deny(QWEN_TEXTS.noWorktree);
  const field = WRITE_TOOLS[tool];
  const shared = sharedFolderOf(chat.project); // the project's aib-shared/, allowed by its main-folder path too (shared_fence.ts)
  if (field) {
    const path = typeof input[field] === 'string' ? input[field] as string : '';
    return insideWorktree(path, rec.path) || inSharedFolder(path, shared) ? pass() : deny(QWEN_TEXTS.write(rec.path, field));
  }
  if (tool === 'run_shell_command') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (namesFolder(command, [chat.folder, chat.project], rec.path, [shared])) return deny(QWEN_TEXTS.shell(rec.path));
    const directory = typeof input.directory === 'string' ? input.directory : '';
    if (directory && !insideWorktree(directory, rec.path, true) && !inSharedFolder(directory, shared, true)) {
      return deny(QWEN_TEXTS.shell(rec.path));
    }
    return pass();
  }
  if (tool.startsWith('mcp__')) {
    const ok = tool.startsWith('mcp__studio_artifact__') && !/merge_into_project|resolve_edit_clash/.test(tool);
    return ok ? pass() : deny(QWEN_TEXTS.mcp);
  }
  return pass();
}
