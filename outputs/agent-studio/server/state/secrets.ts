/**
 * API keys at rest: the Beta agents' keys (studio-settings.json, agents.betaKeys). SettingsStore keeps plain keys in memory
 * only; on disk each key is replaced by a sealed form:
 *
 *   Windows  "dpapi:v1:<base64>"   CryptProtectData for the current user (crypt32.dll via FFI) with AIB's own entropy: only this
 *                                   Windows account on this PC can open it.
 *   macOS    "keychain:v1"          the key is in the login Keychain (generic password, service "AIB beta agent keys"). It is
 *                                   written through `security -i` on stdin, so it never shows in a process list.
 *   Linux    "secret-service:v1"    the key is in the Secret Service (GNOME Keyring, KWallet...) through `secret-tool`, which
 *                                   reads it from stdin.
 *            "file:v1"              no Secret Service: the key is in beta-keys.json next to the settings, mode 0600 (owner only),
 *                                   and Settings says so. Also the fallback when the Keychain or keyring refused the key.
 *
 * A key with no prefix is a plain key from an older AIB: SettingsStore reads it and seals it at once (migration on load).
 * Keys are never logged: messages name the agent and the store, never a value.
 *
 * Writing to the Keychain or keyring needs stdin, which Deno only offers asynchronously, while the settings file is written
 * inside a synchronous lock. So an outside store is filled first (prepare(), awaited before the lock) and seal() then writes
 * only its marker; a key that was not prepared goes to the file instead, never to the settings in plain text.
 *
 * AIB_KEY_STORE=dpapi|keychain|secret-service|file picks the store. Under the test suite (AGENT_STUDIO_TEST=1) macOS and Linux
 * use "file", so a test never touches the user's real Keychain or keyring.
 */
import { getLogger } from '../core/log.ts';
import { writeJsonAtomic } from '../core/fs.ts';
import { which } from '../platform/pypath.ts';

const log = getLogger('secrets');

export type KeyStoreKind = 'dpapi' | 'keychain' | 'secret-service' | 'file';

export interface KeyStore {
  readonly kind: KeyStoreKind;
  /** Plain words for Settings: where a saved key is kept. */
  readonly note: string;
  /** Put the key in the outside store (Keychain, keyring) before the settings are saved. Never throws. */
  prepare(agentId: string, plain: string): Promise<void>;
  /** The forms to write to the settings file for every key ({agentId: plain}); keys no longer listed are forgotten. */
  sealAll(keys: Record<string, string>): Record<string, string>;
  /** The plain key from a stored form; null when it cannot be opened. A plain (unsealed) value is returned as it is. */
  open(agentId: string, stored: string): string | null;
}

export const DPAPI_PREFIX = 'dpapi:v1:';
export const KEYCHAIN_MARK = 'keychain:v1';
export const SECRET_SERVICE_MARK = 'secret-service:v1';
export const FILE_MARK = 'file:v1';
export const KEY_FILE = 'beta-keys.json';
const SEALED = /^(?:dpapi:v1:|keychain:v1$|secret-service:v1$|file:v1$)/;

/** Is this a sealed form, as opposed to a plain key saved by an older AIB? */
export function isSealed(stored: string): boolean {
  return SEALED.test(stored);
}

/** The store this process uses for keys under `stateDir`. */
export function keyStoreFor(stateDir: string): KeyStore {
  const want = (Deno.env.get('AIB_KEY_STORE') || '').trim().toLowerCase();
  const os = Deno.build.os;
  if (want === 'file') return new FileStore(stateDir);
  // The test suite never touches the real Keychain or keyring (DPAPI has no outside state: it stays on).
  if (!want && os !== 'windows' && Deno.env.get('AGENT_STUDIO_TEST') === '1') return new FileStore(stateDir);
  if (want === 'dpapi' || (!want && os === 'windows')) return new DpapiStore(stateDir);
  if (want === 'keychain' || (!want && os === 'darwin')) return new OutsideStore(stateDir, 'keychain');
  if (want === 'secret-service' || (!want && which('secret-tool'))) return new OutsideStore(stateDir, 'secret-service');
  return new FileStore(stateDir);
}

/** A short, stable tag for a state folder, so two AIB data folders (a demo, a test) never share a keyring entry. */
export function folderTag(stateDir: string): string {
  let h = 0x811c9dc5;
  const text = stateDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });
const joinPath = (dir: string, name: string) => dir.replace(/[\\/]+$/, '') + (dir.includes('\\') ? '\\' : '/') + name;

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---- the file: beta-keys.json, mode 0600 -----------------------------------------------------------------------------------

/** {agentId: key} in <state>/beta-keys.json, written atomically with mode 0600 (the owner only). */
class KeyFile {
  constructor(readonly path: string) {}
  read(): Record<string, string> {
    try {
      const data = JSON.parse(Deno.readTextFileSync(this.path));
      const out: Record<string, string> = {};
      if (data && typeof data === 'object' && data.keys && typeof data.keys === 'object') {
        for (const [k, v] of Object.entries(data.keys)) if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  write(keys: Record<string, string>): void {
    const ids = Object.keys(keys);
    if (!ids.length) {
      try {
        Deno.removeSync(this.path);
      } catch { /* not there */ }
      return;
    }
    const current = this.read();
    if (ids.length === Object.keys(current).length && ids.every((id) => current[id] === keys[id])) return;
    writeJsonAtomic(this.path, null, { prefix: '.beta-keys-', suffix: '.tmp', text: JSON.stringify({ version: 1, keys }) });
    try {
      Deno.chmodSync(this.path, 0o600); // the temp file was made 0600; this keeps it so if the umask or an old file disagreed
    } catch { /* Windows: no POSIX modes */ }
  }
}

class FileStore implements KeyStore {
  readonly kind: KeyStoreKind = 'file';
  readonly note: string;
  readonly file: KeyFile;
  constructor(stateDir: string) {
    this.file = new KeyFile(joinPath(stateDir, KEY_FILE));
    this.note = `Saved in ${KEY_FILE} in the data folder, readable only by your user account (file mode 0600). ` +
      'This computer has no keyring (Secret Service) AIB can use, so the key is not encrypted.';
  }
  prepare(): Promise<void> {
    return Promise.resolve();
  }
  sealAll(keys: Record<string, string>): Record<string, string> {
    this.file.write({ ...keys });
    return Object.fromEntries(Object.keys(keys).map((id) => [id, FILE_MARK]));
  }
  open(agentId: string, stored: string): string | null {
    if (!isSealed(stored)) return stored;
    if (stored !== FILE_MARK) return null;
    return this.file.read()[agentId] ?? null;
  }
}

// ---- Windows: DPAPI --------------------------------------------------------------------------------------------------------

const ENTROPY = utf8.encode('AIB beta agent API key v1');
const DESCRIPTION = new Uint8Array([65, 0, 73, 0, 66, 0, 0, 0]); // L"AIB", stored with the blob
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

const DPAPI_SYMBOLS = {
  CryptProtectData: {
    parameters: ['buffer', 'buffer', 'buffer', 'pointer', 'pointer', 'u32', 'buffer'],
    result: 'i32',
  },
  CryptUnprotectData: {
    parameters: ['buffer', 'pointer', 'buffer', 'pointer', 'pointer', 'u32', 'buffer'],
    result: 'i32',
  },
} as const;
const KERNEL_SYMBOLS = { LocalFree: { parameters: ['pointer'], result: 'pointer' } } as const;
let crypt: Deno.DynamicLibrary<typeof DPAPI_SYMBOLS> | null = null;
let kernel: Deno.DynamicLibrary<typeof KERNEL_SYMBOLS> | null = null;
function libs() {
  crypt ??= Deno.dlopen('crypt32.dll', DPAPI_SYMBOLS);
  kernel ??= Deno.dlopen('kernel32.dll', KERNEL_SYMBOLS);
  return { crypt, kernel };
}
/** A DATA_BLOB {DWORD cbData; BYTE *pbData} (16 bytes on 64-bit Windows) over `bytes`, which must outlive the call. */
function blobOf(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const blob = new Uint8Array(16);
  const view = new DataView(blob.buffer);
  view.setUint32(0, bytes.length, true);
  const ptr = bytes.length ? Deno.UnsafePointer.of(bytes) : null;
  view.setBigUint64(8, ptr ? BigInt(Deno.UnsafePointer.value(ptr)) : 0n, true);
  return blob;
}
/** The bytes of an output DATA_BLOB, which is then freed (LocalFree) and its copy wiped by the caller. */
function takeBlob(blob: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const view = new DataView(blob.buffer);
  const size = view.getUint32(0, true);
  const ptr = Deno.UnsafePointer.create(view.getBigUint64(8, true));
  if (!ptr) return new Uint8Array(0);
  try {
    const out = new Uint8Array(size);
    out.set(new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(ptr, size)));
    return out;
  } finally {
    libs().kernel.symbols.LocalFree(ptr);
  }
}

/** CryptProtectData for the current user. */
export function dpapiProtect(plain: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const { crypt } = libs();
  const out = new Uint8Array(16);
  const ok = crypt.symbols.CryptProtectData(blobOf(plain), DESCRIPTION, blobOf(ENTROPY), null, null, CRYPTPROTECT_UI_FORBIDDEN, out);
  if (!ok) throw new Error('Windows could not encrypt the key (CryptProtectData failed)');
  return takeBlob(out);
}

/** CryptUnprotectData; null when it cannot be opened (another Windows account, a damaged value). */
export function dpapiUnprotect(sealed: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  const { crypt } = libs();
  const out = new Uint8Array(16);
  const ok = crypt.symbols.CryptUnprotectData(blobOf(sealed), null, blobOf(ENTROPY), null, null, CRYPTPROTECT_UI_FORBIDDEN, out);
  return ok ? takeBlob(out) : null;
}

class DpapiStore implements KeyStore {
  readonly kind: KeyStoreKind = 'dpapi';
  readonly note = 'Encrypted by Windows (DPAPI) for your Windows account: only you, on this PC, can read it';
  readonly #fallback: FileStore;
  /** Sealing is randomised: a key that did not change keeps its sealed form, so saving other settings does not rewrite it. */
  readonly #sealed = new Map<string, { plain: string; stored: string }>();
  constructor(stateDir: string) {
    this.#fallback = new FileStore(stateDir);
  }
  prepare(): Promise<void> {
    return Promise.resolve();
  }
  sealAll(keys: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, plain] of Object.entries(keys)) {
      const had = this.#sealed.get(id);
      if (had && had.plain === plain) {
        out[id] = had.stored;
        continue;
      }
      const bytes = utf8.encode(plain);
      try {
        out[id] = DPAPI_PREFIX + toBase64(dpapiProtect(bytes));
        this.#sealed.set(id, { plain, stored: out[id] });
      } finally {
        bytes.fill(0);
      }
    }
    for (const id of [...this.#sealed.keys()]) if (!(id in keys)) this.#sealed.delete(id);
    this.#fallback.sealAll({}); // a file left by AIB_KEY_STORE=file or an older fallback goes
    return out;
  }
  open(agentId: string, stored: string): string | null {
    if (!isSealed(stored)) return stored;
    if (stored === FILE_MARK) return this.#fallback.open(agentId, stored);
    if (!stored.startsWith(DPAPI_PREFIX)) return null;
    try {
      const bytes = dpapiUnprotect(fromBase64(stored.slice(DPAPI_PREFIX.length)));
      if (bytes) {
        const plain = fromUtf8.decode(bytes);
        bytes.fill(0);
        this.#sealed.set(agentId, { plain, stored });
        return plain;
      }
    } catch { /* below */ }
    log.warning(`The saved API key for ${agentId} could not be decrypted for this Windows account; type it again in Settings.`);
    return null;
  }
}

// ---- macOS Keychain and the Linux Secret Service ----------------------------------------------------------------------------

const SERVICE = 'AIB beta agent keys';

/** A quoted argument for `security -i` (its own command line: double quotes, backslash escapes). */
const securityArg = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function feed(cmd: string, args: string[], input: string): Promise<boolean> {
  try {
    const child = new Deno.Command(cmd, { args, stdin: 'piped', stdout: 'null', stderr: 'null' }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(utf8.encode(input));
    await writer.close();
    return (await child.status).success;
  } catch {
    return false;
  }
}
function lookup(cmd: string, args: string[]): string | null {
  try {
    const r = new Deno.Command(cmd, { args, stdin: 'null', stdout: 'piped', stderr: 'null' }).outputSync();
    if (!r.success) return null;
    return new TextDecoder().decode(r.stdout).replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

class OutsideStore implements KeyStore {
  readonly kind: KeyStoreKind;
  readonly note: string;
  readonly #fallback: FileStore;
  readonly #tag: string;
  readonly #mark: string;
  /** Keys known to be in the outside store now (put there by prepare(), or read back by open()). */
  readonly #held = new Map<string, string>();
  constructor(stateDir: string, kind: 'keychain' | 'secret-service') {
    this.kind = kind;
    this.#fallback = new FileStore(stateDir);
    this.#tag = folderTag(stateDir);
    this.#mark = kind === 'keychain' ? KEYCHAIN_MARK : SECRET_SERVICE_MARK;
    this.note = kind === 'keychain'
      ? 'Saved in your macOS Keychain (login keychain, "AIB beta agent keys")'
      : 'Saved in your keyring (Secret Service, e.g. GNOME Keyring or KWallet)';
  }
  #account(agentId: string): string {
    return `${agentId}@${this.#tag}`;
  }
  async prepare(agentId: string, plain: string): Promise<void> {
    if (this.#held.get(agentId) === plain) return;
    const account = this.#account(agentId);
    const ok = this.kind === 'keychain'
      ? await feed(
        'security',
        ['-i'],
        [
          'add-generic-password -U -s',
          securityArg(SERVICE),
          '-a',
          securityArg(account),
          '-l',
          securityArg('AIB: ' + agentId + ' API key'),
          '-w',
          securityArg(plain),
        ].join(' ') + '\n',
      )
      : await feed('secret-tool', ['store', '--label', `AIB: ${agentId} API key`, 'service', SERVICE, 'account', account], plain);
    if (ok) this.#held.set(agentId, plain);
    else log.warning(`The ${this.kind} did not take the API key for ${agentId}; it is kept in ${KEY_FILE} instead.`);
  }
  sealAll(keys: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    const toFile: Record<string, string> = {};
    for (const [id, plain] of Object.entries(keys)) {
      if (this.#held.get(id) === plain) out[id] = this.#mark;
      else {
        toFile[id] = plain;
        out[id] = FILE_MARK;
      }
    }
    for (const id of [...this.#held.keys()]) {
      if (out[id] === this.#mark) continue;
      this.#held.delete(id);
      void this.#forget(id);
    }
    this.#fallback.sealAll(toFile);
    return out;
  }
  #forget(agentId: string): Promise<boolean> {
    const account = this.#account(agentId);
    return this.kind === 'keychain'
      ? feed('security', ['-i'], `delete-generic-password -s ${securityArg(SERVICE)} -a ${securityArg(account)}\n`)
      : feed('secret-tool', ['clear', 'service', SERVICE, 'account', account], '');
  }
  open(agentId: string, stored: string): string | null {
    if (!isSealed(stored)) return stored;
    if (stored === FILE_MARK) return this.#fallback.open(agentId, stored);
    if (stored !== this.#mark) return null;
    const known = this.#held.get(agentId);
    if (known) return known; // read once per run: the outside store is not asked again on every settings reload
    const account = this.#account(agentId);
    const plain = this.kind === 'keychain'
      ? lookup('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
      : lookup('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    if (plain === null || plain === '') {
      log.warning(`The saved API key for ${agentId} is not in the ${this.kind} any more; type it again in Settings.`);
      return null;
    }
    this.#held.set(agentId, plain);
    return plain;
  }
}
