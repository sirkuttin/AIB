/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a chat that ended in a distro is still there after an AIB restart (design section
 * 11 item 5). Its Claude Code transcript lives in the distro; the helper lists it (transcripts.sessions) with the project's ref as
 * its folder, the viewer reads its history there (transcripts.read), and continuing it starts the agent in the distro with
 * session/load. The transcript is a fixture inside AIB_WSL_ROOT (the agents' CLAUDE_CONFIG_DIR under test), never the owner's own.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { wslSavedSessions, wslTranscriptGet } from '../../outputs/agent-studio/server/wsl/transcripts.ts';
import { parseQs } from '../../outputs/agent-studio/server/transcripts/pycompat.ts';

type Json = Record<string, unknown>;

Deno.test({
  name: 'wsl e2e: an ended WSL chat is listed after a restart, its history is read in the distro, and it continues there',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-sessions-e2e-' });
    await prepareRoot();
    let studio: Studio | null = null;
    try {
      const repo = `${ROOT}/repo`;
      const id = crypto.randomUUID();
      const rows = [
        { type: 'user', sessionId: id, cwd: repo, timestamp: '2026-11-14T10:00:00Z', message: { role: 'user', content: 'hello from wsl' } },
        {
          type: 'assistant',
          sessionId: id,
          cwd: repo,
          timestamp: '2026-11-14T10:00:05Z',
          message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'hi back from the distro' }] },
        },
      ];
      const folder = repo.replaceAll('/', '-');
      const made = await inDistro(
        'mkdir -p "$1/home/.claude/projects/$2" && cat > "$1/home/.claude/projects/$2/$3.jsonl"',
        [ROOT, folder, id],
        new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
      );
      assertEquals(made.code, 0, made.err);

      newAib(); // an AIB restart: a new process whose first WSL use starts the distro's host again
      await readyHost();
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      const listed = await wslSavedSessions();
      const item = listed.find((s) => s.id === id);
      assert(item, `the ended chat is listed: ${JSON.stringify(listed.map((s) => [s.key, s.cwd]))}`);
      assertEquals([item.cwd, item.projectRoot, item.provider], [ref, ref, 'claude']);
      assert(String(item.key).startsWith(`wsl.${KEY}.claude/`), String(item.key));
      assertEquals((item.wsl as Json).linuxPath, repo);
      assertEquals(await wslSavedSessions(new Set(['wsl://other/x'])), [], 'only sessions of the given projects');

      const page = await wslTranscriptGet('/api/transcript', parseQs(`key=${encodeURIComponent(String(item.key))}&limit=50`));
      assertEquals(page?.status, 200, JSON.stringify(page?.body));
      const text = JSON.stringify((page!.body as Json).events);
      assert(text.includes('hello from wsl') && text.includes('hi back from the distro'), text);
      assertEquals((await wslTranscriptGet('/api/agents', parseQs(`session=${encodeURIComponent(String(item.key))}`)))?.status, 200);
      assertEquals(await wslTranscriptGet('/api/transcript', parseQs('key=claude/x.jsonl')), null, 'Windows keys are not WSL ones');

      // Continue: the agent starts in the distro with session/load of that id (the fake agent stands in for Claude).
      studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
      studio.ownerProbe = () => null;
      studio.connectionFactory = (_command, cwd, provider, options) =>
        new Connection(['python3', `${ROOT}/fake_acp.py`], cwd, provider, {
          ...options,
          wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/python3' } : options?.wsl,
        });
      const c = await studio.connect('claude', ref, id);
      assert(c.ready && !c.closed, 'continued');
      assertEquals([c.cwd, c.agentCwd], [ref, repo]);
    } finally {
      await studio?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});
