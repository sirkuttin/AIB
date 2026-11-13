/**
 * The phone port: the loopback port Tailscale Serve sends phone traffic to. Chosen once (the first free port from 8779, past the
 * desktop app's page and artifact pair) and saved in <state>/remote-port.json, because the owner's `tailscale serve` command names
 * it. Phase D: the phone's artifact port (Serve's https 8443 goes there; remote/artifact_server.ts) is chosen the same way, the
 * next free one, and saved in the same file as `artifactPort`. It never changes by itself: when it is busy AIB keeps trying for about 20 seconds, then reports it (Devices shows "port N is
 * busy") instead of quietly taking another one. `AIB serve` and the desktop app read the same file.
 */
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';

export const REMOTE_PORT_FILE = 'remote-port.json';
export const FIRST_REMOTE_PORT = 8779;
const SCAN = 200;
export const BIND_RETRY_MS = 20_000;

export class PortBusy extends Error {
  override name = 'PortBusy';
  constructor(readonly port: number) {
    super(`Port ${port} is busy`);
  }
}

const portOf = (value: unknown): number | null => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
};

function readPorts(stateDir: string): { port: number | null; artifactPort: number | null } {
  const [status, data] = readJsonFile(inDir(stateDir, REMOTE_PORT_FILE));
  if (status !== 'ok' || !data || typeof data !== 'object') return { port: null, artifactPort: null };
  const d = data as { port?: unknown; artifactPort?: unknown };
  return { port: portOf(d.port), artifactPort: portOf(d.artifactPort) };
}

export function readRemotePort(stateDir: string): number | null {
  return readPorts(stateDir).port;
}

/** The saved artifact port (Serve's https 8443 goes there), or null. */
export function readRemoteArtifactPort(stateDir: string): number | null {
  return readPorts(stateDir).artifactPort;
}

/** Save the phone port (and the artifact port; left out = the one saved now is kept). */
export function saveRemotePort(stateDir: string, port: number, artifactPort?: number | null): void {
  const keep = artifactPort === undefined ? readPorts(stateDir).artifactPort : artifactPort;
  saveJson(inDir(stateDir, REMOTE_PORT_FILE), { version: 1, port, ...(keep ? { artifactPort: keep } : {}) }, 'remote-port-');
}

/** The saved phone port, or (first time only) the first free one from 8779, saved. `avoid`: ports AIB uses itself. */
export function remotePort(stateDir: string, isFree: (port: number) => boolean, avoid: number[] = []): number {
  const saved = readRemotePort(stateDir);
  if (saved !== null) return saved;
  for (let port = FIRST_REMOTE_PORT; port < FIRST_REMOTE_PORT + SCAN; port++) {
    if (avoid.includes(port) || !isFree(port)) continue;
    saveRemotePort(stateDir, port);
    return port;
  }
  throw new PortBusy(FIRST_REMOTE_PORT);
}

/** The saved artifact port, or (first time only) the first free one from 8779 that is not the phone port, saved next to it. */
export function remoteArtifactPort(stateDir: string, phonePort: number, isFree: (port: number) => boolean, avoid: number[] = []): number {
  const saved = readRemoteArtifactPort(stateDir);
  if (saved !== null) return saved;
  for (let port = FIRST_REMOTE_PORT; port < FIRST_REMOTE_PORT + SCAN; port++) {
    if (port === phonePort || avoid.includes(port) || !isFree(port)) continue;
    saveRemotePort(stateDir, phonePort, port);
    return port;
  }
  throw new PortBusy(FIRST_REMOTE_PORT);
}

export function portFree(port: number): boolean {
  try {
    Deno.listen({ hostname: '127.0.0.1', port }).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Bind with `bind(port)` (which throws AddrInUse while the port is taken), trying again every half second for `retryMs`. Throws
 * PortBusy after that: the port is never swapped for another.
 */
export async function bindWithRetry<T>(port: number, bind: (port: number) => T, retryMs = BIND_RETRY_MS, stop?: () => boolean): Promise<T> {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      return bind(port);
    } catch (error) {
      if (!(error instanceof Deno.errors.AddrInUse) && !/address already in use|10048|EADDRINUSE/i.test(String(error))) throw error;
      if (Date.now() >= deadline || stop?.()) throw new PortBusy(port);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
