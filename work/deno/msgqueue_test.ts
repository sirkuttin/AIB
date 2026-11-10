/**
 * server/acp/msgqueue.ts: MessageQueue bookkeeping and QueueStore files, plus parity with msgqueue.py.
 *
 * work/test_queue.py drives a whole Connection with a fake agent, so its cases are re-expressed here against MessageQueue alone
 * (the sending itself belongs to the Connection port). Parity: the same scripted operation sequences run on a Python
 * MessageQueue (a small driver below) and on the port, and each side's QueueStore reads the other's file.
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { PY_REF_DIR, python } from './_parity.ts';
import {
  HOLD_MESSAGES,
  MAX_ITEMS,
  MAX_SESSIONS,
  MessageQueue,
  QueueStore,
  ValueError,
} from '../../outputs/agent-studio/server/acp/msgqueue.ts';
import { writeJsonAtomic } from '../../outputs/agent-studio/server/core/fs.ts';

class FakeClock {
  constructor(public now = 1000.0) {}
  readonly call = () => this.now;
  advance(seconds: number) {
    this.now += seconds;
  }
}

function queue(clock = new FakeClock()): [MessageQueue, FakeClock] {
  return [new MessageQueue(null, clock.call), clock];
}

const ids = (q: MessageQueue) => (q.public().items as { id: string }[]).map((i) => i.id);

function message(fn: () => unknown): string {
  return assertThrows(fn, ValueError).message;
}

// ---- MessageQueue: the queue rules test_queue.py checks through a Connection ----------------------

Deno.test('items wait first in first out and the first is next up', () => {
  const [q] = queue();
  q.add('a', 'one', null, 'f');
  q.add('b', 'two', [], 'f');
  assertEquals(ids(q), ['a', 'b']);
  assertEquals(q.head()?.id, 'a');
  assertEquals(q.pauseReason(), '');
  assert(q.has('a') && !q.has('c'));
  const item = q.items[0];
  assertEquals(Object.keys(item), ['id', 'text', 'attachments', 'fingerprint', 'queuedAt', 'lease', 'note']);
  assert(Math.abs(item.queuedAt - Date.now() / 1000) < 60, 'queuedAt is wall time in seconds');
});

Deno.test('at most MAX_ITEMS can wait', () => {
  const [q] = queue();
  for (let n = 0; n < MAX_ITEMS; n++) q.add(`m${n}`, 'x', null, '');
  assertEquals(message(() => q.add('one-more', 'x', null, '')), 'At most 50 messages can wait in the queue');
});

Deno.test('remove and reorder (test_remove_and_reorder)', () => {
  const [q] = queue();
  for (const name of 'abc') q.add(name, 'mcp', null, '');
  q.move('c', 0);
  assertEquals(ids(q), ['c', 'a', 'b']);
  q.remove('a');
  assertEquals(ids(q), ['c', 'b']);
  assertEquals(message(() => q.remove('a')), 'That message is no longer queued');
  assertEquals(message(() => q.move('a', 0)), 'That message is no longer queued');
  q.move('c', 99);
  assertEquals(ids(q), ['b', 'c']);
  q.move('c', -5);
  assertEquals(ids(q), ['c', 'b']);
});

Deno.test('an edit lease pauses the queue while it is open; releasing resumes it', () => {
  const [q] = queue();
  q.add('a', 'mcp', null, '');
  q.add('b', 'mcp', null, '');
  const lease = q.acquire('a').lease!.id;
  assert(/^[0-9a-f]{32}$/.test(lease), 'uuid4().hex form');
  assertEquals(q.public().reason, 'editing');
  assertEquals(q.public().message, 'Paused while you edit');
  assertEquals(q.public().paused, true);
  q.renew('a', lease);
  q.release('a', lease);
  assertEquals(q.public().reason, '');
  assertEquals(message(() => q.release('a', lease)), 'This edit is no longer open');
});

Deno.test('editing a later message does not block earlier ones but pauses at it', () => {
  const [q] = queue();
  q.add('a', 'x', null, '');
  q.add('b', 'x', null, '');
  q.acquire('b', 'L');
  assertEquals(q.pauseReason(), '');
  q.inflight = q.items.shift()!; // 'a' goes out
  assertEquals(q.pauseReason(), 'editing');
  const items = q.public().items as Record<string, unknown>[];
  assertEquals(items.map((i) => [i.id, i.sending, i.editing]), [['a', true, false], ['b', false, true]]);
});

Deno.test('an expired lease keeps the queue paused (abandoned) until resumed or removed', () => {
  const [q, clock] = queue();
  q.add('a', 'x', null, '');
  q.add('b', 'x', null, '');
  q.acquire('a');
  clock.advance(q.leaseSeconds + 1);
  const state = q.public();
  assertEquals(state.reason, 'abandoned');
  assert((state.message as string).includes('was being edited'));
  assertEquals((state.items as Record<string, unknown>[])[0].leaseActive, false);
  q.resume();
  assertEquals(q.pauseReason(), '');
  assertEquals(q.items[0].lease, null);

  const [r, clock2] = queue();
  r.add('a', 'x', null, '');
  r.add('b', 'x', null, '');
  r.acquire('a');
  clock2.advance(r.leaseSeconds + 1);
  r.remove('a');
  assertEquals([ids(r), r.pauseReason()], [['b'], '']);
});

Deno.test('a second editor cannot take an active lease, but can take an expired one', () => {
  const [q, clock] = queue();
  q.add('a', 'x', null, '');
  q.acquire('a', 'one');
  assertEquals(message(() => q.acquire('a', 'two')), 'That message is already open for editing');
  assertEquals(message(() => q.renew('a', 'two')), 'This edit is no longer open');
  q.acquire('a', 'one'); // the same editor re-acquires
  clock.advance(601);
  assertEquals(q.acquire('a', 'two').lease, { id: 'two', expires: 1601 + 600 });
  assertEquals(message(() => q.acquire('zz')), 'That message is no longer queued (it may already have been sent)');
  assertEquals(message(() => q.renew('zz', 'two')), 'That message is no longer queued (it may already have been sent)');
});

Deno.test('holds pause the queue with their message; removing the last item clears unknown and error', () => {
  for (const [hold, text] of Object.entries(HOLD_MESSAGES)) {
    const [q] = queue();
    q.hold = hold;
    assertEquals(q.public().reason, '', 'an empty queue is never paused');
    q.add('a', 'x', null, '');
    assertEquals([q.public().reason, q.public().message], [hold, text]);
    q.remove('a');
    assertEquals(q.hold, hold === 'unknown' || hold === 'error' ? '' : hold);
  }
});

Deno.test('to_saved drops leases and puts the item in flight first; load restores paused', () => {
  const [q] = queue();
  q.add('a', 'x', [{ type: 'image', data: 'AAAA' }], 'fa');
  q.add('b', 'y', null, 'fb');
  q.acquire('b', 'L');
  q.inflight = q.items.shift()!;
  const saved = q.toSaved();
  assertEquals(saved.map((s) => [s.id, s.lease]), [['a', null], ['b', null]]);
  assert(q.items[0].lease !== null, 'the live item keeps its lease');
  const [r] = queue();
  r.load(saved);
  assertEquals([ids(r), r.hold, r.pauseReason()], [['a', 'b'], 'restart', 'restart']);
  r.load([]);
  assertEquals(r.hold, '');
});

// ---- QueueStore ------------------------------------------------------------------------------------

Deno.test('QueueStore saves atomically, forgets empty chats and reloads', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-queue-' });
  try {
    const store = new QueueStore(`${dir}/state`, 'queues-t');
    assertEquals(store.warning, '');
    store.forget('omp', 's1'); // nothing to forget: no file written
    assertThrows(() => Deno.statSync(store.path));
    store.put('omp', 's1', [{ id: 'a', text: 'x' }]);
    assert(Deno.statSync(`${dir}/state/studio-queues-t.json`).isFile);
    const copy = store.get('omp', 's1');
    copy[0].text = 'changed';
    assertEquals(store.get('omp', 's1'), [{ id: 'a', text: 'x' }]);
    assertEquals(new QueueStore(`${dir}/state`, 'queues-t').get('omp', 's1'), [{ id: 'a', text: 'x' }]);
    store.forget('omp', 's1');
    assertEquals(new QueueStore(`${dir}/state`, 'queues-t').get('omp', 's1'), []);
    assertEquals([...Deno.readDirSync(`${dir}/state`)].map((e) => e.name), ['studio-queues-t.json'], 'no temp files left');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('QueueStore keeps the newest MAX_SESSIONS chats', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-queue-' });
  try {
    const store = new QueueStore(dir, 'q');
    for (let n = 0; n < MAX_SESSIONS + 3; n++) store.put('p', `s${n}`, [{ id: `${n}`, text: 't' }]);
    store.put('p', 's3', [{ id: 'again', text: 't' }]); // touched: moves to the newest end
    const keys = [...new QueueStore(dir, 'q').sessions.keys()];
    assertEquals(keys.length, MAX_SESSIONS);
    assertEquals(keys.slice(0, 2), ['p:s4', 'p:s5']);
    assertEquals(keys.at(-1), 'p:s3');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('QueueStore ignores unreadable files with a warning and reports save failures', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-queue-' });
  try {
    for (const bad of ['{not json', '﻿{"version":1,"sessions":{}}']) {
      Deno.writeTextFileSync(`${dir}/studio-q.json`, bad);
      assertEquals(new QueueStore(dir, 'q').warning, 'Saved queued messages were unreadable and were ignored.');
    }
    Deno.writeFileSync(`${dir}/studio-q.json`, new Uint8Array([0x7b, 0xff, 0x7d]));
    assertEquals(new QueueStore(dir, 'q').warning, 'Saved queued messages were unreadable and were ignored.');
    for (
      const ignored of [
        '{"version":2,"sessions":{"p:s":[1]}}',
        '[]',
        '{"version":1,"sessions":[]}',
        '{"version":1,"sessions":{"p:s":[],"p:t":"x"}}',
      ]
    ) {
      Deno.writeTextFileSync(`${dir}/studio-q.json`, ignored);
      const store = new QueueStore(dir, 'q');
      assertEquals([store.warning, store.sessions.size], ['', 0], ignored);
    }
    Deno.mkdirSync(`${dir}/blocked/studio-q.json`, { recursive: true }); // a folder where the file should be
    const store = new QueueStore(`${dir}/blocked`, 'q');
    assertEquals(store.warning, 'Saved queued messages were unreadable and were ignored.');
    store.put('p', 's', [{ id: 'a', text: 'x' }]);
    assert(store.warning.startsWith('Studio could not save queued messages: '), store.warning);
    assertEquals(store.get('p', 's'), [{ id: 'a', text: 'x' }], 'kept in memory');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('writeJsonAtomic replaces an existing file and creates the folder', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-fs-' });
  try {
    const path = `${dir}/a/b/x.json`;
    writeJsonAtomic(path, { a: 1 });
    writeJsonAtomic(path, { a: 'ü', b: [1.5, null] });
    assertEquals(JSON.parse(Deno.readTextFileSync(path)), { a: 'ü', b: [1.5, null] });
    writeJsonAtomic(path, null, { text: 'raw' });
    assertEquals(Deno.readTextFileSync(path), 'raw');
    assertEquals([...Deno.readDirSync(`${dir}/a/b`)].map((e) => e.name), ['x.json']);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ---- parity with msgqueue.py ---------------------------------------------------------------------

/** Runs an operation script on a Python MessageQueue / QueueStore. No backslashes: it travels as a -c argument. */
const DRIVER = `
import json, sys
sys.path.insert(0, sys.argv[1])
import msgqueue

class Clock:
    now = 1000.0
    def __call__(self):
        return self.now

def run(ops):
    clock = Clock()
    q = msgqueue.MessageQueue(None, clock)
    out = []
    for op in ops:
        name, args = op[0], op[1:]
        try:
            if name == 'advance':
                clock.now += args[0]; result = None
            elif name == 'hold':
                q.hold = args[0]; result = None
            elif name == 'send':
                q.inflight = q.items.pop(0); result = None
            elif name == 'sent':
                q.inflight = None; result = None
            elif name == 'pause_reason':
                result = q.pause_reason()
            elif name == 'public':
                result = q.public(*args)
            elif name == 'to_saved':
                result = q.to_saved()
            elif name == 'summary':
                result = msgqueue.MessageQueue.attachment_summary(*args)
            else:
                result = getattr(q, name)(*args)
            out.append({'ok': result})
        except Exception as error:
            out.append({'error': type(error).__name__, 'message': str(error)})
    return out

request = json.loads(sys.stdin.read())
if request['kind'] == 'queue':
    print(json.dumps([run(ops) for ops in request['scripts']]))
elif request['kind'] == 'store_read':
    store = msgqueue.QueueStore(request['dir'], request['name'])
    print(json.dumps({'warning': store.warning, 'sessions': store.sessions, 'gets': [store.get(*k) for k in request['keys']]}))
elif request['kind'] == 'store_write':
    store = msgqueue.QueueStore(request['dir'], request['name'])
    for provider, session, saved in request['puts']:
        store.put(provider, session, saved)
    print(json.dumps({'warning': store.warning}))
`;

async function runPython(request: unknown): Promise<unknown> {
  const child = new Deno.Command(python(), {
    args: ['-X', 'utf8', '-I', '-c', DRIVER, PY_REF_DIR],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    env: { PYTHONDONTWRITEBYTECODE: '1' },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(request)));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`python driver failed: ${new TextDecoder().decode(stderr)}`);
  return JSON.parse(new TextDecoder().decode(stdout));
}

type Op = [string, ...unknown[]];

function runPort(ops: Op[]): unknown[] {
  const clock = new FakeClock();
  const q = new MessageQueue(null, clock.call);
  const out: unknown[] = [];
  for (const [name, ...args] of ops) {
    try {
      let result: unknown = null;
      if (name === 'advance') clock.advance(args[0] as number);
      else if (name === 'hold') q.hold = args[0] as string;
      else if (name === 'send') q.inflight = q.items.shift()!;
      else if (name === 'sent') q.inflight = null;
      else if (name === 'pause_reason') result = q.pauseReason();
      else if (name === 'public') result = q.public(...(args as [boolean]));
      else if (name === 'to_saved') result = q.toSaved();
      else if (name === 'summary') result = MessageQueue.attachmentSummary(args[0]);
      else {
        const method = { lease_active: 'leaseActive' }[name] ?? name;
        result = (q as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
      }
      out.push({ ok: result === undefined ? null : result });
    } catch (error) {
      out.push({ error: (error as Error).name, message: (error as Error).message });
    }
  }
  return out;
}

/** queuedAt is wall time on both sides (not the injected clock): compare that it is a number, not its value. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'queuedAt' && typeof v === 'number' && v > 1e9 ? 'NOW' : normalize(v)]),
    );
  }
  return value;
}

const long = 'é😀'.repeat(200);
const ATTACHMENTS = [
  { type: 'image', mimeType: 'image/png', data: 'AAAA' },
  { mimeType: 'image/jpeg' },
  { type: null, name: 5 },
  { type: 'file', name: '', mimeType: '' },
  { name: [1, 'a', null, true, 1.5] },
  { name: { k: "it's", n: 1e-7, big: 1e17 } },
  { name: long },
  { name: false, mimeType: 0 },
  'not a dict',
  null,
];

const SCRIPTS: Op[][] = [
  // order, limits, remove / move with odd indexes, holds
  [
    ['add', 'a', 'one', null, 'f'],
    ['add', 'b', long, ATTACHMENTS, 'g'],
    ['add', 'c', 'three', [], ''],
    ['public'],
    ['public', true],
    ['move', 'c', 0],
    ['move', 'c', '2'],
    ['move', 'c', ' -1 '],
    ['move', 'a', 1.7],
    ['move', 'a', -0.5],
    ['move', 'a', true],
    ['move', 'a', 'x'],
    ['move', 'a', '1.5'],
    ['move', 'a', null],
    ['move', 'a', [1]],
    ['move', 'a', '1_0'],
    ['move', 'zz', 0],
    ['to_saved'],
    ['hold', 'unknown'],
    ['public'],
    ['remove', 'a'],
    ['remove', 'b'],
    ['pause_reason'],
    ['remove', 'c'],
    ['public'],
    ['remove', 'c'],
  ],
  // leases: editing, renew, expire, abandon, resume, second editor
  [
    ['add', 'a', 'x', null, ''],
    ['add', 'b', 'y', null, ''],
    ['acquire', 'a', 'L1'],
    ['public'],
    ['acquire', 'a', 'L2'],
    ['acquire', 'a', 'L1'],
    ['advance', 300],
    ['renew', 'a', 'L1'],
    ['renew', 'a', 'L2'],
    ['renew', 'zz', 'L1'],
    ['advance', 601],
    ['public'],
    ['acquire', 'b', 'L3'],
    ['acquire', 'a', 'L2'],
    ['release', 'a', 'L1'],
    ['release', 'a', 'L2'],
    ['release', 'a', 'L2'],
    ['acquire', 'zz', 'L1'],
    ['pause_reason'],
    ['send'],
    ['public'],
    ['has', 'a'],
    ['has', 'b'],
    ['has', 'q'],
    ['to_saved'],
    ['advance', 1000],
    ['public'],
    ['resume'],
    ['public'],
    ['sent'],
    ['hold', 'needs_you'],
    ['public'],
    ['resume'],
    ['public'],
  ],
  // load: what survives a hand-edited or foreign file
  [
    ['load', [
      { id: 'a', text: 'x', attachments: 'nope', fingerprint: null, queuedAt: '12.5', note: 5, lease: { id: 'L', expires: 9e9 }, extra: 1 },
      { id: 'b'.repeat(100) + '😀'.repeat(60), text: 'y', queuedAt: 7, note: '' },
      { id: 'c', text: 'z', queuedAt: [], fingerprint: [], note: {} },
      { id: 'd', text: 'w', queuedAt: false, fingerprint: { a: 1 }, note: ['n'] },
      { id: 5, text: 'x' },
      { id: 'e' },
      'x',
      null,
    ]],
    ['public'],
    ['to_saved'],
    ['load', [{ id: 'f', text: 'x', queuedAt: 'abc' }]],
    ['public'],
    ['load', [{ id: 'g', text: 'x', queuedAt: [1] }]],
    ['load', [{ id: 'h', text: 'x', queuedAt: ' 1_000.5e1 ' }], 'unknown'],
    ['public'],
    ['load', 'not a list'],
    ['public'],
    ['load', Array.from({ length: 60 }, (_, n) => ({ id: `m${n}`, text: 't', queuedAt: n }))],
    ['to_saved'],
  ],
  // attachment summaries and the item limit
  [
    ['summary', ATTACHMENTS],
    ['summary', null],
    ['summary', 'abc'],
    ...Array.from({ length: MAX_ITEMS + 1 }, (_, n): Op => ['add', `m${n}`, 't', null, 'f']),
    ['public', true],
  ],
];

Deno.test('scripted MessageQueue sequences give what Python gives', async () => {
  const expected = await runPython({ kind: 'queue', scripts: SCRIPTS }) as unknown[][];
  SCRIPTS.forEach((ops, s) => {
    const actual = runPort(ops);
    ops.forEach((op, i) =>
      assertEquals(normalize(actual[i]), normalize(expected[s][i]), `script ${s} step ${i} ${JSON.stringify(op).slice(0, 60)}`)
    );
  });
});

const SAVED_A = [{
  id: 'a',
  text: 'héllo 😀',
  attachments: [{ type: 'image', data: 'AAAA' }],
  fingerprint: 'fp',
  queuedAt: 1731234567.123456,
  lease: null,
  note: '',
}];
const SAVED_B = [{ id: 'b', text: 'two', attachments: [], fingerprint: '', queuedAt: 5.5, lease: null, note: 'n' }];

Deno.test('a QueueStore file written by Deno is read by Python, and the other way round', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-queue-' });
  try {
    const keys = [['omp', 's1'], ['claude', 'x:y'], ['omp', 'gone']];
    // Deno writes, Python reads
    const store = new QueueStore(dir, 'queues-deno');
    store.put('omp', 's1', SAVED_A);
    store.put('claude', 'x:y', SAVED_B);
    store.put('omp', 'gone', SAVED_B);
    store.forget('omp', 'gone');
    const py = await runPython({ kind: 'store_read', dir, name: 'queues-deno', keys }) as Record<string, unknown>;
    assertEquals(py, { warning: '', sessions: Object.fromEntries(store.sessions), gets: keys.map(([p, s]) => store.get(p, s)) });

    // Python writes, Deno reads
    const puts = [['omp', 's1', SAVED_A], ['claude', 'x:y', SAVED_B], ['omp', 'gone', SAVED_B], ['omp', 'gone', []], [
      'omp',
      's1',
      SAVED_A,
    ]];
    assertEquals(await runPython({ kind: 'store_write', dir, name: 'queues-py', puts }), { warning: '' });
    const fromPy = new QueueStore(dir, 'queues-py');
    assertEquals(fromPy.warning, '');
    assertEquals([...fromPy.sessions.keys()], ['claude:x:y', 'omp:s1']);
    assertEquals(fromPy.get('omp', 's1'), SAVED_A);
    const pyFile = JSON.parse(Deno.readTextFileSync(`${dir}/studio-queues-py.json`));
    const denoFile = JSON.parse(Deno.readTextFileSync(`${dir}/studio-queues-deno.json`));
    assertEquals(Object.keys(pyFile), ['version', 'savedAt', 'sessions']);
    assertEquals(Object.keys(denoFile), Object.keys(pyFile));
    assert(Math.abs(denoFile.savedAt - pyFile.savedAt) < 60, 'savedAt is seconds on both sides');

    // the same puts on the Deno side give the same sessions as Python wrote
    const mirror = new QueueStore(dir, 'queues-mirror');
    for (const [p, s, saved] of puts) mirror.put(p as string, s as string, saved as unknown[]);
    assertEquals(Object.fromEntries(mirror.sessions), pyFile.sessions);

    // a Deno-restored queue from a Python file matches a Python-restored one
    const q = new MessageQueue();
    q.load(fromPy.get('omp', 's1'));
    const expected = await runPython({
      kind: 'queue',
      scripts: [[['load', fromPy.get('omp', 's1')], ['public'], ['to_saved']]],
    }) as unknown[][];
    assertEquals([{ ok: null }, { ok: q.public() }, { ok: q.toSaved() }], expected[0]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('both sides warn the same way about a file they cannot read', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-queue-' });
  try {
    for (const bad of ['{oops', '﻿{}', '{"version":1,"sessions":{"p:s":[{"id":"a","text":"x"}],"p:t":[],"p:u":"x"}}']) {
      Deno.writeTextFileSync(`${dir}/studio-bad.json`, bad);
      const store = new QueueStore(dir, 'bad');
      const py = await runPython({ kind: 'store_read', dir, name: 'bad', keys: [['p', 's']] });
      assertEquals({ warning: store.warning, sessions: Object.fromEntries(store.sessions), gets: [store.get('p', 's')] }, py, bad);
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
