/**
 * What a paired phone may do to a live chat (phase B): answer a question, approve or deny a request once, send a message, stop a
 * turn, and look after its own queued messages. Each phone route builds a fresh body from the few fields it needs (nothing else
 * from the phone reaches the agent host) and checks it against the chat as it is right now:
 *
 *   elicitation  form questions only; a link ("url") question is finished on the PC.
 *   permission   only an option whose kind is allow_once or reject_once, whose id is not a permission mode (Claude's plan exit offers
 *                acceptEdits / bypassPermissions / default: each switches the chat's mode) and whose id or label does not say
 *                "always" / "don't ask again" / "session". AIB's own merge tools are PC only. Anything unclear is refused.
 *   prompt/queue plain text only: no attachments, nothing that starts with "/" (an agent or AIB command such as /doc).
 *   queue-*      only messages that are queued in that chat right now (not one being sent); queue-resume only while the chat has
 *                queued messages (a Stop or a failed turn paused them).
 *   authenticate never from a phone.
 *
 * A chat that is not running on the PC is refused with "Open it in AIB on your PC" (owner decision pending: no connect from a phone).
 */
import type { WebContext } from '../web/server.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const isStr = (v: unknown): v is string => typeof v === 'string';

export const MAX_TEXT = 8000;

/** The phone routes that act on a chat: path -> the live op it becomes and the word written to the phone activity log. */
export const ACTION_OPS: Readonly<Record<string, { op: string; audit: string }>> = {
  '/api/remote/elicitation': { op: 'elicitation', audit: 'answer' },
  '/api/remote/permission': { op: 'permission', audit: 'approve' },
  '/api/remote/prompt': { op: 'prompt', audit: 'send' },
  '/api/remote/queue': { op: 'queue', audit: 'queue' },
  '/api/remote/cancel': { op: 'cancel', audit: 'stop' },
  '/api/remote/queue-send-now': { op: 'queue-send-now', audit: 'queue: send now' },
  '/api/remote/queue-edit': { op: 'queue-edit', audit: 'queue: edit' },
  '/api/remote/queue-remove': { op: 'queue-remove', audit: 'queue: remove' },
  '/api/remote/dismiss-unknown': { op: 'dismiss-unknown', audit: 'dismiss' },
  '/api/remote/queue-resume': { op: 'queue-resume', audit: 'queue: resume' },
  '/api/remote/authenticate': { op: 'authenticate', audit: 'sign in' },
};

export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const REFUSALS = {
  notLive: () => new Refusal(409, 'not_live', 'This chat is not running on your PC. Open it in AIB on your PC to continue it.'),
  notReady: () => new Refusal(409, 'not_ready', 'This chat is still starting or cannot take messages. Try again in a moment.'),
  gone: () => new Refusal(409, 'gone', 'This was already answered or withdrawn.'),
  urlQuestion: () => new Refusal(403, 'pc_only', 'This question opens a web page. Finish this on your PC.'),
  option: () => new Refusal(403, 'pc_only', 'That choice is on your PC only. From a phone you can allow or deny once.'),
  merge: () => new Refusal(403, 'pc_only', "AIB's merge requests are approved on your PC only."),
  signIn: () => new Refusal(403, 'pc_only', 'Signing an agent in is done on your PC only.'),
  attachments: () => new Refusal(403, 'text_only', 'From a phone you can send text only. Add files in AIB on your PC.'),
  command: () => new Refusal(403, 'text_only', 'Messages that start with / are commands. Type them in AIB on your PC.'),
  empty: () => new Refusal(400, 'empty', 'Type a message first.'),
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

function text(body: Json): string {
  const value = body.text;
  if (!isStr(value)) throw REFUSALS.empty();
  if (!value.trim()) throw REFUSALS.empty();
  if (value.length > MAX_TEXT) throw REFUSALS.tooLong();
  if (value.trimStart().startsWith('/')) throw REFUSALS.command();
  return value;
}

function noFiles(body: Json): void {
  const a = body.attachments;
  if (a !== undefined && a !== null && !(Array.isArray(a) && a.length === 0)) throw REFUSALS.attachments();
  for (const k of ['files', 'images', 'file']) if (body[k] !== undefined && body[k] !== null) throw REFUSALS.attachments();
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
    case 'queue': {
      noFiles(body);
      const value = text(body);
      canTakeMessages(state);
      return { id, text: value, clientMessageId: messageId(body) };
    }
    case 'cancel':
      return { id };
    case 'queue-send-now':
    case 'queue-remove': {
      const item = messageId(body, 'messageId');
      queuedItem(state, item);
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
