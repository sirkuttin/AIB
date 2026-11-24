/**
 * AIB's own notes in the chat are one quiet line, not a card (owner design a): "⑂ Merged “X” · 2 files · Undo · 1:22 AM".
 * Page tests in a headless Chrome (no window): the real theme.css / chat.css / stream.css and stream-ui.js on a static page at 1000
 * and 360 px, and the phone page at 360 px against an in-process AIB with a fake agent host.
 * Checks: a row is one line (height <= the "turn finished" divider + a few px), Undo visible and clickable, a long name cut with "…"
 * and never wrapped (the whole text in the title), the warning kind tinted, no Copy button, no AIB header, the text 4.5:1 against the
 * chat background in both themes, the phone's Undo word a 44 px tap area.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { pairPhone } from './_remote_fixture.ts';
import { liveChat, v2Studio } from './_remote_v2b.ts';
import { phonePage, tap } from './_remote_phone_page.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
const APP = new URL('../../app/', import.meta.url);
const file = (name: string) => new URL(name, APP).href;
const LONG = 'Fix: ' + 'already-merged subagents conflict with a very long name '.repeat(6);

const PAGE = `<!doctype html><html data-theme="teal-dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="${file('theme.css')}"><link rel="stylesheet" href="${file('chat.css')}"><link rel="stylesheet" href="${file('stream.css')}">
<script src="${file('stream-ui.js')}"></script><style>body{display:block;margin:0}</style></head><body><main id="list" style="padding:0 30px;background:var(--bg)"></main>
<script>
const S = window.StreamUI, list = document.getElementById('list');
const actions = (labels) => { const box = document.createElement('div'); box.className = 'note-actions';
  for (const l of labels) { const b = document.createElement('button'); b.type = 'button'; b.className = 'note-action'; b.textContent = l; b.onclick = () => { window.__clicked = l; }; box.append(b); }
  const r = document.createElement('span'); r.className = 'note-actions-result'; box.append(r); return box; };
const add = (id, row, labels) => { const n = S.studioLine(row, labels ? actions(labels) : null); n.id = id; list.append(n); };
const div = S.divider({ value: 'end_turn', time: 1700000000 }); div.id = 'divider'; list.append(div);
add('merged', { value: 'Merged subagent “Fix: already-merged subagents conflict” into main · 2 files', time: 1700000000, noteKind: 'swarm-merge' }, ['Undo']);
add('long', { value: 'Merged subagent “${LONG}” into main · 2 files', time: 1700000000, noteKind: 'swarm-merge' }, ['Undo']);
add('warn', { value: 'Didn’t land subagent “Fix: already-merged subagents conflict”: it conflicts with main in a.ts, b.ts.', time: 1700000000, noteKind: 'swarm-merge' }, ['Merge again']);
add('fail', { value: 'Helper “X” (Claude) failed: boom', time: 1700000000, noteKind: 'swarm-fail' }, null);
add('plain', { value: 'Back: the build finished', time: 1700000000 }, null);
</script></body></html>`;

/** Relative luminance of an element's computed colour property. */
async function lum(page: Page, selector: string, prop: string): Promise<number> {
  return await page.eval<number>(`(() => { const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${prop}; c.fillRect(0,0,1,1);
    const [r,g,b] = c.getImageData(0,0,1,1).data; const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); })()`);
}
const ratio = (a: number, b: number) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);

Deno.test({
  ...OPTS,
  name: 'AIB notes are one quiet line at 1000 and 360 px: one line high, Undo clickable, long name cut, warning tinted, no Copy, contrast 4.5',
  ignore: !browserPath,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: 'aib-noteline-' });
    const html = `${dir}/page.html`;
    await Deno.writeTextFile(html, PAGE);
    const browser = await Browser.launch(['--allow-file-access-from-files']);
    try {
      for (const width of [1000, 360]) {
        const page = await browser.open('about:blank', width, 700);
        await page.goto('file:///' + html.replaceAll('\\', '/').replace(/^\//, ''));
        await page.waitFor('!!document.getElementById("plain")', 5000, 'rows');
        const h = (id: string) => page.eval<number>(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().height`);
        const divider = await h('divider');
        const heights: Record<string, number> = { divider };
        for (const id of ['merged', 'long', 'warn', 'fail', 'plain']) {
          heights[id] = await h(id);
          assert(heights[id] <= 30, `${width}px ${id}: ${heights[id]}px high (one 20 px line + padding), divider ${divider}px`);
        }
        console.log(`heights at ${width}px`, JSON.stringify(heights));
        // no card parts
        assertEquals(
          await page.eval('document.querySelectorAll(".studio-line button:not(.note-action), .studio-line .copy-btn, .studio-line .bubble-head, .studio-line strong, .studio-line article, .studio-line pre").length'),
          0,
          'no Copy / header / card',
        );
        // not monospace, and readable: at least 13 px (owner 2026-11-17: the divider-sized line was "way too muted")
        assert(!/mono|consol|courier/i.test(await page.eval<string>('getComputedStyle(document.querySelector("#merged .studio-text")).fontFamily')));
        assert(parseFloat(await page.eval<string>('getComputedStyle(document.querySelector("#merged")).fontSize')) >= 13, 'note text at least 13 px');
        // Undo: visible, inside the line, clickable
        const undo = await page.eval<{ x: number; y: number; w: number; inside: boolean; shown: boolean }>(`(() => {
          const b = document.querySelector('#merged .note-action'), r = b.getBoundingClientRect(), l = document.getElementById('merged').getBoundingClientRect();
          const s = getComputedStyle(b);
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, inside: r.right <= l.right + 1 && r.left >= l.left,
            shown: s.visibility === 'visible' && s.display !== 'none' && s.opacity === '1' }; })()`);
        assert(undo.inside && undo.shown && undo.w > 10, `${width}px Undo placed ${JSON.stringify(undo)}`);
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: undo.x, y: undo.y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: undo.x, y: undo.y, button: 'left', clickCount: 1 });
        assertEquals(await page.eval('window.__clicked'), 'Undo', `${width}px Undo click`);
        // the long name is cut, not wrapped; Undo stays whole and the whole text is the title
        const long = await page.eval<{ cut: boolean; undoW: number; over: number; title: string }>(`(() => {
          const t = document.querySelector('#long .studio-text'), b = document.querySelector('#long .note-action'), l = document.getElementById('long');
          return { cut: t.scrollWidth > t.clientWidth, undoW: b.getBoundingClientRect().width, over: l.scrollWidth - l.clientWidth, title: l.title }; })()`);
        assert(long.cut && long.undoW > 10 && long.over <= 1 && long.title.includes('very long name'), `${width}px long ${JSON.stringify(long)}`);
        // the time goes first on a narrow chat, Undo never
        const time = await page.eval<string>('getComputedStyle(document.querySelector("#merged .studio-time")).display');
        assertEquals(time === 'none', width === 360, `${width}px time ${time}`);
        // the warning kind is tinted, the plain one is not; the name is the regular colour
        const color = (sel: string) => page.eval<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).color`);
        assert((await color('#warn')) !== (await color('#plain')), 'warning tinted');
        assert((await color('#fail')) !== (await color('#plain')), 'failure tinted');
        assert((await color('#merged .studio-name')) !== (await color('#merged')), 'name in the text colour');
        // contrast against the chat background, both themes
        for (const theme of ['teal-dark', 'teal-light']) {
          await page.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
          const bg = await lum(page, '#list', 'backgroundColor');
          for (const sel of ['#plain', '#warn', '#fail', '#merged .studio-name', '#merged .note-action']) {
            const r = ratio(await lum(page, sel, 'color'), bg);
            assert(r >= 4.5, `${width}px ${theme} ${sel} contrast ${r.toFixed(2)}`);
          }
        }
        await page.close();
      }
    } finally {
      await browser.close().catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone: an AIB note is one line at 360 px, the Undo word a 44 px tap area, a long name cut, the warning tinted',
  ignore: !browserPath,
  async fn() {
    const s = await v2Studio();
    const browser = await Browser.launch();
    try {
      const T = Date.now() / 1000 - 60;
      s.chats.push(liveChat('c1', s.project, {
        events: [
          { seq: 1, kind: 'user', time: T - 60, data: { text: 'Go' } },
          { seq: 2, kind: 'studio_note', time: T, data: { message: `Merged subagent “${LONG}” into main · 2 files`, kind: 'swarm-merge', helper: 'h1', actions: [{ id: 'swarm-undo', label: 'Undo', helper: 'h1' }] } },
          { seq: 3, kind: 'studio_note', time: T, data: { message: 'Didn’t land subagent “Fix”: it conflicts with main in a.ts.', kind: 'swarm-merge', helper: 'h2' } },
          { seq: 4, kind: 'studio_note', time: T, data: { message: 'Back: the build finished' } },
        ],
      }));
      const phone = await pairPhone(s);
      const page = await phonePage(browser, s, phone, undefined, 360);
      await tap(page, '.ph-card[data-chat="c1"]');
      await page.waitFor('document.querySelectorAll(".ph-aibnote").length === 3', 10000, 'notes');
      const m = await page.eval<{ hs: number[]; undoH: number; undoW: number; cut: boolean; side: boolean; tint: boolean; copy: number }>(`(() => {
        const n = [...document.querySelectorAll('.ph-aibnote')], u = document.querySelector('.ph-note-act').getBoundingClientRect();
        const t = n[0].querySelector('.ph-note-text'), d = document.documentElement;
        return { hs: n.map((x) => Math.round(x.getBoundingClientRect().height)), undoH: u.height, undoW: u.width, cut: t.scrollWidth > t.clientWidth,
          side: d.scrollWidth <= d.clientWidth, tint: getComputedStyle(n[1]).color !== getComputedStyle(n[2]).color,
          copy: document.querySelectorAll('.ph-aibnote button:not(.ph-note-act)').length }; })()`);
      console.log('phone note', JSON.stringify(m));
      assert(m.hs.every((x) => x <= 30), `one line high ${m.hs}`);
      assert(m.undoH >= 44 && m.undoW >= 44, `Undo tap area ${m.undoW} x ${m.undoH}`);
      assert(m.cut && m.side && m.tint && m.copy === 0, JSON.stringify(m));
      await page.close();
    } finally {
      await browser.close().catch(() => {});
      await s.close();
    }
  },
});
