/**
 * Sync between PCs for WSL projects, Windows side (design: aib-shared/designs/sync/design.md; slice V7). The sync engine (pcsync/files.ts)
 * stays in AIB on Windows and decides what to copy; every read, write, delete and listing of the project's aib-shared/ or aib-docs/
 * in the distro is one op of a batch sent to the distro's helper (`pcsync.fs`, wsl/helper/pcsync.ts), which runs the same DiskOps
 * (pcsync/diskops.ts) a Windows project runs on its own disk. The docs' doc.aibdoc goes in through the docs store's own WSL path
 * (wsl/docs.ts), not through here.
 *
 * A distro that is not running is never started for sync: the disk answers "not available" (the engine shows "Waiting: <distro>
 * is not running." and looks again later) and nothing is called. A distro that is only starting is not waited for either.
 */
import { DiskDown, SyncDisk } from '../pcsync/disk.ts';
import { fromB64, type Json, toB64 } from '../pcsync/diskops.ts';
import type { Area } from '../pcsync/frames.ts';
import { distroName, notReady, peekState, peekWslHost, wslLoc } from './access.ts';

const CALL_MS = 120_000;

/** '' when the distro's helper is ready for work now, else the line the owner sees. Never starts anything. */
export function distroWaiting(distro: string): string {
  const host = peekWslHost(distro);
  if (host && !notReady(host, distro) && peekState(host) === 'ready') return '';
  return `Waiting: ${distroName(distro)} is not running.`;
}

/** The disk of a WSL project (`ref` is its `wsl://<distro>/…` ref); null for a Windows project. */
export function wslDisk(ref: string, area: Area, sync: string): SyncDisk | null {
  const loc = wslLoc(ref);
  if (!loc) return null;
  const { distro, linuxPath } = loc;
  const exec = async (ops: Json[]): Promise<Json[]> => {
    const host = peekWslHost(distro);
    if (!host) throw new DiskDown(distroWaiting(distro));
    const wire = ops.map((op) => {
      if (!(op.bytes instanceof Uint8Array)) return op;
      const { bytes, ...rest } = op;
      return { ...rest, bytesB64: toB64(bytes) };
    });
    let results: Json[];
    try {
      results = (await host.call('pcsync.fs', { project: linuxPath, area, sync, ops: wire }, { timeoutMs: CALL_MS })).results;
    } catch (error) {
      const why = distroWaiting(distro);
      const code = (error as { code?: string }).code;
      if (!why && (code === 'unknown_method' || code === 'no_method')) {
        throw new DiskDown(`Waiting: the AIB helper in ${distroName(distro)} is older than this AIB and cannot sync yet. Reconnect it in Settings.`);
      }
      throw new DiskDown(why || `Waiting: ${distroName(distro)} could not be reached (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!Array.isArray(results)) throw new DiskDown(`Waiting: ${distroName(distro)} gave no answer.`);
    return results.map((r) => {
      if (typeof r.bytesB64 !== 'string') return r;
      const { bytesB64, ...rest } = r;
      return { ...rest, bytes: fromB64(bytesB64) };
    });
  };
  return new SyncDisk(exec, { watchRoot: null, available: () => distroWaiting(distro) });
}
