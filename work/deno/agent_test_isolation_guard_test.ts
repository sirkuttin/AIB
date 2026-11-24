/**
 * Guard: a test that runs a REAL agent (Claude Code, Codex, Gemini, Maki) keeps its project folders outside the user's home folder
 * (the port of work/test_agent_test_isolation_guard.py).
 *
 * Claude Code walks the parent folders of its working folder for CLAUDE.md, so a project under the user's %TEMP% (inside
 * C:\Users\<me>) loads the owner's ~/.claude/CLAUDE.md as project instructions even with CLAUDE_CONFIG_DIR set. Real-agent tests use
 * work/deno/_agent_tmp.ts: C:/aib-test-tmp on Windows, /tmp on Linux.
 *
 *   test_helper_folders_are_outside_home      the helper's root and the folders it makes (and the e2e Fixture's) are not in the home folder
 *   test_inside_home_sees_a_folder_in_home    the check itself works (a folder in home is "inside")
 *   test_real_agent_e2e_tests_use_helper      every work/deno/*_test.ts that references a real adapter / the stub model API makes its
 *                                             folders with the helper, never Deno.makeTempDir* (the Python half of the guard went with
 *                                             the Python tests it guarded)
 */
import { assert, assertEquals } from './_assert.ts';
import { agentTempDirSync, agentTempRoot, insideHome } from './_agent_tmp.ts';
import { Fixture } from './_host_fixture.ts';
import { WORK } from './_work.ts';

const REAL = /stub_model_api|Stub\.start\(|CLAUDE_ACP|CODEX_ACP/;

Deno.test('test_helper_folders_are_outside_home', async () => {
  assert(!insideHome(agentTempRoot()), agentTempRoot());
  const folder = agentTempDirSync('aib-guard-');
  try {
    assert(!insideHome(folder), folder);
  } finally {
    Deno.removeSync(folder, { recursive: true });
  }
  await using fixture = new Fixture(agentTempRoot());
  assert(!insideHome(fixture.root), fixture.root);
  assert(!insideHome(fixture.workspace), fixture.workspace);
});

Deno.test('test_inside_home_sees_a_folder_in_home', () => {
  const home = Deno.env.get('USERPROFILE') ?? Deno.env.get('HOME') ?? '';
  assert(insideHome(home));
  assert(insideHome(`${home}${Deno.build.os === 'windows' ? '\\' : '/'}AppData${Deno.build.os === 'windows' ? '\\' : '/'}Local${Deno.build.os === 'windows' ? '\\' : '/'}Temp${Deno.build.os === 'windows' ? '\\' : '/'}x`));
  assert(!insideHome(agentTempRoot()));
});

Deno.test('test_real_agent_e2e_tests_use_helper', () => {
  const dir = decodeURIComponent(new URL('deno/', WORK).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const offenders: string[] = [];
  const checked: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.name.endsWith('_test.ts') || entry.name === 'agent_test_isolation_guard_test.ts') continue;
    const text = Deno.readTextFileSync(`${dir}${entry.name}`);
    if (!REAL.test(text)) continue;
    checked.push(entry.name);
    if (/Deno\.makeTempDir(?:Sync)?\(/.test(text)) offenders.push(entry.name);
  }
  assert(checked.length > 0, 'found no real-agent tests: the pattern is stale');
  assertEquals(offenders, [], 'use agentTempDirSync from work/deno/_agent_tmp.ts in real-agent Deno tests');
});
