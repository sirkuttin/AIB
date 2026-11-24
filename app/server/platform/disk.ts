/**
 * Free disk space (shutil.disk_usage(path).free) for the agent installer's preflight. Windows: GetDiskFreeSpaceExW (the bytes
 * available to this user). macOS / Linux: `df -Pk`. Throws an Error when it cannot tell (the installer then skips the check).
 */
import { wide } from './win32.ts';

let lib: Deno.DynamicLibrary<{ GetDiskFreeSpaceExW: { parameters: ['buffer', 'buffer', 'buffer', 'buffer']; result: 'i32' } }> | null =
  null;

function windowsFree(path: string): number {
  lib ??= Deno.dlopen('kernel32.dll', { GetDiskFreeSpaceExW: { parameters: ['buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' } });
  const available = new BigUint64Array(1);
  const total = new BigUint64Array(1);
  const free = new BigUint64Array(1);
  const ok = lib.symbols.GetDiskFreeSpaceExW(
    wide(path),
    new Uint8Array(available.buffer),
    new Uint8Array(total.buffer),
    new Uint8Array(free.buffer),
  );
  if (!ok) throw new Error(`Could not read the free space of ${path}`);
  return Number(available[0]);
}

function posixFree(path: string): number {
  const done = new Deno.Command('df', { args: ['-Pk', path], stdin: 'null', stdout: 'piped', stderr: 'null' }).outputSync();
  const lines = new TextDecoder().decode(done.stdout).trim().split('\n');
  const fields = (lines[lines.length - 1] ?? '').trim().split(/\s+/);
  const kib = Number(fields[3]);
  if (!done.success || !Number.isFinite(kib)) throw new Error(`Could not read the free space of ${path}`);
  return kib * 1024;
}

/** Bytes free for this user on the drive that holds `path` (an existing folder). */
export function diskFree(path: string): number {
  return Deno.build.os === 'windows' ? windowsFree(path) : posixFree(path);
}
