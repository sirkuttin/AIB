/**
 * Phone UI v2 part 2: the adversarial code review's findings (phone-v2-code-review.md), server side, against an in-process AIB
 * with a fake agent host whose prompt behaves like Connection.prompt (_remote_v2b.ts):
 *  1  AIB restarts while a phone's new chat opens: the start is forgotten (404), the chat's own events carry the first message's
 *     clientMessageId once it went, and a repeat with that id is dropped by the agent host;
 *  2  Start sent again (the network dropped): the same chat, never a second one (also two at once);
 *  3  a rename on the PC saves one chat's name (POST /api/live/chat-name), so a phone's rename the PC page has not read is kept;
 *  5  /new/options refuses an agent that cannot start (no probe of a turned-off or missing agent);
 *  6  /artifacts lists only the chat's own live id, never another chat's;
 *  7  Undo is only the exact inverse of what this phone did, and only while the chat is as it left it;
 *  8  no folder path (or any agent host words) in the errors a phone sees;
 *  9  a project default with a model and mode but no agent: a new default agent clears them unless it is the global default;
 *  10 Start new chats turned off while the chat opens: the first message does not go;
 *  11 the phone's unread dots count from the PC page's epoch (studio-sidebar-epoch), as the PC does;
 *  12 deleting a running chat whose session ends slowly says so ("delete it again"), never a bare refusal;
 *  13 New chat sends no model or mode unless one is picked or saved; a pick not on the agent's list is refused.
 *  And the fake agent host itself: not ready / busy refused, a repeated id de-duplicated, the same id with other text refused.
 */
import { assert, assertEquals } from './_assert.ts';
import { NewChats, setAgentRows } from '../../outputs/agent-studio/server/remote/newchat.ts';
import { RemoteServer } from '../../outputs/agent-studio/server/remote/server.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { AGENT_ROWS, liveChat, phoneCall, v2Studio } from './_remote_v2b.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const enc = (t: string) => new TextEncoder().encode(t);

async function until(fn: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out: ' + what);
}
const folderKeyOf = (p: string) => 'w:' + p.replaceAll('\\', '/').toLowerCase();
const entries = (s: { ctx: { conversations: { public(): { entries: unknown } } } }) =>
  s.ctx.conversations.public().entries as unknown as Record<string, Json>;

Deno.test({
  ...OPTS,
  name: 'fake agent host: like Connection.prompt (not ready and busy refused, a repeated id is a duplicate, other text refused)',
  async fn() {
    const s = await v2Studio();
    try {
      s.chats.push(liveChat('c1', s.project), liveChat('c2', s.project, { ready: false }), liveChat('c3', s.project, { busy: true }));
      const call = (id: string, text: string, mid: string) => s.ctx.host.liveCall('prompt', { id, text, clientMessageId: mid });
      assertEquals((await call('c2', 'x', 'a'))[0], 400, 'not ready');
      assertEquals((await call('c3', 'x', 'b'))[0], 400, 'busy');
      const [st, first] = await call('c1', 'hello', 'm1');
      assertEquals([st, (first as Json).duplicate], [200, false]);
      const [st2, again] = await call('c1', 'hello', 'm1');
      assertEquals([st2, (again as Json).duplicate], [200, true]);
      assertEquals(s.chats[0].events.filter((e) => e.kind === 'user' && (e.data as Json).clientMessageId === 'm1').length, 1);
      assertEquals((await call('c1', 'other', 'm1'))[0], 400, 'same id, other text');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'review 1: AIB restarts while a new chat opens: the start is forgotten (404), the first message is found by its id once it went',
  async fn() {
    const s = await v2Studio();
    try {
      const phone = await pairPhone(s);
      s.pick.ready = false;
      let r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        text: 'Fix the login page',
        clientMessageId: 'phone-restart1',
      });
      assertEquals(r.status, 200, r.text);
      const id = r.json.id as string;
      // AIB restarts on the PC: the phone server's memory of this start is gone (and so is its waiter)
      s.ctx.phone.server!.newChats = new NewChats();
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${id}`);
      assertEquals(r.status, 404);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new/first', {
        id,
        text: 'Fix the login page',
        clientMessageId: 'phone-restart1',
      });
      assertEquals(r.status, 404, 'held messages go as normal messages now');
      // the chat becomes ready; the phone sends its first message as a normal one with the same id, twice (a retry): one arrives
      s.chats.find((c) => c.id === id)!.ready = true;
      for (let i = 0; i < 2; i++) {
        r = await phoneCall(s, phone.token, 'POST', '/api/remote/prompt', {
          id,
          text: 'Fix the login page',
          clientMessageId: 'phone-restart1',
        });
        assertEquals(r.status, 200, r.text);
      }
      const chat = s.chats.find((c) => c.id === id)!;
      assertEquals(chat.events.filter((e) => e.kind === 'user').length, 1, 'one first message');
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/chat?id=${id}`);
      assert(
        (r.json.events as Json[]).some((e) => e.kind === 'user' && (e.data as Json).clientMessageId === 'phone-restart1'),
        'the phone finds it by its id',
      );
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'review 2: Start sent again with the same id (the network dropped) is the same chat, never a second one; also two at once',
  async fn() {
    const s = await v2Studio();
    try {
      const phone = await pairPhone(s);
      const body = { project: s.projectId, agent: 'claude', text: 'Write the docs', clientMessageId: 'phone-drop1' };
      const a = await phoneCall(s, phone.token, 'POST', '/api/remote/new', body);
      const b = await phoneCall(s, phone.token, 'POST', '/api/remote/new', body);
      assertEquals([a.status, b.status], [200, 200]);
      assertEquals(b.json.id, a.json.id);
      assertEquals(b.json.existing, true);
      const both = await Promise.all([
        phoneCall(s, phone.token, 'POST', '/api/remote/new', { ...body, clientMessageId: 'phone-drop2' }),
        phoneCall(s, phone.token, 'POST', '/api/remote/new', { ...body, clientMessageId: 'phone-drop2' }),
      ]);
      assertEquals(both[0].json.id, both[1].json.id, 'two at once: one chat');
      assertEquals(s.liveCalls.filter(([n]) => n === 'connect').length, 2, 'two ids, two chats; never more');
      // another phone with the same id is its own start
      const other = await pairPhone(s, 'Other');
      const c = await phoneCall(s, other.token, 'POST', '/api/remote/new', body);
      assert(c.json.id !== a.json.id);
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'review 3: a PC rename saves only its chat (a phone rename the PC page has not read stays); the list answer gives names to an old copy',
  async fn() {
    const s = await v2Studio();
    try {
      s.chats.push(liveChat('c1', s.project), liveChat('c2', s.project));
      const phone = await pairPhone(s);
      const [, boot] = await pc(s, 'GET', '/api/live/list');
      const bootRevision = boot.chatNamesRevision as string;
      // the phone renames c1; the PC page, still on its boot copy, renames c2
      const r = await phoneCall(s, phone.token, 'POST', '/api/remote/rename', { key: 'claude:sess-c1', name: 'From the phone' });
      assertEquals(r.status, 200);
      const [status, out] = await pc(s, 'POST', '/api/live/chat-name', { key: 'claude:sess-c2', name: 'From the PC' });
      assertEquals(status, 200, JSON.stringify(out));
      assertEquals(s.ctx.viewPrefs.chatNames(), { 'claude:sess-c1': 'From the phone', 'claude:sess-c2': 'From the PC' });
      assertEquals(out.chatNames, s.ctx.viewPrefs.chatNames());
      // clearing one name keeps the other
      await pc(s, 'POST', '/api/live/chat-name', { key: 'claude:sess-c2', name: '' });
      assertEquals(s.ctx.viewPrefs.chatNames(), { 'claude:sess-c1': 'From the phone' });
      // the page's first list call sends the revision of what it started with: it gets the phone's name
      const [, list] = await pc(s, 'GET', `/api/live/list?names=${encodeURIComponent(bootRevision)}`);
      assertEquals((list.chatNames as Json)['claude:sess-c1'], 'From the phone');
      // chat.js computes the same revision as the server (namesRevisionOf): one known value
      await s.ctx.viewPrefs.update({ set: { 'studio-conversation-names': '{"claude:a":"A"}' } });
      const text = '{"claude:a":"A"}';
      assertEquals(s.ctx.viewPrefs.chatNamesRevision(), `${text.length}.${fnv(text)}`);
      for (const bad of [{ key: 'nope', name: 'x' }, { key: 'claude:x', name: 'x'.repeat(201) }, { key: 'claude:x' }]) {
        assertEquals((await pc(s, 'POST', '/api/live/chat-name', bad))[0], 400, JSON.stringify(bad));
      }
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

/** chat.js namesRevisionOf's hash (FNV-1a over UTF-16 code units), base 36. */
function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

Deno.test({
  ...OPTS,
  name: 'review 5: /new/options refuses an agent that is turned off or not installed, and never asks it for its lists',
  async fn() {
    const s = await v2Studio();
    try {
      setAgentRows(() => Promise.resolve([...AGENT_ROWS.filter((r) => r.id !== 'omp'), { id: 'omp', enabled: true, found: false }]));
      const phone = await pairPhone(s);
      for (const [agent, why] of [['codex', 'Turned off'], ['omp', 'Not installed'], ['kimi', 'Needs sign-in']]) {
        const r = await phoneCall(s, phone.token, 'GET', `/api/remote/new/options?project=${s.projectId}&agent=${agent}`);
        assertEquals(r.status, 403, agent);
        assertEquals(r.json.code, 'agent_unavailable');
        assert(String(r.json.error).includes(why), String(r.json.error));
      }
      assertEquals((await phoneCall(s, phone.token, 'GET', `/api/remote/new/options?project=${s.projectId}&agent=nobody`)).status, 400);
      assert(!s.liveCalls.some(([n]) => n === 'agent-options'), 'no agent was asked');
      const ok = await phoneCall(s, phone.token, 'GET', `/api/remote/new/options?project=${s.projectId}&agent=claude`);
      assertEquals(ok.status, 200);
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "review 6: a chat's Artifacts page lists its own live id only; another chat's id is refused",
  async fn() {
    const s = await v2Studio();
    try {
      s.chats.push(liveChat('c1', s.project), liveChat('c2', s.project));
      const phone = await pairPhone(s);
      const store = s.ctx.artifacts.store;
      store.create('claude:sess-c1', 'Mine', 'md', 'a.md', enc('# a'));
      store.create('c1', 'Mine, by live id', 'md', 'b.md', enc('# b'));
      store.create('c2', 'Not mine', 'md', 'c.md', enc('# c'));
      let r = await phoneCall(s, phone.token, 'GET', '/api/remote/artifacts?key=claude:sess-c1&id=c1');
      assertEquals(r.status, 200);
      assertEquals((r.json.artifacts as Json[]).map((a) => a.title).sort(), ['Mine', 'Mine, by live id']);
      r = await phoneCall(s, phone.token, 'GET', '/api/remote/artifacts?key=claude:sess-c1&id=c2');
      assertEquals(r.status, 400, 'another chat’s live id');
      assert(!r.text.includes('Not mine'));
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'review 7: Undo is only the inverse of this phone’s own archive or delete, and only while the PC has not changed the chat since',
  async fn() {
    const s = await v2Studio();
    try {
      s.chats.push(liveChat('c1', s.project));
      s.saveChat({ sessionId: 'old-1', prompt: 'Old work' });
      s.saveChat({ sessionId: 'old-2', prompt: 'More work' });
      const phone = await pairPhone(s);
      const later = () => new Promise((res) => setTimeout(res, 20));
      const op = (key: string, o: string, extra: Json = {}) =>
        phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key, op: o, ...extra });
      // archived from the phone: "restore" is not its Undo
      assertEquals((await op('claude:sess-c1', 'archive', { end: false })).status, 200);
      let r = await op('claude:sess-c1', 'restore');
      assertEquals(r.status, 409, r.text);
      assertEquals(r.json.code, 'not_undo');
      // the PC brings it back and archives it again itself: the phone's Undo (unarchive) is not for this archive
      await later();
      await pc(s, 'POST', '/api/live/conversation-state', { action: 'unarchive', provider: 'claude', sessionId: 'sess-c1' });
      await pc(s, 'POST', '/api/live/conversation-state', { action: 'archive', provider: 'claude', sessionId: 'sess-c1' });
      r = await op('claude:sess-c1', 'unarchive');
      assertEquals(r.status, 409, r.text);
      assertEquals(r.json.code, 'changed');
      assert(entries(s)['claude:sess-c1']?.archivedAt, 'still archived (as the PC left it)');
      // deleted from the phone, then the PC restores and deletes it again: the phone's Undo is refused
      assertEquals((await op('claude:old-1', 'delete')).status, 200);
      await later();
      await pc(s, 'POST', '/api/live/conversation-state', { action: 'restore', provider: 'claude', sessionId: 'old-1' });
      await pc(s, 'POST', '/api/live/conversation-state', { action: 'delete', provider: 'claude', sessionId: 'old-1' });
      r = await op('claude:old-1', 'restore');
      assertEquals(r.status, 409, r.text);
      assert(entries(s)['claude:old-1']?.deletedAt, 'still deleted');
      // untouched since: Undo works
      assertEquals((await op('claude:old-2', 'delete')).status, 200);
      r = await op('claude:old-2', 'restore');
      assertEquals(r.status, 200, r.text);
      assert(!entries(s)['claude:old-2']?.deletedAt);
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'review 8: no folder path or agent host words in what a phone sees when a new chat cannot start or its first message fails',
  async fn() {
    const s = await v2Studio();
    try {
      const phone = await pairPhone(s);
      const secret = 'C:\\Users\\owner\\Secret Project\\agent.exe';
      s.pick.connectError = `spawn ${secret} ENOENT`;
      let r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        text: 'x',
        clientMessageId: 'phone-p1',
      });
      assert(r.status >= 400);
      assert(!r.text.includes('Secret Project') && !r.text.includes('ENOENT'), r.text);
      assert(String(r.json.error).includes('could not be started'), r.text);
      s.pick.connectError = '';
      s.pick.promptError = `${secret}: broken pipe`;
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        text: 'x',
        clientMessageId: 'phone-p2',
      });
      const id = r.json.id as string;
      await until(async () => (await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${id}`)).json.state === 'failed', 'failed');
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${id}`);
      assert(!r.text.includes('Secret Project') && !r.text.includes('broken pipe'), r.text);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new/first', { id, text: 'x', clientMessageId: 'phone-p2' });
      assert(!r.text.includes('Secret Project'), r.text);
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'review 9: a saved model and mode with no agent go when the default agent changes to another than the global default',
  async fn() {
    const s = await v2Studio();
    try {
      const key = folderKeyOf(s.project);
      const get = () =>
        Object.fromEntries(
          Object.entries(((((s.ctx.settings.public().settings as Json).defaults as Json).projects as Json)[key] ?? {}) as Json)
            .filter(([, v]) => v !== ''),
        );
      await s.ctx.settings.update({ defaults: { agent: 'claude', projects: { [key]: { model: 'opus', mode: 'plan' } } } });
      await s.ctx.settings.update({ defaults: { projects: { [key]: { agent: 'claude' } } } });
      assertEquals(get(), { agent: 'claude', model: 'opus', mode: 'plan' }, 'the global default agent: they were its');
      await s.ctx.settings.update({ defaults: { projects: { [key]: null } } });
      await s.ctx.settings.update({ defaults: { projects: { [key]: { model: 'opus', mode: 'plan' } } } });
      await s.ctx.settings.update({ defaults: { projects: { [key]: { agent: 'codex' } } } });
      assertEquals(get(), { agent: 'codex' }, 'another agent: cleared');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'review 10: Start new chats turned off while the chat opens: the first message does not go',
  async fn() {
    const s = await v2Studio();
    try {
      const phone = await pairPhone(s);
      s.pick.ready = false;
      const r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        text: 'Deploy it',
        clientMessageId: 'phone-off1',
      });
      const id = r.json.id as string;
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.prompt'] });
      s.chats.find((c) => c.id === id)!.ready = true;
      await until(() => s.ctx.phone.server!.newChats.job(phone.id, id)?.state !== 'opening', 'the waiter decided');
      assertEquals(s.ctx.phone.server!.newChats.job(phone.id, id)?.state, 'failed');
      assert(!s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === id), 'not sent');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "review 11: the phone's unread dots count from the PC page's epoch (studio-sidebar-epoch), as the PC's do",
  async fn() {
    const s = await v2Studio();
    try {
      // finished an hour ago (before this process started), never read; the PC page first ran two hours ago: unread there
      s.chats.push(
        liveChat('c1', s.project, {
          attention: { state: 'idle', needs: 0, turnEndedAt: new Date(Date.now() - 3600_000).toISOString(), busySince: null },
        }),
      );
      await s.ctx.viewPrefs.update({ set: { 'studio-sidebar-epoch': String(Date.now() - 7200_000) } });
      const phone = await pairPhone(s);
      const r = await phoneCall(s, phone.token, 'GET', '/api/remote/home');
      assertEquals((r.json.chats as Json[]).find((c) => c.id === 'c1')!.unread, true);
      // a PC that first ran after it finished: read, on both
      await s.ctx.viewPrefs.update({ set: { 'studio-sidebar-epoch': String(Date.now() - 60_000) } });
      const r2 = await phoneCall(s, phone.token, 'GET', '/api/remote/home');
      assertEquals((r2.json.chats as Json[]).find((c) => c.id === 'c1')!.unread, false);
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'review 12: deleting a running chat whose session ends slowly says "delete it again"; once it ended, Delete goes through',
  async fn() {
    const s = await v2Studio();
    const wait = RemoteServer.END_WAIT_MS;
    try {
      RemoteServer.END_WAIT_MS = 300;
      s.chats.push(liveChat('c1', s.project));
      s.saveChat({ sessionId: 'sess-c1', prompt: 'Its transcript' }); // listed as not running once its session ended
      const phone = await pairPhone(s);
      s.pick.endMs = 1500;
      let r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'delete' });
      assertEquals(r.status, 409, r.text);
      assertEquals(r.json.code, 'ending');
      assert(String(r.json.error).includes('delete it again'), r.text);
      await until(() => s.chats[0].closed, 'the session ended', 5000);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'delete' });
      assertEquals(r.status, 200, r.text);
      assert(Number(entries(s)['claude:sess-c1']?.deletedAt) > 0);
    } finally {
      RemoteServer.END_WAIT_MS = wait;
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "review 13: nothing saved: the lists' default is '' (the agent's own is `current`); a pick not on the list is refused",
  async fn() {
    const s = await v2Studio();
    try {
      const phone = await pairPhone(s);
      let r = await phoneCall(s, phone.token, 'GET', `/api/remote/new/options?project=${s.projectId}&agent=claude`);
      assertEquals([(r.json.model as Json).default, (r.json.model as Json).current], ['', 'sonnet']);
      assertEquals([(r.json.mode as Json).default, (r.json.mode as Json).current], ['', 'default']);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        model: 'gpt-9',
        text: 'x',
        clientMessageId: 'phone-m1',
      });
      assertEquals(r.status, 400, r.text);
      assert(String(r.json.error).includes('does not offer that model'), r.text);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        mode: 'yolo',
        text: 'x',
        clientMessageId: 'phone-m2',
      });
      assertEquals(r.status, 400, r.text);
      assert(!s.liveCalls.some(([n]) => n === 'connect'), 'nothing started');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});
