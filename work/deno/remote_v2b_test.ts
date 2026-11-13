/**
 * Phone UI v2 part 2, server side (in-process Studio, fake agent host, forged Serve headers):
 *  - "Start new chats": a child of Send, on for phones paired before it (missing = on), off with Send; refused without it;
 *  - New chat: options (projects with no paths, agents with reasons), the model/mode lists with defaults, start with the picks for
 *    this chat only, the project's default agent updated (and the old agent's model and mode cleared), an agent that cannot start
 *    refused, the first message sent once ready, held (text kept) when the mode could not be set, said when the model could not;
 *  - the card menu: rename shared with the PC (home, saved list, the PC's list answer), mark unread / read (the PC's unread dot),
 *    Mark handled, archive keep / end (end needs Send), delete (a running one needs Send: refused, else ends it first), Undo;
 *  - a chat's artifacts (phone shape: no links, no paths), the viewer's versions, an unknown version 404;
 *  - the PC's theme in bootstrap and home (the revision changes); 8000 emoji fit the body limit;
 *  - the contract gate: every REMOTE_ROUTES entry needs a paired phone with its switch, swept automatically;
 *  - one activity line per action, never the message text or the name.
 */
import { assert, assertEquals } from './_assert.ts';
import { DEVICE_HEADER, MAX_BODY, REMOTE_ROUTES, ROUTE_SCOPE } from '../../outputs/agent-studio/server/remote/server.ts';
import { setAgentRows } from '../../outputs/agent-studio/server/remote/newchat.ts';
import { DeviceStore } from '../../outputs/agent-studio/server/remote/devices.ts';
import { NAME, pairPhone, pc, phoneHeaders, raw } from './_remote_fixture.ts';
import { liveChat, phoneCall, v2Studio } from './_remote_v2b.ts';

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

Deno.test({
  ...OPTS,
  name: 'Start new chats: a child of Send, on for phones paired before it (missing = on), off with Send; its routes refused without it',
  async fn() {
    const s = await v2Studio();
    try {
      const phone = await pairPhone(s);
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      const row = ((view.devices ?? view.phones) as Json[]).find((d) => d.id === phone.id)!;
      assert((row.scopes as string[]).includes('phone.start'), 'on by default');
      assertEquals(row.start, true);
      // a phone paired before the switch existed (its saved record has no phone.start): on, because Send is on
      const file = `${s.state}/devices.json`;
      const doc = JSON.parse(Deno.readTextFileSync(file));
      for (const d of doc.devices) d.scopes = (d.scopes as string[]).filter((x) => x !== 'phone.start');
      Deno.writeTextFileSync(file, JSON.stringify(doc));
      assert(new DeviceStore(s.state).byId(phone.id)!.scopes.includes('phone.start'), 'missing = on');
      // Send off: Start goes with it (and its own setting is kept for when Send comes back)
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.start'] });
      let r = await phoneCall(s, phone.token, 'GET', '/api/remote/new/options');
      assertEquals(r.status, 403);
      assert(r.text.includes('start new chats'), r.text);
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.prompt', 'phone.start'] });
      r = await phoneCall(s, phone.token, 'GET', '/api/remote/new/options');
      assertEquals(r.status, 200);
      // Start off on its own; Send off and on again: Start stays off
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.prompt'] });
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read'] });
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.prompt'] });
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        text: 'hi',
        clientMessageId: 'm1',
      });
      assertEquals(r.status, 403);
      assert(s.ctx.phone.audit.tail(500).some((e) => e.action === 'new chat' && e.result === 'refused: switched off'));
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'New chat: options (no paths), lists with defaults, picks for this chat only, project default agent (old model/mode cleared), ineligible refused, first message sent / held / said',
  async fn() {
    const s = await v2Studio();
    try {
      const phone = await pairPhone(s);
      // the project's saved default: Codex with a model and mode (they belong to Codex)
      await s.ctx.settings.update({
        defaults: { projects: { [folderKeyOf(s.project)]: { agent: 'claude', model: 'opus', mode: 'default' } } },
      });
      let r = await phoneCall(s, phone.token, 'GET', '/api/remote/new/options');
      assertEquals(r.status, 200);
      const projects = r.json.projects as Json[];
      assertEquals(projects.map((p) => p.id), [s.projectId]);
      assertEquals(projects[0].agent, 'claude');
      assert(!r.text.includes(s.project.replaceAll('\\', '\\\\')) && !r.text.includes('projects\\\\shop'), 'no folder path');
      const agents = r.json.agents as Json[];
      assertEquals(agents.map((a) => [a.id, a.ok]), [['omp', true], ['claude', true], ['codex', false], ['kimi', false]]);
      assertEquals(agents.find((a) => a.id === 'codex')!.why, 'Turned off in Settings on your PC.');
      assertEquals(agents.find((a) => a.id === 'kimi')!.why, 'Needs sign-in. Sign in on your PC.');
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new/options?project=${s.projectId}&agent=claude`);
      assertEquals(r.status, 200);
      assertEquals((r.json.model as Json).default, 'opus', 'the project default');
      assertEquals((r.json.mode as Json).default, 'default');
      assertEquals(((r.json.mode as Json).choices as Json[]).map((c) => c.name), ['Ask before edits', 'Bypass permissions'], 'every mode');

      // an agent that cannot start: refused before anything starts
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'kimi',
        text: 'hi',
        clientMessageId: 'k1',
      });
      assertEquals(r.status, 403);
      assertEquals(r.json.code, 'agent_unavailable');
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'omp',
        text: '/doc x',
        clientMessageId: 'k2',
      });
      assertEquals(r.status, 403);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: 'ffffffffffff',
        agent: 'omp',
        text: 'x',
        clientMessageId: 'k3',
      });
      assertEquals(r.status, 404);
      assert(!s.liveCalls.some(([n]) => n === 'connect'), 'nothing started');

      // OMP with Bypass permissions: picks go with connect; the first message goes once it is ready
      const secret = 'Please refactor the payment step 🙂';
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'omp',
        model: 'opus',
        mode: 'bypassPermissions',
        text: secret,
        clientMessageId: 'first-1',
      });
      assertEquals(r.status, 200, r.text);
      const id = r.json.id as string;
      const connect = s.liveCalls.find(([n]) => n === 'connect')![1];
      assertEquals(connect, {
        provider: 'omp',
        cwd: s.project,
        resume: '',
        background: true,
        picks: { model: 'opus', mode: 'bypassPermissions' },
      });
      await until(() => s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === id), 'the first message');
      assertEquals(s.liveCalls.find(([n]) => n === 'prompt')![1], { id, text: secret, clientMessageId: 'first-1' });
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${id}`);
      assertEquals(r.json.state, 'sent');
      // the project's default agent is now OMP; Claude's model and mode went with it; the global defaults did not change
      const defaults = (s.ctx.settings.public().settings as Json).defaults as Json;
      assertEquals(clean((defaults.projects as Json)[folderKeyOf(s.project)]), { agent: 'omp' });
      assertEquals(defaults.byAgent, {});
      // another phone cannot read this phone's new chat
      const other = await pairPhone(s, 'Other');
      assertEquals((await phoneCall(s, other.token, 'GET', `/api/remote/new?id=${id}`)).status, 404);

      // the mode could not be set: the message is held, the phone keeps the text; a retry through /new/first sends it
      s.pick.results = [{ kind: 'mode', value: 'bypassPermissions', ok: false, message: 'Not allowed here' }];
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        mode: 'bypassPermissions',
        text: 'held one',
        clientMessageId: 'first-2',
      });
      const held = r.json.id as string;
      await until(async () => (await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${held}`)).json.state === 'held', 'held');
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${held}`);
      assert(String(r.json.error).includes('Bypass permissions: Not allowed here'), String(r.json.error));
      assert(!s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === held), 'not sent');
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new/first', { id: held, text: 'held one', clientMessageId: 'first-2' });
      assertEquals(r.status, 200, r.text);
      assert(s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === held && b.clientMessageId === 'first-2'));

      // the model could not be set: said, and the message goes (as on the PC)
      s.pick.results = [{ kind: 'model', value: 'opus', ok: false, message: 'Gone' }];
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        model: 'opus',
        text: 'go',
        clientMessageId: 'first-3',
      });
      const warned = r.json.id as string;
      await until(async () => (await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${warned}`)).json.state === 'sent', 'sent');
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${warned}`);
      assert(String(r.json.warning).includes('the model Opus: Gone'), String(r.json.warning));

      const log = JSON.stringify(s.ctx.phone.audit.tail(500));
      assert(log.includes('started on the PC with OMP'), log);
      assert(!log.includes(secret) && !log.includes('held one'), 'no message text in the activity log');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

/** A saved choice without its empty fields. */
function clean(v: unknown): Json {
  return Object.fromEntries(Object.entries((v ?? {}) as Json).filter(([, x]) => x !== ''));
}

function folderKeyOf(p: string): string {
  return 'w:' + p.replaceAll('\\', '/').toLowerCase();
}

Deno.test({
  ...OPTS,
  name: 'settings: a project default agent that changes clears the old agent’s model and mode (PC and phone); naming them keeps them',
  async fn() {
    const s = await v2Studio();
    try {
      const key = folderKeyOf(s.project);
      await s.ctx.settings.update({ defaults: { projects: { [key]: { agent: 'claude', model: 'opus', mode: 'plan' } } } });
      await s.ctx.settings.update({ defaults: { projects: { [key]: { agent: 'claude' } } } });
      const get = () => clean((((s.ctx.settings.public().settings as Json).defaults as Json).projects as Json)[key]);
      assertEquals(get(), { agent: 'claude', model: 'opus', mode: 'plan' }, 'same agent: kept');
      await s.ctx.settings.update({ defaults: { projects: { [key]: { agent: 'codex' } } } });
      assertEquals(get(), { agent: 'codex' });
      await s.ctx.settings.update({ defaults: { projects: { [key]: { agent: 'claude', model: 'sonnet' } } } });
      assertEquals(get(), { agent: 'claude', model: 'sonnet' });
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'card menu: rename shared with the PC, mark unread / read, handled, archive keep / end (end needs Send), delete (running needs Send), Undo',
  async fn() {
    const s = await v2Studio();
    try {
      s.chats.push(liveChat('c1', s.project, { attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null } }));
      s.saveChat({ sessionId: 'old-1', prompt: 'Old work' });
      const phone = await pairPhone(s);
      const home = async () => (await phoneCall(s, phone.token, 'GET', '/api/remote/home')).json;
      const card = async () => (((await home()).chats as Json[]).find((c) => c.id === 'c1'))!;
      assertEquals((await card()).key, 'claude:sess-c1');

      // rename: the phone, the PC's list answer and the saved list all use the one name
      const [, list0] = await pc(s, 'GET', '/api/live/list?names=x');
      let r = await phoneCall(s, phone.token, 'POST', '/api/remote/rename', { key: 'claude:sess-c1', name: 'Checkout redesign' });
      assertEquals(r.status, 200, r.text);
      assertEquals((await card()).title, 'Checkout redesign');
      const [, list1] = await pc(s, 'GET', `/api/live/list?names=${list0.chatNamesRevision}`);
      assertEquals((list1.chatNames as Json)['claude:sess-c1'], 'Checkout redesign');
      const [, list2] = await pc(s, 'GET', `/api/live/list?names=${list1.chatNamesRevision}`);
      assertEquals(list2.chatNames, undefined, 'only when the page has an old copy');
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/rename', { key: 'claude:old-1', name: 'Saved renamed' });
      assertEquals(r.status, 200);
      assert(((await home()).saved as Json[]).some((c) => c.title === 'Saved renamed'));
      // a PC rename of another chat (the whole value) keeps the phone's names when the page merged them
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/rename', { key: 'nope:x', name: 'x' });
      assertEquals(r.status, 404);

      // mark unread: the PC's read state and the phone's dot; mark read clears it
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/mark', { key: 'claude:sess-c1', read: false });
      assertEquals(r.status, 200);
      assert(s.ctx.readState.public().chats['claude:sess-c1'].markedUnreadAt! > 0);
      assertEquals((await card()).unread, true);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/mark', { key: 'claude:sess-c1', read: true });
      assertEquals((await card()).unread, false);
      // a read position from the PC page passes it too
      await phoneCall(s, phone.token, 'POST', '/api/remote/mark', { key: 'claude:sess-c1', read: false });
      await s.ctx.readState.update({ set: { 'claude:sess-c1': { seenAt: Date.now() + 1000 } } });
      assertEquals(s.ctx.readState.public().chats['claude:sess-c1'].markedUnreadAt, undefined);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/mark', { key: 'claude:old-1', read: false });
      assertEquals(r.status, 409, 'not running: no read / unread');

      // Mark handled
      await pc(s, 'POST', '/api/live/conversation-state', { action: 'your_turn', provider: 'claude', sessionId: 'sess-c1' });
      assertEquals((await card()).yourTurn, true);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'handled' });
      assertEquals(r.status, 200, r.text);
      assertEquals((await card()).yourTurn, false);

      // Send off: archive keeps it running, ending it and deleting a running chat are refused
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read'] });
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'archive', end: true });
      assertEquals(r.status, 403);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'delete' });
      assertEquals(r.status, 403);
      assert(String(r.json.error).includes('Send messages, stop turns and continue chats'));
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'archive', end: false });
      assertEquals(r.status, 200, r.text);
      assert(!s.chats[0].closed, 'kept running');
      assert(!((await home()).chats as Json[]).some((c) => c.id === 'c1'), 'archived: hidden on the phone');
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'unarchive' });
      assertEquals(r.status, 200, r.text);
      assert(((await home()).chats as Json[]).some((c) => c.id === 'c1'), 'Undo');

      // Send on: delete ends the session first, then Undo restores it (not running)
      await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read', 'phone.prompt'] });
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'delete' });
      assertEquals(r.status, 200, r.text);
      assert(s.liveCalls.some(([n, b]) => n === 'disconnect' && b.id === 'c1'));
      assert(Number((s.ctx.conversations.public().entries as unknown as Record<string, Json>)['claude:sess-c1'].deletedAt) > 0);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/chat-op', { key: 'claude:sess-c1', op: 'restore' });
      assertEquals(r.status, 200, r.text);
      assert(!(s.ctx.conversations.public().entries as unknown as Record<string, Json>)['claude:sess-c1']?.deletedAt);
      // Undo only for what this phone did lately
      const other = await pairPhone(s, 'Other');
      r = await phoneCall(s, other.token, 'POST', '/api/remote/chat-op', { key: 'claude:old-1', op: 'restore' });
      assertEquals(r.status, 404);

      const log = s.ctx.phone.audit.tail(500).map((e) => `${e.action}: ${e.result}`);
      for (
        const want of [
          'rename: renamed',
          'mark: marked unread',
          'mark: marked read',
          'chat menu: marked handled',
          'chat menu: archived, kept running',
          'chat menu: session ended, deleted',
          'chat menu: restored (undo)',
        ]
      ) {
        assert(log.includes(want), `${want} in ${log.join(' | ')}`);
      }
      assert(!JSON.stringify(s.ctx.phone.audit.tail(500)).includes('Checkout redesign'), 'no names in the log');
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    "a chat's artifacts (phone shape), the viewer's versions, an unknown version 404; the PC theme in bootstrap and home; 8000 emoji fit",
  async fn() {
    const s = await v2Studio();
    try {
      s.chats.push(liveChat('c1', s.project));
      const phone = await pairPhone(s);
      const store = s.ctx.artifacts.store;
      const a = store.create('claude:sess-c1', 'Checkout flow', 'html', 'flow.html', enc('<p>1</p>'));
      store.addVersion(a.id, enc('<p>2</p>'));
      store.addVersion(a.id, enc('<p>3</p>'));
      store.create('claude:other', 'Not mine', 'md', 'x.md', enc('# x'));
      let r = await phoneCall(s, phone.token, 'GET', '/api/remote/artifacts?key=claude:sess-c1&id=c1');
      assertEquals(r.status, 200, r.text);
      const items = r.json.artifacts as Json[];
      assertEquals(items.map((x) => [x.title, x.version, x.versions]), [['Checkout flow', 3, 3]]);
      assertEquals(Object.keys(items[0]).sort(), ['archived', 'id', 'kind', 'pinned', 'title', 'updatedAt', 'version', 'versions']);
      assert(!r.text.includes('127.0.0.1') && !r.text.includes('flow.html'), 'no loopback links, no paths');
      assertEquals((await phoneCall(s, phone.token, 'GET', '/api/remote/artifacts?key=claude:nope')).status, 404);
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/artifact?id=${a.id}&v=1`);
      assertEquals(r.status, 200);
      assertEquals(r.json.version, 1);
      assertEquals(r.json.latest, 3);
      assertEquals((r.json.versions as Json[]).map((v) => [v.n, v.latest]), [[3, true], [2, false], [1, false]]);
      assertEquals((await phoneCall(s, phone.token, 'GET', `/api/remote/artifact?id=${a.id}&v=9`)).status, 404, 'unknown version');
      // home polls never carry artifact counts
      assert(!(await phoneCall(s, phone.token, 'GET', '/api/remote/home')).text.includes('Checkout flow'));

      // the PC's theme: bootstrap and home; a change changes home's revision
      r = await phoneCall(s, phone.token, 'GET', '/api/remote/bootstrap');
      assertEquals([r.json.pcTheme, r.json.pcSymbols], ['teal-dark', false]);
      const h1 = await phoneCall(s, phone.token, 'GET', '/api/remote/home');
      await s.ctx.viewPrefs.update({ set: { 'aib-theme': 'hc-light', 'aib-status-glyphs': 'on' } });
      const h2 = await phoneCall(s, phone.token, 'GET', `/api/remote/home?rev=${h1.json.revision}`);
      assertEquals(h2.status, 200);
      assertEquals([h2.json.pcTheme, h2.json.pcSymbols], ['hc-light', true]);

      // 8000 characters of emoji (4000 of them), with surrogates escaped as some phones send them
      const text = '😀'.repeat(4000);
      const body = JSON.stringify({ id: 'c1', text, clientMessageId: 'big' }).replace(
        /[\ud800-\udfff]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16),
      );
      assert(new TextEncoder().encode(body).byteLength > 16 * 1024 && new TextEncoder().encode(body).byteLength <= MAX_BODY);
      r = await raw(s.phonePort(), 'POST', '/api/remote/prompt', phoneHeaders({ [DEVICE_HEADER]: phone.token }, 'POST'), body);
      assertEquals(r.status, 200, r.text);
      assert(s.liveCalls.some(([n, b]) => n === 'prompt' && b.text === text));
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'contract gate: every REMOTE_ROUTES entry past the page files, bootstrap and pairing needs a paired phone with its switch',
  async fn() {
    const s = await v2Studio();
    try {
      const open = new Set(['static', 'bootstrap', 'pair']);
      const gated = REMOTE_ROUTES.filter(([, , auth]) => !open.has(auth));
      assert(gated.length >= 30);
      const phone = await pairPhone(s);
      for (const [method, path, auth] of gated) {
        const scope = ROUTE_SCOPE[`${method} ${path}`];
        assert(scope, `${method} ${path} has a scope`);
        const body = method === 'POST' ? '{}' : undefined;
        // not addressed to the tailnet name: refused
        let r = await raw(s.phonePort(), method, path, phoneHeaders({ Host: '127.0.0.1', [DEVICE_HEADER]: phone.token }, method), body);
        assert(r.status === 403 || r.status === 421 || r.status === 400, `${method} ${path} wrong Host -> ${r.status}`);
        // no device token (the image route takes the cookie): not paired
        r = await raw(s.phonePort(), method, path, phoneHeaders({}, method), body);
        assert(r.status === 401 || r.status === 403, `${method} ${path} without a phone -> ${r.status}`);
        // the switch off (See chats cannot be turned off; those routes are checked by the two above)
        if (scope !== 'phone.read' && auth !== 'image') {
          await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes: ['phone.read'] });
          r = await raw(s.phonePort(), method, path, phoneHeaders({ [DEVICE_HEADER]: phone.token }, method), body);
          if (path !== '/api/remote/push/unsubscribe') assertEquals(r.status, 403, `${method} ${path} switched off`);
          await pc(s, 'POST', '/api/live/devices/scopes', {
            id: phone.id,
            scopes: ['phone.read', 'phone.answer', 'phone.prompt', 'phone.start', 'phone.approve', 'phone.push'],
          });
        }
      }
      assertEquals(NAME.length > 0, true);
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});
