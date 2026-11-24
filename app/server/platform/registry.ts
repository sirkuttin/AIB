/**
 * Read-only registry lookups under HKEY_CURRENT_USER (Windows only), through advapi32 in win32.ts: no reg.exe child, so no console
 * and nothing started. Used by wsl/detect.ts for the WSL distro list (HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss).
 */
import { advapi32, fromWide, wide } from './win32.ts';

const HKEY_CURRENT_USER = 0xFFFFFFFF80000001n; // (HKEY)(LONG)0x80000001, sign-extended on 64-bit
const KEY_READ = 0x20019;
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const REG_DWORD = 4;
const ERROR_SUCCESS = 0;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const MAX_SUBKEYS = 256;

export type RegValue = string | number;

function openKey(parent: Deno.PointerValue, path: string): Deno.PointerValue {
  const out = new BigUint64Array(1);
  const status = advapi32().RegOpenKeyExW(parent, wide(path), 0, KEY_READ, new Uint8Array(out.buffer));
  return status === ERROR_SUCCESS ? Deno.UnsafePointer.create(out[0]) : null;
}

function hkcu(): Deno.PointerValue {
  return Deno.UnsafePointer.create(HKEY_CURRENT_USER);
}

/** One value of an open key: REG_SZ / REG_EXPAND_SZ as text, REG_DWORD as a number; undefined when missing or of another type. */
function queryValue(key: Deno.PointerValue, name: string, max = 65536): RegValue | undefined {
  const type = new Uint32Array(1);
  const size = new Uint32Array([1024]);
  let data = new Uint8Array(size[0]);
  const query = () => advapi32().RegQueryValueExW(key, wide(name), null, new Uint8Array(type.buffer), data, new Uint8Array(size.buffer));
  let status = query();
  if (status === ERROR_MORE_DATA && size[0] <= max) {
    data = new Uint8Array(size[0] + 2);
    status = query();
  }
  if (status !== ERROR_SUCCESS) return undefined;
  if (type[0] === REG_DWORD && size[0] >= 4) return new DataView(data.buffer).getUint32(0, true);
  if (type[0] === REG_SZ || type[0] === REG_EXPAND_SZ) return fromWide(data.subarray(0, size[0] + (size[0] % 2)));
  return undefined;
}

/**
 * The subkeys of HKCU\<path> with the named values of each ([] when the key is missing; throws off Windows). `names`: the values
 * to read.
 */
export function hkcuSubkeys(path: string, names: readonly string[]): { key: string; values: Record<string, RegValue> }[] {
  const root = openKey(hkcu(), path);
  if (root === null) return [];
  const out: { key: string; values: Record<string, RegValue> }[] = [];
  try {
    for (let index = 0; index < MAX_SUBKEYS; index++) {
      const name = new Uint8Array(512);
      const length = new Uint32Array([256]);
      const status = advapi32().RegEnumKeyExW(root, index, name, new Uint8Array(length.buffer), null, null, null, null);
      if (status === ERROR_NO_MORE_ITEMS) break;
      if (status !== ERROR_SUCCESS) continue;
      const subkey = fromWide(name);
      const child = openKey(root, subkey);
      if (child === null) continue;
      try {
        const values: Record<string, RegValue> = {};
        for (const valueName of names) {
          const value = queryValue(child, valueName);
          if (value !== undefined) values[valueName] = value;
        }
        out.push({ key: subkey, values });
      } finally {
        advapi32().RegCloseKey(child);
      }
    }
  } finally {
    advapi32().RegCloseKey(root);
  }
  return out;
}

/** One value of HKCU\<path> (undefined when missing). */
export function hkcuValue(path: string, name: string): RegValue | undefined {
  const key = openKey(hkcu(), path);
  if (key === null) return undefined;
  try {
    return queryValue(key, name);
  } finally {
    advapi32().RegCloseKey(key);
  }
}

const HKEY_LOCAL_MACHINE = 0xFFFFFFFF80000002n;
/** Policy values can be whole settings documents: read up to this much. */
const MAX_POLICY_BYTES = 1 << 20;

/**
 * One text value of HKLM\<path> or HKCU\<path> (undefined when missing or not text; throws off Windows). Used for Claude Code's
 * policy settings (HKLM/HKCU\SOFTWARE\Policies\ClaudeCode, value Settings: a JSON document).
 */
export function policyText(hive: 'HKLM' | 'HKCU', path: string, name: string): string | undefined {
  const key = openKey(hive === 'HKLM' ? Deno.UnsafePointer.create(HKEY_LOCAL_MACHINE) : hkcu(), path);
  if (key === null) return undefined;
  try {
    const value = queryValue(key, name, MAX_POLICY_BYTES);
    return typeof value === 'string' ? value : undefined;
  } finally {
    advapi32().RegCloseKey(key);
  }
}
