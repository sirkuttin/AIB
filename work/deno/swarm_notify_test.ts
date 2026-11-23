/**
 * Helper notifications (swarm items, 2026-11-23): a helper's chat notifies and pushes the way any chat does (needs you, finished,
 * failed) under the same switches, and is named by its helper ("Helper “Login bug” (Codex)"), never by the brief's first words; a helper
 * that never got to run (failed to open) is announced once through the main chat. One notification per helper event.
 */
import { assert, assertEquals } from './_assert.ts';
import { AttentionWatcher, type Fire } from '../../outputs/agent-studio/server/attention/watcher.ts';
import { RULES } from '../../outputs/agent-studio/server/attention/rules.ts';
import { Registry } from '../../outputs/agent-studio/server/swarm/registry.ts';

type Json = Record<string, unknown>;
interface Chat {
  id: string;
  sessionId: string;
  cwd: string;
  state: string;
  turnEndedAt?: string | null;
  permissions?: string[];
}

function lab(prefs: Json = { projects: {} }) {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-swarm-notify-' }));
  const chats: Chat[] = [];
  let clock = Date.parse('2026-11-23T10:00:00Z');
  const host = {
    liveList: () =>
      Promise.resolve({
        instanceId: 'test',
        connections: chats.map((c) => ({
          id: c.id,
          provider: 'codex',
          sessionId: c.sessionId,
          cwd: c.cwd,
          projectRoot: c.cwd,
          closed: false,
          cursor: 3,
          attention: { state: c.state, needs: c.permissions?.length ?? 0, turnEndedAt: c.turnEndedAt ?? null, busySince: null },
          elicitations: [],
          queue: { items: [], paused: false },
          breadth: { sessionInfo: { title: 'Task: fix the login test, own server/auth/** …' } },
        })),
      }),
    liveState: (id: string) => {
      const c = chats.find((x) => x.id === id);
      const events = (c?.permissions ?? []).map((key, i) => ({ seq: 10 + i, time: 1700000000 + i, kind: 'permission', data: { key } }));
      return Promise.resolve(c ? { id, permissions: (c.permissions ?? []).map((key) => ({ key, params: {} })), events } : null);
    },
    busyConnections: () => Promise.resolve([]),
  };
  const fired: Fire[][] = [];
  const watcher = new AttentionWatcher({
    host: host as never,
    conversations: { public: () => ({ entries: {} }) } as never,
    projectPrefs: { public: () => prefs } as never,
    viewPrefs: { public: () => ({ prefs: {} }) } as never,
  }, {
    stateDir: dir,
    clock: () => clock,
    settleMs: 1000,
    kinds: () => ({ worktree: false, scratch: false }),
    onFire: (f) => void fired.push(f),
  });
  return {
    dir,
    chats,
    fired,
    watcher,
    tick: (ms: number) => (clock += ms),
    iso: (offsetMs = 0) => new Date(Math.floor((clock + offsetMs) / 1000) * 1000).toISOString().slice(0, 19) + 'Z',
    close: () => Deno.removeSync(dir, { recursive: true }),
  };
}

const helperRecord = (live: string, parent: string): never => (<never> {
  id: 'h_notify01',
  title: 'Login bug',
  project: '/code/shop',
  parent: { live: parent, lasting: '' },
  chat: { live, lasting: '', provider: 'codex', model: '', mode: 'auto' },
  brief: { goal: '', owns: [], avoid: [], done_when: '', reply_with: '', test_cmd: '', read_only: false, context_files: [] },
  state: 'working',
  notes: [],
  reports: [],
});

Deno.test('helper chat: needs you and finished notify once each, named by the helper', async () => {
  const t = lab();
  try {
    await new Registry(t.dir).update('h_notify01', () => helperRecord('helper1', 'main1'));
    t.chats.push({ id: 'main1', sessionId: 'sm', cwd: '/code/shop', state: 'idle' }, { id: 'helper1', sessionId: 'sh', cwd: '/code/shop', state: 'working' });
    await t.watcher.poll();
    t.tick(1000);
    Object.assign(t.chats[1], { state: 'needs_you', permissions: ['p1'] });
    await t.watcher.poll();
    await t.watcher.poll();
    assertEquals(t.fired.flat().map((f) => [f.kind, f.reason, f.title]), [['needs', 'approval', 'Helper “Login bug” (Codex)']]);
    t.tick(1000);
    Object.assign(t.chats[1], { state: 'idle', permissions: [], turnEndedAt: t.iso() });
    await t.watcher.poll();
    t.tick(2000);
    await t.watcher.poll();
    await t.watcher.poll();
    assertEquals(t.fired.flat().map((f) => [f.kind, f.reason, f.title]), [
      ['needs', 'approval', 'Helper “Login bug” (Codex)'],
      ['turn', 'finished', 'Helper “Login bug” (Codex)'],
    ]);
  } finally {
    t.close();
  }
});

Deno.test('helper news (failed to open): announced once through the main chat as a failed chat; nothing for a muted project', async () => {
  const news = (fk = 'helper-failed|h_notify01') => ({
    fk,
    parent: 'main1',
    parentLasting: 'codex:sm',
    title: 'Helper “Login bug” (Codex)',
    kind: 'needs' as const,
    reason: 'failed' as const,
    what: "Codex isn't signed in",
  });
  const t = lab();
  try {
    t.chats.push({ id: 'main1', sessionId: 'sm', cwd: '/code/shop', state: 'idle' });
    await t.watcher.poll();
    t.watcher.announce(news());
    await t.watcher.poll();
    t.watcher.announce(news()); // the same event again
    await t.watcher.poll();
    assertEquals(t.fired.flat().map((f) => [f.kind, f.reason, f.title, f.what, f.chat]), [
      ['needs', 'failed', 'Helper “Login bug” (Codex)', "Codex isn't signed in", 'main1'],
    ]);
  } finally {
    t.close();
  }
  const muted = lab({ projects: { [RULES.pathKey('/code/shop')]: { hidden: false, muted: true } } });
  try {
    muted.chats.push({ id: 'main1', sessionId: 'sm', cwd: '/code/shop', state: 'idle' });
    await muted.watcher.poll();
    muted.watcher.announce(news('helper-failed|h_other'));
    await muted.watcher.poll();
    assertEquals(muted.fired.flat().length, 0, 'the same switches as a chat: a muted project stays quiet');
    assert(true);
  } finally {
    muted.close();
  }
});
