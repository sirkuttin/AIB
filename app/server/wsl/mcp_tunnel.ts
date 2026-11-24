/**
 * AIB's end of the WSL MCP tunnel (docs/wsl/design.md sections 4, 6, 11). An agent in a WSL distro cannot reach AIB's HTTP tool
 * endpoint on Windows 127.0.0.1, so its `studio_artifact` entry is `AIB-keeper mcp-forward --helper-socket <socket>` (Linux), which
 * hands each message to the distro's helper (helper/mcp_tunnel.ts), which sends it here over the helper channel (`mcp.request`).
 *
 * Here: take it with `mcp.accept` (the helper says no when it already told the forwarder AIB was away: then it never runs), hand it
 * to AIB's server (Aib.wslToolCall: the conversation must be a live chat in that same distro, then the HTTP endpoint's own
 * key check and reply: artifacts/mcp_http.ts tunneled), and answer with `mcp.reply`. The page token never enters Linux, and no port
 * is opened: the key travels in the request, as it does in the HTTP header.
 */
import { getLogger } from '../core/log.ts';
import { CONVERSATION_HEADER, KEY_HEADER } from '../artifacts/mcp_http.ts';
import type { HelperMcpRequest, WslHost } from './contract.ts';

const log = getLogger('wsl');

/** What AIB does with one tunneled message: an HTTP-like status and body. */
export type TunnelServe = (
  request: { distro: string; key: string; conversation: string; body: string; headers: Record<string, string> },
) => Promise<TunnelAnswer>;
/** status as HTTP; `error` with 503: AIB cannot take it (the forwarder says so at once, as a tool result for a tools/call). */
export type TunnelAnswer = { status: number; body: string; error?: string };

/** The largest answer sent back (the helper takes lines up to 4 MB from AIB; JSON escaping can grow a body). */
export const MAX_REPLY = 3 * 1024 * 1024;
export const ACCEPT_TIMEOUT_MS = 10_000;
export const REPLY_TIMEOUT_MS = 30_000;

/** A header of the forwarder's headers object, by name, ignoring case (HTTP header names are case-insensitive). */
export function headerOf(headers: Record<string, unknown>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want && typeof v === 'string') return v;
  return '';
}

type TunnelHost = Pick<WslHost, 'distro' | 'call'>;

export class McpTunnelGate {
  #serve: TunnelServe | null = null;

  /** AIB that answers tool calls from the distros (the last one set; the returned function unsets it if still its own). */
  set(serve: TunnelServe): () => void {
    this.#serve = serve;
    return () => {
      if (this.#serve === serve) this.#serve = null;
    };
  }

  /** Follow a host's tunneled tool calls (hosts without a tunnel never send any). */
  watch(host: WslHost): () => void {
    return host.onMcpRequest?.((request) => void this.handle(host, request)) ?? (() => {});
  }

  /** One tunneled message, start to end. Never throws. */
  async handle(host: TunnelHost, request: HelperMcpRequest['params']): Promise<void> {
    const rid = request.rid;
    if (typeof rid !== 'string' || !rid || rid.length > 64) return;
    const serve = this.#serve;
    if (!serve) {
      // nothing here runs tools (AIB starting, or tools off): no accept, so the forwarder hears "AIB is not running" at once
      await host.call('mcp.reply', { rid, status: 503, error: 'AIB is not ready to answer tools yet. Try again in a moment.' }, { timeoutMs: REPLY_TIMEOUT_MS }).catch(() => {});
      return;
    }
    try {
      const taken = await host.call('mcp.accept', { rid }, { timeoutMs: ACCEPT_TIMEOUT_MS });
      if (!taken?.ok) return; // the helper gave up on it already: it must not run now
    } catch (error) {
      log.warning('wsl: could not take a tool call from %s: %s', host.distro, error instanceof Error ? error.message : error);
      return;
    }
    let answer: TunnelAnswer;
    try {
      answer = await serve({
        distro: host.distro,
        key: headerOf(request.headers ?? {}, KEY_HEADER),
        conversation: headerOf(request.headers ?? {}, CONVERSATION_HEADER),
        body: String(request.body ?? ''),
        headers: Object.fromEntries(Object.entries(request.headers ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
      });
    } catch (error) {
      log.exception(error, 'A tool call from WSL failed');
      answer = { status: 500, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }) };
    }
    if (answer.body.length > MAX_REPLY) {
      const id = idOf(request.body);
      answer = {
        status: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: `The answer (${Math.round(answer.body.length / 1048576)} MB) is larger than the WSL tunnel carries (${MAX_REPLY >> 20} MB)` },
        }),
      };
    }
    try {
      const reply = { rid, status: answer.status, ...(answer.body ? { body: answer.body } : {}), ...(answer.error ? { error: answer.error } : {}) };
      await host.call('mcp.reply', reply, { timeoutMs: REPLY_TIMEOUT_MS });
    } catch (error) {
      log.warning('wsl: could not answer a tool call in %s: %s', host.distro, error instanceof Error ? error.message : error);
    }
  }
}

function idOf(body: string): unknown {
  try {
    const id = JSON.parse(body)?.id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** This AIB's gate: AIB sets its server, wsl/access.ts watches every host it hands out. */
export const mcpTunnelGate = new McpTunnelGate();
