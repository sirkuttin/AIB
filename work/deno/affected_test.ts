/**
 * tools/affected.ts, the map behind `deno task test:affected`: a change reaches the tests that cover it, by import, by a file a test
 * names, by the scripts an HTML page loads, and through the two broad rules (the whole server; every page file for browser tests).
 * Built from the real repo, so a map that stops finding a known link fails here.
 */
import { assert, assertEquals } from './_assert.ts';
import { affected, buildGraph, closure, why } from '../../tools/affected.ts';
import { SLOW } from '../../tools/test.ts';

const slow = new Set(Object.keys(SLOW));
const graph = buildGraph();
const tests = (changed: string[], allSlow = false) => {
  const a = affected(changed, slow, '', allSlow);
  const out = new Set<string>();
  for (const [kind, picked] of a.run) for (const t of picked.keys()) out.add(kind === 'go' ? 'go:keeper' : t.split('/').pop()!);
  out.delete('affected_test.ts'); // this file names the files it checks, so the map rightly ties it to them
  return { out, a };
};

Deno.test('affected: a test file runs itself; a helper runs the tests that import it', () => {
  assertEquals([...tests(['work/deno/security_test.ts']).out], ['security_test.ts']);
  assertEquals([...tests(['work/test_split_tree.js']).out], ['test_split_tree.js']);
  const viaHelper = tests(['work/deno/_ports.ts']).out;
  for (const t of ['desktop_serve_test.ts', 'agent_host_test.ts', 'artifact_origin_test.ts']) assert(viaHelper.has(t), t);
  assert(!viaHelper.has('security_test.ts'), 'a test that does not use the helper does not run');
});

Deno.test('affected: a server module reaches the tests that import it, through the import graph', () => {
  const t = tests(['outputs/agent-studio/server/worktrees/sync.ts']).out;
  for (const name of ['worktree_sync_test.ts', 'worktree_sync_interop_test.ts']) assert(t.has(name), name);
  assert(closure(graph, 'work/deno/worktree_sync_test.ts').has('outputs/agent-studio/server/worktrees/sync.ts'));
});

Deno.test('affected: a page file reaches node tests that load it by name or through chat.html, and the browser e2e', () => {
  const t = tests(['outputs/agent-studio/stream-ui.js']).out;
  for (const name of ['test_stream_ui.js', 'test_chat_page.js', 'scroll_e2e_test.ts']) assert(t.has(name), name);
  assert(graph.precise.get('outputs/agent-studio/chat.html')?.has('outputs/agent-studio/stream-ui.js'), 'chat.html loads it');
  assert(why(graph, 'work/deno/scroll_e2e_test.ts', 'outputs/agent-studio/stream-ui.js'), 'the scroll e2e reaches it');
  assert(!t.has('security_test.ts'));
});

Deno.test('affected: Go keeper changes run the Go tests and the Deno tests that build the keeper; nothing else', () => {
  const t = tests(['keeper/server.go']).out;
  assert(t.has('go:keeper'));
  assert(t.has('keeper_crash_e2e_test.ts'), 'calls keeperBinary()');
  assert(!t.has('worktree_sync_test.ts'));
});

Deno.test('affected: a parity module reaches the tests that call it by name', () => {
  assert(tests(['work/python-reference/attachments.py']).out.has('attachments_test.ts'));
});

Deno.test('affected: a slow file reached only through a broad rule is listed, not run, unless --all-slow', () => {
  const { a } = tests(['outputs/agent-studio/server/web/security.ts']);
  const listed = [...a.broadOnly.keys()];
  for (const name of listed) assert(slow.has(name), name);
  if (listed.length) {
    const all = tests(['outputs/agent-studio/server/web/security.ts'], true).out;
    for (const name of listed) assert(all.has(name), name);
  }
});

Deno.test('affected: a dependency file change runs everything', () => {
  const { a } = tests(['outputs/agent-studio/deno.lock']);
  assert(a.everything);
  assertEquals(a.run.get('deno')?.size, [...graph.files].filter((f) => /^work\/deno\/[^/]+_test\.ts$/.test(f)).length);
});
