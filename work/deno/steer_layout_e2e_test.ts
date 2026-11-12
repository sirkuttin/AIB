/**
 * Steer-on-send layout, end to end (beta.9): the composer while the agent works, with the hint under "Send now", the key hint under the box and the ▾ send menu, at the narrowest composer widths, in the light and the dark theme. Real Studio, fake agents of
 * work/fake_acp.py --steer (_steer_lab.ts), headless Chrome/Edge (no window). Needs [B] the page side (feat/steer-page); it fails
 * until that has landed. No selectors beyond the shared ones are assumed: the ▾ is the element with aria-haspopup inside #promptForm,
 * the hints are found by their copy (build-brief-beta9.md, one copy table).
 *
 * What is measured (pixels, not looks), at viewport widths 360, 400, 490 (the narrowest width the page draws without sideways scroll) and 700:
 *  - nothing in the composer sticks out of it and the composer has no sideways scroll;
 *  - Send and ▾ are both visible, side by side without overlap, each at least 24 px wide and tall;
 *  - the key hint and the Attach button do not overlap, the key hint stays inside the composer;
 *  - with the menu open: every item is inside the viewport, its text is not cut off, and it lists the three sends;
 *  - the hint text keeps a contrast of at least 4.5:1 against what is behind it (light and dark).
 *
 * Run (from outputs/agent-studio): deno test -A ../../work/deno/steer_layout_e2e_test.ts
 */
import { assert, hasBrowser, type Json, openPage, type Page, SteerLab, TEST_OPTIONS, until, type Who } from './_steer_lab.ts';

const LONG = 45;
// 490 is the narrowest the page itself draws without sideways scroll (MAIN is 490 px wide even with no steer feature, measured at 360 and 420);
// the composer is also checked at 400 and 360 on its own (the page may scroll there, the composer must still fit its own box)
const WIDTHS = [360, 400, 490, 700];
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
  const attach = [...form.querySelectorAll('button, label')].find((e) => /attach/i.test(e.textContent + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.title || '')) && visible(e));
  const keyHint = document.getElementById('sendKeyHint');
  out.keyHint = keyHint ? keyHint.textContent.trim() : null;
  if (!keyHint || keyHint.hidden) bad('no key hint (Enter sends ...) in the composer');
  if (keyHint && !keyHint.hidden && attach) {
    const a = attach.getBoundingClientRect(), k = keyHint.getBoundingClientRect();
    if (a.right > k.left + 1 && k.right > a.left + 1 && a.bottom > k.top + 1 && k.bottom > a.top + 1) bad('the key hint overlaps Attach');
  }
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
  return out;
})()`;

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

for (const who of ['claude', 'codex', 'omp'] as const) {
  for (const theme of THEMES) {
    Deno.test({
      name: `LY1 [B] ${who}, ${theme}: the working composer (hint, key hint, Send and its menu button, open menu) fits at ${WIDTHS.join(', ')} px`,
      ignore: !hasBrowser,
      ...TEST_OPTIONS,
      async fn() {
        await using lab = new SteerLab();
        await lab.start();
        const chat = await lab.chat(who);
        const gate = lab.gate();
        await chat.prompt(`steer-wait:${gate}`, 'first');
        await until(async () => (await chat.state()).busy, 'working', LONG);
        const page = await openPage(lab, chat, 1400, 900, theme);
        try {
          await page.waitFor(`[...document.querySelectorAll('#promptForm [aria-haspopup]')].some((e) => e.getBoundingClientRect().width > 0)`, 15000, 'the menu button');
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
    name: `LY2 [B] ${theme}: an agent that cannot steer: the "can't read messages mid-turn" hint and the key hint fit at ${WIDTHS.join(', ')} px`,
    ignore: !hasBrowser,
    ...TEST_OPTIONS,
    async fn() {
      await using lab = new SteerLab({ plain: ['claude'] });
      await lab.start();
      const chat = await lab.chat('claude');
      const gate = lab.gate();
      await chat.prompt(`gate:${gate}`, 'first');
      await until(async () => (await chat.state()).busy, 'working', LONG);
      const page = await openPage(lab, chat, 1400, 900, theme);
      try {
        await page.waitFor(`/can.t read messages mid-turn/i.test(document.body.innerText)`, 15000, 'the hint');
        for (const width of WIDTHS) {
          await page.viewport(width, 900);
          await settle();
          const r = await page.eval<Json>(
            `(() => { const form = document.getElementById('promptForm'); const fr = form.getBoundingClientRect(); const problems = [];
              if (form.scrollWidth > form.clientWidth + 1) problems.push('the composer scrolls sideways');
              for (const e of form.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && (r.left < fr.left - 1 || r.right > fr.right + 1)) problems.push((e.id || e.className || e.tagName) + ' sticks out'); }
              return { problems }; })()`,
          );
          assert((r.problems as string[]).length === 0, `${theme}/${width}px: ${(r.problems as string[]).join('; ')}`);
          await check(page, `${theme}/${width}px hint contrast`, CONTRAST("can.t read messages mid-turn"));
        }
      } finally {
        await page.close();
        chat.open(gate);
      }
    },
  });
}
