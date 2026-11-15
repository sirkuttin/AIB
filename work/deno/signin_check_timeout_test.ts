/**
 * The sign-in check (POST /api/live/agents/signin/check) must never hold a request for long: a status command that hangs is killed
 * after the Signer's status timeout, and callers that ask at the same time share one run of the command. A tiny Deno script stands in
 * for the agent CLI (hangs, or answers after a pause); it writes its pid to a file so the test can count starts and see the kill.
 * Nothing runs a real agent CLI or reads an account; every folder is a temp folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { join, tempDir, waitFor } from './_agents.ts';
import { Signer } from '../../outputs/agent-studio/server/agents/signin.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

const sanitize = { sanitizeOps: false, sanitizeResources: false };
const SIGNED_IN = '{"loggedIn": true, "authMethod": "claude.ai"}';

/** A fake `claude` (run as `deno run -A <script> --cli auth status --json`): logs its pid, then hangs or prints SIGNED_IN after `delayMs`. */
function fakeCli(root: string, mode: 'hang' | 'answer', delayMs = 0): { argv: string[]; starts: () => number[] } {
  const log = join(root, `starts-${mode}.log`);
  const script = join(root, `fake-${mode}.ts`);
  Deno.writeTextFileSync(
    script,
    `Deno.writeTextFileSync(${JSON.stringify(log)}, Deno.pid + '\\n', { append: true });\n` +
      (mode === 'hang'
        ? 'setInterval(() => {}, 1000);\n'
        : `await new Promise((r) => setTimeout(r, ${delayMs}));\nconsole.log(${JSON.stringify(SIGNED_IN)});\n`),
  );
  return {
    argv: [Deno.execPath(), 'run', '-A', '--no-config', script],
    starts: () => {
      try {
        return Deno.readTextFileSync(log).split('\n').filter(Boolean).map(Number);
      } catch {
        return [];
      }
    },
  };
}

Deno.test('signin check: a hung status command is killed within the timeout and counts as unknown', sanitize, async () => {
  using t = tempDir();
  const cli = fakeCli(t.root, 'hang');
  const signer = new Signer(join(t.root, 'state'), () => ({ argv: cli.argv, found: true, problem: '' }), { statusTimeout: 2 });
  const started = Date.now();
  const answer = await signer.check('claude', true);
  const took = Date.now() - started;
  assertEquals(answer.state, 'unknown');
  assert(took < 8000, `the check took ${took} ms; the budget is the 2 s timeout plus start-up`);
  await waitFor(() => cli.starts().length === 1, 5);
  const [pid] = cli.starts();
  await waitFor(() => !pidAlive(pid), 5);
  assert(!pidAlive(pid), 'the hung status command was left running');
});

Deno.test('signin check: callers at the same time share one status command (plain and forced)', sanitize, async () => {
  using t = tempDir();
  const cli = fakeCli(t.root, 'answer', 1500);
  const signer = new Signer(join(t.root, 'state'), () => ({ argv: cli.argv, found: true, problem: '' }), { statusTimeout: 20 });
  // three forced checks at once (Settings opened in two tabs and a retry): one command
  const forced = await Promise.all([signer.check('claude', true), signer.check('claude', true), signer.check('claude', true)]);
  assertEquals(forced.map((a) => a.state), ['ready', 'ready', 'ready']);
  assertEquals(cli.starts().length, 1, 'concurrent forced checks each started the CLI');
  // a plain check right after answers from the cache; joining a running forced check also needs no new command
  const again = signer.check('claude', true);
  const plain = await Promise.all([signer.check('claude'), signer.check('claude')]);
  assertEquals((await again).state, 'ready');
  assertEquals(plain.map((a) => a.state), ['ready', 'ready']);
  assertEquals(cli.starts().length, 2, 'plain checks during a forced one started the CLI again');
});
