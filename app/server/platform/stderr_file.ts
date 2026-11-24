/**
 * Windows: this process's stderr into a file (core/crash_trail.ts: the desktop app has no console, so what the runtime prints there
 * itself, Deno's "error: Uncaught" text or a Rust panic, was lost). The file is opened for appending with every share mode (it can be
 * renamed while open: rotation), not inheritable. Rust's std reads the stderr handle on every write, so this takes effect at once.
 */
import { kernel32, wide } from './win32.ts';

const STD_ERROR_HANDLE = 0xFFFFFFF4; // (DWORD)-12
const FILE_APPEND_DATA = 0x4;
const FILE_SHARE_ALL = 0x1 | 0x2 | 0x4;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE = 0xFFFFFFFFFFFFFFFFn;

/** stderr → `path` (appended). Returns the new handle, or null (not Windows, or it failed: stderr is unchanged). Never throws. */
export function stderrToFile(path: string): Deno.PointerObject | null {
  if (Deno.build.os !== 'windows') return null;
  try {
    const k = kernel32();
    const handle = k.CreateFileW(wide(path), FILE_APPEND_DATA, FILE_SHARE_ALL, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
    const value = handle === null ? 0n : BigInt(Deno.UnsafePointer.value(handle));
    if (handle === null || value === 0n || value === INVALID_HANDLE) return null;
    if (!k.SetStdHandle(STD_ERROR_HANDLE, handle)) {
      k.CloseHandle(handle);
      return null;
    }
    return handle;
  } catch {
    return null;
  }
}

/** Closes a handle stderrToFile returned (after another one replaced it). Never throws. */
export function closeStderrFile(handle: Deno.PointerObject): void {
  try {
    kernel32().CloseHandle(handle);
  } catch { /* gone */ }
}
