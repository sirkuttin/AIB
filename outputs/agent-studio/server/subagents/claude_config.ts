/**
 * Subagent worktrees, Claude Code (design v2 2.1, 2.2, 2.3.6, 2.6; P0b): what AIB reads of the user's Claude Code setup (read only,
 * never written) and the per-session settings it gives a chat.
 *
 *   readClaudeSetup(cwd, env)  the read-only agent types (built-ins + custom agents whose `tools` can't edit), whether any settings
 *                              tier or plugin defines its own WorktreeCreate hook, and whether hooks are off (disableAllHooks /
 *                              allowManagedHooksOnly). Sources: user (CLAUDE_CONFIG_DIR or ~/.claude), project (.claude/settings.json,
 *                              settings.local.json, agents/), installed plugins (agents/, hooks/hooks.json), managed settings.
 *   hookSettings(...)          the `_meta.claudeCode.options.settings` object: command hooks that run the keeper's forwarder
 *                              (`<keeper> hook <event> <address file>`). It holds no port and no key, so it is byte-identical on every
 *                              reopen (the adapter rebuilds the session when settings change).
 */
import { isDict } from '../core/py.ts';
import { join } from '../platform/path.ts';

type Json = Record<string, unknown>;

/** Built-in agent types that cannot edit the project (statusline-setup edits only the user's own Claude settings). */
export const BUILTIN_READ_ONLY = ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup'];
/** A custom agent whose `tools` list has none of these is read-only. */
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);

/** The PreToolUse matcher: the spawning tool (and its old name), plus the two AIB refuses (P0b R8). */
export const PRE_TOOL_MATCHER = 'Agent|Task|EnterWorktree|Workflow';
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

export function managedSettingsPath(): string {
  switch (Deno.build.os) {
    case 'windows':
      return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
    case 'darwin':
      return '/Library/Application Support/ClaudeCode/managed-settings.json';
    default:
      return '/etc/claude-code/managed-settings.json';
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
    // no `tools` (or "*"): every tool, so it can edit; else read-only only when none of the editing tools is listed
    const list = tools === null ? null : tools.replace(/[[\]"']/g, '').split(',').map((t) => t.trim().replace(/\(.*$/, '')).filter(Boolean);
    into.set(name, !!list && list.length > 0 && !list.includes('*') && !list.some((t) => EDITING_TOOLS.has(t)));
  }
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
    ['managed Claude Code settings', readJson(managedSettingsPath())],
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
