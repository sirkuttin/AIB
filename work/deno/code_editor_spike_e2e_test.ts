/**
 * Real binary (slow: one `deno desktop` build, shared through _build_cache.ts; AIB_SLOW_TESTS=1, Windows only): the file editor's P0
 * spike (private/designs/file-editor, file-editor-design-v2.md) in the real AIB window (WebView2), on an invisible desktop
 * (_hidden_desktop.ts): no window ever shows on the person's screen. Its own data folders; never the owner's ports or ~/.claude.
 *
 *   1. A window with no file tab has not loaded the editor (vendor/code/editor.js is not fetched with the page).
 *   2. A 1 MB TypeScript file opens in a file tab (today's read-only view), then CodeMirror is loaded on demand and mounted in that
 *      tab (AgentFilesUI._editorSpike), in a shadow root. Under the page's real CSP (style-src 'self', no 'unsafe-inline'): no CSP violation, and
 *      CodeMirror's own styles apply (a constructed stylesheet on the shadow root; in the document style-mod's <style> tag is blocked).
 *   3. The theme comes from AIB's CSS variables: the editor's background and a keyword's colour equal --code-bg and --syn-keyword,
 *      and follow a theme switch (high contrast light) with no editor code.
 *   4. Keys, sent as real key presses (CDP Input.dispatchKeyEvent): Ctrl+F opens the search panel, Ctrl+D adds the next match,
 *      Ctrl+/ comments the line. Each is handled by the editor (default prevented) and AIB does nothing with it (same project,
 *      same mode, no menu or dialog, focus stays in the editor).
 * Prints the numbers (bundle size, load and mount times on the 1 MB file). Only processes this test started are killed.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, until } from './_host_fixture.ts';
import { HiddenDesktop } from './_hidden_desktop.ts';
import { builtDist } from './_build_cache.ts';
import { devToolsPortNow, ownerPort, pickPort, refusedPort } from './_ports.ts';
import { APP_ROOT, APP_VERSION } from '../../outputs/agent-studio/server/core/app.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';

const SLOW = Deno.build.os === 'windows' && Deno.env.get('AIB_SLOW_TESTS') === '1';
type Json = Record<string, unknown>;

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

/** One CDP session on the main window's page (w=m): evaluate, and send real key presses. */
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
    if (res?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(res.exceptionDetails).slice(0, 600)}`);
    return (res?.result as Json)?.value as T;
  }
  /** A real key press: modifiers 2 = Ctrl. */
  async key(key: string, code: string, vk: number, modifiers: number): Promise<void> {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  close(): void {
    this.#ws.close();
  }
}

/** ~1 MB of TypeScript (under the file view's 1 MiB read limit). */
function bigTs(): string {
  const block = (i: number) =>
    `export function compute${i}(value: number, label: string): string {\n` +
    `  const doubled = value * 2; // keep the old rounding\n` +
    `  if (doubled > ${i}) return \`\${label}: \${doubled}\`;\n` +
    `  return label + ' small';\n}\n\n`;
  let out = '';
  for (let i = 0; out.length < 1_000_000; i++) out += block(i);
  return out.slice(0, out.lastIndexOf('\n\n') + 2);
}

Deno.test({
  name: 'real binary: CodeMirror loads on demand in a file tab under the page CSP, themed from AIB variables, keys do not clash',
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
  Deno.mkdirSync(alpha, { recursive: true });
  const big = bigTs();
  Deno.writeTextFileSync(`${alpha}\\big.ts`, big);
  const added = { [projectKey(alpha)]: { path: alpha, at: 1 } };
  const stamp = new Date(Date.now() - 60_000).toISOString();
  Deno.mkdirSync(`${fx.root}\\claude\\enc`, { recursive: true });
  Deno.writeTextFileSync(
    `${fx.root}\\claude\\enc\\s-alpha.jsonl`,
    [
      { type: 'user', sessionId: 's-alpha', cwd: alpha, timestamp: stamp, message: { role: 'user', content: 'Edit the compute helpers' } },
      { type: 'assistant', sessionId: 's-alpha', cwd: alpha, timestamp: stamp, message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Done.' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  Deno.writeTextFileSync(`${fx.state}\\studio-added-projects.json`, JSON.stringify({ version: 1, savedAt: 1, start: 'fresh', added }));
  const home = `${fx.root}\\home`;
  const env: Record<string, string> = {
    AGENT_STUDIO_STATE_DIR: fx.state,
    APPDATA: `${fx.root}\\appdata`,
    LOCALAPPDATA: `${fx.root}\\localappdata`,
    CODEX_HOME: `${home}\\.codex`,
    AIB_UPDATE_API_BASE: `http://127.0.0.1:${refusedPort()}`,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
  };
  for (const d of [env.APPDATA, env.LOCALAPPDATA, home]) Deno.mkdirSync(d, { recursive: true });
  let port = pickPort(true);
  Deno.writeTextFileSync(`${fx.state}\\desktop-port.json`, JSON.stringify({ port }));
  const flags = ['--state-dir', fx.state, '--omp-sessions', `${fx.root}\\omp`, '--claude-projects', `${fx.root}\\claude`, '--owners-dir', fx.owners];
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
      if (await c.eval<boolean>(`!!(window.StudioChat && window.AgentWorkspaceUI && window.AgentFilesUI && AgentWorkspaceUI.paletteProjects().length >= 1)`)) return c;
      lastErr = 'page up, AIB not ready: ' + await c.eval<string>(`location.href + ' ' + typeof window.StudioChat + typeof window.AgentWorkspaceUI + typeof window.AgentFilesUI + ' ' + (window.AgentWorkspaceUI && AgentWorkspaceUI.paletteProjects ? JSON.stringify(AgentWorkspaceUI.paletteProjects()) : '')`);
      c.close();
    } catch (e) {
      lastErr = String(e);
    }
    return null;
  }, 'the main page', 120).catch((e) => {
    const ls = (d: string) => { try { return [...Deno.readDirSync(d)].map((x) => x.name).join(','); } catch (err) { return String(err); } };
    throw new Error(`${e.message}: ${lastErr}; app/AIB: ${ls(`${app}\AIB`)}; state: ${ls(fx.state)}`);
  });
  try {
    const pk = await cdp.eval<string>(`AgentWorkspaceUI.paletteProjects().find((p) => p.name === 'Alpha').key`);
    await cdp.eval(`AgentWorkspaceUI.selectProject(${JSON.stringify(pk)})`);
    await until(() => cdp.eval<boolean>(`!!AgentFilesUI.currentScope()`), 'a Files scope for Alpha', 30);

    // ---- 1. nothing loaded with the page -------------------------------------------------------------------------------------
    const before = await cdp.eval<Json>(`({
      loaded: !!window.AIBCodeEditor,
      fetched: performance.getEntriesByType('resource').some((e) => e.name.includes('/vendor/code/')),
      csp: (document.querySelector('meta[http-equiv]') || {}).content || '',
    })`);
    assertEquals([before.loaded, before.fetched], [false, false], 'the editor is not loaded with the page');
    // record CSP violations from here on (the page's CSP is the response header, security.ts securityHeaders)
    await cdp.eval(`(window.__csp = [], document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || ''))), true)`);

    // ---- 2. the 1 MB file in a file tab, today's view, then the editor -------------------------------------------------------
    const viewMs = await cdp.eval<number>(`(async () => {
      const t0 = performance.now();
      // a helper's copy (read-only): the old read-only view, which the spike mounts its editor over (a project file opens the real
      // editor now: file_editor_e2e_test.ts)
      AgentFilesUI.openFile(Object.assign({}, AgentFilesUI.currentScope(), { root: 'chat', branch: 'aib/spike', label: 'Copy' }), 'big.ts', { keep: true });
      for (let i = 0; i < 600 && !document.querySelector('#fileView .fx-code'); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    })()`);
    assert(await cdp.eval<boolean>(`!!document.querySelector('#fileView .fx-code')`), "today's read-only view shows the file");
    const t = await cdp.eval<Json>(`AgentFilesUI._editorSpike('main').then((r) => (window.__ed = r.editor, { load: r.load, mount: r.mount, total: r.total }))`);
    const second = await cdp.eval<Json>(`(async () => {
      const sr = document.querySelector('#fileView .sf-code-host').shadowRoot;
      window.__ed.destroy();
      const t0 = performance.now();
      const CE = await AgentFilesUI.loadCodeEditor();
      window.__ed = CE.create({ parent: sr, root: sr, text: window.__ed.view.state.doc.toString(), name: 'big.ts', live: true });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { mount: performance.now() - t0 };
    })()`);
    const res = await cdp.eval<Json>(`(() => {
      const e = performance.getEntriesByType('resource').find((x) => x.name.includes('/vendor/code/editor.js'));
      return e ? { transfer: e.transferSize, decoded: e.decodedBodySize, fetchMs: e.duration } : null;
    })()`);
    const shape = await cdp.eval<Json>(`(() => {
      const sr = document.querySelector('#fileView .sf-code-host').shadowRoot, ed = sr && sr.querySelector('.cm-editor');
      if (!ed) return null;
      const cs = getComputedStyle(ed), sc = getComputedStyle(ed.querySelector('.cm-scroller'));
      return {
        display: cs.display, position: cs.position, scrollerOverflow: sc.overflowY, scrollerFont: sc.fontFamily,
        height: Math.round(ed.getBoundingClientRect().height), lines: window.__ed.view.state.doc.lines,
        domLines: ed.querySelectorAll('.cm-line').length, adopted: sr.adoptedStyleSheets.length,
        styleTags: document.querySelectorAll('head style').length,
      };
    })()`);
    assert(shape, 'the editor is in the file tab');
    assertEquals(shape.display, 'flex', "CodeMirror's base styles apply (.cm-editor is a flex box)");
    assertEquals(shape.scrollerOverflow, 'auto', "CodeMirror's scroller styles apply");
    assert(String(shape.scrollerFont).includes('Consolas'), `AIB's code font: ${shape.scrollerFont}`);
    assert((shape.adopted as number) >= 1, 'styles went in through a constructed stylesheet on the shadow root');
    assert((shape.domLines as number) < 400, `only the visible part is in the DOM (${shape.domLines} of ${shape.lines} lines)`);
    assert((shape.height as number) > 200, `the editor fills the tab (${shape.height} px)`);

    // ---- 3. theme from AIB's variables, following a theme switch --------------------------------------------------------------
    const colours = `(() => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const resolve = (v, prop) => { probe.style.color = ''; probe.style.backgroundColor = ''; probe.style[prop] = 'var(' + v + ')'; return getComputedStyle(probe)[prop]; };
      const want = { bg: resolve('--code-bg', 'backgroundColor'), kw: resolve('--syn-keyword', 'color'), cm: resolve('--syn-comment', 'color') };
      probe.remove();
      const ed = document.querySelector('#fileView .sf-code-host').shadowRoot.querySelector('.cm-editor');
      const spans = [...ed.querySelectorAll('.cm-line span')];
      const kw = spans.find((s) => s.textContent === 'function'), cm = spans.find((s) => s.textContent.startsWith('// keep'));
      return { want, got: { bg: getComputedStyle(ed).backgroundColor, kw: kw && getComputedStyle(kw).color, cm: cm && getComputedStyle(cm).color } };
    })()`;
    const dark = await cdp.eval<{ want: Json; got: Json }>(colours);
    assertEquals(dark.got, dark.want, 'the editor uses --code-bg, --syn-keyword and --syn-comment');
    const theme = await cdp.eval<string>(`document.documentElement.getAttribute('data-theme')`);
    await cdp.eval(`document.documentElement.setAttribute('data-theme', 'hc-light')`);
    const light = await cdp.eval<{ want: Json; got: Json }>(colours);
    assertEquals(light.got, light.want, 'after a theme switch the editor follows the variables');
    assert(light.got.bg !== dark.got.bg, 'the switch changed the background');
    await cdp.eval(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme || 'teal')})`);

    // ---- 4. keys ------------------------------------------------------------------------------------------------------------------
    await cdp.eval(`(window.__keys = [], window.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, prevented: e.defaultPrevented }), false), true)`);
    const aib = `({ mode: AgentFilesUI.mode(), project: AgentWorkspaceUI.currentProjectKey ? AgentWorkspaceUI.currentProjectKey() : '',
      dialog: !!document.querySelector('dialog[open]'), menu: !!document.querySelector('.fx-menu'),
      inEditor: !!document.querySelector('#fileView .sf-code-host').shadowRoot.activeElement && !!document.querySelector('#fileView .sf-code-host').shadowRoot.activeElement.closest('.cm-editor') })`;
    // caret on line 1, inside "value"
    await cdp.eval(`(() => { const v = window.__ed.view, at = v.state.doc.line(1).text.indexOf('value') + 2; v.dispatch({ selection: { anchor: at } }); v.focus(); return true; })()`);
    const aibBefore = await cdp.eval<Json>(aib);
    assert(aibBefore.inEditor, 'focus is in the editor');

    await cdp.key('f', 'KeyF', 70, 2);
    await until(() => cdp.eval<boolean>(`!!document.querySelector('#fileView .sf-code-host').shadowRoot.querySelector('.cm-search')`), 'Ctrl+F opened the search panel', 5);
    assert(await cdp.eval<boolean>(`!!document.querySelector('#fileView .sf-code-host').shadowRoot.activeElement && document.querySelector('#fileView .sf-code-host').shadowRoot.activeElement.matches('.cm-search input[name=search]')`), 'Ctrl+F focuses the search field');
    await cdp.key('Escape', 'Escape', 27, 0);
    await until(() => cdp.eval<boolean>(`!document.querySelector('#fileView .sf-code-host').shadowRoot.querySelector('.cm-search')`), 'Esc closed the search panel', 5);
    assertEquals(await cdp.eval<Json>(aib), aibBefore, 'Ctrl+F and Esc: AIB did nothing, focus is back in the editor');

    await cdp.key('d', 'KeyD', 68, 2); // selects the word "value"
    await cdp.key('d', 'KeyD', 68, 2); // adds the next "value"
    const sel = await cdp.eval<Json>(`(() => { const s = window.__ed.view.state; return { n: s.selection.ranges.length, words: s.selection.ranges.map((r) => s.sliceDoc(r.from, r.to)) }; })()`);
    assertEquals(sel, { n: 2, words: ['value', 'value'] }, 'Ctrl+D twice: two selections on "value"');
    assertEquals(await cdp.eval<Json>(aib), aibBefore, 'Ctrl+D: AIB did nothing');

    await cdp.eval(`(() => { const v = window.__ed.view; v.dispatch({ selection: { anchor: 0 } }); return true; })()`);
    await cdp.key('/', 'Slash', 191, 2);
    const line1 = await cdp.eval<string>(`window.__ed.view.state.doc.line(1).text`);
    assert(line1.startsWith('// export function compute0'), `Ctrl+/ commented line 1: ${line1}`);
    assertEquals(await cdp.eval<Json>(aib), aibBefore, 'Ctrl+/: AIB did nothing');

    const keys = await cdp.eval<Json[]>(`window.__keys.filter((k) => k.key !== 'Control')`);
    assertEquals(keys.map((k) => [k.key, k.prevented]), [['f', true], ['Escape', true], ['d', true], ['d', true], ['/', true]], 'the editor handled every key');

    // ---- 5. live file (docs model): a disk change merges in as the FILE origin; the user's edit stays; Ctrl+Z is the user's only
    const disk = big.replace('if (doubled > 0)', 'if (doubled >= 0)');
    const merged = await cdp.eval<Json>(`(() => {
      const ed = window.__ed, t0 = performance.now();
      // base = the disk text the editor opened (the live text without the user's "// "); theirs = that with lines 1 and 3 changed
      const base = ed.live.ytext.toString().slice(3);
      const r = ed.live.applyDisk(base, base.replace('if (doubled > 0)', 'if (doubled >= 0)').replace('compute0(', 'computeZero('));
      const s = ed.view.state;
      return { ms: performance.now() - t0, applied: r.applied.length, overlaps: r.overlaps.length, line1: s.doc.line(1).text, line3: s.doc.line(3).text, sameAsYText: s.doc.toString() === ed.live.ytext.toString() };
    })()`);
    assert(disk !== big, 'the fixture has the line the disk change edits');
    assertEquals([merged.applied, merged.overlaps], [1, 1], 'line 3 merges in; the change to line 1 (which the user edited) is an overlap, not applied');
    assert(String(merged.line1).startsWith('// export function compute0('), `the user's unsaved edit (line 1) stays: ${merged.line1}`);
    assert(String(merged.line3).includes('doubled >= 0'), `the disk change (line 3) merged in: ${merged.line3}`);
    assert(merged.sameAsYText, 'the editor shows the live text');
    await cdp.key('z', 'KeyZ', 90, 2);
    const undone = await cdp.eval<Json>(`(() => { const d = window.__ed.view.state.doc; return { line1: d.line(1).text, line3: d.line(3).text }; })()`);
    assert(String(undone.line1).startsWith('export function compute0'), `Ctrl+Z took back the user's own edit: ${undone.line1}`);
    assert(String(undone.line3).includes('doubled >= 0'), `Ctrl+Z did not take back the disk change: ${undone.line3}`);
    assertEquals(await cdp.eval<Json>(aib), aibBefore, 'Ctrl+Z: AIB did nothing');
    const csp = await cdp.eval<string[]>(`window.__csp`);
    assertEquals(csp, [], 'no CSP violation while loading, mounting, theming and typing');
    // The control: the same editor mounted straight in the document (no shadow root) gets its styles blocked by the CSP.
    const inDoc = await cdp.eval<Json>(`(async () => {
      const div = document.createElement('div');
      div.hidden = true;
      document.body.append(div);
      const ed = (await AgentFilesUI.loadCodeEditor()).create({ parent: div, text: 'x' });
      await new Promise((r) => setTimeout(r, 300));
      const display = getComputedStyle(div.querySelector('.cm-editor')).display;
      ed.destroy();
      div.remove();
      return { violations: window.__csp.slice(), display };
    })()`);
    assert((inDoc.violations as string[]).some((v) => v.startsWith('style-src')), `in the document, style-mod's <style> tag is blocked: ${JSON.stringify(inDoc)}`);

    const size = Deno.statSync(`${APP_ROOT}\\vendor\\code\\editor.js`).size;
    console.log('CODE EDITOR SPIKE', JSON.stringify({
      bundleBytes: size, served: res, fileBytes: big.length, fileLines: shape.lines, readOnlyViewMs: Math.round(viewMs),
      firstOpen: { loadMs: Math.round(t.load as number), mountMs: Math.round(t.mount as number), totalMs: Math.round(t.total as number) },
      secondMountMs: Math.round(second.mount as number), diskMergeMs: Math.round((merged.ms as number) * 10) / 10, domLines: shape.domLines, adoptedSheets: shape.adopted, inDocumentViolations: inDoc.violations, headStyleTags: shape.styleTags,
    }));
  } finally {
    cdp.close();
  }
}
