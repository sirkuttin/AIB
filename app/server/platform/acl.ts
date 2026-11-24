/**
 * Windows security facts for the state folder (state_paths.py windows_dacl, windows_current_user_sid, _package_family_from_api).
 * The DACL is read with GetNamedSecurityInfoW and every ACE is reported by SID string, never by localized icacls text.
 * All FFI stays here and in win32.ts (rewrite spec §3.5).
 */
import { advapi32, kernel32, wide } from './win32.ts';

/** [sid, aceType, mask, flags] for one ACE, as Python's (sid_string, ace_type, mask, flags). */
export type AceEntry = [string, number, number, number];

/** OSError(code, message): str() is '[Errno code] message', which is what Python shows. */
export class WinApiError extends Error {
  constructor(readonly code: number | null, detail: string) {
    super(code === null ? detail : `[Errno ${code}] ${detail}`);
  }
}

function pointerAt(cell: BigUint64Array): Deno.PointerValue {
  return Deno.UnsafePointer.create(cell[0]);
}

/** A NUL-terminated UTF-16 string at a native pointer. */
function wideAt(pointer: Deno.PointerObject): string {
  const view = new Deno.UnsafePointerView(pointer);
  let text = '';
  for (let offset = 0;; offset += 2) {
    const unit = view.getUint16(offset);
    if (!unit) return text;
    text += String.fromCharCode(unit);
  }
}

function sidString(sid: Deno.PointerValue): string {
  const out = new BigUint64Array(1);
  if (!advapi32().ConvertSidToStringSidW(sid, out)) return '';
  const text = pointerAt(out);
  if (text === null) return '';
  try {
    return wideAt(text);
  } finally {
    kernel32().LocalFree(text);
  }
}

/** Object and compound ACE types: GUIDs sit before the SID. */
const OBJECT_ACES = new Set([5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17]);

/** Every ACE of the folder's DACL, or null for a NULL DACL (everyone has full access). Throws WinApiError when it cannot be read. */
export function windowsDacl(path: string): AceEntry[] | null {
  const owner = new BigUint64Array(1);
  const dacl = new BigUint64Array(1);
  const descriptor = new BigUint64Array(1);
  // SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
  const code = advapi32().GetNamedSecurityInfoW(wide(path), 1, 0x1 | 0x4, owner, null, dacl, null, descriptor);
  if (code) throw new WinApiError(code, `GetNamedSecurityInfoW failed for ${path} (error ${code})`);
  try {
    const list = pointerAt(dacl);
    if (list === null) return null;
    const info = new Uint32Array(3);
    if (!advapi32().GetAclInformation(list, info, info.byteLength, 2)) throw new WinApiError(null, 'GetAclInformation failed'); // AclSizeInformation
    const entries: AceEntry[] = [];
    for (let index = 0; index < info[0]; index++) {
      const cell = new BigUint64Array(1);
      if (!advapi32().GetAce(list, index, cell)) throw new WinApiError(null, 'GetAce failed');
      const ace = pointerAt(cell)!;
      const view = new Deno.UnsafePointerView(ace);
      const aceType = view.getUint8(0);
      const flags = view.getUint8(1);
      const mask = view.getUint32(4);
      let offset = 8;
      if (OBJECT_ACES.has(aceType)) {
        const objectFlags = view.getUint32(8);
        offset = 12 + (objectFlags & 1 ? 16 : 0) + (objectFlags & 2 ? 16 : 0);
      }
      entries.push([sidString(Deno.UnsafePointer.offset(ace, offset)), aceType, mask, flags]);
    }
    return entries;
  } finally {
    const block = pointerAt(descriptor);
    if (block !== null) kernel32().LocalFree(block);
  }
}

/** The SID of the user this process runs as (from its token), e.g. 'S-1-5-21-...'. */
export function windowsCurrentUserSid(): string {
  const token = new BigUint64Array(1);
  if (!advapi32().OpenProcessToken(kernel32().GetCurrentProcess(), 0x8, token)) throw new WinApiError(null, 'OpenProcessToken failed'); // TOKEN_QUERY
  const handle = pointerAt(token);
  try {
    const size = new Uint32Array(1);
    advapi32().GetTokenInformation(handle, 1, null, 0, size); // TokenUser
    const buffer = new Uint8Array(Math.max(size[0], 16));
    if (!advapi32().GetTokenInformation(handle, 1, buffer, buffer.byteLength, size)) {
      throw new WinApiError(null, 'GetTokenInformation failed');
    }
    const sid = new BigUint64Array(buffer.buffer, 0, 1); // TOKEN_USER starts with the PSID (it points into this buffer)
    return sidString(pointerAt(sid));
  } finally {
    kernel32().CloseHandle(handle);
  }
}

/** GetCurrentPackageFullName as state_paths' fake kernels see it: (length cell, UTF-16 buffer or null) -> Win32 error code. */
export interface PackageKernel {
  GetCurrentPackageFullName(length: Uint32Array, buffer: Uint16Array | null): number;
}

/** The real kernel32 binding (Windows only). */
export function packageKernel(): PackageKernel {
  return {
    GetCurrentPackageFullName: (length, buffer) => kernel32().GetCurrentPackageFullName(length, buffer),
  };
}
