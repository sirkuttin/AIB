/**
 * The file editor for WSL projects (AIB 0.13.0; files/file_io.ts WslIo, wsl/helper/editor.ts) without a distro: a fake WslHost
 * whose helper calls run the real helper methods (editorMethods, fs.stat) on a temp Windows folder standing in for the distro (the
 * Linux paths are mapped at the last step), so the registry, the settled read in pieces, the save's raw-byte check right before the
 * rename and the guard are the real code. The real-distro run is file_editor_wsl_e2e_test.ts.
 *   - open, type, save through the helper; CRLF and BOM kept; a file over 1 MB read and written in pieces
 *   - a disk change merges in; a save whose disk changed between AIB's read and the rename is refused 'changed' (disk_busy), then
 *     merges and saves
 *   - a distro that is away: the poll never marks the file deleted, a save answers wsl_away and the text stays
 *   - the guard: .git, out of the project, the sign-in folders AIB names, AIB's own data folder, aib-docs
 *   - the helper alone: expect null on an existing file, leftover temp files swept, the save temp name refused
 */
import { assert, assertEquals } from './_assert.ts';
import { LiveFiles } from '../../app/server/files/live_files.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { type HelperMethods, WslHelperError, type WslHost } from '../../app/server/wsl/contract.ts';
import { editorMethods } from '../../app/server/wsl/helper/editor.ts';
import { RpcError } from '../../app/server/wsl/helper/rpc.ts';
import type { HelperContext } from '../../app/server/wsl/helper/methods.ts';

type Json = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST = { pollMs: 200, tickMs: 100, settleMs: 40, storeMs: 50, closeGraceMs: 300, saveWaitMs: 600 };
const T = { sanitizeResources: false, sanitizeOps: false };

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/** A temp folder standing in for the distro's "/": Linux path <-> Windows path. */
class Distro {
  readonly base = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-fe-wsl-' })).replace(/^\\\\\?\\/, '');
  win = (linux: string) => this.base + linux.replaceAll('/', '\\');
  linux = (win: string) => {
    const w = win.replace(/^\\\\\?\\/, '');
    if (!w.toLowerCase().startsWith(this.base.toLowerCase())) throw new Error('outside the fake distro: ' + win);
    return w.slice(this.base.length).replaceAll('\\', '/') || '/';
  };
  write(linux: string, bytes: Uint8Array | string): void {
    Deno.mkdirSync(this.win(linux.slice(0, linux.lastIndexOf('/')) || '/'), { recursive: true });
    Deno.writeFileSync(this.win(linux), typeof bytes === 'string' ? enc(bytes) : bytes);
  }
  read(linux: string): Uint8Array {
    return Deno.readFileSync(this.win(linux));
  }
  text(linux: string): string {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(this.read(linux));
  }
}

function helperCtx(d: Distro): HelperContext {
  return {
    env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home: d.win('/home/u'), arch: 'x64' }),
    own: [d.win('/aib'), d.win('/aib/data-1')],
    data: d.win('/aib/data-1'),
    root: d.win('/aib'),
    aibStart: { version: '', test: false },
  };
}

/** A ready WslHost whose helper is the real editor methods on the fake distro. */
class FakeHost implements WslHost {
  readonly distro = 'Ubuntu';
  state: WslHost['state'] = 'ready';
  readonly note = '';
  readonly link = null;
  readonly helperVersion = 'test';
  calls: { method: string; params: Json }[] = [];
  /** Runs before each editor.write piece that is `done` (a test writes the disk "between AIB's read and the rename"). */
  beforeCommit: (() => void) | null = null;
  readonly methods;
  constructor(readonly d: Distro) {
    this.methods = editorMethods(helperCtx(d), { owners: false });
  }
  async call<M extends keyof HelperMethods>(method: M, params: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']> {
    if (this.state !== 'ready') throw new WslHelperError('Ubuntu stopped', 'stopped');
    const p = { ...(params as Json) };
    this.calls.push({ method, params: p });
    try {
      if (method === 'fs.stat') {
        try {
          const st = Deno.statSync(this.d.win(String(p.path)));
          return { exists: true, isDir: st.isDirectory, isFile: st.isFile, size: st.size, mtimeMs: st.mtime?.getTime() ?? 0 } as never;
        } catch {
          return { exists: false, isDir: false, isFile: false, size: 0, mtimeMs: 0 } as never;
        }
      }
      if (!method.startsWith('editor.')) throw new WslHelperError('No method ' + method, 'no_method');
      if (method === 'editor.write' && p.done === true) this.beforeCommit?.();
      const mapped = { ...p, root: this.d.win(String(p.root)), blocked: ((p.blocked as string[]) ?? []).map(this.d.win) };
      const r = await this.methods[method](mapped) as Json;
      return (typeof r.real === 'string' ? { ...r, real: this.d.linux(r.real) } : r) as never;
    } catch (error) {
      if (error instanceof WslHelperError) throw error;
      const code = error instanceof RpcError
        ? String(error.data?.code ?? 'helper_error')
        : String((error as { code?: unknown }).code ?? 'helper_error');
      throw new WslHelperError((error as Error).message, code);
    }
  }
  env() {
    return Promise.resolve({});
  }
  onOpenUrl() {
    return () => {};
  }
  start() {
    return Promise.resolve();
  }
  reconnect() {
    return Promise.resolve();
  }
}

class AibHost {
  liveCall(name: string): Promise<[number, unknown]> {
    if (name === 'files-changed') return Promise.resolve([200, { instance: 'i', seq: 0, events: [] }]);
    if (name === 'folder-chats') return Promise.resolve([200, { chats: [] }]);
    return Promise.resolve([200, { ok: true }]);
  }
  conversations() {
    return [];
  }
  connectionOf() {
    return null;
  }
}

function setup() {
  const d = new Distro();
  const host = new FakeHost(d);
  setWslHostResolver((key) => (key === 'ubuntu' ? host : null));
  const state = Deno.makeTempDirSync({ prefix: 'aib-fe-wsl-state-' });
  const aib = new AibHost();
  const files = new LiveFiles(
    { stateDir: state, liveCall: (n) => aib.liveCall(n), conversations: () => [], connectionOf: () => null },
    FAST,
  );
  files.start();
  const done = () => {
    files.close();
    setWslHostResolver(null);
    for (const p of [d.base, state]) {
      try {
        Deno.removeSync(p, { recursive: true });
      } catch { /* in use */ }
    }
  };
  return { d, host, files, done, root: 'wsl://ubuntu/home/u/app' };
}

Deno.test('WSL file: open, type, save; CRLF and BOM kept; big file in pieces', T, async () => {
  const { d, host, files, done, root } = setup();
  try {
    d.write('/home/u/app/src/a.ts', '﻿one\r\ntwo\r\nthree\r\n');
    const got = await files.openFile(root, 'src/a.ts');
    assert('file' in got, 'a WSL file opens for editing: ' + JSON.stringify(got));
    const lf = got.file;
    assertEquals(lf.place.abs, 'wsl://ubuntu/home/u/app/src/a.ts');
    assertEquals(lf.place.root, root);
    assertEquals(lf.base.bom, true);
    assertEquals(lf.base.eolKind, 'crlf');
    assertEquals(lf.text.toString(), 'one\ntwo\nthree\n');
    const r = await files.save(lf.id, { text: 'one\nTWO\nthree\n' });
    assert(r.ok, 'saved: ' + JSON.stringify(r));
    assertEquals(d.text('/home/u/app/src/a.ts'), '﻿one\r\nTWO\r\nthree\r\n', 'BOM and CRLF kept, written in the distro');
    assert(
      host.calls.some((c) => c.method === 'editor.write' && c.params.done === true && typeof c.params.expect === 'string'),
      'the save sent the raw-byte sha',
    );
    assertEquals([...Deno.readDirSync(d.win('/home/u/app/src'))].map((e) => e.name), ['a.ts'], 'no temp file left');

    // over 1 MB: read and written in pieces
    const line = 'x'.repeat(99) + '\n';
    d.write('/home/u/app/big.txt', line.repeat(25_000)); // 2.5 MB
    const big = await files.openFile(root, 'big.txt');
    assert('file' in big);
    assertEquals(big.file.text.toString().length, 2_500_000);
    const r2 = await files.save(big.file.id, { text: 'top\n' + line.repeat(25_000) });
    assert(r2.ok, JSON.stringify(r2));
    assertEquals(d.read('/home/u/app/big.txt').length, 2_500_004);
    assert(
      host.calls.filter((c) => c.method === 'editor.write' && c.params.root === '/home/u/app' && c.params.rel === 'big.txt').length >= 3,
      'three pieces',
    );
  } finally {
    done();
  }
});

Deno.test('WSL file: a disk change merges in; a write right before the rename is caught, merged and saved', T, async () => {
  const { d, host, files, done, root } = setup();
  try {
    d.write('/home/u/app/m.txt', 'a\nb\nc\nd\n');
    const got = await files.openFile(root, 'm.txt');
    assert('file' in got);
    const lf = got.file;
    lf.doc.transact(() => lf.text.insert(0, 'A0 ')); // the user's unsaved edit on line 1
    d.write('/home/u/app/m.txt', 'a\nb\nc\nD-agent\n'); // the agent changes line 4 in the distro
    await until(() => lf.text.toString().includes('D-agent'), 'the disk change merged');
    assertEquals(lf.text.toString(), 'A0 a\nb\nc\nD-agent\n');

    // between AIB's read and the rename another write lands: the helper's check refuses, the next save merges it
    host.beforeCommit = () => {
      host.beforeCommit = null;
      d.write('/home/u/app/m.txt', 'a\nb-agent\nc\nD-agent\n');
    };
    const r = await files.save(lf.id, {});
    assertEquals(r.ok ? 'ok' : r.code, 'disk_busy', 'the check right before the rename');
    assertEquals(d.text('/home/u/app/m.txt'), 'a\nb-agent\nc\nD-agent\n', 'the agent write was not overwritten');
    const r2 = await files.save(lf.id, {});
    assert(r2.ok, JSON.stringify(r2));
    assertEquals(d.text('/home/u/app/m.txt'), 'A0 a\nb-agent\nc\nD-agent\n');

    // a real conflict: the same line on both sides
    lf.doc.transact(() => lf.text.insert(0, 'X'));
    d.write('/home/u/app/m.txt', 'agent line one\nb-agent\nc\nD-agent\n');
    const r3 = await files.save(lf.id, {});
    assertEquals(r3.ok ? 'ok' : r3.code, 'merged', 'overlap: the user sees it and saves again');
    const r4 = await files.save(lf.id, {});
    assert(r4.ok, 'keep mine');
    assert(d.text('/home/u/app/m.txt').startsWith('XA0 a'), d.text('/home/u/app/m.txt'));
  } finally {
    done();
  }
});

Deno.test('WSL file: a distro that is away never reads as deleted; save answers wsl_away and keeps the text', T, async () => {
  const { d, host, files, done, root } = setup();
  try {
    d.write('/home/u/app/w.txt', 'one\n');
    const got = await files.openFile(root, 'w.txt');
    assert('file' in got);
    const lf = got.file;
    lf.doc.transact(() => lf.text.insert(0, 'mine '));
    host.state = 'stopped';
    await sleep(FAST.pollMs * 3);
    assertEquals(lf.meta.get('disk') ?? 'ok', 'ok', 'not deleted while away');
    const r = await files.save(lf.id, {});
    assertEquals(r.ok ? 'ok' : r.code, 'wsl_away');
    assertEquals(lf.text.toString(), 'mine one\n');
    host.state = 'ready';
    const r2 = await files.save(lf.id, {});
    assert(r2.ok, JSON.stringify(r2));
    assertEquals(d.text('/home/u/app/w.txt'), 'mine one\n');
  } finally {
    done();
  }
});

Deno.test('WSL file: unsaved text is stored by the project ref and goes with the project removal (forgetProject)', T, async () => {
  const { d, files, done, root } = setup();
  try {
    d.write('/home/u/app/u.txt', 'one\n');
    const got = await files.openFile(root, 'u.txt');
    assert('file' in got);
    got.file.doc.transact(() => got.file.text.insert(0, 'unsaved '));
    await until(() => files.stored(root).length === 1, 'stored');
    assertEquals(files.stored(root)[0].place.abs, 'wsl://ubuntu/home/u/app/u.txt');
    files.forgetProject(root);
    assertEquals(files.stored(root).length, 0);
    assertEquals(files.get(got.file.id), null);
    assertEquals(d.text('/home/u/app/u.txt'), 'one\n', 'the file itself is untouched');
  } finally {
    done();
  }
});

Deno.test('WSL file: the guard (.git, out of the project, sign-in folders, AIB data, aib-docs)', T, async () => {
  const { d, files, done, root } = setup();
  try {
    d.write('/home/u/app/.git/config', '[core]\n');
    d.write('/home/u/app/aib-docs/p/01.md', '# x\n');
    d.write('/home/u/secret.txt', 'no\n');
    let code = '';
    try {
      await files.openFile(root, '.git/config');
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    assertEquals(code, 'hidden', '.git is never opened');
    code = '';
    try {
      await files.openFile(root, '../secret.txt');
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    assert(code !== '', '.. out of the project is refused');
    assertEquals(await files.openFile(root, 'aib-docs/p/01.md'), { refused: 'docs' });

    // AIB's own data folder in the distro, and a chat's copy in it
    d.write('/aib/data-1/worktrees/c1/f.txt', 'x\n');
    d.write('/aib/data-1/keeper/k.json', '{}\n');
    assertEquals(await files.openFile('wsl://ubuntu/aib/data-1/worktrees/c1', 'f.txt'), { refused: 'worktree' });
    assertEquals(await files.openFile('wsl://ubuntu/aib/data-1', 'keeper/k.json'), { refused: 'data' });

    // the sign-in folders: by the /home/<user> rule
    d.write('/home/u/.ssh/config', 'Host x\n');
    d.write('/home/u/.claude/settings.json', '{}\n');
    assertEquals(await files.openFile('wsl://ubuntu/home/u', '.ssh/config'), { refused: 'blocked' });
    assertEquals(await files.openFile('wsl://ubuntu/home/u', '.claude/settings.json'), { refused: 'blocked' });
  } finally {
    done();
  }
});

Deno.test('WSL helper editor methods: expect, sweep, temp names, blocked list', T, async () => {
  const d = new Distro();
  try {
    const m = editorMethods(helperCtx(d), { owners: false });
    d.write('/p/f.txt', 'hello\n');
    const root = d.win('/p');
    const codeOf = async (fn: () => unknown) => {
      try {
        await fn();
        return 'ok';
      } catch (e) {
        return String((e as RpcError).data?.code ?? (e as { code?: string }).code ?? 'error');
      }
    };
    // expect null: the file must not exist
    assertEquals(
      await codeOf(() =>
        m['editor.write']({ root, rel: 'f.txt', token: '0123abcd', offset: 0, bytesB64: btoa('x'), done: true, expect: null })
      ),
      'changed',
    );
    assertEquals(d.text('/p/f.txt'), 'hello\n');
    assertEquals([...Deno.readDirSync(root)].length, 1, 'the refused temp file is removed');
    // a deleted file is written back with expect null
    assertEquals(
      await codeOf(() =>
        m['editor.write']({ root, rel: 'new.txt', token: '0123abce', offset: 0, bytesB64: btoa('n'), done: true, expect: null })
      ),
      'ok',
    );
    assertEquals(d.text('/p/new.txt'), 'n');
    // the folders AIB names
    d.write('/p/home/.codex/auth.json', '{}');
    assertEquals(
      await codeOf(() => m['editor.read']({ root, rel: 'home/.codex/auth.json', blocked: [d.win('/p/home/.codex')] })),
      'blocked',
    );
    // the save temp name itself
    d.write('/p/.aib-save-00000000.tmp', 'x');
    assertEquals(await codeOf(() => m['editor.read']({ root, rel: '.aib-save-00000000.tmp' })), 'data');
    // sweep: only old temp files
    const old = new Date(Date.now() - 120_000);
    Deno.utimeSync(d.win('/p/.aib-save-00000000.tmp'), old, old);
    d.write('/p/.aib-save-11111111.tmp', 'fresh');
    const s = await m['editor.sweep']({ root, rel: 'f.txt' }) as Json;
    assertEquals(s.swept, 1);
    assertEquals(d.text('/p/.aib-save-11111111.tmp'), 'fresh', 'a fresh temp file stays');
    // a settled read of a file that changes during the pause
    const reading = m['editor.read']({ root, rel: 'f.txt', settleMs: 200 }) as Promise<Json>;
    await sleep(50);
    d.write('/p/f.txt', 'changed meanwhile, longer\n');
    assertEquals((await reading).state, 'moving');
  } finally {
    Deno.removeSync(d.base, { recursive: true });
  }
});
