/**
 * server/worktrees/local_backup.ts: the daily zip of local-only folders (owner decision 7: one zip, replaced daily; Q1 b: no size
 * cap). A fake clock moves the days. The zips are opened by a small reader written here from the zip format (an independent reader: CRCs, UTF-8 names, bytes).
 * Temp repos and temp state folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { inflateRawSync } from 'node:zlib';
import { runGit, Sandbox, write } from './_worktree_fixtures.ts';
import * as backup from '../../app/server/worktrees/local_backup.ts';
import { addEntry, ensureDefault } from '../../app/server/worktrees/local_only.ts';
import { repoHash } from '../../app/server/worktrees/worktrees.ts';
import { join } from '../../app/server/platform/ospath.ts';

const DAY = backup.DAY_MS;
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);

interface Opened {
  bad: string | null;
  files: Record<string, [number, number, string]>;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zipfile.ZipFile + testzip(): the central directory, each entry's size, method and bytes (CRC checked, names UTF-8). */
function openZip(path: string): Opened {
  const data = Deno.readFileSync(path);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('no end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Opened = { bad: null, files: {} };
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = utf8.decode(data.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const bodyAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = data.subarray(bodyAt, bodyAt + packed);
    const bytes = method === 0 ? body : method === 8 ? new Uint8Array(inflateRawSync(body)) : null;
    if (!bytes) throw new Error(`unsupported method ${method}`);
    if ((bytes.length !== size || crc32(bytes) !== crc) && out.bad === null) out.bad = name;
    out.files[name] = [size, method, [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('')];
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const hex = (b: string | Uint8Array) => [...(typeof b === 'string' ? new TextEncoder().encode(b) : b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function project(box: Sandbox): Promise<void> {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  await ensureDefault(box.project); // /aib-shared in the temp repo's own exclude
}

Deno.test('backup: made once, kept within the day, skipped when nothing changed, replaced the next day (one zip), and it opens', async () => {
  using box = new Sandbox();
  await project(box);
  write(box.project, 'aib-shared/TASKS.md', 'first\n');
  write(box.project, 'aib-shared/designs/ünïcode é.txt', 'utf-8 name\n');
  const blob = new Uint8Array(300_000).map((_, i) => (i * 7919) % 251); // bigger than one read chunk, not very compressible
  write(box.project, 'aib-shared/data.bin', blob);
  write(box.project, 'aib-shared/empty.txt', '');
  write(box.project, 'aib-shared/node_modules/x.js', 'skipped\n');
  write(box.project, 'tracked-not-local.txt', 'not backed up\n');

  const first = await backup.backupProject(box.state, box.project, T0);
  assertEquals(first.status, 'made');
  const zip = join(box.state, backup.FOLDER, repoHash(box.project) + '.zip');
  assertEquals(first.zip, zip);
  const opened = await openZip(zip);
  assertEquals(opened.bad, null, 'every CRC checks out');
  assertEquals(Object.keys(opened.files).sort(), ['aib-shared/TASKS.md', 'aib-shared/data.bin', 'aib-shared/designs/ünïcode é.txt', 'aib-shared/empty.txt']);
  assertEquals(opened.files['aib-shared/TASKS.md'][2], hex('first\n'));
  assertEquals(opened.files['aib-shared/data.bin'][2], hex(blob));
  assertEquals(opened.files['aib-shared/data.bin'][1], 8, 'deflated');
  assertEquals(opened.files['aib-shared/empty.txt'][0], 0);
  const meta = JSON.parse(Deno.readTextFileSync(zip.replace(/\.zip$/, '.json')));
  assertEquals([meta.project, meta.files, meta.time, meta.skipped], [box.project, 4, T0, []]);

  assertEquals((await backup.backupProject(box.state, box.project, T0 + DAY / 2)).status, 'recent');
  write(box.project, 'aib-shared/TASKS.md', 'second\n');
  assertEquals((await backup.backupProject(box.state, box.project, T0 + DAY / 2)).status, 'recent', 'once a day, even when it changed');
  const next = await backup.backupProject(box.state, box.project, T0 + DAY);
  assertEquals(next.status, 'made');
  assertEquals((await openZip(zip)).files['aib-shared/TASKS.md'][2], hex('second\n'));
  assertEquals((await backup.backupProject(box.state, box.project, T0 + 3 * DAY)).status, 'unchanged');
  const kept = [...Deno.readDirSync(join(box.state, backup.FOLDER))].map((e) => e.name).filter((n) => !n.endsWith('.lock')).sort();
  assertEquals(kept, [repoHash(box.project) + '.json', repoHash(box.project) + '.zip'], 'only one zip, no partial left');
});

Deno.test('backup: every local-only entry (files too), no cap; nothing for projects without local-only files or without git', async () => {
  using box = new Sandbox();
  assertEquals((await backup.backupProject(box.state, box.project, T0)).status, 'none', 'no AIB block yet');
  await project(box);
  assertEquals((await backup.backupProject(box.state, box.project, T0)).status, 'none', '/aib-shared excluded but no folder');
  write(box.project, 'notes.md', 'a local-only file\n');
  assert((await addEntry(box.project, 'notes.md')).ok);
  write(box.project, 'aib-shared/a.txt', 'a\n');
  const made = await backup.backupProject(box.state, box.project, T0);
  assertEquals(made.status, 'made');
  assertEquals(Object.keys((await openZip(made.zip!)).files).sort(), ['aib-shared/a.txt', 'notes.md']);
  const plain = join(box.base, 'plain');
  Deno.mkdirSync(join(plain, 'aib-shared'), { recursive: true });
  write(plain, 'aib-shared/x.txt', 'x\n');
  assertEquals((await backup.backupProject(box.state, plain, T0)).status, 'none');
  assertEquals((await backup.backupProject(box.state, join(box.base, 'gone'), T0)).status, 'none');
});

Deno.test('backup: a file that cannot be read is skipped and listed; the zip around it is still whole', async () => {
  using box = new Sandbox();
  write(box.project, 'a.txt', 'aaa\n');
  write(box.project, 'c.txt', 'ccc\n');
  const zip = join(box.base, 'out.zip');
  const item = (rel: string) => ({ rel, abs: join(box.project, rel), size: 4, mtime: T0 });
  const skipped = await backup.writeZip(zip, [item('a.txt'), item('b-missing.txt'), item('c.txt')]);
  assertEquals(skipped.map((s) => s.path), ['b-missing.txt']);
  assert(skipped[0].reason.includes('NotFound'), skipped[0].reason);
  const opened = await openZip(zip);
  assertEquals([opened.bad, Object.keys(opened.files)], [null, ['a.txt', 'c.txt']]);
  assertEquals(opened.files['c.txt'][2], hex('ccc\n'));
});

Deno.test('backup: an open old zip that cannot be replaced keeps the old one; the schedule backs up each project once per run', async () => {
  using box = new Sandbox();
  await project(box);
  write(box.project, 'aib-shared/a.txt', 'one\n');
  const runner = backup.startLocalBackups({
    stateDir: box.state,
    projects: () => [box.project, box.project, join(box.base, 'nothing-here')],
    now: () => T0,
    schedule: false,
  });
  const results = await runner.runOnce();
  assertEquals([...results.values()].map((r) => r.status), ['made', 'none']);
  runner.stop();
  if (Deno.build.os !== 'windows') return; // only Windows refuses to replace a file that is open
  const zip = results.get(box.project)!.zip!;
  write(box.project, 'aib-shared/a.txt', 'two\n');
  const held = Deno.openSync(zip, { read: true });
  try {
    const later = await backup.backupProject(box.state, box.project, T0 + DAY);
    if (later.status === 'busy') { // the rename was refused: the old zip is whole and the partial is gone
      assertEquals((await openZip(zip)).files['aib-shared/a.txt'][2], hex('one\n'));
      assert(!Deno.readDirSync(join(box.state, backup.FOLDER)).some((e) => e.name.endsWith('.partial')));
    } else assertEquals(later.status, 'made'); // Deno opened it with delete sharing: the rename went through
  } finally {
    held.close();
  }
});

Deno.test('crc32 matches the standard check value', () => {
  assertEquals(backup.crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
});
