/**
 * Tool servers of WSL projects, Windows side: the distro's helper reads the agents' config files there (helper/toolservers.ts,
 * `toolservers.discover`, read only). A distro that is not running is not started for a Settings page; a helper that is away or
 * too old answers null (the page then shows what it could not read; a chat started meanwhile loads everything, as before).
 */
import type { FoundServer } from '../toolservers/discover.ts';
import { peekWslHost } from './access.ts';

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
