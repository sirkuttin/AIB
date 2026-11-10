/**
 * Automatic updates (updater.py), ported from the owner's GROUT updater: check GitHub Releases, download the installer for this
 * platform and architecture, verify its SHA-256 against the release's SHA256SUMS asset, tell the person, and install only when they
 * click.
 *
 * Rules this file keeps (as updater.py):
 *   - The only network calls are to the GitHub Releases API (and the asset hosts GitHub redirects to), over https, never with a
 *     credential, with redirects followed by hand and every hop's host checked. A test points AIB_UPDATE_API_BASE at a local fake
 *     server; the fetch function is injectable too.
 *   - An installer is never run unless its hash matched the release's SHA256SUMS line for exactly that file name.
 *   - Nothing installs without the person's click. Automatic checks only look, download and verify.
 *   - Checks happen at most once a day (manual "Check for updates" is always allowed). Turned off in Settings: no network call.
 *   - The desktop app (a `deno desktop` binary) installs in place on Windows (the per-user zip), macOS (the zipped AIB.app) and Linux
 *     when it runs from an AppImage: update_helper.ts swaps the files after the app quits. A .deb install, and any `deno run`, get the
 *     verified file and instructions.
 *
 * The assets (tools/build.ts): AIB-<version>-windows-x64.zip, -windows-arm64.zip, -macos-x64.zip, -macos-arm64.zip,
 * -linux-x64.AppImage, -linux-arm64.AppImage, -linux-x64.deb, -linux-arm64.deb, and SHA256SUMS. There is no upgrade path from the
 * Tauri beta (its -setup.exe / .dmg names are not offered).
 *
 * The state file (<state dir>/updates/state.json) has the same name and JSON as Python's.
 */
import { createHash } from 'node:crypto';
import { isDict, pyFloat, pyOr, pyStr, pyStrip, pyTruthy, ValueError } from '../core/py.ts';
import { writeJsonAtomic } from '../core/fs.ts';
import { APP_VERSION, isDesktopApp } from '../core/app.ts';
import { spawnDetached } from '../platform/spawn_detached.ts';
import { cleanEnv, type HelperArgs, type InstallTarget, installTarget } from './update_helper.ts';

const envGet = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

/** The releases the desktop app updates from (hand-built with tools/build.ts, uploaded with `gh release create --prerelease`). */
export const UPDATE_REPO = 'sirkuttin/AIB';
/** Test and dev hook: the repository to check ('OWNER/aib' turns checking off). */
export const REPO_ENV = 'AIB_UPDATE_REPO';
export const PLACEHOLDER_REPO = 'OWNER/aib';
export const API_BASE = 'https://api.github.com';
/** Test hook: a local fake release server (http://127.0.0.1:PORT). */
export const BASE_ENV = 'AIB_UPDATE_API_BASE';
export const CHECK_INTERVAL = 24 * 3600;
export const MAX_SUMS_BYTES = 64 * 1024;
export const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;
export const MAX_RELEASES_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT = 30;
export const TICK_SECONDS = 5;
export const FIRST_CHECK_DELAY = 20;
export const SUMS_NAME = 'SHA256SUMS';
export const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}$/;

/** Mutable so tests can shorten them. requestMs: wait for headers, and the longest pause between two body chunks (urllib's timeout). */
export const timeouts = { requestMs: REQUEST_TIMEOUT * 1000 };

export class UpdateError extends Error {
  override name = 'UpdateError';
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(message: string, code = 'update_failed', extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// ---- versions -------------------------------------------------------------------------------------------------------
export type Version = [number, number, number, string[]];
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 'v0.1.0-beta.2' -> [0, 1, 0, ['beta', '2']]; null when it is not a semantic version. */
export function parseVersion(text: unknown): Version | null {
  const m = VERSION_RE.exec(pyStrip(pyStr(pyOr(text, ''))));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []];
}

const cmp = (a: number | string, b: number | string): number => (a > b ? 1 : 0) - (a < b ? 1 : 0);
const isDigits = (s: string) => /^[0-9]+$/.test(s);

/** Semantic-version order: -1, 0 or 1 (a pre-release is older than its release; numbers sort below words). */
export function compare(a: string | Version | null, b: string | Version | null): number {
  const pa = typeof a === 'string' ? parseVersion(a) : a;
  const pb = typeof b === 'string' ? parseVersion(b) : b;
  if (!Array.isArray(pa) || !Array.isArray(pb)) throw new ValueError('not a version');
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return cmp(pa[i] as number, pb[i] as number);
  const [xa, xb] = [pa[3], pb[3]];
  if (!xa.length && !xb.length) return 0;
  if (!xa.length) return 1;
  if (!xb.length) return -1;
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const [x, y] = [xa[i], xb[i]];
    if (x === y) continue;
    const [xn, yn] = [isDigits(x), isDigits(y)];
    if (xn && yn) {
      const [bx, by] = [BigInt(x), BigInt(y)];
      return bx > by ? 1 : bx < by ? -1 : 0;
    }
    if (xn !== yn) return xn ? -1 : 1;
    return cmp(x, y);
  }
  return cmp(xa.length, xb.length);
}

export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version);
  return !!(parsed && parsed[3].length);
}

// ---- which installer is ours ----------------------------------------------------------------------------------------
export type PlatformKey = [string, string];

/** ['windows'|'linux'|'macos', 'x64'|'arm64'] for this machine, or null. Takes Python's names (win32, AMD64) or Deno's (windows, x86_64). */
export function platformKey(system?: string, machine?: string): PlatformKey | null {
  const s = (system || Deno.build.os).toLowerCase();
  const m = (machine || Deno.build.arch).toLowerCase();
  const os = s.startsWith('win') || s.startsWith('cygwin')
    ? 'windows'
    : s === 'darwin' || s === 'macos'
    ? 'macos'
    : s.startsWith('linux')
    ? 'linux'
    : null;
  const arch = ['amd64', 'x86_64', 'x64'].includes(m) ? 'x64' : ['arm64', 'aarch64'].includes(m) ? 'arm64' : null;
  return os && arch ? [os, arch] : null;
}

const ARCH_WORDS: [string, string[]][] = [['x64', ['x64', 'x86_64', 'amd64']], ['arm64', ['arm64', 'aarch64']]];
/** The word a release asset's name must contain for each system (AIB-0.2.0-windows-x64.zip). */
const OS_WORDS: Record<string, string[]> = { windows: ['windows'], macos: ['macos'], linux: ['linux'] };

function words(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/));
}

function archOf(name: string): string | null {
  const w = words(name);
  for (const [arch, aliases] of ARCH_WORDS) if (aliases.some((a) => w.has(a))) return arch;
  return null;
}

/** File endings that install on each system, best first. An asset also needs the system's word and its architecture in its name. */
export const INSTALLER_KINDS = {
  windows: ['.zip'],
  macos: ['.zip'],
  /** Linux running from an AppImage, or without dpkg. */
  linuxAppImage: ['.appimage', '.deb'],
  /** Linux with dpkg. */
  linuxDeb: ['.deb', '.appimage'],
} as const;

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export type Env = Record<string, string | undefined>;

export function installerKinds(
  osName: string,
  env: Env = Deno.env.toObject(),
  exists: (p: string) => boolean = pathExists,
): readonly string[] {
  if (osName === 'windows') return INSTALLER_KINDS.windows;
  if (osName === 'macos') return INSTALLER_KINDS.macos;
  if (env.APPIMAGE || !(exists('/usr/bin/dpkg') || exists('/bin/dpkg'))) return INSTALLER_KINDS.linuxAppImage;
  return INSTALLER_KINDS.linuxDeb;
}

type Dict = Record<string, unknown>;
const uploaded = (a: Dict) => ('state' in a ? a.state : 'uploaded') === 'uploaded';

/** The installer asset for this platform and architecture, or null. Only fully uploaded assets with plain names. */
export function pickAsset(assets: Dict[], key: PlatformKey | null, env?: Env, exists?: (p: string) => boolean): Dict | null {
  if (!key) return null;
  for (const kind of installerKinds(key[0], env, exists)) {
    for (const a of assets) {
      const name = pyStr(pyOr(a.name, ''));
      if (
        uploaded(a) && NAME_OK.test(name) && name.toLowerCase().endsWith(kind) && archOf(name) === key[1] &&
        (OS_WORDS[key[0]] ?? []).some((w) => words(name).has(w))
      ) return a;
    }
  }
  return null;
}

export interface Found {
  version: string;
  tag: string;
  prerelease: boolean;
  page: string;
  installer: { name: string; url: string; size: number };
  sums: { name: string; url: string };
}

/** int() of a JSON value (Python truncates floats and parses digit strings; anything else raises). */
function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\s*[+-]?[0-9](_?[0-9])*\s*$/.test(value)) return Number(value.replaceAll('_', '').trim());
  throw new ValueError(`invalid literal for int() with base 10: ${JSON.stringify(value)}`);
}

/**
 * The newest release worth offering, or null. Drafts are skipped; pre-releases only for someone already on one; a release counts
 * only when its installer for this platform and its SHA256SUMS are both uploaded.
 */
export function pickRelease(
  releases: unknown,
  current: string,
  key: PlatformKey | null,
  env?: Env,
  exists?: (p: string) => boolean,
): Found | null {
  const wantPre = isPrerelease(current);
  let best: Found | null = null;
  let bestParsed: Version | null = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!isDict(r) || pyTruthy(r.draft)) continue;
    const tag = pyStr(pyOr(r.tag_name, ''));
    const version = parseVersion(tag);
    if (version === null || (version[3].length && !wantPre)) continue;
    if (compare(version, current) <= 0) continue;
    const assets = (Array.isArray(r.assets) ? r.assets : []).filter(isDict);
    const installer = pickAsset(assets, key, env, exists);
    const sums = assets.find((a) => a.name === SUMS_NAME && uploaded(a));
    if (!installer || !sums || !pyTruthy(installer.url) || !pyTruthy(sums.url)) continue;
    if (best === null || compare(version, bestParsed) > 0) {
      bestParsed = version;
      best = {
        version: tag.replace(/^v+/, ''),
        tag,
        prerelease: version[3].length > 0,
        page: pyStr(pyOr(r.html_url, '')),
        installer: { name: installer.name as string, url: installer.url as string, size: pyInt(pyOr(installer.size, 0)) },
        sums: { name: SUMS_NAME, url: sums.url as string },
      };
    }
  }
  return best;
}

const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const SUM_LINE = new RegExp(`^([A-Fa-f0-9]{64}) [ *]?([^\\n]+?)[${PY_WS}]*$`);

/** The one SHA-256 line for exactly this file name in a SHA256SUMS text. Zero or several: refused (code no_checksum). */
export function checksumFor(text: string, filename: string): string {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const m = SUM_LINE.exec(line.replace(/^\r+|\r+$/g, ''));
    if (m && m[2] === filename) found.push(m[1].toLowerCase());
  }
  if (found.length !== 1) {
    throw new UpdateError(`The release has no checksum (or an ambiguous one) for ${filename}, so it was not trusted.`, 'no_checksum');
  }
  return found[0];
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  using file = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(1 << 20);
  for (;;) {
    const n = await file.read(buffer);
    if (n === null) break;
    hash.update(buffer.subarray(0, n));
  }
  return hash.digest('hex');
}

// ---- network --------------------------------------------------------------------------------------------------------
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** [base, overridden]: the AIB_UPDATE_API_BASE override (read on every call, as Python reads os.environ) or GitHub's API. */
export function apiBase(): [string, boolean] {
  const override = (envGet(BASE_ENV) ?? '').trim().replace(/\/+$/, '');
  return [override || API_BASE, !!override];
}

function split(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new UpdateError('Unexpected update host.', 'bad_host');
  }
}

/** Refuse any hop that is not GitHub over https (or, in the test hook, the fake server's own scheme, host and port). */
export function checkUrl(url: string, base: [string, boolean] = apiBase()): void {
  const u = split(url);
  if (u.username || u.password) throw new UpdateError('Unexpected update host.', 'bad_host');
  if (base[1]) {
    const b = split(base[0]);
    if (u.protocol === b.protocol && u.hostname === b.hostname && u.port === b.port) return;
    throw new UpdateError('Unexpected update host.', 'bad_host');
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.port !== '') throw new UpdateError('Unexpected update host.', 'bad_host'); // '' = 443 or none
  if (host === 'api.github.com' || host === 'github.com' || host.endsWith('.githubusercontent.com')) return;
  throw new UpdateError('Unexpected update host.', 'bad_host');
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const offline = () => new UpdateError('Could not reach GitHub to check for updates.', 'offline');

/** GET with redirects followed by hand (every hop checked). Returns a 2xx response whose body the caller must read or cancel. */
export async function httpOpen(url: string, accept: string, fetchFn: FetchFn = fetch): Promise<Response> {
  for (let hop = 0; hop < 6; hop++) {
    checkUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.requestMs);
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { 'Accept': accept, 'User-Agent': 'AIB/' + APP_VERSION, 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw offline();
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 200 && response.status < 300) return response;
    const location = REDIRECTS.has(response.status) ? response.headers.get('Location') : null;
    await response.body?.cancel();
    if (!location) throw new UpdateError(`GitHub did not answer the update request (${response.status}). Try again later.`, 'http_error');
    try {
      url = new URL(location, url).href;
    } catch {
      throw new UpdateError('Unexpected update host.', 'bad_host');
    }
  }
  throw new UpdateError('Too many redirects.', 'http_error');
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(offline()), timeouts.requestMs))),
    ]);
  } catch (error) {
    throw error instanceof UpdateError ? error : offline();
  } finally {
    clearTimeout(timer);
  }
}

/** Each body chunk, with urllib's per-read timeout; the stream is cancelled when the loop stops early. */
async function* chunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await readChunk(reader);
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readLimited(url: string, accept: string, limit: number, fetchFn?: FetchFn): Promise<Uint8Array> {
  const response = await httpOpen(url, accept, fetchFn);
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks(response)) {
    parts.push(chunk);
    total += chunk.length;
    if (total > limit) throw new UpdateError('The update response was larger than expected.', 'too_big');
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) out.set(p, offset), offset += p.length;
  return out;
}

/** Stream an asset to dest (via a .part file); returns its SHA-256. Refuses a web page where a file should be. */
export async function downloadTo(url: string, dest: string, limit: number, fetchFn?: FetchFn): Promise<string> {
  const response = await httpOpen(url, 'application/octet-stream', fetchFn);
  const kind = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (kind === 'text/html' || kind === 'application/json') {
    await response.body?.cancel();
    throw new UpdateError('GitHub returned a page instead of the update file.', 'bad_download');
  }
  const part = dest + '.part';
  const hash = createHash('sha256');
  let total = 0;
  try {
    using out = await Deno.open(part, { write: true, create: true, truncate: true });
    for await (const block of chunks(response)) {
      total += block.length;
      if (total > limit) throw new UpdateError('The update file is larger than its limit.', 'too_big');
      hash.update(block);
      let written = 0;
      while (written < block.length) written += await out.write(block.subarray(written));
    }
  } catch (error) {
    await Deno.remove(part).catch(() => {});
    throw error;
  }
  await Deno.rename(part, dest);
  return hash.digest('hex');
}

// ---- paths (pathlib's spelling, so state.json paths match what Python writes) ---------------------------------------
const WINDOWS = Deno.build.os === 'windows';
const SEP = WINDOWS ? '\\' : '/';

function normPath(path: string): string {
  if (WINDOWS) {
    const unc = /^[\\/]{2}[^\\/]/.test(path);
    let p = path.replaceAll('/', '\\').replace(/\\{2,}/g, '\\');
    if (unc) p = '\\' + p;
    return p.length > 1 && p.endsWith('\\') && !/^[A-Za-z]:\\$/.test(p) && !/^\\$/.test(p) ? p.slice(0, -1) : p;
  }
  const p = path.replace(/\/{2,}/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

const join = (...parts: string[]) => normPath(parts.join(SEP));

/** str(pathlib.Path(path).parent) */
export function parentOf(path: string): string {
  const p = normPath(path);
  const i = p.lastIndexOf(SEP);
  if (i < 0) return WINDOWS && /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : '.';
  const head = p.slice(0, i);
  if (!head) return SEP;
  if (WINDOWS && /^[A-Za-z]:$/.test(head)) return head + SEP;
  return head;
}

function isFile(path: unknown): boolean {
  if (typeof path !== 'string' || !path) return false;
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * AIB_UPDATE_REPO when set; else the real repository for the desktop app and the placeholder (no checks, state 'unconfigured') for
 * `deno run`, so a dev or test server never calls GitHub and stays equal to the Python server in the contract tests.
 */
export function defaultRepo(desktop: boolean): string {
  const override = (envGet(REPO_ENV) ?? '').trim();
  return override || (desktop ? UPDATE_REPO : PLACEHOLDER_REPO);
}

// ---- the service ----------------------------------------------------------------------------------------------------
export interface Downloaded {
  version: string;
  name: string;
  path: string;
  sha256: string;
}

export interface UpdateState {
  lastCheck: number;
  found: Found | null;
  downloaded: Downloaded | null;
  error: string;
  code: string;
  installWhenIdle: boolean;
}

export interface UpdateServiceOptions {
  /** The Settings toggle (Settings > About > Automatically check for updates). */
  autoCheck?: () => boolean;
  /** How many chats are working; a throw (or rejection) counts as unknown, which defers the install. */
  busyChats?: () => number | Promise<number>;
  /** Ends this web server so the helper can run the installer. The route answers first; the caller defers the real shutdown. */
  quit?: (() => void) | null;
  /**
   * True when working chats survive this app quitting (they run in the separate agent host): "Install now" then goes ahead while
   * chats work, and the new version attaches to the running host. False (in-process mode): an install waits for the chats.
   */
  chatsKeepRunning?: boolean;
  /** The arguments this app was started with; the helper starts the new version with the same ones. Default: Deno.args. */
  appArgs?: string[];
  /** Starts the detached helper (update_helper.ts). Replaced in tests. */
  launcher?: (args: HelperArgs) => void | Promise<void>;
  current?: string;
  /** null or undefined: this machine (Python: key if key is not None else platform_key()). */
  key?: PlatformKey | null;
  env?: Env;
  /** Seconds since the epoch (time.time). */
  now?: () => number;
  repo?: string;
  fetch?: FetchFn;
  /** os.path.exists, for the dpkg check on Linux. */
  exists?: (path: string) => boolean;
  /** This app: inside a `deno desktop` binary, its pid and Deno.execPath(). Default: the running process. */
  app?: AppInfo;
}

export interface AppInfo {
  desktop: boolean;
  pid: number;
  exe: string;
}

/** The package kind each system updates in place from, by asset ending. */
const IN_PLACE_ENDING: Record<string, string> = { 'windows-zip': '.zip', 'macos-zip': '.zip', 'appimage': '.appimage' };

export interface UpdateStatus {
  current: string;
  autoCheck: boolean;
  configured: boolean;
  checking: boolean;
  lastCheck: number | null;
  error: string;
  errorCode: string;
  installWhenIdle: boolean;
  state: 'none' | 'refused' | 'ready' | 'found' | 'error' | 'unconfigured';
  platform: string[] | null;
  inPlace: boolean;
  available?: Record<string, unknown>;
  instructions?: string;
}

export type InstallResult = { state: 'installing'; chats?: number } | { state: 'waiting'; chats: number };

function emptyState(): UpdateState {
  return { lastCheck: 0, found: null, downloaded: null, error: '', code: '', installWhenIdle: false };
}

/** Owns the update state for one Studio web server (updater.UpdateService). */
export class UpdateService {
  readonly root: string;
  autoCheck: () => boolean;
  busyChats: () => number | Promise<number>;
  quit: (() => void) | null;
  launcher: (args: HelperArgs) => void | Promise<void>;
  readonly chatsKeepRunning: boolean;
  readonly appArgs: string[];
  readonly current: string;
  readonly env: Env;
  readonly key: PlatformKey | null;
  readonly now: () => number;
  readonly repo: string;
  readonly fetch: FetchFn;
  readonly exists: (path: string) => boolean;
  readonly app: AppInfo;
  state: UpdateState;
  #checking = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(stateDir: string, options: UpdateServiceOptions = {}) {
    this.root = join(stateDir, 'updates');
    this.autoCheck = options.autoCheck ?? (() => true);
    this.busyChats = options.busyChats ?? (() => 0);
    this.quit = options.quit ?? null;
    this.chatsKeepRunning = !!options.chatsKeepRunning;
    this.appArgs = [...(options.appArgs ?? Deno.args)];
    this.launcher = options.launcher ?? ((args) => this.#launchHelper(args));
    this.current = options.current ?? APP_VERSION;
    this.env = options.env ?? Deno.env.toObject();
    this.key = options.key ?? platformKey();
    this.now = options.now ?? (() => Date.now() / 1000);
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.exists = options.exists ?? pathExists;
    this.app = options.app ?? { desktop: isDesktopApp(), pid: Deno.pid, exe: Deno.execPath() };
    this.repo = options.repo || defaultRepo(this.app.desktop);
    this.state = this.#load();
  }

  get statePath(): string {
    return join(this.root, 'state.json');
  }

  // -- persistence
  #load(): UpdateState {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Deno.readFileSync(this.statePath));
      const data = JSON.parse(text);
      if (isDict(data)) {
        return {
          lastCheck: pyFloat(pyOr(data.lastCheck, 0)),
          found: isDict(data.found) ? data.found as unknown as Found : null,
          downloaded: isDict(data.downloaded) ? data.downloaded as unknown as Downloaded : null,
          error: pyStr(pyOr(data.error, '')),
          code: pyStr(pyOr(data.code, '')),
          installWhenIdle: pyTruthy(data.installWhenIdle),
        };
      }
    } catch { /* missing or unreadable: start empty (Python: OSError, ValueError) */ }
    return emptyState();
  }

  #save(): void {
    try {
      writeJsonAtomic(this.statePath, this.state, { prefix: 'state.json.', suffix: '.tmp' });
    } catch { /* Python: OSError is ignored */ }
  }

  // -- what the page shows
  configured(): boolean {
    return this.repo !== PLACEHOLDER_REPO || apiBase()[1];
  }

  /** What the helper would replace, or null: only the desktop app updates itself (Windows, macOS, an AppImage on Linux). */
  target(): InstallTarget | null {
    if (!this.key || !this.app.desktop) return null;
    return installTarget(this.key[0] === 'macos' ? 'darwin' : this.key[0], this.app.exe, this.env);
  }

  /**
   * True for the desktop app on Windows and macOS, and on Linux when it runs from an AppImage. False for a .deb install and for
   * `deno run`. When a file is already downloaded, it must be the in-place kind (a Linux AppImage run that only found a .deb: manual).
   */
  canInstallInPlace(): boolean {
    const t = this.target();
    if (!t) return false;
    const name = this.state.downloaded?.name;
    return !name || pyStr(name).toLowerCase().endsWith(IN_PLACE_ENDING[t.kind]);
  }

  #freshFound(): Found | null {
    const found = this.state.found;
    if (found && compare(found.version, this.current) <= 0) return null;
    return found;
  }

  instructions(path: string): string {
    const folder = parentOf(path);
    const lower = path.toLowerCase();
    if (lower.endsWith('.zip') && /macos/.test(lower)) {
      return `Unzip ${path}, drag AIB.app to Applications (replace the old one), then open it (right-click, Open, the first time).`;
    }
    if (lower.endsWith('.zip')) return `Quit AIB, unzip ${path} and copy its AIB folder over your AIB folder, then start AIB.`;
    if (lower.endsWith('.deb')) {
      return `Install it with: sudo apt install "${path}"  (or open the file in your software installer). Then start AIB again.`;
    }
    if (lower.endsWith('.appimage')) return `Replace your AIB AppImage with ${path}, make it executable (chmod +x), and start it.`;
    return `Run ${path} (it is in ${folder}).`;
  }

  status(): UpdateStatus {
    const found = this.#freshFound();
    const got = this.state.downloaded;
    const ready = !!(found && got && got.version === found.version && isFile(got.path ?? ''));
    const out: UpdateStatus = {
      current: this.current,
      autoCheck: !!this.autoCheck(),
      configured: this.configured(),
      checking: this.#checking,
      lastCheck: this.state.lastCheck || null,
      error: this.state.error,
      errorCode: this.state.code,
      installWhenIdle: !!this.state.installWhenIdle,
      state: 'none',
      platform: this.key ? [...this.key] : null,
      inPlace: this.canInstallInPlace(),
    };
    if (this.state.code === 'checksum_mismatch' || this.state.code === 'no_checksum') {
      out.state = 'refused';
    } else if (ready && found && got) {
      out.state = 'ready';
      out.available = {
        version: found.version,
        tag: found.tag,
        prerelease: 'prerelease' in found ? found.prerelease : false,
        page: found.page,
        name: got.name,
        path: got.path,
        sha256: got.sha256,
      };
      if (!out.inPlace) out.instructions = this.instructions(got.path);
    } else if (found) {
      out.state = 'found';
      out.available = {
        version: found.version,
        tag: found.tag,
        prerelease: 'prerelease' in found ? found.prerelease : false,
        page: found.page,
      };
    } else if (this.state.error) {
      out.state = 'error';
    } else if (!this.configured()) {
      out.state = 'unconfigured';
    }
    return out;
  }

  // -- checking
  due(): boolean {
    return this.now() - this.state.lastCheck >= CHECK_INTERVAL;
  }

  /**
   * Look for a newer release, download and verify its installer. Automatic checks stop (no network at all) when the setting is off,
   * the repository is still the placeholder, or a check already happened in the last day. A second call while one runs returns at
   * once (Python's non-blocking lock). Resolves to status().
   */
  async check(manual = false): Promise<UpdateStatus> {
    if (!this.configured()) return this.status();
    if (!manual && (!this.autoCheck() || !this.due())) return this.status();
    if (this.#checking) return this.status();
    this.#checking = true;
    try {
      this.state.lastCheck = this.now(); // the attempt counts: a failing network is not retried in a loop
      this.state.error = '';
      this.state.code = '';
      this.#save();
      try {
        const found = await this.#fetchRelease();
        this.state.found = found;
        this.#save();
        if (found) await this.#download(found);
      } catch (error) {
        if (!(error instanceof UpdateError)) throw error;
        this.state.error = error.message;
        this.state.code = error.code;
        this.#save();
      }
    } finally {
      this.#checking = false;
    }
    return this.status();
  }

  async #fetchRelease(): Promise<Found | null> {
    const url = `${apiBase()[0]}/repos/${this.repo}/releases?per_page=30`;
    const data = await readLimited(url, 'application/vnd.github+json', MAX_RELEASES_BYTES, this.fetch);
    let releases: unknown;
    try {
      releases = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
      throw new UpdateError('GitHub sent a release list that could not be read.', 'bad_response');
    }
    if (!this.key) throw new UpdateError('This computer is not a platform AIB has installers for.', 'unsupported_platform');
    return pickRelease(releases, this.current, this.key, this.env, this.exists);
  }

  async #download(found: Found): Promise<void> {
    const got = this.state.downloaded;
    if (got && got.version === found.version && isFile(got.path ?? '') && await fileSha256(got.path) === got.sha256) return;
    const folder = join(this.root, found.version);
    await Deno.mkdir(folder, { recursive: true });
    const name = found.installer.name;
    if (!NAME_OK.test(name)) throw new UpdateError('The release names its installer in an unexpected way.', 'bad_name');
    const sums = new TextDecoder().decode(await readLimited(found.sums.url, 'application/octet-stream', MAX_SUMS_BYTES, this.fetch));
    const want = checksumFor(sums, name);
    const dest = join(folder, name);
    const have = await downloadTo(found.installer.url, dest, MAX_INSTALLER_BYTES, this.fetch);
    if (have !== want) {
      await Deno.remove(dest).catch(() => {});
      throw new UpdateError(
        'The downloaded update did not match its published checksum, so it was refused and deleted. Nothing was installed.',
        'checksum_mismatch',
      );
    }
    this.state.downloaded = { version: found.version, name, path: dest, sha256: have };
    this.#save();
  }

  // -- installing
  /**
   * The person clicked Install now (or Install when chats finish). {state: 'installing'} when the helper is running and this server
   * is quitting, {state: 'waiting', chats} when it will install once no chat is working. Throws UpdateError.
   */
  async install(whenIdle = false): Promise<InstallResult> {
    const status = this.status();
    if (status.state !== 'ready') throw new UpdateError('There is no verified update to install.', 'not_ready');
    if (!status.inPlace) {
      throw new UpdateError(status.instructions || 'Install it from the downloaded file.', 'manual', { path: status.available!.path });
    }
    if (whenIdle) {
      this.state.installWhenIdle = true;
      this.#save();
    }
    const busy = await this.#busy();
    if (busy && !whenIdle && this.chatsKeepRunning) {
      // The chats run in the agent host, which outlives this app: the new version attaches to it, they keep streaming, and the old
      // host is replaced once none of them is working (host_proxy retireOlderHost).
      return { ...await this.#go(), chats: busy };
    }
    if (busy) {
      if (whenIdle) return { state: 'waiting', chats: busy };
      throw new UpdateError(`${busy} chat(s) are working. Install when they finish, or wait.`, 'chats_working', { chats: busy });
    }
    return await this.#go();
  }

  cancelWait(): UpdateStatus {
    this.state.installWhenIdle = false;
    this.#save();
    return this.status();
  }

  async #busy(): Promise<number> {
    try {
      return pyInt(pyOr(await this.busyChats(), 0));
    } catch {
      return 1; // unknown counts as busy: never install over a chat we cannot see
    }
  }

  async #go(): Promise<InstallResult> {
    const got = this.state.downloaded ?? ({} as Partial<Downloaded>);
    const path = got.path ?? '';
    if (!path || !isFile(path) || await fileSha256(path) !== got.sha256) {
      throw new UpdateError('The downloaded update changed or is missing; it was not run.', 'checksum_mismatch');
    }
    const target = this.target();
    if (!target) throw new UpdateError('This copy of AIB cannot update itself; install the downloaded file by hand.', 'manual', { path });
    this.state.installWhenIdle = false;
    this.#save();
    await this.launcher({
      installer: path,
      sha256: got.sha256!,
      pid: this.app.pid,
      exe: this.app.exe,
      log: join(this.root, 'install.log'),
      version: got.version!,
      kind: target.kind,
      target: target.target,
      args: this.appArgs,
    });
    if (this.quit) this.quit();
    return { state: 'installing' };
  }

  /**
   * Start the helper detached (it outlives this app), hidden, with a clean environment, from the temp folder. Desktop app:
   * `<this binary> update-helper <json>`, except on Linux, where the new (verified) AppImage runs it so the old AppImage's mount can
   * go away. Dev: `deno run update_helper.ts <json>`.
   */
  async #launchHelper(args: HelperArgs): Promise<void> {
    let program: string[];
    if (this.app.desktop && args.kind === 'appimage') {
      await Deno.chmod(args.installer, 0o755);
      program = [args.installer, 'update-helper'];
    } else if (this.app.desktop) {
      program = [this.app.exe, 'update-helper'];
    } else {
      const helper = decodeURIComponent(new URL('./update_helper.ts', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
      program = [Deno.execPath(), 'run', '-A', '--no-config', helper];
    }
    const temp = envGet('TMPDIR') || envGet('TEMP') || envGet('TMP') || (WINDOWS ? 'C:\\Temp' : '/tmp');
    const child = await spawnDetached(
      [...program, JSON.stringify(args)],
      join(this.root, 'helper-output.log'),
      temp,
      cleanEnv(Deno.env.toObject()),
    );
    child.close();
  }

  // -- the background loop (not started by tests)
  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    const schedule = (seconds: number) => {
      if (this.#stopped) return;
      const timer = setTimeout(async () => {
        try {
          await this.tick();
        } catch { /* a failed tick must never end the loop */ }
        schedule(TICK_SECONDS);
      }, seconds * 1000);
      this.#timer = timer;
      Deno.unrefTimer(timer);
    };
    schedule(FIRST_CHECK_DELAY);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
  }

  /** One pass: an automatic check when one is due, and the install the person asked to wait for once no chat is working. */
  async tick(): Promise<void> {
    await this.check(false);
    if (this.state.installWhenIdle && this.status().state === 'ready' && !await this.#busy()) await this.#go();
  }
}

// ---- the web routes' contract (web_handler.get_update, post_update_check, post_update_install) ----------------------
export type RouteReply = [number, Record<string, unknown>];

/** GET /api/live/update */
export function getUpdate(service: UpdateService): RouteReply {
  return [200, { ...service.status() }];
}

/** POST /api/live/update/check: start a manual check in the background (a download can outlast a request); the page polls GET. */
export function postUpdateCheck(service: UpdateService, _body: Record<string, unknown> = {}): RouteReply {
  service.check(true).catch(() => {});
  return [200, { ...service.status(), checking: true }];
}

const INSTALL_STATUS: Record<string, number> = { chats_working: 409, not_ready: 409, manual: 400 };

/**
 * POST /api/live/update/install: install now or, with whenIdle, once no chat is working; cancelWait drops the second. Throws
 * ValueError (the HTTP layer's 400) for a whenIdle that is not a boolean, as Python does. The route must send the reply before the
 * service's quit callback ends the server.
 */
export async function postUpdateInstall(service: UpdateService, body: Record<string, unknown>): Promise<RouteReply> {
  if (body.cancelWait === true) return [200, { ...service.cancelWait() }];
  const whenIdle = 'whenIdle' in body ? body.whenIdle : false;
  if (typeof whenIdle !== 'boolean') throw new ValueError('whenIdle must be true or false');
  try {
    return [200, { ...await service.install(whenIdle), ok: true }];
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    return [INSTALL_STATUS[error.code] ?? 500, { error: error.message, code: error.code, ...error.extra }];
  }
}
