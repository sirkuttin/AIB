/**
 * How a GitHub Copilot CLI chat gets AIB's tools (aib-shared/research/provider-builder-probe-2026-11-25.md, Copilot section, item 5;
 * Copilot CLI 1.0.109). Copilot ignores the `mcpServers` of ACP session/new, but `--additional-mcp-config @<file>` in `--acp` mode
 * adds MCP servers for that run only. So each Copilot chat gets a config file of AIB's own, <state>/copilot/<chat>/mcp.json, naming
 * the same servers the other agents are given, and Copilot starts with `--additional-mcp-config @<file>`. Nothing is written to
 * ~/.copilot, `~/.copilot/mcp-config.json` or the project.
 *
 * File shape (what Copilot reads): {"mcpServers": {"<name>": {"type": "stdio", "command", "args", "env": {..}, "tools": ["*"]}}};
 * an http server is {"type": "http", "url", "headers": {..}, "tools": ["*"]}. Copilot names each tool `<server>-<tool>`
 * (studio_artifact-doc, studio_artifact-publish, ...).
 */
import { isDict } from '../core/py.ts';
import { dirname } from '../platform/path.ts';
import { pathOf } from '../state/paths.ts';
import { codexUsable } from '../acp/codex_mcp.ts';
import type { McpServer } from '../acp/breadth.ts';

type Json = Record<string, unknown>;

export const COPILOT_MCP_FLAG = '--additional-mcp-config';

const record = (items: { name: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(items.map((i) => [i.name, i.value]));

/** One server as a Copilot config entry. */
export function copilotServerEntry(server: McpServer): Json {
  return 'type' in server
    ? { type: 'http', url: server.url, headers: record(server.headers), tools: ['*'] }
    : { type: 'stdio', command: server.command, args: server.args, env: record(server.env), tools: ['*'] };
}

/** The config text for these servers (stdio and http only; the first of each name, as the other agents get them), or null for none. */
export function copilotMcpConfig(servers: McpServer[]): string | null {
  const usable = codexUsable(servers);
  if (!usable.length) return null;
  return JSON.stringify({ mcpServers: Object.fromEntries(usable.map((s) => [s.name, copilotServerEntry(s)])) }, null, 2) + '\n';
}

/** The name Copilot gives a server's tool. */
export const copilotToolName = (server: string, tool: string): string => `${server}-${tool}`;

/** The server and tool of a Copilot tool name (`studio_artifact-doc` -> studio_artifact, doc), or null. Server names hold no hyphen when AIB's own. */
export function splitCopilotToolName(name: string): { server: string; tool: string } | null {
  const m = /^(studio[_-]artifact)-([a-z_]+)$/.exec(name);
  return m ? { server: 'studio_artifact', tool: m[2] } : null;
}

/**
 * The launch command with the config file named, or null when the command has no `--acp` to place it after (the chat then has no
 * AIB tools, and says so). Already named: unchanged. Someone else's `--additional-mcp-config` is kept and AIB's goes beside it
 * (Copilot takes the flag more than once). Never changes the input.
 */
export function copilotMcpCommand(command: readonly string[], file: string): string[] | null {
  const arg = `@${file}`;
  if (command.some((a, i) => a === arg && command[i - 1] === COPILOT_MCP_FLAG)) return [...command];
  const at = command.indexOf('--acp', 1);
  if (at < 1) return null;
  return [...command.slice(0, at + 1), COPILOT_MCP_FLAG, arg, ...command.slice(at + 1)];
}

/** Where a chat's config file goes: <state>/copilot/<chat>/mcp.json (AIB's own folder). */
export function configFileOf(stateDir: string, chatId: string): string {
  return pathOf(stateDir, 'copilot', chatId, 'mcp.json');
}

/** Writes the chat's config file (the same bytes on every reopen) and returns its path. */
export function writeConfigFile(file: string, text: string): string {
  Deno.mkdirSync(dirname(file), { recursive: true });
  Deno.writeTextFileSync(file, text);
  return file;
}

/** The chat is gone: its config folder goes. Never throws. */
export function removeConfig(stateDir: string, chatId: string): void {
  try {
    Deno.removeSync(pathOf(stateDir, 'copilot', chatId), { recursive: true });
  } catch { /* gone */ }
}

/**
 * At start (and after the keeper's running chats are known): the config folders of chats that are not open here and not running in the
 * keeper, and older than `minAgeS`, go. A chat's file is NOT removed when AIB lets go of it: a keeper-held chat that restarts its agent
 * reads the same file again. Never throws.
 */
export function sweepConfigs(stateDir: string, keep: Set<string>, minAgeS = 3600): number {
  let removed = 0;
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(pathOf(stateDir, 'copilot'))];
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory || !/^[0-9a-f]{32}$/.test(e.name) || keep.has(e.name)) continue;
    const dir = pathOf(stateDir, 'copilot', e.name);
    try {
      const st = Deno.lstatSync(dir);
      if (st.isSymlink || (st.mtime && Date.now() - st.mtime.getTime() < minAgeS * 1000)) continue;
      Deno.removeSync(dir, { recursive: true });
      removed++;
    } catch { /* in use, or gone */ }
  }
  return removed;
}

/** The text of a config file that holds AIB's servers (tests and the take-over check). */
export function serversOf(text: string): Json {
  try {
    const parsed = JSON.parse(text);
    return isDict(parsed) && isDict((parsed as Json).mcpServers) ? (parsed as Json).mcpServers as Json : {};
  } catch {
    return {};
  }
}
