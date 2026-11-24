/**
 * How a Codex chat gets its MCP servers (0.15 slice 4).
 *
 * Codex hides MCP tools behind its exec/ALL_TOOLS code mode unless a server says `omit_tools_from: ["deferred", "code_mode"]`, a
 * per-server setting codex-acp cannot carry in session/new (it copies only command/args/env/url/headers). So a Codex-family chat
 * gets ALL its servers in CODEX_CONFIG (`mcp_servers`, the thread config) and an empty `mcpServers` in session/new: a non-empty ACP
 * list replaces CODEX_CONFIG's `mcp_servers`, which would drop AIB's entry (architect review, must-fix 3). The servers stay in
 * Connection.mcpServers as the record, so the prompt, the auto-approval of AIB's own tool and a keeper take-over still know them.
 * Never `required`: with AIB closed the forwarder fails `initialize`, and a required server would fail a working chat.
 */
import type { McpServer } from './breadth.ts';

type Json = Record<string, unknown>;

/** Only AIB's own entry: its six tools go straight into the model request, not behind code mode. */
export const OWN_OMIT_TOOLS_FROM = ['deferred', 'code_mode'];
/** Codex waits this long for AIB's forwarder to answer `initialize` (its default is 10 s; the forwarder retries 15 s itself). */
export const OWN_STARTUP_TIMEOUT_SEC = 30;

const record = (items: { name: string; value: string }[]): Record<string, string> => Object.fromEntries(items.map((i) => [i.name, i.value]));

/** The servers Codex can run (stdio and http; the first of each name, as selectMcpServers does), by name. */
export function codexUsable(servers: McpServer[]): McpServer[] {
  const given = new Set<string>();
  const out: McpServer[] = [];
  for (const server of servers) {
    const type = 'type' in server ? server.type : 'stdio';
    if ((type !== 'stdio' && type !== 'http') || given.has(server.name)) continue;
    given.add(server.name);
    out.push(server);
  }
  return out;
}

/** One server as a Codex `mcp_servers` entry (codex-acp's own conversion, plus AIB's options for its own entry). */
export function codexServerEntry(server: McpServer, own: boolean): Json {
  const entry: Json = 'type' in server
    ? { url: server.url, http_headers: record(server.headers) }
    : { command: server.command, args: server.args, env: record(server.env) };
  if (own) Object.assign(entry, { omit_tools_from: OWN_OMIT_TOOLS_FROM, startup_timeout_sec: OWN_STARTUP_TIMEOUT_SEC });
  return entry;
}

/**
 * The chat's CODEX_CONFIG text with `servers` merged into its `mcp_servers` (the user's own entries of that table stay; an entry of
 * the same name is AIB's or the --mcp-config one, and wins). Null: nothing to put there, or the text is not a JSON object
 * (codex-acp refuses it itself: the chat then keeps the ACP route).
 */
export function withCodexMcp(current: string | undefined, servers: McpServer[], isOwn: (server: McpServer) => boolean): string | null {
  const usable = codexUsable(servers);
  if (!usable.length) return null;
  let config: Json = {};
  if (current && current.trim()) {
    try {
      const parsed = JSON.parse(current);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      config = parsed as Json;
    } catch {
      return null;
    }
  }
  const existing = config.mcp_servers && typeof config.mcp_servers === 'object' && !Array.isArray(config.mcp_servers) ? config.mcp_servers as Json : {};
  const ours = Object.fromEntries(usable.map((server) => [server.name, codexServerEntry(server, isOwn(server))]));
  return JSON.stringify({ ...config, mcp_servers: { ...existing, ...ours } });
}
