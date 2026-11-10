/**
 * server/ownership/probe.ts: the cases of work/test_ownership_probe.py (and the ps cases of test_portability.py) that exercise
 * ownership_probe.py directly, each run against the Python probe too (work/parity/ownership_shim.py run_probe) and compared field by
 * field; plus interop: announcements written by one side are read by the other, and a real process holding a transcript open and
 * naming the session on its command line is reported the same by both probes. Temp folders only; never the real owners folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity, python } from './_parity.ts';
import {
  announcementPrefix,
  classify,
  cleanText,
  fetchProcessesPs,
  humanizeAge,
  iso,
  lockHolders,
  OwnerRegistry,
  OwnershipProbe,
  parseIso,
  processAlive,
  ProcessSource,
  processStartTime,
  type ProcInfo,
  validateAnnouncement,
} from '../../outputs/agent-studio/server/ownership/probe.ts';
import { dirname, join } from '../../outputs/agent-studio/server/platform/ospath.ts';

const WINDOWS = Deno.build.os === 'windows';
const NOW = 1_800_000_000.0;
const BIN = WINDOWS ? 'C:\\x\\' : '/x/';
const SEP = WINDOWS ? '\\' : '/';
const exe = (name: string) => name + (WINDOWS ? '.exe' : '');
const binpath = (name: string) => BIN + exe(name);
const proc = (pid: number, name: string, cmdline: string | null = '', cwd: string | null = null, ppid = 1): ProcInfo => ({
  pid,
  ppid,
  name,
  cmdline,
  cwd,
});

let current: PyParity | null = null;
function py(): PyParity {
  if (!current) throw new Error('no Python parity process: use pyTest/probeTest');
  return current;
}

/** A test with its own Python parity process (a process shared across tests would trip Deno's resource sanitizer). */
function pyTest(name: string, fn: () => Promise<void> | void) {
  Deno.test(name, async () => {
    current = new PyParity();
    try {
      await fn();
    } finally {
      await current.close();
      current = null;
    }
  });
}

function setMtime(path: string, when: number) {
  Deno.utimeSync(path, when, when);
}

/** One temp tree (omp, claude, owners) rebuilt from scratch by setup() before each side runs. */
class Tree {
  readonly base = Deno.makeTempDirSync({ prefix: 'probe-test-' });
  readonly omp = join(this.base, 'omp');
  readonly claude = join(this.base, 'claude');
  readonly owners = join(this.base, 'owners');
  readonly project = join(this.base, 'studio-probe-project');
  #setup: (() => void)[] = [];

  reset() {
    for (const dir of [this.omp, this.claude, this.owners]) {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* not there */ }
    }
    for (const step of this.#setup) step();
  }

  transcriptPath(provider: string, session: string, folder = 'proj'): string {
    const root = provider === 'omp' ? this.omp : this.claude;
    return join(root, folder, provider === 'omp' ? `2026-11-07T00-00-00-000Z_${session}.jsonl` : `${session}.jsonl`);
  }

  transcript(provider: string, session: string, age: number, folder = 'proj', size = 10): string {
    const path = this.transcriptPath(provider, session, folder);
    this.#setup.push(() => {
      Deno.mkdirSync(dirname(path), { recursive: true });
      Deno.writeTextFileSync(path, 'x'.repeat(size));
      setMtime(path, NOW - age);
    });
    this.reset();
    return path;
  }

  file(path: string, text: string, age: number) {
    this.#setup.push(() => {
      Deno.mkdirSync(dirname(path), { recursive: true });
      Deno.writeTextFileSync(path, text);
      setMtime(path, NOW - age);
    });
    this.reset();
  }

  /** Another client's announcement, written by hand exactly as the documented format says. */
  foreign(session: string, fields: Record<string, unknown> = {}, provider = 'omp', raw?: string) {
    const body = {
      format: 'agent-session-owner',
      version: 1,
      provider,
      sessionId: session,
      client: { name: 'devin-vscode', version: '1.0', instanceId: 'theirs' },
      pid: Deno.pid,
      hostname: Deno.hostname(),
      cwd: 'C:/x',
      state: 'working',
      announcedAt: iso(NOW - 100),
      heartbeatAt: iso(NOW - 5),
      ttlSeconds: 30,
      ...fields,
    };
    const path = join(this.owners, `${announcementPrefix(provider, session)}--theirs.json`);
    this.#setup = this.#setup.filter((step) => (step as { path?: string }).path !== path);
    const step = Object.assign(() => {
      Deno.mkdirSync(this.owners, { recursive: true });
      Deno.writeTextFileSync(path, raw ?? JSON.stringify(body));
    }, { path });
    this.#setup.push(step);
    this.reset();
    return body;
  }

  async cleanup() {
    for (let attempt = 0;; attempt++) {
      try {
        Deno.removeSync(this.base, { recursive: true });
        return;
      } catch (error) {
        if (attempt > 50) throw error;
        await new Promise((r) => setTimeout(r, 100)); // a killed holder may keep its files for a moment
      }
    }
  }
}

type Step = Record<string, unknown>;
interface Fixture {
  processes?: ProcInfo[] | { error: string } | 'real';
  holders?: [number, string][] | null | 'real';
  studio_owned?: [string, string][];
  own_pids?: number[];
  inspect?: boolean;
  owners?: boolean;
  now?: number | null;
  steps: Step[];
}

/** The Deno side of run_probe. */
function runDeno(tree: Tree, fixture: Fixture) {
  let now = fixture.now === undefined ? NOW : fixture.now;
  const clock = now === null ? undefined : () => now!;
  const processes = fixture.processes ?? [];
  const source = processes === 'real' ? new ProcessSource(undefined, undefined, clock) : new ProcessSource(
    () => {
      if (!Array.isArray(processes)) throw new Error(processes.error);
      return processes.map((p) => ({ ...p }));
    },
    undefined,
    clock,
  );
  const holders = fixture.holders === undefined ? [] : fixture.holders;
  const owned = new Set((fixture.studio_owned ?? []).map((x) => JSON.stringify(x)));
  const probe = new OwnershipProbe({
    ompRoot: tree.omp,
    claudeRoot: tree.claude,
    registry: fixture.owners === false ? null : new OwnerRegistry(tree.owners, { instanceId: 'mine', clock }),
    processes: source,
    ownedByStudio: (p, s) => owned.has(JSON.stringify([p, s])),
    ownPids: () => fixture.own_pids ?? [],
    lockProbe: holders === 'real' ? lockHolders : () => (holders === null ? null : holders.map((h) => [h[0], h[1]] as [number, string])),
    clock,
    inspectProcesses: fixture.inspect ?? true,
  });
  const out: unknown[] = [];
  for (const step of fixture.steps) {
    if (step.assess) {
      const [provider, session] = step.assess as [string, string];
      const result = probe.assess(provider, session, {
        cwd: (step.cwd as string) ?? null,
        deep: (step.deep as boolean) ?? true,
        skipCmdline: (step.skip_cmdline as boolean) ?? false,
        fresh: (step.fresh as boolean) ?? false,
        projectRoot: (step.project_root as string) ?? null,
      });
      delete result.elapsedMs;
      out.push(result);
    } else if (step.released) {
      probe.noteReleased(...(step.released as [string, string]));
      out.push(null);
    } else if (step.hints) out.push(probe.hints());
    else if (step.certainty) out.push(probe.listCertainty());
    else if (step.advance) {
      now = now! + (step.advance as number);
      out.push(null);
    } else if (step.get) out.push(source.get()[1]);
    else if (step.touch) {
      const [path, size, age] = step.touch as [string, number, number];
      Deno.writeTextFileSync(path, 'x'.repeat(size));
      setMtime(path, now! - age);
      out.push(null);
    }
  }
  return { steps: out, fetches: source.fetches };
}

/** Run the fixture on Python, rebuild the tree, run it on Deno; both must agree. Returns the Deno step results. */
async function both(tree: Tree, fixture: Fixture): Promise<Record<string, unknown>[]> {
  tree.reset();
  const expected = await py().call('ownership_shim', 'run_probe', [{
    now: NOW,
    ...fixture,
    omp: tree.omp,
    claude: tree.claude,
    owners: fixture.owners === false ? null : tree.owners,
  }]);
  tree.reset();
  const actual = runDeno(tree, fixture);
  assertEquals(JSON.parse(JSON.stringify(actual)), expected, JSON.stringify(fixture.steps).slice(0, 120));
  return actual.steps as Record<string, unknown>[];
}

const assess = (provider: string, session: string, extra: Step = {}): Step => ({ assess: [provider, session], ...extra });

function probeTest(name: string, fn: (tree: Tree) => Promise<void> | void) {
  pyTest(name, async () => {
    const tree = new Tree();
    try {
      await fn(tree);
    } finally {
      await tree.cleanup();
    }
  });
}

async function deadPidAsync(): Promise<number> {
  const child = new Deno.Command(python(), { args: ['-c', 'pass'], stdout: 'null', stderr: 'null' }).spawn();
  await child.status;
  return child.pid;
}

// --- pure helpers ------------------------------------------------------------------------------------------------------------------

pyTest('cleanText, humanizeAge, iso, parseIso and announcementPrefix match Python', async () => {
  const texts = [
    'a\x00b\n c',
    'x'.repeat(500),
    '<img src=x onerror=1>\n\x1b[31mred',
    '  tab\tbed  ',
    'ünï\u2028cødé 😀'.repeat(20),
    '\u200b zero',
    '',
  ];
  await py().same('ownership_probe', 'clean_text', texts.map((t) => [t]), cleanText);
  await py().same('ownership_probe', 'clean_text', texts.map((t) => [t, 10]), cleanText);
  const ages = [0, 1, 1.9, 2, 59, 89.9, 90, 149, 150, 151, 5399, 5400, 9000, 3600 * 47, 3600 * 48, 86400 * 2.5, 86400 * 3.5, -5];
  await py().same('ownership_probe', 'humanize_age', ages.map((a) => [a]), humanizeAge);
  await py().same('ownership_probe', '_iso', [[NOW], [NOW + 0.9999999], [0], [1234567890.5]], iso);
  const isos = [
    '2026-11-07T00:00:00Z',
    '2026-11-07T00:00:00+00:00',
    '2026-11-07T01:02:03.456789+02:00',
    '2026-11-07T01:02:03.4-05:30',
    '2026-11-07',
    '2026-11-07 10:20',
    '2026-11-07T10',
    '20261107T102030',
    '2026-11-07T10:20:30,5Z',
    'garbage',
    '',
    '2026-13-01T00:00:00Z',
    '2026-02-30',
    '2026-11-07T24:00:00',
    '2026-11-07T10:20:30.1234567Z',
    '2026-11-07T10:20:30+0200',
    '2026-11-07X10:20:30',
    5,
    null,
    '2026-11-0710:20',
  ];
  await py().same('ownership_probe', '_parse_iso', isos.map((v) => [v]), parseIso);
  await py().same('ownership_probe', 'announcement_prefix', [['omp', 'sess-1'], ['claude', 'ü😀'], ['', '']], announcementPrefix);
});

pyTest('classify matches Python for agents, helpers and other processes', async () => {
  const procs = [
    proc(1, exe('claude'), `"${binpath('Claude')}" --type=renderer`),
    proc(2, exe('node'), `${exe('node')} tool.mjs mcp`),
    proc(3, exe('devin'), `${exe('devin')} acp --agent-type summarizer`),
    proc(4, exe('devin'), `${exe('devin')} acp`),
    proc(5, exe('node'), `node ${BIN}claude-agent-acp${SEP}index.js --resume "abc-1"`),
    proc(6, exe('claude'), `${exe('claude')} --output-format stream-json --session-id=x.y_z`),
    proc(7, exe('omp'), `${exe('omp')} acp --resume s-9`),
    proc(8, 'C:\\Program Files\\Claude\\CLAUDE.EXE', 'claude-code'),
    proc(9, exe('claude'), 'plain'),
    proc(10, exe('omp'), null),
  ];
  await py().same('ownership_probe', 'classify', procs.map((p) => [p]), classify);
});

pyTest('validateAnnouncement accepts and refuses what Python does', async () => {
  const good = {
    format: 'agent-session-owner',
    version: 1,
    provider: 'omp',
    sessionId: 's',
    client: { name: 'n', version: 'v', instanceId: 'i' },
    pid: 12,
    pidStart: '2026-11-07T00:00:00Z',
    hostname: 'H',
    cwd: 'C:/x',
    state: 'ready',
    heartbeatAt: '2026-11-07T00:00:00Z',
    ttlSeconds: 30,
  };
  const cases: unknown[] = [
    good,
    { ...good, version: 2 },
    { ...good, format: 'x' },
    { ...good, provider: 'Bad' },
    { ...good, sessionId: '' },
    { ...good, sessionId: 'x'.repeat(513) },
    { ...good, pid: -4 },
    { ...good, pid: true },
    { ...good, heartbeatAt: 'nope' },
    { ...good, ttlSeconds: 1 },
    { ...good, ttlSeconds: 300.5 },
    { ...good, ttlSeconds: true },
    { ...good, client: [] },
    { ...good, client: { name: ['list'] } },
    { ...good, pidStart: null },
    { ...good, hostname: 5 },
    (({ ttlSeconds: _t, ...rest }) => rest)(good),
    [],
    'x',
    null,
    { ...good, client: { name: '<b>\n\x1bred' + 'y'.repeat(100) } },
  ];
  for (const data of cases) {
    for (const prefix of [null, announcementPrefix('omp', 's'), 'wrong']) {
      const expected = await py().raw('ownership_probe', 'validate_announcement', [data, prefix]);
      let actual: unknown;
      try {
        actual = { ok: JSON.parse(JSON.stringify(validateAnnouncement(data, prefix))) };
      } catch (error) {
        actual = { error: 'ValueError', message: (error as Error).message };
      }
      assertEquals(actual, expected, JSON.stringify(data).slice(0, 100));
    }
  }
});

// --- transcripts ------------------------------------------------------------------------------------------------------------------

probeTest('an old transcript is no evidence and never called safe', async (tree) => {
  tree.transcript('claude', 's1', 3600);
  const [verdict] = await both(tree, { steps: [assess('claude', 's1')] });
  assertEquals(verdict.verdict, 'no_evidence');
  assert((verdict.summary as string).includes('not proof'));
  assert(!(verdict.summary as string).toLowerCase().includes('safe'));
});

probeTest('a recent transcript is possibly active with its age', async (tree) => {
  tree.transcript('claude', 's1', 40);
  const [verdict] = await both(tree, { steps: [assess('claude', 's1')] });
  const reasons = verdict.reasons as Record<string, string>[];
  assertEquals([verdict.verdict, reasons[0].strength], ['possibly_active', 'weak']);
  assert(reasons[0].text.includes('40 seconds ago'));
});

probeTest('OMP transcripts are found by the session ID in the file name', async (tree) => {
  tree.transcript('omp', '01abc-def', 10);
  const steps = await both(tree, { steps: [assess('omp', '01abc-def'), assess('omp', '01abc')] });
  assertEquals(steps.map((s) => s.verdict), ['possibly_active', 'no_evidence']);
});

probeTest('growth between looks is reported', async (tree) => {
  const path = tree.transcript('claude', 's1', 5, 'proj', 10);
  const steps = await both(tree, { steps: [assess('claude', 's1'), { touch: [path, 400, 2] }, assess('claude', 's1')] });
  assert((steps[2].reasons as Record<string, string>[])[0].text.includes('grew by 390 bytes'));
});

probeTest('a Studio-owned conversation is never second-guessed', async (tree) => {
  tree.transcript('claude', 's1', 1);
  const [verdict] = await both(tree, { studio_owned: [['claude', 's1']], steps: [assess('claude', 's1')] });
  assertEquals([verdict.verdict, verdict.reasons], ['owned_by_studio', []]);
});

probeTest('writes just before Studio released it are not blamed on another app', async (tree) => {
  const path = tree.transcript('claude', 's1', 2);
  const steps = await both(tree, {
    steps: [{ released: ['claude', 's1'] }, assess('claude', 's1'), { advance: 30 }, { touch: [path, 4, 5] }, assess('claude', 's1')],
  });
  assertEquals([steps[1].verdict, steps[4].verdict], ['no_evidence', 'possibly_active']);
});

probeTest('subagent activity counts', async (tree) => {
  const main = tree.transcript('claude', 's1', 3000);
  tree.file(join(main.slice(0, -6), 'subagents', 'agent-1.jsonl'), 'x', 15);
  const [verdict] = await both(tree, { steps: [assess('claude', 's1')] });
  assertEquals(verdict.verdict, 'possibly_active');
  assert((verdict.reasons as Record<string, string>[])[0].text.includes('subagent transcript'));
});

probeTest('hostile session IDs never reach the file system', (tree) => {
  const probe = new OwnershipProbe({ claudeRoot: tree.claude });
  for (const bad of ['../x', 'a/b', '*', 'a'.repeat(200), '', 'x\0y']) assertEquals(probe.findTranscript('claude', bad), null);
});

// --- registry ---------------------------------------------------------------------------------------------------------------------

probeTest('announce writes the documented format and withdraw removes it', (tree) => {
  let now = NOW;
  const registry = new OwnerRegistry(tree.owners, { instanceId: 'mine', clock: () => now });
  assert(registry.announce('omp', 'sess-1', 'C:/work', 'opening'));
  const list = () => [...Deno.readDirSync(tree.owners)].map((e) => e.name);
  assertEquals(list().length, 1);
  const file = join(tree.owners, list()[0]);
  let data = JSON.parse(Deno.readTextFileSync(file));
  assertEquals([data.format, data.version, data.provider, data.sessionId, data.state], [
    'agent-session-owner',
    1,
    'omp',
    'sess-1',
    'opening',
  ]);
  assertEquals([data.pid, data.client.name, data.ttlSeconds], [Deno.pid, 'agent-studio', 30]);
  assert(list()[0].startsWith(announcementPrefix('omp', 'sess-1') + '--'));
  if (WINDOWS) assertEquals(data.pidStart, iso(processStartTime(Deno.pid)!));
  const announced = data.announcedAt;
  now += 10;
  registry.announce('omp', 'sess-1', 'C:/work', 'working');
  data = JSON.parse(Deno.readTextFileSync(file));
  assertEquals([data.state, data.announcedAt, data.heartbeatAt], ['working', announced, iso(now)]);
  registry.withdraw('omp', 'sess-1');
  registry.withdraw('omp', 'sess-1');
  assertEquals(list(), []);
});

probeTest('withdrawAll, and an unwritable folder', (tree) => {
  const registry = new OwnerRegistry(tree.owners, { instanceId: 'mine' });
  registry.announce('omp', 'a');
  registry.announce('claude', 'b');
  assertEquals(registry.claimed().length, 2);
  registry.withdrawAll();
  assertEquals([...Deno.readDirSync(tree.owners)], []);
  const blocker = join(tree.base, 'file');
  Deno.writeTextFileSync(blocker, 'x');
  const broken = new OwnerRegistry(join(blocker, 'sub'));
  assertEquals(broken.announce('omp', 'a'), false);
  assert(broken.writeError);
  assertEquals(registry.announce('Bad Provider', 'a'), false);
});

probeTest('our own announcement is not foreign evidence', async (tree) => {
  new OwnerRegistry(tree.owners, { instanceId: 'mine', clock: () => NOW }).announce('omp', 'sess-1');
  const owned = JSON.parse(Deno.readTextFileSync(join(tree.owners, [...Deno.readDirSync(tree.owners)][0].name)));
  tree.foreign('sess-1', { client: { name: 'agent-studio', instanceId: 'mine' }, heartbeatAt: owned.heartbeatAt });
  const [verdict] = await both(tree, { steps: [assess('omp', 'sess-1')] });
  assertEquals(verdict.verdict, 'no_evidence');
});

probeTest('a live foreign announcement is strong', async (tree) => {
  tree.foreign('sess-1');
  const [verdict] = await both(tree, { steps: [assess('omp', 'sess-1')] });
  const reasons = verdict.reasons as Record<string, string>[];
  assertEquals([verdict.verdict, reasons[0].strength], ['owned_elsewhere', 'strong']);
  assert(reasons[0].text.includes('devin-vscode'));
});

probeTest('a stale heartbeat with a running process is only weak', async (tree) => {
  tree.foreign('sess-1', { heartbeatAt: iso(NOW - 300) });
  const [verdict] = await both(tree, { steps: [assess('omp', 'sess-1')] });
  assertEquals(verdict.verdict, 'possibly_active');
  assert((verdict.reasons as Record<string, string>[])[0].text.includes('has not refreshed'));
});

probeTest('a dead PID is reported but does not block', async (tree) => {
  tree.foreign('sess-1', { pid: await deadPidAsync() });
  const [verdict] = await both(tree, { steps: [assess('omp', 'sess-1')] });
  assertEquals(verdict.verdict, 'no_evidence');
  assert((verdict.notes as string[]).some((n) => n.includes('no longer live')));
});

probeTest('a reused PID with a different start time is dead (Windows)', async (tree) => {
  if (!WINDOWS) return;
  const started = processStartTime(Deno.pid)!;
  tree.foreign('sess-1', { pidStart: iso(started - 86400) });
  assertEquals((await both(tree, { steps: [assess('omp', 'sess-1')] }))[0].verdict, 'no_evidence');
  tree.foreign('sess-1', { pidStart: iso(started) });
  assertEquals((await both(tree, { steps: [assess('omp', 'sess-1')] }))[0].verdict, 'owned_elsewhere');
});

probeTest('another computer is weak and never taken over automatically', async (tree) => {
  tree.foreign('sess-1', { hostname: 'SOMEPC-ELSEWHERE' });
  const [verdict] = await both(tree, { steps: [assess('omp', 'sess-1')] });
  assertEquals(verdict.verdict, 'possibly_active');
  assert((verdict.reasons as Record<string, string>[])[0].text.includes('SOMEPC-ELSEWHERE'));
  tree.foreign('sess-1', { hostname: 'SOMEPC-ELSEWHERE', heartbeatAt: iso(NOW - 999) });
  assertEquals((await both(tree, { steps: [assess('omp', 'sess-1')] }))[0].verdict, 'no_evidence');
});

probeTest('malformed, oversized, future and unknown-version files are ignored', async (tree) => {
  const good = tree.foreign('sess-1');
  const text = JSON.stringify(good);
  const cases: Record<string, string> = {
    garbage: '{not json',
    array: '[]',
    oversized: text + ' '.repeat(5000),
    version: JSON.stringify({ ...good, version: 2 }),
    format: JSON.stringify({ ...good, format: 'other' }),
    pid: JSON.stringify({ ...good, pid: -4 }),
    ttl: JSON.stringify({ ...good, ttlSeconds: 1 }),
    future: JSON.stringify({ ...good, heartbeatAt: iso(NOW + 86400) }),
    mismatch: JSON.stringify({ ...good, sessionId: 'different-session' }),
    bom: '\ufeff' + text,
    badutf8: text.replace('devin-vscode', 'devin-\udcff'),
  };
  for (const [name, content] of Object.entries(cases)) {
    tree.foreign('sess-1', {}, 'omp', content);
    const [verdict] = await both(tree, { steps: [assess('omp', 'sess-1')] });
    if (name === 'badutf8') continue; // a lone surrogate is written as U+FFFD by Deno: valid UTF-8, so not a problem file
    assertEquals(verdict.verdict, 'no_evidence', name);
    assert((verdict.notes as string[]).some((n) => n.includes('unreadable')), name);
  }
});

probeTest('a clock moved backwards slightly still counts as fresh', async (tree) => {
  tree.foreign('sess-1', { heartbeatAt: iso(NOW + 20) });
  assertEquals((await both(tree, { steps: [assess('omp', 'sess-1')] }))[0].verdict, 'owned_elsewhere');
});

probeTest('hostile text is flattened', async (tree) => {
  tree.foreign('sess-1', { client: { name: '<img src=x onerror=1>\n\x1b[31mred', instanceId: 'theirs' } });
  const [verdict] = await both(tree, { steps: [assess('omp', 'sess-1')] });
  const text = (verdict.reasons as Record<string, string>[])[0].text;
  assert(!text.includes('\n') && !text.includes('\x1b'));
  assertEquals(cleanText('a\x00b\n c'), 'a b c');
  assertEquals(cleanText('x'.repeat(500)).length, 120);
});

// --- processes --------------------------------------------------------------------------------------------------------------------

probeTest('a command-line session ID is strong', async (tree) => {
  const processes = [proc(500, exe('claude'), `${binpath('claude')} --output-format stream-json --resume=s-1`)];
  const steps = await both(tree, { processes, steps: [assess('claude', 's-1'), assess('claude', 's-2')] });
  assertEquals([steps[0].verdict, (steps[0].reasons as Record<string, number>[])[0].pid, steps[1].verdict], [
    'owned_elsewhere',
    500,
    'no_evidence',
  ]);
});

probeTest('an agent in the same project folder is weak and says it cannot tell', async (tree) => {
  const [processCwd, askedCwd, elsewhere] = WINDOWS
    ? ['c:\\REPOS\\Proj\\', 'C:\\repos\\proj', 'C:\\elsewhere']
    : ['/repos/proj/', '/repos/proj', '/elsewhere'];
  const processes = [proc(10, exe('Devin'), '', null, 0), proc(600, exe('omp'), `${binpath('omp')} acp`, processCwd, 10)];
  const steps = await both(tree, { processes, steps: [assess('omp', 'any', { cwd: askedCwd }), assess('omp', 'any', { cwd: elsewhere })] });
  const text = (steps[0].reasons as Record<string, string>[])[0].text;
  assertEquals([steps[0].verdict, steps[1].verdict], ['possibly_active', 'no_evidence']);
  assert(text.includes('PID 600') && text.includes('started by Devin') && text.includes('cannot tell'));
});

probeTest('an agent in either the cwd or the project root is found', async (tree) => {
  const main = join(tree.project, 'main');
  const wt = join(tree.project, 'wt');
  for (const where of [main, wt]) {
    const processes = [proc(10, exe('Devin'), '', null, 0), proc(600, exe('omp'), `${binpath('omp')} acp`, where, 10)];
    assertEquals(
      (await both(tree, { processes, steps: [assess('omp', 'any', { cwd: wt, project_root: main })] }))[0].verdict,
      'possibly_active',
    );
  }
  const processes = [proc(10, exe('Devin'), '', null, 0), proc(600, exe('omp'), `${binpath('omp')} acp`, main, 10)];
  const steps = await both(tree, {
    processes,
    steps: [
      assess('omp', 'any', { cwd: join(tree.project, 'x'), project_root: join(tree.project, 'y') }),
      assess('omp', 'any', { cwd: wt }),
    ],
  });
  assertEquals(steps.map((s) => s.verdict), ['no_evidence', 'no_evidence']);
});

probeTest('the provider must match and other sessions are excluded', async (tree) => {
  const processes = [
    proc(600, exe('omp'), `${exe('omp')} acp`, tree.project),
    proc(601, exe('claude'), `${exe('claude')} --output-format stream-json --resume=other`, tree.project),
  ];
  const steps = await both(tree, {
    processes,
    steps: [assess('claude', 'mine', { cwd: tree.project }), assess('omp', 'mine', { cwd: tree.project })],
  });
  assertEquals(steps.map((s) => s.verdict), ['no_evidence', 'possibly_active']);
});

probeTest('helpers and unrelated processes are ignored', async (tree) => {
  const processes = [
    proc(1, exe('claude'), `"${binpath('Claude')}" --type=renderer`, tree.project),
    proc(2, exe('node'), `${exe('node')} tool.mjs mcp`, tree.project),
    proc(3, exe('devin'), `${exe('devin')} acp --agent-type summarizer`, tree.project),
    proc(4, exe('node'), 'node eslint.js .', tree.project),
  ];
  const steps = await both(tree, {
    processes,
    steps: [assess('claude', 'x', { cwd: tree.project }), assess('omp', 'x', { cwd: tree.project })],
  });
  assertEquals(steps.map((s) => s.verdict), ['no_evidence', 'no_evidence']);
});

probeTest("Studio's own agents and their children are not evidence", async (tree) => {
  const processes = [
    proc(700, exe('omp'), `${exe('omp')} acp`, tree.project, 77),
    proc(701, exe('node'), `node ${BIN}claude-agent-acp${SEP}index.js`, tree.project, 700),
    proc(702, exe('claude'), `${exe('claude')} --output-format stream-json --resume=s-1`, tree.project, 701),
  ];
  assertEquals(
    (await both(tree, { processes, own_pids: [77], steps: [assess('claude', 's-1', { cwd: tree.project })] }))[0].verdict,
    'no_evidence',
  );
  const single = [proc(800, exe('omp'), `${exe('omp')} acp`, tree.project, 1)];
  assertEquals(
    (await both(tree, { processes: single, own_pids: [800], steps: [assess('omp', 'x', { cwd: tree.project })] }))[0].verdict,
    'no_evidence',
  );
  // This process (Deno.pid) counts as Studio too, with everything below it.
  const mine = [proc(900, exe('omp'), `${exe('omp')} acp --resume=s-1`, tree.project, Deno.pid)];
  const probe = new OwnershipProbe({ processes: new ProcessSource(() => mine), lockProbe: () => [] });
  assertEquals(probe.assess('omp', 's-1', { cwd: tree.project }).verdict, 'no_evidence');
});

probeTest('an adapter chain is reported once', async (tree) => {
  const processes = [
    proc(61, exe('node'), `node ${BIN}claude-agent-acp-devin.js`, tree.project),
    proc(47, exe('node'), `node ${BIN}claude-agent-acp${SEP}dist${SEP}index.js`, tree.project, 61),
    proc(41, exe('claude'), `${exe('claude')} --output-format stream-json`, tree.project, 47),
  ];
  const [verdict] = await both(tree, { processes, steps: [assess('claude', 'x', { cwd: tree.project })] });
  assertEquals((verdict.reasons as Record<string, number>[]).map((r) => r.pid), [61]);
});

probeTest('more than three agents in the folder are summarized', async (tree) => {
  const processes = [1, 2, 3, 4, 5].map((i) => proc(100 + i, exe('omp'), `${exe('omp')} acp`, tree.project, 1));
  const [verdict] = await both(tree, { processes, steps: [assess('omp', 'x', { cwd: tree.project })] });
  assertEquals((verdict.reasons as unknown[]).length, 4);
});

probeTest('an unavailable process list is disclosed, not hidden', async (tree) => {
  const [verdict] = await both(tree, { processes: { error: 'no access' }, steps: [assess('omp', 'x', { cwd: tree.project })] });
  assertEquals(verdict.verdict, 'no_evidence');
  assert((verdict.unavailable as string[]).some((u) => u.includes('running-process check')));
});

probeTest('unreadable agent processes are disclosed', async (tree) => {
  const [verdict] = await both(tree, {
    processes: [proc(900, exe('omp'), null, null)],
    steps: [assess('omp', 'x', { cwd: tree.project })],
  });
  assert((verdict.notes as string[]).some((n) => n.includes('could not be inspected')));
});

probeTest('an open file handle is weak and our own process is ignored', async (tree) => {
  const path = tree.transcript('claude', 's1', 9999);
  assertEquals(
    (await both(tree, { holders: [[4242, 'python']], own_pids: [4242], steps: [assess('claude', 's1')] }))[0].verdict,
    'no_evidence',
  );
  const [verdict] = await both(tree, { holders: [[4321, exe('claude')]], steps: [assess('claude', 's1')] });
  assertEquals([verdict.verdict, (verdict.reasons as Record<string, string>[])[0].signal], ['possibly_active', 'file-handle']);
  const [none] = await both(tree, { holders: null, steps: [assess('claude', 's1')] });
  assert((none.unavailable as string[]).includes('open-file check'));
  Deno.statSync(path);
});

probeTest('a shallow assessment skips the open-file check', (tree) => {
  tree.transcript('claude', 's1', 9999);
  const calls: string[] = [];
  new OwnershipProbe({ claudeRoot: tree.claude, processes: new ProcessSource(() => []), lockProbe: (p) => (calls.push(p), []) })
    .assess('claude', 's1', { deep: false });
  assertEquals(calls, []);
});

// --- certainty --------------------------------------------------------------------------------------------------------------------

probeTest('no evidence is "checked" only when every check could run', async (tree) => {
  tree.transcript('claude', 's1', 3600);
  assertEquals((await both(tree, { steps: [assess('claude', 's1')] }))[0].certainty, 'checked');
  assertEquals((await both(tree, { holders: null, steps: [assess('claude', 's1')] }))[0].certainty, 'unknown');
  assertEquals((await both(tree, { inspect: false, steps: [assess('claude', 's1')] }))[0].certainty, 'unknown');
  assertEquals((await both(tree, { processes: { error: 'no access' }, steps: [assess('claude', 's1')] }))[0].certainty, 'unknown');
});

probeTest('evidence is evidence whatever could not run', async (tree) => {
  tree.transcript('claude', 's1', 40);
  const [verdict] = await both(tree, { holders: null, steps: [assess('claude', 's1')] });
  assertEquals([verdict.verdict, verdict.certainty], ['possibly_active', 'evidence']);
});

probeTest('the list certainty follows the process list and the open-file check', async (tree) => {
  const steps = await both(tree, { steps: [{ certainty: true }, { get: true }, { certainty: true }] });
  assertEquals([steps[0], steps[2]], ['checked', 'checked']);
  assertEquals((await both(tree, { processes: { error: 'no access' }, steps: [{ get: true }, { certainty: true }] }))[1], 'unknown');
  assertEquals((await both(tree, { inspect: false, steps: [{ certainty: true }] }))[0], 'unknown');
  // The default open-file check: available on Windows only.
  assertEquals((await both(tree, { holders: 'real', steps: [{ certainty: true }] }))[0], WINDOWS ? 'checked' : 'unknown');
});

// --- cost and hints ---------------------------------------------------------------------------------------------------------------

probeTest('the process snapshot is cached and hints never start a scan', async (tree) => {
  tree.transcript('claude', 's1', 10);
  let fetches = 0;
  let now = NOW;
  const clock = () => now;
  const fetch = () => (fetches++, []);
  const probe = new OwnershipProbe({
    claudeRoot: tree.claude,
    processes: new ProcessSource(fetch, undefined, clock),
    lockProbe: () => [],
    clock,
  });
  probe.assess('claude', 's1');
  probe.assess('claude', 's1');
  probe.assess('claude', 's2');
  assertEquals(fetches, 1);
  probe.assess('claude', 's1', { fresh: true });
  assertEquals(fetches, 2);
  now += 60;
  const fresh = new OwnershipProbe({
    claudeRoot: tree.claude,
    processes: new ProcessSource(fetch, undefined, clock),
    lockProbe: () => [],
    clock,
  });
  for (let i = 0; i < 5; i++) {
    fresh.hints();
    now += 4;
  }
  assertEquals(fetches, 2);
  const steps = {
    steps: [assess('claude', 's1'), assess('claude', 's1'), assess('claude', 's2'), assess('claude', 's1', { fresh: true })],
  };
  tree.reset();
  assertEquals(
    (await py().call('ownership_shim', 'run_probe', [{ claude: tree.claude, now: NOW, ...steps }]) as { fetches: number }).fetches,
    2,
  );
});

probeTest('hints list only recent unowned transcripts and are cached', async (tree) => {
  tree.transcript('claude', 'recent', 30);
  tree.transcript('claude', 'old', 5000);
  tree.transcript('omp', 'omp-recent', 60);
  tree.transcript('claude', 'mine', 5);
  const added = tree.transcriptPath('claude', 'added');
  const steps = await both(tree, {
    studio_owned: [['claude', 'mine']],
    steps: [{ hints: true }, { touch: [added, 10, 1] }, { hints: true }, { advance: 4 }, { hints: true }],
  });
  const hints = steps[0] as Record<string, Record<string, unknown>>;
  assertEquals(Object.keys(hints).sort(), ['claude:recent', 'omp:omp-recent']);
  assertEquals(hints['claude:recent'].verdict, 'possibly_active');
  assertEquals(Object.keys(steps[2]).sort(), Object.keys(hints).sort()); // cached
  assert('claude:added' in steps[4]);
});

probeTest('hints include live announcements and command-line matches', async (tree) => {
  tree.foreign('sess-1');
  const processes = [proc(500, exe('claude'), `${exe('claude')} --output-format stream-json --resume=c-1`)];
  const steps = await both(tree, { processes, steps: [{ get: true }, { hints: true }] });
  const hints = steps[1] as Record<string, Record<string, unknown>>;
  assertEquals([hints['omp:sess-1'].verdict, hints['claude:c-1'].verdict], ['owned_elsewhere', 'owned_elsewhere']);
});

probeTest('an assessment is fast', (tree) => {
  tree.transcript('claude', 's1', 10);
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    new OwnershipProbe({ claudeRoot: tree.claude, processes: new ProcessSource(() => []), lockProbe: () => [] }).assess('claude', 's1', {
      cwd: tree.project,
    });
  }
  assert(performance.now() - started < 3000);
});

// --- macOS ps parsing (test_portability.py) ---------------------------------------------------------------------------------------

const NAMES = `    1     0 /sbin/launchd
  411     1 /Users/u/.local/bin/claude
  512   411 /usr/local/bin/node
  600     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
`;
const COMMANDS = `    1 /sbin/launchd
  411 /Users/u/.local/bin/claude --resume abc-123 --output-format stream-json
  512 node /opt/claude-agent-acp --resume def-456
  600 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
`;

function psRunner(names: string, commands: string, failFirst: string | null = null, failSecond: string | null = null, code = 0) {
  const seen: string[][] = [];
  const run = (argv: string[]) => {
    seen.push(argv);
    const first = argv[argv.length - 1] === 'pid=,ppid=,comm=';
    const fail = first ? failFirst : failSecond;
    if (fail) throw new Error(fail === 'missing' ? 'ps' : 'timed out');
    return { returncode: first ? code : 0, stdout: new TextEncoder().encode(first ? names : commands) };
  };
  return Object.assign(run, { seen });
}

pyTest('ps output becomes process entries, as in Python', async () => {
  const run = psRunner(NAMES, COMMANDS);
  const found = new Map(fetchProcessesPs(run).map((p) => [p.pid, p]));
  assertEquals(found.get(411)!.name, 'claude');
  assert(found.get(411)!.cmdline!.includes('--resume abc-123'));
  assertEquals([found.get(512)!.ppid, found.get(600)!.name, found.get(600)!.cmdline, found.get(411)!.cwd], [411, 'Electron', null, null]);
  assertEquals(run.seen[0].slice(0, 2), ['ps', '-axww']);
  assertEquals(classify(found.get(411)!)!.session, 'abc-123');
  assertEquals(classify(found.get(512)!)!.kind, 'claude-adapter');
  const cases: [string, string, string | null, string | null, number][] = [
    [NAMES, COMMANDS, null, null, 0],
    [NAMES, '', null, 'timeout', 0],
    ['', '', 'missing', null, 0],
    ['', '', 'timeout', null, 0],
    ['', '', null, null, 1],
    ['garbage\n', '', null, null, 0],
    ['', '', null, null, 0],
  ];
  for (const [names, commands, f1, f2, code] of cases) {
    const expected = await py().call('ownership_shim', 'fetch_ps', [names, commands, f1, f2, code]) as Record<string, unknown>;
    let actual: unknown;
    try {
      actual = { ok: fetchProcessesPs(psRunner(names, commands, f1, f2, code)) };
    } catch (error) {
      actual = { error: 'OSError', message: (error as Error).message };
    }
    if ('error' in expected && (expected.message as string).startsWith('ps is not available')) {
      assert((actual as { message: string }).message.startsWith('ps is not available'), JSON.stringify(actual)); // the cause's text differs
      continue;
    }
    assertEquals(actual, expected, JSON.stringify([names.slice(0, 10), f1, f2, code]));
  }
});

// --- interop with a Python peer ---------------------------------------------------------------------------------------------------

probeTest('an announcement written by Deno is read by Python and one written by Python is read by Deno', async (tree) => {
  const peer = await py().call('ownership_shim', 'identity') as { pid: number; hostname: string; start: number | null };
  assertEquals(peer.hostname.toLowerCase(), Deno.hostname().toLowerCase(), 'both sides must name this computer the same');
  const deno = new OwnerRegistry(tree.owners, { instanceId: 'denoside' });
  assert(deno.announce('claude', 'shared-1', 'C:/w', 'working'));
  const read = await py().call('ownership_shim', 'registry_read', [tree.owners, 'pyside', 'claude', 'shared-1']) as {
    entries: Record<string, unknown>[];
    problems: number;
  };
  assertEquals(read.problems, 0);
  assertEquals([read.entries.length, read.entries[0].status, read.entries[0].pid, read.entries[0].own], [1, 'live', Deno.pid, false]);
  assertEquals([read.entries[0].clientName, read.entries[0].instanceId, read.entries[0].state], ['agent-studio', 'denoside', 'working']);
  if (WINDOWS) assert(Math.abs((read.entries[0].pidStart as number) - processStartTime(Deno.pid)!) <= 1);

  assert(await py().call('ownership_shim', 'registry_announce', [tree.owners, 'pyside', 'omp', 'shared-2', 'C:/p', 'ready']));
  const [entries, problems] = deno.read('omp', 'shared-2');
  assertEquals(problems, 0);
  assertEquals([entries.length, entries[0].status, entries[0].pid, entries[0].clientName, entries[0].own], [
    1,
    'live',
    peer.pid,
    'python-peer',
    false,
  ]);
  if (WINDOWS) assert(Math.abs(entries[0].pidStart! - processStartTime(peer.pid)!) <= 1);
  // Both see both, each knowing which one is its own; the probes call the other one strong evidence.
  const all = await py().call('ownership_shim', 'registry_read', [tree.owners, 'pyside']) as { entries: Record<string, unknown>[] };
  assertEquals(all.entries.map((e) => [e.sessionId, e.own]).sort(), [['shared-1', false], ['shared-2', true]]);
  const probe = new OwnershipProbe({ registry: deno, processes: new ProcessSource(() => []), lockProbe: () => [] });
  assertEquals(probe.assess('omp', 'shared-2').verdict, 'owned_elsewhere');
  assertEquals(probe.assess('claude', 'shared-1').verdict, 'no_evidence');
  await py().call('ownership_shim', 'registry_withdraw', [tree.owners, 'pyside', 'omp', 'shared-2']);
  assertEquals(deno.read('omp', 'shared-2')[0], []);
  deno.withdrawAll();
  assertEquals([...Deno.readDirSync(tree.owners)], []);
});

Deno.test('processAlive: this process, a finished one, nonsense', async () => {
  assertEquals(processAlive(Deno.pid), true);
  assertEquals(processAlive(await deadPidAsync()), false);
  assertEquals([processAlive(0), processAlive(-3), processAlive('x'), processAlive(null)], [false, false, null, null]);
});

probeTest('a real agent-named process holding the transcript open is reported the same by both probes', async (tree) => {
  if (!WINDOWS) return; // the Restart Manager and the PEB reader are Windows-only; the ps and /proc parsers are covered above
  const session = 'interop-sess-1';
  const transcript = tree.transcript('omp', session, 9999);
  Deno.mkdirSync(tree.project, { recursive: true });
  // A copy of deno.exe named omp.exe, started through a launcher that exits, so the holder belongs to neither probe's process tree.
  const omp = join(tree.base, 'bin', 'omp.exe');
  Deno.mkdirSync(join(tree.base, 'bin'));
  Deno.copyFileSync(Deno.execPath(), omp);
  const holdCode = `const f = Deno.openSync(${JSON.stringify(transcript)}, { read: true }); setTimeout(() => f.close(), 60000);`;
  const launcher = [
    'import subprocess, sys',
    'p = subprocess.Popen([sys.argv[1], "eval", sys.argv[2], "acp", "--resume", sys.argv[3]], cwd=sys.argv[4],',
    '    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)',
    'print(p.pid, flush=True)',
  ].join('\n');
  const out = await new Deno.Command(python(), { args: ['-c', launcher, omp, holdCode, session, tree.project], stdout: 'piped' }).output();
  const pid = Number(new TextDecoder().decode(out.stdout).trim());
  assert(pid > 0, 'launcher gave no pid');
  try {
    let holders: [number, string][] | null = [];
    for (let i = 0; i < 100 && !holders?.some(([p]) => p === pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
      holders = lockHolders(transcript);
    }
    assert(holders?.some(([p]) => p === pid), 'the holder never opened the transcript');
    const fixture: Fixture = {
      processes: 'real',
      holders: 'real',
      now: null,
      owners: false,
      steps: [assess('omp', session, { cwd: tree.project, fresh: true })],
    };
    const expected = await py().call('ownership_shim', 'run_probe', [{ omp: tree.omp, claude: tree.claude, owners: null, ...fixture }]) as {
      steps: Record<string, unknown>[];
    };
    const actual = runDeno(tree, fixture).steps[0] as Record<string, unknown>;
    const py0 = expected.steps[0];
    const pick = (r: Record<string, unknown>) => ({
      verdict: r.verdict,
      reasons: r.reasons,
      unavailable: r.unavailable,
      notes: (r.notes as string[]).filter((n) => !n.includes('could not be inspected')), // other users' processes may come and go
    });
    assertEquals(JSON.parse(JSON.stringify(pick(actual))), pick(py0));
    const reasons = actual.reasons as Record<string, unknown>[];
    assertEquals(actual.verdict, 'owned_elsewhere');
    assertEquals(reasons.filter((r) => r.pid).map((r) => [r.signal, r.pid]), [['command-line', pid], ['process-folder', pid], [
      'file-handle',
      pid,
    ]]);
  } finally {
    try {
      Deno.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
});
