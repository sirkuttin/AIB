/**
 * Allow rules for Gemini CLI and Antigravity CLI (owner report 2026-11-23: their requests always asked). The shapes are RECORDED from
 * the real programs, headless, with a stub model and a dummy key (work/gemini_record_permissions.py: @google/gemini-cli 0.70.0;
 * work/antigravity_record_permissions.py: agy 1.5.11) and kept in work/deno/gemini_acp_permission_shapes.json and
 * antigravity_acp_permission_shapes.json. Here:
 *
 *  - a helper's edit inside its own copy is answered by the built-in "helper copy" rule; outside, in .gemini or .git, a deleting
 *    write asks; its test command is answered; push, install, delete, background runs and chains with those ask
 *  - the owner's "always allow edits like this" and "always allow npm test" rules work for them
 *  - a normal chat follows the normal rules (no helper rule)
 *  - anything AIB can't fully read asks (sandbox request, unknown tool, a card naming different files, unknown settings)
 *  - one request through a real Connection per agent: the auto-answer carries the agent's own allow-once id
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, Lab, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { AllowGate } from '../../outputs/agent-studio/server/allow/gate.ts';
import { type AllowRule, BUILTIN, type Builtins, match, type MatchContext, ruleFor } from '../../outputs/agent-studio/server/allow/matcher.ts';
import { join } from 'node:path';

type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const ALL: Builtins = { safeReads: true, syntax: true, scratch: true };
const TEST_CMD = 'deno task test --jobs 2 allow_gemini_antigravity_test';

const readJson = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(name, import.meta.url)));
const GEMINI = readJson('gemini_acp_permission_shapes.json') as { shapes: { label: string; asked: boolean; request: Json; tool_call_update: Json }[] };
const AGY = readJson('antigravity_acp_permission_shapes.json') as { shapes: { label: string; request: Json }[] };

/** A recorded request with the recorded project / outside folders swapped for this test's, whatever the platform's separator. */
function fill<T>(value: T, project: string, outside: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!v.includes('<PROJECT>') && !v.includes('<OUTSIDE>')) return v;
      return v.replaceAll('<PROJECT>', project).replaceAll('<OUTSIDE>', outside).replaceAll(/[\\/]/g, SEP);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

function lab() {
  const base = Deno.makeTempDirSync({ prefix: 'aib-allow-google-' });
  const project = join(base, 'copy');
  const outside = join(base, 'outside');
  for (const d of [join(project, 'src'), join(project, '.git', 'hooks'), outside]) Deno.mkdirSync(d, { recursive: true });
  Deno.writeTextFileSync(join(project, 'notes.md'), '# notes\n');
  Deno.writeTextFileSync(join(project, 'src', 'app.txt'), 'hello world\n');
  Deno.writeTextFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const ctx = (provider: string, helper: boolean, over: Partial<MatchContext> = {}): MatchContext => ({
    provider,
    toolName: null,
    mode: 'default',
    cwd: project,
    project,
    scratch: null,
    stateDir: join(base, 'state'),
    limitMs: 2000,
    ...(helper ? { helper: { testCmd: TEST_CMD } } : {}),
    ...over,
  });
  const gemini = (label: string): Json => {
    const s = GEMINI.shapes.find((x) => x.label === label);
    assert(s?.asked, `recorded: ${label}`);
    return fill(s.request, project, outside);
  };
  const agy = (label: string): Json => {
    const s = AGY.shapes.find((x) => x.label === label);
    assert(s, `recorded: ${label}`);
    return fill(s.request, project, outside);
  };
  return { base, project, outside, ctx, gemini, agy, [Symbol.dispose]: () => Deno.removeSync(base, { recursive: true }) };
}

const call = (req: Json) => req.toolCall as Json;
/** A copy of a recorded request with its tool call changed. */
const withCall = (req: Json, over: Json): Json => ({ ...req, toolCall: { ...call(req), ...over } });
const allowed = (req: Json, ctx: MatchContext, rules: AllowRule[] = []) => match(req, ctx, rules, ALL);

Deno.test('Gemini: the recorded shapes have what the matcher reads (guards the fixture)', () => {
  assertEquals(GEMINI.shapes.filter((s) => s.asked).length, 15);
  for (const s of GEMINI.shapes.filter((x) => x.asked)) {
    const c = s.request.toolCall as Json;
    assert(String(c.toolCallId).includes('__'), s.label);
    assertEquals(c.rawInput, undefined, 'Gemini sends no rawInput');
    assert((s.request.options as Json[]).some((o) => o.kind === 'allow_once'), s.label);
  }
});

Deno.test('Gemini helper: edits inside its own copy are answered; outside, .gemini and emptying writes ask', () => {
  using l = lab();
  const ctx = l.ctx('gemini', true);
  for (const label of ['write_new_file', 'write_existing_file', 'write_absolute_inside', 'replace_in_file']) {
    const r = allowed(l.gemini(label), ctx);
    assert(r.allow && r.ruleId === BUILTIN.helperCopy.id, `${label}: ${JSON.stringify(r)}`);
  }
  // the same card for a file outside the copy (swap its paths), and the recorded ones that must always ask
  const base = l.gemini('write_new_file');
  const elsewhere = join(l.outside, 'x.txt');
  const outsideCard = withCall(base, { locations: [{ path: elsewhere }], content: [{ ...(call(base).content as Json[])[0], path: elsewhere }] });
  assert(!allowed(outsideCard, ctx).allow, 'outside the copy');
  assert(!allowed(l.gemini('write_dot_gemini'), ctx).allow, '.gemini is protected');
  assert(!allowed(l.gemini('write_empty_content'), ctx).allow, 'a write that empties a file asks');
  // not fully readable: diff and location name different files; no diff at all; an edit tool AIB does not know
  const other = join(l.project, 'src', 'other.txt');
  assert(!allowed(withCall(base, { locations: [{ path: other }] }), ctx).allow, 'locations differ from the diff');
  assert(!allowed(withCall(base, { content: [] }), ctx).allow, 'no diff');
  assert(!allowed(withCall(base, { toolCallId: 'save_memory__save_memory_1_0' }), ctx).allow, 'unknown edit tool');
  assert(!allowed(withCall(base, { toolCallId: 'noprefix' }), ctx).allow, 'no tool name in the id');
});

Deno.test('Gemini helper: its test command is answered; push, install, delete, background and chains with them ask', () => {
  using l = lab();
  const ctx = l.ctx('gemini', true);
  for (const label of ['shell_test', 'shell_test_dir_path', 'shell_long_command']) {
    const r = allowed(l.gemini(label), ctx);
    assert(r.allow && r.ruleId === BUILTIN.helperCopy.id, `${label}: ${JSON.stringify(r)}`);
  }
  for (const label of ['shell_git_push', 'shell_npm_install', 'shell_background', 'shell_remove']) {
    assert(!allowed(l.gemini(label), ctx).allow, label);
  }
  const test = l.gemini('shell_test');
  const asks = (title: string, text?: string) =>
    allowed(withCall(test, { title, ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {}) }), ctx);
  assert(!asks('npm test; git push origin main').allow, 'a push after the tests');
  assert(!asks('npm test && npm install left-pad').allow, 'an install after the tests');
  assert(!asks('node --test ..' + SEP + 'other' + SEP + 'x.js').allow, 'a test path outside the copy');
  // where it runs: outside the copy, or with ..
  assert(!asks('npm test', `[in ${l.outside}]`).allow, 'runs outside the copy');
  assert(!asks('npm test', '[in ..]').allow, 'runs in ..');
  assert(!asks('npm test', '[in src] [background]').allow, 'a background run');
  assert(!asks('npm test', 'no folder shown').allow, 'cannot read where it runs');
  assert(asks('npm test', '[in src] (Run the tests)').allow, 'a folder inside the copy, with a description');
  // a sandbox expansion card has no allow-always option: never answered
  const noAlways = { ...test, options: (test.options as Json[]).filter((o) => o.kind !== 'allow_always') };
  assert(!allowed(noAlways, ctx).allow, 'sandbox card');
  // Gemini's web_fetch card and its synthetic outside-read card are not read
  assert(!allowed(l.gemini('web_fetch'), ctx).allow, 'fetch');
});

Deno.test('Gemini normal chat: no helper rule; the owner\'s "always allow edits like this" and "always allow npm test" work', () => {
  using l = lab();
  const ctx = l.ctx('gemini', false);
  assert(!allowed(l.gemini('write_new_file'), ctx).allow, 'a normal chat asks for edits');
  assert(!allowed(l.gemini('shell_test'), ctx).allow, 'and for npm test');
  assert(!allowed(l.gemini('shell_git_push'), ctx).allow);
  // Safe reads and the other built-ins apply as for any agent
  const status = withCall(l.gemini('shell_test'), { title: 'git status --short' });
  assert(allowed(status, ctx).allow, 'a safe read');

  // always allow edits like this: src/ for this project
  const edit = l.gemini('write_new_file'); // src/new_file.txt
  const draft = ruleFor(edit, ctx, 'project', ALL);
  assert(draft.available && draft.hideAgentAlways, JSON.stringify(draft));
  assertEquals(draft.rules[0].folder, 'src');
  const rule = { ...draft.rules[0], id: 'e1', added: 0, from: 'card' } as AllowRule;
  const inSrc = join(l.project, 'src', 'second.txt');
  const next = withCall(edit, { locations: [{ path: inSrc }], content: [{ ...(call(edit).content as Json[])[0], path: inSrc }] });
  const r = allowed(next, ctx, [rule]);
  assert(r.allow && r.ruleId === 'e1', JSON.stringify(r));
  const top = join(l.project, 'top.txt');
  const notInSrc = withCall(edit, { locations: [{ path: top }], content: [{ ...(call(edit).content as Json[])[0], path: top }] });
  assert(!allowed(notInSrc, ctx, [rule]).allow, 'outside the rule\'s folder');
  assert(!allowed(l.gemini('write_dot_gemini'), ctx, [{ ...rule, folder: '' }]).allow, 'never .gemini');

  // always allow npm test (a project script: pinned)
  const cmd = ruleFor(l.gemini('shell_test'), ctx, 'project', ALL);
  assert(cmd.available, JSON.stringify(cmd));
  assertEquals(cmd.rules[0].words, ['npm', 'test']);
  const cmdRule = { ...cmd.rules[0], id: 'c1', added: 0, from: 'card' } as AllowRule;
  assert(allowed(l.gemini('shell_test'), ctx, [cmdRule]).allow);
  assert(!allowed(l.gemini('shell_npm_install'), ctx, [cmdRule]).allow, 'npm install is another command');
  assert(!allowed(l.gemini('shell_background'), ctx, [cmdRule]).allow, 'a background run never matches');
});

Deno.test('Gemini: the command is read with the shell Gemini runs it in; a folder outside the chat folder asks', () => {
  using l = lab();
  const ctx = l.ctx('gemini', true);
  const r = allowed(l.gemini('shell_test'), ctx);
  assert(r.allow, JSON.stringify(r));
  const gone = allowed(withCall(l.gemini('shell_test'), { content: [{ type: 'content', content: { type: 'text', text: '[in ' + join(l.base, 'elsewhere') + ']' } }] }), ctx);
  assert(!gone.allow, 'a folder outside the chat folder');
});

Deno.test('Antigravity helper: edits inside its copy and its test command are answered; outside, .git, .gemini, push, install ask', () => {
  using l = lab();
  const ctx = l.ctx('antigravity', true);
  for (const label of ['write_new_file', 'write_overwrite_existing', 'write_append', 'edit_in_file', 'edit_delete_text', 'run_test']) {
    const r = allowed(l.agy(label), ctx);
    assert(r.allow && r.ruleId === BUILTIN.helperCopy.id, `${label}: ${JSON.stringify(r)}`);
  }
  for (
    const label of [
      'write_dot_git_hook',
      'write_dot_gemini',
      'write_outside_project',
      'write_dotdot_escape',
      'run_git_push',
      'run_npm_install',
      'run_daemon',
      'run_remove',
      'read_outside',
    ]
  ) assert(!allowed(l.agy(label), ctx).allow, label);
  const test = l.agy('run_test');
  const raw = call(test).rawInput as Json;
  const unknownKey = withCall(test, { rawInput: { ...raw, Cwd: l.outside } });
  assert(!allowed(unknownKey, ctx).allow, 'a command setting AIB does not know');
  assert(!allowed(withCall(test, { title: 'something else' }), ctx).allow, 'title differs from the command');
  assert(!allowed(withCall(test, { name: 'run_workflow' }), ctx).allow, 'another tool');
  const edit = l.agy('write_new_file');
  assert(!allowed(withCall(edit, { locations: [{ path: join(l.outside, 'x.txt') }] }), ctx).allow, 'locations differ from Path');
});

Deno.test('Antigravity normal chat: reads in the project are Safe reads; edits and commands follow the normal rules', () => {
  using l = lab();
  const ctx = l.ctx('antigravity', false);
  const readIn = withCall(l.agy('read_outside'), {
    locations: [{ path: join(l.project, 'notes.md') }],
    rawInput: { Path: join(l.project, 'notes.md') },
  });
  const r = allowed(readIn, ctx);
  assert(r.allow && r.ruleId === BUILTIN.safeReads.id, JSON.stringify(r));
  const secret = withCall(readIn, { locations: [{ path: join(l.project, '.env') }], rawInput: { Path: join(l.project, '.env') } });
  assert(!allowed(secret, ctx).allow, 'a secrets file');
  assert(!allowed(l.agy('read_outside'), ctx).allow, 'outside the project');
  assert(!allowed(l.agy('write_new_file'), ctx).allow, 'a normal chat asks for edits');
  assert(!allowed(l.agy('run_test'), ctx).allow);
  // the owner's rule for edits, and Antigravity's own card has no allow-always, so AIB's Always is the only one
  const draft = ruleFor(l.agy('write_new_file'), ctx, 'project', ALL);
  assert(draft.available && draft.hideAgentAlways, JSON.stringify(draft));
  const rule = { ...draft.rules[0], id: 'a1', added: 0, from: 'card' } as AllowRule;
  assertEquals(draft.rules[0].folder, 'src');
  const inSrc = l.agy('edit_in_file');
  assert(allowed(inSrc, ctx, [rule]).allow, 'edit inside the rule folder');
  assert(!allowed(l.agy('write_dot_gemini'), ctx, [{ ...rule, folder: '' }]).allow, 'never .gemini');
});

// ---- through a real Connection and a fake agent that replays the recorded requests ---------------------------------------------

class GoogleLab extends Lab {
  readonly state = this.dir + SEP + 'state';
  readonly copy = this.dir + SEP + 'helper-copy';
  readonly outside = this.dir + SEP + 'outside';
  readonly gate: AllowGate;
  constructor() {
    super();
    Deno.mkdirSync(this.copy + SEP + 'src', { recursive: true });
    Deno.mkdirSync(this.outside, { recursive: true });
    Deno.mkdirSync(this.state, { recursive: true });
    this.gate = new AllowGate(this.state);
  }

  async chat(provider: 'gemini' | 'antigravity', helper: boolean): Promise<Connection> {
    const c = this.connection(fake('--cancel-aware'), {}, this.copy, provider);
    await c.setup(null);
    c.allowGate = this.gate;
    c.worktree = { branch: 'studio/helper-x', base: 'main' };
    c.projectRoot = this.dir + SEP + 'project';
    if (helper) {
      c.swarm = { role: 'helper', helperId: 'h_1', parent: 'parent' };
      c.helperTestCmd = () => TEST_CMD;
    } else c.swarm = { role: 'main' };
    return c;
  }

  recorded(kind: 'gemini' | 'antigravity', label: string): string {
    const shapes = (kind === 'gemini' ? GEMINI.shapes : AGY.shapes) as { label: string; request: Json; tool_call_update?: Json }[];
    const s = shapes.find((x) => x.label === label)!;
    const req = fill(s.request, this.copy, this.outside);
    const update = s.tool_call_update ? fill(s.tool_call_update, this.copy, this.outside) : undefined;
    return 'allowraw:' + JSON.stringify({ toolCall: req.toolCall, options: req.options, ...(update ? { update } : {}) });
  }
}

const kinds = (c: Connection, kind: string) => c.events.filter((e) => e.kind === kind);

async function ask(c: Connection, text: string): Promise<'auto' | 'card'> {
  const autos = kinds(c, 'permission_auto').length;
  await c.prompt(text);
  await until(() => kinds(c, 'permission_auto').length > autos || c.permissions.size > 0, 'an answer or a card', 10);
  if (c.permissions.size > 0) {
    const [key, request] = [...c.permissions][0];
    const refuse = ((request.params as Json).options as Json[]).find((o) => o.kind === 'reject_once')!;
    c.permission(key, String(refuse.optionId));
    await until(() => !c.busy, 'the turn to end', 10);
    return 'card';
  }
  await until(() => !c.busy, 'the turn to end', 10);
  return 'auto';
}

Deno.test('Gemini helper through a Connection: the recorded edit and test run are answered with Gemini\'s own allow-once id; a push asks', async () => {
  await using lab = new GoogleLab();
  const c = await lab.chat('gemini', true);
  assertEquals(await ask(c, lab.recorded('gemini', 'write_new_file')), 'auto');
  assert(c.events.some((e) => e.kind === 'update' && JSON.stringify(e.data).includes('allow outcome=proceed_once;')));
  assertEquals(await ask(c, lab.recorded('gemini', 'shell_test')), 'auto');
  assertEquals((kinds(c, 'permission_auto').at(-1)!.data as Json).ruleId, BUILTIN.helperCopy.id);
  assertEquals(await ask(c, lab.recorded('gemini', 'shell_git_push')), 'card');
  assertEquals(await ask(c, lab.recorded('gemini', 'write_dot_gemini')), 'card');
  assertEquals(kinds(c, 'permission_auto').length, 2);
});

Deno.test('Gemini normal chat through a Connection: the same requests ask', async () => {
  await using lab = new GoogleLab();
  const c = await lab.chat('gemini', false);
  assertEquals(await ask(c, lab.recorded('gemini', 'write_new_file')), 'card');
  assertEquals(await ask(c, lab.recorded('gemini', 'shell_test')), 'card');
  assertEquals(kinds(c, 'permission_auto').length, 0);
});

Deno.test('Antigravity helper through a Connection: the recorded edit and test run are answered with its allow id; outside and push ask', async () => {
  await using lab = new GoogleLab();
  const c = await lab.chat('antigravity', true);
  assertEquals(await ask(c, lab.recorded('antigravity', 'write_new_file')), 'auto');
  assert(c.events.some((e) => e.kind === 'update' && JSON.stringify(e.data).includes('allow outcome=allow;')));
  assertEquals(await ask(c, lab.recorded('antigravity', 'run_test')), 'auto');
  assertEquals(await ask(c, lab.recorded('antigravity', 'run_git_push')), 'card');
  assertEquals(await ask(c, lab.recorded('antigravity', 'write_outside_project')), 'card');
  assertEquals(kinds(c, 'permission_auto').length, 2);
});
