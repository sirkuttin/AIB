/**
 * Approvals of AIB's own tools by tool + action (tool consolidation slice 2, architect review M2 and M3): what is auto-approved,
 * that an old saved rule or Claude ask rule on an old tool name still applies to the new tool + action, that "Always allow" saves
 * tool + action, the real Codex permission shape, and the card Gemini gets (it shows no action).
 */
import { assert, assertEquals } from './_assert.ts';
import { join } from 'node:path';
import { type AllowRule, type Builtins, match, type MatchContext, ruleFor } from '../../app/server/allow/matcher.ts';
import { canonicalTool, isAutoApproved, OLD_TO_NEW } from '../../app/server/allow/own_tools.ts';
import { ownToolAction, ownToolName } from '../../app/server/acp/connection.ts';

type Json = Record<string, unknown>;
const ALL: Builtins = { safeReads: true, syntax: true, scratch: true };
const CODEX_SHAPE = JSON.parse(Deno.readTextFileSync(join(import.meta.dirname!, 'codex_acp_mcp_permission_shape.json'))) as { params: Json };

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  provider: 'claude',
  toolName: null,
  mode: 'default',
  cwd: 'C:/proj',
  project: 'C:/proj',
  scratch: null,
  stateDir: null,
  limitMs: 2000,
  ...over,
});
/** Claude's request for AIB's tool: the name in _meta, the tool input in rawInput. */
const claude = (tool: string, input: Json = {}) => ({
  sessionId: 's',
  toolCall: { toolCallId: 't', kind: 'other', rawInput: input, _meta: { claudeCode: { toolName: `mcp__studio_artifact__${tool}` } } },
  options: [{ optionId: 'y', kind: 'allow_once', name: 'Yes' }],
});
const auto = (params: Json, mcp?: never) => isAutoApproved(ownToolAction((params as { toolCall: Json }).toolCall, mcp));
const rule = (r: Partial<AllowRule>): AllowRule => ({ id: 'r1', kind: 'mcp', scope: 'global', server: 'studio_artifact', label: 'x', added: 0, from: 'card', ...r });

Deno.test('own tools: artifacts list is auto-approved, archive asks', () => {
  assert(auto(claude('artifacts', { action: 'list' })));
  assert(!auto(claude('artifacts', { action: 'archive', id: 'a' })));
  assert(!auto(claude('artifacts', {})), 'no readable action: a card');
  assert(!auto(claude('artifacts', { action: 'LIST ' })), 'only the exact action');
  // as today: the old names
  assert(auto(claude('list')));
  assert(!auto(claude('archive')));
  // publish, helper and merge_into_project stay wholly auto
  for (const t of ['publish', 'helper', 'merge_into_project']) assert(auto(claude(t, { action: 'whatever' })) && auto(claude(t)), t);
  // the whole-tool rest is not auto
  assert(!auto(claude('drawing', { action: 'read' })));
});

Deno.test('own tools: doc read, list, help and comments are auto; restore, undo, claim and the rest ask', () => {
  for (const action of ['read', 'list', 'help', 'comments']) assert(auto(claude('doc', { action })), action);
  for (const action of ['restore', 'undo', 'claim', 'create', 'edit', 'page', 'reply', 'resolve', 'comment', 'history', '']) {
    assert(!auto(claude('doc', { action })), action);
  }
  assert(!auto(claude('doc')), 'no readable action: a card');
});

Deno.test('own tools: an old saved rule on doc_restore still applies to doc + restore, and only to it', () => {
  const old = [rule({ tool: 'doc_restore' })];
  assert(match(claude('doc', { action: 'restore' }), ctx(), old, ALL).allow);
  assert(!match(claude('doc', { action: 'read' }), ctx(), old, ALL).allow, 'the old restore rule does not allow read');
  assert(!match(claude('doc', {}), ctx(), old, ALL).allow, 'an unreadable action is not covered by an action rule');
  assert(match(claude('doc_restore'), ctx(), old, ALL).allow, 'and the old name itself, as before');
  // the other way: a new tool+action rule covers the old name of that action, and an old name's action is in its name
  const fresh = [rule({ tool: 'doc', action: 'restore' })];
  assert(match(claude('doc_restore'), ctx(), fresh, ALL).allow);
  assert(!match(claude('doc_undo'), ctx(), fresh, ALL).allow);
  // a rule on a whole new tool (hand-written) means every action
  assert(match(claude('doc', { action: 'undo' }), ctx(), [rule({ tool: 'doc' })], ALL).allow);
  // another server's rule is exact, as before
  assert(!match(claude('doc', { action: 'restore' }), ctx(), [rule({ server: 'other', tool: 'doc_restore' })], ALL).allow);
});

Deno.test('own tools: a Claude ask rule on an old name still asks for the new tool + action', () => {
  const facts = { askPrograms: new Set<string>(), askTools: new Set(['mcp:studio_artifact__doc_restore']), riskyEnv: '' };
  const rules = [rule({ tool: 'doc' })]; // "doc, any action" must not answer the restore
  const c = ctx({ facts });
  assertEquals(match(claude('doc', { action: 'restore' }), c, rules, ALL).allow, false);
  assertEquals(match(claude('doc', { action: 'read' }), c, rules, ALL).allow, true, 'other actions are not named by the ask rule');
  assertEquals(match(claude('doc', {}), c, rules, ALL).allow, false, 'no readable action: the ask rule may be about it, so it asks');
  assertEquals(match(claude('doc_restore'), c, rules, ALL).allow, false);
  // an ask rule on the new whole tool asks for every action and for the old names
  const whole = ctx({ facts: { ...facts, askTools: new Set(['mcp:studio_artifact__doc']) } });
  assertEquals(match(claude('doc', { action: 'read' }), whole, rules, ALL).allow, false);
  assertEquals(match(claude('doc_read'), whole, rules, ALL).allow, false);
  // and an ask rule on a new tool + the old name of another group is not mixed up
  assertEquals(match(claude('archive'), ctx({ facts }), [rule({ tool: 'archive' })], ALL).allow, true);
});

Deno.test('own tools: Always allow saves tool + action, never the whole tool', () => {
  const draft = ruleFor(claude('doc', { action: 'read', id: 'd' }), ctx(), 'project', ALL);
  assert(draft.available && draft.rules.length === 1);
  const saved = draft.rules[0];
  assertEquals([saved.server, saved.tool, saved.action], ['studio_artifact', 'doc', 'read']);
  assert(saved.label.includes('doc · read'), saved.label);
  assert(draft.hideAgentAlways, "the agent's own Always stays hidden");
  const rules = [{ ...saved, id: 'n', added: 0, from: 'card' } as AllowRule];
  assert(match(claude('doc', { action: 'read' }), ctx(), rules, ALL).allow);
  assert(!match(claude('doc', { action: 'restore' }), ctx(), rules, ALL).allow, 'allowing doc read does not allow doc restore');
  assert(!match(claude('artifacts', { action: 'read' }), ctx(), rules, ALL).allow);
  // an old-name card saves the same tool + action
  const fromOld = ruleFor(claude('doc_restore'), ctx(), 'global', ALL).rules[0];
  assertEquals([fromOld.tool, fromOld.action], ['doc', 'restore']);
  // no readable action: nothing to save
  const none = ruleFor(claude('doc', {}), ctx(), 'global', ALL);
  assert(!none.available && none.rules.length === 0 && none.hideAgentAlways);
});

Deno.test('own tools: the Codex permission shape (recorded from codex-acp 2.6.0) names nothing; the tool_call has the action', () => {
  const params = CODEX_SHAPE.params as { toolCall: Json; _meta: Json };
  assertEquals(Object.keys(params.toolCall).sort(), ['kind', 'status', 'toolCallId']);
  assertEquals(params._meta.is_mcp_tool_approval, true);
  // by itself the request is not AIB's tool: a card
  assertEquals(ownToolName(params.toolCall), '');
  assert(!match(params, ctx({ provider: 'codex' }), [rule({ tool: 'doc', action: 'restore' })], ALL).allow);
  // with the earlier tool_call's rawInput {server, tool, arguments} (what #tools keeps) it is
  const mcp = (tool: string, action: string) => ({ server: 'studio_artifact', tool, action });
  const withParams = params;
  const call = params.toolCall;
  assertEquals(ownToolName(call, mcp('doc', 'read')), 'doc');
  assert(isAutoApproved(ownToolAction(call, mcp('doc', 'read'))));
  assert(!isAutoApproved(ownToolAction(call, mcp('doc', 'restore'))));
  assert(isAutoApproved(ownToolAction(call, mcp('artifacts', 'list'))));
  assert(!isAutoApproved(ownToolAction(call, mcp('artifacts', 'archive'))));
  assertEquals(ownToolAction(call, { server: 'other', tool: 'doc', action: 'read' }), null);
  // the matcher gets the same from its context
  const cx = (tool: string, action: string) => ctx({ provider: 'codex', mcp: mcp(tool, action) });
  const rules = [rule({ tool: 'doc', action: 'restore' })];
  assert(match(withParams, cx('doc', 'restore'), rules, ALL).allow);
  assert(!match(withParams, cx('doc', 'read'), rules, ALL).allow);
  assert(!match(withParams, cx('doc', ''), rules, ALL).allow, 'a tool_call with no action: fails closed');
  const draft = ruleFor(withParams, cx('doc', 'restore'), 'project', ALL);
  assertEquals([draft.rules[0].tool, draft.rules[0].action], ['doc', 'restore']);
  // the Codex tool_call itself (recorded in work/test_tool_details.js): rawInput.arguments.action is the action
  const toolCall = { kind: 'execute', title: 'mcp.studio_artifact.doc', _meta: { is_mcp_tool_call: true }, rawInput: { server: 'studio_artifact', tool: 'doc', arguments: { action: 'read' } } };
  assertEquals(ownToolAction(toolCall), { tool: 'doc', action: 'read' });
});

Deno.test('own tools: Gemini shows no action, so it gets a card (as today)', () => {
  const gemini = { sessionId: 's', toolCall: { toolCallId: 'g', kind: 'other', title: 'doc (studio_artifact MCP Server)' }, options: [{ optionId: 'proceed_once', kind: 'allow_once' }] };
  const name = ownToolAction(gemini.toolCall);
  assertEquals(name, { tool: 'doc', action: '' });
  assert(!isAutoApproved(name));
  assert(!isAutoApproved(ownToolAction({ title: 'artifacts (studio_artifact MCP Server)' })), 'list is not guessed');
  // an old name still resolves, with its action in the name
  assert(isAutoApproved(ownToolAction({ title: 'list (studio_artifact MCP Server)' })));
  const c = ctx({ provider: 'gemini' });
  assert(!match(gemini, c, [rule({ tool: 'doc', action: 'read' })], ALL).allow, 'an action rule does not match: fail closed');
  const draft = ruleFor(gemini, c, 'global', ALL);
  assert(!draft.available || draft.rules.every((r) => r.tool !== 'doc' || !!r.action), 'never a whole-tool doc rule from a card');
});

Deno.test('own tools: the alias table covers every old name once and only the 6 new tools', () => {
  assertEquals(Object.keys(OLD_TO_NEW).length, 30);
  const tools = new Set(Object.values(OLD_TO_NEW).map((v) => v.tool));
  assertEquals([...tools].sort(), ['artifacts', 'doc', 'drawing', 'helper', 'merge_into_project', 'publish']);
  assertEquals(canonicalTool('doc_restore'), { tool: 'doc', action: 'restore' });
  assertEquals(canonicalTool('unlanded_work', 'land'), { tool: 'helper', action: 'work_land' });
  assertEquals(canonicalTool('nope'), null);
});

Deno.test('own tools: the alias table agrees with the real tool plan (mcp_tools.ts)', async () => {
  const { toolPlan } = await import('../../app/server/artifacts/mcp_tools.ts');
  const plan = toolPlan({ main: true, worktree: true } as never, { artifacts: true, docs: true, swarm: true, merge: true } as never);
  const known = new Set(Object.values(OLD_TO_NEW).filter((v) => v.action).map((v) => `${v.tool}/${v.action}`));
  for (const t of plan) {
    if (!t.actions || t.name === 'helper' || t.name === 'merge_into_project') continue;
    for (const a of t.actions) if (a !== 'help') assert(known.has(`${t.name}/${a}`), `${t.name}/${a} has no old name`);
  }
  assertEquals(plan.map((t) => t.name).sort(), ['artifacts', 'doc', 'drawing', 'helper', 'merge_into_project', 'publish']);
});
