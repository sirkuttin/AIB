/**
 * Where docs and files open, end to end (beta.8): a real Studio (Deno web server + in-process agent host, temp state folder, free
 * port; never the live ports), the scripted agent work/scroll-fixture/agent.py, and a headless Chrome/Edge on chat.html (no window).
 *
 *  - An agent making a doc while you type: the doc shows in the right column's Artifacts tab in the background (the tab's count
 *    goes up, its row is marked new); no tab opens, nothing opens beside the chat, the message box keeps the focus and the text.
 *  - Open doc on the doc card: the doc opens in the Artifacts viewer, in the full doc editor, and fits the column.
 *  - A file named in a reply still opens beside the chat on a wide window, at 45 % of the room between the chat list and the right
 *    column. Its divider drags within the minimums (pane 360 px, chat 420 px), the width survives a reload, double-click resets it,
 *    and the arrow keys move it.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/doc_open_e2e_test.ts
 */
import { assert } from './_assert.ts';
import { browserPath, type Chat, Lab, type Page, settle, shown, sleep } from './_scroll_lab.ts';

function e2e(name: string, fn: (lab: Lab) => Promise<void>, size: [number, number] = [1600, 900]) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(size[0], size[1]);
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
      } finally {
        await lab.close();
      }
    },
  });
}

/** A chat with a running turn, open on screen. */
async function openChat(lab: Lab): Promise<Chat> {
  const chat = await lab.chat();
  await chat.start();
  chat.say('Hello READY');
  await lab.select(chat);
  await shown(lab.page, 'READY');
  return chat;
}

const badge = (page: Page) => page.eval<string>(`(document.querySelector('#paneTab-artifacts .pane-badge:not([hidden])') || {}).textContent || ''`);

/** The agent makes a doc: the doc_create row runs, the doc is made (linked to the chat, as the real tool does), the row finishes. */
async function agentMakesDoc(lab: Lab, chat: Chat, title: string): Promise<string> {
  chat.tool('mk-doc', 'mcp__studio_artifact__doc_create', 'in_progress', { rawInput: { doc: title } });
  await lab.page.waitFor(`!!document.querySelector('#messages .doc-tool')`, 15000, 'the running doc row');
  const [status, made] = await lab.web.post('docs/open', { id: chat.id, name: title, create: '' });
  assert(status === 200, `docs/open: ${status} ${JSON.stringify(made)}`);
  const name = String(made.name);
  chat.toolDone('mk-doc', JSON.stringify({ ok: true, doc: name, docTitle: title, created: true, pages: [{ id: 'p1', title: 'Page 1' }] }));
  await lab.page.waitFor(`!!document.querySelector('#messages .doc-card')`, 15000, 'the doc card');
  return name;
}

e2e('an agent-made doc shows in the Artifacts tab in the background: count up, row marked new, no tab, the message box keeps the focus', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  await page.click('#prompt');
  await page.type('half a thought');
  assert((await badge(page)) === '', 'no count before');
  const name = await agentMakesDoc(lab, chat, 'Launch notes');
  await page.waitFor(`(document.querySelector('#paneTab-artifacts .pane-badge:not([hidden])') || {}).textContent === '1'`, 10000, 'the count goes to 1');
  const st = await page.eval<Record<string, unknown>>(`(() => ({
    fresh: ArtifactsUI.state().fresh,
    doc: ArtifactsUI.state().doc,
    focus: document.activeElement && document.activeElement.id,
    text: document.getElementById('prompt').value,
    fileTabs: document.querySelectorAll('.sf-ftab').length,
    beside: document.body.classList.contains('sf-beside-on'),
    frames: document.querySelectorAll('iframe.sf-docframe, iframe.ar-docframe').length,
    label: document.getElementById('paneTab-artifacts').getAttribute('aria-label'),
  }))()`);
  assert(st.fresh === 'doc:' + name, `marked new: ${st.fresh}`);
  assert(st.doc === null, 'not opened');
  assert(st.focus === 'prompt' && st.text === 'half a thought', `focus ${st.focus}, text ${st.text}`);
  assert(st.fileTabs === 0 && !st.beside && st.frames === 0, `no tab, nothing beside: ${JSON.stringify(st)}`);
  assert(/1 doc/.test(String(st.label)) && /new/.test(String(st.label)), `tab label: ${st.label}`);
  // the Artifacts tab: the doc row is marked new, with no ↗
  await page.click('#paneTab-artifacts');
  await page.waitFor(`!!document.querySelector('.ar-empty .ar-doc.ar-new .ar-newdot')`, 8000, 'the marked doc row');
  const row = await page.eval<string>(`document.querySelector('.ar-empty .ar-doc').textContent`);
  assert(!row.includes('↗'), `no arrow: ${row}`);
  chat.end();
});

e2e('Open doc on the card opens the doc in the Artifacts viewer, in the full editor, and it fits the column', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  await agentMakesDoc(lab, chat, 'Release plan');
  await page.click('.doc-card .art-btn');
  await page.waitFor(`!!document.querySelector('#artifactsPane .ar-stage iframe.ar-docframe')`, 10000, 'the doc frame in the viewer');
  const st = await page.eval<Record<string, unknown>>(`(() => ({
    tab: document.getElementById('paneTab-artifacts').getAttribute('aria-selected'),
    pick: document.querySelector('#artifactsPane .ar-pick').textContent,
    ver: document.querySelector('#artifactsPane .ar-ver').hidden,
    fileTabs: document.querySelectorAll('.sf-ftab').length,
    beside: document.body.classList.contains('sf-beside-on'),
    src: document.querySelector('iframe.ar-docframe').getAttribute('src'),
  }))()`);
  assert(st.tab === 'true', 'the Artifacts tab shows');
  assert(/doc\s*Release plan/.test(String(st.pick)), `picker: ${st.pick}`);
  assert(st.ver === true, 'no version chip for a doc');
  assert(st.fileTabs === 0 && !st.beside, 'no tab, nothing beside the chat');
  assert(/where=artifacts/.test(String(st.src)), `src ${st.src}`);
  // the editor loads and is editable, with no sideways scroll at the column's width
  await page.waitFor(
    `(() => { const d = document.querySelector('iframe.ar-docframe').contentDocument; return d && d.querySelector('#docApp .ProseMirror[contenteditable="true"]'); })() && true`,
    20000,
    'the doc editor',
  );
  const fit = await page.eval<Record<string, unknown>>(`(() => {
    const f = document.querySelector('iframe.ar-docframe'), d = f.contentDocument, app = d.getElementById('docApp');
    return { w: f.clientWidth, scroll: d.documentElement.scrollWidth, client: d.documentElement.clientWidth,
      narrow: app.classList.contains('narrow'), picker: !d.getElementById('pagePicker').hidden,
      more: getComputedStyle(d.querySelector('.tbar .tb-more')).display };
  })()`);
  assert(Number(fit.w) > 200, `frame width ${fit.w}`);
  assert(Number(fit.scroll) <= Number(fit.client) + 1, `no sideways scroll: ${fit.scroll} > ${fit.client}`);
  // the column widens for a doc (920 px by default, less on a small window): below 900 px the pages are a header picker
  assert(Number(fit.w) >= 600, `the column widened for the doc: ${fit.w}`);
  if (Number(fit.w) < 900) assert(fit.picker === true, `pages as a header picker below 900 px: ${JSON.stringify(fit)}`);
  await page.shot('doc-in-artifacts');
  chat.end();
});

/** The pane beside the chat, measured: its width, the room between the chat list and the right column, the chat's width. */
const besideBox = (page: Page) =>
  page.eval<{ pane: number; room: number; chat: number; left: number; right: number }>(`(() => {
    const b = document.getElementById('fileBeside').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect();
    const css = (n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)) || 0;
    const room = m.width - css('--side-w') - (document.body.classList.contains('activity-off') ? 0 : css('--activity-w'));
    return { pane: Math.round(b.width), room: Math.round(room), chat: Math.round(room - b.width), left: Math.round(b.left), right: Math.round(b.right) };
  })()`);

async function drag(page: Page, dx: number) {
  const [x, y] = await page.eval<[number, number]>(
    `(() => { const r = document.getElementById('fileBesideDivider').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 5, y, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y, button: 'left', clickCount: 1 });
  await sleep(150);
}

async function openFileFromReply(lab: Lab, chat: Chat) {
  Deno.writeTextFileSync(`${lab.fx.workspace}\\notes.txt`, 'line one\nline two\n');
  chat.say('I wrote the summary to notes.txt FILEREADY');
  await shown(lab.page, 'FILEREADY');
  await lab.page.waitFor(`!!document.querySelector('#messages a.fx-path')`, 15000, 'the file link');
  await lab.page.click('#messages a.fx-path');
  await lab.page.waitFor(`document.body.classList.contains('sf-beside-on') && !document.getElementById('fileBeside').hidden`, 10000, 'the file beside the chat');
  await settle(300);
}

e2e('a file from a reply opens beside the chat at 45 %; the divider drags within the minimums, survives a reload, resets on double-click, moves with the arrow keys', async (lab) => {
  const page = lab.page;
  const chat = await openChat(lab);
  await openFileFromReply(lab, chat);
  let b = await besideBox(page);
  assert(Math.abs(b.pane - Math.round(b.room * 0.45)) <= 2, `45 % of the room: ${JSON.stringify(b)}`);
  const div = await page.eval<Record<string, unknown>>(`(() => { const h = document.getElementById('fileBesideDivider'); const r = h.getBoundingClientRect();
    return { role: h.getAttribute('role'), tab: h.tabIndex, now: h.getAttribute('aria-valuenow'), x: Math.round(r.left + r.width / 2) }; })()`);
  assert(div.role === 'separator' && div.tab === 0, 'a focusable separator');
  assert(Math.abs(Number(div.x) - b.left) <= 4, `the divider sits on the pane's edge: ${div.x} vs ${b.left}`);
  // drag 150 px left: the pane grows by 150, the chat shrinks by 150
  await drag(page, -150);
  const grown = await besideBox(page);
  assert(Math.abs(grown.pane - (b.pane + 150)) <= 3, `grew by 150: ${b.pane} -> ${grown.pane}`);
  // far left: the chat keeps 420 px
  await drag(page, -3000);
  const most = await besideBox(page);
  assert(Math.abs(most.chat - 420) <= 2, `chat keeps 420: ${JSON.stringify(most)}`);
  // far right: the pane keeps 360 px
  await drag(page, 3000);
  const least = await besideBox(page);
  assert(Math.abs(least.pane - 360) <= 2, `pane keeps 360: ${JSON.stringify(least)}`);
  // a chosen width survives a reload (as a fraction of the room)
  await drag(page, -200);
  const chosen = await besideBox(page);
  await page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  await lab.select(chat);
  await openFileFromReply(lab, chat);
  b = await besideBox(page);
  assert(Math.abs(b.pane - chosen.pane) <= 3, `kept after a reload: ${chosen.pane} -> ${b.pane}`);
  // double-click resets to 45 %
  const [x, y] = await page.eval<[number, number]>(
    `(() => { const r = document.getElementById('fileBesideDivider').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  );
  for (const n of [1, 2]) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n });
  }
  await sleep(150);
  b = await besideBox(page);
  assert(Math.abs(b.pane - Math.round(b.room * 0.45)) <= 2, `reset to 45 %: ${JSON.stringify(b)}`);
  // keyboard: ArrowLeft grows by 16, Shift+ArrowRight shrinks by 64
  await page.eval(`(() => { const h = document.getElementById('fileBesideDivider'); h.focus();
    h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); })()`);
  const k1 = await besideBox(page);
  assert(Math.abs(k1.pane - (b.pane + 16)) <= 2, `ArrowLeft: ${b.pane} -> ${k1.pane}`);
  await page.eval(`document.getElementById('fileBesideDivider').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))`);
  const k2 = await besideBox(page);
  assert(Math.abs(k2.pane - (k1.pane - 64)) <= 2, `Shift+ArrowRight: ${k1.pane} -> ${k2.pane}`);
  chat.end();
});
