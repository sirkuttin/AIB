/**
 * WSL audit (docs/wsl/audit-beta10.md), server side of paths in WSL chats: what AIB answers when the page sends it a bare Linux
 * path (the page's path links do, see work/audit_wsl_page_links.js). These tests pin today's answers (clean refusals, nothing
 * read on the Windows disk); the messages are what the user sees.
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { setDistroSource, setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { _mentioned, filesRoutes } from '../../outputs/agent-studio/server/web/files_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import { makeMethods } from '../../outputs/agent-studio/server/wsl/helper/methods.ts';
import { handleLine } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import { cleanPathText, EditorError, resolveWslInside } from '../../outputs/agent-studio/server/desktop/editors.ts';
import { checkShape } from '../../outputs/agent-studio/server/worktrees/outside_files.ts';
import { FilesError } from '../../outputs/agent-studio/server/worktrees/files.ts';

const WIN = Deno.build.os === 'windows';
const REF = 'wsl://ubuntu/home/u/app';

Deno.test({
  name: 'editors: Ctrl+click on a bare Linux path (an outside link in a WSL chat) is refused with "That path is not a folder of this PC"',
  ignore: !WIN,
  fn() {
    const e = assertThrows(() => cleanPathText('/home/u/other/run.log'), EditorError) as EditorError;
    assertEquals(e.message, 'That path is not a folder of this PC');
    // even as a ref, a file outside every known project is refused (outside links can never open in an editor)
    const r = assertThrows(() => resolveWslInside('wsl://ubuntu/home/u/other/run.log', [REF]), EditorError) as EditorError;
    assertEquals(r.message, 'That location is not inside a project folder AIB knows, so AIB will not open it');
    // a ref inside the project is opened
    assertEquals(resolveWslInside(REF + '/README.md', [REF]).linuxPath, '/home/u/app/README.md');
  },
});

Deno.test({
  name: 'files/outside for a WSL chat that is not live in this process: the Windows branch answers "Network and device paths are not supported"',
  ignore: !WIN,
  fn() {
    // a chat that is neither live nor a saved WSL session goes to checkShape, which refuses a Linux path (saved WSL chats: F10 below)
    const e = assertThrows(() => checkShape('/home/u/app/README.md'), FilesError) as FilesError;
    assertEquals(e.message, 'Network and device paths are not supported');
  },
});

// ---- F10 (owner-approved): outside files for a saved WSL chat that is not running in AIB ------------------------------------

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SID = '0a6c1f5e-1111-4222-8333-944445555666';
const READ = (path: string) => ({
  read: { path, abs: path, name: path.split('/').pop(), size: 4, mtime: 1, binary: false, tooBig: false, image: false, page: false, text: 'log\n', lines: 1 },
  outside: { kind: 'folder', folder: '/home/u/other', top: '', branch: '', repo: '', text: '/home/u/other' },
});

Deno.test('F10 helper transcripts.mentions: a saved session names a Linux path only by its exact spelling; relative paths are refused', async () => {
  const home = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-mentions-' }));
  try {
    const dir = osp.join(home, '.claude', 'projects', '-home-u-app');
    Deno.mkdirSync(dir, { recursive: true });
    const line = { type: 'assistant', sessionId: SID, cwd: '/home/u/app', message: { content: [{ type: 'text', text: 'Log at /home/u/other/run.log' }] } };
    Deno.writeTextFileSync(osp.join(dir, SID + '.jsonl'), JSON.stringify(line) + '\n');
    const methods = makeMethods({ env: () => Promise.resolve({ env: { HOME: home }, shell: '/bin/sh', home, arch: 'amd64' }) });
    const ask = async (params: Json) =>
      await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transcripts.mentions', params }), methods) as {
        result?: Json;
        error?: { message: string };
      };
    assertEquals((await ask({ provider: 'claude', sessionId: SID, path: '/home/u/other/run.log' })).result, { mentioned: true });
    assertEquals((await ask({ provider: 'claude', sessionId: SID, path: '/home/u/other/Run.log' })).result, { mentioned: false });
    assertEquals((await ask({ provider: 'claude', sessionId: SID, path: '/home/u/other/secret.txt' })).result, { mentioned: false });
    assertEquals((await ask({ provider: 'claude', sessionId: 'no-such-session', path: '/home/u/other/run.log' })).result, { mentioned: false });
    assertEquals((await ask({ provider: 'codex', sessionId: SID, path: '/home/u/other/run.log' })).result, { mentioned: false });
    assert((await ask({ provider: 'claude', sessionId: SID, path: 'other/run.log' })).error, 'a relative path is refused');
  } finally {
    Deno.removeSync(home, { recursive: true });
  }
});

Deno.test({
  name: 'F10 outside route for a saved WSL chat: the helper checks its transcript, then reads; unnamed and stopped-distro asks are refused',
  ...T,
  async fn() {
    const env = { AIB_WSL_ROOT: Deno.env.get('AIB_WSL_ROOT'), AGENT_STUDIO_TEST: Deno.env.get('AGENT_STUDIO_TEST') };
    Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-audit-f10');
    Deno.env.set('AGENT_STUDIO_TEST', '1');
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['transcripts.sessions'] = (p) => ({
      sessions: p.provider === 'claude' ? [{ key: '-home-u-app/' + SID + '.jsonl', sessionId: SID, cwd: '/home/u/app', title: 'Saved' }] : [],
    });
    host.handlers['transcripts.mentions'] = (p) => ({ mentioned: p.path === '/home/u/other/run.log' });
    host.handlers['files.outside'] = (p) => READ(String(p.path));
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2 } as never]));
    const ctx = {
      token: 'tok',
      stateDir: null,
      host: { connections: new Map(), liveState: () => Promise.resolve(null) }, // the chat is not running in AIB
      conversations: { entries: {} },
      transcripts: { stores: new Map() },
      artifacts: { store: { origin: 'http://127.0.0.1:9' }, conversations: () => [] },
    } as unknown as WebContext;
    const ask = async (query: Record<string, string>) => {
      _mentioned.clear();
      const handler = filesRoutes().get('GET /api/live/files/outside')!;
      const url = new URL('http://127.0.0.1/api/live/files/outside?' + new URLSearchParams(query));
      return await handler(ctx, url, null, new Request(url, { headers: { 'X-Studio-Token': 'tok' } })) as [number, Json];
    };
    const names = () => host.calls.map(([m]) => m);
    try {
      const [s, read] = await ask({ id: 'claude:' + SID, path: '/home/u/other/run.log', peek: '1' });
      assertEquals([s, read.name, read.wsl, read.root], [200, 'run.log', true, '']);
      const mention = host.calls.find(([m]) => m === 'transcripts.mentions')![1];
      assertEquals([mention.provider, mention.sessionId, mention.path, mention.claudeDir], ['claude', SID, '/home/u/other/run.log', '/tmp/aib-wsl-test-audit-f10/home/.claude']);
      assertEquals(host.calls.at(-1), ['files.outside', { path: '/home/u/other/run.log', peek: true }]);
      // the transcript-key form of the same chat works too
      assertEquals((await ask({ id: 'wsl.ubuntu.claude/-home-u-app/' + SID + '.jsonl', path: '/home/u/other/run.log', peek: '1' }))[0], 200);
      // a path its transcript never named: refused before anything is read
      host.calls.length = 0;
      const [s2, no] = await ask({ id: 'claude:' + SID, path: '/home/u/other/secret.txt', peek: '1' });
      assertEquals([s2, no.code, no.error], [403, 'not_mentioned', 'This chat never named that file']);
      assert(!names().includes('files.outside'), 'never read: ' + names().join(', '));
      // the distro stopped: a clear line, and nothing is started or asked
      host.state = 'stopped';
      host.calls.length = 0;
      const [s3, off] = await ask({ id: 'claude:' + SID, path: '/home/u/other/run.log', peek: '1' });
      assertEquals([s3, off.code, off.error], [409, 'wsl_not_running', 'Ubuntu is not running']);
      assertEquals(names(), []);
      host.state = 'ready';
      // a saved Windows chat (no such WSL session) keeps the Windows answer
      const [s4, win] = await ask({ id: 'claude:not-a-wsl-session', path: '/home/u/other/run.log' });
      assertEquals([s4, win.error], [400, 'Network and device paths are not supported']);
    } finally {
      setWslHostResolver(null);
      setDistroSource(null);
      for (const [k, v] of Object.entries(env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  },
});
