/**
 * The doc page's end-to-end harness: a throwaway Studio web server in this process (its own state folder and project, a fake agent
 * host whose chats the test drives, a free port; never the live Studio's ports) and a headless Chrome or Edge (--headless=new, its
 * own temporary profile: no window on the screen) driven over the DevTools protocol. Each page records its console errors and every
 * Content Security Policy violation.
 */
import { assert } from './_assert.ts';
import { makeContext, type WebContext, WebServer } from '../../outputs/agent-studio/server/web/server.ts';
import { docsTool } from '../../outputs/agent-studio/server/web/docs_routes.ts';
import type { LiveBackend } from '../../outputs/agent-studio/server/host/backend.ts';
import type { UpdateService } from '../../outputs/agent-studio/server/desktop/updater.ts';
import type { Source } from '../../outputs/agent-studio/server/transcripts/monitor.ts';

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

const BROWSERS = [
  Deno.env.get('CHROME_PATH') ?? '',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
export const browserPath = BROWSERS.find((p) => {
  try {
    return !!p && Deno.statSync(p).isFile;
  } catch {
    return false;
  }
});

export async function temp(prefix: string): Promise<string> {
  return Deno.realPathSync(await Deno.makeTempDir({ prefix })).replace(
    /^\\\\\?\\/,
    '',
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Studio on a free port whose chats all work in one project; `chat()` sets what the agent host lists (the turn signal). */
export async function studio(root?: string, port = 0) {
  root ??= await temp('aib-docpage-');
  const project = `${root}${sep}project`;
  const state = `${root}${sep}state-${Math.random().toString(36).slice(2, 7)}`;
  await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  await Deno.mkdir(state, { recursive: true });
  const connections: Json[] = [];
  const queued: Json[] = [];
  const host = {
    hostMode: 'test',
    liveInfo: () => Promise.resolve({ connections, instanceId: 'test' }),
    liveList: () => Promise.resolve({ connections }),
    liveState: () => Promise.resolve({}),
    liveWrites: () => Promise.resolve({}),
    liveCall: (op: string, body: Json) => {
      queued.push({ op, ...body });
      return Promise.resolve([200, { ok: true, queued: true }]);
    },
    emitArtifact: () => Promise.resolve(true),
  } as unknown as LiveBackend;
  const ctx: WebContext = makeContext({
    stateDir: state,
    host,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts: {
      sessionCwd: () => Promise.resolve(project),
    } as unknown as Source,
    claudeProjects: state,
    ompSessions: state,
    shutdown: () => {},
  });
  const web = new WebServer(ctx);
  const bound = await web.listen(port);
  const tool = async (
    chat: string,
    name: string,
    args: Json,
  ): Promise<[boolean, Json]> => {
    const [, reply] = await docsTool(ctx, {
      conversationId: chat,
      tool: name,
      args,
    });
    const r = reply as { ok: boolean; result: Json };
    return [r.ok, r.result];
  };
  /** A chat whose turn is running (busy) or ended at `endedAt`. */
  const chat = (
    id: string,
    provider: string,
    session: string,
    endedAt: string | null,
    busy = false,
  ) => {
    const i = connections.findIndex((c) => c.id === id);
    const c = {
      id,
      provider,
      sessionId: session,
      busy,
      closed: false,
      attention: { turnEndedAt: endedAt },
    };
    if (i >= 0) connections[i] = c;
    else connections.push(c);
  };
  let ends = 0;
  /** End a chat's turn now (its turnEndedAt moves; AIB sees it in the next refresh). */
  const endTurn = async (id: string, provider: string, session: string) => {
    chat(
      id,
      provider,
      session,
      new Date(Date.UTC(2026, 10, 11, 10, 0, ++ends)).toISOString(),
    );
    await ctx.artifacts.refresh();
  };
  return {
    ctx,
    web,
    port: bound,
    root,
    project,
    state,
    connections,
    queued,
    tool,
    chat,
    endTurn,
    url: (path: string) => `http://127.0.0.1:${bound}${path}`,
    async close() {
      await web.close();
    },
    async done() {
      await web.close().catch(() => {});
      await Deno.remove(root!, { recursive: true }).catch(() => {});
    },
  };
}
export type Studio = Awaited<ReturnType<typeof studio>>;

/** A headless browser over the DevTools protocol. */
export class Browser {
  #proc: Deno.ChildProcess;
  readonly profile: string;
  readonly port: number;
  constructor(proc: Deno.ChildProcess, profile: string, port: number) {
    this.#proc = proc;
    this.profile = profile;
    this.port = port;
  }
  static async launch(): Promise<Browser> {
    assert(browserPath, 'Chrome or Edge');
    const profile = await temp('aib-docpage-profile-');
    const proc = new Deno.Command(browserPath!, {
      args: [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        `--user-data-dir=${profile}`,
        '--window-size=1280,900',
        '--remote-debugging-port=0',
        'about:blank',
      ],
      stdout: 'null',
      stderr: 'null',
    }).spawn();
    let port = 0;
    for (let i = 0; i < 200 && !port; i++) {
      try {
        port = parseInt(
          Deno.readTextFileSync(`${profile}/DevToolsActivePort`),
          10,
        ) || 0;
      } catch { /* not written yet */ }
      if (!port) await sleep(50);
    }
    assert(port, 'DevTools port');
    return new Browser(proc, profile, port);
  }
  async open(url: string, width = 1280, height = 900): Promise<Page> {
    const target = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, {
      method: 'PUT',
    })).json();
    const page = new Page(target.webSocketDebuggerUrl, target.id, this.port);
    await page.ready;
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '') + ':' + e.lineNumber));",
    });
    await page.viewport(width, height);
    await page.goto(url);
    return page;
  }
  /** At process exit (an unload handler cannot wait): kill Chrome now; its profile folder is a temp folder the OS clears. */
  killNow(): void {
    try {
      this.#proc.kill();
    } catch { /* gone */ }
    try {
      Deno.removeSync(this.profile, { recursive: true });
    } catch { /* Chrome still holds it for a moment */ }
  }
  async close(): Promise<void> {
    try {
      this.#proc.kill();
    } catch { /* gone */ }
    await this.#proc.status;
    for (let i = 0; i < 20; i++) {
      try {
        await Deno.remove(this.profile, { recursive: true });
        break;
      } catch {
        await sleep(100);
      }
    }
  }
}

export class Page {
  #ws: WebSocket;
  #next = 1;
  #waiting = new Map<
    number,
    { resolve: (v: Json) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<void>;
  readonly errors: string[] = [];
  readonly csp: string[] = [];
  readonly logs: string[] = [];
  /** DevTools events a test listens to (method -> handler), e.g. Fetch.requestPaused. */
  readonly listeners = new Map<string, (params: Json) => void>();
  constructor(url: string, readonly id: string, readonly port: number) {
    this.#ws = new WebSocket(url);
    this.ready = new Promise((r) => (this.#ws.onopen = () => r()));
    this.#ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.#waiting.has(msg.id)) {
        const w = this.#waiting.get(msg.id)!;
        this.#waiting.delete(msg.id);
        if (msg.error) {
          w.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
        } else w.resolve(msg.result ?? {});
        return;
      }
      if (msg.method && this.listeners.has(msg.method)) this.listeners.get(msg.method)!(msg.params ?? {});
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(
          `${d.text} ${d.exception?.description ?? ''}`.slice(0, 600),
        );
      } else if (
        msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error'
      ) {
        this.errors.push(
          msg.params.args.map((a: Json) => a.value ?? a.description ?? '').join(
            ' ',
          ).slice(0, 600),
        );
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        const text = String(e.text ?? '');
        this.logs.push(`${e.level} ${text}`);
        if (
          /Content Security Policy|Refused to (apply|execute|load|connect)/i
            .test(text)
        ) this.csp.push(text.slice(0, 400));
      }
    };
  }
  send(method: string, params: Json = {}): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = this.#next++;
      // a page that stops answering (a busy loop) fails the step with what it was doing, instead of hanging the run
      const timer = setTimeout(() => {
        if (!this.#waiting.has(id)) return;
        this.#waiting.delete(id);
        reject(new Error(`the page did not answer ${method} ${JSON.stringify(params).slice(0, 300)}`));
      }, 20000);
      this.#waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 10000);
  }
  async viewport(width: number, height = 900): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  /** Evaluate an expression (awaits promises) and return its value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const d = r.exceptionDetails as Json | undefined;
    if (d) {
      throw new Error(
        `page: ${(d.exception as Json)?.description ?? d.text}\n  in: ${expression.slice(0, 300)}`,
      );
    }
    return (r.result as Json)?.value as T;
  }
  async waitFor(
    expression: string,
    ms = 8000,
    what?: string,
  ): Promise<unknown> {
    const end = Date.now() + ms;
    let last: unknown = null;
    for (;;) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (error) {
        last = error;
      }
      if (Date.now() > end) {
        throw new Error(
          `timed out waiting for ${what ?? expression}${last instanceof Error ? ': ' + last.message : ''}`,
        );
      }
      await sleep(40);
    }
  }
  /** Type text where the caret is (as an input method would: beforeinput/input events the editor handles). */
  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }
  /** Press a key; modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
  async key(key: string, modifiers = 0): Promise<void> {
    const codes: Record<string, [string, number]> = {
      Enter: ['Enter', 13],
      Escape: ['Escape', 27],
      ArrowDown: ['ArrowDown', 40],
      ArrowUp: ['ArrowUp', 38],
      Backspace: ['Backspace', 8],
      Tab: ['Tab', 9],
      Delete: ['Delete', 46],
      F2: ['F2', 113],
    };
    const [code, vk] = codes[key] ??
      [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
    const base = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter' && !modifiers) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'char',
        ...base,
        text: '\r',
      });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  /** Click the centre of the first element matching a selector (a real mouse click). */
  async click(selector: string): Promise<void> {
    const box = await this.waitFor(
      `(() => { const e = document.querySelector(${
        JSON.stringify(selector)
      }); if (!e) return null; e.scrollIntoView({block: 'center'}); const r = e.getBoundingClientRect(); return r.width && r.height ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`,
      8000,
      selector,
    ) as [number, number];
    const [x, y] = box;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }
  /** A PNG of the page (AIB_DOCPAGE_SHOTS=<folder> keeps them, for looking at the page). */
  async shot(name: string): Promise<void> {
    const dir = Deno.env.get('AIB_DOCPAGE_SHOTS');
    if (!dir) return;
    const png = await this.send('Page.captureScreenshot', { format: 'png' });
    await Deno.mkdir(dir, { recursive: true });
    Deno.writeFileSync(
      `${dir}/${name}.png`,
      Uint8Array.from(atob(String(png.data ?? '')), (c) => c.charCodeAt(0)),
    );
  }
  /** CSP violations the page itself saw plus the ones the console reported. */
  async violations(): Promise<string[]> {
    const own = await this.eval<string[]>('window.__csp || []').catch(() => []);
    return [...own, ...this.csp];
  }
  async close(): Promise<void> {
    await fetch(`http://127.0.0.1:${this.port}/json/close/${this.id}`).catch(
      () => {},
    );
    try {
      this.#ws.close();
    } catch { /* closed */ }
  }
}
