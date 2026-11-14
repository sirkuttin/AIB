/**
 * server/worktrees/local_backup.ts: the daily zip of local-only folders (owner decision 7: one zip, replaced daily; Q1 b: no size
 * cap). A fake clock moves the days. The zips are opened by Python's zipfile (an independent reader: CRCs, UTF-8 names, bytes).
 * Temp repos and temp state folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { PYTHON } from './_connection.ts';
import { runGit, Sandbox, write } from './_worktree_fixtures.ts';
import * as backup from '../../outputs/agent-studio/server/worktrees/local_backup.ts';
import { addEntry, ensureDefault } from '../../outputs/agent-studio/server/worktrees/local_only.ts';
import { repoHash } from '../../outputs/agent-studio/server/worktrees/worktrees.ts';
import { join } from '../../outputs/agent-studio/server/platform/ospath.ts';

const DAY = backup.DAY_MS;
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);

const READER = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    out = {'bad': bad, 'files': {i.filename: [i.file_size, i.compress_type, z.read(i.filename).hex()] for i in z.infolist()}}
print(json.dumps(out))
`;

interface Opened {
  bad: string | null;
  files: Record<string, [number, number, string]>;
}

async function openZip(path: string): Promise<Opened> {
  const out = await new Deno.Command(PYTHON, { args: ['-I', '-c', READER, path], stdout: 'piped', stderr: 'piped' }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

const hex = (b: string | Uint8Array) => [...(typeof b === 'string' ? new TextEncoder().encode(b) : b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function project(box: Sandbox): Promise<void> {
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  await ensureDefault(box.project); // /private in the temp repo's own exclude
}

Deno.test('backup: made once, kept within the day, skipped when nothing changed, replaced the next day (one zip), and it opens', async () => {
  using box = new Sandbox();
  await project(box);
  write(box.project, 'private/TASKS.md', 'first\n');
  write(box.project, 'private/designs/ünïcode é.txt', 'utf-8 name\n');
  const blob = new Uint8Array(300_000).map((_, i) => (i * 7919) % 251); // bigger than one read chunk, not very compressible
  write(box.project, 'private/data.bin', blob);
  write(box.project, 'private/empty.txt', '');
  write(box.project, 'private/node_modules/x.js', 'skipped\n');
  write(box.project, 'tracked-not-local.txt', 'not backed up\n');

  const first = await backup.backupProject(box.state, box.project, T0);
  assertEquals(first.status, 'made');
  const zip = join(box.state, backup.FOLDER, repoHash(box.project) + '.zip');
  assertEquals(first.zip, zip);
  const opened = await openZip(zip);
  assertEquals(opened.bad, null, 'every CRC checks out');
  assertEquals(Object.keys(opened.files).sort(), ['private/TASKS.md', 'private/data.bin', 'private/designs/ünïcode é.txt', 'private/empty.txt']);
  assertEquals(opened.files['private/TASKS.md'][2], hex('first\n'));
  assertEquals(opened.files['private/data.bin'][2], hex(blob));
  assertEquals(opened.files['private/data.bin'][1], 8, 'deflated');
  assertEquals(opened.files['private/empty.txt'][0], 0);
  const meta = JSON.parse(Deno.readTextFileSync(zip.replace(/\.zip$/, '.json')));
  assertEquals([meta.project, meta.files, meta.time, meta.skipped], [box.project, 4, T0, []]);

  assertEquals((await backup.backupProject(box.state, box.project, T0 + DAY / 2)).status, 'recent');
  write(box.project, 'private/TASKS.md', 'second\n');
  assertEquals((await backup.backupProject(box.state, box.project, T0 + DAY / 2)).status, 'recent', 'once a day, even when it changed');
  const next = await backup.backupProject(box.state, box.project, T0 + DAY);
  assertEquals(next.status, 'made');
  assertEquals((await openZip(zip)).files['private/TASKS.md'][2], hex('second\n'));
  assertEquals((await backup.backupProject(box.state, box.project, T0 + 3 * DAY)).status, 'unchanged');
  const kept = [...Deno.readDirSync(join(box.state, backup.FOLDER))].map((e) => e.name).filter((n) => !n.endsWith('.lock')).sort();
  assertEquals(kept, [repoHash(box.project) + '.json', repoHash(box.project) + '.zip'], 'only one zip, no partial left');
});

Deno.test('backup: every local-only entry (files too), no cap; nothing for projects without local-only files or without git', async () => {
  using box = new Sandbox();
  assertEquals((await backup.backupProject(box.state, box.project, T0)).status, 'none', 'no AIB block yet');
  await project(box);
  assertEquals((await backup.backupProject(box.state, box.project, T0)).status, 'none', '/private excluded but no folder');
  write(box.project, 'notes.md', 'a local-only file\n');
  assert((await addEntry(box.project, 'notes.md')).ok);
  write(box.project, 'private/a.txt', 'a\n');
  const made = await backup.backupProject(box.state, box.project, T0);
  assertEquals(made.status, 'made');
  assertEquals(Object.keys((await openZip(made.zip!)).files).sort(), ['notes.md', 'private/a.txt']);
  const plain = join(box.base, 'plain');
  Deno.mkdirSync(join(plain, 'private'), { recursive: true });
  write(plain, 'private/x.txt', 'x\n');
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
  write(box.project, 'private/a.txt', 'one\n');
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
  write(box.project, 'private/a.txt', 'two\n');
  const held = Deno.openSync(zip, { read: true });
  try {
    const later = await backup.backupProject(box.state, box.project, T0 + DAY);
    if (later.status === 'busy') { // the rename was refused: the old zip is whole and the partial is gone
      assertEquals((await openZip(zip)).files['private/a.txt'][2], hex('one\n'));
      assert(!Deno.readDirSync(join(box.state, backup.FOLDER)).some((e) => e.name.endsWith('.partial')));
    } else assertEquals(later.status, 'made'); // Deno opened it with delete sharing: the rename went through
  } finally {
    held.close();
  }
});

Deno.test('crc32 matches the standard check value', () => {
  assertEquals(backup.crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
});
