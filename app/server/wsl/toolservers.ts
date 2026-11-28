/**
 * Tool servers of WSL projects, Windows side: the distro's helper reads the agents' config files there (helper/toolservers.ts,
 * `toolservers.discover`, read only). A distro that is not running is not started for a Settings page; a helper that is away or
 * too old answers null (the page then shows what it could not read; a chat started meanwhile loads everything, as before).
 * `toolservers.write` makes the per-chat files Gemini and Qwen need, in AIB's own data folder in the distro.
 */
import type { FoundServer } from '../toolservers/discover.ts';
import { peekWslHost, wslHost } from './access.ts';
import type { HelperMethods } from './contract.ts';

export async function wslDiscoverServers(distro: string, linuxPath: string): Promise<FoundServer[] | null> {
  const host = peekWslHost(distro);
  if (!host || host.state !== 'ready') return null;
  try {
    const answer = await host.call('toolservers.discover', { folder: linuxPath }, { timeoutMs: 8000 });
    return Array.isArray(answer.servers) ? answer.servers as unknown as FoundServer[] : null;
  } catch {
    return null;
  }
}

/**
 * Can this distro's helper write the Gemini and Qwen files? An older helper lists no `toolservers.write`; a host that lists no methods
 * (the tests' fake) can. Never starts a host (a Settings page must not).
 */
export function wslCanWriteToolServers(distro: string): boolean {
  const host = peekWslHost(distro);
  if (!host || host.state !== 'ready') return false;
  const methods = (host as { methods?: string[] }).methods;
  return !Array.isArray(methods) || methods.includes('toolservers.write');
}

/** The path the helper wrote in the distro (a Linux path), or null when it could not or is too old. Never throws. */
export async function wslWriteToolServers(
  distro: string,
  params: HelperMethods['toolservers.write']['params'],
): Promise<string | null> {
  const host = wslHost(distro);
  if (!host || host.state !== 'ready') return null;
  const methods = (host as { methods?: string[] }).methods;
  if (Array.isArray(methods) && !methods.includes('toolservers.write')) return null;
  try {
    const answer = await host.call('toolservers.write', params, { timeoutMs: 15_000 });
    return typeof answer.path === 'string' && answer.path ? answer.path : null;
  } catch {
    return null;
  }
}
