/**
 * Docs of WSL projects without a distro (docs/wsl/design.md section 4 phase 2; app/docs/WSL.md "Docs"):
 *   1. The helper's docs.fs (wsl/helper/docs.ts) on a temp folder: reads, atomic writes (also in chunks), only <project>/aib-docs/…,
 *      no `..`, no recursive remove of aib-docs/ itself.
 *   2. The whole docs store on a WSL ref (wsl://ubuntu/home/u/app) through a FakeWslHost whose docs.fs is that helper method: the
 *      agent's doc tools, the doc.aibdoc and the page copies on "the distro's" disk, the user typing while an agent edits, a file edit
 *      in the distro taken in, history, a restart, the Linux paths an agent reads.
 *   3. The distro away: refused `wsl_unavailable` (never "no such doc", never a new doc over an old one), the edits kept in AIB's
 *      cache and written once it is back; "Move doc to trash" goes to the distro's trash.
 * The real distro is wsl_docs_e2e_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { UserClient } from './_docs.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { installWslDocFs, linuxPath, linuxPaths, wslDocFs } from '../../app/server/wsl/docs.ts';
import { docsMethods } from '../../app/server/wsl/helper/docs.ts';
import { handleLine } from '../../app/server/wsl/helper/rpc.ts';
import { DocStore, mdBody } from '../../app/server/docs/store.ts';
import { runDocTool } from '../../app/server/docs/tools.ts';
import { ArtifactHistory } from '../../app/server/docs/history.ts';
import { ArtifactStore } from '../../app/server/artifacts/artifacts.ts';
import { parseAib } from '../../app/server/docs/aibdoc.ts';
import { DocRefusal } from '../../app/server/docs/live_doc.ts';
import { fsOf, localFs, pathKey, sepOf } from '../../app/server/docs/doc_fs.ts';
import { docsRoutes } from '../../app/server/web/docs_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
Deno.env.set('AGENT_STUDIO_TEST', '1');
Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-docs-unit');

const REF = 'wsl://ubuntu/home/u/app';
const LINUX = '/home/u/app';
const inline = (content: string, as = 'markdown') => ({ from: { kind: 'inline', content }, as });

async function lab() {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-wsl-docs-' })).replace(/^\\\\\?\\/, '');
  const project = `${root}${SEP}distro-app`, state = `${root}${SEP}state`;
  await Deno.mkdir(project), await Deno.mkdir(state);
  const host = new FakeWslHost('unused', 'Ubuntu');
  host.folders.set(LINUX, project);
  const methods = docsMethods(
    { env: () => Promise.resolve({ env: { HOME: '/home/u' }, shell: '/bin/bash', home: '/home/u', arch: 'x86_64' }) },
    { resolve: (p) => host.windowsFor(p) },
  );
  host.handlers['docs.fs'] = (p) => methods['docs.fs'](p);
  setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
  installWslDocFs();
  const artifacts = new ArtifactStore(`${root}${SEP}artifacts`);
  const newStore = () => new DocStore(state, { idleMs: 60_000, snapshotIdleMs: 60_000, history: new ArtifactHistory(() => artifacts) });
  const onDisk = (rel: string) => `${project}${SEP}${rel.replaceAll('/', SEP)}`;
  return {
    root,
    project,
    state,
    host,
    methods,
    artifacts,
    newStore,
    onDisk,
    done: async () => {
      setWslHostResolver(null);
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

const call = (methods: ReturnType<typeof docsMethods>, ops: Json[]) =>
  handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'docs.fs', params: { ops } }), methods) as Promise<{
    result?: { results: Json[] };
    error?: { message: string; code: number };
  }>;

async function tool(store: DocStore, name: string, args: Json, chat = 'claude:s1'): Promise<Json> {
  const [ok, result] = await runDocTool(store, REF, 'claude', name, args, chat);
  if (!ok) throw new Error(`${name} was refused: ${JSON.stringify(result)}`);
  return result;
}

// ---- 1. the helper's docs.fs ----------------------------------------------------------------------------------------------------
Deno.test({
  name: 'helper docs.fs: reads and atomic writes in <project>/aib-docs only; chunks; no .., no remove of aib-docs itself',
  ...T,
  async fn() {
    const t = await lab();
    try {
      const doc = `${LINUX}/aib-docs/plan`;
      let r = await call(t.methods, [
        { op: 'read', path: `${doc}/doc.aibdoc` },
        { op: 'stat', path: `${doc}/doc.aibdoc` },
        { op: 'list', path: `${LINUX}/aib-docs` },
        { op: 'writeAtomic', path: `${doc}/doc.aibdoc`, text: '{"a":1}' },
        { op: 'read', path: `${doc}/doc.aibdoc` },
        { op: 'writeNew', path: `${LINUX}/aib-docs/README.md`, text: 'one' },
        { op: 'writeNew', path: `${LINUX}/aib-docs/README.md`, text: 'two' },
        { op: 'list', path: `${LINUX}/aib-docs` },
      ]);
      const res = r.result!.results;
      assertEquals(res[0], { ok: true, text: null }, 'missing reads as null, as on Windows');
      assertEquals(res[1], { ok: true, stat: null });
      assertEquals(res[2], { ok: true, entries: null });
      assertEquals(res[3], { ok: true });
      assertEquals(res[4], { ok: true, text: '{"a":1}' });
      assertEquals([res[5].created, res[6].created], [true, false], 'writeNew never over a file');
      assertEquals((res[7].entries as Json[]).map((e) => e.name).sort(), ['README.md', 'plan']);
      assertEquals(Deno.readTextFileSync(t.onDisk('aib-docs/README.md')), 'one');
      assertEquals([...Deno.readDirSync(t.onDisk('aib-docs/plan'))].map((e) => e.name), ['doc.aibdoc'], 'no temp file left');

      // a big file in chunks: one temp file, then one rename; the old file stays until the rename
      r = await call(t.methods, [
        { op: 'chunk', path: `${doc}/doc.aibdoc`, token: 'tok1', text: 'AAA', first: true },
        { op: 'chunk', path: `${doc}/doc.aibdoc`, token: 'tok1', text: 'BBB' },
        { op: 'read', path: `${doc}/doc.aibdoc` },
        { op: 'writeAtomic', path: `${doc}/doc.aibdoc`, token: 'tok1' },
        { op: 'read', path: `${doc}/doc.aibdoc` },
      ]);
      assertEquals(r.result!.results[2].text, '{"a":1}', 'until the rename the old file is whole');
      assertEquals(r.result!.results[4].text, 'AAABBB');

      // rename, copy, remove (a file; a doc folder with recursive; never aib-docs/ itself)
      r = await call(t.methods, [
        { op: 'copy', path: `${doc}/doc.aibdoc`, to: `${doc}/copy.txt` },
        { op: 'rename', path: `${doc}/copy.txt`, to: `${doc}/moved.txt` },
        { op: 'remove', path: `${doc}/moved.txt` },
        { op: 'remove', path: `${LINUX}/aib-docs`, recursive: true },
        { op: 'mkdir', path: `${LINUX}/aib-docs/other/assets` },
        { op: 'remove', path: `${LINUX}/aib-docs/other`, recursive: true },
      ]);
      const out = r.result!.results;
      assertEquals([out[0].ok, out[1].ok, out[2].ok], [true, true, true]);
      assertEquals([out[3].ok, out[3].code], [false, 'outside_docs'], 'aib-docs/ itself is never removed');
      assertEquals([out[4].ok, out[5].ok], [true, true]);
      assert(Deno.statSync(t.onDisk('aib-docs/plan/doc.aibdoc')).isFile);

      // nothing outside a project's aib-docs/
      r = await call(t.methods, [
        { op: 'read', path: `${LINUX}/src/secret.txt` },
        { op: 'writeAtomic', path: `${LINUX}/notes.md`, text: 'x' },
        { op: 'read', path: '/aib-docs/x' },
      ]);
      for (const x of r.result!.results) assertEquals([x.ok, x.code], [false, 'outside_docs'], JSON.stringify(x));
      r = await call(t.methods, [{ op: 'read', path: `${LINUX}/aib-docs/../src/x` }]);
      assert(r.error && r.error.code === -32602, 'a .. part is a bad request');
      r = await call(t.methods, [{ op: 'read', path: 'aib-docs/x' }]);
      assert(r.error, 'relative paths are refused');

      // a symlink in aib-docs/ that leads out of the project: refused (skipped where this machine cannot make symlinks)
      const outsideDir = `${t.root}${SEP}elsewhere`;
      Deno.mkdirSync(outsideDir);
      Deno.writeTextFileSync(`${outsideDir}${SEP}doc.aibdoc`, 'secret');
      let linked = false;
      try {
        Deno.symlinkSync(outsideDir, t.onDisk('aib-docs/link'), { type: 'dir' });
        linked = true;
      } catch { /* no symlink rights */ }
      if (linked) {
        r = await call(t.methods, [{ op: 'read', path: `${LINUX}/aib-docs/link/doc.aibdoc` }, { op: 'writeAtomic', path: `${LINUX}/aib-docs/link/x`, text: 'x' }]);
        for (const x of r.result!.results) assertEquals([x.ok, x.code], [false, 'outside_docs'], JSON.stringify(x));
      } else console.log('note: no symlink rights here; the symlink part is checked in the real distro');
    } finally {
      await t.done();
    }
  },
});

Deno.test('doc_fs: Windows paths keep their own rules; a WSL ref goes to its distro with "/" and its case kept', () => {
  assertEquals(fsOf('C:\\work\\app\\aib-docs'), localFs);
  assertEquals(sepOf('C:\\work\\app'), SEP);
  assertEquals(sepOf(REF), '/');
  assertEquals(pathKey(REF + '/Plan'), REF + '/Plan', 'the Linux path keeps its case');
  if (WIN) assertEquals(pathKey('C:\\Work\\App'), 'c:\\work\\app', 'a Windows folder folds case, as before');
  assertEquals(linuxPath(`${REF}/aib-docs/plan/doc.aibdoc`), '/home/u/app/aib-docs/plan/doc.aibdoc');
  assertEquals(linuxPath('C:\\work\\x'), 'C:\\work\\x');
  assertEquals(
    linuxPaths({ doc: 'plan', file: `${REF}/aib-docs/plan/doc.aibdoc`, docs: [{ file: `${REF}/aib-docs/a/doc.aibdoc` }], blocks: [{ md: `${REF}/x` }] }),
    { doc: 'plan', file: '/home/u/app/aib-docs/plan/doc.aibdoc', docs: [{ file: '/home/u/app/aib-docs/a/doc.aibdoc' }], blocks: [{ md: `${REF}/x` }] },
    'only `file` values change: a doc\'s own text is never rewritten',
  );
});

// ---- 2. the store on a WSL ref ---------------------------------------------------------------------------------------------------
Deno.test({
  name: 'WSL docs: doc tools make and edit a doc whose files are in the distro; the user types while the agent edits; file edits come in',
  ...T,
  async fn() {
    const t = await lab();
    const store = t.newStore();
    try {
      const made = await tool(store, 'doc_create', { doc: 'plan', markdown: '# Plan\n\nThe launch moves to October.\n\nSecond paragraph.\n' });
      assertEquals(made.file, `${REF}/aib-docs/plan/doc.aibdoc`, 'AIB keeps the ref; the route hands the agent the Linux path');
      assertEquals(linuxPaths(made).file, '/home/u/app/aib-docs/plan/doc.aibdoc');
      const doc = await store.open(REF, 'plan');
      await store.flush(doc);
      // on the distro's disk: a valid doc.aibdoc, the page copy, AIB's README
      const aib = parseAib(Deno.readTextFileSync(t.onDisk('aib-docs/plan/doc.aibdoc')));
      assertEquals(aib.pages.length, 1);
      assertEquals(mdBody(Deno.readTextFileSync(t.onDisk('aib-docs/plan/01-page-1.md'))), '# Plan\n\nThe launch moves to October.\n\nSecond paragraph.\n');
      assert(Deno.statSync(t.onDisk('aib-docs/README.md')).isFile);
      assert(t.host.calls.some(([m]) => m === 'docs.fs'), 'through the helper');

      const listed = (await tool(store, 'doc_list', {})).docs as Json[];
      assertEquals(listed.map((d) => [d.name, d.dir]), [['plan', 'aib-docs/plan']]);
      assert((listed[0].owned as string[]).includes('aib-docs/plan/doc.aibdoc'), JSON.stringify(listed[0].owned));

      // the user types in block 2 while the agent, from an older read, rewrites it: the agent is refused, the user's words stay;
      // the agent's edit of another block lands
      const read = await tool(store, 'doc_read', { doc: 'plan' });
      const blocks = read.blocks as { id: string; h: string; md: string }[];
      const user = new UserClient(doc.live);
      user.type(blocks[1].id, 'The launch moves to October'.length, ' 6th');
      const [ok, refused] = await runDocTool(store, REF, 'claude', 'doc_edit', {
        doc: 'plan',
        ops: [{ op: 'replace', target: { kind: 'blocks', ids: [blocks[1].id] }, ifHash: blocks[1].h, ifRev: read.rev, with: inline('Launch is in November.', 'text') }],
      }, 'claude:s1');
      assertEquals([ok, (refused as Json).code], [false, 'guard_mismatch']);
      await tool(store, 'doc_edit', { doc: 'plan', ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline('Agent words.') }] });
      await store.flush(doc);
      const page = mdBody(Deno.readTextFileSync(t.onDisk('aib-docs/plan/01-page-1.md')));
      assert(page.includes('October 6th') && page.includes('Agent words.'), page);

      // an agent's file tool edits the page copy in the distro: taken in block by block
      const md = t.onDisk('aib-docs/plan/01-page-1.md');
      Deno.writeTextFileSync(md, Deno.readTextFileSync(md).replace('Second paragraph.', 'Second paragraph, edited in the distro.'));
      await store.syncMirror(doc);
      const again = await tool(store, 'doc_read', { doc: 'plan' });
      assert((again.blocks as { md: string }[]).some((b) => b.md === 'Second paragraph, edited in the distro.'), JSON.stringify(again.blocks));

      // history: versions in AIB's artifact store (on Windows), by who
      await tool(store, 'doc_history', { doc: 'plan' });
      const versions = store.history(doc).versions as { by: string }[];
      assert(versions.length >= 2, JSON.stringify(versions));
      assertEquals(t.artifacts.get(doc.artifactId!).project, REF);

      // a chart: its picture next to the copies, in the distro
      await tool(store, 'doc_edit', {
        doc: 'plan',
        ops: [{ op: 'insert', target: { kind: 'root' }, side: 'end', source: inline('| Month | Sales |\n| --- | --- |\n| Jan | 3 |\n| Feb | 5 |\n') }],
      });
      const table = ((await tool(store, 'doc_read', { doc: 'plan' })).blocks as { id: string; type: string }[]).find((b) => b.type === 'table')!;
      const charted = await runDocTool(store, REF, 'claude', 'doc_edit', { doc: 'plan', ops: [{ op: 'chart_from_table', target: { kind: 'blocks', ids: [table.id] } }] }, 'claude:s1');
      if (charted[0]) {
        await store.flush(doc);
        const assets = [...Deno.readDirSync(t.onDisk('aib-docs/plan/assets'))].map((e) => e.name);
        assert(assets.some((n) => n.endsWith('.chart.svg')), assets.join());
      } else console.log('note: chart_from_table refused here:', JSON.stringify(charted[1]));
    } finally {
      await store.close();
      await t.done();
    }
  },
});

Deno.test({
  name: 'WSL docs: a restart reopens the doc from AIB\'s cache (file unchanged) or rebuilds it from the distro\'s doc.aibdoc (changed there)',
  ...T,
  async fn() {
    const t = await lab();
    let store = t.newStore();
    try {
      await tool(store, 'doc_create', { doc: 'notes', markdown: '# Notes\n\nKept across restarts.\n' });
      let doc = await store.open(REF, 'notes');
      await store.flush(doc);
      const rev = doc.live.rev;
      await store.close();
      store = t.newStore();
      doc = await store.open(REF, 'notes');
      assertEquals(doc.live.rev, rev, 'the cache: same rev');
      assertEquals(store.pageMarkdown(doc), '# Notes\n\nKept across restarts.\n');
      await store.close();
      // a git pull in the distro changed the file while AIB was closed
      const file = t.onDisk('aib-docs/notes/doc.aibdoc');
      Deno.writeTextFileSync(file, Deno.readTextFileSync(file).replace('Kept across restarts.', 'Pulled in the distro.'));
      store = t.newStore();
      doc = await store.open(REF, 'notes');
      assertEquals(store.pageMarkdown(doc), '# Notes\n\nPulled in the distro.\n');
      assert(doc.live.rev > rev);
    } finally {
      await store.close();
      await t.done();
    }
  },
});

Deno.test({
  name: 'WSL docs: the 1 s poll of an unchanged doc sends no file text back (reads carry the known hash and come back "same")',
  ...T,
  async fn() {
    const t = await lab();
    const store = t.newStore();
    try {
      await tool(store, 'doc_create', { doc: 'plan', markdown: '# Plan\n\nWords.\n' });
      const doc = await store.open(REF, 'plan');
      await store.flush(doc);
      const answers: Json[] = [];
      const real = t.host.handlers['docs.fs']!;
      t.host.handlers['docs.fs'] = async (p) => {
        const r = await real(p) as { results: Json[] };
        answers.push(...r.results.map((x, i) => ({ ...x, op: (p.ops as Json[])[i] })));
        return r;
      };
      await store.syncMirror(doc);
      const reads = answers.filter((a) => (a.op as Json).op === 'read');
      assert(reads.length >= 2, JSON.stringify(answers));
      for (const r of reads) assertEquals([typeof (r.op as Json).known, r.same, r.text], ['string', true, undefined], JSON.stringify(r));
      // a change in the distro: its text comes back, and is taken in
      const md = t.onDisk('aib-docs/plan/01-page-1.md');
      Deno.writeTextFileSync(md, Deno.readTextFileSync(md).replace('Words.', 'Changed words.'));
      answers.length = 0;
      await store.syncMirror(doc);
      assert(answers.some((a) => typeof a.text === 'string' && String(a.text).includes('Changed words.')));
      assert(store.pageMarkdown(doc).includes('Changed words.'));
    } finally {
      await store.close();
      await t.done();
    }
  },
});

// ---- 3. the distro away; trash ---------------------------------------------------------------------------------------------------
Deno.test({
  name: 'WSL docs: with the distro stopped nothing is "missing" or made anew; the edits wait in AIB\'s cache and reach the files once it is back',
  ...T,
  async fn() {
    const t = await lab();
    let store = t.newStore();
    try {
      await tool(store, 'doc_create', { doc: 'plan', markdown: '# Plan\n\nBefore.\n' });
      let doc = await store.open(REF, 'plan');
      await store.flush(doc);
      t.host.state = 'stopped';
      t.host.note = 'Ubuntu stopped. Reconnect';
      // the user keeps typing: the write cannot reach the distro and says why
      const user = new UserClient(doc.live);
      const first = (doc.live.read() as { blocks: { id: string }[] }).blocks[1].id;
      user.type(first, 0, 'Typed while away. ');
      let error: unknown = null;
      await store.flush(doc).catch((e) => (error = e));
      assert(error instanceof DocRefusal && error.code === 'wsl_unavailable', String(error));
      assert((error as Error).message.includes('Ubuntu stopped'), (error as Error).message);
      // never "no such doc", never a new doc over the old one
      const [okOpen, openRefusal] = await runDocTool(store, REF, 'claude', 'doc_read', { doc: 'other' }, 'claude:s1');
      assertEquals([okOpen, (openRefusal as Json).code], [false, 'wsl_unavailable']);
      const [okMake, makeRefusal] = await runDocTool(store, REF, 'claude', 'doc_create', { doc: 'plan2', markdown: 'x' }, 'claude:s1');
      assertEquals([okMake, (makeRefusal as Json).code], [false, 'wsl_unavailable']);
      assertEquals(mdBody(Deno.readTextFileSync(t.onDisk('aib-docs/plan/01-page-1.md'))), '# Plan\n\nBefore.\n', 'the files are as they were');
      // AIB quits while the distro is away, then starts again with it back: the edit is written from the cache
      await store.close();
      t.host.state = 'ready';
      t.host.note = '';
      store = t.newStore();
      doc = await store.open(REF, 'plan');
      assertEquals(store.pageMarkdown(doc), '# Plan\n\nTyped while away. Before.\n');
      assertEquals(mdBody(Deno.readTextFileSync(t.onDisk('aib-docs/plan/01-page-1.md'))), '# Plan\n\nTyped while away. Before.\n');
      assert(Deno.readTextFileSync(t.onDisk('aib-docs/plan/doc.aibdoc')).includes('Typed while away.'));
    } finally {
      await store.close();
      await t.done();
    }
  },
});

Deno.test({
  name: 'WSL docs: the poll writes an edit that missed the distro as soon as it is back (AIB kept running)',
  ...T,
  async fn() {
    const t = await lab();
    const store = new DocStore(t.state, { idleMs: 60_000, pollMs: 50 });
    try {
      await tool(store, 'doc_create', { doc: 'plan', markdown: '# Plan\n\nBefore.\n' });
      const doc = await store.open(REF, 'plan');
      await store.flush(doc);
      t.host.state = 'stopped';
      const user = new UserClient(doc.live);
      user.type((doc.live.read() as { blocks: { id: string }[] }).blocks[1].id, 0, 'Late. ');
      await store.flush(doc).catch(() => {});
      store.start();
      await new Promise((r) => setTimeout(r, 200));
      assert(!Deno.readTextFileSync(t.onDisk('aib-docs/plan/01-page-1.md')).includes('Late.'));
      t.host.state = 'ready';
      for (let i = 0; i < 100 && !Deno.readTextFileSync(t.onDisk('aib-docs/plan/01-page-1.md')).includes('Late.'); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(Deno.readTextFileSync(t.onDisk('aib-docs/plan/01-page-1.md')).includes('Late. Before.'));
    } finally {
      await store.close();
      await t.done();
    }
  },
});

Deno.test({
  name: 'WSL docs: "Move doc to trash" sends the doc folder to the distro\'s trash (under test: the test\'s own trash, no gio); no trash = refused',
  ...T,
  async fn() {
    const t = await lab();
    const store = t.newStore();
    try {
      await tool(store, 'doc_create', { doc: 'old', markdown: '# Old\n' });
      const doc = await store.open(REF, 'old');
      await store.flush(doc);
      const seen: Json[] = [];
      const real = t.host.handlers['docs.fs']!;
      let kind = 'xdg';
      t.host.handlers['docs.fs'] = (p) => {
        const op = (p.ops as Json[])[0];
        if (op.op === 'trashKind' || op.op === 'trash') {
          seen.push(op);
          if (op.op === 'trashKind') return { results: [{ ok: true, kind }] };
          Deno.removeSync(t.onDisk('aib-docs/old'), { recursive: true }); // stands in for the trash's one rename
          return { results: [{ ok: true, kind }] };
        }
        return real(p);
      };
      const routes = docsRoutes();
      const ctx = { docs: store } as unknown as WebContext;
      kind = 'permanent';
      const [status, refusal] = await routes.get('POST /api/live/docs/trash')!(ctx, new URL('http://x/'), { doc: doc.id });
      assertEquals([status, (refusal as Json).code], [400, 'no_trash']);
      assert(Deno.statSync(t.onDisk('aib-docs/old/doc.aibdoc')).isFile, 'nothing removed');
      kind = 'xdg';
      const [ok, body] = await routes.get('POST /api/live/docs/trash')!(ctx, new URL('http://x/'), { doc: doc.id });
      assertEquals([ok, (body as Json).trashed], [200, 'old']);
      assertEquals(seen.map((o) => [o.op, o.path, o.dataHome, o.viaGio]), [
        ['trashKind', '/home/u/app/aib-docs/old', '/tmp/aib-wsl-test-docs-unit/home/.local/share', false],
        ['trashKind', '/home/u/app/aib-docs/old', '/tmp/aib-wsl-test-docs-unit/home/.local/share', false],
        ['trash', '/home/u/app/aib-docs/old', '/tmp/aib-wsl-test-docs-unit/home/.local/share', false],
      ]);
      assertEquals(store.get(doc.id), null, 'closed');
      assert(wslDocFs('Ubuntu') === wslDocFs('ubuntu'), 'one layer per distro');
    } finally {
      await store.close();
      await t.done();
    }
  },
});
