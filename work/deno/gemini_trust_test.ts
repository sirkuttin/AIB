/**
 * 0.15: Gemini folder trust (owner decision 2026-11-24) and the Qwen MCP switch. AIB gives Gemini its own trust file through
 * GEMINI_CLI_TRUSTED_FOLDERS_PATH (never ~/.gemini), listing only the chat's project folder and its AIB worktree copy; Qwen waits for
 * its MCP discovery (QWEN_CODE_LEGACY_MCP_BLOCKING). The "model request lists the studio tools" check against the real Gemini CLI and
 * the stub API is aib-shared/research/0.15-agent-tools.md section 6 (run by research/tools; needs the installed CLI).
 */
import { assert, assertEquals } from './_assert.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { GEMINI_TRUST_ENV, GEMINI_TRUST_FILE, trustFolders } from '../../app/server/agents/gemini_trust.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

Deno.test('gemini trust: the file lists exactly the folders given, as TRUST_FOLDER, and never a root', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-gemini-trust-' });
  try {
    const file = dir + SEP + GEMINI_TRUST_FILE;
    const project = dir + SEP + 'project';
    const copy = dir + SEP + 'worktrees' + SEP + 'copy1';
    trustFolders(file, [project, copy]);
    assertEquals(JSON.parse(Deno.readTextFileSync(file)), { [project]: 'TRUST_FOLDER', [copy]: 'TRUST_FOLDER' });
    trustFolders(file, [project, '/', 'C:\\', 'C:/', '']); // roots and empty names are refused; a known folder is not added twice
    assertEquals(Object.keys(JSON.parse(Deno.readTextFileSync(file))).length, 2);
    // a folder the person set to DO_NOT_TRUST stays that way (never turned into a trust by a new chat)
    Deno.writeTextFileSync(file, JSON.stringify({ [project]: 'DO_NOT_TRUST' }));
    trustFolders(file, [project, copy]);
    const after = JSON.parse(Deno.readTextFileSync(file));
    assertEquals(after[project], 'DO_NOT_TRUST');
    assertEquals(after[copy], 'TRUST_FOLDER');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: 'gemini trust: a Gemini process gets AIB\'s own trust file in its environment, Qwen its MCP switch, others neither',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-gemini-env-' });
    const aib = new Aib({ stateDir: state, port: 0, ownersDir: null, noArtifactTool: true });
    try {
      const gemini = aib.betaEnv('gemini');
      assertEquals(gemini[GEMINI_TRUST_ENV], state + SEP + GEMINI_TRUST_FILE);
      assert(!gemini[GEMINI_TRUST_ENV].includes('.gemini'), 'never the owner\'s ~/.gemini');
      assertEquals(aib.betaEnv('qwen').QWEN_CODE_LEGACY_MCP_BLOCKING, '1');
      assertEquals(aib.betaEnv('qwen')[GEMINI_TRUST_ENV], undefined);
      assertEquals(aib.betaEnv('maki')[GEMINI_TRUST_ENV], undefined);
      assertEquals(aib.betaEnv('maki').QWEN_CODE_LEGACY_MCP_BLOCKING, undefined);
    } finally {
      await aib.close();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
