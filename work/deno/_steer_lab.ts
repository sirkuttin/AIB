/**
 * Harness of the steer-on-send end-to-end tests (steer_e2e_test.ts, steer_layout_e2e_test.ts): a real Studio web server and a real,
 * separate agent host (so the routes go through the host proxy and its allow list), a temp state folder, a free port (never 8767,
 * 8768, 8777, 8778) and, for the page tests, a headless Chrome/Edge (no window).
 *
 * The agents are work/fake_acp.py --steer <claude|codex|omp>, which replays the real recordings of work/steer-recordings (see the
 * flag's help for the prompts: steer-bash:<gate>, steer-helper:<gate>, steer-perm, steer-wait:<gate>, steer-drop:<gate>,
 * steer-late:<gate>). Claude and Codex start through launcher scripts the lab writes, OMP through a one-line program that ignores
 * its `acp` argument. A provider listed in `plain` runs without --steer: an agent that cannot steer. Every line an agent receives
 * is logged (FAKE_ACP_LOG), so a test can see what reached it and in which order.
 *
 * The contract names (build-brief-beta9.md) live in ROUTES and SNAPSHOT below; the lead reconciles them when A and B land.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, httpJson, type Json, nativePath, PY, SEP, sleep, until, type Web } from './_host_fixture.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { WORK } from './_parity.ts';

export { assert, assertEquals, browserPath, sleep, until };
export type { Json, Page };

export const FAKE_ACP = nativePath(new URL('fake_acp.py', WORK));
export type Who = 'claude' | 'codex' | 'omp';
const WIN = Deno.build.os === 'windows';

/** Route names of the shared contract. `steer` is a live op (POST /api/live/steer {id, text, clientMessageId, attachments?}); the
 *  background stop is POST /api/live/tool/<toolCallId>/stop {id}. Change here only. */
export const ROUTES = {
  steer: () => '/api/live/steer',
  stopTool: () => '/api/live/tool-stop',
};

export interface LabOptions {
  /** Providers that run WITHOUT --steer (an agent that cannot steer). */
  plain?: Who[];
  /** Extra fake_acp.py flags per provider (e.g. --child-pid-file <path>). */
  extra?: Partial<Record<Who, string[]>>;
}

export const pidAlive = (pid: number): boolean => {
  try {
    if (WIN) {
      const out = new Deno.Command('tasklist', { args: ['/FI', `PID eq ${pid}`, '/NH'], stdout: 'piped' }).outputSync();
      return new TextDecoder().decode(out.stdout).includes(String(pid));
    }
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
};

/** An agent chat of the lab. */
export interface SteerChat {
  id: string;
  provider: Who;
  sessionId: string;
  /** A path inside the lab for a gate file; the fake's command ends when the file exists. */
  gate(name?: string): string;
  open(gate: string): void;
  prompt(text: string, messageId?: string): Promise<[number, Json]>;
  steer(text: string, messageId?: string): Promise<[number, Json]>;
  queue(text: string, messageId?: string): Promise<[number, Json]>;
  cancel(): Promise<[number, Json]>;
  stopTool(toolCallId: string): Promise<[number, Json]>;
  state(): Promise<Json>;
  /** Events of a kind ('user', 'update', 'turn_end', ...). */
  events(kind?: string): Promise<Json[]>;
  /** The text of every agent message chunk so far, joined. */
  agentText(): Promise<string>;
  /** Every JSON-RPC line this provider's fake agent received so far. */
  received(): Json[];
  /** [parent, leaf] process ids of the fake's command started for this gate (once it ran). */
  pids(gate: string): Promise<[number, number]>;
}

export class SteerLab extends Fixture {
  readonly launchers: Record<Who, string>;
  readonly configDir: string;
  web!: Web;
  #chats = 0;
  #gates = 0;

  constructor(readonly options: LabOptions = {}) {
    super();
    // the launchers are fixtures under work/ (the test guard of connection.ts only starts those); what each runs is in <root>/steer-agents/<who>.json
    this.configDir = this.root + SEP + 'steer-agents';
    Deno.mkdirSync(this.configDir);
    for (const who of ['claude', 'codex', 'omp'] as const) {
      const flags = [...(options.plain?.includes(who) ? [] : ['--steer', who]), ...(options.extra?.[who] ?? [])];
      Deno.writeTextFileSync(`${this.configDir}${SEP}${who}.json`, JSON.stringify({ flags, log: this.logOf(who) }));
    }
    const at = (name: string) => nativePath(new URL(`steer-fixture/${name}`, WORK));
    // OMP is started as `<omp-command> acp`: a program that ignores its arguments
    this.launchers = { claude: at('claude.py'), codex: at('codex.py'), omp: at(WIN ? 'omp.cmd' : 'omp') };
  }

  override get env(): Record<string, string> {
    return { ...super.env, AIB_STEER_LAB: this.configDir, AIB_STEER_PY: PY };
  }

  logOf(who: Who): string {
    return `${this.root}${SEP}received-${who}.log`;
  }

  override agentFlags(): string[] {
    return [
      ...super.agentFlags().slice(0, -1),
      this.launchers.claude,
      '--codex-launcher',
      this.launchers.codex,
      '--omp-command',
      this.launchers.omp,
    ];
  }

  /** Start the web server (and its agent host as a separate process) once. */
  async start(extra: string[] = []): Promise<Web> {
    this.web = await this.startWeb(['--no-auto-reconnect', '--no-owner-announcements', ...extra]);
    return this.web;
  }

  readonly gates: string[] = [];

  gate(name?: string): string {
    const gate = `${this.root}${SEP}${name ?? 'gate'}-${this.#gates++}`;
    this.gates.push(gate);
    return gate;
  }

  /** Every command the fake started ends first (its waiters poll the gate file and would outlive the test by minutes). */
  override async cleanup(): Promise<void> {
    for (const gate of this.gates) {
      try {
        Deno.writeTextFileSync(gate, 'cleanup');
        Deno.writeTextFileSync(gate + '.cycle-end', 'cleanup');
      } catch { /* the folder is gone */ }
    }
    await sleep(300);
    await super.cleanup();
  }

  async chat(provider: Who = 'claude', folder = ''): Promise<SteerChat> {
    const cwd = folder ? `${this.workspace}${SEP}${folder}` : this.workspace;
    if (folder) Deno.mkdirSync(cwd, { recursive: true });
    const web = this.web;
    const [status, connection] = await web.post('connect', { provider, cwd, background: true });
    if (status !== 200) throw new Error(`connect: ${status} ${JSON.stringify(connection)}`);
    const id = connection.id as string;
    const ready = await until(async () => {
      const s = await web.state(id);
      return s.ready && s.sessionId ? s : null;
    }, 'connection ready', 60);
    const lab = this;
    const next = () => `m${++lab.#chats}`;
    const chat: SteerChat = {
      id,
      provider,
      sessionId: ready.sessionId as string,
      gate: (name) => lab.gate(name),
      open: (gate) => Deno.writeTextFileSync(gate, 'go'),
      prompt: (text, messageId = next()) => web.post('prompt', { id, text, clientMessageId: messageId }),
      steer: (text, messageId = next()) => httpJson('POST', web.port, ROUTES.steer(), web.token, { id, text, clientMessageId: messageId }),
      queue: (text, messageId = next()) => web.post('queue', { id, text, clientMessageId: messageId }),
      cancel: () => web.post('cancel', { id }),
      stopTool: (toolCallId) => httpJson('POST', web.port, ROUTES.stopTool(), web.token, { id, toolCallId }),
      state: () => web.state(id),
      events: async (kind) => ((await web.state(id)).events as Json[]).filter((e) => kind === undefined || e.kind === kind),
      agentText: async () =>
        (await chat.events('update'))
          .map((e) => (e.data as Json).update as Json)
          .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
          .map((u) => (u.content as Json | undefined)?.text ?? '')
          .join(''),
      received: () => {
        let text = '';
        try {
          text = Deno.readTextFileSync(lab.logOf(provider));
        } catch { /* nothing yet */ }
        return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json);
      },
      pids: async (gate) => {
        const text = await until(() => {
          try {
            return Deno.readTextFileSync(gate + '.pids');
          } catch {
            return '';
          }
        }, 'the command processes', 30);
        const [a, b] = text.trim().split(/\s+/).map(Number);
        return [a, b];
      },
    };
    return chat;
  }

  /** The `_session/steering` requests this provider's agent received, with the text of each. */
  steersReceived(chat: SteerChat): { text: string; meta: Json | undefined; blocks: Json[] }[] {
    return chat.received().filter((m) => m.method === '_session/steering').map((m) => {
      const params = m.params as Json;
      const blocks = (params.prompt as Json[]) ?? [];
      return { text: String(blocks.find((b) => b.type === 'text' && !String(b.text).startsWith('<studio-context>'))?.text ?? ''), meta: params._meta as Json | undefined, blocks };
    });
  }

  /** The `session/prompt` requests this provider's agent received, with the user's text of each. */
  promptsReceived(chat: SteerChat): string[] {
    return chat.received().filter((m) => m.method === 'session/prompt').map((m) =>
      String(((m.params as Json).prompt as Json[]).find((b) => b.type === 'text' && !String(b.text).startsWith('<studio-context>'))?.text ?? '')
    );
  }
}

/** A thing (object) anywhere in `value` for which `test` is true. */
export function deepFind(value: unknown, test: (o: Json) => boolean): Json | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const f = deepFind(v, test);
      if (f) return f;
    }
  } else if (value && typeof value === 'object') {
    if (test(value as Json)) return value as Json;
    for (const v of Object.values(value as Json)) {
      const f = deepFind(v, test);
      if (f) return f;
    }
  }
  return null;
}

/** The tool row's `background` of the contract ({state, stoppable}) as the snapshot carries it, or null. */
export async function backgroundOf(chat: SteerChat, toolCallId: string): Promise<{ state: string; stoppable: boolean } | null> {
  const found = deepFind(await chat.state(), (o) => (o.toolCallId === toolCallId || o.id === toolCallId) && !!o.background && typeof o.background === 'object');
  return found ? found.background as { state: string; stoppable: boolean } : null;
}

// ---- the page --------------------------------------------------------------------------------------------------------------------

let shared: Promise<Browser> | null = null;
export function sharedBrowser(): Promise<Browser> {
  if (!shared) {
    shared = Browser.launch();
    shared.then((b) => globalThis.addEventListener('unload', () => b.killNow())).catch(() => (shared = null));
  }
  return shared;
}

/** The chat page of a running lab, with the chat open (a real click on its sidebar row). */
export async function openPage(lab: SteerLab, chat: SteerChat, width = 1400, height = 900, theme?: 'teal-dark' | 'teal-light'): Promise<Page> {
  const browser = await sharedBrowser();
  const page = await browser.open('about:blank', width, height);
  const url = `http://127.0.0.1:${lab.web.port}/chat.html`;
  if (theme) {
    await page.goto(url);
    await page.eval(`localStorage.setItem('aib-theme', ${JSON.stringify(theme)})`);
  }
  await page.goto(url);
  await page.waitFor('!!document.getElementById("messages")', 15000, 'chat page');
  const key = `${chat.provider}:${chat.sessionId}`;
  const sel = `button.connection[data-key="${key}"]`;
  await page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 20000, `sidebar row ${key}`);
  // the row can be drawn a moment before the page listens to it: click again until it is selected
  for (let attempt = 1;; attempt++) {
    await page.click(sel);
    try {
      await page.waitFor(`document.querySelector(${JSON.stringify(sel)})?.classList.contains('selected')`, 3000, 'chat open');
      break;
    } catch (error) {
      if (attempt >= 6) throw error;
    }
  }
  return page;
}

/** Type into the composer and press Enter (modifiers: 1 Alt, 8 Shift). */
export async function typeAndSend(page: Page, text: string, modifiers = 0): Promise<void> {
  await page.click('#prompt');
  await page.type(text);
  await page.key('Enter', modifiers);
}

/** The visible text of the composer area (`#promptForm`). */
export const composerText = (page: Page): Promise<string> => page.eval<string>(`document.getElementById('promptForm')?.innerText ?? ''`);

/** A visible button (or menu item) in the page whose text matches. */
export function visibleByText(page: Page, pattern: string): Promise<boolean> {
  return page.eval<boolean>(
    `[...document.querySelectorAll('button, [role=menuitem], [role=option]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && new RegExp(${
      JSON.stringify(pattern)
    }, 'i').test(e.textContent || e.getAttribute('aria-label') || ''); })`,
  );
}

/** Click (a real mouse click) the first visible button whose text matches the pattern. */
export async function clickByText(page: Page, pattern: string, within = 'document'): Promise<void> {
  const found = await page.waitFor(
    `(() => { for (const e of ${within}.querySelectorAll('button, [role=menuitem], [role=option], a')) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && new RegExp(${
      JSON.stringify(pattern)
    }, 'i').test(e.textContent || e.getAttribute('aria-label') || e.title || '')) { e.setAttribute('data-steer-click', '1'); return true; } } return false; })()`,
    8000,
    `a button "${pattern}"`,
  );
  assert(found);
  try {
    await page.click('[data-steer-click="1"]');
  } finally {
    await page.eval(`document.querySelectorAll('[data-steer-click]').forEach((e) => e.removeAttribute('data-steer-click'))`);
  }
}

/** The text a permission card's key (state.permissions[0].key) answers. */
export async function answerCard(lab: SteerLab, chat: SteerChat, option = 'allow_once'): Promise<void> {
  const st = await chat.state();
  const card = (st.permissions as Json[])[0];
  assert(card, 'an open permission card');
  const [status, body] = await lab.web.post('permission', { id: chat.id, key: card.key, option });
  assert(status === 200, `permission: ${status} ${JSON.stringify(body)}`);
}

export const hasBrowser = !!browserPath;
export const TEST_OPTIONS = { sanitizeResources: false, sanitizeOps: false };
