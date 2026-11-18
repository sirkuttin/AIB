/**
 * Remote file editing (owner decision 2026-11-16, "1a"; aib-shared/designs/file-editor/file-editor-design-v2.md, architect review v2
 * must-fix 6): a paired COMPUTER with Files edits project files with the PC's editor and rules, on the computer page (/pc.html),
 * against an in-process AIB with a fake agent host. No real Tailscale: this test plays Tailscale Serve, as the other computer page
 * tests do (DevTools Fetch interception for requests, and a small TCP relay with Serve's headers for the editor's WebSocket).
 *   - a computer with Files opens a project file, types, saves: the disk changes and remote-audit.jsonl has the device, path, result;
 *   - an agent's change to the same file merges in while the computer has unsaved lines (theirs merged, mine kept); the unsaved text
 *     is in the PC's store and is the live text the PC's own windows get (an edit there shows up on the computer);
 *   - the code editor bundle is served to the computer page and runs under its CSP (no violations, no page credential);
 *   - a computer without Files: the editor stays off (read-only + Download), its routes and socket are refused;
 *   - a phone token is refused on the socket and on the routes.
 * Headless Chrome / Edge only; nothing shows on the screen.
 */
import { assert, assertEquals } from './_assert.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { DEVICE_HEADER, DEVICE_PROTOCOL_PREFIX } from '../../outputs/agent-studio/server/remote/pc_bridge.ts';
import { Audit } from '../../outputs/agent-studio/server/remote/audit.ts';
import { COMPUTER_SCOPES } from '../../outputs/agent-studio/server/remote/devices.ts';
import {
  fakeTailscale,
  LOGIN,
  NAME,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
} from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

async function remoteOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', { on: true });
  assertEquals(status, 200);
  return s;
}

function call(s: RemoteStudio, token: string, method: string, path: string, body?: Json) {
  return raw(
    s.phonePort(),
    method,
    path,
    { ...phoneHeaders({}, method), [DEVICE_HEADER]: token },
    body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
  );
}

/** A WebSocket handshake to the phone port (refusals answer before any upgrade). */
function socket(s: RemoteStudio, path: string, protocols: string) {
  return raw(
    s.phonePort(),
    'GET',
    path,
    phoneHeaders({
      Origin: `https://${NAME}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Protocol': protocols,
      'Sec-Fetch-Mode': 'websocket',
    }),
  );
}

const indexOfHeadEnd = (b: Uint8Array) => {
  for (let i = 3; i < b.length; i++) if (b[i - 3] === 13 && b[i - 2] === 10 && b[i - 1] === 13 && b[i] === 10) return i + 1;
  return -1;
};

/**
 * Tailscale Serve for the page's WebSockets: the page's wss://<name>/... goes to ws://127.0.0.1:<relay>/... (see the page shim), and
 * the relay sends the upgrade on to the phone port with the headers Serve adds (exact Host, the Tailscale login, Origin same-origin).
 */
function wsRelay(phonePort: number) {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const conns = new Set<Deno.Conn>();
  const upgrades: string[] = [];
  const relay = async (client: Deno.Conn) => {
    let buf = new Uint8Array(0);
    const chunk = new Uint8Array(65536);
    let end = -1;
    while (end < 0) {
      const n = await client.read(chunk);
      if (n === null) return client.close();
      const next = new Uint8Array(buf.length + n);
      next.set(buf);
      next.set(chunk.subarray(0, n), buf.length);
      buf = next;
      end = indexOfHeadEnd(buf);
    }
    const lines = new TextDecoder().decode(buf.subarray(0, end)).split('\r\n').filter(Boolean);
    const drop = /^(host|origin|sec-fetch-site|tailscale-.*|x-forwarded-.*):/i;
    const head = [lines[0], ...lines.slice(1).filter((l) => !drop.test(l))];
    head.push(`Host: ${NAME}`, `Origin: https://${NAME}`, `Tailscale-User-Login: ${LOGIN}`, 'Tailscale-User-Name: Owner');
    head.push('X-Forwarded-For: 100.64.0.7', 'X-Forwarded-Proto: https', 'Sec-Fetch-Site: same-origin');
    upgrades.push(lines[0]);
    const upstream = await Deno.connect({ hostname: '127.0.0.1', port: phonePort });
    conns.add(upstream);
    await upstream.write(new TextEncoder().encode(head.join('\r\n') + '\r\n\r\n'));
    if (buf.length > end) await upstream.write(buf.subarray(end));
    await Promise.allSettled([client.readable.pipeTo(upstream.writable), upstream.readable.pipeTo(client.writable)]);
  };
  (async () => {
    for await (const c of listener) {
      conns.add(c);
      void relay(c).catch(() => {});
    }
  })().catch(() => {});
  return {
    port,
    upgrades,
    close() {
      try {
        listener.close();
      } catch { /* closed */ }
      for (const c of conns) {
        try {
          c.close();
        } catch { /* closed */ }
      }
    },
  };
}

/** The page's WebSocket to the relay (the computer page builds wss://<name>/...; a test browser cannot reach that name). */
const SOCKET_SHIM = (relayPort: number) => `(() => {
  if (location.host !== ${JSON.stringify(NAME)}) return;
  const W = window.WebSocket;
  function S(url, protocols) {
    const from = ${JSON.stringify(`wss://${NAME}/`)};
    const u = String(url).startsWith(from) ? 'ws://127.0.0.1:${relayPort}/' + String(url).slice(from.length) : String(url);
    window.__shimUrls.push(u);
    return protocols === undefined ? new W(u) : new W(u, protocols);
  }
  S.prototype = W.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) S[k] = W[k];
  window.WebSocket = S;
  window.__shimUrls = [];
})();`;

/** Serve for the page's requests (Fetch interception): Serve's headers in, the phone port's answer out. The only change to an
 * answer: the relay's address is added to the CSP's connect-src (the real page connects to its own origin, 'self'). */
async function serveAll(page: Page, s: RemoteStudio, relayPort: number, seen: { credential: string[]; refused: string[] }) {
  await page.send('Network.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `https://${NAME}/*`, requestStage: 'Request' }] });
  page.listeners.set('Fetch.requestPaused', (p) => {
    void (async () => {
      const request = p.request as Json;
      const url = new URL(request.url as string);
      const method = request.method as string;
      const kind = p.resourceType as string;
      const headers: Record<string, string> = { Host: NAME, 'Tailscale-User-Login': LOGIN, 'X-Forwarded-For': '100.64.0.7' };
      for (const [k, v] of Object.entries(request.headers as Record<string, string>)) {
        if (/^(host|cookie|connection|content-length|sec-fetch-.*)$/i.test(k)) continue;
        headers[k] = v;
        if (/^(x-studio-token|x-aib-page-key|x-aib-page-session|x-studio-artifact-key)$/i.test(k)) seen.credential.push(`${k} ${url.pathname}`);
      }
      if (method === 'POST' && !Object.keys(headers).some((k) => k.toLowerCase() === 'origin')) headers.Origin = `https://${NAME}`;
      if (kind === 'Document') Object.assign(headers, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
      else if (kind === 'Fetch' || kind === 'XHR') Object.assign(headers, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
      else Object.assign(headers, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': kind.toLowerCase() });
      let answer = null;
      try {
        answer = await raw(s.phonePort(), method, url.pathname + url.search, headers, request.postData as string | undefined);
      } catch { /* Serve answers 502 */ }
      if (!answer) {
        await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 502, responseHeaders: [], body: '' });
        return;
      }
      if (answer.status === 401 || answer.status === 403) seen.refused.push(`${answer.status} ${method} ${url.pathname} ${answer.text.slice(0, 160)}`);
      const responseHeaders: Json[] = [];
      answer.headers.forEach((value, name) => {
        if (/^(transfer-encoding|connection|content-length|keep-alive)$/i.test(name)) return;
        const v = /^content-security-policy$/i.test(name)
          ? value.replace("connect-src 'self'", `connect-src 'self' ws://127.0.0.1:${relayPort}`)
          : value;
        responseHeaders.push({ name, value: v });
      });
      let bin = '';
      for (let i = 0; i < answer.bytes.length; i += 0x8000) bin += String.fromCharCode(...answer.bytes.subarray(i, i + 0x8000));
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: answer.status, responseHeaders, body: btoa(bin) });
    })().catch(() => {});
  });
}

/** Put a paired device's key where the computer page reads it (IndexedDB 'aib-phone', what pairing leaves behind). */
async function storeDevice(page: Page, token: string, id: string) {
  await page.goto(`https://${NAME}/remote.css`); // a page of this origin that runs nothing
  await page.eval(`new Promise((resolve, reject) => {
    const req = indexedDB.open('aib-phone', 2);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('chats', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ token: ${JSON.stringify(token)}, device: { id: ${JSON.stringify(id)} } }, 'device');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  })`);
}

const HELPERS = `(() => {
  const FE = () => window.AgentFileEditor;
  window.__fe = {
    pane(path) {
      for (const [k, p] of FE()._panes) if (k.startsWith('main|') && p.tab && p.tab.path === path) return p;
      return null;
    },
    ready(path) { const p = this.pane(path); return !!(p && p.ed); },
    text(path) { const p = this.pane(path); return p && p.ed ? p.ed.view.state.doc.toString() : null; },
    caret(path, line, col) {
      const p = this.pane(path), v = p.ed.view;
      const ln = v.state.doc.line(line);
      v.dispatch({ selection: { anchor: col === 'end' ? ln.to : ln.from + col } });
      v.focus();
      return true;
    },
    box() { return document.getElementById('fileView'); },
    tools() { const b = this.box(); const t = b && b.querySelector('.sf-fv-tools'); return t ? t.textContent : ''; },
    foot() { const b = this.box(); const t = b && b.querySelector('.fx-pv-foot'); return t ? t.textContent : ''; },
    fileId(path) { for (const [, st] of FE()._states) if (st.tab && st.tab.path === path && st.info) return st.info.file; for (const [, st] of FE()._states) if (st.info && st.info.path === path) return st.info.file; return ''; },
  };
  return true;
})()`;

Deno.test({
  ...OPTS,
  name: 'computer page: a computer with Files edits a project file (save, audit, agent merge, shared live text); without Files read-only; phone refused',
  ignore: !browserPath,
  async fn() {
    const s = await remoteOn();
    const relay = wsRelay(s.phonePort());
    // the relay is on 127.0.0.1 while the page is https://<name>: Chrome's local network checks would block the socket (the real
    // page connects to its own origin through Serve, never to a local address)
    const browser = await Browser.launch(['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests']);
    try {
      s.chats.push({
        id: 'c1',
        provider: 'claude',
        sessionId: 's1',
        cwd: s.project,
        busy: false,
        closed: false,
        attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
        subagents: {},
        events: [{ seq: 1, kind: 'user', time: Date.now() / 1000 - 60, data: { text: 'Fix the menu' } }],
        permissions: [],
        elicitations: [],
      });
      Deno.mkdirSync(`${s.project}${sep}src`, { recursive: true });
      const file = `${s.project}${sep}src${sep}app.js`;
      Deno.writeTextFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n');
      const computer = await pairPhone(s, 'Linux PC (Chrome)', undefined, 'computer');
      const noFiles = await pairPhone(s, 'Old laptop', COMPUTER_SCOPES.filter((x) => x !== 'pc.files'), 'computer');
      const phone = await pairPhone(s, 'Pixel 9');

      // ---- a phone token: refused on the socket and on every editor route ----
      const P = (r: { status: number; json: Json }, what: string) => assertEquals([r.status, r.json.code], [403, 'not_computer'], what);
      P(await call(s, phone.token, 'POST', '/api/live/files/open', { root: 'project', project: s.project, path: 'src/app.js' }), 'phone open');
      P(await call(s, phone.token, 'POST', '/api/live/files/save', { file: 'x' }), 'phone save');
      P(await call(s, phone.token, 'POST', '/api/live/files/close', { file: 'x', view: 'v' }), 'phone close');
      P(await call(s, phone.token, 'GET', '/api/live/files/compare?file=x'), 'phone compare');
      P(await socket(s, '/api/live/files/socket?file=x&view=v', `aib-file, ${DEVICE_PROTOCOL_PREFIX}${phone.token}`), 'phone socket');
      // ---- a computer without Files: its routes and socket refused (the switch) ----
      const N = (r: { status: number; json: Json }, what: string) => assertEquals([r.status, r.json.code], [403, 'scope'], what);
      N(await call(s, noFiles.token, 'POST', '/api/live/files/open', { root: 'project', project: s.project, path: 'src/app.js' }), 'no Files: open');
      N(await call(s, noFiles.token, 'POST', '/api/live/files/save', { file: 'x' }), 'no Files: save');
      N(await socket(s, '/api/live/files/socket?file=x&view=v', `aib-file, ${DEVICE_PROTOCOL_PREFIX}${noFiles.token}`), 'no Files: socket');

      // ---- the computer page with Files ----
      const seen = { credential: [] as string[], refused: [] as string[] };
      const page = await browser.open('about:blank', 1400, 900);
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_SHIM(relay.port) });
      await serveAll(page, s, relay.port, seen);
      await storeDevice(page, computer.token, computer.id);
      await page.goto(`https://${NAME}/pc.html`);
      await page.waitFor('!!document.querySelector("#connections [data-key]")', 20000, 'the chat list');
      assertEquals(await page.eval('document.documentElement.dataset.remote'), 'pc');
      assert(await page.eval<boolean>(`document.documentElement.hasAttribute('data-can-files')`), 'Files is on for this computer');
      await page.eval(HELPERS);
      await page.eval(`document.querySelector('#connections [data-key]').click()`);
      await page.waitFor(`document.getElementById('messages').textContent.includes('Fix the menu')`, 10000, 'the chat opens');
      await page.click('.sf-mode-files');
      await page.waitFor('!!(window.AgentFilesUI && AgentFilesUI.currentScope())', 10000, 'a Files scope');
      const scopeRoot = await page.eval<string>('AgentFilesUI.currentScope().root');
      assert(scopeRoot === 'main' || scopeRoot === 'project', `the project folder: ${scopeRoot}`);
      assert(await page.eval<boolean>(`AgentFileEditor.handles({ id: 't', scope: AgentFilesUI.currentScope(), path: 'src/app.js' })`), 'the editor is on');
      await page.eval(`AgentFilesUI.openFile(AgentFilesUI.currentScope(), 'src/app.js', { keep: true })`);
      await page.waitFor(`__fe.ready('src/app.js')`, 20000, 'the editor in the app.js tab (vendor/code/editor.js served, the file socket open)')
        .catch(async (e) => {
          const diag = await page.eval<string>(`JSON.stringify({
            states: [...AgentFileEditor._states.values()].map((s) => ({ opening: s.opening, info: !!s.info, error: s.error, readOnly: s.readOnly, client: !!s.client, tab: s.tab && s.tab.path })),
            panes: [...AgentFileEditor._panes.keys()], tools: __fe.tools(), cm: !!window.AIBCodeEditor, ws: String(WebSocket).slice(0, 300),
            csp: window.__csp, shim: window.__shimUrls })`).catch((x) => String(x));
          throw new Error(`${(e as Error).message}\nDIAG ${diag}\nrefused ${JSON.stringify(seen.refused)}\nupgrades ${relay.upgrades}\nerrors ${page.errors.join(' | ')}\nlogs ${page.logs.slice(-8).join(' | ')}`);
        });
      assert(
        await page.eval<boolean>(`__fe.pane('src/app.js').shadow.querySelector('.cm-content').contentEditable === 'true'`),
        'editable at once',
      );
      assert(relay.upgrades.some((l) => l.startsWith('GET /api/live/files/socket?')), `the file socket went through Serve: ${relay.upgrades}`);
      const id = await page.eval<string>(`__fe.fileId('src/app.js')`);
      const lf = s.ctx.liveFiles!.get(id)!;
      assert(lf, 'the file is open on the PC');
      await page.waitFor(`__fe.text('src/app.js') === ${JSON.stringify(Deno.readTextFileSync(file))}`, 10000, 'the text synced');

      // type and save: the disk changes, the audit line names the device, the path and the result
      await page.eval(`__fe.caret('src/app.js', 1, 'end')`);
      await page.type(' // remote');
      await page.waitFor(`__fe.text('src/app.js').startsWith('const a = 1; // remote\\n')`, 5000, 'typed');
      await page.key('s', 2); // Ctrl+S
      for (let i = 0; i < 100 && !Deno.readTextFileSync(file).includes('// remote'); i++) await new Promise((r) => setTimeout(r, 100));
      assertEquals(Deno.readTextFileSync(file), 'const a = 1; // remote\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n', 'saved to disk');
      await page.waitFor(`/Saved/.test(__fe.foot())`, 5000, 'the footer says Saved');
      const saves = new Audit(s.state).tail().filter((e) => e.action === 'file saved' && e.device === computer.id);
      // the computer without Files: its refused save is a line too
      assert(new Audit(s.state).tail().some((e) => e.action === 'file saved' && e.device === noFiles.id && e.result === 'refused: scope'), 'the refused save');
      assertEquals(saves.length, 1, JSON.stringify(saves));
      assertEquals([saves[0].device, saves[0].name, saves[0].path, saves[0].result], [computer.id, 'Linux PC (Chrome)', lf.place.abs, 'saved']);
      await page.shot('pc-file-editor-saved');

      // unsaved lines on the computer, then an agent changes another line of the file: theirs merges in, mine stays
      await page.eval(`__fe.caret('src/app.js', 2, 'end')`);
      await page.type(' // mine, unsaved');
      await page.waitFor(`__fe.text('src/app.js').includes('const b = 2; // mine, unsaved')`, 5000, 'typed again');
      await new Promise((r) => setTimeout(r, 300));
      assert(lf.text.toString().includes('// mine, unsaved'), "the computer's text is the PC's live text");
      // the store: unsaved text from a computer is kept like the PC's (hot exit)
      for (let i = 0; i < 40 && !s.ctx.liveFiles!.stored(lf.place.root).length; i++) await new Promise((r) => setTimeout(r, 100));
      assertEquals(s.ctx.liveFiles!.stored(lf.place.root).length, 1, 'the unsaved text is in the store');
      Deno.writeTextFileSync(file, 'const a = 1; // remote\nconst b = 2;\nconst c = 3;\nconst d = 40; // agent\nconst e = 5;\n');
      await page.waitFor(`__fe.text('src/app.js').includes('const d = 40; // agent')`, 15000, "the agent's change merged in");
      const merged = await page.eval<string>(`__fe.text('src/app.js')`);
      assertEquals(merged, 'const a = 1; // remote\nconst b = 2; // mine, unsaved\nconst c = 3;\nconst d = 40; // agent\nconst e = 5;\n', 'theirs merged, mine kept');
      assertEquals(lf.text.toString(), merged, 'the same live text on the PC');
      assertEquals(lf.overlaps.length, 0, 'no overlap');
      // an edit in a PC window (it reaches the live text the same way): it shows on the computer
      lf.doc.transact(() => lf.text.insert(lf.text.toString().indexOf('const e'), '// from the PC\n'), 'pc-window-test');
      await page.waitFor(`__fe.text('src/app.js').includes('// from the PC\\nconst e = 5;')`, 5000, "the PC window's edit on the computer");
      // save the merge: the disk has all three
      await page.key('s', 2);
      for (let i = 0; i < 100 && !Deno.readTextFileSync(file).includes('mine, unsaved'); i++) await new Promise((r) => setTimeout(r, 100));
      assertEquals(
        Deno.readTextFileSync(file),
        'const a = 1; // remote\nconst b = 2; // mine, unsaved\nconst c = 3;\nconst d = 40; // agent\n// from the PC\nconst e = 5;\n',
      );
      assertEquals(new Audit(s.state).tail().filter((e) => e.action === 'file saved' && e.device === computer.id).map((e) => e.result), ['saved', 'saved']);
      await page.shot('pc-file-editor-merged');

      const errors = page.errors.filter((e) => !/Failed to load resource|fetching the script/.test(e));
      assertEquals(errors, [], 'no page errors');
      assertEquals(await page.violations(), [], 'no CSP violations (the editor in its shadow root)');
      assertEquals(seen.credential, [], 'no page credential on any request');
      assertEquals(seen.refused, [], 'nothing the page asked for was refused');

      // ---- a computer without Files: the editor stays off (read-only + Download) ----
      await storeDevice(page, noFiles.token, noFiles.id);
      await page.goto(`https://${NAME}/pc.html`);
      await page.waitFor('!!document.querySelector("#connections [data-key]")', 20000, 'the chat list (no Files)');
      assert(!(await page.eval<boolean>(`document.documentElement.hasAttribute('data-can-files')`)), 'Files is off');
      assertEquals(
        await page.eval(`String(AgentFileEditor.handles({ id: 't', scope: { root: 'main', id: 'c1' }, path: 'src/app.js' }))`),
        'false',
        'no editor without Files',
      );
    } finally {
      await browser.close().catch(() => {});
      relay.close();
      await s.close();
    }
  },
});
