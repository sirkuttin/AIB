/**
 * Subagent worktrees, Claude Code (design v2 2.1, 2.2, 2.3.6, 2.6; P0b): what AIB reads of the user's Claude Code setup (read only,
 * never written) and the per-session settings it gives a chat.
 *
 *   readClaudeSetup(cwd, env)  the read-only agent types (built-ins + custom agents whose `tools` are all known read-only tools),
 *                              whether any settings tier or plugin defines its own WorktreeCreate hook, and whether hooks are off
 *                              (disableAllHooks / allowManagedHooksOnly). Sources: user (CLAUDE_CONFIG_DIR or ~/.claude), project
 *                              (.claude/settings.json, settings.local.json, agents/), installed plugins (agents/, hooks/hooks.json),
 *                              managed settings (the file, managed-settings.d/, the HKLM/HKCU policy keys).
 *   gitBashPath(env)           Git Bash as Claude Code finds it (it runs the hooks); none: its editing subagents are denied (subagentsOffSettings).
 *   hookSettings(...)          the `_meta.claudeCode.options.settings` object: command hooks that run the keeper's forwarder
 *                              (`<keeper> hook <event> <address file>`). It holds no port and no key, so it is byte-identical on every
 *                              reopen (the adapter rebuilds the session when settings change).
 */
import { isDict } from '../core/py.ts';
import { dirname, join } from '../platform/path.ts';
import { policyText } from '../platform/registry.ts';

type Json = Record<string, unknown>;

/** Built-in agent types that cannot edit the project (statusline-setup edits only the user's own Claude settings). */
export const BUILTIN_READ_ONLY = ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup'];
/**
 * A custom agent is read-only only when EVERY tool its `tools` list names is one of these (security review P1, MF 3: an allowlist;
 * an MCP tool, a wildcard, Skill, Agent or a tool Claude Code adds later may edit, so it gets a worktree).
 */
export const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch', 'ListAgents', 'ReportFindings',
]);

/**
 * The PreToolUse matcher: the spawning tool (and its old name), the two AIB refuses (P0b R8), and Skill (P3 probe, work/
 * p3_skill_fork_probe.py on 2.1.310: a skill or command with `context: fork` starts a subagent with no Agent call, so neither
 * PreToolUse(Agent) nor WorktreeCreate runs and its edits land in the folder; AIB refuses those skills).
 */
export const PRE_TOOL_MATCHER = 'Agent|Task|EnterWorktree|Workflow|Skill';
/** Claude Code's timeout for each hook, seconds: well above the forwarder's own 10 s deadline (P0b R2c: a timed-out hook fails open). */
export const HOOK_TIMEOUT_S = 30;

export interface ClaudeSetup {
  /** Agent types the forwarder passes without a worktree. */
  readOnly: string[];
  /** A user, project, local, plugin or managed WorktreeCreate hook exists: AIB sends none of its own (P0 A6: theirs would win). */
  userWorktreeHook: string;
  /** Why hooks are off ('' when on): AIB's hooks would not run either (P0 A7). */
  hooksOff: string;
}

function readJson(path: string): Json | null {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(path));
    return isDict(raw) ? raw as Json : null;
  } catch {
    return null;
  }
}

function listDir(dir: string): Deno.DirEntry[] {
  try {
    return [...Deno.readDirSync(dir)];
  } catch {
    return [];
  }
}

/** The Claude config folder the agent will use: its CLAUDE_CONFIG_DIR, else <home>/.claude. */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  const home = env.USERPROFILE || env.HOME || Deno.env.get('USERPROFILE') || Deno.env.get('HOME') || '';
  return join(home, '.claude');
}

/** The folder of Claude Code's managed settings (as Claude Code 2.1.310 names it). */
export function managedSettingsDir(): string {
  switch (Deno.build.os) {
    case 'windows':
      return 'C:\\Program Files\\ClaudeCode';
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    default:
      return '/etc/claude-code';
  }
}

export function managedSettingsPath(): string {
  return join(managedSettingsDir(), 'managed-settings.json');
}

/** Claude Code's policy settings in the Windows registry (HKLM and HKCU): a JSON document in the value `Settings`. */
const POLICY_KEY = 'SOFTWARE\\Policies\\ClaudeCode';

export type PolicyReader = (hive: 'HKLM' | 'HKCU', path: string, name: string) => string | undefined;
/** How the registry is read: the real one on Windows (FFI, no reg.exe child), none elsewhere; tests put their own. */
let policyReader: PolicyReader | null = Deno.build.os === 'windows' ? policyText : null;

/** Tests: read the policy keys through this (null: none). Returns the reader it replaced. */
export function setPolicyReader(reader: PolicyReader | null): PolicyReader | null {
  const was = policyReader;
  policyReader = reader;
  return was;
}

function parseJson(text: string | undefined): Json | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    return isDict(raw) ? raw as Json : null;
  } catch {
    return null;
  }
}

/**
 * Every managed settings document Claude Code reads (security review P1, should-fix 8; Claude Code 2.1.310): managed-settings.json,
 * the managed-settings.d drop-in folder (its *.json files not starting with '.', in name order) and, on Windows, the HKLM and HKCU
 * policy keys. `dir`: the managed folder (tests).
 */
export function managedSettings(dir = managedSettingsDir()): [string, Json | null][] {
  const out: [string, Json | null][] = [['managed Claude Code settings', readJson(join(dir, 'managed-settings.json'))]];
  const dropIn = join(dir, 'managed-settings.d');
  const names = listDir(dropIn).filter((e) => (e.isFile || e.isSymlink) && e.name.endsWith('.json') && !e.name.startsWith('.'))
    .map((e) => e.name).sort();
  for (const name of names) out.push([`managed Claude Code settings (managed-settings.d/${name})`, readJson(join(dropIn, name))]);
  for (const hive of ['HKLM', 'HKCU'] as const) {
    let text: string | undefined;
    try {
      text = policyReader?.(hive, POLICY_KEY, 'Settings');
    } catch {
      text = undefined; // no FFI permission: the files only
    }
    if (text !== undefined) out.push([`the Claude Code policy in the registry (${hive})`, parseJson(text)]);
  }
  return out;
}

/**
 * Git Bash as Claude Code 2.1.310 finds it on Windows (P0b R3: it runs command hooks; without it they run in another shell, where
 * AIB's hook command fails open; security review P1, MF 7): CLAUDE_CODE_GIT_BASH_PATH when it names an existing bash/sh, else
 * C:\Program Files\Git\bin\bash.exe or C:\Program Files (x86)\Git\bin\bash.exe, else <the first git on PATH>\..\..\bin\bash.exe.
 * Null when there is none. Off Windows: the shell is always there ('sh').
 */
export function gitBashPath(env: Record<string, string | undefined>, exists: (path: string) => boolean = isFile): string | null {
  if (Deno.build.os !== 'windows') return 'sh';
  const named = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (named) {
    const base = named.replace(/^.*[\\/]/, '').toLowerCase();
    if (['bash.exe', 'sh.exe', 'bash', 'sh'].includes(base) && exists(named)) return named;
  }
  for (const known of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (exists(known)) return known;
  }
  const path = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  const pathext = (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATHEXT')?.[1] || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of path.split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const ext of pathext) {
      if (!exists(join(dir, `git${ext.toLowerCase()}`))) continue;
      // <git>\..\..\bin\bash.exe: the folder above git's own folder (C:\Git\cmd\git.exe -> C:\Git\bin\bash.exe)
      const bash = join(dirname(dir.replace(/[\\/]+$/, '')), 'bin', 'bash.exe');
      return exists(bash) ? bash : null; // Claude Code looks only beside the first git it finds
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Installed plugin folders: installed_plugins.json's install paths, else every version folder under plugins/cache (depth 3). */
function pluginDirs(configDir: string): string[] {
  const out = new Set<string>();
  const installed = readJson(join(configDir, 'plugins', 'installed_plugins.json'));
  const plugins = installed && isDict(installed.plugins) ? installed.plugins as Json : {};
  for (const entries of Object.values(plugins)) {
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      if (isDict(e) && typeof e.installPath === 'string') out.add(e.installPath);
    }
  }
  const cache = join(configDir, 'plugins', 'cache');
  for (const market of listDir(cache)) {
    if (!market.isDirectory) continue;
    for (const plugin of listDir(join(cache, market.name))) {
      if (!plugin.isDirectory) continue;
      for (const version of listDir(join(cache, market.name, plugin.name))) {
        if (version.isDirectory) out.add(join(cache, market.name, plugin.name, version.name));
      }
    }
  }
  return [...out];
}

/** name -> read-only? for the agent files (*.md with front matter) in one folder. */
function customAgents(dir: string, into: Map<string, boolean>): void {
  for (const entry of listDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith('.md')) continue;
    let text: string;
    try {
      text = Deno.readTextFileSync(join(dir, entry.name)).slice(0, 20000);
    } catch {
      continue;
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!front) continue;
    const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(front[1])?.[1]?.trim() ?? null;
    const name = (field('name') ?? entry.name.replace(/\.md$/, '')).replace(/^["']|["']$/g, '');
    if (!name) continue;
    const tools = field('tools');
    // no `tools` (every tool), a list in another form, or its own MCP servers: it may edit. Else read-only only when every listed
    // tool is a known read-only one (an allowlist: mcp__*, "*", Skill and unknown tools may edit)
    const list = tools === null ? null : tools.replace(/[[\]"']/g, '').split(',').map((t) => t.trim().replace(/\(.*$/, '')).filter(Boolean);
    const ownServers = /^mcpServers:/m.test(front[1]);
    into.set(name, !!list && list.length > 0 && !ownServers && list.every((t) => READ_ONLY_TOOLS.has(t)));
  }
}

/** The front matter of a skill or command file says it runs as a forked subagent (`context: fork`). */
function forkFile(path: string): boolean {
  let text: string;
  try {
    text = Deno.readTextFileSync(path).slice(0, 20000);
  } catch {
    return false;
  }
  const front = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!front && /^context:[ \t]*["']?fork["']?[ \t]*$/m.test(front[1]);
}

/** Base names (as the Skill tool names them, without any `plugin:` or folder prefix) of the fork skills and commands under `root`. */
function forkNamesIn(root: string, into: Set<string>): void {
  for (const e of listDir(join(root, 'skills'))) {
    if (e.isDirectory && forkFile(join(root, 'skills', e.name, 'SKILL.md'))) into.add(e.name);
  }
  const commands = (dir: string, depth: number) => {
    for (const e of listDir(dir)) {
      if (e.isDirectory && depth < 3) commands(join(dir, e.name), depth + 1);
      else if (e.isFile && e.name.endsWith('.md') && forkFile(join(dir, e.name))) into.add(e.name.replace(/\.md$/, ''));
    }
  };
  commands(join(root, 'commands'), 0);
}

/**
 * The fork skills and commands a chat in `cwd` can call (P3 probe): the project's .claude, the user's config folder and every
 * installed plugin. Base names only: a `plugin:name` or `apps/web:name` call is refused when ANY fork skill has that base name
 * (refusing too much is safe; running a fork in the folder is not). Reads only; never throws.
 */
export function forkSkillNames(cwd: string, configDir: string): Set<string> {
  const out = new Set<string>();
  for (const root of [join(cwd, '.claude'), configDir, ...pluginDirs(configDir)]) forkNamesIn(root, out);
  return out;
}

/**
 * The Skill tool's `skill` names a skill or command that runs as a forked subagent (`context: fork`): its base name is a fork skill
 * of the project, the user or a plugin, or a directory-scoped name (`apps/web:deploy`) whose folder's .claude has it as one.
 */
export function isForkSkill(name: string, cwd: string, configDir: string): boolean {
  if (!name || name.length > 300) return false;
  const cut = name.lastIndexOf(':');
  const base = (cut >= 0 ? name.slice(cut + 1) : name).replace(/^\//, '');
  if (!base) return false;
  if (forkSkillNames(cwd, configDir).has(base)) return true;
  const scope = cut >= 0 ? name.slice(0, cut) : '';
  // a directory-scoped skill: <cwd>/<scope>/.claude (a plain relative folder only: no drive, no .., no leading slash)
  if (scope && /^[\w.-]+(\/[\w.-]+)*$/.test(scope) && !scope.split('/').includes('..')) {
    const nested = new Set<string>();
    forkNamesIn(join(cwd, ...scope.split('/'), '.claude'), nested);
    return nested.has(base);
  }
  return false;
}

function definesWorktreeCreate(settings: Json | null): boolean {
  const hooks = settings && isDict(settings.hooks) ? settings.hooks as Json : null;
  return !!hooks && Array.isArray(hooks.WorktreeCreate) && hooks.WorktreeCreate.length > 0;
}

/** What AIB needs to know of the user's Claude Code setup for a chat in `cwd`. Reads only; never throws. */
export function readClaudeSetup(cwd: string, env: Record<string, string | undefined>): ClaudeSetup {
  const configDir = claudeConfigDir(env);
  const tiers: [string, Json | null][] = [
    ['your Claude Code settings', readJson(join(configDir, 'settings.json'))],
    ["the project's .claude/settings.json", readJson(join(cwd, '.claude', 'settings.json'))],
    ["the project's .claude/settings.local.json", readJson(join(cwd, '.claude', 'settings.local.json'))],
    ...managedSettings(),
  ];
  let hooksOff = '';
  let userWorktreeHook = '';
  for (const [where, s] of tiers) {
    if (!s) continue;
    if (!hooksOff && s.disableAllHooks === true) hooksOff = `disableAllHooks is on in ${where}`;
    if (!hooksOff && s.allowManagedHooksOnly === true) hooksOff = `allowManagedHooksOnly is on in ${where}`; // AIB's hooks aren't managed
    if (!userWorktreeHook && definesWorktreeCreate(s)) userWorktreeHook = where;
  }
  const agents = new Map<string, boolean>(BUILTIN_READ_ONLY.map((n) => [n, true]));
  const plugins = pluginDirs(configDir);
  for (const dir of plugins) {
    customAgents(join(dir, 'agents'), agents);
    if (!userWorktreeHook && definesWorktreeCreate(readJson(join(dir, 'hooks', 'hooks.json')))) userWorktreeHook = `a plugin (${dir})`;
  }
  customAgents(join(configDir, 'agents'), agents); // user agents override plugin ones; project ones override both
  customAgents(join(cwd, '.claude', 'agents'), agents);
  const readOnly = [...agents].filter(([name, ro]) => ro && /^[\w.:-]+$/.test(name)).map(([name]) => name).sort();
  return { readOnly, userWorktreeHook, hooksOff };
}

/** A path as Git Bash reads it inside double quotes (P0b R3: Claude Code runs command hooks through Git Bash). Null if unsafe. */
export function bashPath(path: string): string | null {
  const p = path.replaceAll('\\', '/');
  return /["$`\\!\r\n]/.test(p) ? null : p;
}

/**
 * The per-session settings: command hooks through the keeper's forwarder. `|| exit 2` makes a missing or broken program block the
 * call too (bash's 127 would otherwise be a non-blocking error: the subagent would run unisolated). Null when a path can't be quoted.
 */
export function hookSettings(forwarder: string, addressFile: string, options: { worktreeCreate: boolean }): Json | null {
  const program = bashPath(forwarder), file = bashPath(addressFile);
  if (!program || !file) return null;
  const hook = (event: string, blocking: boolean) => ({
    type: 'command',
    command: `"${program}" hook ${event} "${file}"${blocking ? ' || exit 2' : ''}`,
    timeout: HOOK_TIMEOUT_S,
  });
  const hooks: Json = {
    PreToolUse: [{ matcher: PRE_TOOL_MATCHER, hooks: [hook('pre-tool', true)] }],
    PostToolUse: [{ matcher: 'Agent|Task', hooks: [hook('post-agent', false)] }],
    SubagentStop: [{ hooks: [hook('subagent-stop', false)] }],
  };
  if (options.worktreeCreate) hooks.WorktreeCreate = [{ hooks: [hook('worktree-create', true)] }];
  return { hooks };
}

/** The system prompt line for a chat whose subagents get their own worktree (design 2.5). */
export const SUBAGENT_PROMPT = 'Subagents that edit files work in their own git worktree. AIB merges their changes into this folder when ' +
  'your turn ends; do not merge, cherry-pick or copy files from a subagent\'s worktree yourself.';

/**
 * The chat line for a typed `/name` that runs as a forked subagent (connection.ts forkSkillRefusal): typed by the user, a fork skill
 * starts with no tool call, so AIB's hooks never see it and it would edit the folder (work/p3_skill_fork_probe.py typed-*).
 */
export const typedForkSkillText = (name: string) =>
  `AIB didn't send /${name}: it runs as a forked subagent (context: fork), and started by typing it, it would skip AIB's subagent ` +
  `rule and change this folder directly instead of working in its own worktree. Ask the agent to do its steps instead, or remove ` +
  `"context: fork" from the skill so it runs in this chat.`;

/** Built-in agent types that can edit (P0b R8: `claude` has every tool; `fork` copies the parent). */
export const BUILTIN_EDITING = ['general-purpose', 'claude', 'fork'];

/**
 * Hooks off in the user's Claude Code settings (P0 A7: AIB's hooks don't run, and `disableAllHooks` can't be overridden): owner rule
 * 2026-11-16, AIB turns that chat's editing subagents off rather than let them edit the folder. Per-session permission deny rules
 * (`_meta.claudeCode.options.settings.permissions.deny`, the --settings tier; verified on 2.1.310 with hooks off, bypass mode
 * included: "Agent type 'general-purpose' has been denied by permission rule"). Built-in editing types, every custom agent that can
 * edit (an Agent call with no type runs general-purpose), Workflow and EnterWorktree. Read-only types (Explore, Plan, ...) still run.
 */
export function subagentsOffSettings(cwd: string, env: Record<string, string | undefined>, readOnly: string[]): Json {
  const configDir = claudeConfigDir(env);
  const agents = new Map<string, boolean>();
  for (const dir of pluginDirs(configDir)) customAgents(join(dir, 'agents'), agents);
  customAgents(join(configDir, 'agents'), agents);
  customAgents(join(cwd, '.claude', 'agents'), agents);
  const ro = new Set(readOnly);
  const editing = [...new Set([...BUILTIN_EDITING, ...[...agents.keys()].filter((n) => !ro.has(n) && /^[\w.:-]+$/.test(n))])].sort();
  const forks = [...forkSkillNames(cwd, configDir)].filter((n) => /^[\w.:-]+$/.test(n)).sort(); // P3: fork skills run as subagents too
  return {
    permissions: {
      deny: [...editing.flatMap((n) => [`Agent(${n})`, `Task(${n})`]), 'Workflow', 'EnterWorktree', ...forks.map((n) => `Skill(${n})`)],
    },
  };
}

/** The system prompt line for a chat whose editing subagents are off (hooks off in the user's Claude Code settings). */
export const SUBAGENTS_OFF_PROMPT = 'In this chat, subagents that edit files are turned off, because hooks are off in the user\'s Claude ' +
  'Code settings and AIB could not give them their own worktree. Read-only subagents (Explore, Plan) still work; do edits yourself.';

/** The system prompt line for a Windows chat without Git Bash: its editing subagents are off (security review P1, MF 7). */
export const SUBAGENTS_OFF_NO_BASH_PROMPT = 'In this chat, subagents that edit files are turned off, because Git Bash is not installed and ' +
  "AIB's subagent rule needs it to give them their own worktree. Read-only subagents (Explore, Plan) still work; do edits yourself.";
