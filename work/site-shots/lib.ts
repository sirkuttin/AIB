/** Capture helpers for the AIB site screenshots: headless Chrome over DevTools (the repo's _doc_browser harness). */
import { Browser, Page, sleep } from '../deno/_doc_browser.ts';
export { Browser, Page, sleep };

export const OUT = new URL('../../site/src/assets/shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const RAW = Deno.env.get('SHOTS_RAW') ?? 'C:/aib-demo/raw';

export type Theme = 'teal-dark' | 'teal-light';
export const THEMES: Theme[] = ['teal-dark', 'teal-light'];

/** Open a page at a desktop size (1600x900, device scale 2) with an AIB theme set before the first paint. */
export async function desk(b: Browser, url: string, theme: Theme, w = 1600, h = 900): Promise<Page> {
  const p = await b.open('about:blank', w, h);
  await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('aib-theme',${JSON.stringify(theme)})}catch(e){}` });
  await p.goto(url);
  await p.eval(`window.AibThemes.paint(${JSON.stringify(theme)})`);
  return p;
}

/** Save a PNG of the page into RAW/<name>.png (convert.py turns these into the site's images). */
export async function shot(p: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  await sleep(350);
  const params: Record<string, unknown> = { format: 'png' };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await p.send('Page.captureScreenshot', params);
  await Deno.mkdir(RAW, { recursive: true });
  Deno.writeFileSync(`${RAW}/${name}.png`, Uint8Array.from(atob(String(r.data)), (c) => c.charCodeAt(0)));
  console.log('shot', name);
}

/** Click the first element matching `sel` whose text contains `text` (by script). */
export async function clickText(p: Page, sel: string, text: string): Promise<void> {
  await p.waitFor(`[...document.querySelectorAll(${JSON.stringify(sel)})].some(e=>e.innerText&&e.innerText.includes(${JSON.stringify(text)}))`, 10000, `${sel} "${text}"`);
  await p.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.innerText&&e.innerText.includes(${JSON.stringify(text)})).click()`);
}

/** Like clickText but the element's whole text must equal `text`. */
export async function clickExact(p: Page, sel: string, text: string): Promise<void> {
  const js = `[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>(e.innerText||'').trim()===${JSON.stringify(text)}&&e.offsetParent!==null)`;
  await p.waitFor(`!!(${js})`, 10000, `${sel} =="${text}"`);
  await p.eval(`(${js}).click()`);
}

/** Run `fn` once per theme on a fresh page; shots are named <name>-<theme>. */
export async function eachTheme(b: Browser, url: string, fn: (p: Page, t: Theme, tag: string) => Promise<void>, w = 1600, h = 900): Promise<void> {
  for (const t of THEMES) {
    const p = await desk(b, url, t, w, h);
    try { await fn(p, t, t === 'teal-dark' ? 'dark' : 'light'); } finally { await p.close(); }
  }
}

/** Swap any path under a user folder (the demo launcher runs from a checkout) for a neutral demo path; no backslashes in the regex on purpose. */
export async function neutralPaths(p: Page): Promise<void> {
  const to = 'C:' + String.fromCharCode(92) + 'aib-demo' + String.fromCharCode(92) + 'bin' + String.fromCharCode(92) + 'claude.cmd';
  await p.eval(`(() => { const re = new RegExp('[A-Za-z]:.Users[^ ]*?agent[.]py', 'g'); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) n.nodeValue = n.nodeValue.replace(re, () => ${JSON.stringify(to)}); })()`);
}

/** Ctrl+\ (split the focused tab right). */
export async function ctrlBackslash(p: Page): Promise<void> {
  const base = { key: String.fromCharCode(92), code: 'Backslash', windowsVirtualKeyCode: 220, nativeVirtualKeyCode: 220, modifiers: 2 };
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Click the deepest visible element whose text contains `text` (no child element contains it). */
export async function clickLeaf(p: Page, text: string, within = 'body'): Promise<void> {
  const js = `(() => { const t = ${JSON.stringify(text)}; const root = document.querySelector(${JSON.stringify(within)});
    const all = [...root.querySelectorAll('*')].filter(e => e.offsetParent !== null && (e.innerText || '').includes(t) && ![...e.children].some(c => (c.innerText || '').includes(t)));
    return all[0] || null; })()`;
  await p.waitFor(`!!${js}`, 10000, `leaf "${text}"`);
  await p.eval(`${js}.click()`);
}

/** Close every open chat tab (the tab bar's x buttons) so a shot starts from one clean state. */
export async function closeTabs(p: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const hit = await p.eval<boolean>(`(() => { const x = [...document.querySelectorAll('button,span')].find(e => e.offsetParent !== null && ['×', '✕', 'x'].includes((e.innerText||'').trim()) && e.getBoundingClientRect().top < 60); if (!x) return false; x.click(); return true; })()`);
    if (!hit) break;
    await sleep(300);
  }
}
/** Click the inbox (envelope) button at the left of the tab bar. */
export async function openInbox(p: Page): Promise<void> {
  await p.eval(`document.elementFromPoint(262, 22).closest('button').click()`);
  await sleep(1200);
}
