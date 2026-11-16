/**
 * WSL audit (docs/wsl/audit-beta10.md), inbox / attention slice: the AttentionWatcher's reading of WSL chats with the real folder
 * kinds (desktop/folders.ts folderKinds: a ref is never read on Windows), against a fake agent host:
 *   - a WSL chat and a WSL worktree chat (projectRoot = the project ref) get the page's project key (notify-rules.js pathKey),
 *     are not worktree/scratch chats, and are named by the folder or the saved display name;
 *   - "needs you" is announced for a WSL chat; a muted or hidden WSL project announces nothing (prefs keyed as the page keys them);
 *   - server (project_delete.ts projectKey) and page (notify-rules.js pathKey) keys agree for refs, so names/colours/mute set on the
 *     PC apply to the phone and the desktop notifications.
 */
import { assert, assertEquals } from './_assert.ts';
import { AttentionWatcher, type Fire } from '../../outputs/agent-studio/server/attention/watcher.ts';
import { RULES } from '../../outputs/agent-studio/server/attention/rules.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { folderKinds } from '../../outputs/agent-studio/server/desktop/folders.ts';

type Json = Record<string, unknown>;
const REF = 'wsl://ubuntu/home/u/app';
const WT = 'wsl://ubuntu/home/u/.aib-server/data-0123456789ab/worktrees/app/chat-1';
const KEY = 'p:wsl:/ubuntu/home/u/app';

function lab(prefs: Json = { projects: {} }) {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-audit-inbox-' }));
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const chats = [
    { id: 'w1', sessionId: 's1', cwd: REF, projectRoot: REF, state: 'working', needs: 0, permissions: [] as string[] },
    { id: 'w2', sessionId: 's2', cwd: WT, projectRoot: REF, state: 'working', needs: 0, permissions: [] as string[] },
  ];
  const host = {
    liveList: () =>
      Promise.resolve({
        instanceId: 'test',
        connections: chats.map((c) => ({
          id: c.id,
          provider: 'claude',
          sessionId: c.sessionId,
          cwd: c.cwd,
          projectRoot: c.projectRoot,
          closed: false,
          cursor: 3,
          attention: { state: c.state, needs: c.needs, turnEndedAt: null, busySince: null },
          elicitations: [],
          queue: { items: [], paused: false },
          breadth: { sessionInfo: { title: 'Chat ' + c.id } },
        })),
      }),
    liveState: (id: string) => {
      const c = chats.find((x) => x.id === id)!;
      const events = c.permissions.map((key, i) => ({ seq: 10 + i, time: 1700000000 + i, kind: 'permission', data: { key } }));
      return Promise.resolve({ id, permissions: c.permissions.map((key) => ({ key, params: {} })), events });
    },
    busyConnections: () => Promise.resolve([]),
  };
  const fired: Fire[][] = [];
  const watcher = new AttentionWatcher({
    host: host as never,
    conversations: { public: () => ({ entries: {} }) } as never,
    projectPrefs: { public: () => prefs } as never,
    viewPrefs: { public: () => ({ prefs: {} }) } as never,
  }, { stateDir: dir, clock: () => clock, settleMs: 1000, onFire: (f) => void fired.push(f) }); // real folder kinds
  return {
    chats,
    fired,
    watcher,
    tick: (ms: number) => (clock += ms),
    close: async () => {
      await watcher.stop();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

Deno.test('inbox: server and page project keys agree for WSL refs; folder kinds never treat a ref as a worktree', () => {
  assertEquals(projectKey(REF), KEY);
  assertEquals(RULES.pathKey(REF), KEY);
  assertEquals(projectKey('wsl://ubuntu/'), RULES.pathKey('wsl://ubuntu/'));
  const kinds = folderKinds([REF, WT, 'wsl://ubuntu/home/u/scratch-1', '/home/u/app'], true);
  assertEquals(kinds[REF], { worktree: false, scratch: false });
  assertEquals(kinds[WT], { worktree: false, scratch: false });
  assertEquals(kinds['wsl://ubuntu/home/u/scratch-1'].scratch, true);
  // a bare Linux path on Windows is not looked up as C:\home\u\app (it may be listed as a plain folder, never with a worktreeOf)
  assert(!kinds['/home/u/app']?.worktreeOf, JSON.stringify(kinds['/home/u/app']));
});

Deno.test('inbox: WSL chats are filed under the WSL project, named by it, and announce "needs you"', async () => {
  const t = lab({ projects: { [KEY]: { name: 'Linux app' } } });
  try {
    for (const c of await t.watcher.sources.host.liveList().then((l) => (l as Json).connections as Json[])) {
      const facts = t.watcher.facts(c, {});
      assertEquals([facts.projectKey, facts.worktree, facts.scratch], [KEY, false, false], String(c.id));
      assertEquals(t.watcher.projectName(c, { projects: { [KEY]: { name: 'Linux app' } } }), 'Linux app');
      assertEquals(t.watcher.projectName(c, { projects: {} }), 'app');
    }
    await t.watcher.poll();
    Object.assign(t.chats[1], { state: 'needs_you', needs: 1, permissions: ['p1'] });
    await t.watcher.poll();
    await t.watcher.poll();
    const flat = t.fired.flat().map((f) => `${f.kind} ${f.key}`);
    assertEquals(flat, ['needs claude:s2'], 'the WSL worktree chat announces');
  } finally {
    await t.close();
  }
});

Deno.test('inbox: a muted WSL project announces nothing (prefs keyed as the page keys them)', async () => {
  const t = lab({ projects: { [KEY]: { muted: true } } });
  try {
    await t.watcher.poll();
    Object.assign(t.chats[0], { state: 'needs_you', needs: 1, permissions: ['p1'] });
    await t.watcher.poll();
    await t.watcher.poll();
    assertEquals(t.fired.flat().length, 0);
  } finally {
    await t.close();
  }
});
