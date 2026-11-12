/**
 * The scroll e2e harness (scroll_e2e_test.ts): a real Studio web server (Deno, in-process agent host, its own temp state folder,
 * a free port; never 8767/8768/8777/8778), the scripted agent work/scroll-fixture/agent.py as "Claude Code", and a headless
 * Chrome or Edge (no window) on chat.html. A test appends one line per step to a chat's script file and the agent sends it at
 * once, so what arrives and when is decided by the test, not a timer.
 *
 * AIB_SCROLL_V2=0 runs every test against the old main-list scroll code (the one-release switch, localStorage aib-scroll-v2).
 *
 * Measuring: `m(page, box)` reads the list's scrollTop / scrollHeight / clientHeight, its distance from the bottom (gap), whether
 * it is paused, and the newest row's box against the list's box. `frames(page, box, ms)` records the same every animation frame.
 */
import { Fixture, nativePath, PY, sleep, until, type Web } from './_host_fixture.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { WORK } from './_parity.ts';

export { browserPath, sleep };
export type { Page };

export const SCROLL_AGENT = nativePath(new URL('scroll-fixture/agent.py', WORK));

/** Fixture with the scripted agent as the Claude launcher. */
export class ScrollFixture extends Fixture {
  override agentFlags(): string[] {
    const flags = super.agentFlags();
    flags[flags.indexOf('--claude-launcher') + 1] = SCROLL_AGENT;
    return flags;
  }
}

/** One owner of the chat lists' scroll position, checked while the tests run: every page wraps the scrollTop setter, and a
 *  write to a list the scroll controller manages (class scroll-list) that does not come from scroll-controller.js is recorded
 *  (page code only: a test's own script, which has no URL, moves the list the way you would). `ownerProblems` reads them. */
export const OWNER_GUARD = `(() => {
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (!d || !d.set) return;
  window.__badWrites = [];
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get: d.get,
    set(v) {
      if (this.classList && this.classList.contains('scroll-list')) {
        const st = String(new Error().stack || '');
        if (!st.includes('scroll-controller.js') && st.includes('http://'))
          window.__badWrites.push((this.id || this.className) + ' <- ' + st.split(String.fromCharCode(10)).slice(2, 4).map((l) => l.trim()).join(' | '));
      }
      d.set.call(this, v);
    },
  });
})()`;
export async function ownerProblems(page: Page): Promise<string> {
  if (Deno.env.get('AIB_SCROLL_V2') === '0') return ''; // the old code writes from everywhere: that is what it is
  const bad = await page.eval<string[]>('window.__badWrites || []').catch(() => []);
  return bad.length ? `scrollTop set on a managed list outside scroll-controller.js: ${[...new Set(bad)].slice(0, 4).join(' ;; ')}` : '';
}

export interface Chat {
  id: string;
  sid: string;
  key: string;
  /** Start a scripted turn (the next lines of a fresh script file). */
  start(): Promise<void>;
  /** The first line of a prompt you type yourself in the composer: sending it starts a scripted turn (a fresh script file). */
  nextPrompt(): string;
  /** Append steps to the open turn's script. */
  step(...lines: unknown[]): void;
  /** Shorthands. */
  say(text: string): void;
  tool(id: string, title: string, status?: string, extra?: Record<string, unknown>): void;
  toolDone(id: string, output?: string): void;
  end(): void;
}

export interface Saved {
  key: string;
  user(text: string): void;
  say(text: string): void;
  tool(name: string, input: Record<string, unknown>, output: string): void;
}

export class Lab {
  fx = new ScrollFixture();
  web!: Web;
  browser!: Browser;
  page!: Page;
  #scripts = 0;

  static async open(width = 1600, height = 900): Promise<Lab> {
    const lab = new Lab();
    try {
      lab.web = await lab.fx.startWeb(['--in-process', '--no-auto-reconnect', '--no-owner-announcements']);
      lab.browser = await Browser.launch();
      lab.page = await lab.browser.open('about:blank', width, height);
      await lab.page.send('Page.addScriptToEvaluateOnNewDocument', { source: OWNER_GUARD });
      await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
      await lab.page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
      if (Deno.env.get('AIB_SCROLL_V2') === '0') {
        // the one-release switch back to the old main-list scroll code (chat.js SCROLL_V2): the same tests against it
        await lab.page.eval(`localStorage.setItem('aib-scroll-v2', '0')`);
        await lab.page.goto(`http://127.0.0.1:${lab.web.port}/chat.html`);
        await lab.page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
      }
    } catch (error) {
      await lab.close();
      throw error;
    }
    return lab;
  }

  /** A new live chat with the scripted agent (its own sub-folder of the workspace, so two chats can share or not). */
  async chat(folder = ''): Promise<Chat> {
    const cwd = folder ? `${this.fx.workspace}\\${folder}` : this.fx.workspace;
    if (folder) Deno.mkdirSync(cwd, { recursive: true });
    const [status, connection] = await this.web.post('connect', { provider: 'claude', cwd, background: true });
    if (status !== 200) throw new Error(`connect: ${status} ${JSON.stringify(connection)}`);
    const id = connection.id as string;
    const st = await until(async () => {
      const s = await this.web.state(id);
      return s.ready && s.sessionId ? s : null;
    }, 'connection ready', 60);
    const sid = st.sessionId as string;
    let file = '';
    const append = (o: unknown) => Deno.writeTextFileSync(file, JSON.stringify(o) + '\n', { append: true });
    const chat: Chat = {
      id,
      sid,
      key: `claude:${sid}`,
      start: async () => {
        file = `${this.fx.root}\\script-${++this.#scripts}.jsonl`;
        Deno.writeTextFileSync(file, '');
        const [s, body] = await this.web.post('prompt', { id, text: `script:${file}`, clientMessageId: `t${this.#scripts}` });
        if (s !== 200) throw new Error(`prompt: ${s} ${JSON.stringify(body)}`);
      },
      nextPrompt: () => {
        file = `${this.fx.root}\\script-${++this.#scripts}.jsonl`;
        Deno.writeTextFileSync(file, '');
        return `script:${file}`;
      },
      step: (...lines) => lines.forEach(append),
      say: (text) => append({ u: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }),
      tool: (tid, title, status = 'in_progress', extra = {}) =>
        append({ u: { sessionUpdate: 'tool_call', toolCallId: tid, title, kind: 'execute', status, ...extra } }),
      toolDone: (tid, output) =>
        append({
          u: {
            sessionUpdate: 'tool_call_update',
            toolCallId: tid,
            status: 'completed',
            ...(output != null ? { rawOutput: output } : {}),
          },
        }),
      end: () => append({ end: 'end_turn' }),
    };
    return chat;
  }

  /** A saved Claude Code transcript (no live connection: the page reads it through /api/transcript every 1.5 s, the way it
   *  watches a chat another program is writing). `add*` append rows to the file at once. */
  savedChat(session: string): Saved {
    const cwd = this.fx.workspace;
    const folder = `${this.fx.root}\\claude\\${cwd.replace(/[^A-Za-z0-9]/g, '-')}`;
    Deno.mkdirSync(folder, { recursive: true });
    const file = `${folder}\\${session}.jsonl`;
    let n = 0;
    let clock = Date.now() - 3600_000;
    const row = (type: string, message: Record<string, unknown>) => {
      clock += 1000;
      n++;
      Deno.writeTextFileSync(
        file,
        JSON.stringify({ type, sessionId: session, cwd, timestamp: new Date(clock).toISOString(), uuid: `${session}-${n}`, message }) + '\n',
        { append: true },
      );
    };
    const saved: Saved = {
      key: `claude:${session}`,
      user: (text) => row('user', { role: 'user', content: text }),
      say: (text) => row('assistant', { role: 'assistant', model: 'scroll-model', content: [{ type: 'text', text }] }),
      tool: (name, input, output) => {
        const id = `toolu_${session}_${n + 1}`;
        row('assistant', { role: 'assistant', model: 'scroll-model', content: [{ type: 'tool_use', id, name, input }] });
        row('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] });
      },
    };
    return saved;
  }

  /** Select a chat in the sidebar (a real click) and wait for its list to be drawn. */
  async select(chat: { key: string }): Promise<void> {
    const sel = `button.connection[data-key="${chat.key}"]`;
    await this.page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 20000, `sidebar row ${chat.key}`);
    await this.page.click(sel);
    await this.page.waitFor(
      `document.querySelector(${JSON.stringify(sel)})?.classList.contains('selected') && !!document.querySelector('#messages > *')`,
      20000,
      'chat open',
    );
  }

  async close(): Promise<void> {
    try {
      await this.page?.close();
    } catch { /* gone */ }
    try {
      await this.browser?.close();
    } catch { /* gone */ }
    await this.fx.cleanup();
  }
}

/** One measurement of a list. */
export interface M {
  top: number;
  height: number;
  client: number;
  gap: number;
  paused: boolean;
  rows: number;
  /** newest top-level row: its top and bottom against the list's visible box (0 = list top; client = list bottom) */
  lastTop: number;
  lastBottom: number;
  lastText: string;
  jump: string | null;
  /** long blocks (pre / terminal output) drawn taller than the clamp although nobody pressed "Show all" (a flash open) */
  tall: number;
}

/** A list by id ('messages') or by CSS selector ('.pane:not(.foc) .mirror-msgs'): the same code in every probe below. */
export const BOX = `((b) => (/^[A-Za-z][\\w-]*$/.test(b) ? document.getElementById(b) : document.querySelector(b)))`;

export const PROBE = `(id) => {
  const box = ${BOX}(id);
  const kids = [...box.children].filter((e) => e.offsetParent !== null && !e.classList.contains('new-line'));
  const last = kids[kids.length - 1];
  const b = box.getBoundingClientRect();
  const r = last ? last.getBoundingClientRect() : { top: 0, bottom: 0 };
  const j = document.getElementById('jumpNew');
  return {
    top: Math.round(box.scrollTop), height: box.scrollHeight, client: box.clientHeight,
    gap: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight), paused: !!box.dataset.paused, rows: box.children.length,
    lastTop: Math.round(r.top - b.top), lastBottom: Math.round(r.bottom - b.top),
    lastText: last ? String(last.textContent).replace(/\\s+/g, ' ').slice(0, 60) : '',
    jump: j && !j.hidden ? j.textContent : null,
    tall: [...box.querySelectorAll('pre, .client-terminal-output')].filter((e) => {
      if (e.classList.contains('clamp-on') || e.offsetParent === null) return false;
      const t = e.nextElementSibling;
      if (t && t.classList.contains('clamp-toggle') && t.getAttribute('aria-expanded') === 'true') return false;
      return e.offsetHeight > 360;
    }).length,
  };
}`;

export function m(page: Page, box = 'messages'): Promise<M> {
  return page.eval<M>(`(${PROBE})(${JSON.stringify(box)})`);
}

/** Run `sample` once per animation frame, AFTER the frame: requestAnimationFrame callbacks run before that frame's layout and
 *  ResizeObservers, so a measurement taken there can show a state that is never painted (the observers correct it before paint);
 *  a task queued from the frame runs once the frame is done, so it reads what was drawn. One exception: another task between the
 *  frame and the sample may change the layout (a column width set from a timer); the sample would then read a layout no frame
 *  painted yet. `size()` (the list's size) is read in the frame and in the sample: when they differ the sample is skipped. */
export const AFTER_EACH_FRAME = `((sample, on, size) => {
  const tick = () => {
    if (!on()) return;
    const at = size ? size() : '';
    setTimeout(() => { if (!on()) return; if (!size || size() === at) sample(); requestAnimationFrame(tick); }, 0);
  };
  requestAnimationFrame(tick);
})`;
const SIZE = (box: string) => `() => { const b = ${BOX}(${JSON.stringify(box)}); return b ? b.clientWidth + 'x' + b.clientHeight : ''; }`;

/** Record a measurement every animation frame (as drawn) until stopFrames. */
export async function startFrames(page: Page, box = 'messages'): Promise<void> {
  await page.eval(`(() => {
    const probe = ${PROBE};
    window.__frames = [];
    const gen = (window.__framesGen = (window.__framesGen || 0) + 1); // one recording at a time: an older loop stops for good
    ${AFTER_EACH_FRAME}(() => window.__frames.push(probe(${JSON.stringify(box)})), () => window.__framesGen === gen, ${SIZE(box)});
  })()`);
}
export function stopFrames(page: Page): Promise<M[]> {
  return page.eval<M[]>(`(() => { window.__framesGen = (window.__framesGen || 0) + 1; return window.__frames; })()`);
}

/** Wait until the list's text contains `text` (the step reached the page). */
export function shown(page: Page, text: string, box = 'messages', ms = 15000): Promise<unknown> {
  return page.waitFor(
    `${BOX}(${JSON.stringify(box)}).textContent.includes(${JSON.stringify(text)})`,
    ms,
    `"${text}" in ${box}`,
  );
}

/** Record, every animation frame, where the row whose text starts with `text` (as anchor() read it) is against the list's
 *  top, and its height: {off, h} per frame as drawn, null in frames where the row is not drawn. A test that measures only once after a
 *  second sees the end state; this sees the frames the owner sees, so a jump that a timer puts right later still fails. */
export async function startRowFrames(page: Page, text: string, box = 'messages'): Promise<void> {
  await page.eval(`(() => {
    const b = ${BOX}(${JSON.stringify(box)}), want = ${JSON.stringify(text)};
    const rows = (window.__rows = []);
    const gen = (window.__rowsGen = (window.__rowsGen || 0) + 1);
    ${AFTER_EACH_FRAME}(() => {
      const top = b.getBoundingClientRect().top;
      const e = [...b.children].find((x) => x.textContent.replace(/\\s+/g, ' ').slice(0, 80) === want);
      const r = e ? e.getBoundingClientRect() : null;
      rows.push(r && r.height ? { off: Math.round(r.top - top), h: Math.round(r.height), st: Math.round(b.scrollTop) } : null);
    }, () => window.__rowsGen === gen, ${SIZE(box)});
  })()`);
}
export function stopRowFrames(page: Page): Promise<({ off: number; h: number; st: number } | null)[]> {
  return page.eval(`(() => { window.__rowsGen = (window.__rowsGen || 0) + 1; return window.__rows; })()`);
}
/** Frames in which the row was drawn somewhere other than `off` (more than `tol` px; a row that re-wrapped keeps the same
 *  point of itself: a negative offset scales with its height). '' when every drawn frame had it in place. */
export function rowFramesProblems(frames: ({ off: number; h: number } | null)[], before: { off: number; h?: number }, tol = 1): string {
  const drawn = frames.filter((f): f is { off: number; h: number } => !!f);
  const want = (f: { h: number }) => (before.off < 0 && before.h ? Math.round((before.off * f.h) / before.h) : before.off);
  const bad = drawn.filter((f) => Math.abs(f.off - want(f)) > tol);
  if (!drawn.length) return `the row was not drawn in any of ${frames.length} frames`;
  return bad.length ? `the row was off its place in ${bad.length}/${drawn.length} frames: at ${[...new Set(bad.map((f) => f.off))].slice(0, 8).join(', ')} instead of ${before.off}` : '';
}

/** Let pending timers (holdAnchor 60/250/800 ms, the 600 ms touch window) and a poll or two run out. */
export const settle = (ms = 1000) => sleep(ms);

/** Scroll the list by a wheel gesture at its centre (a real input event, so the page sees you reading). */
export async function wheel(page: Page, dy: number, box = 'messages'): Promise<void> {
  const [x, y] = await page.eval<[number, number]>(
    `(() => { const r = ${BOX}(${JSON.stringify(box)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  await sleep(150);
}

export const PYTHON = PY;

/** The first row at the top of the list's view: its text and its offset from the list's top (what must not move while you read). */
export function anchor(page: Page, box = 'messages'): Promise<{ text: string; off: number } | null> {
  return page.eval(`(() => {
    const b = ${BOX}(${JSON.stringify(box)}), top = b.getBoundingClientRect().top;
    for (const e of b.children) {
      const r = e.getBoundingClientRect();
      if (r.height && r.bottom > top + 1) return { text: e.textContent.replace(/\\s+/g, ' ').slice(0, 80), off: Math.round(r.top - top) };
    }
    return null;
  })()`);
}

/** Where the row with this exact text (as anchor() read it) is now, against the list's top; null when it is gone. */
export function whereIs(page: Page, text: string, box = 'messages'): Promise<number | null> {
  return page.eval(`(() => {
    const b = ${BOX}(${JSON.stringify(box)}), top = b.getBoundingClientRect().top;
    const e = [...b.children].find((x) => x.textContent.replace(/\\s+/g, ' ').slice(0, 80) === ${JSON.stringify(text)});
    return e ? Math.round(e.getBoundingClientRect().top - top) : null;
  })()`);
}

/** The top of the last element matching a selector, against the list's top (null: none). */
export function topOf(page: Page, selector: string, box = 'messages'): Promise<number | null> {
  return page.eval(`(() => {
    const all = document.querySelectorAll(${JSON.stringify(selector)}), e = all[all.length - 1];
    return e ? Math.round(e.getBoundingClientRect().top - ${BOX}(${JSON.stringify(box)}).getBoundingClientRect().top) : null;
  })()`);
}

/** A real mouse click on the last element matching a selector, where it is now: never scrolls it into view first (that would
 *  move the list the test is measuring). Fails if the element is not inside the window. */
export async function clickHere(page: Page, selector: string): Promise<void> {
  const at = await page.eval<[number, number] | string>(`(() => {
    const all = document.querySelectorAll(${JSON.stringify(selector)}), e = all[all.length - 1];
    if (!e) return 'no element';
    const r = e.getBoundingClientRect(), x = r.left + Math.min(20, r.width / 2), y = r.top + r.height / 2;
    if (y < 0 || y > innerHeight || r.height === 0) return 'outside the window at y=' + Math.round(y);
    return [x, y];
  })()`);
  if (typeof at === 'string') throw new Error(`clickHere ${selector}: ${at}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
  }
}

/** A solid-colour PNG (base64) of the given size: a picture whose height is only known once it decodes. */
export async function png(width: number, height: number): Promise<string> {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([40, 120, 200], y * (width * 3 + 1) + 1 + x * 3);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array())];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) all.set(p, (o += p.length) - p.length);
  let bin = '';
  for (const b of all) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Follow mode: at the bottom (1 px), not paused, the newest row's bottom inside the list. */
export function following(x: M): string {
  const bad = [];
  if (x.gap > 1) bad.push(`${x.gap} px from the bottom`);
  if (x.paused) bad.push('paused (follow switched off)');
  if (x.lastBottom > x.client + 1) bad.push(`newest row ends ${x.lastBottom - x.client} px below the list`);
  return bad.join(', ');
}

/** Frames recorded while following: every frame at the bottom and no long block flashed open. */
export function framesProblems(frames: M[]): string {
  const off = frames.filter((f) => f.gap > 1 && !f.paused);
  const tall = frames.filter((f) => f.tall > 0);
  const bad = [];
  if (off.length) bad.push(`${off.length}/${frames.length} frames not at the bottom (gaps ${off.slice(0, 6).map((f) => f.gap).join(', ')})`);
  if (tall.length) bad.push(`${tall.length}/${frames.length} frames with a long block drawn unclamped`);
  if (frames.some((f) => f.paused)) bad.push(`follow switched off in ${frames.filter((f) => f.paused).length} frames`);
  return bad.join('; ');
}
