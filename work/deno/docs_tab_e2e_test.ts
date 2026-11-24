/**
 * The right column's Docs tab (owner, 2026-11-18; design aib-shared/designs/project-right-panel, slice S4; owner decision 2a):
 * a doc ALWAYS opens in the Docs tab, from anywhere (Files, Ctrl+K, a link or card in a chat reply, "+ New doc"), fully editable
 * there (same editor, saved, an agent's edit merges), with ← Docs back to the list and a small always-visible ⤢ that moves it to a
 * middle tab. The list is the project's aib-docs/, newest edited first, with a live "agent writing" chip while an agent writes a doc.
 * The open doc and the list scroll are remembered per project and window; opening another chat moves only the accent and never
 * closes or changes the open doc. The Artifacts tab no longer has a "Docs the chats wrote" group. Four labelled tabs fit at the 320 px
 * default.
 *
 * A real AIB (the scroll lab: temp state folder, free port; never the live ports), the scripted agent, headless Chrome or Edge.
 * The WSL variant (a fake distro helper; skips without Chrome or Edge) is docs_tab_wsl_e2e_test.ts.
 *
 * Run (from app): deno test -A ../../work/deno/docs_tab_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, type Chat, Lab, type Page, settle, shown, sleep } from './_scroll_lab.ts';

function e2e(name: string, fn: (lab: Lab) => Promise<void>) {
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
      } finally {
        await lab.close();
      }
    },
  });
}

async function openChat(lab: Lab, tag = 'READY'): Promise<Chat> {
  const chat = await lab.chat();
  await chat.start();
  chat.say(`Hello ${tag}`);
  await lab.select(chat);
  await shown(lab.page, tag);
  return chat;
}

/** An agent's doc_create through the tool route (the doc is linked to the chat, as the real tool does). Returns the doc's name. */
async function makeDoc(lab: Lab, chat: Chat, title: string, markdown: string): Promise<string> {
  const [status, r] = await lab.web.post('docs/tool', { conversationId: chat.id, tool: 'doc_create', args: { doc: title, markdown } });
  assert(status === 200 && r.ok === true, `doc_create: ${status} ${JSON.stringify(r)}`);
  return String((r.result as Record<string, unknown>).doc ?? title);
}
const read = async (lab: Lab, chat: Chat, doc: string) => {
  const [, r] = await lab.web.post('docs/tool', { conversationId: chat.id, tool: 'doc_read', args: { doc } });
  return (r.result ?? {}) as { rev: number; blocks: { id: string; h: string }[] };
};

const tab = (page: Page, id: string) => page.click(`#paneTab-${id}`);
const docsOpen = `(document.getElementById('paneTab-docs').getAttribute('aria-selected') === 'true')`;
const openName = (page: Page) => page.eval<string>(`(AgentDocsTabUI.state().doc || {}).name || ''`);
const frameReady = (page: Page) =>
  page.waitFor(
    `(() => { const f = document.querySelector('#docsPane iframe.dt-frame'), d = f && f.contentDocument; return !!(d && d.querySelector('#docApp .ProseMirror[contenteditable="true"]') && f.contentWindow.AIBDoc && f.contentWindow.AIBDoc.editor); })()`,
    25000,
    'the doc editor in the Docs tab',
  );
const frameText = (page: Page) =>
  page.eval<string>(`document.querySelector('#docsPane iframe.dt-frame').contentDocument.querySelector('#docEditor .ProseMirror').innerText`);
const noMiddleTab = (page: Page) =>
  page.eval<boolean>(`document.querySelectorAll('.sf-ftab').length === 0 && !document.body.classList.contains('sf-beside-on')`);
const rows = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('#docsPane .dt-row')].map((r) => r.dataset.doc)`);

e2e('a doc from the chat card, a chat link, Files and Ctrl+K each opens in the Docs tab, never as a middle tab', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  const plan = await makeDoc(lab, chat, 'Release plan', '# Release plan\n\nAlpha words.\n');
  const notes = await makeDoc(lab, chat, 'Team notes', '# Team notes\n\nBeta words.\n');
  const leave = async () => {
    await page.eval(`(() => { const b = document.querySelector('#docsPane .dt-back'); if (b && !b.closest('[hidden]')) b.click(); })()`);
    await tab(page, 'activity');
    await page.waitFor(`!${docsOpen}`, 5000, 'left the Docs tab');
  };
  // 1. a link in a chat reply (a chip)
  chat.say(`The plan is [Release plan](aib-doc://${plan}) LINKREADY`);
  await shown(page, 'LINKREADY');
  await page.waitFor(`!!document.querySelector('#messages a.doc-chip')`, 15000, 'the doc chip');
  await tab(page, 'activity');
  await page.click('#messages a.doc-chip');
  await page.waitFor(docsOpen, 10000, 'the Docs tab shows');
  await page.waitFor(`document.querySelector('#docsPane iframe.dt-frame')`, 10000, 'the doc frame');
  assertEquals(await openName(page), plan);
  assert(await noMiddleTab(page), 'no middle tab, nothing beside the chat');
  await frameReady(page);
  // the panel's own bar: ← Docs and ⤢, always visible
  const bar = await page.eval<Record<string, unknown>>(`(() => { const b = (s) => { const n = document.querySelector(s); const r = n && n.getBoundingClientRect(); return !!r && r.width > 0 && !n.closest('[hidden]'); };
    return { back: b('#docsPane .dt-back'), wide: b('#docsPane .dt-wide'), title: document.querySelector('#docsPane .dt-title').textContent,
      src: document.querySelector('#docsPane iframe.dt-frame').getAttribute('src') }; })()`);
  assert(bar.back === true && bar.wide === true, `← Docs and ⤢ are visible: ${JSON.stringify(bar)}`);
  assert(/where=docs/.test(String(bar.src)), `src ${bar.src}`);
  // 2. ← Docs: the list
  await page.click('#docsPane .dt-back');
  await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 2`, 10000, 'the list of two docs');
  assertEquals(await openName(page), '');
  // 3. Files: the doc row of aib-docs
  await leave();
  await page.eval(`AgentFilesUI.setMode('files')`);
  await page.waitFor(`!!document.querySelector('.fx-row[data-path="aib-docs"]')`, 20000, 'aib-docs in Files');
  if (!(await page.eval<boolean>(`!!document.querySelector('.fx-row.fx-doc')`))) await page.click('.fx-row[data-path="aib-docs"]');
  await page.waitFor(`!!document.querySelector('.fx-row.fx-doc[data-path="aib-docs/${notes}"]')`, 15000, 'the doc rows');
  await page.click(`.fx-row.fx-doc[data-path="aib-docs/${notes}"]`);
  await page.waitFor(docsOpen, 10000, 'Files: the Docs tab shows');
  await page.waitFor(`AgentDocsTabUI.state().doc && AgentDocsTabUI.state().doc.name === ${JSON.stringify(notes)}`, 10000, 'Files: the doc is open');
  assert(await noMiddleTab(page), 'Files: no middle tab');
  await frameReady(page);
  assert((await frameText(page)).includes('Beta words.'), 'Files: the doc text');
  // 4. Ctrl+K
  await leave();
  await page.eval(`AgentFilesUI.setMode('chats')`);
  await page.click('#prompt');
  await page.key('k', 2);
  await page.waitFor('document.activeElement && document.activeElement.classList.contains("switcher-input")', 5000, 'Ctrl+K');
  await page.type('Release plan');
  await page.waitFor(`[...document.querySelectorAll('#switcherList [role="option"]')].some((n) => /Release plan/.test(n.textContent) && /Doc/.test(n.textContent))`, 10000, 'the doc result');
  await page.key('Enter');
  await page.waitFor(docsOpen, 10000, 'Ctrl+K: the Docs tab shows');
  await page.waitFor(`AgentDocsTabUI.state().doc && AgentDocsTabUI.state().doc.name === ${JSON.stringify(plan)}`, 10000, 'Ctrl+K: the doc is open');
  assert(await noMiddleTab(page), 'Ctrl+K: no middle tab');
  await frameReady(page);
  chat.end();
});

e2e('the doc is editable in the Docs tab: type, it saves, an agent edit merges; ⤢ moves it to a middle tab', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  const name = await makeDoc(lab, chat, 'Launch plan', 'Intro line.\n\nAgent paragraph one.\n\nAgent paragraph two.\n');
  await tab(page, 'docs');
  await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 1`, 15000, 'the doc row');
  await page.click('#docsPane .dt-row');
  await frameReady(page);
  assert((await frameText(page)).includes('Agent paragraph two.'), 'the doc text shows');
  // type: at the end of the first paragraph, as the editor does for a keystroke
  await page.eval(`(() => { const w = document.querySelector('#docsPane iframe.dt-frame').contentWindow, v = w.AIBDoc.editor.view; let at = -1;
    v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('Intro line.')) at = pos + n.nodeSize; });
    v.dispatch(v.state.tr.insertText(' Typed by me.', at)); })()`);
  let saved = '';
  for (let i = 0; i < 100 && !saved.includes('Typed by me.'); i++) {
    await sleep(150);
    saved = JSON.stringify(await read(lab, chat, name));
  }
  assert(saved.includes('Typed by me.'), 'the typed text is saved to the doc');
  // an agent edit on another paragraph merges: both texts are in the editor, mine kept
  const r = await read(lab, chat, name);
  const target = r.blocks.find((b) => JSON.stringify(b).includes('paragraph two')) ?? r.blocks[r.blocks.length - 1];
  const [st, res] = await lab.web.post('docs/tool', {
    conversationId: chat.id,
    tool: 'doc_edit',
    args: { doc: name, ops: [{ op: 'replace', target: { kind: 'blocks', ids: [target.id] }, ifHash: target.h, ifRev: r.rev, with: { from: { kind: 'inline', content: 'Agent rewrote this.' }, as: 'markdown' } }] },
  });
  assert(st === 200 && res.ok === true, `doc_edit: ${st} ${JSON.stringify(res)}`);
  await page.waitFor(`document.querySelector('#docsPane iframe.dt-frame').contentDocument.querySelector('#docEditor .ProseMirror').innerText.includes('Agent rewrote this.')`, 10000, "the agent's edit merged");
  const text = await frameText(page);
  assert(text.includes('Typed by me.') && text.includes('Agent rewrote this.'), `both texts are there: ${text}`);
  // ⤢: the doc leaves the panel (back to the list) and opens in a middle tab
  assert(await page.eval<boolean>(`!!document.querySelector('#docsPane .dt-wide') && document.querySelector('#docsPane .dt-wide').getBoundingClientRect().width > 0`), '⤢ is visible');
  await page.click('#docsPane .dt-wide');
  await page.waitFor(`document.querySelectorAll('.sf-ftab').length === 1`, 10000, 'a middle tab');
  await page.waitFor(`!!document.querySelector('iframe.sf-docframe')`, 10000, 'the middle doc frame');
  assertEquals(await openName(page), '', 'the Docs tab shows its list again');
  assertEquals(await page.eval<number>(`document.querySelectorAll('#docsPane iframe').length`), 0, 'no second copy in the panel');
  chat.end();
});

e2e('the Docs tab header has an always-visible pop-out: the doc moves to its own window and leaves the panel', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  const name = await makeDoc(lab, chat, 'Pop plan', 'Pop text.\n');
  // the app's window route (K3) answered by a stand-in: record the ask, hand back window w2 (as the fake desktop windows do in doc_popout_e2e)
  await page.eval(`(() => { window.__asks = []; const f = window.fetch; window.fetch = (u, o) => {
    if (String(u).includes('/api/live/desktop/windows')) { window.__asks.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true, w: 'w2' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
    return f.call(window, u, o); }; })()`);
  await tab(page, 'docs');
  await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 1`, 15000, 'the doc row');
  await page.click('#docsPane .dt-row');
  await frameReady(page);
  assert(
    await page.eval<boolean>(`(() => { const n = document.querySelector('#docsPane .dt-pop'); const r = n && n.getBoundingClientRect(); return !!r && r.width > 0 && !n.closest('[hidden]'); })()`),
    'the pop-out button is visible without hovering',
  );
  assertEquals(await page.eval<string>(`document.querySelector('#docsPane .dt-pop').title`), 'Pop out this doc into its own window');
  await page.click('#docsPane .dt-pop');
  await page.waitFor(`window.__asks.length === 1`, 10000, 'the doc window was asked for');
  const ask = await page.eval<Record<string, unknown>>(`window.__asks[0]`);
  assertEquals(ask.op, 'popout');
  assertEquals((ask.doc as Record<string, unknown>).name, name, 'by the doc name');
  assert(typeof (ask.doc as Record<string, unknown>).project === 'string' && (ask.doc as Record<string, unknown>).project !== '', 'and the project key');
  await page.waitFor(`AgentDocsTabUI.state().doc === null`, 10000, 'the doc left the panel');
  assertEquals(await openName(page), '', 'the Docs tab shows its list again');
  assertEquals(await page.eval<number>(`document.querySelectorAll('#docsPane iframe').length`), 0, 'no copy left in the panel');
  assert(await noMiddleTab(page), 'no middle tab either');
  chat.end();
});

e2e('the Docs list is newest edited first, "+ New doc" makes and opens one, and a writing chip is live while an agent writes', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  const a = await makeDoc(lab, chat, 'Older doc', 'Old text.\n');
  await sleep(1100);
  const b = await makeDoc(lab, chat, 'Newer doc', 'New text.\n');
  await tab(page, 'docs');
  await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 2`, 15000, 'two rows');
  assertEquals(await rows(page), [b, a], 'newest edited first');
  assert(await page.eval<boolean>(`document.querySelector('#paneTab-docs .pane-badge') === null`), 'Docs has no count badge');
  // a doc edited later moves to the top
  await sleep(1100);
  const r = await read(lab, chat, a);
  await lab.web.post('docs/tool', {
    conversationId: chat.id,
    tool: 'doc_edit',
    args: { doc: a, ops: [{ op: 'replace', target: { kind: 'blocks', ids: [r.blocks[0].id] }, ifHash: r.blocks[0].h, ifRev: r.rev, with: { from: { kind: 'inline', content: 'Old text, edited.' }, as: 'markdown' } }] },
  });
  // the writing chip (the agent's turn is running, so it still writes): on the row, and the tab's dot while on another tab
  await page.waitFor(`!!document.querySelector('#docsPane .dt-row[data-doc="${a}"] .dt-writing')`, 15000, 'the writing chip on the row');
  const chip = await page.eval<string>(`document.querySelector('#docsPane .dt-row[data-doc="${a}"] .dt-writing').textContent`);
  assert(/Claude Code writing/.test(chip), `chip: ${chip}`);
  assertEquals(await rows(page), [a, b], 'the edited doc is on top');
  await tab(page, 'activity');
  await page.waitFor(`!document.querySelector('#paneTab-docs .pane-dot').hidden`, 15000, "the tab's live dot");
  // the turn ends: the chip and the dot go
  chat.end();
  await page.waitFor(`document.querySelector('#paneTab-docs .pane-dot').hidden`, 20000, 'the dot goes at turn end');
  await tab(page, 'docs');
  await page.waitFor(`!document.querySelector('#docsPane .dt-writing')`, 10000, 'the chip goes');
  // + New doc: a name field, Enter makes it and opens it in the panel
  await page.click('#docsPane .dt-newrow');
  await page.waitFor(`!!document.querySelector('#docsPane .dt-name')`, 5000, 'the name field');
  assertEquals(await page.eval<string>(`document.querySelector('#docsPane .dt-name').value`), 'Untitled doc');
  await page.eval(`(() => { const i = document.querySelector('#docsPane .dt-name'); i.value = 'Fresh start'; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await page.waitFor(`AgentDocsTabUI.state().doc && /fresh-start/i.test(AgentDocsTabUI.state().doc.name)`, 15000, 'the new doc is open in the panel');
  await frameReady(page);
  assert(await noMiddleTab(page), '+ New doc: no middle tab');
  await page.click('#docsPane .dt-back');
  await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 3`, 10000, 'three rows');
  // a name that is taken is refused with a message and keeps the field
  await page.click('#docsPane .dt-newrow');
  await page.eval(`(() => { const i = document.querySelector('#docsPane .dt-name'); i.value = 'Fresh start'; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await page.waitFor(`!!document.querySelector('#docsPane .dt-error')`, 10000, 'the name-taken message');
});

e2e('opening another chat moves only the accent: the open doc, its frame and the list scroll stay; they are remembered per project and window over a reload', async (lab) => {
  const page = lab.page;
  const one = await openChat(lab, 'ONEREADY');
  const two = await lab.chat();
  await two.start();
  two.say('Hello TWOREADY');
  const name = await makeDoc(lab, one, 'Keep me open', 'Stay here.\n');
  for (let i = 0; i < 14; i++) await makeDoc(lab, one, `Filler doc ${String(i).padStart(2, '0')}`, 'Filler.\n');
  await tab(page, 'docs');
  await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 15`, 20000, 'fifteen rows');
  // the list scroll is remembered
  await page.eval(`document.querySelector('#docsPane .dt-list').scrollTop = 180`);
  await page.waitFor(`document.querySelector('#docsPane .dt-list').scrollTop > 100`, 5000, 'the list scrolled');
  const scroll = await page.eval<number>(`document.querySelector('#docsPane .dt-list').scrollTop`);
  await settle(300);
  // (a script click: a mouse click would scroll the row into view first and change the scroll being remembered)
  await page.eval(`document.querySelector('#docsPane .dt-row[data-doc="${name}"]').click()`);
  await frameReady(page);
  await page.eval(`window.__frame = document.querySelector('#docsPane iframe.dt-frame')`);
  const panel = await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`);
  // another chat of the project opens: nothing in the panel changes
  await lab.select(two);
  await shown(page, 'TWOREADY');
  await settle(800);
  assert(await page.eval<boolean>(`window.__frame === document.querySelector('#docsPane iframe.dt-frame') && window.__frame.isConnected`), 'the same doc frame, not reloaded');
  assertEquals(await openName(page), name);
  assert(await page.eval<boolean>(docsOpen), 'still on the Docs tab');
  assertEquals(await page.eval<number>(`Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width)`), panel, 'the panel width did not move');
  // reload: the same project and window bring the open doc back
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(one);
  await shown(page, 'ONEREADY');
  await page.waitFor(`AgentDocsTabUI.state().doc && AgentDocsTabUI.state().doc.name === ${JSON.stringify(name)}`, 15000, 'the open doc came back');
  await frameReady(page);
  assert(await page.eval<boolean>(docsOpen), 'the Docs tab came back');
  await page.click('#docsPane .dt-back');
  await page.waitFor(`document.querySelectorAll('#docsPane .dt-row').length === 15`, 15000, 'the list again');
  await page.waitFor(`Math.abs(document.querySelector('#docsPane .dt-list').scrollTop - ${scroll}) <= 2`, 10000, `the list scroll comes back (${scroll})`).catch(async (e) => {
    throw new Error(`${e.message}: ${await page.eval<string>(`JSON.stringify([AgentDocsTabUI.state(), localStorage.getItem(Object.keys(localStorage).find((k) => k.includes('studio-docs-tab')) || ''), document.querySelector('#docsPane .dt-list').scrollHeight, document.querySelector('#docsPane .dt-list').clientHeight])`)}`);
  });
  one.end();
  two.end();
});

e2e('four labelled tabs fit at the 320 px default (badges lit, widen button in); Artifacts has no docs group', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  await makeDoc(lab, chat, 'Some doc', 'Words.\n');
  const geo = () =>
    page.eval<Record<string, unknown>>(`(() => { const t = document.getElementById('paneTabs');
      const out = { panel: Math.round(document.getElementById('subagentsPane').getBoundingClientRect().width), rowW: t.clientWidth, scrollW: t.scrollWidth, tabs: [] };
      for (const b of t.querySelectorAll('.pane-tab')) { const l = b.querySelector('.pane-tab-label'), ico = b.querySelector('.pane-tab-ico');
        out.tabs.push({ id: b.dataset.tab, w: Math.round(b.getBoundingClientRect().width), label: getComputedStyle(l).display !== 'none', ico: getComputedStyle(ico).display !== 'none',
          cut: l.scrollWidth > l.clientWidth, right: Math.round(b.getBoundingClientRect().right) }); }
      const e = t.querySelector('.pane-expand'); out.expand = e && !e.hidden ? Math.round(e.getBoundingClientRect().right) : null;
      out.rowRight = Math.round(t.getBoundingClientRect().right); out.n = out.tabs.length; return out; })()`);
  // every badge and the live dot lit, on a tab that shows the widen button
  await page.eval(`(() => { for (const b of document.querySelectorAll('#paneTabs .pane-badge')) { b.hidden = false; b.textContent = '12'; }
    document.querySelector('#paneTab-docs .pane-dot').hidden = false; })()`);
  await tab(page, 'changes');
  await page.waitFor(`!document.querySelector('#paneTabs .pane-expand').hidden`, 10000, 'the widen button');
  const g = await geo();
  assertEquals(g.panel, 320, 'the default panel is 320 px');
  assertEquals(g.n, 4, 'four tabs');
  const tabs = g.tabs as { id: string; label: boolean; ico: boolean; cut: boolean }[];
  assert(tabs.every((t) => t.label && !t.ico && !t.cut), `four labelled tabs, none cut: ${JSON.stringify(g)}`);
  assert(Number(g.scrollW) <= Number(g.rowW), `the tab row does not overflow: ${JSON.stringify(g)}`);
  assert(Number(g.expand) <= Number(g.rowRight), `the widen button stays in the row: ${JSON.stringify(g)}`);
  assert(tabs.map((t) => t.id).join() === 'activity,changes,artifacts,docs', 'the order: Activity, Changes, Artifacts, Docs');
  // Docs: no count, label in the tooltip and aria label
  assertEquals(await page.eval<string>(`document.getElementById('paneTab-docs').title + '|' + document.getElementById('paneTab-docs').getAttribute('aria-label')`), 'Docs|Docs');
  // Artifacts: a doc a chat wrote is not listed there (it is in the Docs tab)
  await tab(page, 'artifacts');
  await settle(600);
  assert(await page.eval<boolean>(`!document.querySelector('#artifactsPane .ar-docs-empty, #artifactsPane .ar-doc') && !/Docs the chats wrote/.test(document.getElementById('artifactsPane').textContent)`), 'no docs group in Artifacts');
  await page.eval(`document.getElementById('paneTab-artifacts').click()`);
  const pop = await page.eval<boolean>(`(() => { const p = document.querySelector('#artifactsPane .ar-pick'); return !!p && !p.disabled && !!p.offsetParent; })()`);
  if (pop) {
    await page.click('#artifactsPane .ar-pick');
    assert(await page.eval<boolean>(`!/Docs the chats wrote/.test(document.querySelector('#artifactsPane .ar-pop').textContent)`), 'no docs group in the picker');
  }
  // below 320: the icons (the container query is measured on the tab row)
  await page.eval(`localStorage.setItem('studio-layout-v1:<1800', JSON.stringify({ activity: 280 }))`);
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(chat);
  await shown(page, 'READY');
  await settle(500);
  const n = await geo();
  assertEquals(n.panel, 280);
  assert((n.tabs as { label: boolean; ico: boolean }[]).every((t) => t.ico && !t.label), `280 px: icon tabs ${JSON.stringify(n)}`);
  chat.end();
});
