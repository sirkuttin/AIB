/**
 * What the phone reads: small payloads built for a phone on a mobile link (review break 8), not the page's /api/live/* answers.
 *
 *   home   every live chat with its title, state, what waits for you, your turn, and its own helpers (`subagents`, folded under it
 *          on the phone; there is no server relation between chats, so none is made up). Needs-you chats first. A revision lets the
 *          phone poll cheaply (304 when nothing changed).
 *   chat   the last N events of one live chat, images replaced by URLs (/api/remote/image, cookie only) and other file bytes
 *          dropped; no model-in-use lookup, no settings, no permission bodies beyond a title. Artifact links (absolute loopback
 *          URLs of the PC's artifact origin, in live events and in the history a chat replays) point at the phone's artifact
 *          origin https://<name>:8443 instead (Phase D); what is stored is never changed.
 */
import { createHash } from 'node:crypto';
import type { WebContext } from '../web/server.ts';
import { permissionDetail, type PhoneOption, phoneOptions } from './actions.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const DEFAULT_TAIL = 200;
export const MAX_TAIL = 1000;
/** Image types the phone may load (never SVG: it can carry script). */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', omp: 'OMP', codex: 'Codex', gemini: 'Gemini' };

export function agentName(provider: unknown): string {
  const p = str(provider, 60);
  return AGENT_NAMES[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Agent');
}

function folderName(cwd: unknown): string {
  const parts = str(cwd, 1000).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}

export interface Helper {
  id: string;
  title: string;
  state: string;
}

export interface HomeChat {
  id: string;
  title: string;
  agent: string;
  folder: string;
  state: string;
  needs: number;
  busySince: string | null;
  turnEndedAt: string | null;
  yourTurn: boolean;
  helpers: Helper[];
}

export interface Home {
  revision: string;
  pcName: string;
  chats: HomeChat[];
  /** The chat drawn as the big card: the newest working or needing chat with helpers, else the newest active chat. */
  main: string | null;
}

/** Remembered first prompts of live chats (looked up once per chat, in the background), for chats with no other title. */
export class TitleCache {
  readonly titles = new Map<string, string>();
  #busy = false;
  #queue: string[] = [];

  want(ctx: WebContext, id: string): void {
    if (this.titles.has(id) || this.#queue.includes(id)) return;
    this.#queue.push(id);
    void this.#run(ctx);
  }

  async #run(ctx: WebContext): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#queue.length) {
        const id = this.#queue.shift()!;
        let title = '';
        try {
          const state = obj(await ctx.host.liveState(id, 0));
          const events = Array.isArray(state.events) ? state.events : [];
          const first = events.find((e) => obj(e).kind === 'user');
          title = str(obj(obj(first).data).text, 170);
        } catch { /* gone */ }
        this.titles.set(id, title);
        while (this.titles.size > 500) this.titles.delete(this.titles.keys().next().value!);
      }
    } finally {
      this.#busy = false;
    }
  }
}

function helpersOf(subagents: unknown): Helper[] {
  const out: Helper[] = [];
  for (const [id, raw] of Object.entries(obj(subagents))) {
    const a = obj(raw);
    out.push({ id, title: str(a.title, 120) || str(a.description, 120) || 'Helper', state: str(a.state, 40) || 'unknown' });
  }
  return out.slice(-30);
}

export function revisionOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

export async function homePayload(ctx: WebContext, pcName: string, titles: TitleCache): Promise<Home> {
  const listing = obj(await ctx.host.liveList());
  const marks = ctx.conversations.public().entries;
  const chats: HomeChat[] = [];
  for (const raw of Array.isArray(listing.connections) ? listing.connections : []) {
    const c = obj(raw);
    if (c.closed) continue;
    const id = str(c.id, 100);
    if (!id) continue;
    const mark = obj(marks[`${str(c.provider, 60)}:${str(c.sessionId, 200)}`]);
    if (mark.archivedAt || mark.deletedAt) continue;
    const attention = obj(c.attention);
    const sessionTitle = str(obj(obj(c.breadth).sessionInfo).title, 170);
    let title = str(mark.title, 170) || sessionTitle;
    if (!title) {
      title = titles.titles.get(id) ?? '';
      if (!titles.titles.has(id)) titles.want(ctx, id);
    }
    const agent = agentName(c.provider);
    const folder = folderName(c.projectRoot || c.cwd);
    chats.push({
      id,
      title: title || `${agent}${folder ? ' in ' + folder : ''}`,
      agent,
      folder,
      state: str(attention.state, 20) || 'idle',
      needs: Number(attention.needs) || 0,
      busySince: (attention.busySince as string | null) ?? null,
      turnEndedAt: (attention.turnEndedAt as string | null) ?? null,
      yourTurn: Number(mark.yourTurnAt) > 0 && !mark.holdAt,
      helpers: helpersOf(c.subagents),
    });
  }
  const activity = (c: HomeChat) => Math.max(Date.parse(c.busySince ?? '') || 0, Date.parse(c.turnEndedAt ?? '') || 0);
  chats.sort((a, b) => (b.needs > 0 ? 1 : 0) - (a.needs > 0 ? 1 : 0) || activity(b) - activity(a) || a.title.localeCompare(b.title));
  const active = chats.filter((c) => c.state === 'working' || c.state === 'needs_you');
  const main = (active.find((c) => c.helpers.length) ?? active[0] ?? chats.find((c) => c.helpers.length) ?? chats[0])?.id ?? null;
  const body = { pcName, chats, main };
  return { revision: revisionOf(body), ...body };
}

/** A loopback artifact URL's origin (any port: history may come from an AIB that ran on another one), when an artifact path or
 * the libraries follow. Other loopback URLs (an agent's dev server) are left alone. */
const LOOPBACK_ARTIFACT = /\bhttps?:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}(?=\/(?:a\/[0-9a-f]{16}\/v[0-9]{1,6}\/|_lib\/))/g;

/** A copy of `value` with every loopback artifact URL in its strings moved to `origin` (the phone's artifact origin). */
export function withArtifactOrigin(value: unknown, origin: string): unknown {
  if (!origin) return value;
  if (typeof value === 'string') return value.includes('://') ? value.replace(LOOPBACK_ARTIFACT, origin) : value;
  if (Array.isArray(value)) return value.map((v) => withArtifactOrigin(v, origin));
  if (!value || typeof value !== 'object') return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) out[k] = withArtifactOrigin(v, origin);
  return out;
}

/** A copy of `value` with image bytes replaced by URLs and other embedded file bytes dropped. */
export function withoutBytes(value: unknown, image: (n: number, mime: string) => string, counter = { n: 0 }): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutBytes(v, image, counter));
  if (!value || typeof value !== 'object') return value;
  const out: Json = {};
  const src = value as Json;
  const mime = typeof src.mimeType === 'string' ? src.mimeType.toLowerCase() : '';
  const isImage = typeof src.data === 'string' && (src.type === 'image' || mime.startsWith('image/'));
  for (const [k, v] of Object.entries(src)) {
    if (k === 'data' && typeof v === 'string' && (isImage || mime || src.type === 'audio')) continue; // file bytes (base64)
    if (k === 'blob' && typeof v === 'string') continue; // embedded resource bytes
    out[k] = withoutBytes(v, image, counter);
  }
  if (isImage) {
    const n = counter.n++;
    if (IMAGE_TYPES.has(mime)) out.url = image(n, mime);
    out.bytesLeftOnPc = true;
  }
  return out;
}

/** The nth image (in withoutBytes' order) of one event: its base64 bytes and type, or null. */
export function imageOf(event: unknown, n: number): { data: string; mime: string } | null {
  let count = 0;
  let found: { data: string; mime: string } | null = null;
  const walk = (value: unknown) => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    const src = value as Json;
    const mime = typeof src.mimeType === 'string' ? src.mimeType.toLowerCase() : '';
    if (typeof src.data === 'string' && (src.type === 'image' || mime.startsWith('image/'))) {
      if (count++ === n) found = IMAGE_TYPES.has(mime) ? { data: src.data, mime } : null;
      // its own fields hold no further images
      for (const [k, v] of Object.entries(src)) if (k !== 'data') walk(v);
      return;
    }
    for (const v of Object.values(src)) walk(v);
  };
  walk(event);
  return found;
}

export interface ChatPayload {
  id: string;
  title: string;
  agent: string;
  folder: string;
  state: string;
  needs: number;
  busy: boolean;
  busySince: string | null;
  cursor: number;
  reset: boolean;
  /** The first event sent (the phone shows "earlier messages are on your PC" when it is not the chat's first). */
  firstSeq: number;
  truncated: boolean;
  helpers: Helper[];
  /** What waits for you: what the sheets need (permission: only the options a phone may pick; question: the form). */
  waiting: Waiting[];
  /** Can take a message now (ready, not read only). */
  ready: boolean;
  /** The connection has ended (the phone offers Continue this chat, by savedKey). */
  closed: boolean;
  /** provider:sessionId, the chat's stable key ('' before the agent gave it a session). */
  savedKey: string;
  /** Why it ended or could not open ('' when it did not). */
  error: string;
  /** Messages waiting to be sent in this chat (text, whether one is being sent or edited). */
  queue: { items: QueuedItem[]; paused: boolean; message: string };
  /** Messages that may or may not have reached the agent before AIB restarted. */
  unknown: { clientMessageId: string; at: number }[];
  events: unknown[];
}

export interface QueuedItem {
  id: string;
  text: string;
  files: number;
  sending: boolean;
  editing: boolean;
}

export interface Waiting {
  kind: 'permission' | 'question' | 'sign-in';
  title: string;
  key?: string;
  /** permission: the command or file it is about. */
  detail?: string;
  /** permission: the options a phone may pick (allow / deny once). */
  options?: PhoneOption[];
  /** permission: options left on the PC (Allow always and the like). */
  hidden?: number;
  /** Must be answered on the PC (a link question, AIB's merge request, sign-in, or no once-only option). */
  pcOnly?: boolean;
  /** question: the form's fields (the agent's requestedSchema). */
  schema?: unknown;
}

export async function chatPayload(
  ctx: WebContext,
  id: string,
  tail: number,
  after: number,
  titles: TitleCache,
  artifactOrigin = '',
): Promise<ChatPayload | null> {
  const state = await ctx.host.liveState(id, after) as Json | null;
  if (!state) return null;
  const all = Array.isArray(state.events) ? state.events : [];
  const n = Math.max(1, Math.min(MAX_TAIL, Math.trunc(tail) || DEFAULT_TAIL));
  const events = all.slice(-n);
  const attention = obj(state.attention);
  const waiting: Waiting[] = [];
  for (const p of Array.isArray(state.permissions) ? state.permissions : []) {
    const params = obj(obj(p).params);
    const { title, detail } = permissionDetail(params);
    const picked = phoneOptions(params);
    waiting.push({
      kind: 'permission',
      key: str(obj(p).key, 100),
      title,
      detail,
      options: picked.options,
      hidden: picked.hidden,
      pcOnly: picked.pcOnly,
    });
  }
  for (const e of Array.isArray(state.elicitations) ? state.elicitations : []) {
    const params = obj(obj(e).params);
    const form = params.mode === 'form';
    waiting.push({
      kind: 'question',
      key: str(obj(e).key, 100),
      title: typeof params.message === 'string' && params.message.trim() ? params.message.slice(0, 2000) : 'An agent has a question',
      pcOnly: !form,
      ...(form ? { schema: params.requestedSchema ?? {} } : {}),
    });
  }
  if (state.auth) waiting.push({ kind: 'sign-in', title: 'An agent needs you to sign in', pcOnly: true });
  const queue = obj(state.queue);
  const queued: QueuedItem[] = (Array.isArray(queue.items) ? queue.items : []).map(obj).map((i) => ({
    id: str(i.id, 128),
    text: typeof i.text === 'string' ? i.text.slice(0, 8000) : '',
    files: Array.isArray(i.attachments) ? i.attachments.length : 0,
    sending: !!i.sending,
    editing: !!i.editing,
  }));
  const unknown = (Array.isArray(state.unknownReceipts) ? state.unknownReceipts : []).map(obj)
    .filter((r) => typeof r.clientMessageId === 'string')
    .map((r) => ({ clientMessageId: r.clientMessageId as string, at: Number(r.at) || 0 }));
  const marks = ctx.conversations.public().entries;
  const mark = obj(marks[`${str(state.provider, 60)}:${str(state.sessionId, 200)}`]);
  const agent = agentName(state.provider);
  const folder = folderName(state.projectRoot || state.cwd);
  const title = str(mark.title, 170) || str(obj(obj(state.breadth).sessionInfo).title, 170) || titles.titles.get(id) ||
    `${agent}${folder ? ' in ' + folder : ''}`;
  return {
    id,
    title,
    agent,
    folder,
    state: str(attention.state, 20) || 'idle',
    needs: Number(attention.needs) || 0,
    busy: !!state.busy,
    busySince: (attention.busySince as string | null) ?? null,
    cursor: Number(state.cursor) || 0,
    reset: !!state.reset,
    firstSeq: Number(obj(events[0]).seq) || 0,
    truncated: all.length > events.length,
    helpers: helpersOf(state.subagents),
    waiting,
    ready: !!state.ready && !state.readOnly && !state.rebuilding && !state.closed,
    closed: !!state.closed,
    savedKey: str(state.provider, 60) && str(state.sessionId, 300) ? `${str(state.provider, 60)}:${str(state.sessionId, 300)}` : '',
    error: state.closed ? str(state.error, 400) : '',
    queue: { items: queued, paused: !!queue.paused, message: str(queue.message, 120) },
    unknown,
    events: events.map((e) => {
      const seq = Number(obj(e).seq) || 0;
      const light = withoutBytes(e, (k) => `/api/remote/image?id=${encodeURIComponent(id)}&seq=${seq}&n=${k}`);
      return withArtifactOrigin(light, artifactOrigin);
    }),
  };
}
