/**
 * Read-only facts about other processes (the Windows half of ownership_probe.py's low-level helpers): the process list, a process's
 * command line and folder from its PEB, start time, liveness, and who holds a file open (Restart Manager). Windows only; callers
 * check Deno.build.os first (the POSIX probe uses ps and /proc, ported with ownership_probe in stage C).
 */
import {
  ERROR_INVALID_PARAMETER,
  fromWide,
  kernel32,
  ntdll,
  PROCESS_QUERY_INFORMATION,
  PROCESS_QUERY_LIMITED_INFORMATION,
  PROCESS_VM_READ,
  rstrtmgr,
  STILL_ACTIVE,
  wide,
} from './win32.ts';

export interface ProcessEntry {
  pid: number;
  parentPid: number;
  exe: string;
}

const PROCESSENTRY32W_SIZE = 568;

/** Every process (pid, parent pid, exe name) from a Toolhelp snapshot. Throws if the snapshot fails. */
export function processList(): ProcessEntry[] {
  const k = kernel32();
  const snapshot = k.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
  if (snapshot === null || Deno.UnsafePointer.value(snapshot) === 0xffffffffffffffffn) throw new Error('Process list unavailable');
  const entry = new Uint8Array(PROCESSENTRY32W_SIZE);
  const view = new DataView(entry.buffer);
  view.setUint32(0, PROCESSENTRY32W_SIZE, true);
  const out: ProcessEntry[] = [];
  try {
    let ok = k.Process32FirstW(snapshot, entry);
    while (ok) {
      out.push({ pid: view.getUint32(8, true), parentPid: view.getUint32(32, true), exe: fromWide(entry.subarray(44)) });
      ok = k.Process32NextW(snapshot, entry);
    }
  } finally {
    k.CloseHandle(snapshot);
  }
  return out;
}

function readMemory(handle: Deno.PointerValue, address: bigint, size: number): Uint8Array | null {
  const buffer = new Uint8Array(size);
  const got = new BigUint64Array(1);
  if (!kernel32().ReadProcessMemory(handle, address, buffer, BigInt(size), got)) return null;
  return buffer.subarray(0, Number(got[0]));
}

/**
 * (command line, current folder) read from the process's PEB, or null if not readable. Needs only
 * PROCESS_QUERY_INFORMATION | PROCESS_VM_READ on a same-user, 64-bit process. Offsets are the x64 layout, as in ownership_probe.py.
 */
export function processStrings(pid: number): { commandLine: string | null; cwd: string | null } | null {
  const k = kernel32();
  const handle = k.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
  if (handle === null) return null;
  try {
    const info = new Uint8Array(48); // PROCESS_BASIC_INFORMATION
    if (ntdll().NtQueryInformationProcess(handle, 0, info, info.byteLength, new Uint32Array(1)) !== 0) return null;
    const peb = new DataView(info.buffer).getBigUint64(8, true);
    const pointer = readMemory(handle, peb + 0x20n, 8); // PEB.ProcessParameters
    if (!pointer || pointer.byteLength < 8) return null;
    const params = new DataView(pointer.buffer, pointer.byteOffset).getBigUint64(0, true);
    const unicodeString = (offset: number, limit: number): string | null => {
      const header = readMemory(handle, params + BigInt(offset), 16);
      if (!header || header.byteLength < 16) return null;
      const view = new DataView(header.buffer, header.byteOffset);
      const length = view.getUint16(0, true);
      const address = view.getBigUint64(8, true);
      if (!length || !address) return '';
      const raw = readMemory(handle, address, Math.min(length, limit));
      return raw ? fromWide(raw) : null;
    };
    return { commandLine: unicodeString(0x70, 16384), cwd: unicodeString(0x38, 4096) };
  } finally {
    k.CloseHandle(handle);
  }
}

/** Process creation time as epoch seconds, or null. */
export function processStartTime(pid: number): number | null {
  const k = kernel32();
  const handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === null) return null;
  try {
    const created = new BigUint64Array(1);
    const scratch = () => new BigUint64Array(1);
    if (!k.GetProcessTimes(handle, created, scratch(), scratch(), scratch())) return null;
    return Number(created[0]) / 10_000_000 - 11644473600;
  } finally {
    k.CloseHandle(handle);
  }
}

/** true/false when it can be told, null when unknown. A start time more than 5 s off means the PID was reused. */
export function processAlive(pid: number, expectedStart?: number | null): boolean | null {
  if (!Number.isInteger(pid)) return null;
  if (pid <= 0) return false;
  const k = kernel32();
  const handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === null) return k.GetLastError() === ERROR_INVALID_PARAMETER ? false : null;
  try {
    const code = new Uint32Array(1);
    if (!k.GetExitCodeProcess(handle, code) || code[0] !== STILL_ACTIVE) return false;
  } finally {
    k.CloseHandle(handle);
  }
  const started = processStartTime(pid);
  if (expectedStart != null && started !== null && Math.abs(started - expectedStart) > 5) return false;
  return true;
}

const RM_PROCESS_INFO_SIZE = 668;

/**
 * [(pid, app name)] of processes that hold `path` open right now, via the Restart Manager; null when unavailable. Read-only: it asks
 * Windows who has the file open and takes no handle that could block a writer. [] proves nothing (open-append-close clients).
 */
export function restartManagerHolders(path: string, max = 32): [number, string][] | null {
  const rm = rstrtmgr();
  const session = new Uint32Array(1);
  if (rm.RmStartSession(session, 0, new Uint16Array(33))) return null;
  try {
    const file = wide(path);
    const names = new BigUint64Array([BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(file)))]);
    if (rm.RmRegisterResources(session[0], 1, names, 0, null, 0, null)) return null;
    const needed = new Uint32Array(1);
    const count = new Uint32Array([max]);
    const infos = new Uint8Array(max * RM_PROCESS_INFO_SIZE);
    const status = rm.RmGetList(session[0], needed, count, infos, new Uint32Array(1));
    if (status !== 0) return null; // 234 = ERROR_MORE_DATA: more holders than max; treated as unknown, like Python
    const out: [number, string][] = [];
    for (let i = 0; i < count[0]; i++) {
      const item = infos.subarray(i * RM_PROCESS_INFO_SIZE, (i + 1) * RM_PROCESS_INFO_SIZE);
      out.push([new DataView(item.buffer, item.byteOffset).getUint32(0, true), fromWide(item.subarray(12, 12 + 512))]);
    }
    return out;
  } finally {
    rm.RmEndSession(session[0]);
  }
}
