/**
 * Subagent worktrees, Codex (aib-shared/designs/subagent-worktrees/codex-gemini-isolation.md 1.5; owner 2026-11-16: the rule holds for
 * every provider, Codex subagents off when hooks are off). Codex can't give a subagent another folder (spawn_agent has no cwd; the
 * child always gets the parent's folder and sandbox), so AIB redirects each of its calls through Codex's own hooks:
 *
 *   PreToolUse(spawn_agent)    the main agent starts a subagent: AIB prepares its worktree (subagents/service.ts prepareFor: the
 *                              same snapshot, branch, cap and spare as Claude's), or denies the call with the reason.
 *   SubagentStart              binds the oldest prepared worktree to the subagent's agent_id and tells it, in additionalContext,
 *                              that its folder is the worktree.
 *   PreToolUse(any, agent_id)  the subagent's own calls (every one carries its agent_id):
 *                                Bash         runs in the worktree: AIB answers its command with a "cd '<worktree>'; " prefix
 *                                             (forward slashes: PowerShell and bash read it; cmd.exe takes the whole line as
 *                                             cd's folder and runs nothing). Denied when it names the main folder.
 *                                apply_patch  passes only when every file is an absolute path inside the worktree (Codex drops a
 *                                             rewritten patch for its JSON form of the tool, so it is never rewritten); else
 *                                             denied, with the paths to use instead.
 *                                MCP tools    only studio_artifact's (not merge_into_project / resolve_edit_clash); others may
 *                                             write anywhere, so they are denied.
 *                              A subagent AIB has no worktree for has every call denied.
 *   SubagentStop               done: it lands like a helper's work when the parent is idle (P2: swarm/service.ts).
 *
 * The hooks reach AIB through the keeper's forwarder (`<keeper> hook codex-<event> <address file>`: keeper/hookforward_codex.go),
 * which fails closed and trusts only AIB's signed answers. They go to codex-acp in CODEX_CONFIG (merged with the user's own
 * CODEX_CONFIG; codex-acp passes `hooks` to `codex app-server -c hooks=...`), with a hooks.state trust entry per hook: Codex runs a
 * hook from a config layer only once its hash is trusted (the hash: codexHookHash, Codex 0.166 hooks/src/engine/discovery.rs
 * hook_hash). Nothing is written to ~/.codex.
 *
 * Hooks off (features.hooks / codex_hooks false in a config Codex reads, allow_managed_hooks_only in its requirements) or
 * unavailable (no keeper forwarder, a path a hook command can't hold, WSL): the chat's subagents are turned off instead,
 * features.multi_agent = false in the same CODEX_CONFIG (P0 A10), and the chat says so.
 *
 * Known gaps (design 1.4): typed input to an open shell (write_stdin) has no hook; relative climbs (`cd ..\..`) and paths built at
 * run time are not seen; hosted tools (web search) skip hooks.
 */
import { createHash } from 'node:crypto';
import { isDict } from '../core/py.ts';
import { join } from '../platform/path.ts';
import { pathOf } from '../state/paths.ts';
import * as wt from '../worktrees/worktrees.ts';
import { deny, type HookAnswer, type SubagentChat, type SubagentWorktrees } from './service.ts';
import { codexTagPrefix } from './shell_tag.ts';

type Json = Record<string, unknown>;

/** Codex's timeout for each hook, seconds: well above the forwarder's own 10 s deadline (a timed-out hook fails open). */
export const CODEX_HOOK_TIMEOUT_S = 30;

/** [Codex event, its key label (hook_event_key_label), the forwarder's event]. */
export const CODEX_EVENTS: readonly (readonly [string, string, string])[] = [
  ['PreToolUse', 'pre_tool_use', 'codex-pre-tool'],
  ['SubagentStart', 'subagent_start', 'codex-subagent-start'],
  ['SubagentStop', 'subagent_stop', 'codex-subagent-stop'],
];

/**
 * The command line of one hook. On Windows Codex runs it through a shell: `cmd.exe /C` per its source, PowerShell 7 (pwsh.exe) as
 * seen on 0.166 here (work/cx_codex_subagent_probe.py spawn-console), and on a PC without pwsh likely Windows PowerShell 5.1. The
 * line must mean the same in all three: the program first and bare (a line that starts with a quote silently fails under cmd.exe,
 * verified on 0.166: so do `cd /d "<dir>" && ...` and `call "<program>" ...`), so a keeper path with a space or a cmd or PowerShell
 * special character can't be named (null: the chat's subagents go off); the address file in double quotes, with no `%`, `!`, `$` or
 * backtick (they expand even there). No `|| exit 2` on Windows: PowerShell 5.1 refuses `||` (a parse error, and the call would
 * run), and Codex runs a call whose hook exits 2 anyway; the forwarder refuses with a JSON deny itself. Elsewhere `$SHELL -lc`:
 * both single-quoted, `|| exit 2` kept.
 */
export function codexHookCommand(forwarder: string, addressFile: string, event: string, os: string = Deno.build.os, viaSocket = false): string | null {
  if (os === 'windows') {
    if (!/^[A-Za-z]:\\[^\s"'&|<>^%!(),;=`$@{}]+$/.test(forwarder) || /["%!$`\r\n]/.test(addressFile)) return null;
    return `${forwarder} hook ${event} "${addressFile}"`;
  }
  if (/['\r\n]/.test(forwarder + addressFile)) return null;
  // viaSocket (a WSL chat): the helper's tunnel socket instead of an address file
  return `'${forwarder}' hook ${event} ${viaSocket ? '--helper-socket ' : ''}'${addressFile}' || exit 2`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isDict(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

/**
 * The trust hash Codex computes for one command hook (0.166 discovery.rs hook_hash + config fingerprint.rs version_for_toml): sha256
 * of the sorted, compact JSON of {event_name, matcher?, hooks: [{type, command, timeout, async}]}. Checked against a real
 * `hooks/list` (work/deno/e2e_subagent_codex_test.ts): when it differs, Codex skips AIB's hooks and its subagents run unisolated, so
 * the e2e is the guard for each codex-acp bump.
 */
export function codexHookHash(label: string, matcher: string | null, handler: { command: string; timeout: number }): string {
  const identity = {
    event_name: label,
    hooks: [{ type: 'command', command: handler.command, timeout: handler.timeout, async: false }],
    ...(matcher !== null ? { matcher } : {}),
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex');
}

/**
 * Where Codex says a `-c hooks=...` hook comes from (its trust key starts with it): `C:\<session-flags>\config.toml` on Windows
 * (seen on 0.166; the drive is the one AIB and the agent run on, so each likely drive gets an entry: extra entries are harmless).
 */
export function sessionFlagSources(cwd: string, os: string = Deno.build.os): string[] {
  if (os !== 'windows') return ['/<session-flags>/config.toml'];
  const drives = new Set(['C']);
  for (const p of [cwd, safeCwd()]) {
    const m = /^([A-Za-z]):/.exec(p);
    if (m) drives.add(m[1].toUpperCase());
  }
  return [...drives].map((d) => `${d}:\\<session-flags>\\config.toml`);
}

function safeCwd(): string {
  try {
    return Deno.cwd();
  } catch {
    return '';
  }
}

/**
 * The `hooks` value of CODEX_CONFIG: the user's own hooks (from their CODEX_CONFIG) first, AIB's after them in each event, and a
 * trusted_hash state entry for each of AIB's (keyed by its group's index). Null when a command can't be written.
 */
export function codexHooks(
  forwarder: string,
  addressFile: string,
  cwd: string,
  userHooks: unknown,
  os: string = Deno.build.os,
  viaSocket = false,
): Json | null {
  const theirs: Json = isDict(userHooks) ? structuredClone(userHooks) as Json : {};
  const state: Json = isDict(theirs.state) ? { ...theirs.state as Json } : {};
  const out: Json = { ...theirs };
  for (const [event, label, forwarded] of CODEX_EVENTS) {
    const command = codexHookCommand(forwarder, addressFile, forwarded, os, viaSocket);
    if (!command) return null;
    const handler = { type: 'command', command, timeout: CODEX_HOOK_TIMEOUT_S };
    const groups = Array.isArray(theirs[event]) ? [...theirs[event] as unknown[]] : [];
    const index = groups.length;
    groups.push({ hooks: [handler] });
    out[event] = groups;
    const hash = codexHookHash(label, null, handler);
    for (const source of sessionFlagSources(cwd, os)) state[`${source}:${label}:${index}:0`] = { trusted_hash: hash };
  }
  out.state = state;
  return out;
}

/**
 * The chat's own folder for its subagents' worktrees: <root>/<repo hash>/.cx-<chat id>. It is a writable root of the chat's sandbox
 * (an ACP additionalDirectories entry), so in Workspace mode a subagent writes in its worktree as the chat writes in its folder,
 * with no prompt; anything outside still asks. Only this chat's subagents' worktrees go there.
 */
export function subagentFolder(root: string, project: string, chatId: string): string {
  return pathOf(root, wt.repoHash(project), `.cx-${chatId}`);
}

/** The chat is gone: its subagent folder goes when empty (a worktree still in it is landing's). Never throws. */
export function removeSubagentFolder(folder: string): void {
  try {
    Deno.removeSync(folder); // not recursive: only an empty folder
  } catch { /* not empty, or gone */ }
}

/** The user's CODEX_CONFIG with AIB's hooks merged in. */
export function withCodexHooks(user: Json | null, hooks: Json): Json {
  return { ...(user ?? {}), hooks };
}

/**
 * Open elsewhere (ownership/handoff.ts): a CODEX_CONFIG (JSON text; '' or none: {}) with thread_unload_delay_secs = 0, so a thread
 * AIB lets go of (codex-acp session/close: thread/unsubscribe) unloads at once and frees its writer lock for the other app (Codex's
 * default keeps it 60 s). codex-acp sends CODEX_CONFIG as each thread's config. Null when the text is not a JSON object (codex-acp
 * refuses that anyway; left as it is).
 */
export function withUnloadNow(raw: string | undefined): string | null {
  let config: unknown = {};
  if (raw && raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isDict(config)) return null;
  return JSON.stringify({ ...(config as Json), thread_unload_delay_secs: 0 });
}

/** The user's CODEX_CONFIG with the chat's subagents turned off (features.multi_agent = false, P0 A10). */
export function withSubagentsOff(user: Json | null): Json {
  const base = user ?? {};
  const features = isDict(base.features) ? base.features as Json : {};
  return { ...base, features: { ...features, multi_agent: false } };
}

// ---- what AIB reads of the user's Codex setup (never written) ---------------------------------------------------------------

export interface CodexSetup {
  /** The user's CODEX_CONFIG, parsed (null: none). */
  config: Json | null;
  /** Why it can't be read ('' when fine): AIB can merge nothing into it, so the chat gets no hooks (codex-acp refuses it too). */
  configError: string;
  /** Why hooks are off ('' when on). */
  hooksOff: string;
}

function readText(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

const FEATURE_KEYS = new Set(['hooks', 'codex_hooks']);

/**
 * True when a config.toml text turns Codex hooks off: `hooks` / `codex_hooks` set to anything but true in a [features] table (a
 * profile's too), as a dotted `features.hooks` key, or inside an inline `features = { ... }`. Line-based, and cautious: a value
 * AIB can't read as `true` counts as off (subagents off is the safe side).
 */
export function tomlTurnsHooksOff(text: string): boolean {
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = header[1].replace(/["'\s]/g, '');
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/["'\s]/g, '');
    const value = kv[2].trim();
    const path = [...(table ? table.split('.') : []), ...key.split('.')];
    const last = path[path.length - 1];
    if (path.length >= 2 && path[path.length - 2] === 'features' && FEATURE_KEYS.has(last) && value !== 'true') return true;
    if (last === 'features' && value.startsWith('{') && /\b(codex_)?hooks\s*=\s*(?!true\b)/.test(value)) return true;
  }
  return false;
}

/** True when a requirements.toml text allows managed hooks only (AIB's are not managed). */
export function requirementsManagedOnly(text: string): boolean {
  return /^\s*allow_managed_hooks_only\s*=\s*true\b/m.test(text) || /allow_managed_hooks_only\s*=\s*true\b/.test(text);
}

/** The Codex config folder the agent will use: its CODEX_HOME, else <home>/.codex. */
export function codexHome(env: Record<string, string | undefined>): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return join(env.USERPROFILE || env.HOME || '', '.codex');
}

function systemCodexDir(env: Record<string, string | undefined>, os: string): string {
  if (os === 'windows') return join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'OpenAI', 'Codex');
  return '/etc/codex';
}

/** What AIB needs to know of the user's Codex setup for a chat in `cwd`. Reads only; never throws. */
export function readCodexSetup(cwd: string, env: Record<string, string | undefined>, os: string = Deno.build.os): CodexSetup {
  let config: Json | null = null;
  let configError = '';
  const raw = env.CODEX_CONFIG;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isDict(parsed)) config = parsed as Json;
      else configError = 'your CODEX_CONFIG is not a JSON object';
    } catch {
      configError = 'your CODEX_CONFIG is not valid JSON';
    }
  }
  let hooksOff = '';
  const features = config && isDict(config.features) ? config.features as Json : {};
  for (const key of FEATURE_KEYS) if (key in features && features[key] !== true) hooksOff ||= `features.${key} is off in your CODEX_CONFIG`;
  const system = systemCodexDir(env, os);
  const tomls: [string, string][] = [
    ['your Codex config.toml', join(codexHome(env), 'config.toml')],
    ["the project's .codex/config.toml", join(cwd, '.codex', 'config.toml')],
    ['the system Codex config.toml', join(system, 'config.toml')],
  ];
  for (const [where, path] of tomls) {
    const text = readText(path);
    if (!hooksOff && text !== null && tomlTurnsHooksOff(text)) hooksOff = `hooks are off in ${where}`;
  }
  for (const name of ['requirements.toml', 'managed_config.toml']) {
    const text = readText(join(system, name));
    if (!hooksOff && text !== null && requirementsManagedOnly(text)) {
      hooksOff = `allow_managed_hooks_only is on in the managed Codex ${name}`;
    }
  }
  return { config, configError, hooksOff };
}

// ---- the system prompt lines ------------------------------------------------------------------------------------------------

export const CODEX_SUBAGENT_PROMPT = 'Subagents you start with spawn_agent work in their own git worktree: AIB runs their shell commands ' +
  "there and merges their changes into this folder when each one finishes (and tells you which files changed). Do not merge, cherry-pick or copy files from a subagent's " +
  'worktree yourself.';

export const CODEX_SUBAGENTS_OFF_PROMPT = 'In this chat, subagents (spawn_agent) are turned off, because AIB could not give them their ' +
  'own git worktree. Do the work yourself.';

// ---- the hook routes --------------------------------------------------------------------------------------------------------

export const CODEX_TEXTS = {
  noWorktree: "AIB has no worktree for this subagent, so it can't run commands or edit files. Finish, and ask the main agent to start " +
    'a new subagent.',
  mainFolder: (wt: string) =>
    `This subagent works in its own git worktree, ${wt}; it can't use the main folder. Run the command in the worktree (relative ` +
    'paths, or absolute ones inside it).',
  patch: (wt: string) =>
    `This subagent works in its own git worktree, ${wt}. Use apply_patch with absolute paths inside it (e.g. ${
      join(wt, 'src', 'file.ts')
    }).`,
  mcp: "Subagents can't use this tool in AIB: it could change files outside the subagent's worktree. Ask the main agent to do it.",
  context: (wt: string, folder: string) =>
    `AIB gave you your own git worktree: ${wt}. Work only there. Your shell commands start in it (AIB runs each one there); with ` +
    `apply_patch, use absolute paths inside it. Never touch the main folder, ${folder}: AIB merges your work into it when the main ` +
    "agent's turn ends.",
};

const json = (payload: unknown): HookAnswer => ({ status: 200, body: JSON.stringify(payload), type: 'application/json' });
const pass = (): HookAnswer => json({});

const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

/** Forward slashes (PowerShell and bash both read them; Git Bash takes C:/...). */
const forward = (p: string) => p.replaceAll('\\', '/');

/** One key-checked Codex hook call of an open chat that was given hooks. Never throws. */
export async function codexHook(service: SubagentWorktrees, event: string, chat: SubagentChat, body: Json): Promise<HookAnswer> {
  const agentId = str(body.agent_id, 64);
  switch (event) {
    case 'codex-pre-tool':
      return agentId ? await subagentCall(service, chat, agentId, body) : await mainCall(service, chat, body);
    case 'codex-subagent-start': {
      if (!agentId) return pass();
      const rec = await service.bindAgent(chat.id, agentId, str(body.agent_type));
      if (!rec) return pass(); // its calls are refused (CODEX_TEXTS.noWorktree)
      return json({
        hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_TEXTS.context(rec.path, chat.folder) },
      });
    }
    case 'codex-subagent-stop':
      await service.agentEnded(chat.id, agentId);
      return pass();
    default:
      return { status: 404, body: 'Not found', type: 'text/plain' };
  }
}

async function mainCall(service: SubagentWorktrees, chat: SubagentChat, body: Json): Promise<HookAnswer> {
  if (body.tool_name !== 'spawn_agent') return pass(); // the forwarder passes these itself
  const input = isDict(body.tool_input) ? body.tool_input as Json : {};
  const message = str(input.message, 2000) || (Array.isArray(input.items) ? 'subagent' : '');
  const outcome = await service.prepareFor(chat, {
    toolUseId: str(body.tool_use_id),
    agentType: str(input.agent_type) || 'default',
    description: message.replace(/\s+/g, ' ').trim().slice(0, 60) || 'subagent',
  });
  return 'deny' in outcome ? deny(outcome.deny) : pass();
}

async function subagentCall(service: SubagentWorktrees, chat: SubagentChat, agentId: string, body: Json): Promise<HookAnswer> {
  const rec = service.runningAgent(chat.id, agentId) ?? await service.bindAgent(chat.id, agentId, str(body.agent_type));
  if (!rec) return deny(CODEX_TEXTS.noWorktree);
  const tool = str(body.tool_name, 300);
  const input = isDict(body.tool_input) ? body.tool_input as Json : {};
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (namesFolder(command, [chat.folder, chat.project], rec.path)) return deny(CODEX_TEXTS.mainFolder(rec.path));
    return json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow', // with updatedInput only (Codex refuses a bare allow); its approval flow still applies
        // hook 2: AIB's cookie prefix in front of the cd, only for a subagent's call whose shell is known (shell_tag.ts); '' otherwise
        updatedInput: { command: `${codexTagPrefix(chat, agentId, body, command)}cd '${forward(rec.path)}'; ${command}` },
      },
    });
  }
  if (tool === 'apply_patch') {
    const patch = typeof input.command === 'string' ? input.command : '';
    return patchInside(patch, rec.path) ? pass() : deny(CODEX_TEXTS.patch(rec.path));
  }
  if (tool.startsWith('mcp__')) {
    const ok = tool.startsWith('mcp__studio_artifact__') && !/merge_into_project|resolve_edit_clash/.test(tool);
    return ok ? pass() : deny(CODEX_TEXTS.mcp);
  }
  return pass();
}

/** Lowercased on Windows, separators as backslashes, doubled ones single, and Git Bash's /c/... as \c\... */
function canon(text: string): string {
  const t = text.replaceAll('/', '\\').replace(/\\{2,}/g, '\\');
  return Deno.build.os === 'windows' ? t.toLowerCase() : t;
}

/**
 * The command names one of `folders` (any slash form, Git Bash's /c/...), not counting the worktree's own path (which may sit
 * below one of them, e.g. under the user's home). A heuristic: the shell is not parsed (design 1.4).
 */
export function namesFolder(command: string, folders: string[], worktree: string): boolean {
  let text = canon(command);
  for (const own of [worktree, forward(worktree)]) text = text.split(canon(own)).join('\u0000');
  for (const folder of folders.filter((f) => !!f)) {
    const f = canon(folder).replace(/\\+$/, '');
    const forms = [f];
    const drive = /^([a-z]):\\(.*)$/i.exec(f);
    if (drive) forms.push(`\\${drive[1]}\\${drive[2]}`); // /c/Users/... in Git Bash
    for (const form of forms) {
      let at = text.indexOf(form);
      while (at >= 0) {
        const next = text[at + form.length] ?? '';
        if (!/[A-Za-z0-9_.-]/.test(next)) return true;
        at = text.indexOf(form, at + 1);
      }
    }
  }
  return false;
}

/** Every file an apply_patch names is an absolute path inside `worktree` (no `..`). A patch naming no file passes. */
export function patchInside(patch: string, worktree: string): boolean {
  const root = canon(worktree).replace(/\\+$/, '') + '\\';
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\r?$/.exec(line);
    if (!m) {
      if (/^\*\*\* /.test(line) && !/^\*\*\* (Begin Patch|End Patch|End of File)/.test(line)) return false;
      continue;
    }
    const path = m[1].trim();
    if (!/^([A-Za-z]:[\\/]|\/)/.test(path) || /(^|[\\/])\.\.?([\\/]|$)/.test(path)) return false;
    if (!canon(path).startsWith(root)) return false;
  }
  return true;
}
