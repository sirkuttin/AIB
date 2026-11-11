/**
 * Builds the AIB desktop app for every target with `deno desktop`, all from one machine, and packages the release assets:
 *
 *   AIB-<version>-windows-x64.zip, -windows-arm64.zip   a top-level AIB/ folder (AIB.exe launcher + AIB.dll); per-user, no installer
 *   AIB-<version>-macos-x64.zip, -macos-arm64.zip       AIB.app/ with unix modes written into the zip (Contents/MacOS/* are 0755)
 *   AIB-<version>-linux-x64.AppImage, -linux-arm64.AppImage, -linux-x64.deb, -linux-arm64.deb
 *   SHA256SUMS                                           sha256sum format over all of them
 *
 * Each package also carries the keeper (keeper/, Go, built with CGO off for the target) next to the app's program: AIB/AIB-keeper.exe,
 * AIB.app/Contents/MacOS/AIB-keeper, AIB-keeper at the AppImage's top level, usr/lib/aib/AIB-keeper in the .deb. Needs Go ($GO or go).
 *
 * Usage (from anywhere): deno run -A tools/build.ts [--targets all|windows-x64,macos-arm64,...] [--out dist/] [--keep] [--no-smoke]
 *                       [--version V]   (a test build that reports version V; default APP_VERSION)
 *
 * The version is APP_VERSION (server/core/app.ts). For the target this machine runs, the build starts the app headless (`AIB serve
 * --in-process`, temp state folder, a free port from 8920, no window) and checks that it serves the page.
 *
 * The app is built from a clean staging copy of outputs/agent-studio (the code and page files only) with its own deno.json (version
 * from APP_VERSION, desktop.app name and identifier, nodeModulesDir none), so a stray package.json or node_modules in a parent folder
 * cannot be pulled in. Every asset over SIZE_LIMIT fails the build. Updates (server/desktop/updater.ts) pick assets by these names.
 */
import { createHash } from 'node:crypto';
import { APP_VERSION } from '../outputs/agent-studio/server/core/app.ts';
import { PROTOCOL_VERSION } from '../outputs/agent-studio/server/host/host_client.ts';
import { KEEPER_NEEDS, PROTOCOL as KEEPER_PROTOCOL } from '../outputs/agent-studio/server/keeper/client.ts';
import { addToAppImage, addToDeb, fixAppImage, fixDeb } from './linux_package.ts';

export const SIZE_LIMIT = 160 * 1024 * 1024;
export const APP_NAME = 'AIB';
export const APP_IDENTIFIER = 'dev.aib.app';

export interface Target {
  id: string;
  triple: string;
  os: 'windows' | 'macos' | 'linux';
  arch: 'x64' | 'arm64';
}

export const TARGETS: Target[] = [
  { id: 'windows-x64', triple: 'x86_64-pc-windows-msvc', os: 'windows', arch: 'x64' },
  { id: 'windows-arm64', triple: 'aarch64-pc-windows-msvc', os: 'windows', arch: 'arm64' },
  { id: 'macos-x64', triple: 'x86_64-apple-darwin', os: 'macos', arch: 'x64' },
  { id: 'macos-arm64', triple: 'aarch64-apple-darwin', os: 'macos', arch: 'arm64' },
  { id: 'linux-x64', triple: 'x86_64-unknown-linux-gnu', os: 'linux', arch: 'x64' },
  { id: 'linux-arm64', triple: 'aarch64-unknown-linux-gnu', os: 'linux', arch: 'arm64' },
];

/** The release asset names a target produces. */
export function assetNames(version: string, target: Target): string[] {
  const base = `${APP_NAME}-${version}-${target.id}`;
  return target.os === 'linux' ? [`${base}.AppImage`, `${base}.deb`] : [`${base}.zip`];
}

export function parseTargets(spec: string): Target[] {
  if (!spec || spec === 'all') return TARGETS;
  return spec.split(',').map((id) => {
    const t = TARGETS.find((x) => x.id === id.trim());
    if (!t) throw new Error(`unknown target ${id}; known: ${TARGETS.map((x) => x.id).join(', ')}`);
    return t;
  });
}

/** Throws when an asset is over the limit (a build that pulled in a node_modules tree, say). */
export function checkSize(name: string, bytes: number, limit = SIZE_LIMIT): void {
  if (bytes > limit) {
    throw new Error(`${name} is ${(bytes / 1048576).toFixed(1)} MB, over the ${(limit / 1048576).toFixed(0)} MB limit`);
  }
}

/** sha256sum's text format: "<64 hex>  <name>\n" per file, sorted by name. */
export function sha256sums(entries: { name: string; sha256: string }[]): string {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((e) => `${e.sha256}  ${e.name}\n`).join('');
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

// ---- zip (written by hand so unix modes survive a build on Windows) ----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipEntry {
  /** Path inside the zip, '/'-separated; a folder ends with '/'. */
  name: string;
  /** File contents (folders: none). */
  data?: Uint8Array;
  /** Unix mode bits (permissions only; the file type is added). */
  mode: number;
  /** A symbolic link: data is its target. */
  symlink?: boolean;
}

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** Writes a zip whose central directory says "made by Unix" with each entry's mode in the external attributes. */
export async function writeZip(path: string, entries: ZipEntry[], when = new Date()): Promise<void> {
  const [time, date] = dosTime(when);
  using out = await Deno.open(path, { write: true, create: true, truncate: true });
  const central: Uint8Array[] = [];
  let offset = 0;
  const write = async (bytes: Uint8Array) => {
    let n = 0;
    while (n < bytes.length) n += await out.write(bytes.subarray(n));
    offset += bytes.length;
  };
  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const isDir = e.name.endsWith('/');
    const raw = e.data ?? new Uint8Array(0);
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (!isDir && raw.length > 0) {
      const packed = await deflateRaw(raw);
      if (packed.length < raw.length) [method, body] = [8, packed];
    }
    if (offset > 0xffffffff || body.length > 0xffffffff) throw new Error('zip64 is not supported');
    const type = isDir ? 0o040000 : e.symlink ? 0o120000 : 0o100000;
    const external = (((type | (e.mode & 0o7777)) << 16) >>> 0) | (isDir ? 0x10 : 0);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by: Unix, zip 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, external, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    await write(local);
    await write(body);
  }
  const cdStart = offset;
  for (const c of central) await write(c);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, offset - cdStart, true);
  ev.setUint32(16, cdStart, true);
  await write(end);
}

export interface ZipListing {
  name: string;
  /** Unix mode (type and permission bits) from the external attributes; 0 when not made by Unix. */
  mode: number;
  madeBy: number;
  method: number;
  size: number;
}

/** The central directory of a zip (for tests and the build's own check). */
export function readZipListing(zip: Uint8Array): ZipListing[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: ZipListing[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const madeBy = v.getUint16(p + 4, true) >> 8;
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    const external = v.getUint32(p + 38, true);
    out.push({
      name: dec.decode(zip.subarray(p + 46, p + 46 + nameLen)),
      mode: madeBy === 3 ? external >>> 16 : 0,
      madeBy,
      method: v.getUint16(p + 10, true),
      size: v.getUint32(p + 24, true),
    });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** The unix mode a packaged file gets: executables in a macOS bundle's Contents/MacOS, the Windows .exe/.dll, folders 0755. */
export function modeFor(relPath: string, isDir: boolean): number {
  if (isDir) return 0o755;
  if (/(^|\/)Contents\/MacOS\/[^/]+$/.test(relPath)) return 0o755;
  if (/\.(exe|dll|dylib|so)$/i.test(relPath)) return 0o755;
  return 0o644;
}

/** Zip a folder as <prefix>/... (prefix = the folder's name in the zip, e.g. "AIB" or "AIB.app"). */
export async function zipFolder(folder: string, zipPath: string, prefix: string): Promise<number> {
  const entries: ZipEntry[] = [{ name: prefix + '/', mode: 0o755 }];
  const walk = async (dir: string, rel: string) => {
    const items = [];
    for await (const e of Deno.readDir(dir)) items.push(e);
    items.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of items) {
      const full = `${dir}/${e.name}`;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymlink) {
        entries.push({ name: `${prefix}/${r}`, data: new TextEncoder().encode(await Deno.readLink(full)), mode: 0o755, symlink: true });
      } else if (e.isDirectory) {
        entries.push({ name: `${prefix}/${r}/`, mode: modeFor(r, true) });
        await walk(full, r);
      } else {
        entries.push({ name: `${prefix}/${r}`, data: await Deno.readFile(full), mode: modeFor(r, false) });
      }
    }
  };
  await walk(folder, '');
  await writeZip(zipPath, entries);
  return entries.length;
}

// ---- icons ---------------------------------------------------------------------------------------------------------------
/** An .icns made of PNG entries (deno desktop on Windows cannot run iconutil to convert a .png for macOS). */
export function makeIcns(pngs: [type: string, data: Uint8Array][]): Uint8Array {
  const total = 8 + pngs.reduce((n, [, d]) => n + 8 + d.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  const enc = new TextEncoder();
  out.set(enc.encode('icns'));
  v.setUint32(4, total);
  let o = 8;
  for (const [type, data] of pngs) {
    out.set(enc.encode(type), o);
    v.setUint32(o + 4, data.length + 8);
    out.set(data, o + 8);
    o += 8 + data.length;
  }
  return out;
}

// ---- staging and building ------------------------------------------------------------------------------------------------
const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
export const REPO = HERE.replace(/\/tools$/, '');
export const APP_DIR = `${REPO}/outputs/agent-studio`;
export const ICONS = `${APP_DIR}/icons`; // the app icon in every size the packages need

// ---- the keeper (keeper/, Go): built for each target and placed next to the app's program ---------------------------------
export const KEEPER_DIR = `${REPO}/keeper`;
export const KEEPER_NAME = 'AIB-keeper';
/** Where the keeper goes inside the .deb: next to the app's program (usr/lib/aib/aib). */
export const DEB_KEEPER_PATH = 'usr/lib/aib/AIB-keeper';

export function goTarget(t: Target): { GOOS: string; GOARCH: string } {
  return { GOOS: t.os === 'macos' ? 'darwin' : t.os, GOARCH: t.arch === 'x64' ? 'amd64' : 'arm64' };
}

export function keeperFile(t: Target): string {
  return t.os === 'windows' ? `${KEEPER_NAME}.exe` : KEEPER_NAME;
}

/** `go build` arguments: stripped, no local paths, and on Windows a GUI-subsystem program (it can never get a console window). */
export function keeperBuildArgs(t: Target, output: string): string[] {
  return ['build', '-trimpath', '-ldflags', t.os === 'windows' ? '-s -w -H windowsgui' : '-s -w', '-o', output, '.'];
}

/** The go command: $GO, else Go's default Windows install folder, else `go` on PATH. */
export function goCommand(): string {
  const env = Deno.env.get('GO');
  if (env) return env;
  if (Deno.build.os === 'windows') {
    try {
      Deno.statSync('C:/Program Files/Go/bin/go.exe');
      return 'C:/Program Files/Go/bin/go.exe';
    } catch { /* not there */ }
  }
  return 'go';
}

/** Builds the keeper for a target (CGO off, so every target builds from any machine). Returns its size in bytes. */
export async function buildKeeper(t: Target, output: string): Promise<number> {
  const out = await new Deno.Command(goCommand(), {
    args: keeperBuildArgs(t, output),
    cwd: KEEPER_DIR,
    env: { CGO_ENABLED: '0', ...goTarget(t) },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(`go build of the keeper failed for ${t.id}:\n${new TextDecoder().decode(out.stderr).slice(-2000)}`);
  return (await Deno.stat(output)).size;
}

/**
 * The top-level names of outputs/agent-studio that go into the app: code, page files, vendored page libraries (vendor/: xterm.js and
 * its licenses), the agent allow-list and its lockfiles.
 */
export function stagedName(name: string, isDir: boolean): boolean {
  if (isDir) return ['server', 'agent_locks', 'vendor'].includes(name);
  return /\.(js|css|html)$/.test(name) || name === 'agent_versions.json';
}

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    if (e.name === '__pycache__' || e.name === 'node_modules') continue;
    if (e.isDirectory) await copyTree(`${from}/${e.name}`, `${to}/${e.name}`);
    else if (e.isFile) await Deno.copyFile(`${from}/${e.name}`, `${to}/${e.name}`);
  }
}

/** The staged deno.json: the app's own settings plus version and desktop.app, and no node_modules. */
export function stagedConfig(appConfig: Record<string, unknown>, version: string): Record<string, unknown> {
  const desktop = (appConfig.desktop ?? {}) as Record<string, unknown>;
  return {
    compilerOptions: appConfig.compilerOptions ?? { strict: true },
    nodeModulesDir: 'none',
    version,
    desktop: { ...desktop, app: { ...(desktop.app as object ?? {}), name: APP_NAME, identifier: APP_IDENTIFIER } },
  };
}

/**
 * `--version V` (test builds, e.g. the update end-to-end test's "next version"): the staged copy's APP_VERSION becomes V, so the
 * built app reports it. The source tree is never changed.
 */
export async function setStagedVersion(stageDir: string, version: string): Promise<void> {
  const path = `${stageDir}/server/core/app.ts`;
  const text = await Deno.readTextFile(path);
  const next = text.replace(/export const APP_VERSION = '[^']*';/, `export const APP_VERSION = '${version}';`);
  if (next === text) throw new Error('could not set the version in the staged app.ts');
  await Deno.writeTextFile(path, next);
}

export const RELEASE_INFO = 'release.json';

/**
 * {version, protocol, appId, keeper}: the agent-host protocol this version speaks (host_client PROTOCOL_VERSION), and what it needs
 * of a running keeper to take chats over from it after Install now (the keeper protocols it speaks and the keeper features it needs,
 * keeper/client.ts KEEPER_NEEDS). A running AIB reads it before Install now while chats work.
 */
export function releaseInfo(version: string): string {
  return JSON.stringify({
    version,
    protocol: PROTOCOL_VERSION,
    appId: APP_IDENTIFIER,
    keeper: { protocols: [KEEPER_PROTOCOL], needs: KEEPER_NEEDS },
  });
}

export async function stage(stageDir: string, version: string): Promise<string[]> {
  await Deno.remove(stageDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(stageDir, { recursive: true });
  const included: string[] = [];
  for await (const e of Deno.readDir(APP_DIR)) {
    if (!stagedName(e.name, e.isDirectory)) continue;
    if (e.isDirectory) await copyTree(`${APP_DIR}/${e.name}`, `${stageDir}/${e.name}`);
    else await Deno.copyFile(`${APP_DIR}/${e.name}`, `${stageDir}/${e.name}`);
    included.push(e.name);
  }
  const appConfig = JSON.parse(await Deno.readTextFile(`${APP_DIR}/deno.json`));
  await Deno.writeTextFile(`${stageDir}/deno.json`, JSON.stringify(stagedConfig(appConfig, version), null, 2) + '\n');
  const icns = makeIcns([
    ['ic11', await Deno.readFile(`${ICONS}/32x32.png`)],
    ['ic07', await Deno.readFile(`${ICONS}/128x128.png`)],
    ['ic08', await Deno.readFile(`${ICONS}/128x128@2x.png`)],
    ['ic09', await Deno.readFile(`${ICONS}/icon.png`)],
  ]);
  await Deno.writeFile(`${stageDir}/AIB.icns`, icns);
  return included.sort();
}

// ---- the Windows launcher's icon -----------------------------------------------------------------------------------------
// `deno desktop --icon` only copies the .ico next to the launcher as AppIcon.ico; Explorer, the Start menu and the taskbar take the
// icon from the exe's own RT_GROUP_ICON resource. So the build writes the .ico into AIB.exe with kernel32's resource update API,
// which works on a PE of any architecture (the arm64 launcher too), but only on a Windows build machine.

export interface IcoImage {
  width: number; // 0 means 256, as in the .ico
  height: number;
  colors: number;
  planes: number;
  bitCount: number;
  /** The image as stored in the .ico (PNG, or a BMP without its file header), which is also the RT_ICON resource's data. */
  data: Uint8Array;
}

/** The images of an .ico (ICONDIR + ICONDIRENTRY). Planes and bit count left 0 by the .ico are read from the image itself. */
export function parseIco(ico: Uint8Array): IcoImage[] {
  const v = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (ico.length < 6 || v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 1) throw new Error('not an .ico file');
  const count = v.getUint16(4, true);
  if (!count || ico.length < 6 + 16 * count) throw new Error('the .ico has no images or is truncated');
  const images: IcoImage[] = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + 16 * i;
    const size = v.getUint32(p + 8, true);
    const offset = v.getUint32(p + 12, true);
    if (!size || offset + size > ico.length) throw new Error(`.ico image ${i} lies outside the file`);
    const data = ico.slice(offset, offset + size);
    const d = new DataView(data.buffer);
    const png = size >= 26 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    // PNG: bit depth x channels (IHDR at 16: depth at 24, colour type at 25); BMP: BITMAPINFOHEADER planes at 12, bit count at 14.
    const channels = png ? ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[data[25]] ?? 4 : 0;
    const planes = v.getUint16(p + 4, true) || (png || size < 16 ? 1 : d.getUint16(12, true));
    const bitCount = v.getUint16(p + 6, true) || (png ? data[24] * channels : size < 16 ? 32 : d.getUint16(14, true));
    images.push({ width: ico[p], height: ico[p + 1], colors: ico[p + 2], planes, bitCount, data });
  }
  return images;
}

/** Width and height of a PNG, from its IHDR. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('not a PNG');
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** An .ico of square PNG images (Vista and later read PNG entries at every size), in the order given; 256 px is written as 0. */
export function makeIco(pngs: Uint8Array[]): Uint8Array {
  const total = 6 + 16 * pngs.length + pngs.reduce((n, d) => n + d.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, pngs.length, true);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((png, i) => {
    const { width, height } = pngSize(png);
    if (width > 256 || height > 256) throw new Error(`an .ico image can be at most 256 px (got ${width}x${height})`);
    const p = 6 + 16 * i;
    out.set([width & 0xff, height & 0xff, 0, 0], p);
    v.setUint16(p + 4, 1, true); // planes
    v.setUint16(p + 6, 32, true); // bit count
    v.setUint32(p + 8, png.length, true);
    v.setUint32(p + 12, offset, true);
    out.set(png, offset);
    offset += png.length;
  });
  return out;
}

/** The RGBA pixels of an 8-bit RGB or RGBA, non-interlaced PNG (what the icon renderer writes); for checks, not a general decoder. */
export async function decodePng(png: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const { width, height } = pngSize(png);
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const [depth, type, interlace] = [png[24], png[25], png[28]];
  if (depth !== 8 || (type !== 6 && type !== 2) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, type ${type})`);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let p = 8; p + 8 <= png.length;) {
    const len = v.getUint32(p);
    const kind = String.fromCharCode(...png.subarray(p + 4, p + 8));
    if (kind === 'IDAT') parts.push(png.slice(p + 8, p + 8 + len));
    if (kind === 'IEND') break;
    p += 12 + len;
  }
  const inflated = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(inflated).arrayBuffer());
  const bpp = type === 6 ? 4 : 3, stride = width * bpp;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = up[x], c = x >= bpp ? up[x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      if (pred === undefined) throw new Error(`bad PNG filter ${filter}`);
      row[x] = (src[x] + pred) & 0xff;
    }
  }
  if (type === 6) return { width, height, rgba: rows };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([rows[i * 3], rows[i * 3 + 1], rows[i * 3 + 2], 255], i * 4);
  return { width, height, rgba };
}

/** An RT_GROUP_ICON resource: GRPICONDIR, then a GRPICONDIRENTRY per image naming its RT_ICON id (firstId, firstId+1, ...). */
export function groupIconBytes(images: IcoImage[], firstId = 1): Uint8Array {
  const out = new Uint8Array(6 + 14 * images.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, images.length, true);
  images.forEach((img, i) => {
    const p = 6 + 14 * i;
    out.set([img.width, img.height, img.colors, 0], p);
    v.setUint16(p + 4, img.planes, true);
    v.setUint16(p + 6, img.bitCount, true);
    v.setUint32(p + 8, img.data.length, true);
    v.setUint16(p + 12, firstId + i, true);
  });
  return out;
}

export const RT_ICON = 3;
export const RT_GROUP_ICON = 14;
/** A resource name: an integer id, or a string name. */
export type ResName = number | string;
export interface PeResource {
  type: number;
  name: ResName;
  lang: number;
  data: Uint8Array;
}

function kernel32() {
  if (Deno.build.os !== 'windows') {
    throw new Error('the Windows launcher icon can only be embedded on a Windows build machine (kernel32 resource API)');
  }
  return Deno.dlopen('kernel32.dll', KERNEL32);
}
const KERNEL32 = {
  BeginUpdateResourceW: { parameters: ['buffer', 'i32'], result: 'pointer' },
  UpdateResourceW: { parameters: ['pointer', 'pointer', 'pointer', 'u16', 'buffer', 'u32'], result: 'i32' },
  EndUpdateResourceW: { parameters: ['pointer', 'i32'], result: 'i32' },
  LoadLibraryExW: { parameters: ['buffer', 'pointer', 'u32'], result: 'pointer' },
  FreeLibrary: { parameters: ['pointer'], result: 'i32' },
  EnumResourceNamesW: { parameters: ['pointer', 'pointer', 'function', 'isize'], result: 'i32' },
  EnumResourceLanguagesW: { parameters: ['pointer', 'pointer', 'pointer', 'function', 'isize'], result: 'i32' },
  FindResourceExW: { parameters: ['pointer', 'pointer', 'pointer', 'u16'], result: 'pointer' },
  SizeofResource: { parameters: ['pointer', 'pointer'], result: 'u32' },
  LoadResource: { parameters: ['pointer', 'pointer'], result: 'pointer' },
  LockResource: { parameters: ['pointer'], result: 'pointer' },
} as const;
type Kernel32 = ReturnType<typeof kernel32>;

function wide(s: string): Uint16Array {
  const out = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A name as the resource API takes it (MAKEINTRESOURCE for an id); the returned buffer must stay alive for the call. */
function resPointer(name: ResName): [Deno.PointerValue, Uint16Array | null] {
  if (typeof name === 'number') return [Deno.UnsafePointer.create(BigInt(name)), null];
  const buf = wide(name);
  return [Deno.UnsafePointer.of(buf), buf];
}

function resNameOf(ptr: Deno.PointerValue): ResName {
  const value = Number(Deno.UnsafePointer.value(ptr));
  if (value < 0x10000) return value; // IS_INTRESOURCE
  const view = new Deno.UnsafePointerView(ptr!);
  let s = '';
  for (let i = 0;; i += 2) {
    const c = view.getUint16(i);
    if (!c) return s;
    s += String.fromCharCode(c);
  }
}

/** Every resource of the given types in a PE file, in the order the resource directory lists them (names, then ids). */
function readResourcesWith(lib: Kernel32, path: string, types: number[]): PeResource[] {
  const LOAD_LIBRARY_AS_DATAFILE = 0x2, LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;
  const h = lib.symbols.LoadLibraryExW(wide(path), null, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
  if (!h) throw new Error(`cannot open ${path} to read its resources`);
  const found: PeResource[] = [];
  try {
    for (const type of types) {
      const [typePtr] = resPointer(type);
      const names: ResName[] = [];
      const onName = new Deno.UnsafeCallback(
        { parameters: ['pointer', 'pointer', 'pointer', 'isize'], result: 'i32' } as const,
        (_h, _t, name) => (names.push(resNameOf(name)), 1),
      );
      lib.symbols.EnumResourceNamesW(h, typePtr, onName.pointer, 0n); // fails when the type is absent: no names
      onName.close();
      for (const name of names) {
        const [namePtr, keep] = resPointer(name);
        const langs: number[] = [];
        const onLang = new Deno.UnsafeCallback(
          { parameters: ['pointer', 'pointer', 'pointer', 'u16', 'isize'], result: 'i32' } as const,
          (_h, _t, _n, lang) => (langs.push(lang), 1),
        );
        lib.symbols.EnumResourceLanguagesW(h, typePtr, namePtr, onLang.pointer, 0n);
        onLang.close();
        for (const lang of langs) {
          const res = lib.symbols.FindResourceExW(h, typePtr, namePtr, lang);
          const size = res ? lib.symbols.SizeofResource(h, res) : 0;
          const ptr = res ? lib.symbols.LockResource(lib.symbols.LoadResource(h, res)) : null;
          const data = ptr && size ? new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(ptr, size)).slice() : new Uint8Array();
          found.push({ type, name, lang, data });
        }
        void keep;
      }
    }
  } finally {
    lib.symbols.FreeLibrary(h);
  }
  return found;
}

/** The icon resources (RT_GROUP_ICON and RT_ICON) of a PE file, read back through the Windows resource API. Windows only. */
export function readIconResources(path: string): { groups: PeResource[]; icons: PeResource[] } {
  const lib = kernel32();
  try {
    const all = readResourcesWith(lib, path, [RT_GROUP_ICON, RT_ICON]);
    return { groups: all.filter((r) => r.type === RT_GROUP_ICON), icons: all.filter((r) => r.type === RT_ICON) };
  } finally {
    lib.close();
  }
}

/**
 * Writes an .ico into a PE file as its icon: RT_ICON 1..n and one RT_GROUP_ICON, which takes the name and language of the file's
 * first existing group (the one Explorer shows), or id 1 and language neutral when it has none. Every other existing group and
 * icon is removed, so the new group is the only one. Windows only (fails clearly elsewhere).
 */
export function embedWindowsIcon(exe: string, ico: Uint8Array): void {
  const images = parseIco(ico);
  const lib = kernel32();
  try {
    const old = readResourcesWith(lib, exe, [RT_GROUP_ICON, RT_ICON]);
    const first = old.find((r) => r.type === RT_GROUP_ICON);
    const groupName: ResName = first?.name ?? 1;
    const lang = first?.lang ?? 0;
    const writes: [number, ResName, Uint8Array][] = [
      ...images.map((img, i): [number, ResName, Uint8Array] => [RT_ICON, i + 1, img.data]),
      [RT_GROUP_ICON, groupName, groupIconBytes(images, 1)],
    ];
    const written = (r: PeResource) => r.lang === lang && writes.some(([t, n]) => t === r.type && n === r.name);
    const handle = lib.symbols.BeginUpdateResourceW(wide(exe), 0);
    if (!handle) throw new Error(`cannot open ${exe} to update its resources`);
    let ok = true;
    const update = (type: number, name: ResName, l: number, data: Uint8Array | null) => {
      const [typePtr] = resPointer(type);
      const [namePtr, keep] = resPointer(name);
      ok = ok && lib.symbols.UpdateResourceW(handle, typePtr, namePtr, l, data, data?.length ?? 0) !== 0;
      void keep;
    };
    for (const r of old) if (!written(r)) update(r.type, r.name, r.lang, null); // delete
    for (const [type, name, data] of writes) update(type, name, lang, data);
    if (!ok) {
      lib.symbols.EndUpdateResourceW(handle, 1);
      throw new Error(`could not write the icon resources into ${exe}`);
    }
    if (!lib.symbols.EndUpdateResourceW(handle, 0)) throw new Error(`could not save the icon resources into ${exe}`);
  } finally {
    lib.close();
  }
}

function iconFor(os: Target['os'], stageDir: string): string {
  return os === 'windows' ? `${ICONS}/icon.ico` : os === 'macos' ? `${stageDir}/AIB.icns` : `${ICONS}/icon.png`;
}

async function desktop(stageDir: string, included: string[], target: Target, output: string): Promise<void> {
  const args = [
    'desktop',
    '-A',
    '--no-check',
    '--no-npm',
    '--config',
    `${stageDir}/deno.json`,
    '--target',
    target.triple,
    '--icon',
    iconFor(target.os, stageDir),
    '--output',
    output,
    ...included.flatMap((name) => ['--include', name]),
    'server/main.ts',
  ];
  const out = await new Deno.Command(Deno.execPath(), { args, cwd: stageDir, stdout: 'piped', stderr: 'piped' }).output();
  if (!out.success) {
    throw new Error(`deno desktop failed for ${target.id}:\n${new TextDecoder().decode(out.stderr).slice(-2000)}`);
  }
}

export interface Built {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

async function buildTarget(target: Target, version: string, stageDir: string, included: string[], out: string, work: string) {
  const dir = `${work}/${target.id}`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  const names = assetNames(version, target);
  const keeperBytes = (bytes: number) => console.log(`  ${target.id} keeper: ${(bytes / 1048576).toFixed(1)} MB`);
  if (target.os === 'windows') {
    await desktop(stageDir, included, target, `${dir}/${APP_NAME}`);
    embedWindowsIcon(`${dir}/${APP_NAME}/${APP_NAME}.exe`, await Deno.readFile(`${ICONS}/icon.ico`)); // --icon leaves the exe's icon as is
    keeperBytes(await buildKeeper(target, `${dir}/${APP_NAME}/${keeperFile(target)}`)); // AIB/AIB-keeper.exe
    await zipFolder(`${dir}/${APP_NAME}`, `${out}/${names[0]}`, APP_NAME);
  } else if (target.os === 'macos') {
    await desktop(stageDir, included, target, `${dir}/${APP_NAME}`); // deno desktop adds .app (AIB.app → AIB.app.app)
    keeperBytes(await buildKeeper(target, `${dir}/${APP_NAME}.app/Contents/MacOS/${keeperFile(target)}`)); // zipped 0755
    await zipFolder(`${dir}/${APP_NAME}.app`, `${out}/${names[0]}`, `${APP_NAME}.app`);
  } else {
    keeperBytes(await buildKeeper(target, `${dir}/${keeperFile(target)}`));
    const keeper = await Deno.readFile(`${dir}/${keeperFile(target)}`);
    await desktop(stageDir, included, target, `${dir}/${APP_NAME}.AppImage`);
    await fixAppImage(`${dir}/${APP_NAME}.AppImage`, APP_NAME, APP_IDENTIFIER); // .DirIcon, root 0755, Name/StartupWMClass
    await addToAppImage(`${dir}/${APP_NAME}.AppImage`, keeperFile(target), keeper, 0o755); // next to the top-level AIB
    await Deno.copyFile(`${dir}/${APP_NAME}.AppImage`, `${out}/${names[0]}`);
    await Deno.mkdir(`${dir}/deb`, { recursive: true });
    await desktop(stageDir, included, target, `${dir}/deb/aib.deb`);
    await fixDeb(`${dir}/deb/aib.deb`, APP_NAME); // deno desktop writes Name=aib
    await addToDeb(`${dir}/deb/aib.deb`, DEB_KEEPER_PATH, keeper, 0o755);
    await Deno.copyFile(`${dir}/deb/aib.deb`, `${out}/${names[1]}`);
  }
  return names;
}

/** A free local port from 8920 up (never the live Studio's 8767/8768). */
function freePort(from = 8920): number {
  for (let port = from; port < from + 200; port++) {
    try {
      const l = Deno.listen({ hostname: '127.0.0.1', port });
      l.close();
      const l2 = Deno.listen({ hostname: '127.0.0.1', port: port + 1 }); // the artifact origin
      l2.close();
      return port;
    } catch { /* taken */ }
  }
  throw new Error('no free port for the smoke check');
}

/**
 * Starts the built app headless (`AIB serve --in-process`, no window) with a fresh temp state folder and asks it for the page: the
 * page files must be inside the binary. Only for the target this machine can run. Stops what it started.
 */
export async function smokeCheck(exe: string): Promise<string> {
  const state = await Deno.makeTempDir({ prefix: 'aib-build-smoke-' });
  const port = freePort();
  const child = new Deno.Command(exe, {
    args: ['serve', '--in-process', '--port', String(port)],
    env: { AGENT_STUDIO_STATE_DIR: state },
    stdin: 'null',
    stdout: 'null',
    stderr: 'piped',
  }).spawn();
  let exited: number | null = null;
  child.status.then((st) => (exited = st.code));
  const stderr = new Response(child.stderr).text();
  try {
    for (let i = 0; i < 60 && exited === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
        const html = await page.text();
        const js = await fetch(`http://127.0.0.1:${port}/chat.js`, { signal: AbortSignal.timeout(3000) });
        await js.body?.cancel();
        if (page.status === 200 && html.includes('<html') && js.status === 200) return `page 200 on port ${port}`;
        throw new Error(`the built app answered ${page.status} for / and ${js.status} for /chat.js (page files not bundled?)`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('the built app')) throw error;
      }
    }
    throw new Error(`the built app did not serve the page (exit ${exited}): ${(await Promise.race([stderr, '']))?.slice(-1500)}`);
  } finally {
    if (exited === null) {
      if (Deno.build.os === 'windows') {
        await new Deno.Command('taskkill', { args: ['/PID', String(child.pid), '/T', '/F'], stdout: 'null', stderr: 'null' }).output();
      } else {
        try {
          child.kill('SIGTERM');
        } catch { /* gone */ }
      }
    }
    await child.status;
    await stderr.catch(() => '');
    await Deno.remove(state, { recursive: true }).catch(() => {});
  }
}

/** The built program this machine can run, for the smoke check, or null. */
function runnable(target: Target, work: string): string | null {
  if (target.triple !== Deno.build.target) return null;
  if (target.os === 'windows') return `${work}/${target.id}/${APP_NAME}/${APP_NAME}.exe`;
  if (target.os === 'macos') return `${work}/${target.id}/${APP_NAME}.app/Contents/MacOS/laufey_webview`;
  return null; // the AppImage needs FUSE; not checked here
}

function argValue(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : fallback;
}

export function table(rows: Built[]): string {
  const w = Math.max(...rows.map((r) => r.name.length), 5);
  const lines = [`${'asset'.padEnd(w)}  ${'MB'.padStart(7)}  sha256`];
  for (const r of rows) lines.push(`${r.name.padEnd(w)}  ${(r.bytes / 1048576).toFixed(1).padStart(7)}  ${r.sha256.slice(0, 16)}…`);
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const targets = parseTargets(argValue(argv, '--targets', 'all'));
  const outArg = argValue(argv, '--out', `${REPO}/dist`);
  const out = outArg.replaceAll('\\', '/').replace(/\/$/, '');
  const keep = argv.includes('--keep');
  const version = argValue(argv, '--version', APP_VERSION);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`--version ${version}: not a version like 0.1.0-beta.2`);
  await Deno.mkdir(out, { recursive: true });
  const stageDir = `${out}/.stage`;
  const work = `${out}/.build`;
  const included = await stage(stageDir, version);
  if (version !== APP_VERSION) await setStagedVersion(stageDir, version);
  console.log(`AIB ${version}: staged ${included.length} entries; building ${targets.map((t) => t.id).join(', ')}`);
  const names: string[] = [];
  for (const t of targets) {
    const started = Date.now();
    names.push(...await buildTarget(t, version, stageDir, included, out, work));
    console.log(`  ${t.id} built in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    const exe = argv.includes('--no-smoke') ? null : runnable(t, work);
    if (exe) console.log(`  ${t.id} smoke check: ${await smokeCheck(exe)}`);
  }
  // release.json: what the updater of a running AIB reads before "Install now" while chats work (can the new version attach to
  // the running agent host?). Listed in SHA256SUMS like every asset.
  await Deno.writeTextFile(`${out}/${RELEASE_INFO}`, releaseInfo(version) + '\n');
  names.push(RELEASE_INFO);
  const rows: Built[] = [];
  for (const name of names) {
    const path = `${out}/${name}`;
    rows.push({ name, path, bytes: (await Deno.stat(path)).size, sha256: await fileSha256(path) });
  }
  // Re-read the zips: macOS executables must keep their mode.
  for (const r of rows.filter((r) => r.name.includes('-macos-'))) {
    const listing = readZipListing(await Deno.readFile(r.path));
    const exes = listing.filter((e) => /\/Contents\/MacOS\/[^/]+$/.test(e.name));
    if (!exes.length || exes.some((e) => (e.mode & 0o111) === 0)) throw new Error(`${r.name}: Contents/MacOS files are not executable`);
  }
  await Deno.writeTextFile(`${out}/SHA256SUMS`, sha256sums(rows));
  console.log(table(rows));
  const over = rows.filter((r) => r.bytes > SIZE_LIMIT);
  if (!keep) {
    await Deno.remove(stageDir, { recursive: true }).catch(() => {});
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
  for (const r of over) console.error(`error: ${r.name} is over the size limit`);
  for (const r of rows) checkSize(r.name, r.bytes);
  console.log(`wrote ${rows.length} assets and SHA256SUMS to ${out}`);
  return over.length ? 1 : 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    Deno.exit(1);
  }
}
