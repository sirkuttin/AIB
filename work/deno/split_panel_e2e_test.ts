/**
 * Split view, the right panel (owner, 2026-11-15, mockup v2): with two chats side by side, Activity, Changes and Artifacts list
 * BOTH chats in pane order, each under its own header, and look the same whichever pane has focus. Nothing in the panel moves
 * pane focus. Artifacts: one dropdown per chat, side by side when the panel has room, stacked when it is narrow. Changes: each
 * chat's own Discard / Merge row; Merge asks that chat. One chat (no split): none of it shows.
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), two scripted live chats, headless Chrome or
 * Edge. Changes, the worktree status and the artifact lists are answered in the page (a fetch stub keyed by chat id), so the test
 * needs no git worktrees; the helpers are real (scripted subagent_update events).
 *
 * Gaps closed (owner, 2026-11-15): a subagent or process row of the UNFOCUSED chat opens its history here without moving focus;
 * an open history stays open when focus moves; the × that hides Activity is where it is with one chat and never moves; each chat's
 * dropdown also lists "Docs this chat wrote"; the two dropdowns sit side by side at the default 280 px panel.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/split_panel_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert } from './_assert.ts';
import { browserPath, type Chat, Lab, ownerProblems, type Page, settle, shown } from './_scroll_lab.ts';

function panelTest(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1600, 900);
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

/** Changes, worktree status, artifact and doc lists per chat id, B's processes, answered in the page; merge requests are recorded. */
function stub(page: Page, a: Chat, b: Chat) {
  const files = {
    [a.id]: [
      { path: 'src/cart/totals.ts', status: 'M', added: 42, removed: 9 },
      { path: 'src/cart/tax.ts', status: 'M', added: 11, removed: 6 },
    ],
    [b.id]: [{ path: 'src/feed/rss.ts', status: 'A', added: 37, removed: 0 }],
  };
  const arts = {
    [a.id]: [
      { id: 'art-a1', conversationId: a.id, kind: 'html', title: 'Checkout bug root cause', version: 2, updatedAt: Date.now() / 1000 - 240 },
      { id: 'art-a2', conversationId: a.id, kind: 'svg', title: 'Totals before and after', version: 1, updatedAt: Date.now() / 1000 - 540 },
    ],
    [b.id]: [{ id: 'art-b1', conversationId: b.id, kind: 'md', title: 'RSS feed plan', version: 1, updatedAt: Date.now() / 1000 - 720 }],
  };
  const docs = {
    [a.id]: [],
    [b.id]: [{ name: 'feed-notes', title: 'Feed notes', pages: 2, chat: b.id }, { name: 'other-notes', title: 'Not this chat', pages: 1, chat: 'someone-else' }],
  };
  const started = new Date(Date.now() - 90_000).toISOString();
  const cmds = {
    [b.key]: [{ id: 'cmd-b1', title: 'npm run feed-watch', status: 'running', started, agent: 'Main conversation', tool: 'Bash', command: 'npm run feed-watch' }],
  };
  return page.eval(`(() => {
    const files = ${JSON.stringify(files)}, arts = ${JSON.stringify(arts)}, docs = ${JSON.stringify(docs)}, cmds = ${JSON.stringify(cmds)};
    const merges = (window.__merges = []), real = window.fetch.bind(window);
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (url, init) => {
      const u = new URL(String(url), location.href), id = u.searchParams.get('id') || u.searchParams.get('conversationId') || '';
      if (u.pathname === '/api/live/changes' && files[id])
        return json({ git: true, scope: 'branch', files: files[id], worktree: { branch: 'aib/' + id.slice(0, 6), base: 'main' } });
      if (u.pathname === '/api/live/worktree' && files[id])
        return json({ worktree: true, enabled: true, state: 'ready', base: 'main', label: 'Merge' });
      if (u.pathname === '/api/live/worktree/merge-request') {
        merges.push(JSON.parse(init.body).id);
        return json({ message: 'Merge requested' });
      }
      if (u.pathname === '/api/live/artifacts' && arts[id]) return json({ artifacts: arts[id] });
      if (u.pathname === '/api/live/docs/list' && docs[id]) return json({ docs: docs[id] });
      // a saved chat's session is its transcript path (".../feedsaved.jsonl"), the key "claude:feedsaved"
      const sess = u.searchParams.get('session') || '',
        session = Object.keys(cmds).find((k) => sess === k || sess.endsWith('/' + k.split(':').pop() + '.jsonl')) || sess;
      if (u.pathname === '/api/commands' && cmds[session]) return json({ commands: cmds[session] });
      if (u.pathname === '/api/command' && cmds[session])
        return json(Object.assign({}, cmds[session].find((t) => t.id === u.searchParams.get('id')), { output: 'FEEDWATCHOUT' }));
      return real(url, init);
    };
  })()`);
}

function helpers(chat: Chat, tag: string, list: [string, string][]) {
  list.forEach(([desc, state], i) =>
    chat.step({ u: { sessionUpdate: 'subagent_update', subagent: { sessionId: `${tag}-helper-${i}`, description: desc, state } } })
  );
}

/** Two live chats, A in the left pane (focused) and B in the right pane. */
async function openSplit(lab: Lab) {
  const page = lab.page;
  const a = await lab.chat();
  await a.start();
  a.say('Alpha here ALPHAEND');
  helpers(a, 'a', [['Find rounding bug', 'running'], ['Map tax rules', 'completed']]);
  const b = await lab.chat();
  await b.start();
  b.say('Beta here BETAEND');
  helpers(b, 'b', [['Check feed spec', 'running']]);
  await stub(page, a, b);
  await lab.select(b);
  await shown(page, 'BETAEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await settle(800);
  return { a, b };
}
async function split(lab: Lab, a: Chat, b: Chat) {
  const page = lab.page;
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2 && !!document.querySelector('.mirror-msgs')`, 15000, 'two panes');
  await page.eval(`(() => { const p = AgentSplitUI.panes().find((p) => p.group.active === ${JSON.stringify(a.key)}); if (p && !p.focused) AgentSplitUI.focusPane(p.id); })()`);
  await page.waitFor(`AgentSplitUI.panes().find((p) => p.focused)?.group.active === ${JSON.stringify(a.key)}`, 15000, 'A focused');
  const order = await page.eval<string[]>(`AgentSplitUI.paneChats()`);
  assert(JSON.stringify(order) === JSON.stringify([a.key, b.key]), `pane order ${JSON.stringify(order)}`);
}

const focusedKey = (page: Page) => page.eval<string>(`AgentSplitUI.panes().find((p) => p.focused)?.group.active || ''`);
const keysOf = (page: Page, sel: string) =>
  page.eval<string[]>(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((n) => n.offsetParent).map((n) => n.dataset.key)`);

/** Everything visible in the right panel: element, classes, box (px) and text (digits out: the run clocks tick). */
const PANEL = `(() => {
  const pane = document.getElementById('subagentsPane'), out = [];
  for (const n of pane.querySelectorAll('*')) {
    if (!n.offsetParent && getComputedStyle(n).position !== 'fixed') continue;
    // a spinning working dot's box turns with it: its untransformed box counts, not the turned one
    const spin = getComputedStyle(n).animationName !== 'none', b = n.getBoundingClientRect();
    const r = spin ? { left: b.left + b.width / 2 - n.offsetWidth / 2, top: b.top + b.height / 2 - n.offsetHeight / 2, width: n.offsetWidth, height: n.offsetHeight } : b;
    if (!r.width || !r.height) continue;
    const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').replace(/\\d+/g, '#').trim();
    out.push([n.tagName, n.className, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), own].join('|'));
  }
  return out;
})()`;
function diff(a: string[], b: string[]) {
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`${a[i]}  ->  ${b[i]}`);
  return out.slice(0, 8).join('\n');
}
async function clickOther(page: Page, want: string) {
  await page.click('#splitStage .pane:not(.foc) :is(.mirror-copy > header [data-mid="title"], .mirror-head)');
  await page.waitFor(`AgentSplitUI.panes().find((p) => p.focused)?.group.active === ${JSON.stringify(want)}`, 15000, 'focus moved');
  await settle(2500);
}

panelTest('split panel: one chat shows none of the split sections and keeps its own header row', async (lab) => {
  const page = lab.page;
  await openSplit(lab);
  const st = await page.eval<Record<string, unknown>>(`(() => {
    const vis = (sel) => { const n = document.querySelector(sel); return !!n && !!n.offsetParent; };
    return { splitOn: document.body.classList.contains('split-on'), splitActivity: vis('#splitActivity .sp-grp'),
      subagentList: vis('#subagentList'), commands: vis('#commandSection'), heads: document.querySelectorAll('#subagentsPane .sp-head').length };
  })()`);
  assert(!st.splitOn && !st.splitActivity && st.subagentList && st.commands && st.heads === 0, `single view: ${JSON.stringify(st)}`);
  await page.click('#paneTab-changes');
  await settle(600);
  assert(await page.eval<boolean>(`!document.querySelector('#splitChanges')?.offsetParent && !!document.querySelector('#changesPane .cg-bar')?.offsetParent`), 'single Changes view');
  await page.click('#paneTab-artifacts');
  await settle(600);
  assert(await page.eval<boolean>(`!document.querySelector('.ar-split')?.offsetParent`), 'no split dropdowns with one chat');
});

panelTest('split panel: both chats in pane order on every tab, focus changes nothing, panel clicks keep focus', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await split(lab, a, b);
  // Activity: both chats, pane order, each with header, SUBAGENTS label and its helpers
  await page.waitFor(
    `(() => { const s = [...document.querySelectorAll('#splitActivity .sp-grp')]; return s.length === 2 && s.every((g) => g.querySelectorAll('.subagent-card').length > 0); })()`,
    20000,
    'Activity lists both chats with their helpers',
  ).catch(async (e) => {
    throw new Error(`${e.message}: ${await page.eval(`document.getElementById('subagentsPane').innerText.slice(0, 600)`)}`);
  });
  assert(JSON.stringify(await keysOf(page, '#splitActivity .sp-grp')) === JSON.stringify([a.key, b.key]), 'Activity in pane order');
  const act = await page.eval<{ heads: string[]; labels: string[]; headRow: boolean }>(`({
    heads: [...document.querySelectorAll('#splitActivity .sp-head')].map((h) => h.innerText.replace(/\\s+/g, ' ')),
    labels: [...document.querySelectorAll('#splitActivity .sp-label')].filter((n) => n.offsetParent).map((n) => n.innerText.replace(/\\s+/g, ' ')),
    headRow: !!document.getElementById('activityHead')?.offsetParent,
  })`);
  assert(!act.headRow, 'the header row above the tabs is gone in split view');
  assert(/1 working/.test(act.heads[0]) && /1 working/.test(act.heads[1]), `headers: ${JSON.stringify(act.heads)}`);
  assert(act.labels.filter((l) => /^subagents/i.test(l)).length === 2, `labels: ${JSON.stringify(act.labels)}`);

  // focus changes nothing in the panel, on each tab
  for (const tab of ['activity', 'changes', 'artifacts']) {
    await page.click(`#paneTab-${tab}`);
    if (tab === 'changes')
      await page.waitFor(`document.querySelectorAll('#splitChanges .sp-grp .cg-file').length === 3`, 15000, 'files of both chats');
    if (tab === 'artifacts')
      await page.waitFor(`document.querySelectorAll('.ar-split .ar-spick:not(.plain)').length === 2`, 15000, 'both dropdowns');
    await settle(1500);
    const before = await page.eval<string[]>(PANEL);
    const other = (await focusedKey(page)) === a.key ? b.key : a.key;
    await clickOther(page, other);
    const after = await page.eval<string[]>(PANEL);
    assert(before.join('\n') === after.join('\n'), `${tab}: the panel changed when focus moved:\n${diff(before, after)}`);
    assert((await page.eval<string>(`document.querySelector('#paneTabs [aria-selected="true"]').dataset.tab`)) === tab, `${tab} stays selected`);
  }

  // Changes: pane order, per-chat headers and Merge rows; Merge asks its own chat
  await page.click('#paneTab-changes');
  assert(JSON.stringify(await keysOf(page, '#splitChanges .sp-grp')) === JSON.stringify([a.key, b.key]), 'Changes in pane order');
  await page.waitFor(`[...document.querySelectorAll('#splitChanges .cg-merge-btn')].filter((n) => n.offsetParent && !n.disabled).length === 2`, 15000, 'two Merge buttons');
  const focusNow = await focusedKey(page);
  await page.click('#splitChanges .sp-grp:nth-child(2) .cg-merge-btn');
  await page.waitFor(`window.__merges.length === 1`, 10000, 'merge request sent');
  assert((await page.eval<string>(`window.__merges[0]`)) === b.id, 'Merge in the second section asks the second chat');
  assert((await focusedKey(page)) === focusNow, 'Merge did not move focus');

  // clicks anywhere in the panel never move focus
  for (const sel of ['#paneTab-activity', '#splitActivity .sp-grp:nth-child(2) .sp-head', '#splitActivity .sp-grp:nth-child(2) .subagent-card', '#paneTab-changes', '#splitChanges .sp-grp:nth-child(2) .sp-head', '#splitChanges .sp-grp:nth-child(2) .cg-file', '#paneTab-artifacts', '.ar-split .ar-sgrp:nth-child(2) .ar-spick']) {
    const was = await focusedKey(page);
    await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})?.offsetParent`, 10000, sel);
    await page.click(sel);
    await settle(400);
    assert((await focusedKey(page)) === was, `clicking ${sel} moved focus`);
  }
  // the second chat's dropdown lists its artifact; picking it shows it and gives that bar the accent border
  await page.waitFor(`!!document.querySelector('.ar-pop:not([hidden]) .ar-it[data-id="art-b1"]')`, 5000, 'B dropdown open');
  await page.click('.ar-pop .ar-it[data-id="art-b1"]');
  await page.waitFor(`document.querySelector('.ar-split .ar-sgrp:nth-child(2) .ar-spick')?.classList.contains('showing')`, 10000, 'B showing');
  assert(!(await page.eval<boolean>(`document.querySelector('.ar-split .ar-sgrp:nth-child(1) .ar-spick').classList.contains('showing')`)), 'only one bar has the accent');
  assert(JSON.stringify(await keysOf(page, '.ar-split .ar-sgrp')) === JSON.stringify([a.key, b.key]), 'Artifacts in pane order');
});

panelTest('split panel: artifact dropdowns side by side at the default 280 px panel (titles end in …), stacked only when narrower', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await split(lab, a, b);
  await page.click('#paneTab-artifacts');
  await page.waitFor(`document.querySelectorAll('.ar-split .ar-spick:not(.plain)').length === 2`, 15000, 'two dropdowns');
  const at = async (w: number) => {
    await page.eval(`document.documentElement.style.setProperty('--activity-w', '${w}px')`);
    await settle(400);
    return page.eval<{ w: number; t: number[]; l: number[]; titleW: number[]; full: string[]; over: boolean[] }>(`(() => {
      const g = [...document.querySelectorAll('.ar-split .ar-sgrp')], picks = g.map((n) => n.querySelector('.ar-spick'));
      const titles = picks.map((p) => p.querySelector('.ar-pick-title'));
      return { w: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width),
        t: g.map((n) => Math.round(n.getBoundingClientRect().top)), l: g.map((n) => Math.round(n.getBoundingClientRect().left)),
        titleW: titles.map((n) => Math.round(n.getBoundingClientRect().width)), full: picks.map((p) => p.title),
        over: titles.map((n) => getComputedStyle(n).textOverflow === 'ellipsis' && getComputedStyle(n).whiteSpace === 'nowrap') };
    })()`);
  };
  const dflt = await at(280);
  assert(dflt.w === 280, `panel width ${dflt.w}`);
  assert(dflt.t[0] === dflt.t[1] && dflt.l[1] > dflt.l[0], `default 280 px panel: side by side, tops ${dflt.t} lefts ${dflt.l}`);
  assert(dflt.titleW.every((x) => x >= 75), `titles readable (>= 75 px each): ${dflt.titleW}`);
  assert(dflt.over.every(Boolean), 'a long title ends in an ellipsis');
  assert(/^Checkout bug root cause/.test(dflt.full[0]) && /^RSS feed plan/.test(dflt.full[1]), `full titles on hover: ${JSON.stringify(dflt.full)}`);
  const wide = await at(440);
  assert(wide.t[0] === wide.t[1], `wide panel (${wide.w}px): side by side, tops ${wide.t}`);
  const narrow = await at(250);
  assert(narrow.t[1] > narrow.t[0], `narrow panel (${narrow.w}px): stacked, tops ${narrow.t}`);
});

panelTest('split panel: each chat\'s dropdown also lists "Docs this chat wrote"', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await split(lab, a, b);
  await page.click('#paneTab-artifacts');
  await page.waitFor(`document.querySelectorAll('.ar-split .ar-spick:not(.plain)').length === 2`, 15000, 'two dropdowns');
  await page.waitFor(`/1 doc/.test(document.querySelector('.ar-split .ar-sgrp:nth-child(2) .sp-sub')?.textContent || '')`, 15000, 'B header counts its doc');
  const was = await focusedKey(page);
  await page.click('.ar-split .ar-sgrp:nth-child(2) .ar-spick');
  await page.waitFor(`!!document.querySelector('.ar-pop:not([hidden]) .ar-it[data-doc="feed-notes"]')`, 5000, "B's doc listed");
  const pop = await page.eval<{ text: string; docs: string[] }>(`({ text: document.querySelector('.ar-pop').innerText,
    docs: [...document.querySelectorAll('.ar-pop [data-doc]')].map((n) => n.dataset.doc) })`);
  assert(/Docs this chat wrote/i.test(pop.text), `group label: ${pop.text}`);
  assert(JSON.stringify(pop.docs) === JSON.stringify(['feed-notes']), `only B's own docs: ${JSON.stringify(pop.docs)}`);
  assert(/RSS feed plan/.test(pop.text), "B's artifact is still listed");
  assert((await focusedKey(page)) === was, 'opening the dropdown did not move focus');
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await settle(300);
  // A's dropdown: A wrote no docs, so no docs group
  await page.click('.ar-split .ar-sgrp:nth-child(1) .ar-spick');
  await page.waitFor(`!!document.querySelector('.ar-pop:not([hidden]) .ar-it[data-id="art-a1"]')`, 5000, 'A dropdown open');
  assert(!(await page.eval<boolean>(`/Docs this chat wrote/i.test(document.querySelector('.ar-pop').innerText)`)), 'A lists no docs group');
});

panelTest('split panel: the other chat\'s subagent and process rows open their history without moving focus; it stays open when focus moves', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await split(lab, a, b);
  await page.waitFor(`!!document.querySelector('#splitActivity .sp-grp:nth-child(2) .subagent-card')?.offsetParent`, 20000, "B's helper row");
  const hist = () =>
    page.eval<{ open: boolean; eyebrow: string; title: string; cmd: string }>(`({ open: !document.getElementById('subchatPane').hidden && !!document.getElementById('subchatPane').offsetParent,
      eyebrow: document.getElementById('inspectorEyebrow').textContent, title: document.getElementById('subchatTitle').textContent,
      cmd: document.getElementById('commandDetails').hidden ? '' : document.getElementById('commandDetails').innerText })`);
  // B (unfocused): its subagent row opens B's helper history; A keeps focus
  await page.click('#splitActivity .sp-grp:nth-child(2) .subagent-card');
  await page.waitFor(`!document.getElementById('subchatPane').hidden`, 10000, 'history opened');
  await settle(800);
  let h = await hist();
  assert(h.open && /SUBAGENT/.test(h.eyebrow) && /Check feed spec/.test(h.title), `B's helper history: ${JSON.stringify(h)}`);
  assert((await focusedKey(page)) === a.key, 'opening the other chat\'s history did not move focus');
  // focus moves to B, then back to A: the history stays open on the same helper
  await clickOther(page, b.key);
  h = await hist();
  assert(h.open && /Check feed spec/.test(h.title), `after focus moved to B: ${JSON.stringify(h)}`);
  await clickOther(page, a.key);
  h = await hist();
  assert(h.open && /Check feed spec/.test(h.title), `after focus moved back to A: ${JSON.stringify(h)}`);
  // the focused chat's own history stays open too when focus moves away
  await page.click('#closeSubchat');
  await page.waitFor(`document.getElementById('subchatPane').hidden`, 10000, 'history closed');
  await page.click('#splitActivity .sp-grp:nth-child(1) .subagent-card');
  await page.waitFor(`!document.getElementById('subchatPane').hidden`, 10000, "A's history opened");
  const aTitle = (await hist()).title;
  assert(/Find rounding bug|Map tax rules/.test(aTitle), `A's helper history: ${aTitle}`);
  await clickOther(page, b.key);
  h = await hist();
  assert(h.open && h.title === aTitle, `A's history after focus moved to B: ${JSON.stringify(h)}`);
});

panelTest('split panel: the other chat’s process row opens its details without moving focus; they stay open when focus moves', async (lab) => {
  // processes are read from a saved transcript's chat (a live chat lists them once saved): B is a saved chat here
  const page = lab.page;
  const a = await lab.chat();
  await a.start();
  a.say('Alpha here ALPHAEND');
  const saved = lab.savedChat('feedsaved');
  saved.user('Watch the feed');
  saved.say('Watching SAVEDEND');
  const b = { id: 'none', key: saved.key } as unknown as Chat;
  await stub(page, a, b);
  await lab.select(saved);
  await shown(page, 'SAVEDEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await settle(800);
  await split(lab, a, b);
  await page.waitFor(`!!document.querySelector('#splitActivity .sp-grp:nth-child(2) .command-card')?.offsetParent`, 20000, "B's process row").catch(async (e) => {
    throw new Error(`${e.message}: ${await page.eval(`JSON.stringify({ t: document.getElementById('splitActivity')?.innerText, chats: AgentSplitUI.paneChats(),  })`)}`);
  });
  await page.click('#splitActivity .sp-grp:nth-child(2) .command-card');
  await page.waitFor(`/FEEDWATCHOUT/.test(document.getElementById('commandDetails').innerText)`, 10000, "B's process details");
  const hist = () =>
    page.eval<{ open: boolean; eyebrow: string; title: string }>(`({ open: !document.getElementById('subchatPane').hidden,
      eyebrow: document.getElementById('inspectorEyebrow').textContent, title: document.getElementById('subchatTitle').textContent })`);
  let h = await hist();
  assert(h.open && /COMMAND/.test(h.eyebrow) && /npm run feed-watch/.test(h.title), `B's process: ${JSON.stringify(h)}`);
  assert((await focusedKey(page)) === a.key, 'opening the other chat’s process did not move focus');
  await clickOther(page, b.key);
  h = await hist();
  assert(h.open && /npm run feed-watch/.test(h.title), `B's process after focus moved to B: ${JSON.stringify(h)}`);
  assert(/FEEDWATCHOUT/.test(await page.eval<string>(`document.getElementById('commandDetails').innerText`)), 'details still shown');
});

panelTest('split panel: the × that hides Activity is where it is with one chat, and focus does not move it', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  const box = `(() => { const n = document.getElementById('activityHide'); if (!n || !n.offsetParent) return null;
    // where it sits in the Activity body, under the tab row (split view has no chat tab strip above the panel: the body starts higher)
    const r = n.getBoundingClientRect(), b = document.getElementById('subagentsPane').getBoundingClientRect(), t = document.getElementById('paneTabs').getBoundingClientRect();
    return [Math.round(b.right - r.right), Math.round(r.top - t.bottom), Math.round(r.width), Math.round(r.height)]; })()`;
  const single = await page.eval<number[] | null>(box);
  assert(single, 'the × shows with one chat');
  await split(lab, a, b);
  await page.waitFor(`document.querySelectorAll('#splitActivity .sp-grp').length === 2`, 20000, 'split Activity');
  await settle(1600);
  const inSplit = await page.eval<number[] | null>(box);
  assert(inSplit && JSON.stringify(inSplit) === JSON.stringify(single), `split × ${JSON.stringify(inSplit)} vs one chat ${JSON.stringify(single)}`);
  // nothing under it: the first header's text stops before it
  const clear = await page.eval<boolean>(`(() => { const x = document.getElementById('activityHide').getBoundingClientRect();
    return [...document.querySelectorAll('#splitActivity .sp-grp:first-child .sp-head > *')].every((n) => n.getBoundingClientRect().right <= x.left + 1); })()`);
  assert(clear, 'the first chat header does not run under the ×');
  await clickOther(page, b.key);
  assert(JSON.stringify(await page.eval(box)) === JSON.stringify(single), 'focus on B: the × did not move');
  await clickOther(page, a.key);
  assert(JSON.stringify(await page.eval(box)) === JSON.stringify(single), 'focus back on A: the × did not move');
  // it still hides Activity
  await page.click('#activityHide');
  await page.waitFor(`!document.getElementById('subagentsPane').offsetParent || document.getElementById('subagentsPane').getBoundingClientRect().width < 2`, 5000, 'Activity hidden');
});
