/**
 * Helper chats in the lists, their names and their approvals (owner decision 2026-11-23), on the server side, in-process with a fake
 * agent host:
 *  - a helper chat is left out of the phone's chat list and its saved list (every state: working, done, merged), and the paired PC's
 *    page reads the same lists; /api/live/swarm marks it `hidden` (registry.ts hiddenFromLists, the one predicate) and carries its
 *    open requests (`waits`) so the main chat and Activity can answer them;
 *  - the chat is named "<title> (<agent>)" once; an owner's own name is never replaced;
 *  - a helper that waits on an approval is an inbox row, its desktop toast has Allow / Deny (a click answers the helper's own chat),
 *    and the phone's inbox card has Allow; answered anywhere, every surface clears.
 * The page's side (left list, search, Activity buttons, the main chat's card) is work/deno/swarm_approvals_e2e_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath } from './_doc_browser.ts';
import { pairPhone, pc } from './_remote_fixture.ts';
import { liveChat, v2Aib } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';
import { homePayload } from '../../app/server/remote/payloads.ts';
import { SavedChats } from '../../app/server/remote/saved.ts';
import { Registry, hiddenChats, hiddenFromLists, readHelpers } from '../../app/server/swarm/registry.ts';
import { DesktopNotifications, type NotifyTarget, type OsNotify } from '../../app/server/desktop/notify.ts';
import { type SpawnToastHelper, toastTag } from '../../app/server/desktop/toast.ts';
import { startWindowsToasts } from '../../app/server/desktop/toast_act.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const ONCE = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];
const needs = { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null };
const perm = (key: string, command: string) => [{ key, params: { toolCall: { toolCallId: `tc-${key}`, title: 'Bash', rawInput: { command } }, options: ONCE } }];
const buttons = (xml: string) => [...xml.matchAll(/<action content="([^"]*)" arguments="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]);

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const record = (id: string, title: string, chat: { id: string; sessionId: string; provider: string }, parent: { id: string; sessionId: string }, state: string, label = ''): never =>
  (<never> {
    id,
    title,
    project: '/code/shop',
    parent: { live: parent.id, lasting: `claude:${parent.sessionId}` },
    chat: { live: chat.id, lasting: `${chat.provider}:${chat.sessionId}`, provider: chat.provider, model: '', mode: 'auto', ...(label ? { label } : {}) },
    brief: { goal: 'g', owns: [`${id}/`], avoid: [], done_when: 'd', reply_with: 'r', test_cmd: 'none', read_only: false, context_files: [] },
    picked_by: 'rule',
    rule: 'tests',
    why: '',
    worktree: { path: '', branch: `studio/helper-${id}`, base: 'main', start: '' },
    state,
    reason: '',
    createdAt: Date.now() / 1000 - 300,
    turnEndedAt: 'x', // scripted chats: never reported by the swarm watcher
    cursor: 0,
    reports: [],
    merge: null,
    notes: [],
  });

Deno.test({
  ...OPTS,
  name: 'swarm lists: a helper chat is not in the phone list or the saved list; it is named once, an owner name wins; /api/live/swarm carries its request',
  async fn() {
    const s = await v2Aib();
    try {
      const main = liveChat('c-main', s.project, { breadth: { sessionInfo: { title: 'Lead chat' } } });
      const helper = liveChat('c-help', s.project, {
        provider: 'codex',
        breadth: { sessionInfo: { title: 'New conversation' } },
        attention: { ...needs },
        permissions: perm('p1', 'npm test'),
      });
      const renamed = liveChat('c-own', s.project, { provider: 'codex', breadth: { sessionInfo: { title: 'New conversation' } } });
      const done = liveChat('c-done', s.project, { provider: 'codex', breadth: { sessionInfo: { title: 'New conversation' } } });
      s.chats.push(main, helper, renamed, done);
      s.saveChat({ sessionId: 'sess-saved-help', prompt: 'helper work' });
      s.saveChat({ sessionId: 'sess-saved-plain', prompt: 'plain work' });
      await s.ctx.viewPrefs.setChatName('codex:sess-c-own', 'My own name');
      const reg = new Registry(s.state);
      await reg.update('h_one00001', () => record('h_one00001', 'Fix Use-with list layout', helper, main, 'waiting', ''));
      await reg.update('h_own00001', () => record('h_own00001', 'Login bug', renamed, main, 'working'));
      await reg.update('h_don00001', () => record('h_don00001', 'Old migration', done, main, 'merged', 'Claude Code · strata'));
      await reg.update('h_sav00001', () =>
        record('h_sav00001', 'Saved job', { id: 'gone', sessionId: 'sess-saved-help', provider: 'claude' }, main, 'done'));

      // the predicate: a helper chat is hidden in every state; a subagent's landing entry has no chat to hide
      const all = readHelpers(s.state);
      assert(Object.values(all).every((h) => hiddenFromLists(h)), 'every helper chat is left out of the lists, whatever its state');
      assert(!hiddenFromLists({ ...all['h_one00001'], kind: 'subagent' }), 'a subagent entry has no chat of its own');
      assert(hiddenChats(all).lasting.has('codex:sess-c-done'));

      // the phone's list: the lead chat, never a helper (inbox rows still carry a waiting helper: below)
      const home = await homePayload(s.ctx, 'pc', s.ctx.phone.titles);
      assertEquals(home.chats.map((c) => c.id), ['c-main']);
      const saved = (await new SavedChats().list(s.ctx, true)).map((c) => c.key);
      assert(saved.includes('claude:sess-saved-plain'), `a plain saved chat is listed: ${saved}`);
      assert(!saved.includes('claude:sess-saved-help'), `a saved helper chat is not: ${saved}`);

      // the route: hidden, the request, and the name
      const [status, list] = await pc(s, 'GET', '/api/live/swarm');
      assertEquals(status, 200);
      const rows = list.helpers as Json[];
      const one = rows.find((h) => h.id === 'h_one00001')!;
      assertEquals(one.hidden, true);
      assertEquals(((one.waits as Json).permissions as Json[]).map((p) => p.key), ['p1']);
      assert(!('waits' in rows.find((h) => h.id === 'h_own00001')!), 'a helper that waits on nothing carries no request');
      await until('the helper chats named', () => s.ctx.viewPrefs.chatNames()['codex:sess-c-help'] !== undefined && s.ctx.viewPrefs.chatNames()['codex:sess-c-done'] !== undefined);
      const names = s.ctx.viewPrefs.chatNames();
      assertEquals(names['codex:sess-c-help'], 'Fix Use-with list layout (Codex)');
      assertEquals(names['codex:sess-c-done'], 'Old migration (Claude Code · strata)');
      assertEquals(names['codex:sess-c-own'], 'My own name', "the owner's name wins");
      await until('the owner-named helper marked done', () => readHelpers(s.state)['h_own00001']?.named === true);
      // an owner's rename after the helper was named is kept (the name is written once)
      await s.ctx.viewPrefs.setChatName('codex:sess-c-help', 'Renamed by me');
      await new Promise((r) => setTimeout(r, 2500));
      assertEquals(s.ctx.viewPrefs.chatNames()['codex:sess-c-help'], 'Renamed by me');
      // the phone and the inbox use the chat names
      await s.ctx.viewPrefs.setChatName('codex:sess-c-help', 'Fix Use-with list layout (Codex)');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'swarm approvals: a waiting helper is an inbox row; its toast has Allow / Deny and answers the helper; answered, every surface clears',
  async fn() {
    const s = await v2Aib();
    const dir = await Deno.makeTempDir({ prefix: 'aib-swarm-toast-' });
    let stop = () => {};
    try {
      const main = liveChat('c-main', s.project, { breadth: { sessionInfo: { title: 'Lead chat' } } });
      const helper = liveChat('c-help', s.project, {
        provider: 'codex',
        breadth: { sessionInfo: { title: 'New conversation' } },
        attention: { ...needs },
        permissions: perm('p1', 'npm test'),
      });
      const risky = liveChat('c-risk', s.project, {
        provider: 'codex',
        breadth: { sessionInfo: { title: 'New conversation' } },
        attention: { ...needs },
        permissions: perm('p2', 'git push origin main'),
      });
      s.chats.push(main, helper, risky);
      await s.ctx.viewPrefs.setChatName('codex:sess-c-help', 'Fix Use-with list layout (Codex)');
      await s.ctx.viewPrefs.setChatName('codex:sess-c-risk', 'Release (Codex)');
      const reg = new Registry(s.state);
      await reg.update('h_one00001', () => record('h_one00001', 'Fix Use-with list layout', helper, main, 'waiting'));
      await reg.update('h_two00001', () => record('h_two00001', 'Release', risky, main, 'waiting'));
      const calls: [string, Json][] = [];
      s.answerLive((name, body) => {
        calls.push([name, body]);
        if (name === 'permission') {
          const c = s.chats.find((x) => x.id === body.id);
          if (c) {
            c.permissions = [];
            c.attention = { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() };
            c.busy = true;
          }
        }
        return [200, { ok: true }];
      });

      // the inbox: the helper's request is a row of the helper's chat, named by its job (not "New conversation")
      const inbox = await s.ctx.inbox.look();
      const row = inbox.rows.find((r) => r.id === 'c-help')!;
      assert(row, `the helper's request is an inbox row: ${JSON.stringify(inbox.rows.map((r) => r.key))}`);
      assertEquals([row.kind, row.title], ['approval', 'Fix Use-with list layout (Codex)']);
      assertEquals(row.what, 'Run npm test');

      // the desktop toast: Allow / Deny, Allow answers the helper's own chat; a risky one has Open only
      const sent: Json[] = [];
      let deliver: (m: Json) => void = () => {};
      const spawn: SpawnToastHelper = (onMessage) => {
        deliver = onMessage;
        return {
          send(m) {
            sent.push(m);
            if (m.op === 'register') queueMicrotask(() => onMessage({ op: 'ready' }));
            if (m.op === 'show') queueMicrotask(() => onMessage({ op: 'shown', id: m.id }));
          },
          close() {},
        };
      };
      const balloon: OsNotify = { mechanism: 'windows-balloon', show: () => Promise.resolve({ shown: true, code: 1 }) };
      const opened: (NotifyTarget | null)[] = [];
      const notifications = new DesktopNotifications(balloon, (t) => opened.push(t), () => true);
      const started = startWindowsToasts(s.ctx, notifications, {
        stateDir: dir,
        program: 'unused: the fake helper runs instead',
        launch: '',
        icon: new Uint8Array([137, 80, 78, 71]),
        quietState: () => 5,
        spawn,
        firstWaitMs: 50,
        settleMs: 10,
      });
      assert(started, 'the toast route is on');
      stop = started.stop;
      await until('registered', () => started.toasts.state === 'ready');
      await s.ctx.inbox.look();
      const show = async (key: string, title: string) => {
        const r = await notifications.show({ title, body: 'shop', target: { type: 'inbox', key }, test: false });
        assert(r.shown, key);
        return buttons(String(sent.filter((x) => x.op === 'show').at(-1)!.xml));
      };
      const helperButtons = await show('codex:sess-c-help', 'Fix Use-with list layout (Codex)');
      assertEquals(helperButtons.map((b) => b[0]), ['Allow', 'Deny']);
      const riskyButtons = await show('codex:sess-c-risk', 'Release (Codex)');
      assertEquals(riskyButtons.map((b) => b[0]), ['Open'], 'a risky helper request: Open only');
      deliver({ op: 'activated', args: helperButtons[0][1], inputs: {} });
      await until('the approval reached the helper', () => calls.some((c) => c[0] === 'permission'));
      assertEquals(calls.filter((c) => c[0] === 'permission'), [['permission', { id: 'c-help', key: 'p1', option: 'yes' }]]);
      await until('its toast removed', () => sent.some((m) => m.op === 'remove' && m.tag === toastTag('codex:sess-c-help')));

      // answered: the inbox row and the route's request clear
      const after = await s.ctx.inbox.look();
      assert(!after.rows.some((r) => r.id === 'c-help'), 'the answered request left the inbox');
      const [, list] = await pc(s, 'GET', '/api/live/swarm');
      assert(!('waits' in (list.helpers as Json[]).find((h) => h.id === 'h_one00001')!), 'the route has no request for it now');
      assert((list.helpers as Json[]).find((h) => h.id === 'h_two00001')!.waits, 'the other helper still waits');
    } finally {
      stop();
      await s.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'swarm approvals: the phone shows a waiting helper in its inbox with Allow (not in its chat list); a tap answers the helper',
  ignore: !browserPath,
  async fn() {
    const s = await v2Aib();
    const browser = await Browser.launch();
    try {
      const main = liveChat('c-main', s.project, { breadth: { sessionInfo: { title: 'Lead chat' } } });
      const helper = liveChat('c-help', s.project, {
        provider: 'codex',
        breadth: { sessionInfo: { title: 'New conversation' } },
        attention: { ...needs },
        permissions: perm('p1', 'npm test'),
        events: [{ seq: 1, kind: 'permission', time: Date.now() / 1000, data: { key: 'p1' } }],
      });
      s.chats.push(main, helper);
      await s.ctx.viewPrefs.setChatName('codex:sess-c-help', 'Fix Use-with list layout (Codex)');
      await new Registry(s.state).update('h_one00001', () => record('h_one00001', 'Fix Use-with list layout', helper, main, 'waiting'));
      const calls: [string, Json][] = [];
      s.answerLive((name, body) => {
        calls.push([name, body]);
        if (name === 'permission') {
          helper.permissions = [];
          helper.attention = { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date().toISOString() };
          helper.busy = true;
        }
        return [200, { ok: true }];
      });
      const phone = await pairPhone(s);
      const ph = await phonePage(browser, s, phone);
      // the chat list has the lead chat only
      assertEquals(await ph.eval<string[]>(`[...document.querySelectorAll('.ph-card')].map((c) => c.dataset.chat || c.textContent.slice(0, 40))`).then((l) => l.length), 1);
      assert(!(await ph.eval<string>('document.getElementById("app").innerText')).includes('Fix Use-with list layout'), 'no helper card in the chat list');
      await ph.waitFor('document.querySelector("#phInbox .ph-env-badge")?.textContent === "1"', 15000, 'the phone badge counts the helper request');
      await tap(ph, '#phInbox');
      await ph.waitFor('document.querySelectorAll(".ph-icard").length === 1', 8000, 'the helper request card');
      const card = await ph.eval<Json>(`(() => { const c = document.querySelector('.ph-icard');
        return { text: c.querySelector('.ph-il2').textContent, acts: [...c.querySelectorAll('.ph-iacts button')].map((b) => b.dataset.act) }; })()`);
      assert(String(card.text).startsWith('Fix Use-with list layout (Codex)'), String(card.text));
      assert((card.acts as string[]).includes('allow') && (card.acts as string[]).includes('deny'), JSON.stringify(card.acts));
      await tap(ph, '.ph-icard [data-act=allow]');
      await until('the phone tap answered the helper', () => calls.some((c) => c[0] === 'permission'));
      assertEquals(calls.filter((c) => c[0] === 'permission')[0][1].id, 'c-help');
      await ph.waitFor('document.querySelectorAll(".ph-icard").length === 0', 15000, 'the card clears');
      await ph.close();
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
