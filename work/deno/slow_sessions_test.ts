/**
 * GET /api/sessions and GET /api/commands must stay cheap when polled over a big Claude projects folder (the owner's log: /api/sessions
 * 1-12 s, /api/commands 1-8 s, polled every few seconds). A synthetic ~/.claude/projects-like tree (20 projects x 15 chats, each with
 * 4 subagent transcripts in nested folders, two 30 MB transcripts) under work/slowreq-fixture/state/ (git-ignored), never the real one.
 * Checks an IO budget (folder listings per poll) and a time budget, that concurrent polls share one pass, that a new subagent is still
 * counted, and that a just-built command list is reused without walking its family again.
 */
import { assert, assertEquals } from './_assert.ts';
import { Catalog, commandList, handleGet, Store } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

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
    const { setDistroSource, setWslHostResolver } = await import('../../outputs/agent-studio/server/wsl/access.ts');
    const { wslSavedSessionsQuick, WSL_SESSIONS_FRESH_MS } = await import('../../outputs/agent-studio/server/wsl/transcripts.ts');
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
