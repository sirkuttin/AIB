/**
 * The MCP servers an agent would start for a folder, found by READING the agents' own config files (never writing them): Claude Code's
 * ~/.claude.json (user and per-project servers, claude.ai connectors it has connected) and <folder>/.mcp.json, Codex's config.toml,
 * Gemini's and Qwen's settings.json, Copilot's mcp-config.json, Antigravity's config/mcp_config.json. Pure over a `Files` reader, so the
 * WSL helper runs the same code natively in the distro (wsl/helper/toolservers.ts) and tests give it fake files.
 *
 * Probed with the real CLIs (aib-shared/designs/tool-servers/probe.md): with CLAUDE_CONFIG_DIR set the user's Claude servers are in
 * $CLAUDE_CONFIG_DIR/.claude.json, else in ~/.claude.json.
 */
import { isDict } from '../core/py.ts';

type Json = Record<string, unknown>;

export type AgentId = 'claude' | 'codex' | 'gemini' | 'qwen' | 'copilot' | 'antigravity';
export const AGENT_NAMES: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  copilot: 'GitHub Copilot',
  antigravity: 'Antigravity',
};

export interface Files {
  /** The file's text, or null when it is not there or cannot be read. */
  read(path: string): string | null;
}
export interface DiscoverEnv {
  /** The home folder whose agent folders are read (a WSL distro's home for a WSL project). */
  home: string;
  /** The project folder. */
  folder: string;
  env: Record<string, string | undefined>;
  /** Path separator joiner (Windows `\`, Linux `/`). */
  sep: '/' | '\\';
}

export interface FoundServer {
  id: string;
  kind: 'local' | 'remote';
  from: 'user' | 'project' | 'connector';
  /** Where the entry was read: "Your user settings", "This project · .mcp.json", "claude.ai connector". */
  fromText: string;
  /** The agents whose own config names this server. */
  agents: AgentId[];
  /** The raw entry per agent (Qwen and agy need a full copy of it when a tool is off). */
  entries: Partial<Record<AgentId, Json>>;
}

const join = (e: DiscoverEnv, ...parts: string[]) => parts.filter(Boolean).map((p, i) => (i ? p : p.replace(/[\\/]+$/, ''))).join(e.sep);

function readJson(files: Files, path: string): Json | null {
  const text = files.read(path);
  if (text === null) return null;
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    return isDict(v) ? v as Json : null;
  } catch {
    return null;
  }
}

/** Runs on this PC (a command it starts) or is a remote address. */
export function kindOf(entry: Json): 'local' | 'remote' {
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
  if (type === 'http' || type === 'sse' || type === 'streamable-http' || type === 'remote') return 'remote';
  if (typeof entry.url === 'string' || typeof entry.httpUrl === 'string' || typeof entry.serverUrl === 'string') return 'remote';
  return 'local';
}

/** The `[mcp_servers.NAME]` tables of a Codex config.toml as entries (command, args, url: enough to tell local from remote). Unquoted or quoted names. */
export function codexServers(text: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  let current: Json | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const table = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(\.[^\]]*)?\]\s*$/.exec(line);
    if (table) {
      // a sub-table (.env, .http_headers) of a server carries nothing this reads
      current = table[4] ? null : (out[table[1] ?? table[2] ?? table[3]] = {});
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const kv = /^(command|url|bearer_token_env_var|enabled)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/\s+#.*$/, '').trim();
    if (kv[1] === 'enabled') current.enabled = value === 'true';
    else current[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

function add(into: Map<string, FoundServer>, agent: AgentId, id: string, entry: Json, from: FoundServer['from'], fromText: string): void {
  if (!id || id === 'studio_artifact' || id === 'studio-artifact') return; // AIB's own: always on, locked, never listed as a choice
  const kind = kindOf(entry);
  const found = into.get(id);
  if (found) {
    if (!found.agents.includes(agent)) found.agents.push(agent);
    found.entries[agent] = entry;
    // a project entry of the same name wins the "where from" line (it is the one a chat in this folder reads first)
    if (from === 'project' && found.from === 'user') {
      found.from = from;
      found.fromText = fromText;
    }
    return;
  }
  into.set(id, { id, kind, from, fromText, agents: [agent], entries: { [agent]: entry } });
}

function servers(into: Map<string, FoundServer>, agent: AgentId, table: unknown, from: FoundServer['from'], fromText: string): void {
  if (!isDict(table)) return;
  for (const [id, entry] of Object.entries(table)) {
    if (isDict(entry) && entry.disabled !== true && entry.enabled !== false) add(into, agent, id, entry as Json, from, fromText);
  }
}

const USER = 'Your user settings';

/** Every server the agents' own config files name for this folder. Never throws. */
export function discoverServers(files: Files, e: DiscoverEnv): FoundServer[] {
  const into = new Map<string, FoundServer>();
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch { /* one unreadable file never hides the others */ }
  };
  // Claude Code
  safe(() => {
    const dir = e.env.CLAUDE_CONFIG_DIR;
    const file = dir ? join(e, dir, '.claude.json') : join(e, e.home, '.claude.json');
    const cfg = readJson(files, file);
    if (cfg) {
      servers(into, 'claude', cfg.mcpServers, 'user', USER);
      const projects = isDict(cfg.projects) ? cfg.projects as Json : {};
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      for (const [path, value] of Object.entries(projects)) {
        if (norm(path) === norm(e.folder) && isDict(value)) {
          servers(into, 'claude', (value as Json).mcpServers, 'project', 'This project · your Claude settings');
        }
      }
      // claude.ai connectors Claude Code has connected for this account: remote, loaded in every session unless denied
      if (Array.isArray(cfg.claudeAiMcpEverConnected)) {
        for (const name of cfg.claudeAiMcpEverConnected) {
          if (typeof name === 'string' && name) add(into, 'claude', name, { type: 'http' }, 'connector', 'claude.ai connector');
        }
      }
    }
    const project = readJson(files, join(e, e.folder, '.mcp.json'));
    if (project) servers(into, 'claude', project.mcpServers, 'project', 'This project · .mcp.json');
  });
  // Codex
  safe(() => {
    const dir = e.env.CODEX_HOME || join(e, e.home, '.codex');
    for (
      const [path, from, text] of [[join(e, dir, 'config.toml'), 'user', USER], [
        join(e, e.folder, '.codex', 'config.toml'),
        'project',
        'This project · .codex/config.toml',
      ]] as const
    ) {
      const toml = files.read(path);
      if (toml === null) continue;
      for (const [id, entry] of Object.entries(codexServers(toml))) if (entry.enabled !== false) add(into, 'codex', id, entry, from, text);
    }
  });
  // Gemini CLI, Qwen Code: settings.json with mcpServers, user and project
  for (
    const [agent, userDir, projectDir] of [
      ['gemini', e.env.GEMINI_CLI_HOME ? join(e, e.env.GEMINI_CLI_HOME, '.gemini') : join(e, e.home, '.gemini'), '.gemini'],
      ['qwen', e.env.QWEN_HOME || join(e, e.home, '.qwen'), '.qwen'],
    ] as const
  ) {
    safe(() => {
      servers(into, agent, readJson(files, join(e, userDir, 'settings.json'))?.mcpServers, 'user', USER);
      servers(
        into,
        agent,
        readJson(files, join(e, e.folder, projectDir, 'settings.json'))?.mcpServers,
        'project',
        `This project · ${projectDir}/settings.json`,
      );
    });
  }
  // GitHub Copilot CLI
  safe(() => {
    const dir = e.env.COPILOT_HOME || join(e, e.home, '.copilot');
    servers(into, 'copilot', readJson(files, join(e, dir, 'mcp-config.json'))?.mcpServers, 'user', USER);
    servers(
      into,
      'copilot',
      readJson(files, join(e, e.folder, '.vscode', 'mcp.json'))?.servers,
      'project',
      'This project · .vscode/mcp.json',
    );
  });
  // Antigravity
  safe(() => {
    servers(into, 'antigravity', readJson(files, join(e, e.home, '.gemini', 'config', 'mcp_config.json'))?.mcpServers, 'user', USER);
  });
  return [...into.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Files on this machine (Windows or Linux), read-only. */
export const diskFiles: Files = {
  read(path: string): string | null {
    try {
      const info = Deno.statSync(path);
      if (!info.isFile || info.size > 4_000_000) return null;
      return Deno.readTextFileSync(path);
    } catch {
      return null;
    }
  },
};

export function hostEnv(folder: string, env: Record<string, string | undefined> = Deno.env.toObject()): DiscoverEnv {
  const win = Deno.build.os === 'windows';
  const home = (win ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) ?? '';
  return { home, folder, env, sep: win ? '\\' : '/' };
}
