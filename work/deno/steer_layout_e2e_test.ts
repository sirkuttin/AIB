/**
 * Steer-on-send layout, end to end (beta.9): the composer while the agent works, with the hint under "Send now" and the ▾ send menu, at the narrowest composer widths, in the light and the dark theme. Real Studio, fake agents of
 * work/fake_acp.py --steer (_steer_lab.ts), headless Chrome/Edge (no window). Needs [B] the page side (feat/steer-page); it fails
 * until that has landed. No selectors beyond the shared ones are assumed: the ▾ is the element with aria-haspopup inside #promptForm,
 * the hints are found by their copy (build-brief-beta9.md, one copy table).
 *
 * What is measured (pixels, not looks), at viewport widths 360, 400, 490 (the narrowest width the page draws without sideways scroll), 700, 860
 * and 1600:
 *  - nothing in the composer sticks out of it and the composer has no sideways scroll;
 *  - Send and ▾ are both visible, side by side without overlap, each at least 24 px wide and tall;
 *  - no key hint row under the box (owner, 2026-11-12): the composer is exactly as tall working as idle, and the shortcuts are in the
 *    Send button's tooltip (steerable, a slash command typed, an agent that cannot steer);
 *  - with the menu open: every item is inside the viewport, its text is not cut off, and it lists the three sends;
 *  - and every item can really be seen and clicked: document.elementFromPoint at five points of each item finds that item (QA beta.9:
 *    the menu sat inside the composer, which clips what sticks out of it, so only its last ~19 px showed although its rectangle was
 *    inside the window); LY3 clicks "Send now" and "Interrupt and send" with the mouse at such a point;
 *  - the hint text keeps a contrast of at least 4.5:1 against what is behind it (light and dark).
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/steer_layout_e2e_test.ts
 */
import { assert, assertEquals, hasBrowser, type Json, openPage, type Page, SteerLab, TEST_OPTIONS, until, type Who } from './_steer_lab.ts';
import type { SteerChat } from './_steer_lab.ts';

const LONG = 45;
// 490 is the narrowest the page itself draws without sideways scroll (MAIN is 490 px wide even with no steer feature, measured at 360 and 420);
// the composer is also checked at 400 and 360 on its own (the page may scroll there, the composer must still fit its own box)
const WIDTHS = [360, 400, 490, 700, 860, 1600];
const THEMES = ['teal-dark', 'teal-light'] as const;

const MEASURE = `(() => {
  const form = document.getElementById('promptForm');
  const fr = form.getBoundingClientRect();
  const out = { problems: [] };
  const bad = (m) => out.problems.push(m);
  if (form.scrollWidth > form.clientWidth + 1) bad('the composer scrolls sideways: scrollWidth ' + form.scrollWidth + ' > ' + form.clientWidth);
  if (innerWidth >= 490 && document.documentElement.scrollWidth > innerWidth + 1) bad('the page scrolls sideways');
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  for (const e of form.querySelectorAll('button, textarea, input, p, span, div, small')) {
    if (!visible(e) || e.closest('[role=menu]')) continue; // a menu may float; it is checked on its own below
    const r = e.getBoundingClientRect();
    if (r.left < fr.left - 1 || r.right > fr.right + 1) bad((e.id || e.className || e.tagName) + ' sticks out of the composer sideways: ' + Math.round(r.left) + '..' + Math.round(r.right) + ' vs ' + Math.round(fr.left) + '..' + Math.round(fr.right));
  }
  const send = document.getElementById('send');
  const caret = form.querySelector('[aria-haspopup]');
  if (!send || !visible(send)) bad('Send is not visible');
  if (!caret || !visible(caret)) bad('the caret (menu button) is not visible');
  if (send && caret && visible(send) && visible(caret)) {
    const a = send.getBoundingClientRect(), b = caret.getBoundingClientRect();
    if (a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1) bad('Send and the caret overlap');
    if (b.width < 24 || b.height < 24) bad('the caret is smaller than 24 px: ' + Math.round(b.width) + 'x' + Math.round(b.height));
    if (a.width < 24 || a.height < 24) bad('Send is smaller than 24 px');
  }
  if (document.getElementById('sendKeyHint') || form.querySelector('.send-key-hint')) bad('a key hint row under the box (the owner removed it)');
  return out;
})()`;

const MENU = `(() => {
  const out = { problems: [] };
  const bad = (m) => out.problems.push(m);
  const menu = document.querySelector('[role=menu]:not([hidden])');
  if (!menu) { bad('no menu is open'); return out; }
  const mr = menu.getBoundingClientRect();
  if (mr.left < -1 || mr.right > innerWidth + 1 || mr.top < -1 || mr.bottom > innerHeight + 1) bad('the menu is outside the window: ' + [mr.left, mr.top, mr.right, mr.bottom].map(Math.round));
  for (const e of menu.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > mr.right + 1 || r.left < mr.left - 1) bad('inside the menu: ' + (e.textContent || e.tagName).trim().slice(0, 40) + ' sticks out of it');
    if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible') bad('text cut off: ' + (e.textContent || '').trim().slice(0, 40));
  }
  const text = menu.innerText;
  for (const item of ['Send now', 'Send after this turn', 'Interrupt and send']) if (!text.includes(item)) bad('the menu lacks "' + item + '"');
  // seen and clickable: what is on top at five points of each item is that item (not the composer, not something clipping it)
  const items = [...menu.querySelectorAll('[role=menuitem]')];
  if (items.length !== 3) bad('the menu has ' + items.length + ' items, not 3');
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const name = (item.querySelector('b') || item).textContent.trim();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) bad('"' + name + '" is not wholly inside the window');
    const cy = r.top + r.height / 2, cx = r.left + r.width / 2;
    for (const [x, y] of [[cx, cy], [r.left + 6, cy], [r.right - 6, cy], [cx, r.top + 3], [cx, r.bottom - 3]]) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !item.contains(hit)) bad('"' + name + '" is covered at ' + Math.round(x) + ',' + Math.round(y) + ' by ' + (hit ? (hit.id || hit.className || hit.tagName) : 'nothing'));
    }
  }
  return out;
})()`;

/** A real mouse click on a menu item, at its centre, after checking that the item is what is on top there. */
async function clickMenuItem(page: Page, label: string): Promise<void> {
  const at = await page.eval<[number, number] | string>(
    `(() => { const b = [...document.querySelectorAll('[role=menu]:not([hidden]) [role=menuitem]')].find((e) => e.textContent.includes(${JSON.stringify(label)}));
      if (!b) return 'no item'; const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y);
      return hit && b.contains(hit) ? [x, y] : 'covered by ' + (hit ? hit.id || hit.className || hit.tagName : 'nothing'); })()`,
  );
  assert(Array.isArray(at), `"${label}" cannot be clicked: ${at}`);
  const [x, y] = at as [number, number];
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const CONTRAST = (pattern: string) =>
  `((re) => {
    const lum = (c) => { const v = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
    const el = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && re.test(e.textContent) && e.getBoundingClientRect().width > 0).pop();
    if (!el) return { problems: ['hint text not found: ' + re] };
    const fg = parse(getComputedStyle(el).color);
    let bg = [255, 255, 255, 1];
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
    for (const c of layers.reverse()) bg = [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3])).concat([1]);
    const a = lum(fg.slice(0, 3)), b = lum(bg.slice(0, 3));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return { ratio, problems: ratio < 4.5 ? ['hint contrast ' + ratio.toFixed(2) + ':1 is below 4.5:1'] : [] };
  })(new RegExp(${JSON.stringify(pattern)}))`;

const HINT_START: Record<Who, string> = { claude: 'Claude Code answers right away', codex: 'Codex answers right away', omp: 'OMP answers right away' };

async function check(page: Page, what: string, expression: string): Promise<void> {
  const r = await page.eval<Json>(expression);
  const problems = (r.problems as string[]) ?? [];
  assert(problems.length === 0, `${what}: ${problems.join('; ')}`);
}

const settle = () => new Promise((r) => setTimeout(r, 400));

/** The composer's height (px) at each width. */
async function heights(page: Page): Promise<number[]> {
  const out: number[] = [];
  for (const width of WIDTHS) {
    await page.viewport(width, 900);
    await settle();
    out.push(await page.eval<number>(`Math.round(document.getElementById('promptForm').getBoundingClientRect().height)`));
  }
  return out;
}

const STEER_TIP = 'Enter sends now · Alt+Enter after this turn · Shift+Enter for a new line';
const sendTip = (page: Page) => page.eval<string>(`document.getElementById('send').title`);

/** The Send tooltip with a slash command typed: commands always wait for the turn end. */
async function slashTip(page: Page): Promise<string> {
  await page.eval(`(() => { const p = document.getElementById('prompt'); p.value = '/doc plan'; p.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();
  const tip = await sendTip(page);
  await page.eval(`(() => { const p = document.getElementById('prompt'); p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();
  return tip;
}

for (const who of ['claude', 'codex', 'omp'] as const) {
  for (const theme of THEMES) {
    Deno.test({
      name: `LY1 [B] ${who}, ${theme}: the working composer (Send and its menu button, open menu, the Send tooltip) fits and keeps its idle height at ${WIDTHS.join(', ')} px`,
      ignore: !hasBrowser,
      ...TEST_OPTIONS,
      async fn() {
        await using lab = new SteerLab();
        await lab.start();
        const chat = await lab.chat(who);
        const gate = lab.gate();
        const page = await openPage(lab, chat, 1400, 900, theme);
        try {
          const idle = await heights(page);
          assertEquals(await sendTip(page), '', 'idle: no Send tooltip');
          await page.viewport(1400, 900);
          await chat.prompt(`steer-wait:${gate}`, 'first');
          await until(async () => (await chat.state()).busy, 'working', LONG);
          await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => e.getBoundingClientRect().width > 0)`, 15000, 'the menu button');
          assertEquals(await heights(page), idle, 'the composer is as tall working as idle, at every width');
          assertEquals(await sendTip(page), STEER_TIP, 'the shortcuts are in the Send tooltip');
          assertEquals(await slashTip(page), 'Commands run after this turn');
          for (const width of WIDTHS) {
            await page.viewport(width, 900);
            await settle();
            await check(page, `${who}/${theme}/${width}px composer`, MEASURE);
            await page.click('#promptForm [aria-haspopup]');
            await page.waitFor(`!!document.querySelector('[role=menu]:not([hidden])')`, 4000, 'the menu');
            await check(page, `${who}/${theme}/${width}px menu`, MENU);
            await check(page, `${who}/${theme}/${width}px hint`, CONTRAST(HINT_START[who]));
            await page.shot(`steer-${who}-${theme}-${width}`);
            await page.key('Escape');
            await page.waitFor(`!document.querySelector('[role=menu]:not([hidden])')`, 4000, 'the menu closed');
          }
          assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
        } finally {
          await page.close();
          chat.open(gate);
        }
      },
    });
  }
}

for (const theme of THEMES) {
  Deno.test({
    name: `LY2 [B] ${theme}: an agent that cannot steer: its Send tooltip, the menu's "can't read messages" hint fits, same height as idle, at ${WIDTHS.join(', ')} px`,
    ignore: !hasBrowser,
    ...TEST_OPTIONS,
    async fn() {
      await using lab = new SteerLab({ plain: ['claude'] });
      await lab.start();
      const chat = await lab.chat('claude');
      const gate = lab.gate();
      const page = await openPage(lab, chat, 1400, 900, theme);
      try {
        const idle = await heights(page);
        await page.viewport(1400, 900);
        await chat.prompt(`gate:${gate}`, 'first');
        await until(async () => (await chat.state()).busy, 'working', LONG);
        await page.waitFor(`/can.t read messages mid-turn/i.test(document.getElementById('send').title)`, 15000, 'the Send tooltip');
        assertEquals(await sendTip(page), 'Claude Code can’t read messages mid-turn · Enter sends when it ends');
        assertEquals(await heights(page), idle, 'the composer is as tall working as idle, at every width');
        for (const width of WIDTHS) {
          await page.viewport(width, 900);
          await settle();
          const r = await page.eval<Json>(
            `(() => { const form = document.getElementById('promptForm'); const fr = form.getBoundingClientRect(); const problems = [];
              if (form.scrollWidth > form.clientWidth + 1) problems.push('the composer scrolls sideways');
              for (const e of form.querySelectorAll('*')) { if (e.closest('[role=menu]')) continue; const r = e.getBoundingClientRect(); if (r.width && (r.left < fr.left - 1 || r.right > fr.right + 1)) problems.push((e.id || e.className || e.tagName) + ' sticks out'); }
              return { problems }; })()`,
          );
          assert((r.problems as string[]).length === 0, `${theme}/${width}px: ${(r.problems as string[]).join('; ')}`);
          // the menu's greyed "Send now" carries the longer words
          await page.click('#promptForm [aria-haspopup]');
          await page.waitFor(`!!document.querySelector('[role=menu]:not([hidden])')`, 4000, 'the menu');
          await check(page, `${theme}/${width}px menu`, MENU);
          await check(page, `${theme}/${width}px hint contrast`, CONTRAST('can.t read messages during a turn'));
          await page.key('Escape');
          await page.waitFor(`!document.querySelector('[role=menu]:not([hidden])')`, 4000, 'the menu closed');
        }
      } finally {
        await page.close();
        chat.open(gate);
      }
    },
  });
}

// LY3: the menu's sends work with the mouse (QA beta.9: only the keyboard reached them), at the widest and a narrow width.
const steersOf = (chat: SteerChat) =>
  chat.received().filter((m) => m.method === '_session/steering').map((m) => JSON.stringify(m.params));

for (const who of ['claude', 'codex', 'omp'] as const) {
  Deno.test({
    name: `LY3 [B] ${who}: "Send now" (1600 px, dark) and "Interrupt and send" (860 px, light) clicked with the mouse in the open menu`,
    ignore: !hasBrowser,
    ...TEST_OPTIONS,
    async fn() {
      await using lab = new SteerLab();
      await lab.start();
      const chat = await lab.chat(who);
      const gate = lab.gate();
      const page = await openPage(lab, chat, 1600, 900, 'teal-dark');
      const typeOnly = async (text: string) => {
        await page.click('#prompt');
        await page.type(text);
      };
      const openMenu = async () => {
        await page.click('#promptForm [aria-haspopup]');
        await page.waitFor(`!!document.querySelector('[role=menu]:not([hidden])')`, 4000, 'the menu');
      };
      try {
        await chat.prompt(`steer-wait:${gate}`, 'first');
        await until(async () => (await chat.state()).busy, 'working', LONG);
        await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => e.getBoundingClientRect().width > 0)`, 15000, 'the menu button');
        await typeOnly('clicked send now');
        await openMenu();
        await check(page, `${who}/1600 menu`, MENU);
        await clickMenuItem(page, 'Send now');
        await until(() => steersOf(chat).some((p) => p.includes('clicked send now')), '"Send now" reached the agent as a steer', LONG);
        await page.waitFor(`document.getElementById('prompt').value === ''`, 8000, 'the box is cleared');
        assert((await chat.state()).busy, 'the turn goes on after "Send now"');

        await page.eval(`localStorage.setItem('aib-theme', 'teal-light'); document.documentElement.dataset.theme = 'teal-light'`);
        await page.viewport(860, 900);
        await settle();
        await typeOnly('clicked interrupt');
        await openMenu();
        await check(page, `${who}/860 menu`, MENU);
        await clickMenuItem(page, 'Interrupt and send');
        await until(() => lab.promptsReceived(chat).includes('clicked interrupt'), '"Interrupt and send" stopped the turn and sent the message', LONG);
        assert(chat.received().some((m) => m.method === 'session/cancel'), 'the turn was cancelled');
        assert(page.errors.length === 0, `console errors: ${page.errors.join(' | ')}`);
      } finally {
        await page.close();
        chat.open(gate);
      }
    },
  });
}
