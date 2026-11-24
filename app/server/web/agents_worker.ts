/// <reference lib="deno.worker" />
/**
 * The agent-list Worker: builds Settings' agent list (shared.ts describeAgents) off the web server's event loop. That build looks
 * for every agent's program in every PATH folder (with every PATHEXT) and reads prerequisites' versions, mostly with synchronous
 * file checks: 0.4-2 s on a PC with a long PATH, during which the server answered nothing (every page and the phone froze).
 *
 * shared.ts agentListOffThread posts {id, options, launchers, snapshot, connections, recheck} and gets {id, ok: true, rows} or
 * {id, ok: false, error} back. Reads only (the same files and PATH as describeAgents in the server); writes nothing.
 */
import { type AgentOptions, describeAgents, type SettingsLike } from './shared.ts';

export interface AgentListRequest {
  id: number;
  options: AgentOptions;
  /** settings.launcher(id) of the built-ins, read in the server (the Worker has no settings store) */
  launchers: Record<string, string>;
  snapshot: ReturnType<SettingsLike['snapshot']>;
  connections: unknown[];
  recheck: boolean;
}

self.onmessage = async (e: MessageEvent<AgentListRequest>) => {
  const m = e.data;
  try {
    const settings = { launcher: (id: string) => m.launchers[id] ?? '', snapshot: () => m.snapshot };
    const rows = await describeAgents(m.options, settings, m.connections, m.recheck);
    self.postMessage({ id: m.id, ok: true, rows });
  } catch (error) {
    self.postMessage({ id: m.id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
