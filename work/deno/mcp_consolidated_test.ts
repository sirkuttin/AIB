/**
 * AIB's six agent tools (tool consolidation slice 1): the frozen tools/list per context, the old 30 names as hidden aliases, the
 * per-action checks (a field of another action is refused), the doc help action, the served hash with action lists, and a stub model
 * per agent shape that creates and edits a doc through `doc`.
 */
import { assert, assertEquals } from './_assert.ts';
import { handle, servedToolList, toolSignatures, WSL_TOOL_GROUPS, type ToolContext } from '../../app/server/artifacts/mcp.ts';
import { consolidatedTools, toolSignature } from '../../app/server/artifacts/mcp_tools.ts';
import { toolsHash } from '../../app/server/artifacts/served.ts';
import { DocStore } from '../../app/server/docs/store.ts';
import { runDocTool } from '../../app/server/docs/tools.ts';

type Json = Record<string, unknown>;
type Ctx = { restricted?: boolean; worktree?: boolean; main?: boolean };
const sep = Deno.build.os === 'windows' ? '\\' : '/';

const DOC_ACTIONS = ['list', 'create', 'read', 'changes', 'edit', 'page', 'claim', 'undo', 'comments', 'comment', 'reply', 'resolve', 'history', 'restore', 'help'];
const DRAWING_ACTIONS = ['create', 'read', 'edit', 'from_mermaid'];
const HELPER_ALL = ['providers', 'start', 'status', 'stop', 'merge', 'work_list', 'work_land', 'work_diff', 'work_discard'];
const HELPER_WORK = ['work_list', 'work_land', 'work_diff', 'work_discard'];
const MERGE_ACTIONS = ['merge', 'check', 'keep_mine', 'leave'];

/** The frozen answer: tool names with their action lists, per context (the schemas are held by the shape guard and the size budget). */
const FROZEN: [string, Ctx, [string, string[] | null][]][] = [
  ['plain', {}, [['publish', null], ['artifacts', ['list', 'archive']], ['doc', DOC_ACTIONS], ['drawing', DRAWING_ACTIONS]]],
  ['worktree', { worktree: true }, [['publish', null], ['artifacts', ['list', 'archive']], ['doc', DOC_ACTIONS], ['drawing', DRAWING_ACTIONS], ['merge_into_project', MERGE_ACTIONS]]],
  ['main', { main: true }, [['publish', null], ['artifacts', ['list', 'archive']], ['doc', DOC_ACTIONS], ['drawing', DRAWING_ACTIONS], ['helper', HELPER_ALL]]],
  ['main + worktree', { main: true, worktree: true }, [['publish', null], ['artifacts', ['list', 'archive']], ['doc', DOC_ACTIONS], ['drawing', DRAWING_ACTIONS], ['helper', HELPER_ALL], ['merge_into_project', MERGE_ACTIONS]]],
  // a WSL chat: the work_* actions only unless it is "main" (a WSL chat is a main chat for unlanded work); a main one has the helper tools too (2026-11-25)
  ['wsl', { restricted: true }, [['publish', null], ['artifacts', ['list', 'archive']], ['doc', DOC_ACTIONS], ['drawing', DRAWING_ACTIONS], ['helper', HELPER_WORK]]],
  ['wsl worktree', { restricted: true, worktree: true }, [['publish', null], ['artifacts', ['list', 'archive']], ['doc', DOC_ACTIONS], ['drawing', DRAWING_ACTIONS], ['helper', HELPER_WORK], ['merge_into_project', MERGE_ACTIONS]]],
  ['wsl main', { restricted: true, main: true }, [['publish', null], ['artifacts', ['list', 'archive']], ['doc', DOC_ACTIONS], ['drawing', DRAWING_ACTIONS], ['helper', HELPER_ALL]]],
];

const actionsOf = (tool: Json): string[] | null => {
  const action = ((tool.inputSchema as Json).properties as Json).action as Json | undefined;
  return action ? (action.enum as string[]) : null;
};

Deno.test('tools/list is frozen per context: the six tools and their action lists', () => {
  for (const [label, ctx, expected] of FROZEN) {
    const tools = servedToolList(ctx) as Json[];
    assertEquals(tools.map((t) => [t.name, actionsOf(t)]), expected, label);
  }
  // the old 30 names are not listed anywhere
  for (const [, ctx] of FROZEN) {
    const names = servedToolList(ctx).map((t) => String(t.name));
    for (const old of ['update', 'list', 'archive', 'doc_edit', 'drawing_edit', 'start_helper', 'unlanded_work', 'resolve_edit_clash']) {
      assert(!names.includes(old), old);
    }
  }
});

Deno.test('tools/list size budget: the whole main + worktree list stays small (the old 30 tools were ~42,000 characters)', () => {
  const chars = JSON.stringify(servedToolList({ main: true, worktree: true })).length;
  assert(chars <= 11_000, `main + worktree list is ${chars} characters`);
  for (const tool of servedToolList({ main: true, worktree: true })) {
    const words = String(tool.description).split(/\s+/).length;
    assert(words <= 160, `${tool.name} description is ${words} words`);
  }
});

Deno.test('schema shape guard: flat objects, a required action enum, no combinators, $ref, const, format or type arrays', () => {
  const banned = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$ref', '$defs', 'const', 'format', 'dependentRequired'];
  const walk = (node: unknown, where: string) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      // a property NAMED like a keyword (none today) would sit inside `properties`; only schema keywords matter here
      assert(!banned.includes(key) || where.endsWith('.properties'), `${where}.${key}`);
      if (key === 'type') assert(typeof value === 'string', `${where}.type is not a string`);
      walk(value, `${where}.${key}`);
    }
  };
  for (const [label, ctx] of FROZEN) {
    for (const tool of servedToolList(ctx) as Json[]) {
      const schema = tool.inputSchema as Json;
      assertEquals([schema.type, schema.additionalProperties], ['object', false], `${label} ${tool.name}`);
      walk(schema, `${label}.${tool.name}`);
      const action = actionsOf(tool);
      if (tool.name === 'publish') {
        assertEquals(schema.required, undefined);
        assertEquals(action, null);
      } else {
        assertEquals(schema.required, ['action'], `${label} ${tool.name}`);
        assert(Array.isArray(action) && action.length > 0);
      }
    }
  }
});

// ---- a recording fake AIB ----------------------------------------------------------------------------------------------------

interface Seen {
  method: string;
  path: string;
  body: Json | null;
}

function fakeAib(reply?: (path: string, body: Json | null) => unknown) {
  const seen: Seen[] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const text = await request.text();
    const body = text ? JSON.parse(text) as Json : null;
    const path = new URL(request.url).pathname;
    seen.push({ method: request.method, path, body });
    const custom = reply?.(path, body);
    if (custom !== undefined) return Response.json(custom);
    if (path.endsWith('/artifacts/publish')) return Response.json({ id: 'abc', title: 'T', version: 1, link: 'studio-artifact://abc', url: 'u' });
    if (path.endsWith('/artifacts')) return Response.json({ artifacts: [] });
    if (path.endsWith('/artifacts/archive')) return Response.json({ artifacts: [{ id: 'a', title: 'T', link: 'l' }], refused: [] });
    if (path.endsWith('/docs/tool')) return Response.json({ ok: true, result: { ok: true } });
    if (path.endsWith('/swarm/tool')) return Response.json({ ok: true });
    return Response.json({ message: 'Done' });
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  const ctx = (extra: Ctx = {}): ToolContext => ({ key: 'k', conversation: 'conv1', cwd: null, worktree: false, roots: () => [url], ...extra });
  const call = async (context: ToolContext, name: string, args?: unknown) =>
    (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, context))!;
  return { seen, ctx, call, close: () => server.shutdown() };
}

const textOf = (reply: Json) => ((reply.result as Json).content as Json[])[0].text as string;
const isError = (reply: Json) => !!(reply.result as Json | undefined)?.isError;

Deno.test('every one of the 30 old names still works as a hidden alias, with the same route and body as before', async () => {
  const aib = fakeAib();
  const main = aib.ctx({ main: true, worktree: true });
  try {
    const cases: [string, Json, string, (b: Json | null) => unknown][] = [
      ['publish', { title: 'T', content: 'x', filename: 'a.html' }, '/api/live/artifacts/publish', (b) => b!.title],
      ['update', { id: 'abc', content: 'x' }, '/api/live/artifacts/publish', (b) => b!.id],
      ['list', {}, '/api/live/artifacts', () => true],
      ['archive', { ids: ['a'] }, '/api/live/artifacts/archive', (b) => b!.ids],
      ...['doc_list', 'doc_create', 'doc_read', 'doc_changes', 'doc_edit', 'doc_page', 'doc_claim', 'doc_undo', 'doc_comments', 'doc_comment', 'doc_reply', 'doc_resolve', 'doc_history', 'doc_restore',
        'drawing_create', 'drawing_read', 'drawing_edit', 'drawing_from_mermaid'].map((name): [string, Json, string, (b: Json | null) => unknown] => [
          name,
          { doc: 'plan', zzz: 'passed through untouched' },
          '/api/live/docs/tool',
          (b) => [b!.tool, (b!.args as Json).zzz],
        ]),
      ...['helper_providers', 'start_helper', 'helper_status', 'stop_helper', 'merge_helper', 'unlanded_work'].map((name): [string, Json, string, (b: Json | null) => unknown] => [
        name,
        { helper: 'h_1', action: 'list' },
        '/api/live/swarm/tool',
        (b) => [b!.action, (b!.args as Json).helper],
      ]),
      ['merge_into_project', {}, '/api/live/worktree/tool', (b) => b!.action],
      ['resolve_edit_clash', { action: 'check' }, '/api/live/worktree/tool', (b) => b!.action],
    ];
    assertEquals(cases.length, 30);
    for (const [name, args, path, pick] of cases) {
      aib.seen.length = 0;
      const reply = await aib.call(main, name, args);
      assert(reply.result, `${name}: ${JSON.stringify(reply)}`);
      assertEquals(aib.seen.length, 1, name);
      assertEquals(aib.seen[0].path, path, name);
      const expected = name === 'merge_into_project' ? 'merge' : name === 'resolve_edit_clash' ? 'check' : name === 'publish' ? 'T' : name === 'update' ? 'abc' : name === 'list' ? true : name === 'archive' ? ['a'] : name.startsWith('doc_') || name.startsWith('drawing_') ? [name, 'passed through untouched'] : [name, 'h_1'];
      assertEquals(pick(aib.seen[0].body), expected, name);
    }
    // gated by the same context as before: helper names need a main chat, merge names a worktree
    const plain = aib.ctx();
    aib.seen.length = 0;
    for (const name of ['helper_providers', 'start_helper', 'helper_status', 'stop_helper', 'merge_helper', 'unlanded_work', 'merge_into_project', 'resolve_edit_clash']) {
      assertEquals(((await aib.call(plain, name, {})).error as Json).code, -32602, name);
    }
    assertEquals(aib.seen.length, 0);
    // a WSL chat: unlanded_work and the doc tools answer, the helper tools do not
    const wsl = aib.ctx({ restricted: true });
    assert(!(await aib.call(wsl, 'unlanded_work', { action: 'list' })).error);
    assertEquals(((await aib.call(wsl, 'start_helper', {})).error as Json).code, -32602);
  } finally {
    await aib.close();
  }
});

Deno.test('the six tools run the handler they always had: doc, drawing, helper, artifacts, merge_into_project, publish with id', async () => {
  const aib = fakeAib();
  const main = aib.ctx({ main: true, worktree: true });
  try {
    const sent = async (name: string, args: Json) => {
      aib.seen.length = 0;
      const reply = await aib.call(main, name, args);
      assert(!isError(reply), `${name} ${JSON.stringify(args)}: ${textOf(reply)}`);
      return aib.seen[0];
    };
    assertEquals((await sent('doc', { action: 'create', doc: 'plan', markdown: '# x' })).body, { conversationId: 'conv1', tool: 'doc_create', args: { doc: 'plan', markdown: '# x' } });
    // M1: doc page takes `change`, and the route still gets `action`
    assertEquals(((await sent('doc', { action: 'page', doc: 'plan', change: 'rename', page: 'p1', title: 'New' })).body!.args), { doc: 'plan', action: 'rename', page: 'p1', title: 'New' });
    assertEquals(((await sent('doc', { action: 'page', doc: 'plan', change: 'move', page: 'p2', after: '' })).body!.args), { doc: 'plan', action: 'move', page: 'p2', after: null });
    assertEquals(((await sent('doc', { action: 'page', doc: 'plan', change: 'add', title: 'T', after: 'p1' })).body!.args), { doc: 'plan', action: 'add', title: 'T', after: 'p1' });
    assertEquals((await sent('drawing', { action: 'from_mermaid', doc: 'd', drawing: 'x', mermaid: 'flowchart TD\n A --> B' })).body!.tool, 'drawing_from_mermaid');
    // M1: flat helper actions
    assertEquals((await sent('helper', { action: 'work_land', work: 'sa_1' })).body, { conversationId: 'conv1', action: 'unlanded_work', args: { action: 'land', work: 'sa_1' } });
    assertEquals((await sent('helper', { action: 'work_discard', work: 'sa_1', reason: 'junk' })).body!.args, { action: 'discard', work: 'sa_1', reason: 'junk' });
    assertEquals((await sent('helper', { action: 'work_list' })).body!.args, { action: 'list' });
    assertEquals((await sent('helper', { action: 'stop', helper: 'all' })).body, { conversationId: 'conv1', action: 'stop_helper', args: { helper: 'all' } });
    assertEquals((await sent('helper', { action: 'merge', helper: 'h_1' })).body!.action, 'merge_helper');
    assertEquals((await sent('helper', { action: 'providers' })).body!.action, 'helper_providers');
    assertEquals((await sent('artifacts', { action: 'list' })).path, '/api/live/artifacts');
    assertEquals((await sent('artifacts', { action: 'archive', ids: ['a'], archived: false })).body, { conversationId: 'conv1', ids: ['a'], archived: false });
    assertEquals((await sent('merge_into_project', { action: 'keep_mine' })).body, { conversationId: 'conv1', action: 'keep_mine' });
    assertEquals((await sent('merge_into_project', { action: 'merge' })).body, { conversationId: 'conv1', action: 'merge' });
    // publish: no id is a new artifact, an id is a new version (the old update)
    assertEquals((await sent('publish', { title: 'T', content: 'x', filename: 'a.html' })).body!.title, 'T');
    const version = await sent('publish', { id: 'abc', content: 'y', note: 'fixed' });
    assertEquals([version.body!.id, version.body!.note, version.body!.title], ['abc', 'fixed', undefined]);
    // a required field missing, an unknown action
    for (const [name, args] of [['doc', { action: 'read' }], ['doc', { action: 'zap', doc: 'p' }], ['doc', {}], ['helper', { action: 'start' }], ['publish', {}]] as [string, Json][]) {
      aib.seen.length = 0;
      assert(isError(await aib.call(main, name, args)), `${name} ${JSON.stringify(args)}`);
      assertEquals(aib.seen.length, 0, 'a refused call sends nothing');
    }
    // an action the context does not list is refused as unknown, never sent: a WSL chat that is not a main one cannot start helpers; a plain chat has no helper
    const wsl = aib.ctx({ restricted: true }); // a WSL chat that is not a main one (a helper): the work_* actions only
    const refused = await aib.call(wsl, 'helper', { action: 'start', title: 't' });
    assert(isError(refused) && textOf(refused).includes('work_list'), textOf(refused));
    assertEquals(((await aib.call(aib.ctx(), 'helper', { action: 'work_list' })).error as Json).code, -32602);
    assertEquals(((await aib.call(aib.ctx(), 'merge_into_project', { action: 'merge' })).error as Json).code, -32602);
    assertEquals(aib.seen.length, 0);
  } finally {
    await aib.close();
  }
});

Deno.test('a field that belongs to another action is refused, never ignored, and nothing is sent', async () => {
  const aib = fakeAib();
  const main = aib.ctx({ main: true, worktree: true });
  try {
    const cases: [string, Json, string][] = [
      ['doc', { action: 'read', doc: 'p', ops: [{}] }, '`ops`'],
      ['doc', { action: 'edit', doc: 'p', ops: [{}], query: 'x' }, '`query`'],
      ['doc', { action: 'create', doc: 'p', change: 'add' }, '`change`'],
      ['doc', { action: 'page', doc: 'p', change: 'add', ifRev: 1, version: 2 }, '`version`'],
      ['doc', { action: 'page', doc: 'p', change: 'rename', page: 'x', action2: 1 } as Json, 'unknown field'],
      ['drawing', { action: 'read', doc: 'p', ops: [{}] }, '`ops`'],
      ['helper', { action: 'work_land', work: 'sa_1', goal: 'x' }, '`goal`'],
      ['helper', { action: 'stop', helper: 'h', work: 'sa_1' }, '`work`'],
      ['artifacts', { action: 'list', ids: ['a'] }, '`ids`'],
      ['merge_into_project', { action: 'check', note: 'x' }, 'unknown field'],
      ['publish', { id: 'a', content: 'x', kind: 'html' }, '`kind`'],
      ['publish', { title: 'T', content: 'x', note: 'n' }, '`note`'],
    ];
    for (const [name, args, words] of cases) {
      const reply = await aib.call(main, name, args);
      assert(isError(reply) && textOf(reply).includes(words), `${name} ${JSON.stringify(args)}: ${textOf(reply)}`);
      assert(textOf(reply).includes('doc') || textOf(reply).includes(name), 'the refusal carries the usage line');
    }
    assertEquals(aib.seen.length, 0);
    // null and "" values count as not given
    assert(!isError(await aib.call(main, 'doc', { action: 'read', doc: 'p', ops: null, query: null })));
  } finally {
    await aib.close();
  }
});

Deno.test('doc help: the long rules on demand, and a malformed edit comes back with them', async () => {
  const aib = fakeAib((path, body) => {
    if (path.endsWith('/docs/tool') && body?.tool === 'doc_edit') {
      const op = ((body.args as Json).ops as Json[])[0];
      return op.op === 'nope' ? { ok: false, result: { code: 'bad_op', message: 'op 0: bad op' } } : { ok: false, result: { code: 'guard_mismatch', message: 'changed' } };
    }
    return undefined;
  });
  const ctx = aib.ctx();
  try {
    const edit = textOf(await aib.call(ctx, 'doc', { action: 'help', topic: 'edit' }));
    for (const words of ['"op":"insert"', 'table_merge', 'chart_from_table', 'guard_mismatch', 'ifHash', 'anchors_affected']) assert(edit.includes(words), words);
    assert(edit.length > 4000);
    for (const topic of ['read', 'comments', 'pages', 'history', 'drawings']) {
      const reply = await aib.call(ctx, 'doc', { action: 'help', topic });
      assert(!isError(reply) && textOf(reply).length > 100, topic);
    }
    assert(textOf(await aib.call(ctx, 'doc', { action: 'help', topic: 'pages' })).includes('change "add"'));
    assert(textOf(await aib.call(ctx, 'doc', { action: 'help', topic: 'drawings' })).includes('add_box'));
    const index = await aib.call(ctx, 'doc', { action: 'help' });
    assert(!isError(index) && textOf(index).includes('edit') && textOf(index).includes('drawings'));
    const bad = await aib.call(ctx, 'doc', { action: 'help', topic: 'zzz' });
    assert(isError(bad) && textOf(bad).includes('topic must be one of'));
    assertEquals(aib.seen.length, 0, 'help is answered without AIB');
    // a refused edit: the grammar refusals carry the edit rules, other refusals stay short
    const malformed = await aib.call(ctx, 'doc', { action: 'edit', doc: 'p', ops: [{ op: 'nope' }] });
    assert(isError(malformed));
    const data = JSON.parse(textOf(malformed));
    assertEquals(data.code, 'bad_op');
    assert(String(data.help).includes('"op":"insert"'));
    const stale = JSON.parse(textOf(await aib.call(ctx, 'doc', { action: 'edit', doc: 'p', ops: [{ op: 'replace' }] })));
    assertEquals([stale.code, stale.help], ['guard_mismatch', undefined]);
    // the tool description points at it
    const description = String(servedToolList({}).find((t) => t.name === 'doc')!.description);
    assert(description.includes('help topic "edit"'));
  } finally {
    await aib.close();
  }
});

Deno.test('the served-tools hash sees an action list change under the same tool name (review M6)', () => {
  const names = (ctx: Ctx) => servedToolList(ctx).map((t) => String(t.name));
  assertEquals(names({ restricted: true, main: true }), names({ restricted: true }), 'same names, different contexts below');
  assert(toolSignatures({ restricted: true, main: true }).some((s) => s.startsWith('helper:merge,providers,start')), 'a WSL main chat is offered the helper tools (2026-11-25)');
  const off = consolidatedTools({ restricted: true, main: true }, { ...WSL_TOOL_GROUPS, swarm: false }).map(toolSignature);
  assert(off.includes(`helper:${[...HELPER_WORK].sort().join(',')}`), off.join(' '));
  // the WSL swarm group switched off: the same names, a shorter helper action list
  const on = consolidatedTools({ restricted: true, main: true }, { ...WSL_TOOL_GROUPS, swarm: true }).map(toolSignature);
  assertEquals(on.map((s) => s.split(':')[0]), off.map((s) => s.split(':')[0]));
  assert(toolsHash(on) !== toolsHash(off), 'the hash changes when only an action list changes');
  assertEquals(toolsHash(off), toolsHash([...off].reverse()), 'order does not matter');
  // and any one action added to any tool
  const tools = servedToolList({ main: true, worktree: true }) as Json[];
  const before = toolsHash(tools.map(toolSignature));
  const doc = tools.find((t) => t.name === 'doc')!;
  const props = (doc.inputSchema as Json).properties as Json;
  const changed = { ...doc, inputSchema: { ...(doc.inputSchema as Json), properties: { ...props, action: { type: 'string', enum: [...(actionsOf(doc) ?? []), 'extra'] } } } };
  assert(before !== toolsHash(tools.map((t) => (t === doc ? changed : t)).map(toolSignature)));
  assert(toolsHash(names({})) !== toolsHash(toolSignatures({})), 'a plain name list is not a signature list');
});

Deno.test('WSL publish: the path note is rewritten for the merged tool (id replaces update)', () => {
  const wsl = servedToolList({ restricted: true }).find((t) => t.name === 'publish')!;
  const description = String(wsl.description);
  assert(description.includes('Linux path') && description.includes('same `id` and `path`') && !description.includes('`update`'), description);
  assert(description.includes('an existing file in the distro'), description);
  assert(String((((wsl.inputSchema as Json).properties as Json).path as Json).description).startsWith('Linux path'));
  const plain = String(servedToolList({}).find((t) => t.name === 'publish')!.description);
  assert(!plain.includes('Linux path'));
});

// ---- a stub model per agent shape, creating and editing a doc through `doc` ---------------------------------------------------

/**
 * Three agent shapes, each as its host shows the model AIB's tools: Claude Code lists `mcp__studio_artifact__<tool>`, Codex calls
 * `tools.mcp__studio_artifact__<tool>(...)` from its exec script, Gemini CLI declares `mcp_studio_artifact_<tool>`. The stub model
 * sees only the names its host would show, picks the doc tool by that name, and sends a create, a read and a find-and-replace edit
 * as the model would, through the real MCP handler and the real doc backend (docs/tools.ts).
 */
const SHAPES: [string, (name: string) => string][] = [
  ['claude', (n) => `mcp__studio_artifact__${n}`],
  ['codex', (n) => `tools.mcp__studio_artifact__${n}`],
  ['gemini', (n) => `mcp_studio_artifact_${n}`],
];

for (const [shape, hostName] of SHAPES) {
  Deno.test(`stub model (${shape} shape): doc create, read and edit end to end`, async () => {
    const project = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-doc-shape-' })).replace(/^\\\\\?\\/, '');
    const state = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-doc-shape-state-' })).replace(/^\\\\\?\\/, '');
    const store = new DocStore(state, { idleMs: 60_000 });
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
      const body = await request.json();
      const [ok, result] = await runDocTool(store, project, shape, body.tool, body.args);
      return Response.json({ ok, result });
    });
    const url = `http://127.0.0.1:${server.addr.port}`;
    const ctx: ToolContext = { key: 'k', conversation: `${shape}:s1`, worktree: false, cwd: null, roots: () => [url] };
    try {
      // the model's view: the tool names its host shows
      const listed = ((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx))!.result as Json).tools as Json[];
      const shown = listed.map((t) => hostName(String(t.name)));
      const docName = shown.find((n) => n.endsWith('doc'))!;
      assert(docName, shown.join(','));
      assertEquals(docName, hostName('doc'));
      const use = async (args: Json) => {
        const bare = docName.slice(docName.length - 'doc'.length);
        const reply = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: bare, arguments: args } }, ctx))!;
        const result = reply.result as { content: { text: string }[]; isError?: boolean };
        return { data: JSON.parse(result.content[0].text) as Json, isError: !!result.isError };
      };
      const created = await use({ action: 'create', doc: 'plan', markdown: '# Plan\n\nShip it in October.' });
      assertEquals(created.isError, false, JSON.stringify(created.data));
      const read = await use({ action: 'read', doc: 'plan' });
      assertEquals(read.isError, false);
      const blocks = read.data.blocks as { id: string; md: string }[];
      assert(blocks.some((b) => b.md.includes('Ship it in October')));
      const edited = await use({
        action: 'edit',
        doc: 'plan',
        ops: [{ op: 'replace', target: { kind: 'find', text: 'October' }, with: { from: { kind: 'inline', content: 'November' }, as: 'text' } }],
      });
      assertEquals(edited.isError, false, JSON.stringify(edited.data));
      const after = await use({ action: 'read', doc: 'plan' });
      assert((after.data.blocks as { md: string }[]).some((b) => b.md.includes('Ship it in November')));
      // a malformed edit is refused with the rules, so a model that skipped help learns the grammar there
      const bad = await use({ action: 'edit', doc: 'plan', ops: [{ op: 'nope', target: { kind: 'root' } }] });
      assertEquals([bad.isError, bad.data.code], [true, 'bad_op']);
      assert(String(bad.data.help).includes('"op":"insert"'));
      assertEquals(Deno.statSync(`${project}${sep}aib-docs${sep}plan${sep}doc.aibdoc`).isFile, true);
    } finally {
      await server.shutdown();
    }
  });
}
