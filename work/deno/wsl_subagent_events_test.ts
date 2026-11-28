/**
 * AIB never loses track of a WSL chat's subagents (owner 2026-11-28, chat 1eb022f0: a game build used ~11 cores in the distro; the
 * helper answered `subagent.event` after 120 s, AIB dropped the events, and three subagents' worktrees showed nowhere).
 *   - an event the distro did not take (timeout, helper gone) waits in the chat's queue, in order, and is tried again until the
 *     distro has it; the queue is bounded, and what carries the whole picture (turnEnded, reconcileEnded) keeps only its newest;
 *   - the chat reads "syncing" while events wait or the distro's records cannot be read (Activity says so, never "not isolated");
 *   - AIB reads the distro's records again by itself, and a distro that was out of reach and is back gets the streams' state again;
 *   - the helper answers an event within seconds ("queued") whatever the chat's own work holds, runs one chat's events in order, and
 *     one stuck chat or call never holds another call;
 *   - a worktree with no record is taken up as a stopped record (never left alone, never deleted), unless something works in it.
 * A FakeWslHost with injected slow or failing answers; the helper's real methods over temp repos. Never a real distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { runGit, Sandbox, write } from './_worktree_fixtures.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import { wslRemote } from '../../app/server/wsl/subagents.ts';
import { subagentMethods } from '../../app/server/wsl/helper/subagents.ts';
import { type SubagentChat, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { STRAY_WHY } from '../../app/server/subagents/strays.ts';
import * as wt from '../../app/server/worktrees/worktrees.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const GIT = { ...T, ignore: !HAVE_GIT };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const CHAT = '1eb022f0843342669f333e07d0961df4';
const REF = 'wsl://ubuntu/home/u/app';

Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-fake');

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, ok: () => boolean, ms = 4000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (ok()) return;
    await pause(10);
  }
  throw new Error(`gave up waiting for: ${what}`);
}

const chat = (): SubagentChat => ({
  id: CHAT,
  provider: 'claude',
  lasting: 'claude:s1',
  folder: REF,
  project: REF,
  hooks: { readOnly: new Set(), userWorktreeHook: false },
  wsl: { distro: 'ubuntu' },
});

/** A service for the chat over a fake host; the host's `subagent.event` and `subagent.records` answers are the test's. */
class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-events-' }));
  readonly host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu');
  readonly service: SubagentWorktrees;
  /** What the distro took, in the order it took it: [op, args]. */
  readonly taken: [string, Json][] = [];
  /** Every try, taken or not. */
  tries = 0;
  /** Set: the try throws this (null: the distro takes it). */
  failure: (() => Error | null) | null = null;
  records: Json[] = [];
  recordsFail = false;
  recordCalls = 0;
  recordDelayMs = 0;

  constructor() {
    Deno.mkdirSync(this.dir + SEP + 'state', { recursive: true });
    this.service = new SubagentWorktrees(this.dir + SEP + 'state', this.dir + SEP + 'worktrees', (id) => (id === CHAT ? chat() : null));
    this.service.remote = wslRemote;
    this.service.wslEventWaitMs = 30;
    this.service.wslRetryMs = [15];
    this.host.handlers['subagent.event'] = (p) => {
      this.tries++;
      const error = this.failure?.();
      if (error) throw error;
      this.taken.push([String(p.op), (p.args ?? {}) as Json]);
      return { ok: true };
    };
    this.host.handlers['subagent.records'] = async () => {
      this.recordCalls++;
      if (this.recordDelayMs) await pause(this.recordDelayMs);
      if (this.recordsFail) throw new WslHelperError('subagent.records in ubuntu took longer than 60 s', 'timeout');
      return { records: this.records };
    };
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  ops(): string[] {
    return this.taken.map(([op]) => op);
  }

  [Symbol.dispose](): void {
    setWslHostResolver(null);
    try {
      Deno.removeSync(this.dir, { recursive: true });
    } catch { /* in use: temp */ }
  }
}

const timeout = () => new WslHelperError('subagent.event in ubuntu took longer than 120 s', 'timeout');

Deno.test({ name: 'wsl subagent events: a timed-out event waits in order and is delivered later; the chat reads syncing meanwhile', ...T, async fn() {
  using lab = new Lab();
  let down = true;
  lab.failure = () => (down ? timeout() : null);
  const s = lab.service;
  await s.claudeTool(CHAT, 'Agent', 'toolu_1', { description: 'Build', subagent_type: 'general-purpose' }, 'in_progress', '');
  await s.claudeTool(CHAT, 'Agent', 'toolu_2', { description: 'Test' }, 'in_progress', '');
  await s.acpEnded(CHAT, 'agent-1', 'end_turn');
  await s.reconcileEnded(CHAT, new Map([['agent-2', 'end_turn']]));
  assertEquals(lab.taken.length, 0, 'the distro took nothing');
  assertEquals(s.wslPending(CHAT), 4, 'nothing was dropped');
  assert(s.syncing(CHAT), 'syncing while events wait');
  assert(lab.tries >= 2, 'it keeps trying');
  down = false;
  await until('delivered', () => lab.taken.length === 4);
  // in the order they came, the first one first although it failed first
  assertEquals(lab.ops(), ['claudeTool', 'claudeTool', 'acpEnded', 'reconcileEnded']);
  assertEquals((lab.taken[0][1] as Json).toolUseId, 'toolu_1');
  assertEquals((lab.taken[1][1] as Json).toolUseId, 'toolu_2');
  assertEquals((lab.taken[3][1] as Json).ended, [['agent-2', 'end_turn']]);
  await until('queue gone', () => s.wslPending(CHAT) === 0);
  assert(!s.syncing(CHAT), 'in sync again');
} });

Deno.test({ name: 'wsl subagent events: a helper that went away (helper_gone) and a distro that is not running are tried again too', ...T, async fn() {
  using lab = new Lab();
  const errors = [new WslHelperError('The AIB helper in ubuntu is not running', 'helper_gone'), new Error('the distro ubuntu is not running')];
  lab.failure = () => errors.shift() ?? null;
  await lab.service.acpEnded(CHAT, 'agent-1', 'end_turn');
  await until('delivered', () => lab.taken.length === 1);
  assertEquals(lab.ops(), ['acpEnded']);
  assertEquals(lab.tries, 3);
} });

Deno.test({ name: 'wsl subagent events: a call the helper refuses as malformed is dropped (again would say the same), the next goes on', ...T, async fn() {
  using lab = new Lab();
  let first = true;
  lab.failure = () => {
    if (!first) return null;
    first = false;
    return new WslHelperError('params must be an object', '-32602');
  };
  await lab.service.acpEnded(CHAT, 'agent-1', 'end_turn');
  await lab.service.acpEnded(CHAT, 'agent-2', 'cancelled');
  await until('delivered', () => lab.taken.length === 1);
  assertEquals(lab.taken[0][1].agentId, 'agent-2');
  assertEquals(lab.service.wslPending(CHAT), 0);
} });

Deno.test({ name: 'wsl subagent events: the queue is bounded, and a turn end waiting is replaced by the newest one', ...T, async fn() {
  using lab = new Lab();
  lab.failure = () => timeout();
  const s = lab.service;
  s.wslEventWaitMs = 1;
  for (let i = 0; i < 450; i++) await s.claudeTool(CHAT, 'Agent', `toolu_${i}`, {}, 'in_progress', '');
  assert(s.wslPending(CHAT) <= 300, `bounded: ${s.wslPending(CHAT)}`);
  const before = s.wslPending(CHAT);
  await s.turnEnded(CHAT);
  await s.turnEnded(CHAT);
  await s.turnEnded(CHAT);
  await s.reconcileEnded(CHAT, new Map([['a', 'end_turn']]));
  await s.reconcileEnded(CHAT, new Map([['a', 'end_turn'], ['b', 'end_turn']]));
  assert(s.wslPending(CHAT) <= before + 2, `one turnEnded and one reconcileEnded wait, not five: ${before} -> ${s.wslPending(CHAT)}`);
  lab.failure = null;
  await until('drained', () => s.wslPending(CHAT) === 0, 8000);
  const reconciles = lab.taken.filter(([op]) => op === 'reconcileEnded');
  assertEquals(reconciles.length, 1, 'only the newest picture was told');
  assertEquals((reconciles[0][1].ended as unknown[]).length, 2);
} });

Deno.test({ name: 'wsl subagent events: the caller of an event is never held for long by a distro that does not answer', ...T, async fn() {
  using lab = new Lab();
  lab.failure = () => timeout();
  lab.service.wslEventWaitMs = 120;
  const started = Date.now();
  await lab.service.turnEnded(CHAT);
  await lab.service.acpEnded(CHAT, 'agent-1', 'end_turn');
  assert(Date.now() - started < 1500, `two events took ${Date.now() - started} ms`);
  lab.failure = null; // (so nothing keeps trying after the test)
  await until('drained', () => lab.service.wslPending(CHAT) === 0);
} });

Deno.test({ name: "wsl subagent events: the distro's records are read again by themselves, one read at a time; a distro back from out of reach gets the streams' state again", ...T, async fn() {
  using lab = new Lab();
  const s = lab.service;
  const recovered: string[] = [];
  s.onWslRecovered = (d) => recovered.push(d);
  // many callers at once share a read, they do not each send one to a slow distro
  lab.recordDelayMs = 40;
  await Promise.all(Array.from({ length: 8 }, () => s.refreshWsl('ubuntu')));
  assert(lab.recordCalls <= 2, `8 callers, ${lab.recordCalls} reads`);
  lab.recordDelayMs = 0;
  // a distro AIB has heard from, now unreadable: syncing; back: recovered once
  await s.acpEnded(CHAT, 'agent-1', 'end_turn');
  await until('quiet', () => s.wslPending(CHAT) === 0);
  lab.recordsFail = true;
  await s.reconcileWsl();
  assert(s.syncing(CHAT), 'records unreadable: syncing');
  assertEquals(recovered, []);
  // the records the events never told about show up at the next look
  lab.recordsFail = false;
  lab.records = [{
    id: 'sa_orphan11', kind: 'subagent', chat: CHAT, lasting: 'claude:s1', project: '/home/u/app', folder: '/home/u/app', slug: 'sub-1eb022f0-11',
    branch: 'studio/sub-1eb022f0-11', path: '/home/u/.aib-server/data-x/worktrees/h/sub-1eb022f0-11', snapshot: 'abc', tree: 'def', state: 'running',
    toolUseId: 'toolu_1', agentId: 'agent-11', agentType: 'general-purpose', description: 'Build', createdAt: 1,
  }];
  await s.reconcileWsl();
  assertEquals(recovered, ['ubuntu']);
  assert(!s.syncing(CHAT));
  const mirrored = s.all().filter((r) => r.chat === CHAT);
  assertEquals(mirrored.map((r) => [r.id, r.state, r.wsl?.distro]), [['sa_orphan11', 'running', 'ubuntu']]);
  await s.reconcileWsl();
  assertEquals(recovered, ['ubuntu'], 'told once, not at every look');
  // the periodic look does the same without anyone calling it
  lab.records = [];
  const stop = s.watchWsl(20);
  await until('mirror follows the distro', () => s.all().length === 0);
  stop();
} });

Deno.test({ name: 'wsl subagent events (helper): the answer comes in seconds, a stuck call holds only its own chat, and one chat\'s events keep their order', ...T, async fn() {
  using box = new Sandbox(false);
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = subagentMethods(box.state, {
    eventAckMs: 40,
    strayWaitMs: 20,
    beforeEvent: async (op) => {
      ran.push('start:' + op);
      if (op === 'claudeTool') await gate; // the call that holds the chat's queue (a worktree being made under load)
    },
  });
  const facts = (id: string): Json => ({ id, provider: 'claude', lasting: 'claude:s1', folder: box.project, project: box.project });
  const OTHER = 'ffffffff0000111122223333444455556';
  const started = Date.now();
  const first = await h['subagent.event']({ chat: facts(CHAT), op: 'claudeTool', args: { tool: 'Agent', toolUseId: 'toolu_1', input: {}, status: 'in_progress' } }) as Json;
  assertEquals([first.ok, first.queued], [true, true]);
  assert(Date.now() - started < 1500, 'answered within the ack time, not when the work was done');
  const second = await h['subagent.event']({ chat: facts(CHAT), op: 'acpEnded', args: { agentId: 'agent-1', how: 'end_turn' } }) as Json;
  assertEquals(second.queued, true);
  assertEquals(ran, ['start:claudeTool'], 'the second waits behind the first: same chat, same order');
  // meanwhile everything else is answered at once: another chat's event, the records, a read of another chat
  const other = await h['subagent.event']({ chat: facts(OTHER), op: 'turnEnded', args: {} }) as Json;
  assertEquals([other.ok, other.queued], [true, false], 'another chat is not held by the stuck one');
  const records = await h['subagent.records']({}) as { records: Json[] };
  assertEquals(records.records, []);
  assertEquals(((await h['subagent.records']({ chat: CHAT })) as { records: Json[] }).records, []);
  assertEquals(await h['subagent.ownWaiting']({ chat: facts(OTHER) }), { waiting: 0 });
  release();
  await until('both ran, in order', () => ran.length === 3);
  assertEquals(ran.filter((x) => x.endsWith('claudeTool') || x.endsWith('acpEnded')), ['start:claudeTool', 'start:acpEnded']);
} });

Deno.test({ name: 'wsl subagent events (helper): an unknown op is refused, and one chat cannot queue without end', ...T, async fn() {
  using box = new Sandbox(false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = subagentMethods(box.state, { eventAckMs: 1, beforeEvent: () => gate });
  const facts: Json = { id: CHAT, provider: 'claude', lasting: 'claude:s1', folder: box.project, project: box.project };
  let refused = false;
  try {
    await h['subagent.event']({ chat: facts, op: 'rm -rf', args: {} });
  } catch {
    refused = true;
  }
  assert(refused);
  let full = false;
  for (let i = 0; i < 520 && !full; i++) {
    try {
      await h['subagent.event']({ chat: facts, op: 'turnEnded', args: {} });
    } catch {
      full = true;
    }
  }
  assert(full, 'the helper says so when 500 events wait for one chat');
  release();
} });

/** A worktree made by hand the way AIB makes one (`git worktree add -b studio/sub-<chat>-<n>` under <data>/worktrees/<repo hash>/). */
function strayAt(box: Sandbox, slug: string, branch = `studio/${slug}`): string {
  const folder = new wt.Registry(box.state).root + SEP + wt.repoHash(box.project);
  Deno.mkdirSync(folder, { recursive: true });
  const path = folder + SEP + slug;
  runGit(box.project, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
  return path;
}

Deno.test({ name: 'wsl subagent orphans: worktrees with no record are taken up as stopped records with their real facts, never deleted', ...GIT, async fn() {
  using box = new Sandbox();
  runGit(box.project, 'config', 'core.autocrlf', 'false');
  const head = runGit(box.project, 'rev-parse', 'HEAD').trim();
  // sub-1eb022f0-11..16, as the owner's distro had them, and what each of them left in its worktree
  const paths = [11, 12, 13].map((n) => strayAt(box, `sub-1eb022f0-${n}`));
  write(paths[0], 'built.txt', 'the work of -11\n');
  const busyPath = strayAt(box, 'sub-1eb022f0-14');
  const foreign = strayAt(box, 'sub-1eb022f0-15', 'feature/not-aibs');
  const busy = (p: string) => p === busyPath;
  const h = subagentMethods(box.state, { busy, strayEveryS: 0, strayWaitMs: 5000 });
  // the chat is known to the helper (it has told it about itself): its records carry its real id
  await h['subagent.event']({ chat: { id: CHAT, provider: 'claude', lasting: 'claude:s1', folder: box.project, project: box.project }, op: 'turnEnded', args: {} });
  const out = (await h['subagent.records']({})) as { records: Json[] };
  const slugs = out.records.map((r) => String(r.slug)).sort();
  assertEquals(slugs, ['sub-1eb022f0-11', 'sub-1eb022f0-12', 'sub-1eb022f0-13'], 'the busy one waits, a foreign branch is never claimed');
  for (const r of out.records) {
    assertEquals(r.state, 'stopped');
    assertEquals(r.stoppedWhy, STRAY_WHY);
    assertEquals(r.branch, `studio/${r.slug}`);
    assertEquals(r.snapshot, head, 'S is what the worktree was made from');
    assertEquals(r.chat, CHAT, 'tied to its chat by the name prefix');
    assertEquals(r.lasting, 'claude:s1');
  }
  // its work is still there for the main agent (unlanded work: status / diff / keep), the worktrees are untouched
  const rec = out.records.find((r) => r.slug === 'sub-1eb022f0-11')!;
  const work = (await h['subagent.work']({ id: rec.id, op: 'status' })) as { files: string[] };
  assert(work.files.includes('built.txt'), JSON.stringify(work));
  for (const p of [...paths, busyPath, foreign]) assert(wt.lexists(p), `${p} still exists`);
  // looked at again: no second record for the same worktree; the one that was busy is taken up once nothing works in it
  const again = ((await h['subagent.records']({})) as { records: Json[] }).records;
  assertEquals(again.length, 3);
  const h2 = subagentMethods(box.state, { busy: () => false, strayEveryS: 0, strayWaitMs: 5000 });
  const later = ((await h2['subagent.records']({})) as { records: Json[] }).records.map((r) => String(r.slug)).sort();
  assertEquals(later, ['sub-1eb022f0-11', 'sub-1eb022f0-12', 'sub-1eb022f0-13', 'sub-1eb022f0-14']);
  assert(!later.includes('sub-1eb022f0-15'));
} });

Deno.test({ name: 'wsl subagent orphans: AIB mirrors the adopted record, so the swarm hands its work to the main agent', ...GIT, async fn() {
  using box = new Sandbox();
  const path = strayAt(box, 'sub-1eb022f0-11');
  const h = subagentMethods(box.state, { busy: () => false, strayEveryS: 0, strayWaitMs: 5000 });
  const lab = new Lab();
  try {
    const linux = (v: unknown) => (typeof v === 'string' && v.startsWith(box.base) ? '/home/u/lab' + v.slice(box.base.length).replaceAll(SEP, '/') : v);
    lab.host.handlers['subagent.records'] = async (p) => ({
      records: (((await h['subagent.records'](p)) as Json).records as Json[]).map((r) => ({ ...r, path: linux(r.path), folder: linux(r.folder), project: linux(r.project) })),
    });
    lab.recordsFail = false;
    await lab.service.reconcileWsl(); // no event ever reached the distro; the look at its records is enough
    lab.service.wslEventWaitMs = 5;
    await lab.service.acpEnded(CHAT, 'x', 'end_turn'); // makes the distro one AIB looks at
    await lab.service.reconcileWsl();
    const mirrored = lab.service.all();
    assertEquals(mirrored.map((r) => [r.slug, r.state, r.wsl?.distro]), [['sub-1eb022f0-11', 'stopped', 'ubuntu']]);
    assertEquals(mirrored[0].stoppedWhy, STRAY_WHY);
    assert(wt.lexists(path));
  } finally {
    lab[Symbol.dispose]();
  }
} });
