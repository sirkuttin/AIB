/**
 * Golden parity for server/transcripts/monitor.ts: every GET the viewer answers (sessions, agents, commands, command,
 * transcript pages with before/after/limit/kind/q/thinking, plan context, meta, revision, images, errors) is asked of the port over
 * the fixture folders, in the same order (so the cache sees the same history), and the JSON must be what the retired handler
 * answered then. Each answer is kept as a fingerprint of the JSON (fixtures/frozen/monitor_golden.json) with the times that come
 * from files (created, idle seconds, revision stamps) and the Deno-only keys taken out. Fixtures: work/subagents-fixture and work/design-fixture (generated in temp
 * copies), the record shapes of the old tests, an edge-case transcript, file growth and replacement, and a large synthetic chat.
 */
import { assert, assertEquals } from './_assert.ts';
import { Frozen } from './_frozen.ts';
import { digestOf } from './_digest.ts';
import { handleGet, openSource, type Source, Transcript } from '../../app/server/transcripts/monitor.ts';
import { join } from '../../app/server/transcripts/purepath.ts';
import * as fx from './_monitor_fixtures.ts';

const py = new Frozen();
const TMP = Deno.makeTempDirSync({ prefix: 'aib-monitor-golden-' });
const TMP_SLASH = TMP.replaceAll('\\', '/').toLowerCase();
const TMP_RE = new RegExp(TMP_SLASH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
// steered: a message Claude Code saved as sent while it worked (normalize.ts, B15, beta.9) is Deno only; not in the frozen answers
// endedWithAgent: 7d633bbf's flag on a row that reads "ended with the agent" (Activity asks whether its process still runs); Deno only
const IGNORED = new Set(['now', 'steered', 'endedWithAgent']);

/**
 * The JSON with the Deno-only keys out and what comes from the clock or from file times written as 0 / 'T': a number within three
 * days of now (seconds, milliseconds or nanoseconds: created, modified, idle seconds, revision stamps, `now`) and an ISO instant
 * within three days of now (the generated fixtures stamp their records when they are made); sessions lists are sorted. This is what the fingerprints are made of.
 */
function norm(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => norm(v));
    // sessions listed by file time: files made in the same instant come in a different order on every run, so the list is sorted
    return key === 'sessions' || key === 'agents' ? items.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)) : items;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !IGNORED.has(k)).map(([k, v]) => [k, norm(v, k)]));
  }
  const now = Date.now();
  const window = 3 * 86_400_000;
  if (typeof value === 'number') {
    if (key === 'transcriptIdleSeconds') return 0;
    for (const scale of [1e-3, 1, 1e6]) if (Math.abs(value / scale - now) < window) return 0; // seconds, ms, ns
    return value;
  }
  // a path under the temp folder (random name, and a slash or backslash style) is written as <TMP>
  if (typeof value === 'string' && value.replaceAll('\\', '/').toLowerCase().includes(TMP_SLASH)) return value.replaceAll('\\', '/').replace(TMP_RE, '<TMP>');
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const at = Date.parse(value);
    if (Math.abs(at - now) < window) return 'T';
  }
  return value;
}

function b64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

interface Root {
  omp: string | null;
  claude: string | null;
  source: Source;
}

async function root(omp: string | null, claude: string | null): Promise<Root> {
  return { omp, claude, source: await openSource(omp, claude) };
}

let compared = 0;
const tally = new Map<string, number>();
const count = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);

/** The answers the frozen answers hold, in the order they were asked: 5 hex characters of the fingerprint of each (3,900 of them fit in 40 KB). */
const golden: string[] = (await py.frozenWhole<string>('golden-answers')).split(' ');
const short = (value: unknown) => digestOf(value).slice(0, 5);

/** Ask the port; the answer must be the one the frozen answers hold (a fingerprint). Returns the (plain JSON) body, or null when both raised. */
async function same(r: Root, path: string, query = ''): Promise<unknown> {
  let ts: { status: number; body: unknown };
  try {
    const got = await handleGet(r.source, path, query);
    const body = got.body instanceof Uint8Array
      ? { __bytes__: b64(got.body), mime: got.contentType }
      : JSON.parse(JSON.stringify(got.body));
    ts = { status: got.status, body };
  } catch (error) {
    // the frozen answer raised too: its answer was the name of the error
    assertEquals(short({ error: (error as Error).name }), golden[compared], `${path}?${query}: both raise (answer ${compared})`);
    compared++;
    count('raised ' + (error as Error).name);
    return null;
  }
  assertEquals(short(norm(ts)), golden[compared], `${path}?${query} (answer ${compared}) is not what the frozen answers hold: ${JSON.stringify(ts).slice(0, 300)}`);
  compared++;
  const status = ts.status;
  count(`${status} ${path}`);
  if (status === 400) count('400: ' + (ts.body as { error: string }).error.slice(0, 60));
  return ts.body;
}

const PAGE_QUERIES = (total: number) => [
  '',
  'thinking=1',
  'limit=7',
  'limit=7&thinking=1',
  `before=${Math.floor(total / 2)}`,
  `before=${Math.floor(total / 2)}&thinking=1&limit=3`,
  `before=${Math.max(0, total - 1)}&limit=2`,
  'after=0&limit=5',
  'after=3',
  'after=99999',
  'kind=tools',
  'kind=messages&thinking=1',
  'kind=errors',
  'kind=bogus&limit=4',
  'q=msg',
  'q=REPLY&limit=3',
  'q=%C3%BC',
  'q=+tool+',
  'limit=abc',
  'before=-5',
  'limit=0',
  'limit=1000',
  'before=x',
  'after=%2B2',
  'limit=%20%2012%20',
  'after=&before=&limit=',
  'limit=1_0',
  'before=3&before=9',
];

/** Files written in the same instant are listed in a different order on every run, so the sweep walks them by key. */
const byKey = <T extends { key: string }>(items: T[]): T[] => [...items].sort((x, y) => (x.key < y.key ? -1 : 1));

/** Every route over every chat and agent of a root. */
async function sweep(r: Root, deep = true): Promise<void> {
  const sessions = await same(r, '/api/sessions') as { sessions: { key: string }[] } | null;
  assert(sessions === null || sessions.sessions.length > 0, 'a root with chats lists them');
  count('sessions listed: ' + (sessions?.sessions.length ?? 0));
  for (const session of byKey(sessions?.sessions ?? [])) {
    const q = 'session=' + encodeURIComponent(session.key);
    const agents = await same(r, '/api/agents', q) as { agents: { key: string }[] } | null;
    const commands = await same(r, '/api/commands', q) as { commands: { id: string }[] } | null;
    await same(r, '/api/commands', q + '&running=1');
    for (const command of commands?.commands ?? []) await same(r, '/api/command', `${q}&id=${encodeURIComponent(command.id)}`);
    await same(r, '/api/command', `${q}&id=nope`);
    for (const agent of byKey(agents?.agents ?? [])) {
      const key = 'key=' + encodeURIComponent(agent.key);
      const first = await same(r, '/api/transcript', key + '&thinking=1&limit=500') as {
        total: number;
        events: { images?: Record<string, number>[] }[];
      } | null;
      const total = first?.total ?? 0;
      for (const query of deep ? PAGE_QUERIES(total) : ['', 'thinking=1']) {
        await same(r, '/api/transcript', key + (query ? '&' + query : ''));
      }
      for (const event of first?.events ?? []) {
        for (const im of event.images ?? []) {
          await same(r, '/api/transcript/image', `${key}&n=${im.n}&i=${im.i}${im.j !== undefined ? '&j=' + im.j : ''}`);
          await same(r, '/api/transcript/image', `${key}&n=${im.n}&i=${im.i + 1}`);
          await same(r, '/api/transcript/image', `${key}&n=${im.n}&i=${im.i}&j=${(im.j ?? 0) + 7}`);
        }
      }
      if (deep) {
        await same(r, '/api/transcript/image', key + '&n=1&i=0');
        await same(r, '/api/transcript/image', key + '&n=x&i=0');
      }
    }
  }
}

async function refusals(r: Root, provider: string): Promise<void> {
  for (
    const key of [
      '',
      'nope/x.jsonl',
      `${provider}/../x.jsonl`,
      `${provider}/../../etc/passwd`,
      `${provider}/C:/Windows/win.ini`,
      `${provider}//server/share/x.jsonl`,
      `${provider}/\\\\server\\share\\x.jsonl`,
      `${provider}/missing/none.jsonl`,
      `${provider}/x`,
      provider,
    ]
  ) {
    await same(r, '/api/transcript', 'key=' + encodeURIComponent(key));
    await same(r, '/api/agents', 'session=' + encodeURIComponent(key));
    await same(r, '/api/commands', 'session=' + encodeURIComponent(key));
  }
  await same(r, '/api/nope');
}

Deno.test('golden: the generated work/*-fixture folders (subagents, design)', async () => {
  const subagents = await fx.runGenerator('subagents-fixture', TMP);
  const design = await fx.runGenerator('design-fixture', TMP);
  const a = await root(null, join(subagents, 'claude'));
  await sweep(a);
  await refusals(a, 'claude');
  const data = join(design, 'data');
  const b = await root(join(data, 'omp'), join(data, 'claude'));
  await sweep(b);
  await refusals(b, 'omp');
});

Deno.test('golden: record shapes from the old tests', async () => {
  const base = join(TMP, 'shapes');
  const claude = join(base, 'claude');
  const omp = join(base, 'omp');
  Deno.mkdirSync(omp, { recursive: true });
  fx.writeRows(join(claude, 'enc', 'paging.jsonl'), fx.pagingRows());
  fx.writeRows(
    join(claude, 'proj', 'cache.jsonl'),
    fx.cacheRows(
      'fx1',
      4,
      true,
      '<task-notification><task-id>fx1j0</task-id><tool-use-id>fx1-c0</tool-use-id><status>completed</status><summary>Done</summary></task-notification>',
    ),
  );
  fx.cacheFamily(claude, 5);
  fx.planFixtures(join(claude, 'plans'));
  fx.writeRows(join(claude, 'img', 'images.jsonl'), fx.imageRows());
  fx.subagentFixtures(claude);
  fx.titleFixtures(join(claude, 'titles'));
  fx.projectFixtures(claude);
  fx.processFixtures(claude);
  fx.edgeFixture(join(omp, 'edge'));
  fx.write(
    join(omp, 'edge', '2026-01-01_omp-1.jsonl'),
    fx.lines([{ type: 'session', id: 'omp-1', cwd: '/x', timestamp: '2026-01-01T00:00:00Z' }]),
  );
  const r = await root(omp, claude);
  await sweep(r);
  await refusals(r, 'claude');
});

Deno.test('golden: a record the frozen answers could not read fails the same way', async () => {
  const claude = join(TMP, 'crash', 'claude');
  fx.write(join(claude, 'p', 'list.jsonl'), '[1, 2]\n' + fx.lines([{ type: 'user', message: { role: 'user', content: 'x' } }]));
  fx.write(
    join(claude, 'q', 'role.jsonl'),
    fx.lines([{ type: 'user', message: { role: 5, content: 'x' } }, { type: 'user', message: 'str' }]),
  );
  fx.write(join(claude, 'r', 'text.jsonl'), fx.lines([{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 5 }] } }]));
  fx.write(
    join(claude, 's', 'hash.jsonl'),
    fx.lines([{ type: 'user', message: { role: 'user', content: [{ type: 'image', mimeType: ['x'], data: 'QQ==' }] } }]),
  );
  const r = await root(null, claude);
  await same(r, '/api/sessions');
  for (const key of ['p/list.jsonl', 'q/role.jsonl', 'r/text.jsonl', 's/hash.jsonl']) {
    for (let n = 0; n < 3; n++) await same(r, '/api/transcript', 'key=claude/' + key); // the frozen answers fail once, then read past the record
  }
});

Deno.test('golden: growth in odd pieces, a larger replacement, shrinking, and a rewrite in place', async () => {
  const claude = join(TMP, 'grow', 'claude');
  const path = join(claude, 'enc', 'sess.jsonl');
  const r = await root(null, claude);
  const blob = new TextEncoder().encode(fx.lines(fx.pagingRows(), false));
  for (let pos = 0; pos < blob.length;) {
    pos = Math.min(blob.length, pos + 9973);
    fx.write(path, blob.subarray(0, pos));
    await same(r, '/api/transcript', 'key=claude/enc/sess.jsonl&limit=50');
  }
  fx.write(path, fx.lines(fx.pagingRows(120, 'old')));
  await same(r, '/api/transcript', 'key=claude/enc/sess.jsonl');
  fx.write(path, fx.pagingRows().map((row) => JSON.stringify(row).replace('"role"', '"role" ')).join('\n') + '\n');
  await same(r, '/api/transcript', 'key=claude/enc/sess.jsonl&limit=500');
  fx.write(path, fx.lines(fx.pagingRows(30)));
  await same(r, '/api/transcript', 'key=claude/enc/sess.jsonl&limit=500');
  const same30 = fx.lines(fx.pagingRows(30)).replaceAll('MSG-001', 'MSG-999');
  fx.write(path, same30, -5);
  await same(r, '/api/transcript', 'key=claude/enc/sess.jsonl&limit=500');
  await sweep(r, false);
});

Deno.test('golden: a large synthetic chat (and parse time)', async () => {
  const claude = join(TMP, 'big', 'claude');
  const path = fx.write(join(claude, 'C--repo-app', 'big.jsonl'), fx.bigRows(9000));
  const lineCount = (await Deno.readTextFile(path)).split('\n').length - 1;
  const r = await root(null, claude);
  const key = 'key=claude/C--repo-app/big.jsonl';
  const first = await same(r, '/api/transcript', key + '&thinking=1&limit=500') as { total: number };
  for (const before of [first.total, Math.floor(first.total / 3), 4000, 501, 1]) {
    await same(r, '/api/transcript', `${key}&before=${before}&limit=500`);
    await same(r, '/api/transcript', `${key}&before=${before}&limit=500&thinking=1`);
  }
  await same(r, '/api/transcript', key + '&q=answer+1234&limit=500');
  await same(r, '/api/sessions');
  await same(r, '/api/commands', 'session=claude/C--repo-app/big.jsonl');
  // The whole parse state, event for event.
  const expected = await py.frozen<unknown>('snapshot');
  const t = await new Transcript(path).refresh();
  const actual = JSON.parse(JSON.stringify({
    events: t.events,
    commands: [...t.commands.values()],
    meta: t.meta,
    number: t.number,
    marks: t.planMarks,
    offset: t.offset,
    images: [...t.imageOffsets].sort((a, b) => a[0] - b[0]),
    thinking: t.thinkingAt,
    ended: [...t.endedIds].sort(),
    jobs: Object.fromEntries(t.jobCalls),
    signature: [t.signature![0], Number(t.signature![1])],
  }));
  assertEquals(norm(actual), expected, 'the whole parse state');
  // Timing: best of three cold parses each.
  const timings: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await new Transcript(path).refresh();
    timings.push((performance.now() - start) / 1000);
  }
  const deno = Math.min(...timings);
  const size = (await Deno.stat(path)).size;
  console.log(
    `big transcript: ${lineCount} lines, ${(size / 1048576).toFixed(1)} MB, ${t.events.length} events; parse ${deno.toFixed(3)} s`,
  );
});

Deno.test('golden: summary', () => {
  assertEquals(golden.length, compared, 'every answer the frozen answers hold was compared');
  console.log(`golden replies compared: ${compared}`);
  console.log([...tally].sort().map(([k, v]) => `  ${v}  ${k}`).join('\n'));
  try {
    Deno.removeSync(TMP, { recursive: true });
  } catch { /* Windows may hold a file briefly */ }
});
