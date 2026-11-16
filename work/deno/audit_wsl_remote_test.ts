/**
 * WSL audit (docs/wsl/audit-beta10.md), phone / remote slice: a WSL project and its chats through the phone port, end to end in an
 * in-process AIB with a fake agent host (_remote_v2b.ts) and a FakeWslHost for the distro's saved sessions. Checks that nothing on the
 * phone path treats a `wsl://` ref or a Linux path as a Windows folder:
 *   - home: a live WSL chat and a WSL worktree chat (cwd = the worktree ref, projectRoot = the project ref) are filed under the WSL
 *     project (same id as New chat's project, the folder's name), and no ref or Linux path goes to the phone;
 *   - New chat: the WSL project is offered and Start connects with exactly its ref;
 *   - saved chats: a recovered WSL worktree chat and a distro's saved session (helper transcripts.sessions) are listed, their history
 *     reads through the distro (transcripts.read), Continue connects with the chat's own ref (as the PC's Continue does);
 *   - the approval sheet's detail for a Linux path is shown as is.
 * Never a real distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { projectId } from '../../outputs/agent-studio/server/remote/projects.ts';
import { setAgentRows } from '../../outputs/agent-studio/server/remote/newchat.ts';
import { folderKey } from '../../outputs/agent-studio/server/state/agent_options.ts';
import { permissionDetail } from '../../outputs/agent-studio/server/remote/actions.ts';
import { setDistroSource, setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';
import { pairPhone } from './_remote_fixture.ts';
import { liveChat, phoneCall, v2Studio } from './_remote_v2b.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const REF = 'wsl://ubuntu/home/u/app';
const WT = 'wsl://ubuntu/home/u/.aib-server/data-0123456789ab/worktrees/app/chat-1';

Deno.env.set('AGENT_STUDIO_TEST', '1');
Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-audit-remote');

/** The fake host's liveList with each chat's projectRoot from `roots` (the fixture files every chat under its cwd). */
function withRoots(s: Awaited<ReturnType<typeof v2Studio>>, roots: Record<string, string>, recovered: Json[] = []): void {
  const host = s.ctx.host as unknown as { liveList: () => Promise<Json>; liveState: (id: string, after?: number) => Promise<Json | null> };
  const list = host.liveList.bind(host), state = host.liveState.bind(host);
  host.liveList = async () => {
    const out = await list();
    for (const c of out.connections as Json[]) if (roots[c.id as string]) c.projectRoot = roots[c.id as string];
    return { ...out, recovered };
  };
  host.liveState = async (id, after) => {
    const out = await state(id, after);
    if (out && roots[id]) out.projectRoot = roots[id];
    return out;
  };
}

const noPath = (text: string) => !text.includes('wsl://') && !text.includes('/home/u') && !text.includes('aib-server');

Deno.test({
  ...OPTS,
  name: 'phone + WSL project: home files WSL chats (and a WSL worktree chat) under the project, New chat starts with the ref, no path sent',
  async fn() {
    const s = await v2Studio();
    try {
      await s.ctx.addedProjects.add(REF);
      const phone = await pairPhone(s);
      s.chats.push(liveChat('w1', REF));
      s.chats.push(liveChat('w2', WT));
      withRoots(s, { w2: REF });
      const home = await phoneCall(s, phone.token, 'GET', '/api/remote/home');
      assertEquals(home.status, 200, home.text);
      const id = projectId(projectKey(REF));
      const cards = (home.json.chats as Json[]).filter((c) => c.id === 'w1' || c.id === 'w2');
      assertEquals(cards.length, 2);
      for (const c of cards) {
        assertEquals((c.project as Json).id, id, `card ${c.id} filed under the WSL project`);
        assertEquals((c.project as Json).name, 'app');
        assertEquals(c.folder, 'app');
      }
      assert(noPath(home.text), 'no ref or Linux path on the phone: ' + home.text.slice(0, 400));
      const chat = await phoneCall(s, phone.token, 'GET', '/api/remote/chat?id=w2');
      assertEquals(chat.status, 200, chat.text);
      assertEquals([chat.json.folder, (chat.json.project as Json).id], ['app', id]);
      assert(noPath(chat.text), 'chat payload has no path');

      const options = await phoneCall(s, phone.token, 'GET', '/api/remote/new/options');
      assertEquals(options.status, 200, options.text);
      const p = (options.json.projects as Json[]).find((x) => x.id === id);
      assert(p, 'the WSL project is offered: ' + options.text.slice(0, 300));
      assertEquals(p!.name, 'app');
      assertEquals(p!.chats, 2, 'both WSL chats (the worktree one too) count for the project');
      assert(noPath(options.text));
      const start = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: id,
        agent: 'claude',
        text: 'hello from the phone',
        clientMessageId: 'wm1',
      });
      assertEquals(start.status, 200, start.text);
      const connect = s.liveCalls.filter(([n]) => n === 'connect').at(-1)![1];
      assertEquals(connect.cwd, REF, 'Start connects with exactly the ref');
      // the project's default agent is saved under the key the PC's New chat reads (agent-choice.js projectKey: same rules)
      assertEquals(folderKey(REF), 'p:wsl:/ubuntu/home/u/app');
      const defaults = (s.ctx.settings.public().settings as Json).defaults as Json;
      assertEquals(((defaults.projects as Json)[folderKey(REF)] as Json).agent, 'claude');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone + WSL saved chats: a recovered WSL worktree chat and a distro session are listed; history via the distro; Continue keeps the ref',
  async fn() {
    const s = await v2Studio();
    const host = new FakeWslHost('unused', 'Ubuntu');
    host.handlers['transcripts.sessions'] = (p) => ({
      sessions: p.provider === 'claude'
        ? [{
          id: 'sess-distro',
          sessionId: 'sess-distro',
          key: 'enc/sess-distro.jsonl',
          provider: 'claude',
          cwd: '/home/u/app',
          title: 'Distro chat',
          hasMessages: true,
          modified: Date.now() / 1000 - 60,
        }]
        : [],
    });
    host.handlers['transcripts.read'] = () => ({
      status: 200,
      body: { events: [{ kind: 'user', text: 'read in the distro', time: Date.now() / 1000 - 60 }], total: 1 },
    });
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2 } as never]));
    try {
      await s.ctx.addedProjects.add(REF);
      const phone = await pairPhone(s);
      withRoots(s, {}, [{ provider: 'claude', sessionId: 'sess-rec', cwd: WT, projectRoot: REF, title: 'Recovered WSL', lastSeen: Date.now() / 1000 - 30 }]);
      s.ctx.phone.saved.invalidate();
      const home = await phoneCall(s, phone.token, 'GET', '/api/remote/home');
      assertEquals(home.status, 200, home.text);
      const saved = home.json.saved as Json[];
      const keys = saved.map((c) => c.key);
      assert(keys.includes('claude:sess-rec'), 'the recovered WSL worktree chat is listed: ' + JSON.stringify(saved));
      assert(keys.includes('claude:sess-distro'), 'the distro session is listed: ' + JSON.stringify(saved));
      assertEquals(saved.find((c) => c.key === 'claude:sess-distro')!.folder, 'app');
      assert(noPath(home.text), 'no path in the saved list');

      const one = await phoneCall(s, phone.token, 'GET', '/api/remote/saved?key=claude:sess-distro&tail=20');
      assertEquals(one.status, 200, one.text);
      assertEquals(one.json.history, true);
      assert(host.calls.some(([m]) => m === 'transcripts.read'), 'history read in the distro');

      s.answerLive((name) => (name === 'connect' ? [200, { id: 'c-9', provider: 'claude' }] : [200, { ok: true }]));
      let r = await phoneCall(s, phone.token, 'POST', '/api/remote/continue', { key: 'claude:sess-rec' });
      assertEquals(r.status, 200, r.text);
      assertEquals(s.liveCalls.filter(([n]) => n === 'connect').at(-1)![1].cwd, WT, 'continue: the worktree ref, as the PC sends');
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/continue', { key: 'claude:sess-distro' });
      assertEquals(r.status, 200, r.text);
      assertEquals(s.liveCalls.filter(([n]) => n === 'connect').at(-1)![1].cwd, REF);
    } finally {
      setWslHostResolver(null);
      setDistroSource(null);
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test('phone approval sheet: a Linux file path is shown as is', () => {
  const d = permissionDetail({ toolCall: { title: 'Edit', rawInput: { file_path: '/home/u/app/src/x.ts' } } });
  assertEquals(d.detail, '/home/u/app/src/x.ts');
});
