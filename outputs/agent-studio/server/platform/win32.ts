/**
 * Every Windows system call the server makes, in one place (rewrite spec §3.5: no FFI outside server/platform/).
 * Libraries open lazily on first use, so importing this module on macOS or Linux is harmless.
 * A wrong signature here crashes the process instead of throwing, so each binding has a test in work/deno/platform_test.ts.
 */

const kernel32Symbols = {
  GetLastError: { parameters: [], result: 'u32' },
  CloseHandle: { parameters: ['pointer'], result: 'i32' },
  OpenProcess: { parameters: ['u32', 'i32', 'u32'], result: 'pointer' },
  GetExitCodeProcess: { parameters: ['pointer', 'buffer'], result: 'i32' },
  GetProcessTimes: { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  ReadProcessMemory: { parameters: ['pointer', 'u64', 'buffer', 'usize', 'buffer'], result: 'i32' },
  CreateToolhelp32Snapshot: { parameters: ['u32', 'u32'], result: 'pointer' },
  Process32FirstW: { parameters: ['pointer', 'buffer'], result: 'i32' },
  Process32NextW: { parameters: ['pointer', 'buffer'], result: 'i32' },
  CreateJobObjectW: { parameters: ['pointer', 'pointer'], result: 'pointer' },
  SetInformationJobObject: { parameters: ['pointer', 'i32', 'buffer', 'u32'], result: 'i32' },
  AssignProcessToJobObject: { parameters: ['pointer', 'pointer'], result: 'i32' },
  TerminateJobObject: { parameters: ['pointer', 'u32'], result: 'i32' },
  GetConsoleWindow: { parameters: [], result: 'pointer' },
  AllocConsole: { parameters: [], result: 'i32' },
  AttachConsole: { parameters: ['u32'], result: 'i32' },
  GetConsoleCP: { parameters: [], result: 'u32' },
  TerminateProcess: { parameters: ['pointer', 'u32'], result: 'i32' },
  GetCurrentPackageFullName: { parameters: ['buffer', 'buffer'], result: 'i32' },
  CreateFileW: { parameters: ['buffer', 'u32', 'u32', 'buffer', 'u32', 'u32', 'pointer'], result: 'pointer' },
  CreateProcessW: {
    parameters: ['pointer', 'buffer', 'pointer', 'pointer', 'i32', 'u32', 'pointer', 'buffer', 'buffer', 'buffer'],
    result: 'i32',
  },
  InitializeProcThreadAttributeList: { parameters: ['buffer', 'u32', 'u32', 'buffer'], result: 'i32' },
  UpdateProcThreadAttribute: { parameters: ['buffer', 'u32', 'usize', 'buffer', 'usize', 'pointer', 'pointer'], result: 'i32' },
  DeleteProcThreadAttributeList: { parameters: ['buffer'], result: 'void' },
  LocalFree: { parameters: ['pointer'], result: 'pointer' },
  GetCurrentProcess: { parameters: [], result: 'pointer' },
} as const;

/** Security descriptors and tokens (server/platform/acl.ts: the owner-only check of the state folder); the registry (tray_icon.ts). */
const advapi32Symbols = {
  GetNamedSecurityInfoW: { parameters: ['buffer', 'i32', 'u32', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'u32' },
  GetAclInformation: { parameters: ['pointer', 'buffer', 'u32', 'i32'], result: 'i32' },
  GetAce: { parameters: ['pointer', 'u32', 'buffer'], result: 'i32' },
  ConvertSidToStringSidW: { parameters: ['pointer', 'buffer'], result: 'i32' },
  OpenProcessToken: { parameters: ['pointer', 'u32', 'buffer'], result: 'i32' },
  GetTokenInformation: { parameters: ['pointer', 'i32', 'buffer', 'u32', 'buffer'], result: 'i32' },
  // HKEY (a predefined key is a sign-extended pointer value), sub key, value name, RRF_RT_* flags, type, data, data size -> LSTATUS
  RegGetValueW: { parameters: ['pointer', 'buffer', 'buffer', 'u32', 'pointer', 'buffer', 'buffer'], result: 'i32' },
} as const;

const ntdllSymbols = {
  NtQueryInformationProcess: { parameters: ['pointer', 'u32', 'buffer', 'u32', 'buffer'], result: 'i32' },
} as const;

const rstrtmgrSymbols = {
  RmStartSession: { parameters: ['buffer', 'u32', 'buffer'], result: 'u32' },
  RmRegisterResources: { parameters: ['u32', 'u32', 'buffer', 'u32', 'pointer', 'u32', 'pointer'], result: 'u32' },
  RmGetList: { parameters: ['u32', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'u32' },
  RmEndSession: { parameters: ['u32'], result: 'u32' },
} as const;

const user32Symbols = {
  ShowWindow: { parameters: ['pointer', 'i32'], result: 'i32' },
  IsWindowVisible: { parameters: ['pointer'], result: 'i32' },
  GetSystemMetrics: { parameters: ['i32'], result: 'i32' },
} as const;

function lazy<S extends Deno.ForeignLibraryInterface>(name: string, symbols: S): () => Deno.DynamicLibrary<S>['symbols'] {
  let lib: Deno.DynamicLibrary<S> | null = null;
  return () => {
    if (Deno.build.os !== 'windows') throw new Error(`${name} is only available on Windows`);
    lib ??= Deno.dlopen(name, symbols);
    return lib.symbols;
  };
}

export const kernel32 = lazy('kernel32.dll', kernel32Symbols);
export const ntdll = lazy('ntdll.dll', ntdllSymbols);
export const rstrtmgr = lazy('rstrtmgr.dll', rstrtmgrSymbols);
export const user32 = lazy('user32.dll', user32Symbols);
export const advapi32 = lazy('advapi32.dll', advapi32Symbols);

type AllocWithOptions = (options: Uint32Array, result: Uint32Array) => number;
let allocWithOptions: AllocWithOptions | null | undefined;

/** AllocConsoleWithOptions exists only on Windows 11 24H2 (build 26100) and later, so it is looked up on its own; null when missing. */
export function allocConsoleWithOptions(): AllocWithOptions | null {
  if (allocWithOptions !== undefined) return allocWithOptions;
  try {
    const lib = Deno.dlopen('kernel32.dll', { AllocConsoleWithOptions: { parameters: ['buffer', 'buffer'], result: 'i32' } } as const);
    allocWithOptions = (options, result) => lib.symbols.AllocConsoleWithOptions(options, result);
  } catch {
    allocWithOptions = null;
  }
  return allocWithOptions;
}

/** A NUL-terminated UTF-16 string for a W API. */
export function wide(text: string): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(text.length + 1);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Decode UTF-16LE bytes up to the first NUL. */
export function fromWide(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  let end = units.indexOf(0);
  if (end < 0) end = units.length;
  let text = '';
  for (let i = 0; i < end; i += 4096) text += String.fromCharCode(...units.subarray(i, Math.min(end, i + 4096)));
  return text;
}

export const PROCESS_TERMINATE = 0x0001;
export const PROCESS_VM_READ = 0x0010;
export const PROCESS_SET_QUOTA = 0x0100;
export const PROCESS_QUERY_INFORMATION = 0x0400;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
export const STILL_ACTIVE = 259;
export const ERROR_INVALID_PARAMETER = 87;
