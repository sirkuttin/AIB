/**
 * Windows toasts with buttons (Inbox v3.1 phase 4; aib-shared/designs/inbox-v31 section 3). The AIB server starts `AIB-keeper toast`
 * once, hidden (the keeper is a GUI-subsystem program: no console, ever), and talks JSON lines with it (keeper/toast.go). The
 * helper writes AIB's app identity under HKCU at every start (no installer, no shortcut), shows the toasts and hands each click back.
 *
 * Buttons, by the inbox row a notification is about (toastActs):
 *   approval      Allow / Deny (the agent's once-options); a risky command (push, force push, delete) or a PC-only request: Open
 *   asks/finished a Reply box and Send
 *   stalled       Continue · Open        failed  Retry · Open        a question form, a sign-in: Open
 *   grouped       ("3 agents are waiting for you") no buttons; a click opens the inbox
 * Every answering button carries a one-time code (ToastCodes) that only this AIB issued, for that chat and that request, and only
 * while the request is still open; a refused click just opens the chat (toast_act.ts). One toast per chat (its tag), removed from
 * the notification centre once its request is answered anywhere (seeInbox). If anything fails (the helper doesn't start, crashes,
 * or Windows refuses a toast), that notification goes out as today's tray balloon and the reason is logged once.
 *
 * Nothing here touches the OS by itself: the helper process is injected (SpawnToastHelper), so work/deno/desktop_toast_test.ts
 * runs it all with fakes and no toast ever shows during tests.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getLogger } from '../core/log.ts';
import { INBOX, type InboxRow } from '../attention/inbox_rules.ts';
import { RULES } from '../attention/rules.ts';
import { type NotifyRequest, type NotifyTarget, type OsNotify, quietReason, type ShowResult } from './notify.ts';

const log = getLogger('desktop');
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

/** AIB's app identity for toasts (HKCU\Software\Classes\AppUserModelId\AIB.Studio) and its click handler's fixed COM class. */
export const TOAST_APP_ID = 'AIB.Studio';
export const TOAST_CLSID = '{6B1F3A52-8C4D-4E7A-9F21-3D5B7C9E0A14}';
export const TOAST_GROUP = 'aib';
/** How long a toast's buttons stay good (a request older than that is answered in AIB). */
export const CODE_TTL_MS = 12 * 3600_000;

// ---------- what a toast shows ----------

export type ToastAct = 'allow' | 'deny' | 'reply' | 'continue' | 'retry' | 'open';

interface PermOption {
  optionId: string;
  name: string;
  kind: string;
}

function optionsOf(row: InboxRow | null): PermOption[] {
  const list = row?.request?.kind === 'permission' ? row.request.params.options : null;
  return (Array.isArray(list) ? list : []).map(obj).map((o) => ({
    optionId: String(o.optionId ?? ''),
    name: String(o.name ?? ''),
    kind: String(o.kind ?? ''),
  }))
    .filter((o) => o.optionId);
}

/** The agent's once-options: Allow is allow_once, Deny is reject_once ("Always" stays in the chat). */
export function onceOptions(row: InboxRow | null): { allow: PermOption | null; deny: PermOption | null } {
  const list = optionsOf(row);
  return { allow: list.find((o) => o.kind === 'allow_once') ?? null, deny: list.find((o) => o.kind === 'reject_once') ?? null };
}

/** A command never allowed with one click (notify-rules.js isRisky: push, force push, delete), or a delete tool. */
export function riskyRow(row: InboxRow | null): boolean {
  if (!row) return false;
  const tc = obj(row.request?.params?.toolCall);
  const raw = obj(tc.rawInput);
  if (String(tc.kind ?? '') === 'delete') return true;
  const text = [row.what, row.whatCode, typeof raw.command === 'string' ? raw.command : '', typeof tc.title === 'string' ? tc.title : '']
    .join('\n');
  return RULES.isRisky(text);
}

/** The buttons a row's toast gets (the module header's table), in order. */
export function toastActs(row: InboxRow | null): ToastAct[] {
  if (!row) return [];
  switch (row.kind) {
    case 'approval': {
      if (row.request?.kind !== 'permission' || row.request.pcOnly || riskyRow(row)) return ['open'];
      const { allow, deny } = onceOptions(row);
      if (!allow) return ['open'];
      return deny ? ['allow', 'deny'] : ['allow'];
    }
    case 'asks':
    case 'finished':
      return ['reply'];
    case 'stalled':
      return ['continue', 'open'];
    case 'failed':
      return ['retry', 'open'];
    default:
      return ['open'];
  }
}

export interface ToastSpec {
  title: string;
  body: string;
  launch: string;
  buttons: { label: string; args: string; input?: string }[];
  input: { id: string; placeholder: string } | null;
  silent: boolean;
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** A toast's content: the notification's own words (line 1 of the row), the body click, and the buttons with their code. */
export function toastSpec(req: Pick<NotifyRequest, 'title' | 'body' | 'target' | 'silent'>, row: InboxRow | null, code: string): ToastSpec {
  const key = req.target?.key ?? '';
  // a chat's row; the grouped toast: the inbox; no target (update ready, the Settings test): just AIB to the front
  const launch = key ? q({ act: 'open', chat: key }) : req.target ? q({ act: 'inbox' }) : q({ act: 'front' });
  const acts = key ? toastActs(row) : [];
  const labels: Record<ToastAct, string> = {
    allow: 'Allow',
    deny: 'Deny',
    reply: 'Send',
    continue: 'Continue',
    retry: 'Retry',
    open: 'Open',
  };
  const buttons = acts.map((act) =>
    act === 'open'
      ? { label: labels.open, args: launch }
      : { label: labels[act], args: q({ act, chat: key, n: code }), ...(act === 'reply' ? { input: 'reply' } : {}) }
  );
  return {
    title: req.title || 'AIB',
    body: req.body,
    launch,
    buttons,
    input: acts.includes('reply') ? { id: 'reply', placeholder: 'Reply' } : null,
    silent: req.silent === true,
  };
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * The ToastGeneric XML. Every click goes to AIB's COM activator (desktop apps ignore activationType="background"); AIB decides
 * that only Open and a body click bring a window forward. Default scenario only (no reminder toasts that stay on screen).
 */
export function toastXml(spec: ToastSpec): string {
  const lines = spec.body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  const texts = [spec.title, ...lines].map((t) => `<text>${xmlEscape(t)}</text>`).join('');
  let actions = '';
  if (spec.buttons.length) {
    const input = spec.input
      ? `<input id="${xmlEscape(spec.input.id)}" type="text" placeHolderContent="${xmlEscape(spec.input.placeholder)}"/>`
      : '';
    const buttons = spec.buttons.slice(0, 5).map((b) =>
      `<action content="${xmlEscape(b.label)}" arguments="${xmlEscape(b.args)}" activationType="foreground"${
        b.input ? ` hint-inputId="${xmlEscape(b.input)}"` : ''
      }/>`
    ).join('');
    actions = `<actions>${input}${buttons}</actions>`;
  }
  const audio = spec.silent ? '<audio silent="true"/>' : '';
  return `<toast launch="${
    xmlEscape(spec.launch)
  }"><visual><binding template="ToastGeneric">${texts}</binding></visual>${actions}${audio}</toast>`;
}

/** A click's arguments: act=<act>&chat=<key>&n=<code> (a body click: act=open&chat=<key>; the grouped toast: act=inbox). */
export function parseToastArgs(args: string): { act: string; chat: string; code: string } {
  const p = new URLSearchParams(String(args ?? '').slice(0, 2000));
  return { act: p.get('act') ?? '', chat: p.get('chat') ?? '', code: p.get('n') ?? '' };
}

/** What a body click or Open opens: the inbox on that chat's row (as the balloon's click), or the inbox. */
export function openTarget(chat: string): NotifyTarget {
  return chat ? { type: 'inbox', key: chat } : { type: 'inbox' };
}

/** A short, stable toast tag for a chat (Windows caps tags at 64 characters; chat keys can be longer). */
export function toastTag(chat: string): string {
  return createHash('sha256').update(chat).digest('hex').slice(0, 24);
}

// ---------- the one-time codes ----------

export type CodeRefusal = 'unknown' | 'used' | 'expired' | 'wrong_chat' | 'not_allowed' | 'answered';

interface CodeEntry {
  h: string;
  chat: string;
  sig: string;
  acts: ToastAct[];
  exp: number;
  used?: boolean;
}

const hashOf = (code: string) => createHash('sha256').update('aib-toast/v1\0' + code).digest('hex');

/**
 * The codes on toast buttons. A code is good once, for the chat and the request (the row's signature) it was issued for, for the
 * buttons it was issued with, until CODE_TTL_MS. Only hashes are kept, in memory and in <data>/toast-codes.json, so a click made
 * while AIB was fully quit (the helper's toast-inbox.jsonl) is still checked after AIB starts again.
 */
export class ToastCodes {
  #codes = new Map<string, CodeEntry>();
  readonly clock: () => number;

  constructor(readonly options: { file?: string; clock?: () => number; ttlMs?: number } = {}) {
    this.clock = options.clock ?? Date.now;
    if (options.file) {
      try {
        const list = JSON.parse(Deno.readTextFileSync(options.file));
        for (const e of Array.isArray(list) ? list : []) {
          const c = obj(e);
          if (typeof c.h === 'string' && typeof c.chat === 'string' && typeof c.sig === 'string' && Array.isArray(c.acts)) {
            this.#codes.set(c.h, {
              h: c.h,
              chat: c.chat,
              sig: c.sig,
              acts: c.acts as ToastAct[],
              exp: Number(c.exp) || 0,
              used: c.used === true,
            });
          }
        }
      } catch { /* none yet */ }
      this.#prune();
    }
  }

  /** A new code for this chat's toast; the chat's older codes stop working (one toast per chat). */
  issue(chat: string, sig: string, acts: ToastAct[]): string {
    this.revokeChat(chat, false);
    const code = randomBytes(18).toString('base64url');
    const h = hashOf(code);
    this.#codes.set(h, { h, chat, sig, acts: [...acts], exp: this.clock() + (this.options.ttlMs ?? CODE_TTL_MS) });
    this.#save();
    return code;
  }

  /** Is this click good? currentSig: the chat's row's signature now (null: the chat no longer needs you). Good once. */
  check(code: string, chat: string, act: string, currentSig: string | null): { ok: true } | { ok: false; reason: CodeRefusal } {
    const e = code ? this.#codes.get(hashOf(code)) : undefined;
    if (!e) return { ok: false, reason: 'unknown' };
    if (e.used) return { ok: false, reason: 'used' };
    if (this.clock() > e.exp) return { ok: false, reason: 'expired' };
    if (e.chat !== chat) return { ok: false, reason: 'wrong_chat' };
    if (!e.acts.includes(act as ToastAct)) return { ok: false, reason: 'not_allowed' };
    if (currentSig === null || currentSig !== e.sig) return { ok: false, reason: 'answered' };
    e.used = true;
    this.#save();
    return { ok: true };
  }

  /** The chat's codes stop working (its request was answered elsewhere). */
  revokeChat(chat: string, save = true): void {
    let changed = false;
    for (const [h, e] of this.#codes) {
      if (e.chat === chat) {
        this.#codes.delete(h);
        changed = true;
      }
    }
    if (changed && save) this.#save();
  }

  get size(): number {
    return this.#codes.size;
  }

  #prune(): void {
    const now = this.clock();
    for (const [h, e] of this.#codes) if (now > e.exp) this.#codes.delete(h);
    while (this.#codes.size > 200) this.#codes.delete(this.#codes.keys().next().value!);
  }

  #save(): void {
    this.#prune();
    if (!this.options.file) return;
    try {
      Deno.writeTextFileSync(this.options.file, JSON.stringify([...this.#codes.values()]));
    } catch { /* memory still works while AIB runs */ }
  }
}

// ---------- the helper process ----------

/** One running helper: send a message; messages and its end come back through the callbacks given to the spawner. */
export interface ToastHelperProc {
  send(msg: Json): void;
  close(): void;
}

export type SpawnToastHelper = (onMessage: (m: Json) => void, onExit: (why: string) => void) => ToastHelperProc;

/** `AIB-keeper toast` with stdin/stdout piped; stderr dropped. The keeper is GUI-subsystem: no console window ever. */
export function keeperToastSpawner(program: string): SpawnToastHelper {
  return (onMessage, onExit) => {
    const child = new Deno.Command(program, { args: ['toast'], stdin: 'piped', stdout: 'piped', stderr: 'null' }).spawn();
    const writer = child.stdin.getWriter();
    const enc = new TextEncoder();
    let open = true;
    (async () => {
      let buf = '';
      try {
        for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              onMessage(obj(JSON.parse(line)));
            } catch { /* not a message */ }
          }
        }
      } catch { /* the pipe ended */ }
      const status = await child.status.catch(() => null);
      open = false;
      onExit(`the helper ended (exit ${status?.code ?? '?'})`);
    })();
    return {
      send(msg) {
        if (!open) return;
        writer.write(enc.encode(JSON.stringify(msg) + '\n')).catch(() => {});
      },
      close() {
        open = false;
        writer.close().catch(() => {});
        setTimeout(() => {
          try {
            child.kill();
          } catch { /* gone */ }
        }, 2000);
      },
    };
  };
}

export interface RegisterInfo {
  appId: string;
  name: string;
  icon: string;
  clsid: string;
  /** AIB's data folder: a click while AIB is closed lands in <data>/toast-inbox.jsonl. */
  data: string;
  /** AIB's program, started by such a click ('' in a source run). */
  launch: string;
}

export interface ToastClick {
  args: string;
  inputs: Record<string, string>;
}

export interface WindowsToastsOptions {
  spawn: SpawnToastHelper;
  register: RegisterInfo;
  /** Today's balloon route: every notification the toast route can't show goes there. */
  balloon: OsNotify;
  quietState: () => number | null;
  codes: ToastCodes;
  /** The chat's inbox row now (the watcher's last inbox), or null. */
  rowOf: (key: string) => InboxRow | null;
  onActivated: (click: ToastClick) => void;
  /** How long to wait for the helper's answer (ms). */
  timeoutMs?: number;
}

type Waiter = (m: Json | null) => void;

/** The Windows route with toasts: an OsNotify, so DesktopNotifications uses it as it used the balloon (notify.ts use()). */
export class WindowsToasts implements OsNotify {
  readonly mechanism = 'windows-toast';
  #proc: ToastHelperProc | null = null;
  #state: 'off' | 'starting' | 'ready' | 'broken' = 'off';
  #starting: Promise<boolean> | null = null;
  #failures = 0;
  #seq = 0;
  #waiters = new Map<string, Waiter>();
  #ready: Waiter | null = null;
  #logged = new Set<string>();
  /** tag -> the chat and request (row signature) its toast is about */
  #shown = new Map<string, { chat: string; sig: string }>();

  constructor(readonly options: WindowsToastsOptions) {}

  get state(): string {
    return this.#state;
  }

  /** The tags of the toasts on screen or in the notification centre, with their chat (tests). */
  shown(): { tag: string; chat: string; sig: string }[] {
    return [...this.#shown].map(([tag, v]) => ({ tag, ...v }));
  }

  #once(why: string): void {
    if (this.#logged.has(why)) return;
    this.#logged.add(why);
    log.info('notifications: Windows toast route: %s; using the tray balloon for it', why);
  }

  /** Starts the helper (once; again after a crash, up to 3 times). Resolves true when it is ready. */
  start(): Promise<boolean> {
    if (this.#state === 'ready') return Promise.resolve(true);
    if (this.#state === 'broken') return Promise.resolve(false);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<boolean> {
    this.#state = 'starting';
    let proc: ToastHelperProc;
    try {
      proc = this.options.spawn((m) => this.#message(m), (why) => this.#exit(proc, why));
    } catch (error) {
      this.#fail(`the helper could not start (${error instanceof Error ? error.message : error})`);
      return false;
    }
    this.#proc = proc;
    const answer = await new Promise<Json | null>((resolve) => {
      this.#ready = resolve;
      setTimeout(() => resolve(null), (this.options.timeoutMs ?? 3000) * 2);
      proc.send({ op: 'register', ...this.options.register });
    });
    this.#ready = null;
    if (answer?.op === 'ready') {
      this.#state = 'ready';
      return true;
    }
    this.#fail(answer ? `the helper refused to register (${String(answer.error ?? answer.op)})` : 'the helper did not answer');
    try {
      proc.close();
    } catch { /* gone */ }
    if (this.#proc === proc) this.#proc = null;
    return false;
  }

  #fail(why: string): void {
    this.#failures++;
    this.#state = this.#failures >= 3 ? 'broken' : 'off';
    this.#once(why);
  }

  #exit(proc: ToastHelperProc, why: string): void {
    if (this.#proc !== proc) return;
    this.#proc = null;
    if (this.#state === 'ready') this.#fail(why);
    this.#ready?.(null);
    for (const w of this.#waiters.values()) w(null);
    this.#waiters.clear();
  }

  #message(m: Json): void {
    const op = m.op;
    if ((op === 'ready' || op === 'error') && this.#ready) return this.#ready(m);
    if ((op === 'shown' || op === 'failed') && typeof m.id === 'string') {
      const w = this.#waiters.get(m.id);
      this.#waiters.delete(m.id);
      return w?.(m);
    }
    if (op === 'activated') {
      const inputs: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(m.inputs))) if (typeof v === 'string') inputs[k.slice(0, 40)] = v.slice(0, 8000);
      try {
        this.options.onActivated({ args: typeof m.args === 'string' ? m.args : '', inputs });
      } catch (error) {
        log.info('notifications: toast click failed (%s)', error instanceof Error ? error.message : error);
      }
    }
  }

  async show(title: string, body: string, silent?: boolean, req?: NotifyRequest): Promise<ShowResult> {
    const quiet = quietReason(this.options.quietState());
    if (quiet) return { shown: false, reason: quiet };
    const balloon = () => this.options.balloon.show(title, body, silent, req);
    if (!(await this.start()) || !this.#proc) {
      if (this.#state === 'broken') this.#once('the helper is not available');
      return balloon();
    }
    const target = req?.target ?? null;
    const chat = target?.key ?? '';
    const row = chat ? this.options.rowOf(chat) : null;
    const acts = chat ? toastActs(row) : [];
    const sig = row ? (row.sig ?? INBOX.sigOf(row)) : '';
    const code = acts.some((a) => a !== 'open') ? this.options.codes.issue(chat, sig, acts) : '';
    const xml = toastXml(toastSpec({ title, body, target, silent }, row, code));
    const tag = chat ? toastTag(chat) : 'group';
    const id = String(++this.#seq);
    const proc = this.#proc;
    const answer = await new Promise<Json | null>((resolve) => {
      this.#waiters.set(id, resolve);
      setTimeout(() => {
        if (this.#waiters.delete(id)) resolve(null);
      }, this.options.timeoutMs ?? 3000);
      proc.send({ op: 'show', id, tag, group: TOAST_GROUP, xml });
    });
    if (answer?.op === 'shown') {
      if (chat) this.#shown.set(tag, { chat, sig });
      return { shown: true, code: 1 };
    }
    if (chat) this.options.codes.revokeChat(chat);
    this.#once(answer ? `Windows refused a toast (${String(answer.error ?? '')})` : 'the helper did not answer');
    return balloon();
  }

  onClick(fn: () => void): void {
    this.options.balloon.onClick?.(fn); // the fallback balloon's clicks (a toast's clicks come through onActivated)
  }

  /** Takes a chat's toast out of the notification centre and voids its codes. */
  remove(chat: string): void {
    const tag = toastTag(chat);
    this.options.codes.revokeChat(chat);
    if (!this.#shown.delete(tag)) return;
    this.#proc?.send({ op: 'remove', tag, group: TOAST_GROUP });
  }

  /** Every inbox built: a toast whose request was answered anywhere (its row is gone, or about a newer request) is removed. */
  seeInbox(inbox: { rows: InboxRow[] }): void {
    for (const [, v] of [...this.#shown]) {
      const row = inbox.rows.find((r) => r.key === v.chat);
      if (!row || (row.sig ?? INBOX.sigOf(row)) !== v.sig) this.remove(v.chat);
    }
  }

  close(): void {
    const proc = this.#proc;
    this.#proc = null;
    this.#state = 'broken';
    proc?.close();
  }
}
