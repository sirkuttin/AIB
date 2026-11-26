/**
 * History loading phase 2B (the page's data path), end to end: a real AIB (Deno web server + in-process agent host, temp state
 * folder, free port; never 8767/8768/8777/8778), the scripted agent work/scroll-fixture/agent.mjs, and a headless Chrome/Edge on
 * chat.html (no window). The page's requests are recorded (a fetch wrapper: URL, response size, and the events of
 * /api/live/events pages), so the gates are bytes and request counts; the scroll checks are frame by frame (_scroll_lab.ts).
 *
 * Run (from app): deno test -A ../../work/deno/history_page_e2e_test.ts
 * Without Chrome or Edge (CHROME_PATH chooses one) every test is ignored.
 */
import { assert } from './_assert.ts';
import {
  anchor,
  BOX,
  browserPath,
  type Chat,
  clickHere,
  following,
  framesProblems,
  Lab,
  m,
  type Page,
  ownerProblems,
  rowFramesProblems,
  settle,
  shown,
  sleep,
  startFrames,
  startRowFrames,
  stopFrames,
  stopRowFrames,
  wheel,
} from './_scroll_lab.ts';

function historyTest(name: string, fn: (lab: Lab) => Promise<void>, size: [number, number] = [1600, 900], pollScale?: number) {
  Deno.test({
    name,
    ignore: !browserPath || Deno.env.get('AIB_SCROLL_V2') === '0', // history-v2 needs scroll-v2
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(size[0], size[1], undefined, { pollScale });
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
        const owner = await ownerProblems(lab.page);
        assert(!owner, owner);
      } finally {
        await lab.close();
      }
    },
  });
}

/** Records every request the page makes from now on: {u, n (response characters), ev (an events page: its events' session ids)}. */
const RECORD = `(() => {
  if (window.__req) return;
  window.__req = [];
  const f = window.fetch.bind(window);
  window.fetch = (u, o) => {
    const r = f(u, o);
    const rec = { u: String(u), n: 0, sids: null, at: Date.now() };
    window.__req.push(rec);
    r.then((res) => res.clone().text().then((t) => {
      rec.n = t.length;
      if (rec.u.startsWith('/api/live/events')) {
        try { rec.sids = (JSON.parse(t).events || []).map((e) => (e.data && e.data.sessionId) || ''); } catch {}
      }
    })).catch(() => {});
    return r;
  };
})()`;
interface Req { u: string; n: number; sids: string[] | null; at: number }
const reqs = (page: Page) => page.eval<Req[]>('window.__req || []');
const q = (r: Req) => new URL(r.u, 'http://x').searchParams;
const forId = (list: Req[], path: string, id: string) => list.filter((r) => r.u.startsWith(path + '?') && q(r).get('id') === id);

/** A big chat: one long turn of `n` finished steps with ~3 KB outputs and a reply each (about n * 3.5 KB of events). */
async function bigChat(lab: Lab, n = 700, tag = 'Big'): Promise<Chat> {
  const chat = await lab.chat();
  await chat.start();
  chat.say(`${tag} FIRSTROW the oldest reply of the chat. `);
  for (let i = 0; i < n; i++) {
    chat.tool(`b${i}`, `${tag} step ${i}`);
    chat.toolDone(`b${i}`, `output ${i} ` + 'x'.repeat(3000));
    chat.say(`\n\n${tag} reply ${i}. ` + 'Some words to fill a line or two. '.repeat(3) + '\n\n');
  }
  chat.say(`${tag} done ${tag.toUpperCase()}END`);
  chat.end();
  // wait until the host has them all (the agent sends each line as it is written)
  for (let i = 0; i < 300; i++) {
    const s = await lab.web.state(chat.id);
    if (!s.busy && JSON.stringify(s.events || []).includes(`${tag.toUpperCase()}END`)) return chat;
    await sleep(200);
  }
  throw new Error('the big chat did not finish');
}

historyTest('h1 opening a big chat sends only its newest page (bytes gate), never the full state', async (lab) => {
  const page = lab.page;
  const chat = await bigChat(lab);
  const total = JSON.stringify((await lab.web.state(chat.id)).events).length;
  assert(total > 2.3 * 1024 * 1024, `the chat is big: ${total}`);
  await page.eval(RECORD);
  await lab.select(chat);
  await shown(page, 'BIGEND');
  await settle(2000);
  const list = await reqs(page);
  const pagesRead = forId(list, '/api/live/events', chat.id), states = forId(list, '/api/live/state', chat.id);
  assert(pagesRead.length >= 1, 'the open read /api/live/events');
  assert(!states.some((r) => q(r).get('after') === '0'), `no full state read: ${states.map((r) => r.u).join(' ')}`);
  const bytes = [...pagesRead, ...states].reduce((s, r) => s + r.n, 0);
  assert(bytes < 1.3 * 1024 * 1024, `open + polls downloaded ${bytes} characters of a ${total}-character chat`);
  assert(!(await page.eval<boolean>(`!!document.querySelector('#messages .show-earlier, #messages .load-history')`)), 'no Show earlier / Load earlier button');
});

historyTest('h2 scrolling up loads older pages above without moving the row you read (every frame), up to the first row', async (lab) => {
  const page = lab.page;
  const chat = await bigChat(lab);
  await page.eval(RECORD);
  await lab.select(chat);
  await shown(page, 'BIGEND');
  await settle(1500);
  const problems: string[] = [];
  let loaded = 0;
  for (let k = 0; k < 40 && !(await page.eval<boolean>(`document.getElementById('messages').textContent.includes('FIRSTROW')`)); k++) {
    const pagesBefore = forId(await reqs(page), '/api/live/events', chat.id).length;
    // to the top, the way a scrollbar drag goes there; the row at the top then must not move while rows are put above it
    await page.eval(`(() => { const b = ${BOX}('messages'); b.scrollTop = 0; })()`);
    const before = await anchor(page);
    if (!before) throw new Error('no row at the top');
    await startRowFrames(page, before.text);
    await settle(900);
    const frames = await stopRowFrames(page);
    const p = rowFramesProblems(frames, before);
    if (p) problems.push(`round ${k} ("${before.text.slice(0, 30)}"): ${p}`);
    if (forId(await reqs(page), '/api/live/events', chat.id).length > pagesBefore) loaded++;
  }
  assert(!problems.length, problems.join('\n'));
  assert(loaded >= 1, 'at least one older page was fetched');
  const why = await page.eval<string>(`(() => { const b = document.getElementById('messages'), e = window.StudioChat.chatCache.entry(${JSON.stringify(chat.id)});
    return JSON.stringify({ from: e.from, more: e.more, size: e.size(), first: e.first, win: b._winStart, grow: typeof b._grow, top: b.scrollTop, h: b.scrollHeight, kids: b.children.length, firstKid: (b.children[0]?.textContent || '').slice(0, 60) }); })()`);
  assert(await page.eval<boolean>(`document.getElementById('messages').textContent.includes('FIRSTROW')`), 'the first row was reached: ' + why + ' loaded ' + loaded);
  const olders = forId(await reqs(page), '/api/live/events', chat.id).filter((r) => q(r).get('before'));
  assert(olders.length === loaded, `one request per older page: ${olders.length} vs ${loaded}`);
  const sids = olders.flatMap((r) => r.sids || []);
  assert(!sids.some((s) => s && s !== chat.sid), 'older pages carry only the chat\'s own events');
});

historyTest('h3 follow mode and "↓ Latest" are unchanged with lazy pages: every frame at the end; ↓ Latest makes no request', async (lab) => {
  const page = lab.page;
  const chat = await bigChat(lab, 400);
  await lab.select(chat);
  await shown(page, 'BIGEND');
  await settle(1500);
  await chat.start();
  const problems: string[] = [];
  for (let k = 0; k < 4; k++) {
    await startFrames(page);
    chat.tool(`f${k}`, `Follow step ${k}`, 'completed');
    chat.say(`\n\nFollow reply FOLLOW${k} ` + 'words '.repeat(60));
    await shown(page, `FOLLOW${k}`);
    await settle(900);
    const p = framesProblems(await stopFrames(page));
    if (p) problems.push(`update ${k}: ${p}`);
  }
  const end = await m(page);
  assert(!following(end), `following after the updates: ${following(end)}`);
  assert(!problems.length, problems.join('\n'));
  // read back, things arrive, ↓ Latest: drawn from the cache, no page request
  await wheel(page, -1500);
  await settle(400);
  chat.say('\n\nWhile reading WHILEREAD ' + 'words '.repeat(80));
  await shown(page, 'WHILEREAD');
  await settle(800);
  assert((await m(page)).jump, `a jump button shows: ${JSON.stringify(await m(page))}`);
  await page.eval(RECORD);
  for (let i = 0; i < 2 && (await m(page)).jump; i++) {
    await clickHere(page, '#jumpNew');
    await settle(700);
  }
  const after = await m(page);
  assert(!following(after), `following after ↓ Latest: ${following(after)}`);
  const pagesAfter = forId(await reqs(page), '/api/live/events', chat.id);
  assert(pagesAfter.length === 0, `↓ Latest fetched pages: ${pagesAfter.map((r) => r.u).join(' ')}`);
  chat.end();
});

historyTest('h4 a side pane on a chat uses the shared cache: no opening page or full state of its own, reads shared', async (lab) => {
  const page = lab.page;
  const a = await bigChat(lab, 150, 'Alpha');
  const b = await bigChat(lab, 150, 'Beta');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await lab.select(b);
  await shown(page, 'BETAEND');
  await settle(800);
  await page.eval(RECORD);
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(a.key)}, 'row')`);
  await page.waitFor(`document.querySelectorAll('.mirror-msgs').length === 1 && document.querySelector('.mirror-msgs').children.length > 5`, 15000, 'a side pane with chat a').catch(async (e) => {
    throw new Error(e.message + ' :: ' + await page.eval<string>(`JSON.stringify({n: document.querySelectorAll('.mirror-msgs').length, t: (document.querySelector('.mirror-msgs')?.textContent || '').slice(-300), key: document.querySelector('.mirror-msgs')?.dataset.mirror, a: ${JSON.stringify(a.key)}, errs: (window.__req||[]).filter(r => r.n < 400 && /api.live/.test(r.u)).slice(-5).map(r => r.u)})`));
  });
  await settle(6000);
  const list = await reqs(page);
  const opens = forId(list, '/api/live/events', a.id).filter((r) => !q(r).get('before') && !q(r).get('session'));
  assert(opens.length === 0, `the pane opened chat a again: ${opens.map((r) => r.u).join(' ')}`);
  const states = forId(list, '/api/live/state', a.id);
  assert(!states.some((r) => q(r).get('after') === '0'), 'no full state read for the pane');
  assert(states.every((r) => r.n < 64 * 1024), `the pane's reads are deltas: ${states.map((r) => r.n).join(',')}`);
  assert(states.length <= 6, `about one read of chat a per second at most in 6 s: ${states.length}`);
  // the same chat in the main list and the pane: one read stream (main + pane reads within a second are one)
  const bStates = forId(list, '/api/live/state', b.id);
  const close = bStates.filter((r, i) => i > 0 && r.at - bStates[i - 1].at < 300);
  assert(close.length === 0, `two reads of the open chat within 300 ms: ${close.length}`);
}, [1600, 900], 1); // counts reads per second: the real poll periods

historyTest("h5 a helper's history is fetched when it is opened (the chat's open has none of its events)", async (lab) => {
  const page = lab.page;
  // recorded from the start: the project's Activity reads a working chat of the project on screen before you open it (that read is
  // its opening page, shared with the main list when you open it)
  await page.eval(RECORD);
  const chat = await lab.chat();
  await chat.start();
  chat.say('Starting a helper');
  chat.step({ u: { sessionUpdate: 'tool_call', toolCallId: 'agent-1', title: 'Agent', kind: 'think', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } } });
  chat.step({ u: { sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Review the code', capabilities: { cancel: {} }, state: { state: 'running' } } });
  const child = (u: Record<string, unknown>) => chat.step({ sid: 'child-1', u: { ...u, _meta: { claudeCode: { parentToolUseId: 'agent-1' } } } });
  for (let i = 0; i < 25; i++) {
    child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Child message ${i}. ` + 'Helper words. '.repeat(15) + '\n\n' } });
    child({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: `Child read ${i}`, kind: 'read', status: 'completed' });
  }
  chat.say('\n\nMain after HELPERSTARTED');
  await sleep(1500);
  await lab.select(chat);
  await shown(page, 'HELPERSTARTED');
  await page.waitFor(`!!document.querySelector('#projectActivity button[data-key="child-1"]')`, 15000, 'subagent card from the helper facts');
  let list = await reqs(page);
  const open = forId(list, '/api/live/events', chat.id).filter((r) => !q(r).get('session'));
  assert(open.length >= 1 && open.every((r) => (r.sids || []).every((s) => s !== 'child-1')), 'the open page has no helper events');
  assert(forId(list, '/api/live/events', chat.id).every((r) => q(r).get('session') !== 'child-1'), 'not fetched before it is opened');
  await clickHere(page, '#projectActivity button[data-key="child-1"]');
  await shown(page, 'Child read 24', 'submessages');
  list = await reqs(page);
  const helper = forId(list, '/api/live/events', chat.id).filter((r) => q(r).get('session') === 'child-1');
  assert(helper.length === 1, `one helper page read: ${helper.length}`);
  assert((helper[0].sids || []).length > 0 && (helper[0].sids || []).every((s) => s === 'child-1'), 'only its own events');
  // live updates while open ride the normal poll
  child({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nChild live CHILDLIVE\n\n' } });
  await shown(page, 'CHILDLIVE', 'submessages');
  assert(forId(await reqs(page), '/api/live/events', chat.id).filter((r) => q(r).get('session') === 'child-1').length === 1, 'no second helper page');
  chat.end();
});
