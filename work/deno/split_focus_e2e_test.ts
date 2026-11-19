/**
 * Split view, focus moving between panes: no blank, white frame. A real Studio (the scroll lab: Deno web server + in-process
 * agent host, temp state folder, free port; never the live ports), two scripted live chats side by side, headless Chrome/Edge.
 *
 * The bug (owner, 2026-11-14): with two chats side by side, clicking into the other pane flashed the screen white. Focusing a pane
 * opens its chat in the real view (split-ui.js focusPane -> chat.js openConversation), and beginConversation cleared the message
 * list to "Loading conversation…" until the rows were fetched again, while the pane you left got an empty copy until its next
 * poll. Now the panes swap their drawn rows in the same task (chat.js splitSwap / takeLeft, split-ui.js drawMirror).
 *
 * Every frame and every DOM change during a switch is checked: the focused pane's list and the other pane's copy both hold rows,
 * and no "Loading conversation…" shows. Both panes keep updating live; both chats count as open (no inbox row, toast or desktop
 * notification: AgentWorkspaceUI.openKeys and the presence report the server reads); the place you read is kept.
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/split_focus_e2e_test.ts   (ignored without Chrome or Edge)
 */
import { assert } from './_assert.ts';
import { browserPath, type Chat, clickHere, Lab, ownerProblems, type Page, settle, shown, wheel } from './_scroll_lab.ts';

function splitTest(name: string, fn: (lab: Lab) => Promise<void>) {
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

function seed(chat: Chat, n: number, tag: string) {
  for (let i = 0; i < n; i++) {
    chat.say(`${tag} message ${i}. ` + 'Some words to fill a line or two, so the list is taller than its pane. '.repeat(4));
    chat.tool(`${tag}-${i}`, `Read ${tag.toLowerCase()} file ${i}`, 'completed');
  }
}

/** Two live chats, A in the focused pane (the real view) and B in the other pane (its copy). */
async function openSplit(lab: Lab) {
  const page = lab.page;
  // the presence reports the page sends (the server leaves the chats in them out of desktop notifications)
  await page.eval(`(() => {
    const sent = (window.__presence = []), real = window.fetch.bind(window);
    window.fetch = (url, init) => {
      try { if (String(url).includes('presence') && init && init.body) sent.push(JSON.parse(init.body)); } catch {}
      return real(url, init);
    };
    // what the page hands the toasts and desktop notifications (selected: open in the window, never notified)
    const seen = (window.__notified = []), N = window.AgentNotifyUI, obs = N.observeItems.bind(N);
    N.observeItems = (items) => { seen.push(items.map((i) => ({ key: i.key, selected: i.selected }))); if (seen.length > 50) seen.shift(); return obs(items); };
  })()`);
  const a = await lab.chat();
  await a.start();
  seed(a, 30, 'Alpha');
  a.say('Alpha done ALPHAEND');
  const b = await lab.chat();
  await b.start();
  seed(b, 30, 'Beta');
  b.say('Beta done BETAEND');
  await lab.select(b);
  await shown(page, 'BETAEND');
  await lab.select(a);
  await shown(page, 'ALPHAEND');
  await settle(800);
  await page.eval(`AgentSplitUI.splitTab(${JSON.stringify(b.key)}, 'row')`);
  await page.waitFor(`AgentSplitUI.panes().length === 2 && !!document.querySelector('.mirror-msgs')`, 15000, 'two panes');
  await settle(1500);
  await page.eval(`(() => { const p = AgentSplitUI.panes().find((p) => p.group.active === ${JSON.stringify(a.key)}); if (p && !p.focused) AgentSplitUI.focusPane(p.id); })()`);
  await page.waitFor(
    `(() => { const m = document.querySelector('#splitStage .pane:not(.foc) .mirror-msgs');
      return !!m && m.dataset.mirror === ${JSON.stringify(b.key)} && m.textContent.includes('BETAEND')
        && !!document.querySelector('#splitStage .pane.foc #messages') && document.getElementById('messages').textContent.includes('ALPHAEND'); })()`,
    20000,
    'A focused, B in the other pane',
  ).catch(async (e) => {
    const st = await page.eval(`JSON.stringify({ panes: AgentSplitUI.panes().map((p) => [p.group.active, p.focused]), mirror: document.querySelector('.mirror-msgs')?.dataset.mirror, a: ${JSON.stringify(a.key)}, b: ${JSON.stringify(b.key)}, msgs: document.getElementById('messages').textContent.slice(-80) })`);
    throw new Error(`${e.message}: ${st}`);
  });
  await settle(1500);
  return { a, b };
}

/** The other pane's header (its title: a click there only focuses the pane): the copy of the real header, or the plain stand-in. */
const OTHER_HEAD = '#splitStage .pane:not(.foc) :is(.mirror-copy > header [data-mid="title"], .mirror-head)';

/** Watch every frame and every DOM change in the panes until stopWatch: both panes must always hold rows. */
function startWatch(page: Page) {
  return page.eval(`(() => {
    const w = (window.__watch = { frames: 0, changes: 0, bad: [], on: true });
    const rows = (b) => (b ? [...b.children].filter((e) => !e.classList.contains('empty-state')).length : 0);
    const check = (when) => {
      const foc = document.querySelector('#splitStage .pane.foc'),
        side = document.querySelector('#splitStage .pane:not(.foc)');
      const fm = foc && foc.querySelector('#messages'),
        sm = side && side.querySelector('.mirror-msgs');
      const loading = !!(fm && fm.querySelector(':scope > .empty-state'));
      const fc = rows(fm), sc = rows(sm);
      if (!fm || !sm || !fc || !sc || loading || fm.hidden || !fm.clientHeight || !sm.clientHeight)
        w.bad.push(when + ': focused pane ' + (fm ? fc + ' rows' + (loading ? ' + "' + fm.textContent.slice(0, 40) + '"' : '') : 'without the list') +
          ', other pane ' + (sm ? sc + ' rows' : 'without a copy'));
    };
    const mo = new MutationObserver(() => { if (w.on) { w.changes++; check('change ' + w.changes); } });
    mo.observe(document.getElementById('splitStage'), { childList: true, subtree: true });
    const tick = () => {
      if (!w.on) return mo.disconnect();
      w.frames++;
      check('frame ' + w.frames);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}
function stopWatch(page: Page) {
  return page.eval<{ frames: number; changes: number; bad: string[] }>(`(() => { const w = window.__watch; w.on = false; return w; })()`);
}

/** Click the other pane (its header: what a click anywhere in the pane does) and watch the switch. */
async function switchFocus(page: Page, want: string) {
  await startWatch(page);
  await settle(300);
  await page.click(OTHER_HEAD);
  await page.waitFor(
    `document.getElementById('messages').textContent.includes(${JSON.stringify(want)}) && !!document.querySelector('#splitStage .pane.foc #messages')`,
    15000,
    'the clicked pane focused',
  );
  await settle(2500); // the opened chat's rows fetched and drawn again, a poll or two of the other pane
  const w = await stopWatch(page);
  assert(w.frames > 20, `frames watched: ${w.frames}`);
  assert(!w.bad.length, `a pane was blank during the focus switch (${w.bad.length} of ${w.frames} frames / ${w.changes} changes):\n${w.bad.slice(0, 8).join('\n')}`);
}

const openKeys = (page: Page) => page.eval<string[]>(`AgentWorkspaceUI.openKeys()`);
async function bothOpen(page: Page, a: Chat, b: Chat, when: string) {
  const open = await openKeys(page);
  assert(open.includes(a.key) && open.includes(b.key), `${when}: open chats ${JSON.stringify(open)}`);
  await page.waitFor(
    `(() => { const p = window.__presence.at(-1); return !!p && p.open.includes(${JSON.stringify(a.key)}) && p.open.includes(${JSON.stringify(b.key)}); })()`,
    25000,
    `${when}: the presence report names both chats`,
  );
  // the toasts and desktop notifications (workspace-ui.js notifyChats -> notify-ui.js decide) leave open chats out
  const flags = await page.eval<Record<string, boolean>>(
    `Object.fromEntries((window.__notified.at(-1) || []).filter((i) => [${JSON.stringify(a.key)}, ${JSON.stringify(b.key)}].includes(i.key)).map((i) => [i.key, i.selected]))`,
  );
  assert(flags[a.key] === true && flags[b.key] === true, `${when}: notify items not marked open: ${JSON.stringify(flags)}`);
}

splitTest('SF1 split view: focusing the other pane never blanks either pane; both stay live; both count as open', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  await bothOpen(page, a, b, 'before the switch');

  await switchFocus(page, 'BETAEND');
  assert(
    await page.eval<boolean>(`document.querySelector('#splitStage .pane:not(.foc) .mirror-msgs').dataset.mirror === ${JSON.stringify(a.key)}`),
    'A moved to the other pane',
  );
  // both panes keep updating: B in the real view, A in its copy
  b.say('\n\nNew in B BLIVE1');
  a.say('\n\nNew in A ALIVE1');
  await shown(page, 'BLIVE1');
  await page.waitFor(`document.querySelector('.mirror-msgs').textContent.includes('ALIVE1')`, 15000, 'the update in the other pane');
  await bothOpen(page, a, b, 'after the switch');

  // and back again
  await switchFocus(page, 'ALIVE1');
  b.say('\n\nNew in B BLIVE2');
  a.say('\n\nNew in A ALIVE2');
  await shown(page, 'ALIVE2');
  await page.waitFor(`document.querySelector('.mirror-msgs').textContent.includes('BLIVE2')`, 15000, 'the update in the other pane');
  await bothOpen(page, a, b, 'after switching back');
  // B (in the other pane) finishes its turn: it is in front of you, so no Finished row in the inbox and no toast
  b.end();
  await settle(3500);
  const inbox = await page.eval<string[]>(`AgentWorkspaceUI._inboxKeys()`);
  assert(!inbox.includes(b.key) && !inbox.includes(a.key), `an inbox row for a chat shown in a pane: ${JSON.stringify(inbox)}`);
  await bothOpen(page, a, b, 'after B finished');
  a.end();
});

/** The row at the top of a list's view (its text) and the gap under the view. */
const place = (page: Page, sel: string) =>
  page.eval<{ text: string; gap: number }>(`(() => {
    const b = document.querySelector(${JSON.stringify(sel)}), top = b.getBoundingClientRect().top;
    let text = '';
    for (const e of b.children) { const r = e.getBoundingClientRect(); if (r.height && r.bottom > top + 1) { text = e.textContent.replace(/\\s+/g, ' ').slice(0, 60); break; } }
    return { text, gap: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) };
  })()`);

splitTest('SF2 split view: a focus switch keeps each chat where you read it', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  for (let i = 0; i < 10; i++) await wheel(page, -150, 'messages'); // read A midway
  await settle(900);
  const readA = await place(page, '#messages');
  assert(readA.gap > 600 && readA.text, `reading A midway: ${JSON.stringify(readA)}`);
  const sideB = await place(page, '#splitStage .pane:not(.foc) .mirror-msgs');
  assert(sideB.gap <= 1, `B's copy at the bottom: ${JSON.stringify(sideB)}`);

  await switchFocus(page, 'BETAEND');
  const nowB = await place(page, '#messages'), nowA = await place(page, '#splitStage .pane:not(.foc) .mirror-msgs');
  assert(nowB.gap <= 1, `B, focused, still at the bottom: ${JSON.stringify(nowB)}`);
  assert(nowA.text === readA.text && nowA.gap > 300, `A's copy at the row read: ${JSON.stringify(nowA)}, read ${JSON.stringify(readA)}`);
  a.end();
  b.end();
});

/** Every frame of a focus switch: each pane's message list (the real one or the copy) keeps its exact box and its place. */
function startGeom(page: Page) {
  return page.eval(`(() => {
    const w = (window.__geom = { frames: 0, bad: [], first: null, on: true });
    const snap = () => {
      const out = {};
      for (const p of document.querySelectorAll('#splitStage .pane')) {
        const list = p.querySelector('#messages') || p.querySelector('.mirror-msgs');
        if (!list) { out[p.dataset.g] = null; continue; }
        const r = list.getBoundingClientRect(), top = r.top;
        let text = '';
        for (const e of list.children) { const q = e.getBoundingClientRect(); if (q.height && q.bottom > top + 1) { text = e.textContent.replace(/\s+/g, ' ').slice(0, 50); break; } }
        out[p.dataset.g] = { top: Math.round(r.top), bottom: Math.round(r.bottom), text, gap: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) };
      }
      return out;
    };
    const tick = () => {
      if (!w.on) return;
      w.frames++;
      const s = snap();
      if (!w.first) w.first = s;
      else for (const g of Object.keys(w.first)) {
        const a = w.first[g], b = s[g];
        if (!a || !b || a.top !== b.top || a.bottom !== b.bottom || a.text !== b.text || (a.gap <= 1) !== (b.gap <= 1))
          w.bad.push('frame ' + w.frames + ' pane ' + g + ': ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}

splitTest('SF3 split view: switching focus never moves either pane (the bottom bar stays in both)', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  for (let i = 0; i < 6; i++) await wheel(page, -150, 'messages'); // A read midway, B at the bottom
  await settle(900);
  // the other pane shows its bar too: the turn line with the chat's status and the quiet message box
  const bar = await page.eval<{ turn: string; comp: boolean }>(`(() => { const p = document.querySelector('#splitStage .pane:not(.foc)');
    return { turn: p.querySelector('[data-mid="turnStatus"], .mirror-turn')?.textContent || '', comp: !!p.querySelector('[data-mid="promptForm"] textarea, .mirror-foot .mirror-comp') }; })()`);
  assert(bar.turn && bar.comp, `the other pane's bottom bar: ${JSON.stringify(bar)}`);
  for (const want of ['BETAEND', 'ALPHA', 'BETAEND']) {
    await startGeom(page);
    await settle(300);
    await page.click(OTHER_HEAD);
    await page.waitFor(`document.getElementById('messages').textContent.includes(${JSON.stringify(want)})`, 15000, 'focused');
    await settle(2500);
    const w = await page.eval<{ frames: number; bad: string[] }>(`(() => { const w = window.__geom; w.on = false; return w; })()`);
    assert(w.frames > 20, `frames watched: ${w.frames}`);
    assert(!w.bad.length, `a pane moved during the focus switch (${w.bad.length} of ${w.frames} frames):\n${w.bad.slice(0, 6).join('\n')}`);
  }
  a.end();
  b.end();
});

/* SF4 (owner, 2026-11-15: "stop changing what is displayed when switching chat focus"): the other pane shows everything the
   focused one does (header, status, turn line, message box and its buttons, the chip row under it) at the same size and place,
   undimmed, with the same tab colour; a focus switch moves, hides or resizes none of it in either pane; one click on a chip in
   the other pane focuses it and opens that chip's menu; hovering or clicking around the right panel never moves pane focus. */
const BAR_IDS = ['title', 'status', 'turnRow', 'turnStatus', 'promptForm', 'prompt', 'send', 'attachImages', 'composerChips'];
const PANE_KEY = `(p) => p.classList.contains('foc') ? AgentSplitUI.panes().find((x) => x.focused).group.active : p.querySelector('.mirror-msgs').dataset.mirror`;
/** Per pane (by the chat it shows): the box of every bar item and every chip against its pane, what is hidden or dimmed, and the
 *  active tab's background. */
const barGeom = (page: Page) =>
  page.eval<Record<string, { items: Record<string, string>; chips: string[]; hidden: string[]; tab: string }>>(`(() => {
    const out = {}, keyOf = ${PANE_KEY};
    for (const p of document.querySelectorAll('#splitStage .pane')) {
      const pr = p.getBoundingClientRect(), items = {}, hidden = [];
      const shown = (e) => {
        if (!e) return false;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        for (let n = e; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 1) return false;
        }
        return true;
      };
      const box = (e) => { const r = e.getBoundingClientRect(); return [r.left - pr.left, r.top - pr.top, r.width, r.height].map(Math.round).join(','); };
      for (const id of ${JSON.stringify(BAR_IDS)}) {
        let e = p.querySelector('#' + id + ', [data-mid="' + id + '"]');
        if (id === 'composerChips' && e) e = e.parentElement; // the chip box is display: contents; its row holds the chips
        if (!shown(e)) hidden.push(id);
        else items[id] = box(e);
      }
      const chipsBox = p.querySelector('#composerChips, [data-mid="composerChips"]');
      const chips = chipsBox ? [...chipsBox.querySelectorAll('.chip')].map((c) => (shown(c) ? '' : 'HIDDEN ') + c.textContent.trim() + '@' + box(c)) : [];
      const tab = p.querySelector('.pane-strip .ws-tab.on');
      out[keyOf(p)] = { items, chips, hidden, tab: tab ? getComputedStyle(tab).backgroundColor : 'none' };
    }
    return out;
  })()`);

/** Every frame until stopped: each bar item's box in each pane must stay exactly as in the first frame. */
function startBarWatch(page: Page) {
  return page.eval(`(() => {
    const w = (window.__bars = { frames: 0, bad: [], first: null, on: true });
    const snap = () => {
      const out = {};
      for (const p of document.querySelectorAll('#splitStage .pane')) {
        const pr = p.getBoundingClientRect(), s = [];
        for (const id of ${JSON.stringify(BAR_IDS)}) {
          let e = p.querySelector('#' + id + ', [data-mid="' + id + '"]');
          if (id === 'composerChips' && e) e = e.parentElement;
          const r = e ? e.getBoundingClientRect() : null;
          s.push(id + ':' + (r && r.height ? [r.left - pr.left, r.top - pr.top, r.width, r.height].map(Math.round).join(',') : 'none'));
        }
        out[p.dataset.g] = s.join(' ');
      }
      return out;
    };
    const tick = () => {
      if (!w.on) return;
      w.frames++;
      const s = snap();
      if (!w.first) w.first = s;
      else for (const g of Object.keys(w.first)) if (w.first[g] !== s[g]) w.bad.push('frame ' + w.frames + ' pane ' + g + ':\\n  ' + w.first[g] + '\\n  ' + s[g]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}

splitTest('SF4 split view: focus changes nothing in the panes but the accent line; a chip works in one click; the right panel never moves focus', async (lab) => {
  const page = lab.page;
  const { a, b } = await openSplit(lab);
  // B was in the real view once (openSplit opened it first): its pane shows the copy of the real view
  assert(await page.eval<boolean>(`!!document.querySelector('#splitStage .pane:not(.foc) .mirror-copy')`), 'the other pane shows the copy of the real view');
  assert(await page.eval<boolean>(`!document.querySelector('#splitStage .pane:not(.foc) .mirror-copy [id]')`), 'the copy holds no ids (the page never finds it by id)');
  const before = await barGeom(page);
  for (const [key, g] of Object.entries(before)) {
    assert(!g.hidden.length, `pane of ${key}: hidden or dimmed: ${g.hidden.join(', ')}: ${JSON.stringify(before)}`);
    assert(g.chips.length >= 1 && !g.chips.some((c) => c.startsWith('HIDDEN')), `pane of ${key}: chip row ${JSON.stringify(g.chips)}`);
  }
  assert(before[a.key].tab === before[b.key].tab, `active tab colour differs: focused ${before[a.key].tab}, other ${before[b.key].tab}`);
  // the panes are the same width: the bars sit at the same height in both
  for (const id of ['promptForm', 'composerChips', 'turnRow'])
    assert(
      before[a.key].items[id].split(',').slice(1).join() === before[b.key].items[id].split(',').slice(1).join(),
      `${id}: focused ${before[a.key].items[id]} vs other ${before[b.key].items[id]}`,
    );

  for (const want of ['BETAEND', 'ALPHAEND', 'BETAEND']) {
    await startBarWatch(page);
    await settle(300);
    await page.click(OTHER_HEAD);
    await page.waitFor(`document.getElementById('messages').textContent.includes(${JSON.stringify(want)})`, 15000, 'focused');
    await settle(2500);
    const w = await page.eval<{ frames: number; bad: string[] }>(`(() => { const w = window.__bars; w.on = false; return w; })()`);
    assert(w.frames > 20, `frames watched: ${w.frames}`);
    assert(!w.bad.length, `a bar item moved, resized or hid during the focus switch (${w.bad.length} of ${w.frames} frames):\n${w.bad.slice(0, 4).join('\n')}`);
    assert(await page.eval<boolean>(`!document.querySelector('.mirror-hold')`), 'the copy held over the real view is gone once it settled');
    const now = await barGeom(page);
    for (const key of [a.key, b.key]) {
      assert(JSON.stringify(now[key].items) === JSON.stringify(before[key].items), `pane of ${key} after the switch:\n${JSON.stringify(before[key].items)}\n${JSON.stringify(now[key].items)}`);
      assert(JSON.stringify(now[key].chips) === JSON.stringify(before[key].chips), `chips of ${key}:\n${before[key].chips.join(' | ')}\n${now[key].chips.join(' | ')}`);
      assert(now[key].tab === before[key].tab && !now[key].hidden.length, `pane of ${key}: tab ${now[key].tab}, hidden ${now[key].hidden}`);
    }
  }

  // one click on a chip with a menu (else the message box) in the other pane: the pane takes focus and the real control works
  const chip = await page.eval<string>(`(() => { const c = document.querySelector('#splitStage .pane:not(.foc) button[data-mid^="chip-"]'); return c ? c.getAttribute('data-mid') : ''; })()`);
  if (chip) {
    await clickHere(page, `#splitStage .pane:not(.foc) [data-mid="${chip}"]`);
    await page.waitFor(
      `document.getElementById('messages').textContent.includes('ALPHAEND') && document.getElementById(${JSON.stringify(chip)})?.getAttribute('aria-expanded') === 'true'`,
      8000,
      `one click on ${chip} in the other pane focuses it and opens the menu`,
    );
    await page.eval(`AgentComposerChips.closeMenu(false)`);
    await settle(300);
  } else {
    await clickHere(page, '#splitStage .pane:not(.foc) [data-mid="prompt"]');
    await page.waitFor(`document.getElementById('messages').textContent.includes('ALPHAEND') && document.activeElement?.id === 'prompt'`, 8000, 'one click on the other message box focuses the pane and the box');
  }

  // the right panel: hovering or clicking its tabs, strip and the Activity list never moves pane focus
  const focusNow = await page.eval<string>(`AgentSplitUI.layout().focus`);
  let tried = 0;
  for (const sel of ['#paneTab-changes', '#paneTab-artifacts', '#paneTab-activity', '#activityStrip', '#projectActivity']) {
    const at = await page.eval<[number, number] | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? [r.left + Math.min(20, r.width / 2), r.top + Math.min(10, r.height / 2)] : null; })()`);
    if (!at) continue;
    tried++;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    await settle(150);
    assert((await page.eval<string>(`AgentSplitUI.layout().focus`)) === focusNow, `hovering ${sel} moved pane focus`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
    await settle(400);
    assert((await page.eval<string>(`AgentSplitUI.layout().focus`)) === focusNow, `clicking ${sel} in the right panel moved pane focus`);
  }
  assert(tried >= 2, `right panel targets found: ${tried}`);
  a.end();
  b.end();
});
