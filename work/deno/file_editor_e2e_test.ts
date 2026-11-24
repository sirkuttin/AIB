/**
 * Real binary (slow: one `deno desktop` build, shared through _build_cache.ts; AIB_SLOW_TESTS=1, Windows only): the file editor v1
 * (aib-shared/designs/file-editor; architect review 2026-11-16) in the real AIB window (WebView2) on an invisible desktop
 * (_hidden_desktop.ts): nothing shows on the person's screen. Its own data folders; never the owner's ports, ~/.claude or ~/.codex.
 * Keys are real key presses (CDP Input.dispatchKeyEvent). Only processes this test started are killed.
 *
 * Must-fixes (the server-only halves are in file_editor_server_test.ts):
 *   1  in the editor beside a chat: every printable ASCII key, `?`, End, Home, Alt+↑/↓ and Alt+N go to the editor; no shortcut sheet,
 *      no chat switch, no new chat, the chat does not scroll; Ctrl+K then Esc puts the caret back in the editor
 *   2  an emoji changed on disk merges into a dirty tab and the save writes exactly the expected bytes
 *   3  an agent's change next to the user's line merges; on the user's line it is an overlap (gutter marker, "1 overlap · Compare");
 *      Save keeps the user's line and the agent's other lines
 *   4  a disk change while the project's pause lock is held (a landing or Undo moving the folder) is not read until it is let go
 *   5  Ctrl+S right after typing saves the last keystrokes; the dirty dot follows the text (typing back to the disk's text clears it);
 *      unsaved text survives a reload of the page and a restart of AIB, which never asks "Save changes?"
 *   6  no file socket without the page token (a paired computer: file_editor_server_test.ts)
 *   8  a binary file opens read-only; a BOM + CRLF file keeps its bytes; a disk change to non-UTF-8 is never merged and Save asks twice
 * Owner rules: a project file opens editable at once; aib-docs is read-only with "Open in Docs"; a helper's copy is read-only with
 * "Edit in project folder", which opens the project's file editable; Ctrl+P is Switch project, Ctrl+K opens files; Compare opens in
 * the same pane at the same width and the right column keeps its width; Save and the dirty dot are visible buttons; closing a dirty
 * tab asks by the tab (Cancel keeps the text, Don't save leaves the disk as it was).
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { builtDist } from './_build_cache.ts';
import { devToolsPortNow, ownerPort, pickPort, refusedPort } from './_ports.ts';
import { APP_VERSION } from '../../app/server/core/app.ts';
import { projectKey } from '../../app/server/desktop/project_delete.ts';
import { pauseLock } from '../../app/server/worktrees/worktrees.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
type Json = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function unzip(zip: string, into: string): Promise<void> {
  Deno.mkdirSync(into, { recursive: true });
  const r = await new Deno.Command('C:\\Windows\\System32\\tar.exe', { args: ['-xf', zip, '-C', into] }).output();
  assert(r.success, `unzip ${zip}`);
}

async function killUnder(folder: string): Promise<void> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${
    folder.replaceAll("'", "''")
  }', 'OrdinalIgnoreCase') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await new Deno.Command('powershell', { args: ['-NoProfile', '-NonInteractive', '-Command', script] }).output();
}

/** One CDP session on the main window's page (w=m): evaluate, and real key presses. */
class Cdp {
  #ws: WebSocket;
  #next = 1;
  #waiting = new Map<number, (r: Json) => void>();
  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as Json;
      const done = typeof m.id === 'number' ? this.#waiting.get(m.id) : undefined;
      if (done) {
        this.#waiting.delete(m.id as number);
        done(m);
      }
    };
  }
  static async open(root: string, port: number): Promise<Cdp> {
    const cdp = devToolsPortNow(root);
    if (!cdp) throw new Error('no DevToolsActivePort yet');
    const targets = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json() as Json[];
    const page = targets.find((t) => {
      if (t.type !== 'page' || !String(t.url).startsWith(`http://127.0.0.1:${port}`)) return false;
      try {
        return (new URL(String(t.url)).searchParams.get('w') || 'm') === 'm';
      } catch {
        return false;
      }
    });
    if (!page) throw new Error('no main page target yet');
    const ws = new WebSocket(String(page.webSocketDebuggerUrl));
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  send(method: string, params: Json = {}): Promise<Json> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const res = reply.result as Json | undefined;
    if (res?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(res.exceptionDetails).slice(0, 700)}`);
    return (res?.result as Json)?.value as T;
  }
  /** A real key press: modifiers 1 Alt, 2 Ctrl, 8 Shift. */
  async key(key: string, code: string, vk: number, modifiers = 0): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  /** A real printable key press (keydown carries the text, as a keyboard does). */
  async char(ch: string): Promise<void> {
    if (ch === '\n') return await this.key('Enter', 'Enter', 13);
    const c = ch.charCodeAt(0);
    const upper = ch >= 'A' && ch <= 'Z', lower = ch >= 'a' && ch <= 'z', digit = ch >= '0' && ch <= '9';
    const vk = lower ? c - 32 : upper || digit || ch === ' ' ? c : 0;
    const modifiers = upper || '~!@#$%^&*()_+{}|:"<>?'.includes(ch) ? 8 : 0;
    const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async type(text: string): Promise<void> {
    for (const ch of text) await this.char(ch);
  }
  close(): void {
    this.#ws.close();
  }
}

/** The page helpers the scenarios use (evaluated once per page load). */
const HELPERS = `(() => {
  const FE = () => window.AgentFileEditor;
  window.__fe = {
    pane(where, path) {
      for (const [k, p] of FE()._panes) if (k.startsWith(where + '|') && p.tab && p.tab.path === path) return p;
      return null;
    },
    ready(where, path) { const p = this.pane(where, path); return !!(p && p.ed); },
    text(where, path) { const p = this.pane(where, path); return p && p.ed ? p.ed.view.state.doc.toString() : null; },
    box(where) { return where === 'beside' ? document.querySelector('#fileBeside .sf-fileview') : document.getElementById('fileView'); },
    tools(where) { const b = this.box(where); const t = b && b.querySelector('.sf-fv-tools'); return t ? t.textContent : ''; },
    foot(where) { const b = this.box(where); const t = b && b.querySelector('.fx-pv-foot'); return t ? t.textContent : ''; },
    caret(where, path, at) {
      const p = this.pane(where, path), v = p.ed.view;
      const pos = at === 'end' ? v.state.doc.length : typeof at === 'number' ? at : v.state.doc.line(at.line).from + (at.col || 0);
      v.dispatch({ selection: { anchor: pos } });
      v.focus();
      return document.activeElement === p.host;
    },
    inEditor(where, path) {
      const p = this.pane(where, path);
      return !!p && document.activeElement === p.host && !!p.shadow.activeElement && !!p.shadow.activeElement.closest('.cm-editor');
    },
    marks(where, path) { const p = this.pane(where, path); return p && p.shadow ? p.shadow.querySelectorAll('.cm-aib-overlap-line').length : 0; },
    gutterMarks(where, path) {
      const p = this.pane(where, path);
      return p && p.shadow ? [...p.shadow.querySelectorAll('.cm-aib-overlap')].filter((e) => getComputedStyle(e.closest('.cm-gutterElement')).visibility !== 'hidden').length : 0;
    },
    dirtyDot(path) {
      return [...document.querySelectorAll('.sf-ftab')].some((t) => t.querySelector('.ws-tab-main').title.split('\\n')[0].endsWith(path) && t.querySelector('.ws-tab-x.sf-dirty'));
    },
    click(where, label) {
      const b = [...this.box(where).querySelectorAll('.sf-fv-tools button, .sf-fv-alert button')].find((x) => x.textContent.trim() === label);
      if (!b) return false;
      b.click();
      return true;
    },
    open(path, opts) { AgentFilesUI.openFile(AgentFilesUI.currentScope(), path, Object.assign({ keep: true }, opts || {})); return true; },
    diag() {
      const out = { clients: [], tabs: [...document.querySelectorAll('.sf-ftab')].map((t) => t.querySelector('.ws-tab-main').title.split('\\n')[0] + ':' + t.querySelector('.ws-tab-x').className) };
      for (const [id, c] of FE()._clients) out.clients.push({ id, synced: c.client.synced, localDirty: c.client.localDirty, meta: c.client.meta.toJSON(), overlaps: c.client.overlaps.length });
      return JSON.stringify(out).slice(0, 3000);
    },
  };
  return true;
})()`;

/** ~60 messages, so the chat can scroll (End would jump it to the bottom). */
function transcript(alpha: string): string {
  const stamp = new Date(Date.now() - 60_000).toISOString();
  const rows: Json[] = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ type: 'user', sessionId: 's-alpha', cwd: alpha, timestamp: stamp, message: { role: 'user', content: `Question ${i}: tell me more about the helpers` } });
    rows.push({
      type: 'assistant',
      sessionId: 's-alpha',
      cwd: alpha,
      timestamp: stamp,
      message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: `Answer ${i}.\n\n` + 'A longer line of text about the helpers. '.repeat(8) }] },
    });
  }
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

Deno.test({
  name: 'real binary: the file editor v1 (must-fixes 1-8 and the owner rules)',
  ignore: !SLOW,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => reject(new Error('gave up after 15 minutes')), 15 * 60_000);
    });
    await using fx = new Fixture();
    const desk = new HiddenDesktop();
    const saved = Deno.env.toObject();
    try {
      await Promise.race([deadline, run(fx, desk, saved)]);
    } finally {
      clearTimeout(giveUp);
      await killUnder(`${fx.root}\\install`);
      desk.close();
      for (const k of Object.keys(Deno.env.toObject())) if (!(k in saved)) Deno.env.delete(k);
      for (const [k, v] of Object.entries(saved)) Deno.env.set(k, v);
    }
  },
});

async function run(fx: Fixture, desk: HiddenDesktop, saved: Record<string, string>): Promise<void> {
  const dist = await builtDist();
  const app = `${fx.root}\\install\\A`;
  await unzip(`${dist}\\AIB-${APP_VERSION}-windows-x64.zip`, app);
  const alpha = `${fx.root}\\projects\\Alpha`;
  const at = (rel: string) => `${alpha}\\${rel.replaceAll('/', '\\')}`;
  const files: Record<string, string | Uint8Array> = {
    'src/app.ts': Array.from({ length: 8 }, (_, i) => `export const v${i + 1} = ${i + 1};\n`).join(''),
    'src/keys.ts': 'export const typed = "";\n// line two\n// line three\n',
    'src/emoji.ts': 'export const face = "😀";\nexport const n = 1;\n',
    'crlf.txt': '\uFEFFone\r\ntwo\r\n',
    'notes.txt': 'first\nsecond\n',
    'bin.dat': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]),
    'aib-docs/plan/01-page-1.md': '# Plan\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    Deno.mkdirSync(at(rel).slice(0, at(rel).lastIndexOf('\\')), { recursive: true });
    Deno.writeFileSync(at(rel), typeof body === 'string' ? enc(body) : body);
  }
  const added = { [projectKey(alpha)]: { path: alpha, at: 1 } };
  Deno.mkdirSync(`${fx.root}\\claude\\enc`, { recursive: true });
  Deno.writeTextFileSync(`${fx.root}\\claude\\enc\\s-alpha.jsonl`, transcript(alpha));
  Deno.writeTextFileSync(`${fx.state}\\studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, start: 'fresh', added }));
  const home = `${fx.root}\\home`;
  const env: Record<string, string> = {
    AGENT_STUDIO_STATE_DIR: fx.state,
    APPDATA: `${fx.root}\\appdata`,
    LOCALAPPDATA: `${fx.root}\\localappdata`,
    CODEX_HOME: `${home}\\.codex`,
    CLAUDE_CONFIG_DIR: `${home}\\.claude`,
    AIB_UPDATE_API_BASE: `http://127.0.0.1:${refusedPort()}`,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
  };
  for (const d of [env.APPDATA, env.LOCALAPPDATA, home]) Deno.mkdirSync(d, { recursive: true });
  const flags = ['--state-dir', fx.state, '--omp-sessions', `${fx.root}\\omp`, '--claude-projects', `${fx.root}\\claude`, '--owners-dir', fx.owners];
  const launch = async (): Promise<{ cdp: Cdp; port: number }> => {
    let port = pickPort(true);
    Deno.writeTextFileSync(`${fx.state}\\desktop-port.json`, JSON.stringify({ port }));
    try {
      for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
      desk.spawn([`${app}\\AIB\\AIB.exe`, ...flags], `${app}\\AIB`);
    } finally {
      for (const k of Object.keys(env)) saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]);
    }
    port = await ownerPort(fx.state, 90);
    let lastErr = '';
    const cdp = await until(async () => {
      try {
        const c = await Cdp.open(app, port);
        if (await c.eval<boolean>(`!!(window.StudioChat && window.AgentWorkspaceUI && window.AgentFilesUI && window.AgentFileEditor && AgentWorkspaceUI.paletteProjects().length >= 1)`)) return c;
        lastErr = 'page up, AIB not ready';
        c.close();
      } catch (e) {
        lastErr = String(e);
      }
      return null;
    }, 'the main page', 120).catch((e) => {
      throw new Error(`${e.message}: ${lastErr}`);
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(HELPERS);
    return { cdp, port };
  };
  let { cdp, port } = await launch();
  const wait = (expr: string, what: string, s = 20) =>
    until(() => cdp.eval<boolean>(expr), what, s).catch(async (e) => {
      throw new Error(`${e.message}
DIAG ${await cdp.eval<string>('window.__fe ? __fe.diag() : ""').catch(() => '')}`);
    });
  const disk = (rel: string) => Deno.readFileSync(at(rel));
  const diskText = (rel: string) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(disk(rel));
  try {
    // record CSP violations (the editor lives in shadow roots: none expected)
    await cdp.eval(`(window.__csp = [], document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || ''))), true)`);
    const pk = await cdp.eval<string>(`AgentWorkspaceUI.paletteProjects().find((p) => p.name === 'Alpha').key`);
    await cdp.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
    await wait(`!!AgentFilesUI.currentScope()`, 'a Files scope for Alpha', 30);

    // ---- owner rule: a project file opens editable at once; must-fix 5: Ctrl+S right after typing; dirty follows the text -------------
    await cdp.eval(`__fe.open('src/app.ts')`);
    await wait(`__fe.ready('main', 'src/app.ts')`, 'the editor in the app.ts tab');
    assert(await cdp.eval<boolean>(`__fe.pane('main', 'src/app.ts').shadow.querySelector('.cm-content').contentEditable === 'true'`), 'editable at once');
    const foot0 = await cdp.eval<string>(`__fe.foot('main')`);
    assert(foot0.includes('LF') && foot0.includes('UTF-8') && foot0.includes('Spaces'), `footer: ${foot0}`);
    assert(await cdp.eval<boolean>(`__fe.click('main', 'Save') === false || [...__fe.box('main').querySelectorAll('.sf-ed-save')].every((b) => b.disabled)`), 'Save is there, disabled while clean');
    await cdp.eval(`__fe.caret('main', 'src/app.ts', { line: 1, col: 'export const v1'.length })`);
    await cdp.type('0');
    await cdp.key('s', 'KeyS', 83, 2); // at once
    await until(() => diskText('src/app.ts').startsWith('export const v10 = 1;\n'), 'the save wrote the last keystroke', 15);
    await wait(`!__fe.dirtyDot('src/app.ts')`, 'no dirty dot after the save');
    await wait(`__fe.foot('main').includes('Saved')`, 'the footer says Saved');
    await cdp.type('9');
    await wait(`__fe.dirtyDot('src/app.ts')`, 'the dirty dot (a visible button in the × box)');
    await cdp.key('Backspace', 'Backspace', 8);
    await wait(`!__fe.dirtyDot('src/app.ts')`, 'typing back to the disk text clears dirty (dirty = text differs)', 10);

    // ---- must-fix 3: a disk change next to the user's line merges; on it, an overlap; Compare in the same pane; Save keeps mine ------
    await cdp.eval(`__fe.caret('main', 'src/app.ts', { line: 3, col: 'export const v3 = 3'.length })`);
    await cdp.type(' + 100');
    await sleep(400);
    const base3 = diskText('src/app.ts');
    Deno.writeTextFileSync(at('src/app.ts'), base3.replace('v6 = 6', 'v6 = 66'));
    await wait(`__fe.text('main', 'src/app.ts').includes('v6 = 66') && __fe.text('main', 'src/app.ts').includes('v3 = 3 + 100')`, 'the disk change merged around the user\'s line');
    Deno.writeTextFileSync(at('src/app.ts'), base3.replace('v6 = 6', 'v6 = 66').replace('v3 = 3', 'v3 = 33').replace('v4 = 4', 'v4 = 44'));
    await wait(`__fe.marks('main', 'src/app.ts') >= 1`, 'the overlap\'s gutter marker');
    await wait(`__fe.text('main', 'src/app.ts').includes('v4 = 44')`, 'the agent\'s next line merged in');
    const t3 = await cdp.eval<string>(`__fe.text('main', 'src/app.ts')`);
    assert(t3.includes('v3 = 3 + 100;') && !t3.includes('v3 = 33'), `the user's line stays: ${t3}`);
    assert((await cdp.eval<number>(`__fe.gutterMarks('main', 'src/app.ts')`)) >= 1, 'a visible gutter marker on the overlapped line');
    await wait(`__fe.tools('main').includes('1 overlap') && __fe.tools('main').includes('Compare')`, 'the tools row: "… changed lines you edited · 1 overlap" + Compare');
    const widths = `({ box: Math.round(__fe.box('main').getBoundingClientRect().width), act: getComputedStyle(document.documentElement).getPropertyValue('--activity-w'), side: getComputedStyle(document.documentElement).getPropertyValue('--side-w') })`;
    const before = await cdp.eval<Json>(widths);
    assert(await cdp.eval<boolean>(`__fe.click('main', 'Compare')`), 'Compare is a visible button');
    await wait(`!!(__fe.box('main').querySelector('.sf-ed-cmp') && __fe.box('main').querySelector('.sf-ed-cmp').shadowRoot.querySelector('.cm-mergeView'))`, 'Compare opened in the same pane');
    assertEquals(await cdp.eval<Json>(widths), before, 'Compare: same pane width, the right column and the chat list keep theirs');
    assert(await cdp.eval<boolean>(`__fe.click('main', 'Back to editing')`));
    await wait(`__fe.ready('main', 'src/app.ts') && !__fe.box('main').querySelector('.sf-ed-cmp')`, 'back to the editor');
    await cdp.eval(`__fe.caret('main', 'src/app.ts', 'end')`);
    await cdp.key('s', 'KeyS', 83, 2);
    await until(() => diskText('src/app.ts').includes('v3 = 3 + 100;'), 'saved (keep mine)', 15);
    const after3 = diskText('src/app.ts');
    assert(after3.includes('v4 = 44') && after3.includes('v6 = 66') && !after3.includes('v3 = 33'), `keep mine kept only the user's line: ${after3}`);
    await wait(`__fe.marks('main', 'src/app.ts') === 0`, 'the overlap closed with the save');

    // ---- must-fix 4: nothing read while the pause lock is held (a landing / Undo moving the folder) ----------------------------------
    await cdp.type('\n// typed');
    const pause = pauseLock(fx.state, alpha, 2);
    await pause.acquire();
    const held = diskText('src/app.ts');
    Deno.writeTextFileSync(at('src/app.ts'), held.replace('v8 = 8', 'v8 = 88'));
    await sleep(4500);
    assert(!(await cdp.eval<string>(`__fe.text('main', 'src/app.ts')`)).includes('v8 = 88'), 'not read while the pause lock is held');
    pause.release();
    await wait(`__fe.text('main', 'src/app.ts').includes('v8 = 88')`, 'read once the lock is let go');
    assert((await cdp.eval<string>(`__fe.text('main', 'src/app.ts')`)).includes('// typed'), 'the unsaved text stayed');

    // ---- must-fix 2: an emoji changed on disk while the tab is dirty; the save's bytes -------------------------------------------------
    await cdp.eval(`__fe.open('src/emoji.ts')`);
    await wait(`__fe.ready('main', 'src/emoji.ts')`, 'the emoji tab');
    await cdp.eval(`__fe.caret('main', 'src/emoji.ts', 'end')`);
    await cdp.type('// mine\n');
    await sleep(400);
    Deno.writeTextFileSync(at('src/emoji.ts'), 'export const face = "😃";\nexport const n = 1;\n');
    await wait(`__fe.text('main', 'src/emoji.ts').includes('😃')`, 'the emoji change merged');
    await cdp.key('s', 'KeyS', 83, 2);
    await until(() => diskText('src/emoji.ts').includes('// mine'), 'the emoji file saved', 15);
    assertEquals(disk('src/emoji.ts'), enc('export const face = "😃";\nexport const n = 1;\n// mine\n'), 'byte for byte, no U+FFFD');

    // ---- must-fix 8: BOM + CRLF bytes; a binary file is read-only; non-UTF-8 on disk is never merged ------------------------------
    await cdp.eval(`__fe.open('crlf.txt')`);
    await wait(`__fe.ready('main', 'crlf.txt')`, 'the CRLF tab');
    const footCrlf = await cdp.eval<string>(`__fe.foot('main')`);
    assert(footCrlf.includes('CRLF') && footCrlf.includes('BOM'), `footer: ${footCrlf}`);
    await cdp.eval(`__fe.caret('main', 'crlf.txt', 'end')`);
    await cdp.type('three\n');
    await cdp.key('s', 'KeyS', 83, 2);
    await until(() => diskText('crlf.txt').includes('three'), 'the CRLF file saved', 15);
    assertEquals(disk('crlf.txt'), enc('\uFEFFone\r\ntwo\r\nthree\r\n'), 'BOM and CRLF kept');
    await cdp.eval(`__fe.open('bin.dat')`);
    await wait(`__fe.foot('main').includes('Read-only')`, 'a binary file is read-only');
    assert(!(await cdp.eval<boolean>(`__fe.ready('main', 'bin.dat')`)), 'no editor for a binary file');
    await cdp.eval(`__fe.open('notes.txt')`);
    await wait(`__fe.ready('main', 'notes.txt')`, 'the notes tab');
    await cdp.eval(`__fe.caret('main', 'notes.txt', 'end')`);
    await cdp.type('mine\n');
    await sleep(400);
    Deno.writeFileSync(at('notes.txt'), new Uint8Array([0x66, 0x69, 0xe9, 0x0a])); // Latin-1: not UTF-8
    await wait(`__fe.tools('main').includes("can't edit")`, 'the tools row says the disk changed to a form AIB can\'t edit');
    assertEquals(await cdp.eval<string>(`__fe.text('main', 'notes.txt')`), 'first\nsecond\nmine\n', 'never merged: the user\'s text stays');
    await cdp.key('s', 'KeyS', 83, 2);
    await wait(`__fe.tools('main').includes('Save overwrites')`, 'Save asks for a second press');
    assertEquals(disk('notes.txt'), new Uint8Array([0x66, 0x69, 0xe9, 0x0a]), 'nothing written on the first press');
    await cdp.key('s', 'KeyS', 83, 2);
    await until(() => diskText('notes.txt') === 'first\nsecond\nmine\n', 'the second press overwrote it', 15);

    // ---- owner rules: aib-docs read-only with Open in Docs; a helper's copy read-only with Edit in project folder ------------------
    await cdp.eval(`__fe.open('aib-docs/plan/01-page-1.md')`);
    await wait(`__fe.foot('main').includes('Read-only') && __fe.tools('main').includes('Open in Docs')`, 'aib-docs: read-only with Open in Docs');
    const copy = await cdp.eval<boolean>(`(() => {
      const s = AgentFilesUI.currentScope();
      AgentFilesUI.openFile(Object.assign({}, s, { root: 'chat', branch: 'aib/helper-fix', label: 'Copy', id: s.id }), 'src/app.ts', { keep: true });
      return true;
    })()`);
    assert(copy);
    await wait(`__fe.tools('main').includes('Edit in project folder')`, 'a helper copy shows Edit in project folder', 20).catch(async (e) => {
      throw new Error(`${e.message}: ${await cdp.eval<string>(`__fe.foot('main') + ' | ' + __fe.tools('main')`)}`);
    });
    assert((await cdp.eval<string>(`__fe.foot('main')`)).includes('Read-only'), 'the copy is read-only');
    assert(await cdp.eval<boolean>(`__fe.click('main', 'Edit in project folder')`));
    await wait(`__fe.ready('main', 'src/app.ts') && AgentFilesUI.currentScope() && [...AgentFileEditor._panes.keys()].some((k) => k.startsWith('main|'))`, 'the project file opened editable');

    // ---- must-fix 1: real keys in the editor BESIDE the chat -------------------------------------------------------------------------
    await wait(`!!document.querySelector('button.connection[data-key="claude:s-alpha"]')`, 'the chat in the list', 30);
    await cdp.eval(`document.querySelector('button.connection[data-key="claude:s-alpha"]').click(), true`);
    await wait(`!document.getElementById('chat').hidden && document.querySelectorAll('#messages > *').length > 10`, 'the chat shows', 30);
    await cdp.eval(`__fe.open('src/keys.ts', { beside: true })`);
    await wait(`__fe.ready('beside', 'src/keys.ts')`, 'the editor beside the chat', 30).catch(async (e) => {
      throw new Error(`${e.message}: beside=${await cdp.eval<string>(`String(!!document.body.classList.contains('sf-beside-on')) + ' ' + innerWidth`)}`);
    });
    const m = document_messages();
    await cdp.eval(`(() => { const m = ${m}; m.scrollTop = 200; return m.scrollTop; })()`);
    const aib = `({ selected: (document.querySelector('button.connection.selected, button.connection[aria-current="true"]') || {}).dataset?.key || '',
      dialog: !!document.querySelector('dialog[open]'), setup: !document.getElementById('setup').hidden,
      scroll: Math.round(${m}.scrollTop), conversations: document.querySelectorAll('button.connection').length,
      besideW: Math.round(document.getElementById('fileBeside').getBoundingClientRect().width),
      act: getComputedStyle(document.documentElement).getPropertyValue('--activity-w') })`;
    await cdp.eval(`__fe.caret('beside', 'src/keys.ts', { line: 1, col: 'export const typed = '.length })`);
    const aibBefore = await cdp.eval<Json>(aib);
    assert(await cdp.eval<boolean>(`__fe.inEditor('beside', 'src/keys.ts')`), 'the caret is in the editor beside the chat');
    let ascii = '';
    for (let c = 32; c < 127; c++) ascii += String.fromCharCode(c);
    await cdp.type(ascii);
    const typed = await cdp.eval<string>(`__fe.text('beside', 'src/keys.ts')`);
    for (const ch of ascii) assert(typed.includes(ch), `the key ${JSON.stringify(ch)} reached the editor`);
    assert(typed.split('\n')[0].length >= 'export const typed = ""'.length + 95, `every key typed: ${typed.split('\n')[0]}`);
    assertEquals(await cdp.eval<Json>(aib), aibBefore, 'printable keys incl. `?`: no shortcut sheet, nothing else in AIB changed');
    await cdp.key('End', 'End', 35);
    await cdp.key('Home', 'Home', 36);
    assertEquals(await cdp.eval<Json>(aib), aibBefore, 'End and Home: the chat did not jump');
    const lines0 = await cdp.eval<string>(`__fe.text('beside', 'src/keys.ts')`);
    await cdp.key('ArrowDown', 'ArrowDown', 40, 1);
    const moved = await cdp.eval<string>(`__fe.text('beside', 'src/keys.ts')`);
    assert(moved !== lines0 && moved.split('\n')[1] === lines0.split('\n')[0], 'Alt+Down moved the line in the editor');
    await cdp.key('ArrowUp', 'ArrowUp', 38, 1);
    assertEquals(await cdp.eval<string>(`__fe.text('beside', 'src/keys.ts')`), lines0, 'Alt+Up moved it back');
    await cdp.key('n', 'KeyN', 78, 1);
    assertEquals(await cdp.eval<Json>(aib), aibBefore, 'Alt+Up/Down and Alt+N: no chat switch, no new chat');
    assert(await cdp.eval<boolean>(`__fe.inEditor('beside', 'src/keys.ts')`), 'the caret stayed in the editor');
    await cdp.key('k', 'KeyK', 75, 2);
    await wait(`!!document.querySelector('dialog[open]')`, 'Ctrl+K opens the switcher (files and chats)', 5);
    await cdp.key('Escape', 'Escape', 27);
    await wait(`!document.querySelector('dialog[open]')`, 'Esc closes it', 5);
    await wait(`__fe.inEditor('beside', 'src/keys.ts')`, 'focus is back in the editor after Ctrl+K / Esc', 5);
    await cdp.key('p', 'KeyP', 80, 2);
    await wait(`document.getElementById('wsProjectBtn').getAttribute('aria-expanded') === 'true' || !!document.querySelector('dialog[open], [role="dialog"]:not([hidden])')`, 'Ctrl+P is still Switch project', 5);
    await cdp.key('Escape', 'Escape', 27);
    await sleep(300);
    const after1 = await cdp.eval<Json>(aib);
    assertEquals([after1.besideW, after1.act], [aibBefore.besideW, aibBefore.act], 'the beside pane and the right column kept their width');

    // ---- closing a dirty tab asks by the tab; Cancel keeps the text; Don't save leaves the disk ------------------------------------
    const keysDisk = diskText('src/keys.ts');
    await cdp.eval(`document.querySelector('#fileBeside .sf-ftab .ws-tab-x').click(), true`);
    await wait(`!!document.querySelector('.sf-close-pop')`, 'the Save / Don\'t save / Cancel popover by the tab', 5);
    assert(!(await cdp.eval<boolean>(`!!document.querySelector('dialog[open]')`)), 'not a modal dialog');
    await cdp.eval(`[...document.querySelectorAll('.sf-close-pop button')].find((b) => b.textContent === 'Cancel').click(), true`);
    await wait(`!document.querySelector('.sf-close-pop') && __fe.ready('beside', 'src/keys.ts')`, 'Cancel keeps the tab');
    assert((await cdp.eval<string>(`__fe.text('beside', 'src/keys.ts')`)).includes('~'), 'Cancel kept the text');
    await cdp.eval(`document.querySelector('#fileBeside .sf-ftab .ws-tab-x').click(), true`);
    await wait(`!!document.querySelector('.sf-close-pop')`, 'the popover again', 5);
    await cdp.eval(`[...document.querySelectorAll('.sf-close-pop button')].find((b) => b.textContent === "Don't save").click(), true`);
    await wait(`!__fe.pane('beside', 'src/keys.ts')`, 'Don\'t save closed the tab');
    assertEquals(diskText('src/keys.ts'), keysDisk, 'Don\'t save wrote nothing');

    // ---- must-fix 6 (page side): no file socket without the page token -------------------------------------------------------------
    const socketRefused = await cdp.eval<boolean>(`new Promise((res) => {
      const ws = new WebSocket('ws://' + location.host + '/api/live/files/socket?file=x', ['aib-file']);
      ws.onopen = () => res(false); ws.onerror = () => res(true); ws.onclose = () => res(true);
    })`);
    assert(socketRefused, 'the file socket refuses a caller without the page token');

    // ---- must-fix 5: unsaved text survives a reload, and a restart of AIB that never asks ---------------------------------------------
    await cdp.eval(`__fe.open('notes.txt')`);
    await wait(`__fe.ready('main', 'notes.txt')`, 'notes again');
    await cdp.eval(`__fe.caret('main', 'notes.txt', 'end')`);
    await cdp.type('unsaved line\n');
    await sleep(600);
    await cdp.eval(`(window.__old = 1, location.reload(), true)`);
    cdp.close();
    ({ cdp } = await (async () => {
      const c = await until(async () => {
        try {
          const x = await Cdp.open(app, port);
          if (await x.eval<boolean>(`!window.__old && !!(window.AgentFileEditor && window.AgentFilesUI && window.AgentWorkspaceUI && AgentWorkspaceUI.paletteProjects().length >= 1)`)) return x;
          x.close();
        } catch { /* not yet */ }
        return null;
      }, 'the page after the reload', 60);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
      await c.eval(HELPERS);
      return { cdp: c };
    })());
    await cdp.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
    await wait(`!!AgentFilesUI.currentScope()`, 'the scope after the reload', 30);
    await cdp.eval(`__fe.open('notes.txt')`);
    await wait(`(__fe.text('main', 'notes.txt') || '').includes('unsaved line')`, 'the unsaved text after the reload', 30);
    assertEquals(diskText('notes.txt'), 'first\nsecond\nmine\n', 'still not on disk');
    await sleep(1500); // the server keeps it ~1 s after the last change
    cdp.close();
    await killUnder(`${fx.root}\\install`); // AIB ends without asking anything
    await sleep(1500);
    // the killed AIB's port files would point the relaunch at its old ports
    try {
      Deno.removeSync(`${fx.state}\\aib-owner.json`);
    } catch { /* gone */ }
    const stale = (dir: string, depth: number): void => {
      if (depth < 0) return;
      try {
        for (const e of Deno.readDirSync(dir)) {
          const p = `${dir}\\${e.name}`;
          if (e.isFile && e.name === 'DevToolsActivePort') Deno.removeSync(p);
          else if (e.isDirectory) stale(p, depth - 1);
        }
      } catch { /* unreadable */ }
    };
    stale(app, 6);
    stale(env.LOCALAPPDATA, 6);
    ({ cdp, port } = await launch());
    await cdp.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
    await wait(`!!AgentFilesUI.currentScope()`, 'the scope after the restart', 30);
    await cdp.eval(`__fe.open('notes.txt')`);
    await wait(`(__fe.text('main', 'notes.txt') || '').includes('unsaved line')`, 'the unsaved text after AIB restarted', 30);
    await wait(`__fe.foot('main').includes('Restored unsaved edits')`, 'the footer says it was restored', 10);
    assertEquals(diskText('notes.txt'), 'first\nsecond\nmine\n', 'quitting never saved it');

    const csp = await cdp.eval<string[]>(`window.__csp || []`);
    assertEquals(csp, [], 'no CSP violation');
  } finally {
    cdp.close();
  }
}

function document_messages(): string {
  return `document.getElementById('messages')`;
}
