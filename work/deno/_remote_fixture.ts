/**
 * Phone access test helpers: a raw HTTP/1.1 client (fetch cannot set Host, which Tailscale Serve passes on), "Serve" headers for a
 * phone request, a fake Tailscale CLI (status / serve status answers from a JSON file the test edits), and an in-process AIB
 * whose agent host the test fills (chats, events, subagents).
 */
import { PAGE_KEY } from './_page_key.ts';
import { makeContext, type WebContext, WebServer } from '../../app/server/web/server.ts';
import type { LiveBackend } from '../../app/server/host/backend.ts';
import { stateSource } from '../../app/server/host/host_proxy.ts';
import { fullEvent, page, pageQuery } from '../../app/server/acp/event_pages.ts';
import type { UpdateService } from '../../app/server/desktop/updater.ts';
import { openSource, type Source } from '../../app/server/transcripts/monitor.ts';
import { projectKey } from '../../app/server/desktop/project_delete.ts';
import type { Runner } from '../../app/server/remote/tailscale.ts';
import type { AccessOptions } from '../../app/server/remote/access.ts';
import type { PcSyncOptions } from '../../app/server/pcsync/service.ts';
import { readRemotePort, saveRemotePort } from '../../app/server/remote/port.ts';

// test mode: the Tailscale and setup fakes are read, and no real Tailscale, winget, msiexec or browser can be reached
Deno.env.set('AGENT_STUDIO_TEST', '1');

type Json = Record<string, unknown>;
const sep = Deno.build.os === 'windows' ? '\\' : '/';

export const NAME = 'studio-pc.tail-a1b2.ts.net';
export const LOGIN = 'owner@example.com';

export interface Raw {
  status: number;
  headers: Headers;
  text: string;
  json: Json;
  bytes: Uint8Array;
}

/** One HTTP/1.1 request over a fresh TCP connection, headers exactly as given (Host included). */
export async function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Raw> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    const payload = body === undefined ? new Uint8Array() : new TextEncoder().encode(body);
    let head = `${method} ${path} HTTP/1.1\r\n`;
    const all: Record<string, string> = { Connection: 'close', ...headers };
    if (body !== undefined) {
      all['Content-Type'] = 'application/json';
      all['Content-Length'] = String(payload.byteLength);
    }
    for (const [k, v] of Object.entries(all)) head += `${k}: ${v}\r\n`;
    head += '\r\n';
    await conn.write(new TextEncoder().encode(head));
    // Send the body while reading the answer: a server that refuses a big body early never reads it, and a write that waits for the
    // whole body to be taken (Linux's socket buffers are small next to 31 MB) would wait forever, with the 413 already sent.
    if (payload.byteLength) {
      const writer = conn.writable.getWriter();
      void writer.write(payload).catch(() => {}).finally(() => writer.releaseLock());
    }
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    const deadline = Date.now() + 20000;
    const join = () => {
      const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    };
    /** The whole answer is in (by Content-Length, the chunked end, or no body): stop without waiting for the connection to close. */
    const complete = (data: Uint8Array) => {
      const end = indexOf(data, [13, 10, 13, 10]);
      if (end >= data.length) return false;
      const head = new TextDecoder().decode(data.slice(0, end)).toLowerCase();
      const length = head.match(/\r\ncontent-length:\s*(\d+)/)?.[1];
      if (length !== undefined) return data.length - end - 4 >= Number(length);
      if (/\r\ntransfer-encoding:\s*chunked/.test(head)) return new TextDecoder().decode(data.slice(-7)).endsWith('0\r\n\r\n');
      return / 304 | 204 /.test(head.split('\r\n')[0] + ' ');
    };
    for (;;) {
      if (Date.now() > deadline) throw new Error(`no answer to ${method} ${path}`);
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
      if (complete(join())) break;
    }
    const all8 = join();
    const split = indexOf(all8, [13, 10, 13, 10]);
    const headText = new TextDecoder().decode(all8.slice(0, split));
    let rest: Uint8Array = all8.slice(split + 4);
    const lines = headText.split('\r\n');
    const status = Number(lines[0].split(' ')[1]);
    const out = new Headers();
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) out.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    if ((out.get('transfer-encoding') ?? '').includes('chunked')) rest = unchunk(rest);
    const text = new TextDecoder().decode(rest);
    let json: Json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch { /* not JSON */ }
    return { status, headers: out, text, json, bytes: rest };
  } finally {
    try {
      conn.close();
    } catch { /* closed */ }
  }
}

function indexOf(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return hay.length;
}

function unchunk(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  for (;;) {
    const end = indexOf(data.slice(i), [13, 10]) + i;
    const size = parseInt(new TextDecoder().decode(data.slice(i, end)), 16);
    if (!size) break;
    out.push(...data.slice(end + 2, end + 2 + size));
    i = end + 2 + size + 2;
  }
  return new Uint8Array(out);
}

/** The headers Tailscale Serve and a phone's Chrome send for a same-origin API call (override any of them). */
export function phoneHeaders(extra: Record<string, string | null> = {}, method = 'GET'): Record<string, string> {
  const base: Record<string, string | null> = {
    Host: NAME,
    'Tailscale-User-Login': LOGIN,
    'Tailscale-User-Name': 'Owner',
    'X-Forwarded-For': '100.64.0.7',
    'X-Forwarded-Proto': 'https',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(method === 'POST' ? { Origin: `https://${NAME}` } : {}),
    ...extra,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== null) out[k] = v;
  return out;
}

/** A fake `tailscale` CLI: answers from `state` (edit it between calls). */
export function fakeTailscale(
  state: { status?: Json | null; serve?: Json; running?: boolean } = {},
): { runner: Runner; state: typeof state; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = (args) => {
    calls.push(args);
    if (state.status === null) return Promise.resolve(null);
    if (args[0] === 'status') return Promise.resolve({ code: 0, stdout: JSON.stringify(state.status ?? tailscaleStatus()) });
    if (args[0] === 'serve') return Promise.resolve({ code: 0, stdout: JSON.stringify(state.serve ?? {}) });
    return Promise.resolve({ code: 1, stdout: '' });
  };
  return { runner, state, calls };
}

export function tailscaleStatus(over: Json = {}): Json {
  return {
    BackendState: 'Running',
    Self: { DNSName: NAME + '.', HostName: 'studio-pc', UserID: 42 },
    User: { '42': { LoginName: LOGIN, DisplayName: 'Owner' } },
    CertDomains: [NAME],
    CurrentTailnet: { Name: 'example.com', MagicDNSSuffix: 'tail-a1b2.ts.net' },
    ...over,
  };
}

/** `tailscale serve status --json` with https 443 sent to the phone port and (Phase D, `artifactPort`) https 8443 to the artifact
 * port; Funnel on for 443 (`true`) or for the port named. */
export function serveStatus(port: number, funnel: boolean | string = false, artifactPort = 0): Json {
  const web: Json = { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } };
  if (artifactPort) web[`${NAME}:8443`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${artifactPort}` } } };
  return {
    TCP: { '443': { HTTPS: true }, ...(artifactPort ? { '8443': { HTTPS: true } } : {}) },
    Web: web,
    ...(funnel ? { AllowFunnel: { [`${NAME}:${funnel === true ? '443' : funnel}`]: true } } : {}),
  };
}

export async function tempDir(prefix: string): Promise<string> {
  return Deno.realPathSync(await Deno.makeTempDir({ prefix })).replace(/^\\\\\?\\/, '');
}

export interface FakeChat {
  id: string;
  provider: string;
  sessionId: string;
  cwd: string;
  busy: boolean;
  closed: boolean;
  attention: Json;
  subagents: Json;
  events: Json[];
  permissions: Json[];
  elicitations: Json[];
  breadth?: Json;
  /** Phase B: can take a message (default: not closed), its queue, unknown receipts, a sign-in request. */
  ready?: boolean;
  queue?: Json;
  unknownReceipts?: Json[];
  auth?: Json | null;
}

/** One saved Claude Code chat of the fixture's project (a transcript file, as Claude Code writes it). `ageSeconds`: how long ago it
 * was last written (its rows' times and the file's modified time). */
export interface SavedChatSpec {
  sessionId: string;
  rows?: Json[];
  prompt?: string;
  reply?: string;
  ageSeconds?: number;
}

export function writeSavedChat(claudeDir: string, project: string, spec: SavedChatSpec): string {
  const when = new Date(Date.now() - (spec.ageSeconds ?? 3600) * 1000);
  const stamp = when.toISOString();
  const base = { sessionId: spec.sessionId, cwd: project, timestamp: stamp };
  const rows = spec.rows ?? [
    { type: 'user', ...base, message: { role: 'user', content: spec.prompt ?? `Work on ${spec.sessionId}` } },
    {
      type: 'assistant',
      ...base,
      message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: spec.reply ?? 'Done.' }] },
    },
  ];
  Deno.mkdirSync(`${claudeDir}${sep}enc`, { recursive: true });
  const file = `${claudeDir}${sep}enc${sep}${spec.sessionId}.jsonl`;
  Deno.writeTextFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  Deno.utimeSync(file, when, when);
  return file;
}

/** An in-process AIB (page port 0) with a fake agent host the test fills; phone access options come from the test.
 * `saved`: real saved transcripts (a Claude Code folder under the root) and one added project, `project`, they belong to. */
export async function remoteAib(phone: AccessOptions = {}, root?: string, extra: { saved?: boolean; pcsync?: PcSyncOptions } = {}) {
  root ??= await tempDir('aib-remote-');
  const state = `${root}${sep}state`;
  await Deno.mkdir(state, { recursive: true });
  const claudeDir = `${root}${sep}claude`;
  const project = `${root}${sep}projects${sep}shop`;
  let transcripts = {} as unknown as Source;
  if (extra.saved) {
    for (const dir of [claudeDir, `${root}${sep}omp`, project]) await Deno.mkdir(dir, { recursive: true });
    const added = { [projectKey(project)]: { path: project, at: 1 } };
    Deno.writeTextFileSync(
      `${state}${sep}studio-added-projects.json`,
      JSON.stringify({ version: 1, savedAt: 1, start: 'fresh', added }),
    );
    transcripts = await openSource(`${root}${sep}omp`, claudeDir);
  }
  // The phone port is fixed in remote-port.json (never port 0); an OS-chosen number, as for any child that comes back on its port.
  // Both are held open until the studio is built (closed just before this returns): a number picked and let go at once could be
  // taken by another process (an outgoing connection gets an ephemeral port too) before Phone access binds it, and AIB keeps its
  // phone port (port_busy, then no pairing code), so under a loaded test pool the pairing failed now and then.
  const held: Deno.Listener[] = [];
  if (readRemotePort(state) === null) {
    for (let i = 0; i < 2; i++) held.push(Deno.listen({ hostname: '127.0.0.1', port: 0 }));
    const [phonePort, artifactPort] = held.map((l) => (l.addr as Deno.NetAddr).port);
    saveRemotePort(state, phonePort, artifactPort); // and the artifact port (Phase D)
  }
  const chats: FakeChat[] = [];
  const stateCalls: [string, number][] = [];
  /** Every live op the agent host got ([name, body]); `liveAnswer` sets what it answers. */
  const liveCalls: [string, Json][] = [];
  let liveAnswer: (name: string, body: Json) => [number, unknown] = () => [200, { ok: true }];
  const host = {
    hostMode: 'test',
    liveInfo: () => Promise.resolve({ connections: [], instanceId: 'test' }),
    liveList: () =>
      Promise.resolve({
        connections: chats.map((c) => ({
          id: c.id,
          provider: c.provider,
          sessionId: c.sessionId,
          cwd: c.cwd,
          projectRoot: c.cwd,
          busy: c.busy,
          closed: c.closed,
          attention: c.attention,
          subagents: c.subagents,
          breadth: c.breadth ?? {},
          ready: c.ready ?? !c.closed,
          cursor: c.events.length ? c.events.at(-1)!.seq : 0,
          events: [],
        })),
      }),
    liveState: (id: string, after = 0) => {
      stateCalls.push([id, after]);
      const c = chats.find((x) => x.id === id);
      if (!c) return Promise.resolve(null);
      return Promise.resolve({
        ...c,
        projectRoot: c.cwd,
        ready: c.ready ?? !c.closed,
        queue: c.queue ?? { items: [], paused: false, reason: '', message: '' },
        unknownReceipts: c.unknownReceipts ?? [],
        auth: c.auth ?? null,
        events: c.events.filter((e) => (e.seq as number) > after),
        cursor: c.events.length ? c.events.at(-1)!.seq : 0,
        reset: false,
      });
    },
    // history loading: the same page rules the agent host uses, over this chat's events (host_proxy's older-host path)
    liveEvents: async (id: string, query: Json = {}) => {
      const state = await host.liveState(id, 0) as Json | null;
      return state ? page(stateSource(state), pageQuery(query)) : null;
    },
    liveEvent: async (id: string, seq: number) => {
      const state = await host.liveState(id, 0) as Json | null;
      return state ? fullEvent(stateSource(state), seq) : null;
    },
    liveWrites: () => Promise.resolve({}),
    liveCall: (name: string, body: Json) => {
      liveCalls.push([name, body]);
      return Promise.resolve(liveAnswer(name, body));
    },
    emitArtifact: () => Promise.resolve(true),
    // conversation marks: a delete is refused while the chat is live (web/shared.ts conversationAction)
    aibOwns: (provider: unknown, sessionId: unknown) =>
      Promise.resolve(chats.some((c) => !c.closed && c.provider === provider && c.sessionId === sessionId)),
    busyConnections: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  } as unknown as LiveBackend;
  const ctx: WebContext = makeContext({
    stateDir: state,
    host,
    updates: {} as UpdateService,
    webInstanceId: 'test',
    cliPort: 0,
    transcripts,
    claudeProjects: state,
    ompSessions: state,
    shutdown: () => {},
    phone: { bindRetryMs: 1500, ...phone },
    pcsync: extra.pcsync,
    pageKey: PAGE_KEY, // a browser on chat.html carries it in its link (_doc_browser.ts Page.goto)
  });
  const web = new WebServer(ctx);
  const port = await web.listen(0);
  for (const listener of held) listener.close(); // the test turns Phone access on next: it binds them
  return {
    ctx,
    web,
    port,
    root,
    state,
    chats,
    claudeDir,
    project,
    saveChat: (spec: SavedChatSpec) => writeSavedChat(claudeDir, project, spec),
    stateCalls,
    liveCalls,
    answerLive(fn: (name: string, body: Json) => [number, unknown]) {
      liveAnswer = fn;
    },
    /** The page's own token (a test checks the phone port never returns it). */
    get token() {
      return ctx.token;
    },
    phonePort: () => ctx.phone.server?.port ?? 0,
    /** Phase D: the phone's artifact port (0 while it does not listen). */
    artifactPort: () => ctx.phone.artifactServer?.port ?? 0,
    async close() {
      await ctx.phone.close().catch(() => {});
      await ctx.artifacts?.stop().catch(() => {});
      await web.close().catch(() => {});
      for (let i = 0; i < 20; i++) {
        try {
          await Deno.remove(root!, { recursive: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    },
  };
}
export type RemoteAib = Awaited<ReturnType<typeof remoteAib>>;

/** Page-port call with the page token (the PC side: Settings > Devices). */
export async function pc(s: RemoteAib, method: string, path: string, body?: Json): Promise<[number, Json]> {
  const headers: Record<string, string> = { 'X-Studio-Token': s.token, Origin: `http://127.0.0.1:${s.port}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return [r.status, await r.json()];
}

/** A random phone nonce (hex), as phone.js makes one. */
export function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pair a fake phone end to end through the HTTP routes; returns its device token and cookie.
 *
 * kind 'computer' makes a computer paired the way it was before computers got sessions: a phone pairing whose kind the owner then
 * switched (Settings > Devices), so its `token` is the long-lived device key, as an older computer's was. (A computer approved as a
 * computer is given a session instead: pairComputer.) Scopes, when given, are set after the switch.
 */
export async function pairPhone(
  s: RemoteAib,
  name = 'Pixel 9',
  scopes?: string[],
  kind?: 'phone' | 'computer' | 'computer-session',
): Promise<{ token: string; cookie: string; id: string; session: boolean }> {
  const port = s.phonePort();
  const [pairStatus, code] = await pc(s, 'POST', '/api/live/devices/pair', {});
  // say why when there is no code (e.g. 409 not_ready: the phone port did not listen), not a TypeError on `words`
  if (!Array.isArray(code.words)) throw new Error(`pair: ${pairStatus} ${JSON.stringify(code)} (phone port ${port})`);
  const words = (code.words as string[]).join(' ');
  const claim = await raw(
    port,
    'POST',
    '/api/remote/pair/claim',
    phoneHeaders({}, 'POST'),
    JSON.stringify({ code: words, name, nonce: nonce() }),
  );
  if (claim.status !== 200) throw new Error(`claim: ${claim.status} ${claim.text}`);
  const [, view] = await pc(s, 'GET', '/api/live/devices');
  const pending = ((view.pairing as Json).pending as Json[]).find((p) => p.id === claim.json.claim)!;
  const legacyComputer = kind === 'computer';
  const [status] = await pc(s, 'POST', '/api/live/devices/approve', {
    claim: pending.id,
    ...(scopes ? { scopes } : {}),
    ...(kind && !legacyComputer ? { kind: kind === 'computer-session' ? 'computer' : kind } : {}),
  });
  if (status !== 200) throw new Error('approve');
  const done = await raw(
    port,
    'POST',
    '/api/remote/pair/status',
    phoneHeaders({}, 'POST'),
    JSON.stringify({ claim: claim.json.claim, claimSecret: claim.json.claimSecret }),
  );
  const cookie = (done.headers.get('set-cookie') ?? '').match(/__Host-aib-phone=([^;]+)/)?.[1] ?? '';
  const id = (done.json.device as Json).id as string;
  if (legacyComputer) {
    const [kindStatus] = await pc(s, 'POST', '/api/live/devices/kind', { id, kind: 'computer' });
    if (kindStatus !== 200) throw new Error('kind');
    if (scopes) await pc(s, 'POST', '/api/live/devices/scopes', { id, scopes });
  }
  return { token: done.json.token as string, cookie, id, session: done.json.session === true };
}

/** A computer approved as a computer on the PC: the pairing gives it a short session token (and the HttpOnly cookie), no long-lived key. */
export function pairComputer(s: RemoteAib, name = 'Laptop (Edge)', scopes?: string[]) {
  return pairPhone(s, name, scopes, 'computer-session');
}
