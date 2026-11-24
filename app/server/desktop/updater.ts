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
 *     when it runs from an AppImage: update_helper.ts swaps the files after the app quits. Any `deno run` gets the verified file and
 *     instructions.
 *   - A .deb install (/usr/lib/aib/aib, owned by dpkg) updates itself the electron-updater DebUpdater way, but only from a click on
 *     Install now in AIB's window on the PC: AIB answers the click at once ({state: 'authorizing'}), and while AIB is still open
 *     `/usr/bin/pkexec /usr/lib/aib/aib-install-deb <the verified .deb> <its version>` (a root script the .deb ships, with the polkit action
 *     "Authentication is required to update AIB"; tools/linux/) asks for the system password. The window says "AIB is asking for
 *     your system password to install the update" meanwhile (status().authorizing). The root script trusts nothing on the user's
 *     side: it reads its own copy of the file, fetches the release's SHA256SUMS from GitHub itself and checks the copy against it,
 *     refuses anything not newer than the installed aib, and runs apt. Then AIB checks the chats again and quits (or, when a chat
 *     it cannot hand over started meanwhile, restarts once they finish), and the helper starts the new version. "Install when chats
 *     finish" and the phone never open the prompt: they leave the update waiting for a click on the PC (status().askOnPc). No
 *     pkexec, no polkit agent (SSH), a closed password prompt or a refused file: nothing is installed, AIB stays open and shows why
 *     (status().installError) with the manual line. The .deb Version is AIB's with every "-" a "~" (`deno desktop`); dpkg orders a
 *     release below its own test builds (0.13.2~beta.1.test.2 > 0.13.2~beta.1), where AIB orders it above: the root script allows
 *     exactly that step as a downgrade. A test build from the local feed has no GitHub release, so the root script refuses it.
 *   - Test builds (0.1.0-beta.12.test.3) also read a local feed folder (%LOCALAPPDATA%\AIB-test-feed, filled by `tools/build.ts
 *     --feed`) every FEED_INTERVAL and on window focus, and take the newest of GitHub and the feed. Same rules: a SHA256SUMS match
 *     (the feed's own), the click, the helper. Version order puts X.test.M below X, so the real release replaces its test builds.
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
export { DEB_EXE } from './update_helper.ts';
import { PROTOCOL_VERSION } from '../host/host_client.ts';
import { missingFeatures } from '../keeper/client.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('updates');

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
/**
 * Test hook, honoured only together with BASE_ENV (a fake release server): the version the updater takes this app to be, so an e2e
 * test can download "the next version" with a source run and then start again as that version (the release-notes tab).
 */
export const CURRENT_ENV = 'AIB_UPDATE_CURRENT';
/**
 * The local test channel: a test build (a version whose pre-release has a "test" identifier, 0.1.0-beta.12.test.3) also reads this
 * folder, which `deno run -A tools/build.ts --feed` fills: one sub-folder per version holding the Windows zip, SHA256SUMS,
 * release.json and notes.md. Release builds never look at it. AIB_TEST_FEED_DIR moves it (honoured only for test builds; tests).
 */
export const FEED_ENV = 'AIB_TEST_FEED_DIR';
export const FEED_DIR_NAME = 'AIB-test-feed';
export const FEED_NOTES = 'notes.md';
/** How often a test build reads its local feed (a folder listing, no network); also on window focus (the page asks). */
export const FEED_INTERVAL = 120;
/** The release notes kept with a downloaded update (<data>/updates/release-notes.json): how many releases, how long each. */
export const NOTES_FILE = 'release-notes.json';
export const MAX_NOTES_RELEASES = 20;
export const MAX_NOTES_CHARS = 32 * 1024;
export const CHECK_INTERVAL = 24 * 3600;
/** A test build, or a release build with "Get test builds" on, asks GitHub this often (a new test pre-release shows up within the hour). */
export const TEST_CHECK_INTERVAL = 3600;
/** In that mode, window focus also asks GitHub, at most this often (GitHub allows 60 unauthenticated requests an hour). */
export const FOCUS_CHECK_INTERVAL = 15 * 60;
/** An automatic check that failed for a passing reason (no network, GitHub busy) is tried again after this, not a day later. */
export const RETRY_INTERVAL = 3600;
/** The error codes RETRY_INTERVAL applies to; a refusal (checksum, bad name, unsupported platform) waits the full day. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(['offline', 'http_error', 'bad_response', 'bad_download']);
export const MAX_SUMS_BYTES = 64 * 1024;
/** The release's small description asset ({version, protocol}), checked against SHA256SUMS like the installer. */
export const RELEASE_INFO_NAME = 'release.json';
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

/** The pre-release identifier that marks a test build: X.test.M is a test of X. */
export const TEST_WORD = 'test';

/** [the version a test build is a test of, the identifiers after "test"] or [the pre-release, null] for any other version. */
function splitTest(pre: string[]): [string[], string[] | null] {
  const i = pre.indexOf(TEST_WORD);
  return i < 0 ? [pre, null] : [pre.slice(0, i), pre.slice(i + 1)];
}

/**
 * Semantic-version order: -1, 0 or 1 (a pre-release is older than its release; numbers sort below words). One exception: a test
 * build X.test.M (0.1.0-beta.12.test.3) is older than X itself (0.1.0-beta.12, which plain semver would put first) and newer than
 * X.test.M-1 and everything before X, so a real release replaces the test builds made on the way to it.
 */
export function compare(a: string | Version | null, b: string | Version | null): number {
  const pa = typeof a === 'string' ? parseVersion(a) : a;
  const pb = typeof b === 'string' ? parseVersion(b) : b;
  if (!Array.isArray(pa) || !Array.isArray(pb)) throw new ValueError('not a version');
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return cmp(pa[i] as number, pb[i] as number);
  const [ba, ta] = splitTest(pa[3]);
  const [bb, tb] = splitTest(pb[3]);
  if (ta === null && tb === null) return comparePre(pa[3], pb[3]);
  const base = comparePre(ba, bb);
  if (base !== 0) return base;
  if (ta === null) return 1; // X is newer than X.test.M
  if (tb === null) return -1;
  return identifiers(ta, tb);
}

/** Pre-release order: none (the release) is newest, then identifier by identifier. */
function comparePre(xa: string[], xb: string[]): number {
  if (!xa.length && !xb.length) return 0;
  if (!xa.length) return 1;
  if (!xb.length) return -1;
  return identifiers(xa, xb);
}

function identifiers(xa: string[], xb: string[]): number {
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

/** One release's notes for the "What's new" tab: its version, publish date (ISO, '' when unknown), page and Markdown body. */
export interface ReleaseNote {
  version: string;
  date: string;
  page: string;
  body: string;
}

/** <data>/updates/release-notes.json: the notes of `version` and the releases before it, newest first; shown once that version runs. */
export interface ReleaseNotes {
  version: string;
  releases: ReleaseNote[];
  shown: boolean;
}

/**
 * The notes the "What's new in AIB <version>" tab shows: `version` and the releases before it (no drafts; pre-releases only when
 * `withPre`), newest first, at most MAX_NOTES_RELEASES, each body cut at MAX_NOTES_CHARS. Releases with an empty body are left out.
 */
export function releaseNotes(releases: unknown, version: string, withPre: boolean): ReleaseNote[] {
  const out: [Version, ReleaseNote][] = [];
  const top = parseVersion(version);
  if (!top) return [];
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!isDict(r) || pyTruthy(r.draft)) continue;
    const tag = pyStr(pyOr(r.tag_name, ''));
    const parsed = parseVersion(tag);
    if (!parsed || (parsed[3].length && !withPre) || compare(parsed, top) > 0) continue;
    const body = typeof r.body === 'string' ? r.body.replace(/\r\n?/g, '\n').trim() : '';
    if (!body) continue;
    const date = typeof r.published_at === 'string' ? r.published_at : typeof r.created_at === 'string' ? r.created_at : '';
    out.push([parsed, {
      version: tag.replace(/^v+/, ''),
      date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 40) : '',
      page: typeof r.html_url === 'string' ? r.html_url.slice(0, 500) : '',
      body: body.length > MAX_NOTES_CHARS ? body.slice(0, MAX_NOTES_CHARS) + '\n\n…' : body,
    }]);
  }
  out.sort((a, b) => compare(b[0], a[0]));
  const seen = new Set<string>();
  return out.filter(([, n]) => !seen.has(n.version) && !!seen.add(n.version)).slice(0, MAX_NOTES_RELEASES).map(([, n]) => n);
}

export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version);
  return !!(parsed && parsed[3].length);
}

/** A test build: its pre-release has a "test" identifier (0.1.0-beta.12.test.3). Only these read the local test feed. */
export function isTestBuild(version: string): boolean {
  const parsed = parseVersion(version);
  return !!(parsed && parsed[3].includes(TEST_WORD));
}

/** Notes from several sources (GitHub, the test feed) for one tab: newest first, one per version (the first source wins), bounded. */
export function mergeNotes(...lists: ReleaseNote[][]): ReleaseNote[] {
  const seen = new Set<string>();
  const all: [Version, ReleaseNote][] = [];
  for (const n of lists.flat()) {
    const v = parseVersion(n.version);
    if (v && !seen.has(n.version)) seen.add(n.version), all.push([v, n]);
  }
  return all.sort((a, b) => compare(b[0], a[0])).slice(0, MAX_NOTES_RELEASES).map(([, n]) => n);
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
  /** release.json (tools/build.ts): {version, protocol}; present in releases built from beta.2 on. */
  info?: { name: string; url: string };
  /** From the local test feed: the urls are file paths in the feed folder (read, never fetched). */
  feed?: boolean;
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
      const info = assets.find((a) => a.name === RELEASE_INFO_NAME && uploaded(a) && pyTruthy(a.url));
      if (info) best.info = { name: RELEASE_INFO_NAME, url: info.url as string };
    }
  }
  return best;
}

// ---- the local test feed ----------------------------------------------------------------------------------------------
/** Where a test build looks for its feed: AIB_TEST_FEED_DIR, else %LOCALAPPDATA%\AIB-test-feed (~/.local/share elsewhere). */
export function feedDir(env: Env): string {
  const override = (env[FEED_ENV] ?? '').trim();
  if (override) return override;
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, FEED_DIR_NAME);
  return env.HOME ? join(env.HOME, '.local', 'share', FEED_DIR_NAME) : '';
}

function readSmallText(path: string, limit: number): string {
  try {
    if (Deno.statSync(path).size > limit) return '';
    return new TextDecoder().decode(Deno.readFileSync(path));
  } catch {
    return '';
  }
}

/**
 * The feed folder as a GitHub-like release list: each sub-folder named as a version is one release, its files are the assets (url =
 * the file's path), notes.md is the body, release.json's `date` the publish date. Unreadable folders are skipped.
 */
export function feedReleases(dir: string): Dict[] {
  const out: Dict[] = [];
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory || e.isSymlink || !NAME_OK.test(e.name) || !parseVersion(e.name)) continue;
    const folder = join(dir, e.name);
    const assets: Dict[] = [];
    try {
      for (const f of Deno.readDirSync(folder)) {
        if (!f.isFile || !NAME_OK.test(f.name)) continue;
        const path = join(folder, f.name);
        assets.push({ name: f.name, state: 'uploaded', url: path, size: Deno.statSync(path).size });
      }
    } catch {
      continue;
    }
    let date = '';
    try {
      const info = JSON.parse(readSmallText(join(folder, RELEASE_INFO_NAME), MAX_SUMS_BYTES) || '{}');
      if (isDict(info) && typeof info.date === 'string') date = info.date;
    } catch { /* no date */ }
    out.push({
      tag_name: e.name,
      draft: false,
      html_url: '',
      published_at: date,
      body: readSmallText(join(folder, FEED_NOTES), MAX_NOTES_CHARS * 2),
      assets,
    });
  }
  return out;
}

/** The newest feed version for this platform above `current` (marked feed: true) and the feed's notes up to it. */
export function pickFeed(
  dir: string,
  current: string,
  key: PlatformKey | null,
  env?: Env,
  exists?: (p: string) => boolean,
): { found: Found | null; notes: ReleaseNote[] } {
  const releases = feedReleases(dir);
  const found = pickRelease(releases, current, key, env, exists);
  if (!found) return { found: null, notes: [] };
  found.feed = true;
  return { found, notes: releaseNotes(releases, found.version, true) };
}

/** A feed file read whole, refused over `limit`. */
async function readFeedFile(path: string, limit: number): Promise<Uint8Array> {
  try {
    if ((await Deno.stat(path)).size > limit) throw new UpdateError('The update file is larger than its limit.', 'too_big');
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError('The local test feed could not be read.', 'bad_download');
  }
}

/** Copy a feed file to dest (via a .part file), as downloadTo does; returns its SHA-256. */
async function copyFeedFile(src: string, dest: string, limit: number): Promise<string> {
  const part = dest + '.part';
  const hash = createHash('sha256');
  let total = 0;
  try {
    using input = await Deno.open(src, { read: true });
    using out = await Deno.open(part, { write: true, create: true, truncate: true });
    const buffer = new Uint8Array(1 << 20);
    for (;;) {
      const n = await input.read(buffer);
      if (n === null) break;
      total += n;
      if (total > limit) throw new UpdateError('The update file is larger than its limit.', 'too_big');
      const block = buffer.subarray(0, n);
      hash.update(block);
      let written = 0;
      while (written < block.length) written += await out.write(block.subarray(written));
    }
  } catch (error) {
    await Deno.remove(part).catch(() => {});
    if (error instanceof UpdateError) throw error;
    throw new UpdateError('The local test feed could not be read.', 'bad_download');
  }
  await Deno.rename(part, dest);
  return hash.digest('hex');
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

/** <data>/updates/started-<version>.ok: the new app writes it once it is up; the update helper waits for it (update_helper.ts). */
export function startedMarker(updatesDir: string, version: string): string {
  return join(updatesDir, `started-${version}.ok`);
}

export function bytesSha256(data: Uint8Array): Promise<string> {
  return Promise.resolve(createHash('sha256').update(data).digest('hex'));
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

/**
 * Linux and macOS: the file, its version folder and the updates folder end up writable by their owner alone. They take the process's
 * umask, and the common one (002, Ubuntu's own) makes them group-writable; the .deb installer (tools/linux/aib-install-deb.sh) runs as
 * root and refuses any of the three that others can write ("can be written by others"). Windows has no such modes.
 */
export function closeToOthers(root: string, folder: string, file: string): void {
  if (WINDOWS) return;
  Deno.chmodSync(root, 0o755);
  Deno.chmodSync(folder, 0o755);
  Deno.chmodSync(file, 0o644);
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

/** A folder name under <data>/updates that a version download made (0.1.0, 0.1.0-beta.3, ...). */
const VERSION_DIR = /^v?\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/;

function isEmptyDir(path: string): boolean {
  try {
    for (const _ of Deno.readDirSync(path)) return false;
    return true;
  } catch {
    return false;
  }
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => (WINDOWS ? p.replaceAll('/', '\\').toLowerCase() : p).replace(/[\\/]+$/, '');
  return norm(a) === norm(b);
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
  /** The agent-host protocol of that version (from its release.json), when the release said. */
  hostProtocol?: number;
  /**
   * What that version needs of a running keeper to take chats over from it (release.json `keeper`: the keeper protocols it speaks
   * and the keeper features it needs). Absent: a version that cannot take chats over from a keeper.
   */
  keeper?: { protocols: number[]; needs: string[] };
}

/** The keeper this app's chats run in, as Install now needs to know it (UpdateServiceOptions.keeper). */
export interface KeeperState {
  /** '' when every working chat runs in this keeper and this app is connected to it; otherwise why not. */
  reason: string;
  /** The keeper's protocol and hello features (what the new version's release.json is checked against). */
  protocol: number;
  features: string[];
  version: string;
  /** The data folder whose keeper it is: the update helper stays connected to it while the files are swapped. */
  dataDir: string;
}

export interface UpdateState {
  lastCheck: number;
  found: Found | null;
  downloaded: Downloaded | null;
  error: string;
  code: string;
  installWhenIdle: boolean;
  /** The last version the "update ready" desktop notification went out for (one per version; '' none yet). */
  notified: string;
}

export interface UpdateServiceOptions {
  /** The Settings toggle (Settings > About > Automatically check for updates). */
  autoCheck?: () => boolean;
  /** How many chats are working; a throw (or rejection) counts as unknown, which defers the install. */
  busyChats?: () => number | Promise<number>;
  /**
   * Ends this web server so the helper can run the installer. The route answers first; the caller defers the real shutdown. `release`
   * true: the chats run in the keeper and the new version takes them over, so this app leaves them running (Aib.release) instead
   * of stopping them.
   */
  quit?: ((release?: boolean) => void) | null;
  /**
   * The keeper the chats run in (one AIB process with the keeper), or null/undefined when there is none. With it, Install now goes
   * ahead while chats work when the new version can take them over from this keeper (its release.json `keeper`), and the app
   * releases them instead of stopping them. A throw counts as "no".
   */
  keeper?: (() => Promise<KeeperState | null>) | null;
  /**
   * True when working chats survive this app quitting (they run in the separate agent host): "Install now" then goes ahead while
   * chats work, and the new version attaches to the running host. False (in-process mode): an install waits for the chats.
   */
  chatsKeepRunning?: boolean;
  /**
   * True while the person has quit AIB and it only stays in the tray for work still going on (DesktopApp.background): the install
   * they asked to wait for ("Install when chats finish") is held, so an update never opens a window after a quit; it stays
   * pending (state.json) and goes ahead at the next launch, or as soon as the window is opened again.
   */
  holdInstall?: () => boolean;
  /** The arguments this app was started with; the helper starts the new version with the same ones. Default: Deno.args. */
  appArgs?: string[];
  /**
   * An update became ready (downloaded and verified): called once per version, from the background check, also while the window is
   * closed to the tray. main.ts sends the desktop notification from here when the person's "Desktop notifications" setting is on.
   */
  onReady?: ((version: string) => void | Promise<void>) | null;
  /** Starts the detached helper (update_helper.ts). Replaced in tests. */
  launcher?: (args: HelperArgs) => void | Promise<void>;
  /** A .deb install: runs `pkexec <argv>` (the root script that installs the verified .deb). Default runPkexec; replaced in tests. */
  privileged?: PrivilegedRun;
  /** A .deb install: does dpkg own /usr/lib/aib/aib (default: /var/lib/dpkg/info/aib.list lists it)? Replaced in tests. */
  dpkgOwns?: (path: string) => boolean;
  /** A .deb install: the pkexec arguments for a downloaded file and the home folder, or null (default debInstallArgs). Tests. */
  debArgs?: (path: string, home: string, version: string) => string[] | null;
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
  /** The local test feed folder (test builds only; ignored otherwise). Default: feedDir(env). */
  feedDir?: string;
  /** The Settings switch "Get test builds" (off by default): a release build then also reads the local test feed. */
  getTestBuilds?: () => boolean;
}

export interface AppInfo {
  desktop: boolean;
  pid: number;
  exe: string;
}

/** The package kind each system updates in place from, by asset ending. */
const IN_PLACE_ENDING: Record<string, string> = { 'windows-zip': '.zip', 'macos-zip': '.zip', 'appimage': '.appimage', 'deb': '.deb' };

// ---- a .deb install: pkexec + the root script the .deb ships (tools/linux/aib-install-deb.sh) ---------------------------------
/** The root script that installs a verified .deb (polkit action dev.aib.app.update). */
export const DEB_INSTALLER = '/usr/lib/aib/aib-install-deb';
/** A version as aib-install-deb accepts it in a folder and file name. */
const DEB_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * The pkexec arguments for installing `path`, or null when aib-install-deb would refuse it anyway (so no password is asked for):
 * the same rules as the script: an absolute, plain path (letters, digits, . _ / + -; no //, /./ or /../) inside `home`, ending in
 * updates/<version>/AIB-<version>-linux-<x64|arm64>.deb, where <version> is `version`, the one the window offered (passed on: root
 * refuses a file, a folder or a package of any other version). (Ownership, links and the package's own name the script checks.)
 */
export function debInstallArgs(path: string, home: string, version: string): string[] | null {
  const h = (home ?? '').replace(/\/+$/, '');
  if (!h.startsWith('/') || !/^\/[A-Za-z0-9._/+-]+$/.test(path) || /\/\/|\/\.\.?(\/|$)/.test(path)) return null;
  if (!path.startsWith(h + '/')) return null;
  const m = /\/updates\/([^/]+)\/AIB-([^/]+)-linux-(?:x64|arm64)\.deb$/.exec(path);
  if (!m || m[1] !== m[2] || !DEB_VERSION.test(m[1]) || m[1] !== version) return null;
  return [DEB_INSTALLER, path, version];
}

/** What running pkexec gave: its exit code and error output, or null when pkexec could not be started (not installed). */
export type PrivilegedResult = { code: number; stderr: string } | null;
/** Runs `pkexec <argv>` and waits (the password prompt is the system's). Replaced in tests. */
export type PrivilegedRun = (argv: string[]) => Promise<PrivilegedResult>;

/**
 * Why a .deb install did not happen, for the person. 'partial': apt unpacked the new version and then failed (the new files are on
 * disk, half set up): the message says how to finish it, and no manual line follows. Every other reason: nothing was installed, and
 * the manual line with the file's path follows the message.
 */
export type DebOutcome =
  | { ok: true }
  | {
    ok: false;
    reason: 'no_pkexec' | 'cancelled' | 'no_agent' | 'not_allowed' | 'refused' | 'unverified' | 'failed' | 'partial';
    message: string;
  };

/**
 * pkexec's answer as an outcome. pkexec exits 126 when the password prompt was dismissed and 127 when it could not authorize (no
 * polkit agent: "No authentication agent found"; or the account may not); otherwise the script's code (tools/linux/
 * aib-install-deb.sh): 0 installed; 64-66, 69, 73 refused (nothing ran: not AIB's download, not the release's file, not newer);
 * 68 and 74 the release's SHA256SUMS could not be fetched (74: the test-only source file is not root's); 70 apt failed and dpkg
 * left the old version; 71 unexpected version after apt; 72 apt failed after unpacking (partly installed; also on a retry, when the
 * same version is still half set up); 75 a tool the script needs is missing (setpriv, or both curl and wget).
 */
export function debOutcome(result: PrivilegedResult): DebOutcome {
  if (result === null) {
    return { ok: false, reason: 'no_pkexec', message: 'AIB could not ask for your password to update itself (pkexec is not installed).' };
  }
  if (result.code === 0) return { ok: true };
  const lines = result.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const own = lines.filter((l) => l.startsWith('aib-install-deb:')).pop();
  const detail = (own ?? lines.pop() ?? '').replace(/^aib-install-deb:\s*/, '').slice(0, 200);
  const why = detail ? ` (${detail})` : '';
  if (result.code === 126) return { ok: false, reason: 'cancelled', message: 'The password prompt was closed, so nothing was installed.' };
  if (result.code === 127 && /authentication agent/i.test(result.stderr)) {
    return {
      ok: false,
      reason: 'no_agent',
      message: 'AIB could not ask for your password here (no password prompt runs, as over SSH), so nothing was installed.',
    };
  }
  if (result.code === 127) {
    return { ok: false, reason: 'not_allowed', message: `Your account could not authorize the update${why}, so nothing was installed.` };
  }
  if ((result.code >= 64 && result.code <= 66) || result.code === 69 || result.code === 73) {
    return { ok: false, reason: 'refused', message: `AIB's installer refused the downloaded file${why}, so nothing was installed.` };
  }
  if (result.code === 68 || result.code === 74) {
    return {
      ok: false,
      reason: 'unverified',
      message: `AIB's installer could not get the release's checksums from GitHub to check the file${why}, so nothing was installed.`,
    };
  }
  if (result.code === 75) {
    return { ok: false, reason: 'failed', message: `AIB's installer needs a system tool that is not installed${why}.` };
  }
  if (result.code === 70) {
    return { ok: false, reason: 'failed', message: `apt could not install the update${why}; the installed AIB is unchanged.` };
  }
  if (result.code === 72) {
    return {
      ok: false,
      reason: 'partial',
      message: "The update is only partly installed: apt put the new version's files on disk, then setting them up failed" +
        `${why}. AIB keeps running for now. To finish, open a terminal and run: sudo dpkg --configure -a  then restart AIB.`,
    };
  }
  return { ok: false, reason: 'failed', message: `The update did not install${why}.` };
}

/**
 * Where pkexec may be, in order: fixed system paths only, never a search of PATH (a program on PATH could draw its own password
 * prompt and keep the password).
 */
export const PKEXEC_PATHS: readonly string[] = ['/usr/bin/pkexec', '/bin/pkexec'];

/** The first of `paths` that is a file, or null. `stat` is replaced in tests. */
export function findPkexec(
  paths: readonly string[] = PKEXEC_PATHS,
  stat: (path: string) => { isFile: boolean } = (p) => Deno.statSync(p),
): string | null {
  for (const p of paths) {
    if (!p.startsWith('/')) continue;
    try {
      if (stat(p).isFile) return p;
    } catch { /* not there */ }
  }
  return null;
}

/** pkexec by its absolute path (PKEXEC_PATHS; tests pass others), no input, its error output kept. Never throws. */
export async function runPkexec(argv: string[], paths: readonly string[] = PKEXEC_PATHS): Promise<PrivilegedResult> {
  const pkexec = findPkexec(paths);
  if (!pkexec) return null;
  try {
    const out = await new Deno.Command(pkexec, { args: argv, stdin: 'null', stdout: 'null', stderr: 'piped' }).output();
    return { code: out.code, stderr: new TextDecoder().decode(out.stderr).slice(-4000) };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    return { code: 127, stderr: error instanceof Error ? error.message : String(error) };
  }
}

export interface UpdateStatus {
  current: string;
  autoCheck: boolean;
  configured: boolean;
  checking: boolean;
  lastCheck: number | null;
  error: string;
  errorCode: string;
  /** Deno only: when the next automatic check is due after a passing failure (RETRY_INTERVAL), else null. */
  retryAt: number | null;
  /** Deno only: this is the desktop app (false: a source run, which never updates itself). */
  desktop: boolean;
  installWhenIdle: boolean;
  state: 'none' | 'refused' | 'ready' | 'found' | 'error' | 'unconfigured';
  platform: string[] | null;
  inPlace: boolean;
  available?: Record<string, unknown>;
  instructions?: string;
  /** Present (true) only on a test build: it also reads the local test feed (the page asks again on window focus). */
  feed?: boolean;
  // The .deb install's own fields, present only there (a click on Install now on the PC asks for the system password):
  /** Installing asks for the system password on the PC. */
  password?: boolean;
  /** AIB is asking for the system password now (or apt runs): the window says so. */
  authorizing?: boolean;
  /** "Install when chats finish" or a remote device asked for the install: it waits for a click on Install now on the PC. */
  askOnPc?: boolean;
  /** The new version is installed; AIB restarts on it once no chat is working (a chat it cannot hand over started meanwhile). */
  restarting?: boolean;
  /** Why the last Install now did not install (with what to do), '' when it did or none ran. */
  installError?: string;
}

/** 'authorizing': a .deb install asks for the system password now; the outcome comes through status(). */
export type InstallResult =
  | { state: 'installing'; chats?: number }
  | { state: 'waiting'; chats: number }
  | { state: 'authorizing'; chats?: number };

function emptyState(): UpdateState {
  return { lastCheck: 0, found: null, downloaded: null, error: '', code: '', installWhenIdle: false, notified: '' };
}

/** Owns the update state for one AIB web server (updater.UpdateService). */
export class UpdateService {
  readonly root: string;
  autoCheck: () => boolean;
  busyChats: () => number | Promise<number>;
  quit: ((release?: boolean) => void) | null;
  launcher: (args: HelperArgs) => void | Promise<void>;
  privileged: PrivilegedRun;
  readonly dpkgOwns: ((path: string) => boolean) | undefined;
  readonly debArgs: (path: string, home: string, version: string) => string[] | null;
  /** A .deb install is asking for the password (or apt runs): a second Install now waits for it. */
  #debInstalling = false;
  /** The background password step of a .deb install (tests wait for it with debSettled()). */
  #debRun: Promise<void> | null = null;
  /** A .deb install was asked for where no password prompt may open (Install when chats finish, a remote device). */
  #askOnPc = false;
  /** Why the last .deb install did not happen ('' none). */
  #debError = '';
  readonly chatsKeepRunning: boolean;
  readonly keeper: (() => Promise<KeeperState | null>) | null;
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
  readonly holdInstall: () => boolean;
  onReady: ((version: string) => void | Promise<void>) | null;
  /** The local test feed this test build reads; '' for every other version (a release build never looks at it). */
  get feedDir(): string {
    return isTestBuild(this.current) || this.getTestBuilds() ? this.#feedBase : '';
  }
  #feedBase: string;
  /** The Settings switch "Get test builds": a release build also reads the local test feed while it is on. */
  getTestBuilds: () => boolean;
  /** When the feed was last read (seconds), and what it offered at the last try (version + its SHA256SUMS): an unchanged feed is not copied again. */
  #feedAt = 0;
  #feedTried = '';
  /** The notes of the release list the last check read, for the version it found (written with the download). */
  #notes: ReleaseNote[] = [];
  #checking = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(stateDir: string, options: UpdateServiceOptions = {}) {
    this.root = join(stateDir, 'updates');
    this.autoCheck = options.autoCheck ?? (() => true);
    this.busyChats = options.busyChats ?? (() => 0);
    this.quit = options.quit ?? null;
    this.chatsKeepRunning = !!options.chatsKeepRunning;
    this.keeper = options.keeper ?? null;
    this.holdInstall = options.holdInstall ?? (() => false);
    // A tray-only start (the keeper's orphan restart) is not how the person runs AIB: the new version opens its window again.
    this.appArgs = [...(options.appArgs ?? Deno.args)].filter((a) => a !== '--start-in-tray');
    this.launcher = options.launcher ?? ((args) => this.#launchHelper(args));
    this.privileged = options.privileged ?? runPkexec;
    this.dpkgOwns = options.dpkgOwns;
    this.debArgs = options.debArgs ?? debInstallArgs;
    this.onReady = options.onReady ?? null;
    // AIB_UPDATE_CURRENT: only with a test source (the fake release server, or a test feed folder)
    const testCurrent = apiBase()[1] || (envGet(FEED_ENV) ?? '').trim() ? (envGet(CURRENT_ENV) ?? '').trim() : '';
    this.current = options.current ?? (parseVersion(testCurrent) ? testCurrent : APP_VERSION);
    this.env = options.env ?? Deno.env.toObject();
    this.#feedBase = options.feedDir ?? feedDir(this.env);
    this.getTestBuilds = options.getTestBuilds ?? (() => false);
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
          notified: typeof data.notified === 'string' ? data.notified : '',
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
    return this.#github() || !!this.feedDir;
  }

  /** GitHub (or the fake release server) is asked: not for the placeholder repository. */
  #github(): boolean {
    return this.repo !== PLACEHOLDER_REPO || apiBase()[1];
  }

  /**
   * What the helper would replace, or null: only the desktop app updates itself (Windows, macOS, and on Linux an AppImage or a .deb
   * install).
   */
  target(): InstallTarget | null {
    if (!this.key || !this.app.desktop) return null;
    return installTarget(this.key[0] === 'macos' ? 'darwin' : this.key[0], this.app.exe, this.env, this.dpkgOwns);
  }

  /**
   * True for the desktop app on Windows and macOS, and on Linux when it runs from an AppImage or a .deb install. False for `deno run`.
   * When a file is already downloaded, it must be the in-place kind (a Linux AppImage run that only found a .deb, or the other way
   * round: manual).
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
      retryAt: this.#retrying() ? this.state.lastCheck + RETRY_INTERVAL : null,
      desktop: !!this.app.desktop,
      installWhenIdle: !!this.state.installWhenIdle,
      state: 'none',
      platform: this.key ? [...this.key] : null,
      inPlace: this.canInstallInPlace(),
    };
    if (this.feedDir) out.feed = true;
    if (out.inPlace && this.target()?.kind === 'deb') {
      out.password = true;
      out.authorizing = this.#debInstalling;
      out.askOnPc = this.#askOnPc;
      out.restarting = !!this.#debInstalled;
      out.installError = this.#debError;
    }
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
    return this.now() - this.state.lastCheck >= (this.#retrying() ? RETRY_INTERVAL : this.checkInterval());
  }

  /** Seconds between automatic GitHub checks: 1 h for a test build or with "Get test builds" on, else 24 h. */
  checkInterval(): number {
    return isTestBuild(this.current) || this.getTestBuilds() ? TEST_CHECK_INTERVAL : CHECK_INTERVAL;
  }

  #focusAt = 0;
  /**
   * The window got focus: in test-build mode, ask GitHub now, at most once per FOCUS_CHECK_INTERVAL; never with automatic checks
   * off. Resolves to true when a check ran.
   */
  async focusCheck(): Promise<boolean> {
    if (!this.configured() || !this.autoCheck() || !(isTestBuild(this.current) || this.getTestBuilds())) return false;
    if (this.#focusAt && this.now() - this.#focusAt < FOCUS_CHECK_INTERVAL) return false;
    this.#focusAt = this.now();
    await this.check(true);
    return true;
  }

  /** The last check failed for a passing reason (offline, GitHub busy): the next automatic one comes after RETRY_INTERVAL. */
  #retrying(): boolean {
    return !!this.state.error && RETRYABLE_CODES.has(this.state.code) && !!this.state.lastCheck;
  }

  /**
   * Remove what an earlier update left behind (called once at start): the downloaded files of the version now running, or of an
   * older one, are deleted with their folder, and state.json forgets them. Only version folders directly under <data>/updates are
   * looked at (their names must parse as a version and compare at or below this one); logs, markers and state.json stay. A folder
   * left empty by a refused or broken download is removed too. Never throws. Returns the folder names removed.
   */
  cleanup(): string[] {
    const removed: string[] = [];
    const atOrBelow = (version: unknown) => {
      try {
        return compare(String(version ?? ''), this.current) <= 0;
      } catch {
        return false;
      }
    };
    if (this.state.downloaded && atOrBelow(this.state.downloaded.version)) {
      this.state.downloaded = null; // installed (this is that version now) or older: nothing left to offer
      if (this.state.found && atOrBelow(this.state.found.version)) this.state.found = null;
      this.state.installWhenIdle = false;
      this.#save();
    }
    let entries: Deno.DirEntry[] = [];
    try {
      entries = [...Deno.readDirSync(this.root)];
    } catch {
      return removed;
    }
    const keep = this.state.downloaded ? parentOf(this.state.downloaded.path ?? '') : '';
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymlink || !VERSION_DIR.test(entry.name)) continue;
      const folder = join(this.root, entry.name);
      if (keep && sameDir(folder, keep)) continue;
      if (!atOrBelow(entry.name) && !isEmptyDir(folder)) continue;
      try {
        Deno.removeSync(folder, { recursive: true });
        removed.push(entry.name);
      } catch { /* in use: the next start tries again */ }
    }
    return removed;
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
        if (found) {
          await this.#download(found);
          this.#saveNotes(found.version);
        }
      } catch (error) {
        if (!(error instanceof UpdateError)) throw error;
        this.state.error = error.message;
        this.state.code = error.code;
        this.#save();
      }
    } finally {
      this.#checking = false;
    }
    await this.announce();
    return this.status();
  }

  /** One "update ready" call (onReady) per version: the version is remembered in state.json, so a restart does not repeat it. */
  async announce(): Promise<boolean> {
    const st = this.status();
    const version = st.state === 'ready' ? String(st.available?.version ?? '') : '';
    if (!version || this.state.notified === version) return false;
    this.state.notified = version;
    this.#save();
    try {
      await this.onReady?.(version);
    } catch (error) {
      log.info('update: the "update ready" notice failed: %s', error);
    }
    return true;
  }

  // -- release notes (the "What's new in AIB <version>" tab after an update)
  get notesPath(): string {
    return join(this.root, NOTES_FILE);
  }

  #saveNotes(version: string): void {
    const got = this.state.downloaded;
    if (!got || got.version !== version) return;
    const releases = this.#notes;
    try {
      if (!releases.length) Deno.removeSync(this.notesPath);
      else writeJsonAtomic(this.notesPath, { version, releases, shown: false }, { prefix: NOTES_FILE + '.', suffix: '.tmp' });
    } catch { /* no notes: the tab is skipped */ }
  }

  #readNotes(): ReleaseNotes | null {
    try {
      const data = JSON.parse(Deno.readTextFileSync(this.notesPath));
      if (!isDict(data) || typeof data.version !== 'string' || !Array.isArray(data.releases)) return null;
      const releases = (data.releases as unknown[]).filter((r): r is Dict =>
        isDict(r) && typeof r.version === 'string' && typeof r.body === 'string'
      )
        .map((r) => ({
          version: r.version as string,
          date: pyStr(pyOr(r.date, '')),
          page: pyStr(pyOr(r.page, '')),
          body: r.body as string,
        }));
      return { version: data.version, releases, shown: data.shown === true };
    } catch {
      return null;
    }
  }

  /** The notes to show once: this app runs the version they were stored for, they have a body, and they were not shown yet. */
  pendingNotes(): ReleaseNotes | null {
    const notes = this.#readNotes();
    if (!notes || notes.shown || !notes.releases.length || notes.version !== this.current) return null;
    return notes;
  }

  /** The notes of the verified download waiting to install (newer than this app), newest first; [] when none (remote devices). */
  upcomingNotes(): ReleaseNote[] {
    const st = this.status();
    const notes = this.#readNotes();
    if (st.state !== 'ready' || !notes || notes.version !== st.available?.version) return [];
    return notes.releases.filter((r) => {
      try {
        return compare(r.version, this.current) > 0;
      } catch {
        return false;
      }
    });
  }

  /** The page opened the tab: never again for this version. */
  notesShown(): boolean {
    const notes = this.#readNotes();
    if (!notes || notes.shown) return false;
    try {
      writeJsonAtomic(this.notesPath, { ...notes, shown: true }, { prefix: NOTES_FILE + '.', suffix: '.tmp' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The newest of GitHub's releases and (test builds) the local feed's versions. A GitHub failure is reported only when the feed has
   * nothing newer either.
   */
  async #fetchRelease(): Promise<Found | null> {
    let releases: unknown = [];
    let found: Found | null = null;
    let failed: UpdateError | null = null;
    if (this.#github()) {
      try {
        releases = await this.#githubReleases();
        found = pickRelease(releases, this.current, this.key, this.env, this.exists);
      } catch (error) {
        if (!(error instanceof UpdateError)) throw error;
        failed = error;
      }
    }
    const feed = this.feedDir ? pickFeed(this.feedDir, this.current, this.key, this.env, this.exists) : { found: null, notes: [] };
    if (this.feedDir) this.#feedAt = this.now();
    if (feed.found && (!found || compare(feed.found.version, found.version) > 0)) found = feed.found;
    if (!found && failed) throw failed;
    this.#notes = found
      ? mergeNotes(
        found.feed ? feed.notes : [],
        releaseNotes(releases, found.version, isPrerelease(this.current) || found.prerelease),
      )
      : [];
    return found;
  }

  async #githubReleases(): Promise<unknown> {
    const url = `${apiBase()[0]}/repos/${this.repo}/releases?per_page=30`;
    const data = await readLimited(url, 'application/vnd.github+json', MAX_RELEASES_BYTES, this.fetch);
    let releases: unknown;
    try {
      releases = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
      throw new UpdateError('GitHub sent a release list that could not be read.', 'bad_response');
    }
    if (!this.key) throw new UpdateError('This computer is not a platform AIB has installers for.', 'unsupported_platform');
    return releases;
  }

  /**
   * Test builds: read the local feed (a folder listing, no network) and, when it has a version newer than this app and than what
   * GitHub offered, copy it in and verify it against the feed's SHA256SUMS, exactly as a download. Called every FEED_INTERVAL by the
   * background loop and on window focus (POST /api/live/update/check {feed: true}); a feed that has not changed since the last try
   * is not copied again. Nothing installs. Resolves to status().
   */
  async checkFeed(): Promise<UpdateStatus> {
    if (!this.feedDir || this.#checking || !this.key) return this.status();
    this.#feedAt = this.now();
    const { found, notes } = pickFeed(this.feedDir, this.current, this.key, this.env, this.exists);
    if (!found) return this.status();
    const have = this.#freshFound();
    if (have && compare(have.version, found.version) > 0) return this.status(); // GitHub offers something newer
    const tried = found.version + '\n' + readSmallText(found.sums.url, MAX_SUMS_BYTES);
    if (tried === this.#feedTried) return this.status();
    this.#feedTried = tried;
    const st = this.status();
    if (st.state === 'ready' && st.available?.version === found.version) return st;
    this.#checking = true;
    try {
      this.state.found = found;
      this.state.error = '';
      this.state.code = '';
      this.#save();
      try {
        this.#notes = notes;
        await this.#download(found);
        this.#saveNotes(found.version);
      } catch (error) {
        if (!(error instanceof UpdateError)) throw error;
        this.state.error = error.message;
        this.state.code = error.code;
        this.#save();
      }
    } finally {
      this.#checking = false;
    }
    await this.announce();
    return this.status();
  }

  async #download(found: Found): Promise<void> {
    const got = this.state.downloaded;
    if (got && got.version === found.version && isFile(got.path ?? '') && await fileSha256(got.path) === got.sha256) {
      // Already here (a file an earlier build saved with the process's umask: group-writable, refused by the root installer): close it
      try {
        closeToOthers(this.root, parentOf(got.path), got.path);
      } catch { /* not ours to change: the installer will say so */ }
      return;
    }
    const folder = join(this.root, found.version);
    await Deno.mkdir(folder, { recursive: true });
    try {
      await this.#downloadInto(found, folder);
    } finally {
      if (isEmptyDir(folder)) await Deno.remove(folder).catch(() => {}); // a refused or broken download leaves no empty folder
    }
  }

  async #downloadInto(found: Found, folder: string): Promise<void> {
    const name = found.installer.name;
    if (!NAME_OK.test(name)) throw new UpdateError('The release names its installer in an unexpected way.', 'bad_name');
    // The local test feed is read from disk; everything else comes over the network. The checksum rules are the same.
    const read = (url: string, limit: number) =>
      found.feed ? readFeedFile(url, limit) : readLimited(url, 'application/octet-stream', limit, this.fetch);
    const sums = new TextDecoder().decode(await read(found.sums.url, MAX_SUMS_BYTES));
    const want = checksumFor(sums, name);
    const dest = join(folder, name);
    const have = found.feed
      ? await copyFeedFile(found.installer.url, dest, MAX_INSTALLER_BYTES)
      : await downloadTo(found.installer.url, dest, MAX_INSTALLER_BYTES, this.fetch);
    closeToOthers(this.root, folder, dest);
    if (have !== want) {
      await Deno.remove(dest).catch(() => {});
      throw new UpdateError(
        'The downloaded update did not match its published checksum, so it was refused and deleted. Nothing was installed.',
        'checksum_mismatch',
      );
    }
    this.state.downloaded = { version: found.version, name, path: dest, sha256: have };
    if (found.info) {
      // The agent-host protocol the new version speaks: Install now keeps working chats only when it can attach to this host.
      try {
        const raw = await read(found.info.url, MAX_SUMS_BYTES);
        if (await bytesSha256(raw) === checksumFor(sums, RELEASE_INFO_NAME)) {
          const info = JSON.parse(new TextDecoder().decode(raw));
          if (Number.isInteger(info.protocol)) this.state.downloaded.hostProtocol = info.protocol;
          const k = info.keeper;
          if (isDict(k) && Array.isArray(k.protocols) && Array.isArray(k.needs)) {
            this.state.downloaded.keeper = {
              protocols: k.protocols.filter((p: unknown) => Number.isInteger(p)),
              needs: k.needs.filter((f: unknown) => typeof f === 'string'),
            };
          }
        }
      } catch { /* unknown: Install now then waits for the chats */ }
    }
    this.#save();
  }

  // -- installing
  /**
   * The person clicked Install now (or Install when chats finish). {state: 'installing'} when the helper is running and this server
   * is quitting, {state: 'waiting', chats} when it will install once no chat is working, {state: 'authorizing'} when a .deb install
   * asks for the system password now (its outcome comes through status()). Throws UpdateError.
   *
   * `from`: 'remote' for a phone or a paired computer. A .deb install opens the password prompt only for a click on the PC
   * (`from` 'pc', not whenIdle): otherwise it throws 'password_on_pc' and leaves Install now waiting on the PC (status().askOnPc).
   */
  async install(whenIdle = false, from: 'pc' | 'remote' = 'pc'): Promise<InstallResult> {
    const status = this.status();
    if (status.state !== 'ready') throw new UpdateError('There is no verified update to install.', 'not_ready');
    if (!status.inPlace) {
      throw new UpdateError(status.instructions || 'Install it from the downloaded file.', 'manual', { path: status.available!.path });
    }
    if (status.password) {
      if (this.#debInstalling) throw new UpdateError('AIB is already asking for your system password to install the update.', 'busy');
      if (this.#debInstalled) throw new UpdateError('The update is installed; AIB restarts on it once no chat is working.', 'busy');
      if (whenIdle || from === 'remote') {
        // Never a password prompt nobody just asked for: the install waits for a click on the PC.
        this.#askOnPc = true;
        if (this.state.installWhenIdle) {
          this.state.installWhenIdle = false;
          this.#save();
        }
        const name = `AIB ${String(status.available?.version ?? '')}`.trim();
        throw new UpdateError(
          `Installing ${name} needs your system password on the PC, so it does not start by itself` +
            `${from === 'remote' ? ' from here' : ' when the chats finish'}. Click Install now in AIB on the PC when you are ready.`,
          'password_on_pc',
        );
      }
    }
    if (whenIdle) {
      this.state.installWhenIdle = true;
      this.#save();
    }
    const busy = await this.#busy();
    const handover = await this.keeperHandover();
    if (handover === true && !whenIdle) {
      // The chats run in the keeper, which outlives this app: the app leaves them there (release), the helper keeps the keeper
      // company while it swaps the files, and the new version takes every chat over from the keeper's record. Nothing waits.
      return busy ? { ...await this.#go(true), chats: busy } : await this.#go(true);
    }
    const keeps = this.keepsChats();
    if (busy && !whenIdle && keeps === true) {
      // The chats run in the agent host, which outlives this app: the new version attaches to it, they keep streaming, and the old
      // host is handed over once none of them is working (host_proxy retireOlderHost).
      return { ...await this.#go(), chats: busy };
    }
    if (busy) {
      if (whenIdle) return { state: 'waiting', chats: busy };
      const why = handover !== 'off' && handover !== true
        ? `${KEEPER_WHY[handover] ?? 'This update cannot take the running chats over'}, so it waits until no chat is working (${busy} now).`
        : keeps === 'protocol'
        ? `This update changes how AIB runs agents, so it waits until no chat is working (${busy} now).`
        : keeps === 'unknown'
        ? `AIB cannot tell whether this update can take over running chats, so it waits until no chat is working (${busy} now).`
        : `${busy} chat(s) are working. Install when they finish, or wait.`;
      if (status.password) {
        // a .deb install never installs by itself later (that would open a password prompt nobody just asked for)
        this.#askOnPc = true;
        throw new UpdateError(
          `${why.replace(/, so it waits until no chat is working \((\d+) now\)\.$/, ' (chats working now: $1).')} ` +
            'Installing asks for your system password, so click Install now again once they finish.',
          'chats_working',
          { chats: busy, password: true },
        );
      }
      throw new UpdateError(why, 'chats_working', { chats: busy });
    }
    return await this.#go(handover === true);
  }

  /**
   * Can Install now leave every chat running in the keeper for the new version to take over? true; otherwise why not: 'off' (no
   * keeper: the agent-host rules apply), 'release' (the new version's release.json says nothing about the keeper: an older build),
   * 'protocol' / 'features' (the running keeper is too old for the new version), 'outside' (a working chat runs outside the keeper,
   * or this app lost the keeper), 'unknown' (the keeper could not be asked).
   */
  async keeperHandover(): Promise<true | 'off' | 'release' | 'protocol' | 'features' | 'outside' | 'unknown'> {
    if (!this.keeper) return 'off';
    let state: KeeperState | null;
    try {
      state = await this.keeper();
    } catch {
      return 'unknown';
    }
    if (!state) return 'off';
    if (state.reason) return 'outside';
    const wants = this.state.downloaded?.keeper;
    if (!wants) return 'release';
    if (!wants.protocols.includes(state.protocol)) return 'protocol';
    if (missingFeatures(state.features, wants.needs).length) return 'features';
    this.#keeperData = state.dataDir;
    return true;
  }

  #keeperData = '';

  /**
   * Can Install now leave working chats running? true; 'off' (in-process: the agents die with the app); 'protocol' (the new version
   * speaks another agent-host protocol, so it could not attach to the running host); 'unknown' (the release has no release.json).
   */
  keepsChats(): true | 'off' | 'protocol' | 'unknown' {
    if (!this.chatsKeepRunning) return 'off';
    const protocol = this.state.downloaded?.hostProtocol;
    if (protocol === undefined || protocol === null) return 'unknown';
    return protocol === PROTOCOL_VERSION ? true : 'protocol';
  }

  cancelWait(): UpdateStatus {
    this.state.installWhenIdle = false;
    this.#askOnPc = false;
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

  async #go(release = false): Promise<InstallResult> {
    const got = this.state.downloaded ?? ({} as Partial<Downloaded>);
    const path = got.path ?? '';
    if (!path || !isFile(path) || await fileSha256(path) !== got.sha256) {
      throw new UpdateError('The downloaded update changed or is missing; it was not run.', 'checksum_mismatch');
    }
    const target = this.target();
    if (!target) throw new UpdateError('This copy of AIB cannot update itself; install the downloaded file by hand.', 'manual', { path });
    if (target.kind === 'deb') return this.#startDeb(path, { ...got } as Downloaded, target);
    this.state.installWhenIdle = false;
    this.#save();
    await this.#restart({ ...got } as Downloaded, target, release);
    return { state: 'installing' };
  }

  /** Start the helper and quit: it swaps the files (or, for a .deb, only starts the version apt installed). */
  async #restart(got: Downloaded, target: InstallTarget, release: boolean): Promise<void> {
    await this.launcher({
      installer: got.path,
      sha256: got.sha256,
      pid: this.app.pid,
      exe: this.app.exe,
      log: join(this.root, 'install.log'),
      version: got.version,
      kind: target.kind,
      target: target.target,
      args: this.appArgs,
      marker: startedMarker(this.root, got.version),
      ...(release && this.#keeperData ? { keeper: this.#keeperData } : {}),
    });
    if (this.quit) this.quit(release);
  }

  /**
   * A .deb install, from a click on Install now on the PC: answers at once ({state: 'authorizing'}) and runs
   * `/usr/bin/pkexec aib-install-deb <file>` in the background (the system asks for the password; status().authorizing meanwhile).
   * Then #debOutcome. Throws UpdateError 'manual' (no prompt) when the root script would refuse the path anyway.
   */
  #startDeb(path: string, got: Downloaded, target: InstallTarget): InstallResult {
    if (this.#debInstalling) throw new UpdateError('AIB is already asking for your system password to install the update.', 'busy');
    let real = path;
    let home = this.env.HOME ?? '';
    try {
      real = Deno.realPathSync(path); // aib-install-deb refuses a path that goes through a link
      if (home) home = Deno.realPathSync(home);
    } catch { /* checked as given */ }
    try {
      closeToOthers(this.root, parentOf(real), real); // a download an older build saved group-writable: the root script refuses it
    } catch { /* not ours to change: the root script will say so */ }
    const argv = this.debArgs(real, home, String(got.version ?? ''));
    if (!argv) {
      log.info('update: %s is not where aib-install-deb accepts an update (in the home folder); install it by hand', real);
      throw new UpdateError(
        'This copy of AIB keeps its data where its installer does not take updates from (outside your home folder, or a folder name ' +
          `with unusual characters), so it cannot install the update by itself. ${this.instructions(path)}`,
        'manual',
        { path },
      );
    }
    this.#debInstalling = true;
    this.#askOnPc = false;
    this.#debError = '';
    if (this.state.installWhenIdle) {
      this.state.installWhenIdle = false;
      this.#save();
    }
    log.info('update: asking for the system password to install %s (%s)', real, DEB_INSTALLER);
    this.#debRun = this.#runDeb(argv, path, got, target);
    return { state: 'authorizing' };
  }

  /** The password step, then: the outcome in status(), or the restart (#debRestartNow). Never throws. */
  async #runDeb(argv: string[], path: string, got: Downloaded, target: InstallTarget): Promise<void> {
    let outcome: DebOutcome;
    try {
      outcome = debOutcome(await this.privileged(argv));
    } catch (error) {
      outcome = { ok: false, reason: 'failed', message: `The update did not install (${error instanceof Error ? error.message : error}).` };
    } finally {
      this.#debInstalling = false;
    }
    if (!outcome.ok) {
      log.info('update: the .deb was not installed (%s): %s', outcome.reason, outcome.message);
      this.#debError = outcome.reason === 'partial' ? outcome.message : `${outcome.message} ${this.instructions(path)}`;
      return;
    }
    log.info('update: %s installed with apt', path);
    this.#debInstalled = { got, target };
    await this.#debRestartNow();
  }

  /** The installed .deb waiting for its restart (the chats), or null. */
  #debInstalled: { got: Downloaded; target: InstallTarget } | null = null;

  /**
   * After the password step (and on each tick while it waits): the chats are checked again, since one may have started while the
   * prompt was open. Restart now when none works or the keeper / agent host keeps them; otherwise wait (tick tries again).
   */
  async #debRestartNow(): Promise<void> {
    const done = this.#debInstalled;
    if (!done) return;
    const busy = await this.#busy();
    const handover = await this.keeperHandover();
    if (busy && handover !== true && this.keepsChats() !== true) {
      log.info('update: %s is installed; %d chat(s) are working: AIB restarts on it once they finish', done.got.version, busy);
      return;
    }
    this.#debInstalled = null;
    try {
      await this.#restart(done.got, done.target, handover === true);
      log.info('update: quitting so %s starts', done.got.version);
    } catch (error) {
      this.#debError = `AIB ${done.got.version} is installed, but AIB could not restart itself (${
        error instanceof Error ? error.message : error
      }). Quit AIB and start it again.`;
    }
  }

  /** Tests: wait for the background password step of the last .deb Install now. */
  async debSettled(): Promise<void> {
    await this.#debRun;
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
    this.cleanup();
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

  #held(): boolean {
    let held = false;
    try {
      held = this.holdInstall();
    } catch { /* unknown: not held */ }
    if (held) {
      log.info(
        'update: the install waiting for idle chats is held: AIB was quit and only stays in the tray; it installs at the next launch',
      );
    }
    return held;
  }

  /**
   * One pass: an automatic check when one is due, and the install the person asked to wait for once no chat is working. A .deb
   * install never starts here (that would open a password prompt nobody just asked for): a wait left from before turns into
   * "Install now waits on the PC"; an installed .deb whose restart waits for the chats restarts once they finish.
   */
  async tick(): Promise<void> {
    await this.check(false);
    if (this.feedDir && this.autoCheck() && this.now() - this.#feedAt >= FEED_INTERVAL) await this.checkFeed();
    await this.announce(); // a download an earlier run finished but never announced
    if (this.#debInstalled) {
      if (!this.#held()) await this.#debRestartNow();
      return;
    }
    if (this.state.installWhenIdle && this.target()?.kind === 'deb') {
      this.state.installWhenIdle = false;
      this.#askOnPc = true;
      this.#save();
      return;
    }
    if (this.state.installWhenIdle && this.status().state === 'ready' && !this.#held() && !await this.#busy()) {
      await this.#go(await this.keeperHandover() === true); // idle chats in the keeper are left to the new version too
    }
  }
}

// ---- the web routes' contract (web_handler.get_update, post_update_check, post_update_install) ----------------------
export type RouteReply = [number, Record<string, unknown>];

/** GET /api/live/update */
export function getUpdate(service: UpdateService): RouteReply {
  return [200, { ...service.status() }];
}

/** GET /api/live/update/notes: {notes: {version, releases: [{version, date, page, body}]}} once after an update, else {notes: null}. */
export function getUpdateNotes(service: UpdateService): RouteReply {
  return [200, { notes: service.pendingNotes() }];
}

/** POST /api/live/update/notes {shown: true}: the page opened the "What's new" tab; it is not offered again. */
export function postUpdateNotes(service: UpdateService, body: Record<string, unknown>): RouteReply {
  if (body.shown !== true) throw new ValueError('shown must be true');
  return [200, { ok: true, changed: service.notesShown() }];
}

/** POST /api/live/update/check: start a manual check in the background (a download can outlast a request); the page polls GET. */
export function postUpdateCheck(service: UpdateService, body: Record<string, unknown> = {}): RouteReply {
  if (body.feed === true) {
    // The window got focus (a test build): read the local feed; in test-build mode also GitHub (throttled); not while automatic checks are off.
    if (service.autoCheck()) {
      service.checkFeed().catch(() => {});
      service.focusCheck().catch(() => {}); // GitHub too, test-build mode only, at most every 15 minutes
    }
    return [200, { ...service.status() }];
  }
  service.check(true).catch(() => {});
  return [200, { ...service.status(), checking: true }];
}

/** Why Install now cannot leave the chats in the keeper (the start of the "waits until no chat is working" message). */
const KEEPER_WHY: Record<string, string> = {
  release: 'This update cannot take running chats over from the keeper',
  protocol: 'The running keeper is too old for this update to take its chats over',
  features: 'The running keeper is too old for this update to take its chats over',
  outside: 'Some working chats do not run in the keeper',
  unknown: 'AIB cannot tell whether the keeper can hand its chats to this update',
};

const INSTALL_STATUS: Record<string, number> = { chats_working: 409, not_ready: 409, busy: 409, password_on_pc: 409, manual: 400 };

/**
 * POST /api/live/update/install: install now or, with whenIdle, once no chat is working; cancelWait drops the second. Throws
 * ValueError (the HTTP layer's 400) for a whenIdle that is not a boolean, as Python does. The route must send the reply before the
 * service's quit callback ends the server.
 */
export async function postUpdateInstall(
  service: UpdateService,
  body: Record<string, unknown>,
  from: 'pc' | 'remote' = 'pc',
): Promise<RouteReply> {
  if (body.cancelWait === true) return [200, { ...service.cancelWait() }];
  const whenIdle = 'whenIdle' in body ? body.whenIdle : false;
  if (typeof whenIdle !== 'boolean') throw new ValueError('whenIdle must be true or false');
  try {
    return [200, { ...await service.install(whenIdle, from), ok: true }];
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    return [INSTALL_STATUS[error.code] ?? 500, { error: error.message, code: error.code, ...error.extra }];
  }
}
