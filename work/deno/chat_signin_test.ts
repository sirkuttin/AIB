/**
 * The chat's sign-in card on the server side (Deno only; the Python reference has no mid-session sign-in): a prompt that fails because
 * the agent's login expired becomes one sign-in state (not two raw errors), AIB resends the message once after the sign-in, a sign-in
 * that did not take says so, Claude Code is offered its terminal methods, and the terminal command is the agent's own launcher plus
 * the advertised args. Fake agents only (work/fake_acp.py); no real CLI and no real credentials.
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { events, FAKE, type Json, Lab, PYTHON, until, updateTexts } from './_connection.ts';
import { ValueError } from '../../app/server/core/py.ts';
import { builtinSigninCommand } from '../../app/server/web/terminal_routes.ts';
import type { AgentOptions } from '../../app/server/web/shared.ts';

const replies = (c: { events: Json[] }) => updateTexts(c as never).filter((t) => t.startsWith('Fixture reply'));

Deno.test('mid-session auth failure: one sign-in card with the agent text as detail, no raw error', async () => {
  await using lab = new Lab();
  const marker = lab.path('signed-in');
  const c = await lab.open(['--prompt-auth', '--held-turn', '--auth-file', marker], { provider: 'claude' });
  await c.prompt('hello', 'm1');
  await until(() => c.auth !== null && !c.busy);
  const auth = c.public().auth as Json;
  assertEquals(auth.during, 'prompt');
  assert(String(auth.detail).startsWith('Failed to authenticate: OAuth session expired'), String(auth.detail));
  assert(String(auth.detail).includes('Authentication required'));
  assertEquals(events(c, 'error').length, 0, 'no raw error bubble');
  assertEquals(events(c, 'auth_required').length, 1);
  assertEquals(c.public().state, 'input_needed');
  // Claude Code is asked with auth.terminal, so its terminal methods come with the args AIB runs
  const methods = auth.methods as Json[];
  assertEquals(methods.map((m) => m.id), ['claude-ai-login', 'console-login']);
  assertEquals(methods[0].args, ['--fixture-login']);
  assertEquals(c.error, '');
});

Deno.test('after the terminal sign-in succeeds, retry sends the failed message again once and the card clears', async () => {
  await using lab = new Lab();
  const marker = lab.path('signed-in');
  const c = await lab.open(['--prompt-auth', '--held-turn', '--auth-file', marker], { provider: 'claude' });
  await c.prompt('hello again');
  await until(() => c.auth !== null && !c.busy);
  // what the terminal runs: the agent's own launcher + the method's args (here the fake's --fixture-login writes the marker)
  const login = new Deno.Command(PYTHON, { args: [FAKE, '--auth-file', marker, '--fixture-login'], stdout: 'null', stderr: 'null' });
  assertEquals((await login.output()).code, 0);
  c.answerAuth('retry');
  await until(() => replies(c).some((t) => t.includes('hello again')) && !c.busy);
  assertEquals(c.auth, null);
  assertEquals(events(c, 'user').length, 2, 'sent once more');
  assertEquals(events(c, 'error').length, 0);
});

Deno.test('a sign-in that did not take: the card comes back saying so (Try again), and Dismiss shows the detail', async () => {
  await using lab = new Lab();
  const marker = lab.path('signed-in');
  const c = await lab.open(['--prompt-auth', '--held-turn', '--auth-file', marker], { provider: 'claude' });
  await c.prompt('x');
  await until(() => c.auth !== null && !c.busy);
  c.answerAuth('retry'); // not signed in: the resend fails for sign-in again
  await until(() => events(c, 'auth_required').length === 2 && c.auth !== null && !c.busy);
  assert(c.auth!.error.includes('still asks for sign-in'), c.auth!.error);
  assert(assertThrows(() => c.answerAuth('authenticate', 'claude-ai-login'), ValueError).message.includes('terminal'));
  c.answerAuth('cancel');
  assertEquals(c.auth, null);
  const errors = events(c, 'error');
  assertEquals(errors.length, 1);
  assert(String((errors[0].data as Json).message).includes('Failed to authenticate'));
});

Deno.test('an in-app method (Codex shape): authenticate on the live connection, then the message goes again', async () => {
  await using lab = new Lab();
  const marker = lab.path('signed-in');
  const c = await lab.open(['--prompt-auth', '--held-turn', '--auth-file', marker], { provider: 'codex' });
  await c.prompt('codex hi');
  await until(() => c.auth !== null && !c.busy);
  assertEquals((c.auth!.methods).map((m) => [m.id, m.kind]), [['fixture-login', 'agent']], 'no auth.terminal for Codex');
  c.answerAuth('authenticate', 'fixture-login');
  await until(() => replies(c).some((t) => t.includes('codex hi')) && !c.busy);
  assertEquals(c.auth, null);
});

Deno.test('setup-time: Claude Code is offered its terminal method with args (auth.terminal sent)', async () => {
  await using lab = new Lab();
  const [c] = lab.start(['--auth-required', '--beta-auth'], 'claude');
  await until(() => c.auth !== null);
  const terminal = c.auth!.methods.find((m) => m.kind === 'terminal');
  assert(terminal, 'a terminal method is offered');
  assertEquals(terminal!.args, ['--fixture-login']);
  assertEquals(c.auth!.during, undefined);
  const [other] = lab.start(['--auth-required', '--beta-auth'], 'omp');
  await until(() => other.auth !== null);
  assertEquals(other.auth!.methods.filter((m) => m.kind === 'terminal').length, 0, 'other agents are not sent auth.terminal');
});

Deno.test("the sign-in terminal runs the agent's own launcher with the advertised args; unsafe args are refused", async () => {
  const options = { claudeLauncher: FAKE, codexLauncher: "", ompCommand: "", nodeCommand: PYTHON, stateDir: null } as unknown as AgentOptions;
  const ctx = { agentOptions: options, settings: { launcher: () => '' } } as never;
  const spec = await builtinSigninCommand(ctx, 'claude', ['--fixture-login']);
  assert(typeof spec !== 'string', String(spec));
  const all = [spec.file, ...spec.args];
  assertEquals(all.slice(-1), ['--fixture-login']);
  assert(all.some((a) => a.endsWith('fake_acp.py')), all.join(' '));
  assert(typeof (await builtinSigninCommand(ctx, 'claude', ['login & calc'])) === 'string');
  assert(typeof (await builtinSigninCommand(ctx, 'claude', [])) === 'string');
});
