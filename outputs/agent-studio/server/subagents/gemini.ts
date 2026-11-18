/**
 * Subagent worktrees, Gemini CLI part (aib-shared design gemini-proof.md; verified on Gemini CLI 0.68.0 under ACP). Owner rule: an agent's
 * own subagent that edits files works in its own git worktree, landed like a helper's; when that can't run, its edits are refused,
 * never made in the folder.
 *
 * Two layers, both per chat, neither touching the user's ~/.gemini:
 *
 *   Fence (always): `--admin-policy <dir>` with one TOML file AIB writes. For every subagent name Gemini can run (generalist, the
 *     built-in read-only ones, and each custom agent found in the project's, the user's and the extensions' agents folders; policy
 *     rules match exact names), it denies run_shell_command and MCP tools always, and write_file / replace unless file_path is inside
 *     this chat's own subagent folder (<state>/worktrees/<repo hash>/.gem-<chat>/) with no `..`. With no redirect, every subagent edit
 *     is denied. Gemini checks the policy AFTER BeforeTool hooks, on the rewritten arguments, so the fence holds whatever the hook does
 *     (AIB down, a squatter on its port, hooks off): a subagent edit lands in its worktree or nowhere.
 *
 *   Redirect (API-key sign-in, git project, keeper program present): a per-chat GEMINI_CLI_HOME (<state>/gemini/<chat>/home) whose
 *     .gemini/settings.json is the user's settings plus one BeforeTool hook for write_file|replace that runs the keeper's forwarder
 *     (`AIB-keeper hook gemini-before-tool <address file>`, signed answers as for Claude). Everything else in the user's ~/.gemini is
 *     there too: folders as junctions (session history in tmp/ and history/ stays shared, so resume works), files as copies (never
 *     written back). AIB's subagent folder goes in with `--include-directories`. Who is calling comes from the parent's ACP stream
 *     (an invoke_agent tool call in progress), never from the hook input (Gemini sends the same session for parent and subagent).
 *     The worktree is made when the call starts (record first, P1's service), bound to the call id; the hook rewrites file_path
 *     into it; the call's end marks it done and the swarm landing lands it when the parent is idle (P2's path).
 *
 * Google-login chats get the fence only: their sign-in (oauth_creds.json, refreshed and rewritten by Gemini) can't be checked here
 * without an account, and a copied or linked credentials file could leave the user signed out or on stale tokens. They get a chat line.
 */
import { getLogger } from '../core/log.ts';
import { isDict } from '../core/py.ts';
import { pathOf } from '../state/paths.ts';
import { normcase, SEP } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { type SubagentRecord, SubagentWorktrees, unlinkLinks } from './service.ts';

const log = getLogger('subagents.gemini');
const WIN = Deno.build.os === 'windows';

/** Built-in Gemini subagents (0.68.0): generalist edits; codebase_investigator and cli_help only read (fenced all the same). */
export const BUILTIN_AGENTS = ['generalist', 'codebase_investigator', 'cli_help'];
/** Their editing tools the hook moves; the shell can't be moved safely (absolute paths, cd), so it is always denied to subagents. */
export const EDIT_TOOLS = ['write_file', 'replace'];
/** How long the hook route waits for a worktree that is still being made (the forwarder gives up at 10 s; the fence then denies). */
const READY_BUDGET_MS = 8000;

export const GEMINI_TEXTS = {
  fence:
    "AIB: this subagent can't change files in the project folder. In AIB, a subagent's edits go to its own git worktree; if AIB was " +
    'restarting, try again in a moment.',
  shell: "AIB: subagents can't run shell commands in AIB chats (their edits must go to their own worktree). Ask the main agent to run it.",
  mcp: "AIB: subagents can't use MCP tools in AIB chats, because AIB can't keep their edits in their own worktree.",
  off: (why: string) =>
    `Subagents that edit files are off in this Gemini chat: ${why}. AIB denies their edits instead of letting them change the ` +
    'project folder; read-only subagents still work.',
  outside: "AIB: this subagent may only change files inside the project (AIB puts them in the subagent's own worktree).",
  ambiguous: "AIB can't tell which of several running subagents made this change, so it was not made. Run one subagent at a time.",
};

/** The reasons a chat gets the fence only (its chat line names them). */
export const OFF = {
  googleLogin: 'it signs in with a Google login, and AIB only moves subagent edits for API-key sign-in',
  notGit: 'the folder is not a git project',
  noCommits: 'the repository has no commits yet',
  noKeeper: "AIB's keeper program can't run hooks",
  settings: "AIB couldn't read your Gemini settings",
  hooksOff: 'hooks are off in your Gemini settings',
  wsl: 'WSL chats come later',
  noKey: 'AIB has no key secret',
};

// ---- reading the user's setup (read only) ------------------------------------------------------------------------------------

/** The home Gemini uses for this agent environment (GEMINI_CLI_HOME, else the user's home). */
export function geminiHomeOf(env: Record<string, string>): string {
  return env.GEMINI_CLI_HOME || (WIN ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || '';
}

/** JSON with // and /* comments (Gemini's settings files), or null. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0, quoted = false; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** The user's ~/.gemini/settings.json: {} when there is none, null when it can't be read. */
export function readUserSettings(home: string): Record<string, unknown> | null {
  const file = pathOf(home, '.gemini', 'settings.json');
  let text: string;
  try {
    text = Deno.readTextFileSync(file);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? {} : null;
  }
  if (!text.trim()) return {};
  const parsed = parseJsonc(text);
  return isDict(parsed) ? parsed as Record<string, unknown> : null;
}

const dig = (o: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((v, k) => (isDict(v) ? (v as Record<string, unknown>)[k] : undefined), o);

/** How the chat signs in: 'api-key' (a Gemini or Vertex key in its environment, no other method picked), else 'google-login'. */
export function geminiAuth(env: Record<string, string>, settings: Record<string, unknown>): 'api-key' | 'google-login' {
  const picked = String(dig(settings, 'security', 'auth', 'selectedType') ?? settings.selectedAuthType ?? '');
  const key = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  if (key && (!picked || picked === 'gemini-api-key' || picked === 'vertex-ai')) return 'api-key';
  return 'google-login';
}

/** Hooks turned off in the user's settings (hooksConfig.enabled false), or by system settings AIB can read. */
export function hooksOff(settings: Record<string, unknown>): boolean {
  return dig(settings, 'hooksConfig', 'enabled') === false;
}

/** A custom agent's name from its front matter (`name:`), else its file name; '' when neither is a usable name. */
function agentName(file: string): string {
  let text = '';
  try {
    text = Deno.readTextFileSync(file).slice(0, 8192);
  } catch {
    return '';
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const named = front ? /^name:\s*["']?([^"'\r\n#]+?)["']?\s*$/m.exec(front[1]) : null;
  const name = (named ? named[1] : file.replace(/^.*[\\/]/, '').replace(/\.md$/i, '')).trim();
  return /^[\w.:@-]{1,100}$/.test(name) ? name : '';
}

function mdFiles(dir: string): string[] {
  try {
    return [...Deno.readDirSync(dir)].filter((e) => !e.isDirectory && /\.md$/i.test(e.name)).map((e) => pathOf(dir, e.name));
  } catch {
    return [];
  }
}

/** Every subagent name Gemini can run here: the built-ins, the project's and the user's agents, and installed extensions' agents. */
export function agentNames(project: string, home: string): string[] {
  const names = new Set(BUILTIN_AGENTS);
  const files = [...mdFiles(pathOf(project, '.gemini', 'agents')), ...mdFiles(pathOf(home, '.gemini', 'agents'))];
  try {
    for (const ext of Deno.readDirSync(pathOf(home, '.gemini', 'extensions'))) {
      if (ext.isDirectory || ext.isSymlink) files.push(...mdFiles(pathOf(home, '.gemini', 'extensions', ext.name, 'agents')));
    }
  } catch { /* none */ }
  for (const f of files) {
    const n = agentName(f);
    if (n) names.add(n);
  }
  return [...names].sort();
}

// ---- the fence --------------------------------------------------------------------------------------------------------------

const tomlString = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The admin policy for one chat: per subagent name, deny the shell and MCP tools, and deny write_file / replace unless (redirect on)
 * file_path starts with the chat's subagent folder and has no `..`. Gemini matches argsPattern on its stable JSON of the arguments
 * (keys sorted, no spaces), so the prefix is matched as JSON text.
 */
export function policyToml(names: string[], subFolder: string | null): string {
  const lines = ['# AIB: subagents of this one chat may not change the project folder (subagent worktrees). Written by AIB; not yours.', ''];
  const rule = (fields: Record<string, string | string[] | number>) => {
    lines.push('[[rule]]');
    for (const [k, v] of Object.entries(fields)) {
      lines.push(`${k} = ${typeof v === 'number' ? v : Array.isArray(v) ? `[${v.map(tomlString).join(', ')}]` : tomlString(v)}`);
    }
    lines.push('');
  };
  const prefix = subFolder ? JSON.stringify(subFolder.replace(/[\\/]+$/, '') + SEP).slice(1, -1) : '';
  for (const name of names) {
    if (subFolder) {
      rule({ toolName: EDIT_TOOLS, subagent: name, argsPattern: `"file_path":"(?!${regexEscape(prefix)})`, decision: 'deny', priority: 999, denyMessage: GEMINI_TEXTS.fence });
      rule({ toolName: EDIT_TOOLS, subagent: name, argsPattern: `"file_path":"[^"]*\\.\\.`, /* no nested quantifier: Gemini drops those (ReDoS) */ decision: 'deny', priority: 999, denyMessage: GEMINI_TEXTS.fence });
    } else {
      rule({ toolName: EDIT_TOOLS, subagent: name, decision: 'deny', priority: 999, denyMessage: GEMINI_TEXTS.fence });
    }
    rule({ toolName: 'run_shell_command', subagent: name, decision: 'deny', priority: 999, denyMessage: GEMINI_TEXTS.shell });
    rule({ toolName: 'mcp_*', subagent: name, decision: 'deny', priority: 999, denyMessage: GEMINI_TEXTS.mcp });
  }
  return lines.join('\n');
}

// ---- the redirect's home ----------------------------------------------------------------------------------------------------

/** The hook command Gemini runs (PowerShell on Windows, bash elsewhere): the forwarder, its event and AIB's address file. */
export function hookCommand(forwarder: string, addressFile: string): string {
  if (WIN) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    return `& ${q(forwarder)} hook gemini-before-tool ${q(addressFile)}`;
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${q(forwarder)} hook gemini-before-tool ${q(addressFile)}`;
}

/** The user's settings plus AIB's BeforeTool hook (after the user's own), its key and chat id in the hook entry's env. */
export function mergedSettings(user: Record<string, unknown>, command: string, env: Record<string, string>): Record<string, unknown> {
  const out = structuredClone(user);
  const hooks = isDict(out.hooks) ? out.hooks as Record<string, unknown> : {};
  const before = Array.isArray(hooks.BeforeTool) ? hooks.BeforeTool : [];
  const entry = { matcher: EDIT_TOOLS.join('|'), hooks: [{ type: 'command', command, timeout: 15000, env }] };
  out.hooks = { ...hooks, BeforeTool: [...before, entry] };
  return out;
}

/**
 * Builds <dir>/.gemini: settings.json (merged), every folder of the user's ~/.gemini as a junction (symlink elsewhere) to it, every
 * other file as a copy. Nothing in the user's folder is written. When the user has no ~/.gemini yet, its tmp/ and history/ go to
 * `shared` (one AIB folder for all such chats), so a chat's history is found again on reopen.
 */
export function buildHome(dir: string, realHome: string, settings: Record<string, unknown>, shared: string): void {
  const gem = pathOf(dir, '.gemini');
  removeHome(dir);
  Deno.mkdirSync(gem, { recursive: true });
  const real = pathOf(realHome, '.gemini');
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(real)];
  } catch { /* no ~/.gemini yet */ }
  const link = (target: string, at: string) => Deno.symlinkSync(target, at, WIN ? { type: 'junction' } : { type: 'dir' });
  if (!entries.length) {
    for (const name of ['tmp', 'history']) {
      Deno.mkdirSync(pathOf(shared, name), { recursive: true });
      link(pathOf(shared, name), pathOf(gem, name));
    }
  }
  for (const e of entries) {
    if (e.name === 'settings.json' || e.name.endsWith('.lock')) continue;
    const from = pathOf(real, e.name), to = pathOf(gem, e.name);
    try {
      const st = Deno.statSync(from);
      if (st.isDirectory) link(from, to);
      else if (st.isFile && st.size < 4 * 1024 * 1024) Deno.copyFileSync(from, to);
    } catch (error) {
      log.warning('Gemini home: %s not linked (%s)', from, error instanceof Error ? error.message : error);
    }
  }
  Deno.writeTextFileSync(pathOf(gem, 'settings.json'), JSON.stringify(settings, null, 2));
}

/** Removes a chat's home: its junctions first (never what they point at), then the folder. */
export function removeHome(dir: string): void {
  try {
    Deno.lstatSync(dir);
  } catch {
    return;
  }
  unlinkLinks(dir);
  Deno.removeSync(dir, { recursive: true });
}

// ---- the chat's setup -------------------------------------------------------------------------------------------------------

/** What a Gemini chat was given (on the Connection as `geminiSubagents`). */
export interface GeminiSetup {
  /** The admin policy folder (always: the fence). */
  policyDir: string;
  /** Redirect on: the per-chat home and subagent folder; off: why (the chat line names it). */
  home: string;
  subFolder: string;
  off: string;
  /** Per-chat folder AIB owns under <state>/gemini/ (removed when the chat goes). */
  dir: string;
}

export interface SetupInput {
  stateDir: string;
  /** AIB's worktrees folder (the subagent service's root). */
  root: string;
  chatId: string;
  project: string;
  folder: string;
  env: Record<string, string>;
  gitProject: '' | 'not a git project' | 'the repository has no commits yet';
  forwarder: string | null;
  addressFile: string;
  hookKey: string | null;
  wsl: boolean;
}

/** Decide fence-only or fence + redirect for a new Gemini chat and write its files; the launch args and env to add. */
export function setUp(i: SetupInput): { setup: GeminiSetup; args: string[]; env: Record<string, string> } {
  const dir = pathOf(i.stateDir, 'gemini', i.chatId);
  const policyDir = pathOf(dir, 'policy');
  const realHome = geminiHomeOf(i.env);
  const settings = readUserSettings(realHome);
  const off = i.wsl
    ? OFF.wsl
    : i.gitProject === 'not a git project'
    ? OFF.notGit
    : i.gitProject
    ? OFF.noCommits
    : settings === null
    ? OFF.settings
    : geminiAuth(i.env, settings) !== 'api-key'
    ? OFF.googleLogin
    : hooksOff(settings)
    ? OFF.hooksOff
    : !i.forwarder
    ? OFF.noKeeper
    : !i.hookKey
    ? OFF.noKey
    : '';
  const subFolder = off ? '' : pathOf(i.root, wt.repoHash(i.project), `.gem-${i.chatId}`);
  Deno.mkdirSync(policyDir, { recursive: true });
  Deno.writeTextFileSync(pathOf(policyDir, 'aib-subagents.toml'), policyToml(agentNames(i.project, realHome), subFolder || null));
  const args = ['--admin-policy', policyDir];
  if (off) return { setup: { policyDir, home: '', subFolder: '', off, dir }, args, env: {} };
  const home = pathOf(dir, 'home');
  Deno.mkdirSync(subFolder, { recursive: true });
  const command = hookCommand(i.forwarder!, i.addressFile);
  buildHome(home, realHome, mergedSettings(settings!, command, { AIB_HOOK_KEY: i.hookKey!, AIB_HOOK_CHAT: i.chatId }), pathOf(i.stateDir, 'gemini', 'shared'));
  return {
    setup: { policyDir, home, subFolder, off: '', dir },
    args: [...args, '--include-directories', subFolder],
    env: { GEMINI_CLI_HOME: home },
  };
}

/** The chat is gone: its home (junctions unlinked first), policy and empty subagent folder go. Never throws. */
export function tearDown(setup: GeminiSetup): void {
  try {
    removeHome(setup.dir);
  } catch (error) {
    log.warning('Removing the Gemini chat folder %s failed: %s', setup.dir, error instanceof Error ? error.message : error);
  }
  if (setup.subFolder) {
    try {
      Deno.removeSync(setup.subFolder); // only when empty: a worktree still in it is landing's
    } catch { /* not empty, or gone */ }
  }
}

// ---- who is calling, and the hook route -------------------------------------------------------------------------------------

interface Bracket {
  callId: string;
  agent: string;
  ready: Promise<SubagentRecord | string | null>;
}

export interface HookAnswer {
  status: number;
  body: string;
  type: 'application/json' | 'text/plain';
}

const json = (payload: unknown): HookAnswer => ({ status: 200, body: JSON.stringify(payload), type: 'application/json' });
const deny = (reason: string) => json({ decision: 'deny', reason });

/** A subagent's key: its invoke_agent call id as the record's agentId (service.ts startExternal) and its Activity card's id. */
export function agentKey(callId: string): string {
  return callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * What its Activity card says, from the parent's invoke_agent call (Gemini's ACP stream has no child session of its own): a
 * subagent_update keyed by agentKey, so the card's fixed line reads P3's {where, landing} for that agentId. null: no change to tell.
 */
export function cardUpdate(callId: string, title: string, status: string, told: Map<string, { state: string; agent: string }>): Record<string, unknown> | null {
  const key = agentKey(callId);
  const state = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'running';
  const was = told.get(key);
  if (was && was.state === state) return null;
  const agent = was?.agent || agentOfTitle(title) || 'subagent';
  told.set(key, { state, agent });
  while (told.size > 200) told.delete(told.keys().next().value!);
  return { sessionUpdate: 'subagent_update', sessionId: key, title: agent, description: title.slice(0, 300), agentType: agent, state };
}

/** The subagent name in Gemini's invoke_agent call title ("Delegating to agent 'generalist'"), else ''. */
export function agentOfTitle(title: string): string {
  const m = /agent\s+['"‘“]([^'"’”]{1,100})['"’”]/.exec(title);
  return m ? m[1] : '';
}

export class GeminiSubagents {
  /** Per chat: the invoke_agent calls the parent's ACP stream shows running now. */
  readonly #open = new Map<string, Map<string, Bracket>>();

  constructor(
    readonly service: SubagentWorktrees,
    /** The open chat's folder and subagent folder, or null (not open, or no redirect). */
    readonly chat: (id: string) => { folder: string; subFolder: string } | null,
  ) {}

  /** An invoke_agent tool call of the parent (main session) changed: start its worktree, or end it. Never throws. */
  toolUpdate(chatId: string, callId: string, title: string, status: string): void {
    const open = this.#open.get(chatId) ?? new Map<string, Bracket>();
    this.#open.set(chatId, open);
    const known = open.get(callId);
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      if (!known) return;
      open.delete(callId);
      void known.ready.then((rec) => {
        if (rec && typeof rec !== 'string') return this.service.endExternal(chatId, rec.toolUseId, status === 'completed');
      }).catch((error) => log.exception(error, 'Ending a Gemini subagent failed'));
      return;
    }
    if (known) return;
    const agent = agentOfTitle(title) || 'subagent';
    // a read-only built-in gets no worktree (its edit tools are fenced all the same)
    const ready = agent === 'codebase_investigator' || agent === 'cli_help' || !this.chat(chatId)
      ? Promise.resolve(null)
      : this.service.startExternal(chatId, { callId, agentType: agent, description: `${agent} (Gemini)` }).catch((error) => {
        log.exception(error, 'Making a Gemini subagent worktree failed');
        return `AIB couldn't make a worktree for this subagent (${error instanceof Error ? error.message : error})`;
      });
    open.set(callId, { callId, agent, ready });
  }

  /** The turn ended or was stopped: nothing runs any more; a call whose end AIB never saw is stopped (kept, never landed by itself). */
  turnOver(chatId: string): void {
    const open = this.#open.get(chatId);
    this.#open.delete(chatId);
    for (const b of open?.values() ?? []) {
      void b.ready.then((rec) => {
        if (rec && typeof rec !== 'string') return this.service.endExternal(chatId, rec.toolUseId, false);
      }).catch((error) => log.exception(error, 'Stopping a Gemini subagent failed'));
    }
  }

  chatClosed(chatId: string): void {
    this.#open.delete(chatId);
  }

  /** BeforeTool for write_file / replace (key already checked for `chatId`). Never throws. */
  async beforeTool(chatId: string, body: unknown): Promise<HookAnswer> {
    try {
      return await this.#beforeTool(chatId, body);
    } catch (error) {
      log.exception(error, 'Gemini BeforeTool hook failed');
      return deny(`AIB couldn't place this subagent's change: ${error instanceof Error ? error.message : error}`);
    }
  }

  async #beforeTool(chatId: string, body: unknown): Promise<HookAnswer> {
    const chat = this.chat(chatId);
    if (!chat || !isDict(body)) return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
    const b = body as Record<string, unknown>;
    const tool = String(b.tool_name ?? '');
    if (!EDIT_TOOLS.includes(tool)) return json({});
    const running = [...(this.#open.get(chatId)?.values() ?? [])];
    if (!running.length) return json({}); // the parent's own call (under ACP they skip hooks today): Gemini's own rules
    if (running.length > 1) return deny(GEMINI_TEXTS.ambiguous);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<'slow'>((resolve) => (timer = setTimeout(() => resolve('slow'), READY_BUDGET_MS)));
    const rec = await Promise.race([running[0].ready, slow]).finally(() => clearTimeout(timer));
    if (rec === 'slow') return deny('AIB is still preparing a worktree for this subagent; try again in a moment.');
    if (rec === null) return deny(GEMINI_TEXTS.fence); // a read-only subagent
    if (typeof rec === 'string') return deny(`AIB couldn't make a worktree for this subagent: ${rec}.`);
    const input = isDict(b.tool_input) ? b.tool_input as Record<string, unknown> : {};
    const given = typeof input.file_path === 'string' ? input.file_path : '';
    const rel = relativeInside(given, chat.folder, rec.path);
    if (rel === null) return deny(GEMINI_TEXTS.outside);
    return json({ hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: { ...input, file_path: pathOf(rec.path, ...rel) } } });
  }
}

/**
 * `given` (relative to the folder, or absolute in the folder or already in the worktree) as path parts inside the folder; null when
 * it is outside both, empty, or climbs out with `..`.
 */
export function relativeInside(given: string, folder: string, worktree: string): string[] | null {
  if (!given || given.includes('\0')) return null;
  const parts = given.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(given);
  if (!absolute) return parts.length ? parts : null;
  const key = (p: string) => normcase(p.replace(/[\\/]+/g, SEP)).replace(/[\\/]+$/, '');
  const full = key(given);
  for (const base of [worktree, folder]) {
    const b = key(base);
    if (full.startsWith(b + SEP)) {
      const rest = given.replace(/[\\/]+/g, SEP).slice(b.length + 1).split(SEP).filter((p) => p !== '' && p !== '.');
      return rest.length ? rest : null;
    }
  }
  return null;
}

// ---- after a restart --------------------------------------------------------------------------------------------------------

const CHAT_ID = /^[0-9a-f]{32}$/;

/**
 * A Gemini chat taken over from the keeper after an AIB restart: its setup as it was launched, read back from AIB's own folders
 * (the agent process still runs with them). Null when AIB made none for it.
 */
export function restore(stateDir: string, root: string, chatId: string, project: string): GeminiSetup | null {
  if (!CHAT_ID.test(chatId)) return null;
  const dir = pathOf(stateDir, 'gemini', chatId);
  const policyDir = pathOf(dir, 'policy');
  const there = (p: string) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  };
  if (!there(pathOf(policyDir, 'aib-subagents.toml'))) return null;
  const home = pathOf(dir, 'home');
  const subFolder = pathOf(root, wt.repoHash(project), `.gem-${chatId}`);
  if (there(pathOf(home, '.gemini', 'settings.json')) && there(subFolder)) return { policyDir, home, subFolder, off: '', dir };
  return { policyDir, home: '', subFolder: '', off: 'it started with the fence only', dir };
}

/** The chat ids in running agents' command lines (`--admin-policy <state>/gemini/<id>/policy`): their folders stay. */
export function idsInArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const m = /[\\/]gemini[\\/]([0-9a-f]{32})[\\/]policy$/.exec(a);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * At start, after the keeper's running chats are known: every <state>/gemini/<id> folder (this install's only) whose chat is not
 * open here and not running in the keeper, and older than `minAgeS`, goes, junctions unlinked first; its empty .gem-<id> subagent
 * folder too (one holding a worktree is landing's or cleanup's). Never throws.
 */
export function sweep(stateDir: string, root: string, keep: Set<string>, minAgeS = 3600): number {
  let removed = 0;
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(pathOf(stateDir, 'gemini'))];
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory || !CHAT_ID.test(e.name) || keep.has(e.name)) continue;
    const dir = pathOf(stateDir, 'gemini', e.name);
    try {
      const st = Deno.lstatSync(dir);
      if (st.isSymlink || (st.mtime && Date.now() - st.mtime.getTime() < minAgeS * 1000)) continue;
      removeHome(dir);
      removed++;
    } catch (error) {
      log.warning('Gemini sweep: %s stays (%s)', dir, error instanceof Error ? error.message : error);
    }
  }
  try {
    for (const repo of Deno.readDirSync(root)) {
      if (!repo.isDirectory) continue;
      for (const g of Deno.readDirSync(pathOf(root, repo.name))) {
        const m = /^\.gem-([0-9a-f]{32})$/.exec(g.name);
        if (!m || keep.has(m[1])) continue;
        try {
          Deno.removeSync(pathOf(root, repo.name, g.name)); // empty only
        } catch { /* holds a worktree, or gone */ }
      }
    }
  } catch { /* no worktrees folder */ }
  return removed;
}
