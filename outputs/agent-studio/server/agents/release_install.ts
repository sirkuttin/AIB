/**
 * Installing a Beta agent that ships as a native program on its GitHub release (beta_catalog.ts `release`, Maki): the pieces the
 * installer (installer.ts) runs, kept free of its job and lock handling so they can be tested on their own.
 *
 *   1. download   https://github.com/<repo>/releases/download/<tag>/<file> (GitHub redirects to its release CDN), at most the
 *                 catalog's byte count; nothing else is ever fetched (no "latest" lookup, no install script)
 *   2. verify     the archive's SHA-256 must equal the one pinned in the catalog, else nothing in it is used
 *   3. unpack     only the program at the archive's root (a .zip or a .tar.gz), read in memory; no other file is written, so a path
 *                 inside the archive can never point outside the install folder
 *
 * The install itself is <state>/agents/<id>/<version>/<program>[.exe] plus the `.complete` marker the npm installs use.
 */
import { type BetaAgent, betaAgent, type BetaRelease, type BetaReleaseAsset } from './beta_catalog.ts';
import { COMPLETE_MARKER, completeVersions } from './adapters.ts';
import { isFile } from '../platform/pypath.ts';
import { pathOf } from '../state/paths.ts';

/** The largest program AIB unpacks from a release archive (a damaged or hostile archive cannot fill the disk). */
export const MAX_PROGRAM_BYTES = 512 * 1024 * 1024;
/** Hosts a release download may come from: the github.com URL, then GitHub's own release CDN it redirects to. */
const DOWNLOAD_HOSTS = [/^github\.com$/, /^(?:objects|release-assets)\.githubusercontent\.com$/];

/** `<os>-<arch>` of this computer, the key of BetaRelease.assets. */
export function platformKey(): string {
  return `${Deno.build.os}-${Deno.build.arch}`;
}

/** The release of a Beta agent id, or null. */
export function releaseOf(agentId: unknown): BetaRelease | null {
  return betaAgent(agentId)?.release ?? null;
}

/** The archive for this computer, or null when the vendor publishes none for it. */
export function releaseAsset(agent: BetaAgent | null | undefined, platform = platformKey()): BetaReleaseAsset | null {
  const assets = agent?.release?.assets;
  return assets && Object.prototype.hasOwnProperty.call(assets, platform) ? assets[platform] : null;
}

/** The program's file name on this OS (Windows: maki.exe). */
export function programFile(release: BetaRelease, os: string = Deno.build.os): string {
  return os === 'windows' ? `${release.program}.exe` : release.program;
}

/** The download address of one archive. Only github.com release downloads are ever built. */
export function releaseUrl(release: BetaRelease, asset: BetaReleaseAsset): string {
  const safe = (part: string) => /^[A-Za-z0-9._-]+$/.test(part);
  const [owner, name, ...rest] = release.repo.split('/');
  if (rest.length || !owner || !name || ![owner, name, release.tag, asset.file].every(safe)) {
    throw new Error(`Not a release download AIB can build: ${release.repo} ${release.tag} ${asset.file}`);
  }
  return `https://github.com/${owner}/${name}/releases/download/${release.tag}/${asset.file}`;
}

/** True for an https address on github.com or GitHub's release CDN. */
export function allowedDownload(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && DOWNLOAD_HOSTS.some((host) => host.test(u.hostname));
  } catch {
    return false;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A download that could not be used; `message` is the one plain line the card shows. */
export class ReleaseError extends Error {
  override name = 'ReleaseError';
}

export interface DownloadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Called with the bytes received so far. */
  onBytes?: (received: number) => void;
}

/** The archive's bytes: the exact size the catalog names, from an allowed host only. Throws ReleaseError (or an AbortError). */
export async function downloadAsset(url: string, asset: BetaReleaseAsset, options: DownloadOptions = {}): Promise<Uint8Array> {
  if (!allowedDownload(url)) throw new ReleaseError('AIB only downloads agents from github.com releases.');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { redirect: 'follow', signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ReleaseError('Could not reach github.com. Check the internet connection and try again.');
  }
  if (response.url && !allowedDownload(response.url)) {
    await response.body?.cancel();
    throw new ReleaseError('The download was sent somewhere other than GitHub, so AIB stopped it.');
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ReleaseError(`GitHub answered ${response.status} for the download. Try again later.`);
  }
  const out = new Uint8Array(asset.bytes);
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > asset.bytes) {
        throw new ReleaseError('The download is larger than the release AIB expects, so it was not used.');
      }
      out.set(value, received);
      received += value.length;
      options.onBytes?.(received);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ReleaseError || options.signal?.aborted) throw error;
    throw new ReleaseError('The download stopped part way. Check the internet connection and try again.');
  }
  if (received !== asset.bytes) throw new ReleaseError('The download stopped part way. Check the internet connection and try again.');
  return out;
}

/** Decompress with a size cap. */
async function inflate(data: Uint8Array, format: 'gzip' | 'deflate-raw', max: number): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(format));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > max) throw new ReleaseError('The program in the download is larger than AIB allows, so it was not used.');
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** An archive entry name that is the program at the archive's root ('maki', './maki'). */
function atRoot(entry: string, name: string): boolean {
  return entry.replace(/^\.\//, '') === name;
}

const bad = () => new ReleaseError('The download is not an archive AIB can read, so it was not used.');

/** The program from a .zip (stored or deflated; no ZIP64). */
export async function fromZip(zip: Uint8Array, name: string, max = MAX_PROGRAM_BYTES): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const text = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== 0x02014b50) throw bad();
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = text.decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!atRoot(entry, name)) continue;
    if (packed === 0xffffffff || size === 0xffffffff || size > max) throw bad();
    if (local + 30 > zip.length || view.getUint32(local, true) !== 0x04034b50) throw bad();
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > zip.length) throw bad();
    const body = zip.subarray(start, start + packed);
    const data = method === 0 ? body.slice() : method === 8 ? await inflate(body, 'deflate-raw', max) : null;
    if (!data || data.length !== size) throw bad();
    return data;
  }
  throw new ReleaseError(`The download does not contain ${name}, so it was not used.`);
}

/** The program from a .tar.gz (ustar or GNU tar; regular files only). */
export async function fromTarGz(archive: Uint8Array, name: string, max = MAX_PROGRAM_BYTES): Promise<Uint8Array> {
  let tar: Uint8Array;
  try {
    tar = await inflate(archive, 'gzip', max + 64 * 1024 * 1024);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw bad();
  }
  const text = new TextDecoder();
  const field = (at: number, len: number) => text.decode(tar.subarray(at, at + len)).replace(/\0.*$/s, '');
  let at = 0;
  let longName = '';
  while (at + 512 <= tar.length) {
    if (tar.subarray(at, at + 512).every((b) => b === 0)) break;
    const size = parseInt(field(at + 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw bad();
    const type = String.fromCharCode(tar[at + 156] || 48);
    const prefix = field(at + 257, 6).startsWith('ustar') ? field(at + 345, 155) : '';
    const entry = longName || (prefix ? `${prefix}/${field(at, 100)}` : field(at, 100));
    const start = at + 512;
    if (start + size > tar.length) throw bad();
    longName = '';
    if (type === 'L') longName = text.decode(tar.subarray(start, start + size)).replace(/\0.*$/s, '');
    else if ((type === '0' || type === '\0') && atRoot(entry, name)) {
      if (size > max) throw bad();
      return tar.slice(start, start + size);
    }
    at = start + Math.ceil(size / 512) * 512;
  }
  throw new ReleaseError(`The download does not contain ${name}, so it was not used.`);
}

/** The program from the archive, by the archive's file name. */
export function extractProgram(archive: Uint8Array, file: string, name: string): Promise<Uint8Array> {
  if (/\.zip$/i.test(file)) return fromZip(archive, name);
  if (/\.tar\.gz$|\.tgz$/i.test(file)) return fromTarGz(archive, name);
  return Promise.reject(new ReleaseError(`AIB cannot unpack ${file}.`));
}

export interface ReleaseInstall {
  program: string;
  version: string;
  dir: string;
}

/** AIB's own install of a release agent: the newest complete version folder that has the program, or null. Reads the disk. */
export function findReleaseInstall(agent: BetaAgent, stateDir: string | null | undefined): ReleaseInstall | null {
  if (!agent.release || !stateDir) return null;
  const file = programFile(agent.release);
  for (const dir of completeVersions(stateDir, agent.id)) {
    const program = pathOf(dir, file);
    if (isFile(program)) return { program, version: dir.slice(Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1), dir };
  }
  return null;
}

/** Write the program into a version folder (executable on macOS / Linux), then the `.complete` marker, last. */
export function writeInstall(dir: string, release: BetaRelease, asset: BetaReleaseAsset, program: Uint8Array, at: number): string {
  Deno.mkdirSync(dir, { recursive: true });
  const path = pathOf(dir, programFile(release));
  Deno.writeFileSync(path, program, { mode: 0o755 });
  if (Deno.build.os !== 'windows') Deno.chmodSync(path, 0o755);
  Deno.writeTextFileSync(
    pathOf(dir, COMPLETE_MARKER),
    JSON.stringify({ package: `github:${release.repo}`, version: release.version, file: asset.file, sha256: asset.sha256, finishedAt: at }),
  );
  return path;
}
