/**
 * What a paired phone may do to a live chat (phase B): answer a question, approve or deny a request once, send a message, stop a
 * turn, and look after its own queued messages. Each phone route builds a fresh body from the few fields it needs (nothing else
 * from the phone reaches the agent host) and checks it against the chat as it is right now:
 *
 *   elicitation  form questions only; a link ("url") question is finished on the PC.
 *   permission   only an option whose kind is allow_once or reject_once, whose id is not a permission mode (Claude's plan exit offers
 *                acceptEdits / bypassPermissions / default: each switches the chat's mode) and whose id or label does not say
 *                "always" / "don't ask again" / "session". AIB's own merge tools are PC only. Anything unclear is refused.
 *   prompt/steer/queue text, and pictures and files as bytes (phoneAttachments: never a path; the PC composer's types and limits;
 *                what this chat's agent can take), nothing that starts with "/" (an agent or AIB command such as /doc).
 *   queue-*      only messages that are queued in that chat right now (not one being sent); queue-resume only while the chat has
 *                queued messages (a Stop or a failed turn paused them).
 *   authenticate never from a phone.
 *
 * A chat that is not running on the PC is refused with "tap Continue this chat" (owner decision 3b: the phone starts it again with
 * POST /api/remote/continue, remote/saved.ts; an action never starts a chat by itself).
 */
import { claudeBase } from '../agents/claude_family.ts';
import type { WebContext } from '../web/server.ts';
import {
  MAX_FILES,
  MAX_IMAGES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  validateFileAttachments,
  validateImageAttachments,
} from '../acp/attachments.ts';
import { ValueError } from '../core/py.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const isStr = (v: unknown): v is string => typeof v === 'string';

export const MAX_TEXT = 8000;

/** The phone routes that act on a chat: path -> the live op it becomes and the word written to the phone activity log. */
export const ACTION_OPS: Readonly<Record<string, { op: string; audit: string }>> = {
  '/api/remote/elicitation': { op: 'elicitation', audit: 'answer' },
  '/api/remote/permission': { op: 'permission', audit: 'approve' },
  '/api/remote/prompt': { op: 'prompt', audit: 'send' },
  '/api/remote/steer': { op: 'steer', audit: 'send' }, // a typed message while the chat works: sent now when the agent can read it
  '/api/remote/queue': { op: 'queue', audit: 'queue' },
  '/api/remote/cancel': { op: 'cancel', audit: 'stop' },
  '/api/remote/queue-send-now': { op: 'queue-send-now', audit: 'queue: send now' },
  '/api/remote/queue-edit': { op: 'queue-edit', audit: 'queue: edit' },
  '/api/remote/schedule-cancel': { op: 'schedule-cancel', audit: 'scheduled: cancel' },
  '/api/remote/queue-remove': { op: 'queue-remove', audit: 'queue: remove' },
  '/api/remote/dismiss-unknown': { op: 'dismiss-unknown', audit: 'dismiss' },
  '/api/remote/queue-resume': { op: 'queue-resume', audit: 'queue: resume' },
  '/api/remote/authenticate': { op: 'authenticate', audit: 'sign in' },
  '/api/remote/swarm-act': { op: 'swarm-act', audit: 'merge: undo' }, // the Undo / Merge again word on a merge line (swarm/service.ts)
};

export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const REFUSALS = {
  notLive: () => new Refusal(409, 'not_live', 'This chat is not running on your PC. Tap Continue this chat to start it again, then send.'),
  notReady: () => new Refusal(409, 'not_ready', 'This chat is still starting or cannot take messages. Try again in a moment.'),
  gone: () => new Refusal(409, 'gone', 'This was already answered or withdrawn.'),
  urlQuestion: () => new Refusal(403, 'pc_only', 'This question opens a web page. Finish this on your PC.'),
  option: () => new Refusal(403, 'pc_only', 'That choice is on your PC only. From a phone you can allow or deny once.'),
  merge: () => new Refusal(403, 'pc_only', "AIB's merge requests are approved on your PC only."),
  signIn: () => new Refusal(403, 'pc_only', 'Signing an agent in is done on your PC only.'),
  /** A path, a link or any field but a file's name, type and bytes: a phone sends the file itself. */
  bytesOnly: () => new Refusal(400, 'bytes_only', 'Attach the file itself. A phone cannot send a path or a link to a file.'),
  tooMany: () => new Refusal(413, 'too_many', `Attach up to ${MAX_IMAGES} pictures and ${MAX_FILES} files to one message.`),
  tooBig: (why: string) => new Refusal(413, 'too_big', why),
  wrongType: (why: string) => new Refusal(415, 'wrong_type', why),
  noPictures: (agent: string) => new Refusal(403, 'no_pictures', `${agent} can't take pictures. Remove the picture and send again.`),
  noBinary: (agent: string, names: string[]) =>
    new Refusal(
      403,
      'text_files_only',
      `${agent} can take text files only, not ${names.join(', ')}. Remove ${names.length === 1 ? 'it' : 'them'} and send again.`,
    ),
  command: () => new Refusal(403, 'text_only', 'Messages that start with / are commands. Type them in AIB on your PC.'),
  empty: () => new Refusal(400, 'empty', 'Type a message or attach something first.'),
  tooLong: () => new Refusal(400, 'too_long', `A message from a phone can be at most ${MAX_TEXT} characters.`),
  notQueued: () => new Refusal(409, 'not_queued', 'That message is no longer waiting in this chat (it may already have been sent).'),
  bad: () => new Refusal(400, 'invalid', 'Invalid request'),
};

// ---- permission options ----------------------------------------------------------------------------------------------------

/** Option ids that switch a chat's permission mode (Claude Code's plan exit and mode names; other agents' mode words). */
const MODE_IDS = new Set(
  ['default', 'acceptedits', 'bypasspermissions', 'plan', 'dontask', 'auto', 'autoedit', 'auto_edit', 'yolo', 'full-access', 'readonly']
    .map((s) => s.toLowerCase()),
);
const LASTING = /always|don'?t ask|do not ask|never ask|session|remember|auto[- ]?accept|bypass|for all|every time|from now on/i;
const ONCE_KINDS = new Set(['allow_once', 'reject_once']);
/** AIB's own worktree tools: a merge is approved on the PC. */
const OWN_MERGE = /merge_into_project|resolve_edit_clash/i;

export interface PhoneOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'reject_once';
}

/** True when this permission is for AIB's own merge tools (any agent's naming). */
export function isMergeRequest(params: unknown): boolean {
  const call = obj(obj(params).toolCall);
  const meta = obj(call._meta);
  const names = [call.title, call.name, call.kind, obj(meta.claudeCode).toolName, obj(call.rawInput).tool, obj(call.rawInput).name];
  return names.some((n) => isStr(n) && OWN_MERGE.test(n));
}

/** One option a phone may pick, or null (refused). */
export function phoneOption(option: unknown): PhoneOption | null {
  const o = obj(option);
  const id = o.optionId;
  const kind = o.kind;
  const name = isStr(o.name) ? o.name : '';
  if (!isStr(id) || !id || !isStr(kind) || !ONCE_KINDS.has(kind)) return null;
  if (MODE_IDS.has(id.toLowerCase())) return null;
  if (LASTING.test(id) || LASTING.test(name)) return null;
  return { optionId: id, name: name.slice(0, 80), kind: kind as PhoneOption['kind'] };
}

/** The options of a permission request a phone may pick, and how many stay on the PC. */
export function phoneOptions(params: unknown): { options: PhoneOption[]; hidden: number; pcOnly: boolean } {
  const all = Array.isArray(obj(params).options) ? obj(params).options as unknown[] : [];
  if (isMergeRequest(params)) return { options: [], hidden: all.length, pcOnly: true };
  const options = all.map(phoneOption).filter((o): o is PhoneOption => o !== null);
  // Two options with the same kind and no way to tell them apart are ambiguous: keep the phone out of it.
  const kinds = options.map((o) => o.kind);
  const clear = options.filter((o) => kinds.filter((k) => k === o.kind).length === 1);
  return { options: clear, hidden: all.length - clear.length, pcOnly: clear.length === 0 };
}

/** What the approval sheet shows for a request: its title, the command or file it is about, and the folder. */
export function permissionDetail(params: unknown): { title: string; detail: string } {
  const call = obj(obj(params).toolCall);
  const input = obj(call.rawInput);
  const title = (isStr(call.title) && call.title.trim()) || 'An agent asks to run something';
  let detail = '';
  const command = input.command ?? input.cmd;
  if (isStr(command)) detail = command;
  else if (Array.isArray(command)) detail = command.filter(isStr).join(' ');
  else if (isStr(input.file_path)) detail = input.file_path;
  else if (isStr(input.path)) detail = input.path;
  else if (isStr(input.url)) detail = input.url;
  return { title: title.slice(0, 400), detail: detail === title ? '' : detail.slice(0, 4000) };
}

// ---- the chat as it is now -------------------------------------------------------------------------------------------------

/** The chat's state now (no events), or a not-live refusal. */
async function liveNow(ctx: WebContext, id: string): Promise<Json> {
  const list = obj(await ctx.host.liveList());
  const entry = (Array.isArray(list.connections) ? list.connections : []).map(obj).find((c) => c.id === id);
  if (!entry || entry.closed) throw REFUSALS.notLive();
  const state = obj(await ctx.host.liveState(id, Math.max(0, Math.trunc(Number(entry.cursor) || 0))));
  if (!state.id || state.closed) throw REFUSALS.notLive();
  return state;
}

function text(body: Json, attached = false): string {
  const value = body.text ?? (attached ? '' : undefined);
  if (!isStr(value)) throw REFUSALS.empty();
  if (!value.trim() && !attached) throw REFUSALS.empty();
  if (value.length > MAX_TEXT) throw REFUSALS.tooLong();
  if (value.trimStart().startsWith('/')) throw REFUSALS.command();
  return value;
}

/** Fields of a message body that would name a file instead of carrying it, or the old ways of sending one. */
const NOT_BYTES = ['files', 'images', 'file', 'path', 'paths', 'uri', 'url', 'filePath'];
const IMAGE_KEYS = new Set(['type', 'mimeType', 'data']);
const FILE_KEYS = new Set(['type', 'name', 'mimeType', 'data']);
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** What a chat's agent can take (its promptCapabilities). */
export interface Takes {
  pictures: boolean;
  binary: boolean;
  audio: boolean;
}
export function takesOf(state: Json): Takes {
  const caps = obj(state.promptCapabilities);
  return { pictures: caps.image === true, binary: caps.embeddedContext === true, audio: caps.audio === true };
}

const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', omp: 'OMP', codex: 'Codex', gemini: 'Gemini' };
export const agentLabel = (provider: unknown): string =>
  (isStr(provider) && provider && (AGENT_LABELS[claudeBase(provider)] ?? provider.slice(0, 40))) || 'This agent';

/**
 * The pictures and files of a phone message: bytes only (base64 `data`, a display name and a type; never a path, a link or any
 * other field), the PC composer's types and limits (acp/attachments.ts: 4 pictures of PNG, JPEG, GIF or WebP up to 5 MiB, 15 MiB
 * of pictures; 8 files, text up to 2 MiB, others up to 10 MiB; 20 MiB in all), and, when `takes` is known (null: a New chat that
 * is still opening), only what this chat's agent can take: pictures need image input, PDFs and other binary files need embedded
 * context, text files always go (as the PC composer). Returns fresh objects with exactly those fields (the agent host checks them
 * again), or [] for none. Throws a Refusal in phone words.
 */
export function phoneAttachments(body: Json, takes: Takes | null, agent = 'This agent'): Json[] {
  for (const k of NOT_BYTES) if (body[k] !== undefined && body[k] !== null) throw REFUSALS.bytesOnly();
  const list = body.attachments;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw REFUSALS.bad();
  if (!list.length) return [];
  if (list.length > MAX_IMAGES + MAX_FILES) throw REFUSALS.tooMany();
  const out: Json[] = [];
  for (const raw of list) {
    const item = obj(raw);
    const kind = item.type ?? 'image';
    const keys = kind === 'file' ? FILE_KEYS : IMAGE_KEYS;
    if (!Object.keys(item).length || Object.keys(item).some((k) => !keys.has(k))) throw REFUSALS.bytesOnly();
    if (kind !== 'image' && kind !== 'file') throw REFUSALS.bad();
    if (!isStr(item.data)) throw REFUSALS.bytesOnly();
    if (!item.data) throw new Refusal(400, 'empty_file', `${isStr(item.name) && item.name ? item.name : 'A file'} is empty.`);
    if (kind === 'image' && !PICTURE_TYPES.has(String(item.mimeType))) {
      throw REFUSALS.wrongType('Pictures must be PNG, JPEG, GIF or WebP.');
    }
    out.push(
      kind === 'file'
        ? { type: 'file', name: item.name, mimeType: item.mimeType ?? '', data: item.data }
        : { type: 'image', mimeType: item.mimeType, data: item.data },
    );
  }
  const images = out.filter((i) => i.type === 'image');
  const files = out.filter((i) => i.type === 'file');
  if (images.length > MAX_IMAGES || files.length > MAX_FILES) throw REFUSALS.tooMany();
  let total = 0;
  let binary: string[] = [];
  try {
    if (images.length) total += validateImageAttachments(images)[1];
    if (files.length) {
      const [records, bytes] = validateFileAttachments(files);
      total += bytes;
      binary = records.filter((r) => r.kind !== 'text' && !(r.kind === 'audio' && takes?.audio)).map((r) => r.name);
    }
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    const why = error.message.endsWith('.') ? error.message : error.message + '.';
    if (/limit|exceed/i.test(why)) throw REFUSALS.tooBig(why);
    if (/Images must be|as images, not as files|does not match|not a valid MIME/i.test(why)) throw REFUSALS.wrongType(why);
    throw new Refusal(400, 'bad_file', why);
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw REFUSALS.tooBig(`Attachments can be at most ${MAX_TOTAL_ATTACHMENT_BYTES / 1048576} MiB in all.`);
  }
  if (takes) {
    if (images.length && !takes.pictures) throw REFUSALS.noPictures(agent);
    if (binary.length && !takes.binary) throw REFUSALS.noBinary(agent, binary);
  }
  return out;
}

/** "with 1 picture and 2 files" for the activity log (never names or bytes), or ''. */
export function attachedWords(list: unknown): string {
  const items = Array.isArray(list) ? list.map(obj) : [];
  const pictures = items.filter((i) => i.type !== 'file').length;
  const files = items.length - pictures;
  const words = [
    pictures ? `${pictures} picture${pictures === 1 ? '' : 's'}` : '',
    files ? `${files} file${files === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return words.length ? 'with ' + words.join(' and ') : '';
}

function messageId(body: Json, field = 'clientMessageId'): string {
  const v = body[field];
  if (!isStr(v) || !v || v.length > 128) throw REFUSALS.bad();
  return v;
}

function queuedItem(state: Json, id: string): Json {
  const items = Array.isArray(obj(state.queue).items) ? obj(state.queue).items as unknown[] : [];
  const item = items.map(obj).find((i) => i.id === id);
  if (!item || item.sending) throw REFUSALS.notQueued();
  return item;
}

function canTakeMessages(state: Json): void {
  if (!state.ready || state.readOnly || state.rebuilding) throw REFUSALS.notReady();
}

/**
 * Check one phone action and build the body the agent host gets. Throws a Refusal. `op` is ACTION_OPS[path].op.
 */
export async function checkAction(ctx: WebContext, op: string, body: Json): Promise<Json> {
  if (op === 'authenticate') throw REFUSALS.signIn();
  const id = body.id;
  if (!isStr(id) || !id || id.length > 100) throw REFUSALS.bad();
  const state = await liveNow(ctx, id);
  switch (op) {
    case 'elicitation': {
      const key = body.key;
      const action = body.action;
      if (!isStr(key) || !isStr(action) || !['accept', 'decline', 'cancel'].includes(action)) throw REFUSALS.bad();
      const pending = (Array.isArray(state.elicitations) ? state.elicitations : []).map(obj).find((e) => e.key === key);
      if (!pending) throw REFUSALS.gone();
      const params = obj(pending.params);
      if (params.mode !== 'form') throw REFUSALS.urlQuestion();
      const out: Json = { id, key, action };
      if (action === 'accept') {
        const content = body.content;
        if (content !== undefined && content !== null && (typeof content !== 'object' || Array.isArray(content))) throw REFUSALS.bad();
        out.content = content ?? {};
      }
      return out;
    }
    case 'permission': {
      const key = body.key;
      const option = body.option;
      if (!isStr(key) || !isStr(option)) throw REFUSALS.bad();
      const pending = (Array.isArray(state.permissions) ? state.permissions : []).map(obj).find((p) => p.key === key);
      if (!pending) throw REFUSALS.gone();
      if (isMergeRequest(pending.params)) throw REFUSALS.merge();
      if (!phoneOptions(pending.params).options.some((o) => o.optionId === option)) throw REFUSALS.option();
      return { id, key, option };
    }
    case 'prompt':
    case 'steer': // same checks as a prompt; the agent host decides (steer now, hold while a card is open, or an ordinary prompt when idle)
    case 'queue': {
      const attachments = phoneAttachments(body, takesOf(state), agentLabel(state.provider));
      const value = text(body, attachments.length > 0);
      canTakeMessages(state);
      return { id, text: value, clientMessageId: messageId(body), ...(attachments.length ? { attachments } : {}) };
    }
    case 'cancel':
      return { id };
    case 'queue-send-now':
    case 'queue-remove': {
      const item = messageId(body, 'messageId');
      queuedItem(state, item);
      return { id, messageId: item };
    }
    case 'schedule-cancel': { // a phone sees the scheduled cards and can cancel one (scheduling itself is from the PC)
      const item = messageId(body, 'messageId');
      const waiting = Array.isArray(obj(state.queue).scheduled) ? obj(state.queue).scheduled as unknown[] : [];
      if (!waiting.map(obj).some((i) => i.id === item)) throw REFUSALS.notQueued();
      return { id, messageId: item };
    }
    case 'queue-edit': {
      const item = messageId(body, 'messageId');
      const action = body.action;
      if (!isStr(action) || !['acquire', 'renew', 'save', 'cancel'].includes(action)) throw REFUSALS.bad();
      queuedItem(state, item);
      const leaseId = body.leaseId;
      if (leaseId !== undefined && leaseId !== null && (!isStr(leaseId) || leaseId.length > 128)) throw REFUSALS.bad();
      const out: Json = { id, messageId: item, action, leaseId: leaseId ?? null };
      if (action === 'save') out.text = text(body);
      return out;
    }
    case 'queue-resume': {
      const items = Array.isArray(obj(state.queue).items) ? obj(state.queue).items as unknown[] : [];
      if (!items.length) throw REFUSALS.notQueued();
      return { id };
    }
    case 'dismiss-unknown': {
      const mid = messageId(body);
      const known = (Array.isArray(state.unknownReceipts) ? state.unknownReceipts : []).map(obj).some((r) => r.clientMessageId === mid);
      if (!known) throw REFUSALS.gone();
      return { id, clientMessageId: mid };
    }
  }
  throw REFUSALS.bad();
}
