/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a chat that ended in a distro is still there after an AIB restart (design section
 * 11 item 5). Its Claude Code transcript lives in the distro; the helper lists it (transcripts.sessions) with the project's ref as
 * its folder, the viewer reads its history there (transcripts.read), and continuing it starts the agent in the distro with
 * session/load. The transcript is a fixture inside AIB_WSL_ROOT (the agents' CLAUDE_CONFIG_DIR under test), never the owner's own.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, newAib, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { wslSavedSessions, wslTranscriptGet } from '../../app/server/wsl/transcripts.ts';
import { parseQs } from '../../app/server/transcripts/pycompat.ts';
import { _mentioned, filesRoutes } from '../../app/server/web/files_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;

Deno.test({
  name: 'wsl e2e: an ended WSL chat is listed after a restart, its history is read in the distro, and it continues there',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-sessions-e2e-' });
    await prepareRoot();
    let aib: Aib | null = null;
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
        // ended ten minutes ago: a transcript written moments ago by someone else would ask before Continue (the ownership check)
        'mkdir -p "$1/home/.claude/projects/$2" && cat > "$1/home/.claude/projects/$2/$3.jsonl" && touch -d "@$4" "$1/home/.claude/projects/$2/$3.jsonl"',
        [ROOT, folder, id, String(Math.floor(Date.now() / 1000) - 600)],
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
      aib = new Aib({ stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
      aib.ownerProbe = () => null;
      aib.connectionFactory = (_command, cwd, provider, options) =>
        new Connection(['node', `${ROOT}/fake_acp.mjs`], cwd, provider, {
          ...options,
          wsl: options?.wsl ? { ...options.wsl, program: '/usr/bin/node' } : options?.wsl,
        });
      const c = await aib.connect('claude', ref, id);
      assert(c.ready && !c.closed, 'continued');
      assertEquals([c.cwd, c.agentCwd], [ref, repo]);
    } finally {
      await aib?.close().catch(() => {});
      await cleanRoot();
      Deno.removeSync(state, { recursive: true });
    }
  },
});

Deno.test({
  name: 'wsl e2e (audit F10): a saved WSL chat that is not running opens an outside file its transcript names, and only that one',
  ...T,
  async fn() {
    await prepareRoot();
    const OUT = `${ROOT}-out`; // outside the project and outside AIB's own folder (the helper never shows AIB_WSL_ROOT)
    try {
      const repo = `${ROOT}/repo`;
      const id = crypto.randomUUID();
      const rows = [
        { type: 'user', sessionId: id, cwd: repo, timestamp: '2026-11-14T10:00:00Z', message: { role: 'user', content: 'where is the log?' } },
        {
          type: 'assistant',
          sessionId: id,
          cwd: repo,
          timestamp: '2026-11-14T10:00:05Z',
          message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: `The log is at ${OUT}/run.log` }] },
        },
      ];
      const made = await inDistro(
        'mkdir -p "$1/home/.claude/projects/$2" "$4" && cat > "$1/home/.claude/projects/$2/$3.jsonl" && printf "log\\n" > "$4/run.log" && printf "no\\n" > "$4/secret.txt"',
        [ROOT, repo.replaceAll('/', '-'), id, OUT],
        new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
      );
      assertEquals(made.code, 0, made.err);
      newAib();
      const host = await readyHost();
      const claudeDir = `${ROOT}/home/.claude`;
      assertEquals(await host.call('transcripts.mentions', { provider: 'claude', sessionId: id, path: `${OUT}/run.log`, claudeDir }), { mentioned: true });
      assertEquals(await host.call('transcripts.mentions', { provider: 'claude', sessionId: id, path: `${OUT}/secret.txt`, claudeDir }), { mentioned: false });
      assertEquals(await host.call('transcripts.mentions', { provider: 'claude', sessionId: id, path: `${OUT}/Run.log`, claudeDir }), { mentioned: false });

      const ctx = {
        token: 'tok',
        stateDir: null,
        host: { connections: new Map(), liveState: () => Promise.resolve(null) },
        conversations: { entries: {} },
        transcripts: { stores: new Map() },
        artifacts: { store: { origin: 'http://127.0.0.1:9' }, conversations: () => [] },
      } as unknown as WebContext;
      const ask = async (path: string) => {
        _mentioned.clear();
        const url = new URL('http://127.0.0.1/api/live/files/outside?' + new URLSearchParams({ id: `claude:${id}`, path }));
        return await filesRoutes().get('GET /api/live/files/outside')!(ctx, url, null, new Request(url, { headers: { 'X-Studio-Token': 'tok' } })) as [
          number,
          Json,
        ];
      };
      const [s, read] = await ask(`${OUT}/run.log`);
      assertEquals([s, read.name, read.text, read.wsl], [200, 'run.log', 'log\n', true], JSON.stringify(read));
      const [s2, no] = await ask(`${OUT}/secret.txt`);
      assertEquals([s2, no.code], [403, 'not_mentioned']);
    } finally {
      await inDistro('case "$1" in /tmp/aib-wsl-test-*-out) rm -rf -- "$1";; esac', [OUT]);
      await cleanRoot();
    }
  },
});
