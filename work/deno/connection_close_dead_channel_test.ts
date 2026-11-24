/**
 * Connection.close() with a keeper channel whose connection is already gone returns at once (no 5 s + 3 s + 3 s of waiting for an
 * exit nobody can cause) and still ends the agent process; a healthy channel still gets its graceful stdin close and its wait.
 */
import { assert } from './_assert.ts';
import { Lab, pause } from './_connection.ts';
import type { Connection } from '../../app/server/acp/connection.ts';

type Json = Record<string, unknown>;

/** Give a child-process connection a stand-in keeper channel; returns what was called on it. */
function standIn(c: Connection, unreachable: boolean, onCloseStdin: () => void) {
  const calls = { closeStdin: 0, kill: 0 };
  const conn = c as unknown as Json;
  const tree = conn.tree as { kill(): void };
  conn.tree = { kill: () => (calls.kill++, tree.kill()) };
  conn.channel = {
    unreachable,
    claim: () => Promise.resolve(0),
    closeStdin: () => (calls.closeStdin++, onCloseStdin(), Promise.resolve()),
    remove: () => Promise.resolve(),
  };
  return calls;
}

Deno.test('close with a dead channel returns under 1 s and the agent process ends', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const exited = c.process!.status;
  const calls = standIn(c, true, () => {});
  const started = performance.now();
  await c.close();
  const took = performance.now() - started;
  assert(took < 1000, `close took ${Math.round(took)} ms`);
  assert(calls.kill >= 1, 'the process tree is still killed');
  await Promise.race([exited, pause(5000).then(() => Promise.reject(new Error('agent still running')))]);
});

Deno.test('close with a healthy channel waits for the graceful exit', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const process = c.process!;
  const calls = standIn(c, false, () => void pause(1200).then(() => process.kill('SIGTERM')));
  const started = performance.now();
  await c.close();
  const took = performance.now() - started;
  assert(took >= 1100, `close did not wait for the exit (${Math.round(took)} ms)`);
  assert(calls.closeStdin === 1, 'stdin was closed first');
  assert(calls.kill === 1, 'the tree kill runs once, after the graceful exit');
});
