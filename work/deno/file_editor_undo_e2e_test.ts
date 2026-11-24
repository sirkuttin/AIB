/**
 * Real binary (slow: one `deno desktop` build, shared through _build_cache.ts; AIB_SLOW_TESTS=1, Windows only): the file editor's undo
 * history outlives the tab (owner 2026-11-17: "if a user edits a file and closes the file tab but then reopens it, I want the
 * undo/redo history to persist across the closing of a file"). In the real AIB window (WebView2) on an invisible desktop
 * (_hidden_desktop.ts); its own data folders, never the owner's ports, ~/.claude or ~/.codex. Keys are real key presses (CDP
 * Input.dispatchKeyEvent): Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z.
 *   1  edits, a save, an agent's change merged between edits, more edits; close the tab (Save in the popover); open it again: Ctrl+Z
 *      steps back through every edit in order and never takes the agent's line; Ctrl+Y / Ctrl+Shift+Z redo
 *   2  a reload of the page keeps the history
 *   3  "Don't save" drops the typing, and Ctrl+Z after opening the file again brings it back
 *   4  a restart of AIB keeps the history
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { builtDist } from './_build_cache.ts';
import { devToolsPortNow, ownerPort, pickPort, refusedPort } from './_ports.ts';
import { APP_VERSION } from '../../app/server/core/app.ts';
import { projectKey } from '../../app/server/desktop/project_delete.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
type Json = Record<string, unknown>;
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
    const lower = ch >= 'a' && ch <= 'z', digit = ch >= '0' && ch <= '9';
    const vk = lower ? c - 32 : digit || ch === ' ' ? c : 0;
    const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
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

const HELPERS = `(() => {
  const FE = () => window.AgentFileEditor;
  window.__fe = {
    pane(where, path) {
      for (const [k, p] of FE()._panes) if (k.startsWith(where + '|') && p.tab && p.tab.path === path) return p;
      return null;
    },
    ready(where, path) { const p = this.pane(where, path); return !!(p && p.ed && FE()._states.get(p.tab.id) && FE()._states.get(p.tab.id).client.synced); },
    text(where, path) { const p = this.pane(where, path); return p && p.ed ? p.ed.view.state.doc.toString() : null; },
    caret(where, path, at) {
      const p = this.pane(where, path), v = p.ed.view;
      const pos = at === 'end' ? v.state.doc.length : at;
      v.dispatch({ selection: { anchor: pos } });
      v.focus();
      return document.activeElement === p.host;
    },
    head(where, path) { const p = this.pane(where, path); return p.ed.view.state.selection.main.head; },
    closeTab(path) {
      const t = [...document.querySelectorAll('.sf-ftab')].find((x) => !x.closest('#fileBeside') && x.querySelector('.ws-tab-main').title.split('\\n')[0].endsWith(path));
      if (!t) return false;
      t.querySelector('.ws-tab-x').click();
      return true;
    },
    popover(label) {
      const b = [...document.querySelectorAll('.sf-close-pop button')].find((x) => x.textContent === label);
      if (!b) return false;
      b.click();
      return true;
    },
    open(path) { AgentFilesUI.openFile(AgentFilesUI.currentScope(), path, { keep: true }); return true; },
  };
  return true;
})()`;

Deno.test({
  name: 'real binary: the file editor\'s undo history survives closing the tab, a reload, Don\'t save and a restart',
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
  const notes = `${alpha}\\notes.txt`;
  Deno.mkdirSync(alpha, { recursive: true });
  Deno.writeTextFileSync(notes, 'first\nsecond\n');
  const added = { [projectKey(alpha)]: { path: alpha, at: 1 } };
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
  for (const d of [env.APPDATA, env.LOCALAPPDATA, home, `${fx.root}\\claude`]) Deno.mkdirSync(d, { recursive: true });
  const flags = ['--state-dir', fx.state, '--omp-sessions', `${fx.root}\\omp`, '--claude-projects', `${fx.root}\\claude`, '--owners-dir', fx.owners];
  const page = async (port: number, what: string, fresh = ''): Promise<Cdp> => {
    let lastErr = '';
    const cdp = await until(async () => {
      try {
        const c = await Cdp.open(app, port);
        if (await c.eval<boolean>(`${fresh || 'true'} && !!(window.StudioChat && window.AgentWorkspaceUI && window.AgentFilesUI && window.AgentFileEditor && AgentWorkspaceUI.paletteProjects().length >= 1)`)) return c;
        lastErr = 'page up, AIB not ready';
        c.close();
      } catch (e) {
        lastErr = String(e);
      }
      return null;
    }, what, 120).catch((e) => {
      throw new Error(`${e.message}: ${lastErr}`);
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(HELPERS);
    return cdp;
  };
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
    return { cdp: await page(port, 'the main page'), port };
  };
  let { cdp, port } = await launch();
  const wait = (expr: string, what: string, s = 20) =>
    until(() => cdp.eval<boolean>(expr), what, s).catch(async (e) => {
      throw new Error(`${e.message}\nTEXT ${JSON.stringify(await cdp.eval<string>(`__fe.text('main', 'notes.txt')`).catch(() => ''))}`);
    });
  const diskText = () => Deno.readTextFileSync(notes);
  const text = () => cdp.eval<string>(`__fe.text('main', 'notes.txt')`);
  const isText = (want: string, what: string) => wait(`__fe.text('main', 'notes.txt') === ${JSON.stringify(want)}`, what, 10);
  const undo = () => cdp.key('z', 'KeyZ', 90, 2);
  const redo = () => cdp.key('y', 'KeyY', 89, 2);
  const redoShift = () => cdp.key('Z', 'KeyZ', 90, 2 | 8); // with Shift held a keyboard reports key "Z"
  const save = () => cdp.key('s', 'KeyS', 83, 2);
  const pk = await cdp.eval<string>(`AgentWorkspaceUI.paletteProjects().find((p) => p.name === 'Alpha').key`);
  const openNotes = async (what: string) => {
    await cdp.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
    await wait(`!!AgentFilesUI.currentScope()`, 'a Files scope for Alpha', 30);
    await cdp.eval(`__fe.open('notes.txt')`);
    await wait(`__fe.ready('main', 'notes.txt')`, what, 30);
    assert(await cdp.eval<boolean>(`__fe.caret('main', 'notes.txt', 'end')`), 'the caret is in the editor');
  };
  const A = 'agent\n', BASE = 'first\nsecond\n';
  try {
    // ---- 1: edits, a save, an agent's change between edits, more edits; close (Save); open again; Ctrl+Z back through all ----------
    await openNotes('the notes tab');
    await cdp.type('a1');
    await sleep(800); // a step of its own (the undo history groups typing within 500 ms)
    await cdp.type('b2');
    await sleep(800);
    await save();
    await until(() => diskText() === BASE + 'a1b2', 'saved', 15);
    Deno.writeTextFileSync(notes, A + BASE + 'a1b2'); // the agent's write
    await isText(A + BASE + 'a1b2', "the agent's line merged in");
    await cdp.eval(`__fe.caret('main', 'notes.txt', 'end')`);
    await cdp.type('c3');
    await sleep(800);
    assert(await cdp.eval<boolean>(`__fe.closeTab('notes.txt')`), 'the tab has a × button');
    await wait(`!!document.querySelector('.sf-close-pop')`, 'unsaved: Save / Don\'t save / Cancel by the tab', 5);
    assert(await cdp.eval<boolean>(`__fe.popover('Save')`));
    await wait(`!__fe.pane('main', 'notes.txt')`, 'the tab closed');
    assertEquals(diskText(), A + BASE + 'a1b2c3');
    await openNotes('the notes tab again');
    assertEquals(await text(), A + BASE + 'a1b2c3');
    await undo();
    await isText(A + BASE + 'a1b2', 'Ctrl+Z after reopening undoes the last edit (made before the close)');
    assertEquals(await cdp.eval<number>(`__fe.head('main', 'notes.txt')`), (A + BASE + 'a1b2').length, 'the caret is where the change was');
    await undo();
    await isText(A + BASE + 'a1', 'Ctrl+Z again: across the save');
    await undo();
    await isText(A + BASE, "every edit undone, the agent's line stays");
    await undo();
    await sleep(600);
    assertEquals(await text(), A + BASE, 'nothing more to undo: the agent\'s change is not the person\'s');
    await redo();
    await isText(A + BASE + 'a1', 'Ctrl+Y redoes');
    await redoShift();
    await isText(A + BASE + 'a1b2', 'Ctrl+Shift+Z redoes');
    await redo();
    await isText(A + BASE + 'a1b2c3', 'redo all the way');

    // ---- 2: a reload keeps it ------------------------------------------------------------------------------------------------------
    await cdp.eval(`(window.__old = 1, location.reload(), true)`);
    cdp.close();
    cdp = await page(port, 'the page after the reload', '!window.__old');
    await openNotes('the notes tab after the reload');
    await undo();
    await isText(A + BASE + 'a1b2', 'Ctrl+Z after a reload');
    await redo();
    await isText(A + BASE + 'a1b2c3', 'Ctrl+Y after a reload');

    // ---- 3: Don't save drops the typing; Ctrl+Z after opening again brings it back -------------------------------------------------
    await cdp.eval(`__fe.caret('main', 'notes.txt', 'end')`);
    await sleep(600);
    await cdp.type('zz');
    await sleep(800);
    assert(await cdp.eval<boolean>(`__fe.closeTab('notes.txt')`));
    await wait(`!!document.querySelector('.sf-close-pop')`, 'the popover', 5);
    assert(await cdp.eval<boolean>(`__fe.popover("Don't save")`));
    await wait(`!__fe.pane('main', 'notes.txt')`, "Don't save closed the tab");
    assertEquals(diskText(), A + BASE + 'a1b2c3', "Don't save wrote nothing");
    await openNotes('the notes tab after Don\'t save');
    assertEquals(await text(), A + BASE + 'a1b2c3', 'the dropped typing is gone');
    await undo();
    await isText(A + BASE + 'a1b2c3zz', "Ctrl+Z brings back what Don't save dropped");

    // ---- 4: a restart keeps it -----------------------------------------------------------------------------------------------------
    await sleep(1500); // the server keeps it ~1 s after the last change
    cdp.close();
    await killUnder(`${fx.root}\\install`);
    await sleep(1500);
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
    await openNotes('the notes tab after the restart');
    assertEquals(await text(), A + BASE + 'a1b2c3zz', 'the unsaved text after the restart');
    await undo();
    await isText(A + BASE + 'a1b2c3', 'Ctrl+Z after a restart');
    await undo();
    await isText(A + BASE + 'a1b2', 'and again, through edits made before the first close');
    await redo();
    await isText(A + BASE + 'a1b2c3', 'Ctrl+Y after a restart');
  } finally {
    cdp.close();
  }
}
