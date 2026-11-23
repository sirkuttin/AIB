/**
 * Split view, the right panel (owner, 2026-11-15, mockup v2): with two chats side by side, Changes and Artifacts list BOTH chats in
 * pane order, each under its own header, and look the same whichever pane has focus. Activity is the project's (2026-11-18): every
 * working chat of the project, split or not, with a Left / Right tag on the pane chats; focus only moves its accent. Nothing in the panel moves
 * pane focus. Artifacts: the one project picker (project_artifacts_e2e_test.ts). Changes: each
 * chat's own read-only summary row, no Merge or Discard (owner, 2026-11-16). One chat (no split): none of it shows.
 *
 * A real Studio (the scroll lab: temp state folder, free port; never the live ports), two scripted live chats, headless Chrome or
 * Edge. Changes, the worktree status and the artifact lists are answered in the page (a fetch stub keyed by chat id), so the test
 * needs no git worktrees; the helpers are real (scripted subagent_update events).
 *
 * Gaps closed (owner, 2026-11-15): a subagent or process row of the UNFOCUSED chat opens its history here without moving focus;
 * an open history stays open when focus moves; the × that hides Activity is where it is with one chat and never moves;
 * the one picker also lists the docs the chats wrote.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/split_panel_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
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

/** The project's Changes (the same list for every chat), artifact and doc lists per chat id, B's processes, answered in the page. */
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
    const real = window.fetch.bind(window);
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (url, init) => {
      const u = new URL(String(url), location.href), id = u.searchParams.get('id') || u.searchParams.get('conversationId') || '';
      if (u.pathname === '/api/live/project/changes' && Object.keys(files).length) { // the project's Changes: one list for every chat
        const all = Object.values(files).flat(), sum = { files: all.length, added: all.reduce((n, f) => n + f.added, 0), removed: all.reduce((n, f) => n + f.removed, 0) };
        return json({ git: true, sections: [], left: [], main: { id: 'main', kind: 'main', name: 'Project folder', branch: 'main', state: 'active', expanded: true, git: true,
          counts: sum, changes: { git: true, scope: 'uncommitted', root: '/r', prefix: '', files: all, filesTotal: all.length, totals: sum } } });
      }
      if (u.pathname === '/api/live/project/artifacts') return json({ artifacts: Object.values(arts).flat().sort((x, y) => y.updatedAt - x.updatedAt) }); // the project's: every chat's
      if (u.pathname === '/api/live/artifacts' && arts[id]) return json({ artifacts: arts[id] });
      if (u.pathname === '/api/live/docs/list' && docs[id]) return json({ docs: Object.values(docs).flat() }); // the project's docs, whichever chat asks
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
  // A joins Activity first, B after it (join order; turns started in the same second would sort by key)
  await lab.select(a);
  await page.waitFor(`!!document.querySelector(${JSON.stringify(`#projectActivity .sp-grp[data-key="${a.key}"]`)})`, 20000, 'A joined');
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
    out.push([n.tagName, String(n.className).replace(' sp-focus', ''), Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), own].join('|'));
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

panelTest('split panel: with one chat on screen Activity already lists both working chats (no pane tags); Changes and Artifacts stay single', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await page.waitFor(`document.querySelectorAll('#projectActivity .sp-grp .subagent-card').length >= 2`, 20000, 'both working chats listed');
  const st = await page.eval<Record<string, unknown>>(`({ splitOn: document.body.classList.contains('split-on'),
    keys: [...document.querySelectorAll('#projectActivity .sp-grp')].map((g) => g.dataset.key),
    tags: document.querySelectorAll('#projectActivity .sp-pane-tag').length,
    focus: [...document.querySelectorAll('#projectActivity .sp-grp.sp-focus')].map((g) => g.dataset.key) })`);
  assert(!st.splitOn, 'no split');
  assertEquals(st.keys, [a.key, b.key], 'the project\'s working chats, in the order they started');
  assertEquals(st.tags, 0, 'no pane tags without a split');
  assertEquals(st.focus, [a.key], 'the open chat has the accent');
  await page.click('#paneTab-changes');
  await settle(600);
  assert(await page.eval<boolean>(`!!document.querySelector('#projectChanges')?.offsetParent && !!document.querySelector('#changesPane .cg-bar')?.offsetParent`), 'the project Changes view');
  await page.click('#paneTab-artifacts');
  await settle(600);
  assert(await page.eval<boolean>(`!document.querySelector('.ar-split')`), 'the per-chat split dropdowns are gone: one picker');
});

panelTest('split panel: both chats in pane order on every tab, focus changes nothing, panel clicks keep focus', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await split(lab, a, b);
  // Activity: both chats, each with header, SUBAGENTS label and its helpers, a Left / Right tag on each head
  await page.waitFor(
    `(() => { const s = [...document.querySelectorAll('#projectActivity .sp-grp')]; return s.length === 2 && s.every((g) => g.querySelectorAll('.subagent-card').length > 0); })()`,
    20000,
    'Activity lists both chats with their helpers',
  ).catch(async (e) => {
    throw new Error(`${e.message}: ${await page.eval(`document.getElementById('subagentsPane').innerText.slice(0, 600)`)}`);
  });
  assert(JSON.stringify(await keysOf(page, '#projectActivity .sp-grp')) === JSON.stringify([a.key, b.key]), 'Activity in join order');
  const act = await page.eval<{ heads: string[]; labels: string[]; tags: string[] }>(`({
    heads: [...document.querySelectorAll('#projectActivity .sp-head')].map((h) => h.innerText.replace(/\\s+/g, ' ')),
    labels: [...document.querySelectorAll('#projectActivity .sp-label')].filter((n) => n.offsetParent).map((n) => n.innerText.replace(/\\s+/g, ' ')),
    tags: [...document.querySelectorAll('#projectActivity .sp-grp')].map((g) => g.querySelector('.sp-pane-tag')?.textContent || ''),
  })`);
  assert(/1 working/.test(act.heads[0]) && /1 working/.test(act.heads[1]), `headers: ${JSON.stringify(act.heads)}`);
  assert(act.labels.filter((l) => /^subagents/i.test(l)).length === 2, `labels: ${JSON.stringify(act.labels)}`);
  // the count is the working subagents only, never the finished ones (owner 2026-11-23)
  assert(act.labels.filter((l) => /^subagents/i.test(l)).every((l) => /^subagents [0-9]+ working$/i.test(l)), `working-only count: ${JSON.stringify(act.labels)}`);
  assertEquals(act.tags, ['Left', 'Right'], 'pane tags');

  // focus changes nothing in the panel, on each tab (on Activity only the accent moves to the focused chat's section)
  for (const tab of ['activity', 'changes', 'artifacts']) {
    await page.click(`#paneTab-${tab}`);
    if (tab === 'changes')
      await page.waitFor(`document.querySelectorAll('#projectChanges .cg-file').length === 3`, 15000, 'the project\'s files');
    if (tab === 'artifacts')
      await page.waitFor(`document.querySelector('#paneTab-artifacts .pane-badge')?.textContent === '3'`, 15000, "the project's three artifacts");
    await settle(1500);
    const before = await page.eval<string[]>(PANEL);
    const other = (await focusedKey(page)) === a.key ? b.key : a.key;
    await clickOther(page, other);
    const after = await page.eval<string[]>(PANEL);
    assert(before.join('\n') === after.join('\n'), `${tab}: the panel changed when focus moved:\n${diff(before, after)}`);
    assert((await page.eval<string>(`document.querySelector('#paneTabs [aria-selected="true"]').dataset.tab`)) === tab, `${tab} stays selected`);
    if (tab === 'activity')
      assertEquals(await page.eval<string[]>(`[...document.querySelectorAll('#projectActivity .sp-grp.sp-focus')].map((g) => g.dataset.key)`), [other], 'the accent moved');
  }

  // Changes: the project's one list, whichever chats are in the panes; no Merge or Discard anywhere (owner, 2026-11-16)
  await page.click('#paneTab-changes');
  assertEquals(await page.eval<string[]>(`[...document.querySelectorAll('#projectChanges > .cg-sec')].map((s) => s.dataset.sec)`), ['main'], 'one project section, not one per chat');
  assertEquals(await page.eval<number>(`document.querySelectorAll('#projectChanges .cg-file').length`), 3);
  assertEquals(await page.eval<number>(`document.querySelectorAll('#changesPane button.cg-merge-btn, #changesPane button.cg-discard, #changesPane .cg-foot button').length`), 0, 'no Merge or Discard');

  // clicks anywhere in the panel never move focus
  for (const sel of ['#paneTab-activity', '#projectActivity .sp-grp:nth-child(2) .sp-head', '#projectActivity .sp-grp:nth-child(2) .subagent-card', '#paneTab-changes', '#projectChanges .cg-file', '#projectChanges .cg-sec-head', '#paneTab-artifacts', '#artifactsPane .ar-pick']) {
    const was = await focusedKey(page);
    await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})?.offsetParent`, 10000, sel);
    await page.click(sel);
    await settle(400);
    assert((await focusedKey(page)) === was, `clicking ${sel} moved focus`);
  }
  // the one picker lists the project's artifacts, both chats', each tagged with its chat; picking B's shows it
  await page.waitFor(`!!document.querySelector('.ar-pop:not([hidden]) .ar-it[data-id="art-b1"]')`, 5000, 'the picker is open');
  const rows = await page.eval<string[]>(`[...document.querySelectorAll('.ar-pop .ar-it[data-id]')].map((r) => r.dataset.id)`);
  assertEquals(rows, ['art-a1', 'art-a2', 'art-b1'], 'newest first, both chats');
  assertEquals(await page.eval<number>(`document.querySelectorAll('.ar-pop .ar-it[data-id] .ar-chip').length`), 3, 'each row tagged with its chat');
  await page.click('.ar-pop .ar-it[data-id="art-b1"]');
  await page.waitFor(`/RSS feed plan/.test(document.querySelector('#artifactsPane .ar-pick')?.textContent || '')`, 10000, 'B shown');
  assertEquals(await page.eval<number>(`document.querySelectorAll('.ar-split, .ar-spick').length`), 0, 'one renderer, no per-pane dropdowns');
});

panelTest('split panel: the Docs tab lists the project\'s docs whichever chat is focused; the Artifacts picker has no docs group', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await split(lab, a, b);
  await page.click('#paneTab-artifacts');
  await page.waitFor(`document.querySelector('#paneTab-artifacts .pane-badge')?.textContent === '3'`, 15000, 'three artifacts');
  const was = await focusedKey(page);
  // the open chat's doc list was read before the stub went in: read it again now
  await page.eval(`AgentDocLinks.listFor(ArtifactsUI.state().chat.id, 'main', true)`);
  // the Artifacts picker lists artifacts only
  await page.click('#artifactsPane .ar-pick');
  await page.waitFor(`!!document.querySelector('.ar-pop:not([hidden]) .ar-it[data-id]')`, 8000, 'the picker is open');
  const pick = await page.eval<{ text: string; docs: number }>(`({ text: document.querySelector('.ar-pop').innerText, docs: document.querySelectorAll('.ar-pop [data-doc]').length })`);
  assert(!/Docs the chats wrote/i.test(pick.text) && pick.docs === 0, `no docs group in the Artifacts picker: ${pick.text}`);
  assert(/RSS feed plan/.test(pick.text) && /Checkout bug root cause/.test(pick.text), "both chats' artifacts are listed");
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await settle(300);
  // the Docs tab: the project's docs
  await page.click('#paneTab-docs');
  const docsOf = async () => {
    await page.waitFor(`!!document.querySelector('#docsPane .dt-row[data-doc="feed-notes"]')`, 8000, 'the doc is listed').catch(async (e) => {
      throw new Error(`${e.message}: ${await page.eval("JSON.stringify([document.querySelector('#docsPane')?.innerText, ArtifactsUI.state().chat, AgentDocLinks.cached(ArtifactsUI.state().chat.id, 'main')])")}`);
    });
    return page.eval<string[]>(`[...document.querySelectorAll('#docsPane .dt-row')].map((n) => n.dataset.doc).sort()`);
  };
  const first = await docsOf();
  assertEquals(first, ['feed-notes', 'other-notes']);
  assert((await focusedKey(page)) === was, 'opening the Docs tab did not move focus');
  // focus on the other pane: the same list
  await clickOther(page, b.key);
  assertEquals(await docsOf(), first, 'the list does not depend on the focused chat');
});

panelTest('split panel: the other chat\'s subagent and process rows open their history without moving focus; it stays open when focus moves', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await split(lab, a, b);
  await page.waitFor(`!!document.querySelector('#projectActivity .sp-grp:nth-child(2) .subagent-card')?.offsetParent`, 20000, "B's helper row");
  const hist = () =>
    page.eval<{ open: boolean; eyebrow: string; title: string; cmd: string }>(`({ open: !document.getElementById('subchatPane').hidden && !!document.getElementById('subchatPane').offsetParent,
      eyebrow: document.getElementById('inspectorEyebrow').textContent, title: document.getElementById('subchatTitle').textContent,
      cmd: document.getElementById('commandDetails').hidden ? '' : document.getElementById('commandDetails').innerText })`);
  // B (unfocused): its subagent row opens B's helper history; A keeps focus
  await page.click('#projectActivity .sp-grp:nth-child(2) .subagent-card');
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
  await page.click('#projectActivity .sp-grp:nth-child(1) .subagent-card');
  await page.waitFor(`!document.getElementById('subchatPane').hidden`, 10000, "A's history opened");
  const aTitle = (await hist()).title;
  assert(/Find rounding bug|Map tax rules/.test(aTitle), `A's helper history: ${aTitle}`);
  await clickOther(page, b.key);
  h = await hist();
  assert(h.open && h.title === aTitle, `A's history after focus moved to B: ${JSON.stringify(h)}`);
});

panelTest('split panel: the other chat’s process row opens its details without moving focus; they stay open when focus moves', async (lab) => {
  const page = lab.page;
  const a = await lab.chat();
  await a.start();
  a.say('Alpha here ALPHAEND');
  await lab.select(a);
  await page.waitFor(`!!document.querySelector(${JSON.stringify(`#projectActivity .sp-grp[data-key="${a.key}"]`)})`, 20000, 'A joined');
  const b = await lab.chat();
  await b.start(); // working (its turn stays open), so it has an Activity section
  b.say('Beta here BETAEND');
  // processes are read from a saved transcript (an unsaved live chat lists none yet): B's transcript is saved too
  const saved = lab.savedChat(b.sid);
  saved.user('Watch the feed');
  saved.say('Watching SAVEDEND');
  await stub(page, a, b);
  await lab.select(b);
  await shown(page, 'BETAEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await settle(800);
  await split(lab, a, b);
  await page.waitFor(`!!document.querySelector('#projectActivity .sp-grp:nth-child(2) .command-card')?.offsetParent`, 20000, "B's process row").catch(async (e) => {
    throw new Error(`${e.message}: ${await page.eval(`JSON.stringify({ t: document.getElementById('projectActivity')?.innerText, chats: AgentSplitUI.paneChats(),  })`)}`);
  });
  await page.click('#projectActivity .sp-grp:nth-child(2) .command-card');
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
  await page.waitFor(`document.querySelectorAll('#projectActivity .sp-grp').length === 2`, 20000, 'split Activity');
  await settle(1600);
  const inSplit = await page.eval<number[] | null>(box);
  assert(inSplit && JSON.stringify(inSplit) === JSON.stringify(single), `split × ${JSON.stringify(inSplit)} vs one chat ${JSON.stringify(single)}`);
  // nothing under it: the first header's text stops before it
  const clear = await page.eval<boolean>(`(() => { const x = document.getElementById('activityHide').getBoundingClientRect();
    return [...document.querySelectorAll('#projectActivity .sp-grp:first-child .sp-head > *')].every((n) => n.getBoundingClientRect().right <= x.left + 1); })()`);
  assert(clear, 'the first chat header does not run under the ×');
  await clickOther(page, b.key);
  assert(JSON.stringify(await page.eval(box)) === JSON.stringify(single), 'focus on B: the × did not move');
  await clickOther(page, a.key);
  assert(JSON.stringify(await page.eval(box)) === JSON.stringify(single), 'focus back on A: the × did not move');
  // it still hides Activity
  await page.click('#activityHide');
  await page.waitFor(`!document.getElementById('subagentsPane').offsetParent || document.getElementById('subagentsPane').getBoundingClientRect().width < 2`, 5000, 'Activity hidden');
});
