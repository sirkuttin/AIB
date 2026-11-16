/**
 * Allow rules: what Claude Code's own settings say that changes AIB's answer (read only; AIB never writes agent configs).
 *  - Ask rules (review 4.2): AIB doesn't copy Claude's matcher. If any Claude ask rule (user, project, local, managed) names a
 *    program, AIB never auto-answers that program; a bare "Bash" ask rule stops every shell auto-answer.
 *  - Risky env (review 2.7): an `env` block setting PATH, AIB_*, NODE_OPTIONS, GIT_*, BASH_ENV or ENV switches rules off for the
 *    chat (an agent could point PATH at its own `git`).
 * Files are re-read when their modification time changes. Codex and Gemini configs are not read yet.
 */
import { join } from 'node:path';

export interface AgentConfigFacts {
  /** Programs Claude ask rules name ('*' = every shell command). */
  askPrograms: Set<string>;
  /** Other tools Claude ask rules name: 'edit', 'fetch', 'mcp:*', 'mcp:<server>', 'mcp:<server>__<tool>' (review H11). */
  askTools: Set<string>;
  /** Why rules are off for this chat ('' = they aren't). */
  riskyEnv: string;
}

const RISKY =
  /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|AIB_.*|GIT_.*|CLAUDE_CODE_SHELL.*|npm_config_.*|YARN_.*|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PSModulePath|PERL5OPT|PERL5LIB|RUBYOPT|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|COMSPEC|SHELL|PROMPT_COMMAND|ZDOTDIR)$/i;

const cache = new Map<string, { mtime: number; json: Record<string, unknown> | null }>();

function readJson(path: string): Record<string, unknown> | null {
  let mtime = -1;
  try {
    mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
  } catch {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtime === mtime) return hit.json;
  let json: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(Deno.readTextFileSync(path));
    json = v && typeof v === 'object' ? v : null;
  } catch { /* unreadable: no facts from it */ }
  cache.set(path, { mtime, json });
  return json;
}

function claudeHome(): string {
  const dir = Deno.env.get('CLAUDE_CONFIG_DIR');
  if (dir) return dir;
  const home = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '';
  return home ? join(home, '.claude') : '';
}

function managedSettings(): string {
  if (Deno.build.os === 'windows') return join(Deno.env.get('ProgramData') ?? 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json');
  if (Deno.build.os === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/**
 * The facts for a Claude chat in `cwd`. `home`: Claude's config folder when the caller knows it (the WSL helper passes the agent's
 * CLAUDE_CONFIG_DIR or ~/.claude in the distro); else this process's.
 */
export function claudeFacts(cwd: string, home: string = claudeHome()): AgentConfigFacts {
  const files = [
    home ? join(home, 'settings.json') : '',
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    managedSettings(),
  ].filter(Boolean);
  const askPrograms = new Set<string>();
  const askTools = new Set<string>();
  let riskyEnv = '';
  for (const file of files) {
    const json = readJson(file);
    if (!json) continue;
    const env = json.env && typeof json.env === 'object' ? Object.keys(json.env as object) : [];
    const bad = env.find((k) => RISKY.test(k));
    if (bad && !riskyEnv) riskyEnv = `${file} sets ${bad}`;
    const perms = json.permissions && typeof json.permissions === 'object' ? json.permissions as Record<string, unknown> : {};
    const ask = Array.isArray(perms.ask) ? perms.ask : [];
    for (const rule of ask) {
      if (typeof rule !== 'string') continue;
      const text = rule.trim();
      if (/^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(text)) askTools.add('edit');
      if (/^WebFetch\b/.test(text)) askTools.add('fetch');
      const mcp = /^mcp__([^_(][^(]*?)(?:__([^(]+))?(?:\(.*\))?$/.exec(text);
      if (mcp) askTools.add(mcp[2] && mcp[2] !== '*' ? `mcp:${mcp[1]}__${mcp[2]}` : mcp[1] === '*' ? 'mcp:*' : `mcp:${mcp[1]}`);
      const m = /^(Bash|PowerShell)(?:\((.*)\))?$/.exec(text);
      if (!m) continue;
      const first = (m[2] ?? '').trim().split(/[\s:(]/)[0];
      askPrograms.add(first && first !== '*' ? first.toLowerCase() : '*');
    }
  }
  return { askPrograms, askTools, riskyEnv };
}
