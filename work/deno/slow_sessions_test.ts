/**
 * GET /api/sessions and GET /api/commands must stay cheap when polled over a big Claude projects folder (the owner's log: /api/sessions
 * 1-12 s, /api/commands 1-8 s, polled every few seconds). A synthetic ~/.claude/projects-like tree (20 projects x 15 chats, each with
 * 4 subagent transcripts in nested folders, two 30 MB transcripts) under work/slowreq-fixture/state/ (git-ignored), never the real one.
 * Checks an IO budget (folder listings per poll) and a time budget, that concurrent polls share one pass, that a new subagent is still
 * counted, and that a just-built command list is reused without walking its family again.
 */
import { assert, assertEquals } from './_assert.ts';
import { Catalog, commandList, commandListQuick, handleGet, setCommandQuickMs, Store } from '../../app/server/transcripts/monitor.ts';

const ROOT = new URL('../slowreq-fixture/state/', import.meta.url);
const rootPath = () => decodeURIComponent(ROOT.pathname).replace(/^\/([A-Za-z]:)/, '$1');
const PROJECTS = 20, CHATS = 15, SUBAGENTS = 4;

function chatLines(cwd: string, id: string): string {
  const rows = [
    { type: 'user', cwd, sessionId: id, timestamp: '2026-11-14T10:00:00Z', message: { role: 'user', content: `Fix the thing in ${id}` } },
    { type: 'assistant', cwd, sessionId: id, timestamp: '2026-11-14T10:00:05Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

async function buildTree(): Promise<string> {
  await Deno.mkdir(rootPath(), { recursive: true });
  const root = await Deno.makeTempDir({ dir: rootPath(), prefix: 'claude-projects-' });
  const big = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1 << 20) }] } }) + '\n';
  for (let p = 0; p < PROJECTS; p++) {
    const cwd = `C:\\work\\proj${p}`;
    const dir = `${root}/C--work-proj${p}`;
    await Deno.mkdir(dir);
    for (let c = 0; c < CHATS; c++) {
      const id = `s${p}-${c}`;
      let text = chatLines(cwd, id);
      if (p === 0 && c < 2) text += big.repeat(30); // two ~30 MB transcripts
      await Deno.writeTextFile(`${dir}/${id}.jsonl`, text);
      await Deno.mkdir(`${dir}/${id}/subagents/deeper`, { recursive: true });
      await Deno.mkdir(`${dir}/${id}/tool-results`, { recursive: true });
      for (let a = 0; a < SUBAGENTS; a++) {
        const where = a % 2 ? 'subagents/deeper' : 'subagents';
        await Deno.writeTextFile(`${dir}/${id}/${where}/agent-a${a}.jsonl`, chatLines(cwd, `${id}-a${a}`));
      }
      await Deno.writeTextFile(`${dir}/${id}/tool-results/out.txt`, 'x');
    }
  }
  return root;
}

/** Counts Deno.readDir calls while fn runs (the IO that grows with the tree: one listing per folder walked). */
async function countingReadDir<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const original = Deno.readDir;
  let calls = 0;
  Object.defineProperty(Deno, 'readDir', {
    value: (path: string | URL) => {
      calls++;
      return original(path);
    },
    configurable: true,
    writable: true,
  });
  try {
    return [await fn(), calls];
  } finally {
    Object.defineProperty(Deno, 'readDir', { value: original, configurable: true, writable: true });
  }
}

Deno.test({
  name: 'sessions: a poll over a big projects folder lists only the project folders, within a time budget',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = await buildTree();
    try {
      const store = await Store.open(root);
      let t = performance.now();
      const [cold, coldDirs] = await countingReadDir(() => store.sessions());
      const coldMs = performance.now() - t;
      assertEquals(cold.length, PROJECTS * CHATS);
      assert(cold.every((s) => s.subagentCount === SUBAGENTS), 'every chat counts its 4 subagents, nested ones too');
      t = performance.now();
      const [warm, warmDirs] = await countingReadDir(() => store.sessions());
      const warmMs = performance.now() - t;
      assertEquals(warm.length, PROJECTS * CHATS);
      console.log(`sessions: cold ${coldMs.toFixed(0)} ms / ${coldDirs} listings; warm ${warmMs.toFixed(0)} ms / ${warmDirs} listings`);
      // root + one per project; before the fix every chat's artifact folder tree was listed again (4 more per chat) on every poll
      assert(warmDirs <= PROJECTS + 1, `warm poll listed ${warmDirs} folders`);
      assert(warmMs < 1500, `warm poll took ${warmMs.toFixed(0)} ms`);

      // a subagent started later is counted on the next poll: the chat records its Agent call, and the folder's mtime changed
      await new Promise((r) => setTimeout(r, 30));
      await Deno.writeTextFile(`${root}/C--work-proj3/s3-4/subagents/deeper/agent-new.jsonl`, chatLines('C:\\work\\proj3', 'new'));
      await Deno.writeTextFile(`${root}/C--work-proj3/s3-4.jsonl`, chatLines('C:\\work\\proj3', 'more'), { append: true });
      const after = await store.sessions();
      assertEquals(after.find((s) => s.key === 'C--work-proj3/s3-4.jsonl')?.subagentCount, SUBAGENTS + 1);

      // concurrent polls share one pass: the root is listed once for five requests
      const [many, manyDirs] = await countingReadDir(() => Promise.all([1, 2, 3, 4, 5].map(() => store.sessions())));
      assert(many.every((list) => list.length === PROJECTS * CHATS));
      assert(manyDirs <= PROJECTS + 1, `five concurrent polls listed ${manyDirs} folders`);
      many[0][0].title = 'changed by a caller';
      assert(many[1][0].title !== 'changed by a caller', 'each caller gets its own items');

      // the HTTP handler answers in budget too
      const catalog = await Catalog.open(null, root);
      await handleGet(catalog, '/api/sessions', '');
      t = performance.now();
      const reply = await handleGet(catalog, '/api/sessions', '');
      const handlerMs = performance.now() - t;
      assertEquals(reply.status, 200);
      assert(handlerMs < 1500, `GET /api/sessions took ${handlerMs.toFixed(0)} ms`);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'commands: concurrent requests for one chat share one build of its command list',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await Deno.mkdir(rootPath(), { recursive: true });
    const root = await Deno.makeTempDir({ dir: rootPath(), prefix: 'claude-commands-' });
    try {
      const dir = `${root}/C--work-proj`;
      await Deno.mkdir(`${dir}/main/subagents`, { recursive: true });
      await Deno.writeTextFile(`${dir}/main.jsonl`, chatLines('C:\\work\\proj', 'main'));
      for (let a = 0; a < 60; a++) await Deno.writeTextFile(`${dir}/main/subagents/agent-${a}.jsonl`, chatLines('C:\\work\\proj', `a${a}`));
      const session = 'claude/C--work-proj/main.jsonl';
      const one = await Catalog.open(null, root);
      const [first, oneDirs] = await countingReadDir(() => commandList(one, session));
      assert(oneDirs >= 1, 'a build walks the family');
      // five requests at once (the page's /api/agents + /api/commands, several views) share one build: the same folder listings
      const five = await Catalog.open(null, root);
      const [lists, fiveDirs] = await countingReadDir(() =>
        Promise.all([
          ...[1, 2, 3, 4].map(() => commandList(five, session)),
          handleGet(five, '/api/commands', `session=${encodeURIComponent(session)}`),
        ])
      );
      assertEquals(fiveDirs, oneDirs, 'concurrent requests share one walk');
      assertEquals((lists[0] as unknown[]).length, first.length);
      assertEquals((lists[4] as { status: number }).status, 200);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'sessions: the WSL part of a poll is answered from the last listing while a slow helper is asked again',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { setDistroSource, setWslHostResolver } = await import('../../app/server/wsl/access.ts');
    const { wslSavedSessionsQuick, WSL_SESSIONS_FRESH_MS } = await import('../../app/server/wsl/transcripts.ts');
    const saved = { test: Deno.env.get('AGENT_STUDIO_TEST'), root: Deno.env.get('AIB_WSL_ROOT') };
    Deno.env.set('AGENT_STUDIO_TEST', '1');
    Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-slowreq-test');
    let calls = 0;
    let delay = 0;
    const host = {
      distro: 'Ubuntu',
      state: 'ready',
      call: async (_method: string, params: { provider: string }) => {
        calls++;
        await new Promise((r) => setTimeout(r, delay));
        return { sessions: params.provider === 'claude' ? [{ key: 'p/s1.jsonl', sessionId: 's1', cwd: '/home/u/proj' }] : [] };
      },
    };
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2 }]));
    setWslHostResolver(() => host as never);
    try {
      const [a, b] = await Promise.all([wslSavedSessionsQuick(), wslSavedSessionsQuick()]);
      assertEquals(a.length, 1);
      assertEquals(b.length, 1);
      assertEquals(calls, 2, 'one listing (two providers, asked at once) for two concurrent polls');
      await new Promise((r) => setTimeout(r, WSL_SESSIONS_FRESH_MS + 50));
      delay = 5_000; // the helper is now slow
      const t = performance.now();
      const stale = await wslSavedSessionsQuick();
      const ms = performance.now() - t;
      assertEquals(stale.length, 1);
      assert(ms < 1000, `the poll waited ${ms.toFixed(0)} ms for a slow helper`);
      await new Promise((r) => setTimeout(r, 100));
      assertEquals(calls, 4, 'a fresh listing was started for the next poll');
      await new Promise((r) => setTimeout(r, delay + 200)); // let it finish before the hooks are removed
    } finally {
      setDistroSource(null);
      setWslHostResolver(null);
      if (saved.test === undefined) Deno.env.delete('AGENT_STUDIO_TEST');
      else Deno.env.set('AGENT_STUDIO_TEST', saved.test);
      if (saved.root === undefined) Deno.env.delete('AIB_WSL_ROOT');
      else Deno.env.set('AIB_WSL_ROOT', saved.root);
    }
  },
});

/** One session that started `count` background Bash commands, in a Claude projects folder at `root`; its key. */
function bgSession(root: string, count: number): string {
  const iso = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const rows: unknown[] = [{ type: 'user', sessionId: 'bg', cwd: 'C:\\work\\app', timestamp: iso(60), message: { role: 'user', content: 'run them' } }];
  for (let i = 0; i < count; i++) {
    rows.push({
      type: 'assistant',
      sessionId: 'bg',
      timestamp: iso(50 - i),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'Bash', input: { command: `job ${i}`, description: `Job ${i}`, run_in_background: true } }] },
    });
    rows.push({
      type: 'user',
      sessionId: 'bg',
      timestamp: iso(49 - i),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: `Command running in background with ID: job${i}.` }] },
      toolUseResult: { backgroundTaskId: `job${i}` },
    });
  }
  Deno.mkdirSync(`${root}/proj`, { recursive: true });
  Deno.writeTextFileSync(`${root}/proj/bg.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return 'proj/bg.jsonl';
}

Deno.test({
  name: 'commands: a page poll never waits for a slow build (pending first, then the list; the last list while a newer one is read)',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await Deno.mkdir(rootPath(), { recursive: true });
    const root = await Deno.makeTempDir({ dir: rootPath(), prefix: 'claude-cmd-quick-' });
    try {
      const key = bgSession(root, 3);
      const store = await Store.open(root);
      // nothing built yet and no time to wait: answered at once, marked pending; the build goes on behind it
      const first = await commandListQuick(store, key, 0);
      assertEquals([first.pending, first.stale, first.tasks.length], [true, false, 0]);
      assertEquals((await commandList(store, key)).length, 3);
      const warm = await commandListQuick(store, key, 1000);
      assertEquals([warm.pending, warm.stale, warm.tasks.length], [false, false, 3]);
      // one more command saved: with no time to wait, the last list comes back marked stale; the next poll has the new one
      bgSession(root, 4);
      const stale = await commandListQuick(store, key, 0);
      assertEquals([stale.pending, stale.stale, stale.tasks.length], [false, true, 3]);
      assertEquals((await commandList(store, key)).length, 4);
      // the HTTP route says pending while the first list is read, then answers with the list
      const fresh = await Store.open(root);
      setCommandQuickMs(0);
      try {
        const q = `session=${encodeURIComponent(key)}`;
        const r1 = await handleGet(fresh, '/api/commands', q);
        const b1 = r1.body as { pending?: boolean; commands: unknown[] };
        assertEquals([r1.status, b1.pending, b1.commands.length], [200, true, 0]);
        await commandList(fresh, key);
        const b2 = (await handleGet(fresh, '/api/commands', q)).body as { pending?: boolean; total: number };
        assertEquals([b2.pending, b2.total], [undefined, 4]);
        // an unknown chat is still refused, not "pending"
        assertEquals((await handleGet(fresh, '/api/commands', 'session=proj/nope.jsonl')).status, 400);
      } finally {
        setCommandQuickMs(250);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
