/**
 * Golden parity for server/transcripts/monitor.ts: every GET the viewer answers (sessions, agents, commands, command,
 * transcript pages with before/after/limit/kind/q/thinking, plan context, meta, revision, images, errors) is asked of the Python
 * handler (work/parity/monitor_shim.py) and of the port over the same fixture folders, in the same order (so both caches see
 * the same history), and the JSON must be identical. Fixtures: work/subagents-fixture and work/design-fixture (generated in temp
 * copies), the record shapes of the Python tests, an edge-case transcript, file growth and replacement, and a large synthetic chat.
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { handleGet, openSource, type Source, Transcript } from '../../outputs/agent-studio/server/transcripts/monitor.ts';
import { join } from '../../outputs/agent-studio/server/transcripts/purepath.ts';
import * as fx from './_monitor_fixtures.ts';

const py = new PyParity();
const TMP = Deno.makeTempDirSync({ prefix: 'aib-monitor-golden-' });
const TOLERANCE: Record<string, number> = { created: 0.0015, transcriptIdleSeconds: 2 };
const IGNORED = new Set(['now']);

function b64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

/** First difference between two JSON trees, or null. */
function diff(a: unknown, b: unknown, path = '$'): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    const key = path.slice(path.lastIndexOf('.') + 1);
    const tolerance = TOLERANCE[key] ?? 0;
    return Math.abs(a - b) <= tolerance || Object.is(a, b) ? null : `${path}: ${a} != ${b}`;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return Object.is(a, b) ? null : `${path}: ${JSON.stringify(a)?.slice(0, 200)} != ${JSON.stringify(b)?.slice(0, 200)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return `${path}: length ${a.length} != ${bb.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], bb[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => !IGNORED.has(k)).sort();
  const kb = Object.keys(rb).filter((k) => !IGNORED.has(k)).sort();
  if (ka.join('\u0000') !== kb.join('\u0000')) return `${path}: keys ${JSON.stringify(ka)} != ${JSON.stringify(kb)}`;
  for (const k of ka) {
    const d = diff(ra[k], rb[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
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

/** Ask both servers; returns the (plain JSON) body both agreed on, or null when both raised the same Python error. */
async function same(r: Root, path: string, query = ''): Promise<unknown> {
  const reply = await py.raw('monitor_shim', 'handle', [r.omp, r.claude, path, query]);
  let ts: unknown;
  try {
    const got = await handleGet(r.source, path, query);
    const body = got.body instanceof Uint8Array
      ? { __bytes__: b64(got.body), mime: got.contentType }
      : JSON.parse(JSON.stringify(got.body));
    ts = { status: got.status, body };
  } catch (error) {
    if ('error' in reply) {
      assertEquals((error as Error).name, reply.error, `${path}?${query}: both raise`);
      compared++;
      count('raised ' + reply.error);
      return null;
    }
    throw error;
  }
  if ('error' in reply) {
    throw new Error(`${path}?${query}: Python raised ${reply.error}: ${reply.message}; Deno answered ${JSON.stringify(ts).slice(0, 300)}`);
  }
  const d = diff(ts, reply.ok);
  if (d) throw new Error(`${path}?${query}: ${d}`);
  compared++;
  const status = (ts as { status: number; body: unknown }).status;
  count(`${status} ${path}`);
  if (status === 400) count('400: ' + (ts as { body: { error: string } }).body.error.slice(0, 60));
  return (reply.ok as { body: unknown }).body;
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

/** Every route over every chat and agent of a root. */
async function sweep(r: Root, deep = true): Promise<void> {
  const sessions = await same(r, '/api/sessions') as { sessions: { key: string }[] } | null;
  assert(sessions === null || sessions.sessions.length > 0, 'a root with chats lists them');
  count('sessions listed: ' + (sessions?.sessions.length ?? 0));
  for (const session of sessions?.sessions ?? []) {
    const q = 'session=' + encodeURIComponent(session.key);
    const agents = await same(r, '/api/agents', q) as { agents: { key: string }[] } | null;
    const commands = await same(r, '/api/commands', q) as { commands: { id: string }[] } | null;
    await same(r, '/api/commands', q + '&running=1');
    for (const command of commands?.commands ?? []) await same(r, '/api/command', `${q}&id=${encodeURIComponent(command.id)}`);
    await same(r, '/api/command', `${q}&id=nope`);
    for (const agent of agents?.agents ?? []) {
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

Deno.test('golden: record shapes from the Python tests', async () => {
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

Deno.test('golden: a record Python cannot read fails the same way', async () => {
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
    for (let n = 0; n < 3; n++) await same(r, '/api/transcript', 'key=claude/' + key); // Python fails once, then reads past the record
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

Deno.test('golden: a large synthetic chat (and parse time against Python)', async () => {
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
  const expected = await py.call('monitor_shim', 'snapshot', [path]) as Record<string, unknown>;
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
  const d = diff(actual, expected);
  assert(d === null, d ?? '');
  // Timing: best of three cold parses each.
  const timings: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await new Transcript(path).refresh();
    timings.push((performance.now() - start) / 1000);
  }
  const deno = Math.min(...timings);
  const python = await py.call('monitor_shim', 'time_parse', [path]) as number;
  const size = (await Deno.stat(path)).size;
  console.log(
    `big transcript: ${lineCount} lines, ${(size / 1048576).toFixed(1)} MB, ${t.events.length} events; parse Deno ${
      deno.toFixed(3)
    } s, Python ${python.toFixed(3)} s (${(python / deno).toFixed(2)}x)`,
  );
});

Deno.test('golden: summary', async () => {
  await py.call('monitor_shim', 'reset');
  await py.close();
  console.log(`golden replies compared: ${compared}`);
  console.log([...tally].sort().map(([k, v]) => `  ${v}  ${k}`).join('\n'));
  try {
    Deno.removeSync(TMP, { recursive: true });
  } catch { /* Windows may hold a file briefly */ }
});
