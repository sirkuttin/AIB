/**
 * One transcript file read incrementally (monitor.Transcript): display events, background commands, plan-fold marks and card
 * metadata, re-read only when the file signature (size, mtime_ns) changes and resumed from the last offset while the file
 * still continues the bytes already read.
 */
import { isDict, pyStr, ValueError } from '../core/py.ts';
import {
  asMessage,
  BG_ID,
  contentText,
  CONTEXT_LIMIT,
  type Dict,
  type Event,
  FINISH_TEXT,
  finishedIds,
  IMAGE_LIMIT,
  imageBlock,
  type Json,
  type Mark,
  normalize,
  PLAN_TOOL,
  planMark,
  projectCwd,
  updateMetadata,
  WRAP_TOOL,
} from './normalize.ts';
import {
  b64decodeStrict,
  clipped,
  dget,
  digitsInt,
  hkey,
  lstrip,
  needStr,
  or,
  pySplit,
  PyTypeError,
  pyTypeName,
  S,
  truthy,
} from './pycompat.ts';
import { statSig } from './purepath.ts';
import { findtext, parseNotice } from './xml_notice.ts';

export const TERMINAL_STATUSES = ['completed', 'failed', 'killed', 'cancelled'];
// Claude Code tools that stop a background job, and the argument naming the job.
const STOP_TOOLS: Record<string, string> = { taskstop: 'task_id', killshell: 'shell_id', killbash: 'shell_id' };
// Claude Code tools that report on a background job; a terminal status they print for a known job is authoritative.
const POLL_TOOLS: Record<string, string> = { bashoutput: 'bash_id', taskoutput: 'task_id' };
const SHELL_TOOLS = ['bash', 'powershell', 'shell', 'exec_command', 'run_terminal_cmd', 'run_terminal_command', 'monitor'];
const READ_CHUNK = 4 << 20;
const YIELD_EVERY = 4000;

/** Serializes async work on one object (Python's per-transcript RLock). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}

const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type Task = Record<string, unknown>;

// Rows that are never displayed and carry nothing the page counts, recognised by the start of the raw line (json is not parsed).
// A snapshot may still carry a task-notification (see trackCommands), so those are always parsed.
const SKIP_ROW = /^[ \t\n\r\f\v]*\{[ \t\n\r\f\v]*"type"[ \t\n\r\f\v]*:[ \t\n\r\f\v]*"(api-request-blob|file-history-snapshot)"/;
const LATIN1 = new TextDecoder('latin1');
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const TASK_NOTIFICATION = new TextEncoder().encode('task-notification');

export function bytesInclude(line: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  let i = line.indexOf(first);
  while (i >= 0 && i + needle.length <= line.length) {
    let k = 1;
    while (k < needle.length && line[i + k] === needle[k]) k++;
    if (k === needle.length) return true;
    i = line.indexOf(first, i + 1);
  }
  return false;
}

/** True for a raw transcript line that normalize/updateMetadata/trackCommands would ignore entirely. */
export function skippableRow(line: Uint8Array): boolean {
  return SKIP_ROW.test(LATIN1.decode(line.subarray(0, 96))) && !bytesInclude(line, TASK_NOTIFICATION);
}

const isBlank = (line: Uint8Array) => line.every((b) => b === 32 || (b >= 9 && b <= 13));

/** json.loads(bytes): the value, or undefined where Python raises ValueError/UnicodeError. */
export function loadsBytes(line: Uint8Array): Json | undefined {
  try {
    return JSON.parse(UTF8.decode(line));
  } catch {
    return undefined;
  }
}

/** json.loads(str). */
export function loads(text: string): Json | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const STATUS_DONE = new RegExp(`<status>[${S}]*(completed|failed|killed|cancelled)[${S}]*</status>`, 'u');
const EXPIRES = new RegExp(`expires in[${S}]+((?:[\\p{Nd}]+[${S}]*[hms][${S}]*)+)`, 'u');
const DURATION_PART = new RegExp(`([\\p{Nd}]+)[${S}]*([hms])`, 'gu');
const MONITOR_STARTED = new RegExp(`^[${S}]*Monitor started \\(task[${S}]+([A-Za-z0-9_-]+)`, 'u');
const BACKGROUNDED = new RegExp(`^[${S}]*(?:Backgrounded as job|Command running in background with ID:)[${S}]*([A-Za-z0-9_-]+)`, 'iu');
const NOTICE = /<task-notification>[\s\S]*?<\/task-notification>/gu;

const toolNameOf = (task: Task) => pyStr(or(task.tool, '')).toLowerCase();

/** isinstance(details.get('jobs', []), ...) iteration: Python iterates a str by character and a dict by key. */
function iterate(value: Json): Json[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
}

export class Transcript {
  /** Refreshes that really read the file (a unit-test and timing probe; unchanged files do not count). */
  static parses = 0;

  readonly lock = new Mutex(); // one reader of this file at a time; other transcripts are not blocked
  offset = 0;
  number = 0;
  events: Event[] = [];
  planMarks: [number, Mark][] = []; // (index into events, mark) for the events planMark names
  thinkingAt: number[] = []; // indexes of 'thinking' events, to map a thinking-hidden position back
  flaggedCalls = new Set<string>();
  imageOffsets = new Map<number, number>(); // record number -> byte offset, for records that hold an image
  anchor: Uint8Array = new Uint8Array(0); // the last bytes before `offset`, to notice a file replaced under us
  meta: Dict = {};
  signature: [number, bigint] | null = null;
  /** call id (hkey) -> task; Python's dict keyed by the call id. */
  commands = new Map<string, Task>();
  jobCalls = new Map<string, Json>(); // str(job) -> call id
  stopCalls = new Map<string, string>();
  pollCalls = new Map<string, string>();
  endedIds = new Set<string>(); // ids a task-notification / TaskStop reported finished (an agent's id too)

  constructor(readonly path: string) {}

  #command(call: Json): Task | undefined {
    return this.commands.get(hkey(call));
  }

  #jobCommand(job: Json): Task | undefined {
    const call = typeof job === 'string' ? this.jobCalls.get(job) : undefined;
    return call === undefined ? this.commands.get(hkey(null)) : this.#command(call);
  }

  trackCommands(row: Dict): void {
    const msg = dget(row, 'message', row);
    if (!isDict(msg)) return;
    const stamp = or(dget(row, 'timestamp'), dget(msg, 'timestamp'));
    const content = dget(msg, 'content', []);
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    const role = dget(msg, 'role', dget(row, 'type'));
    // Raw API snapshots are inspected only for explicit task lifecycle records.
    const snapshots = row.type === 'api-request-blob';
    for (const block of blocks) {
      if (!isDict(block)) continue;
      const toolName = pyStr(dget(block, 'name', '')).toLowerCase();
      const isCall = block.type === 'toolCall' || block.type === 'tool_use';
      if (!snapshots && isCall && Object.hasOwn(STOP_TOOLS, toolName)) {
        const args = Object.hasOwn(block, 'input') ? block.input : dget(block, 'arguments', {});
        if (isDict(args) && truthy(dget(block, 'id')) && truthy(dget(args, STOP_TOOLS[toolName]))) {
          this.stopCalls.set(hkey(block.id), pyStr(args[STOP_TOOLS[toolName]]));
        }
      }
      if (!snapshots && isCall && Object.hasOwn(POLL_TOOLS, toolName)) {
        const args = Object.hasOwn(block, 'input') ? block.input : dget(block, 'arguments', {});
        if (isDict(args) && truthy(dget(block, 'id')) && truthy(dget(args, POLL_TOOLS[toolName]))) {
          this.pollCalls.set(hkey(block.id), pyStr(args[POLL_TOOLS[toolName]]));
        }
      }
      if (!snapshots && isCall && SHELL_TOOLS.includes(toolName)) {
        const args = Object.hasOwn(block, 'arguments') ? block.arguments : dget(block, 'input', {});
        if (!isDict(args)) continue;
        const call = dget(block, 'id');
        if (!truthy(call)) continue;
        const command = Object.hasOwn(args, 'command') ? args.command : dget(args, 'cmd', '');
        const fallback = Object.hasOwn(args, 'command') ? args.command : dget(args, 'cmd', 'Shell command');
        const timeout = dget(args, 'timeout_ms');
        const task: Task = {
          callId: call,
          tool: dget(block, 'name'),
          command: clipped(command),
          title: clipped(or(dget(args, 'description'), dget(block, 'intent'), dget(args, 'i'), fallback), 240),
          description: clipped(or(dget(args, 'description'), dget(block, 'intent'), dget(args, 'i'), ''), 240),
          started: stamp,
          ended: null,
          status: 'in-progress',
          background: truthy(or(dget(args, 'run_in_background'), dget(args, 'async'))) || toolName === 'monitor',
          output: '',
          jobId: null,
          durationMs: null,
          timeoutMs: typeof timeout === 'number' ? timeout : null,
          persistent: dget(args, 'persistent') === true,
        };
        const key = hkey(call);
        if (!this.commands.has(key)) this.commands.set(key, task);
      }
      if (!snapshots && (block.type === 'tool_result' || role === 'toolResult')) {
        const call = or(dget(block, 'tool_use_id'), dget(msg, 'toolCallId'));
        const failed = truthy(dget(block, 'is_error')) || truthy(dget(msg, 'isError'));
        const stopJob = this.stopCalls.get(hkey(call));
        if (stopJob && !failed) {
          let result = dget(row, 'toolUseResult');
          if (!isDict(result)) {
            const parsed = loads(contentText(dget(block, 'content', '')));
            result = parsed === undefined ? {} : parsed;
          }
          const stopped = this.#jobCommand(stopJob);
          const r = isDict(result) ? result : null;
          const named = r !== null && (stopJob === dget(r, 'task_id') || stopJob === dget(r, 'shell_id'));
          const message = r ? pyStr(dget(r, 'message', '')) : '';
          if (
            stopped && named &&
            (message.startsWith('Successfully stopped task: ' + stopJob) || message.startsWith('Successfully killed shell: ' + stopJob))
          ) {
            Object.assign(stopped, { status: 'killed', ended: stamp, completionSummary: clipped(r!.message, 500) });
          }
          if (r && stopJob === dget(r, 'task_id') && message.startsWith('Successfully stopped task')) this.endedIds.add(stopJob);
        }
        const isResultBlock = block.type === 'tool_result';
        const pollJob = this.pollCalls.get(hkey(call));
        if (pollJob && !failed) {
          const polled = this.#jobCommand(pollJob);
          const report = isResultBlock ? contentText(dget(block, 'content', '')) : contentText(dget(msg, 'content', []));
          const state = STATUS_DONE.exec(report);
          if (polled && state && (polled.status === 'running' || polled.status === 'in-progress')) {
            Object.assign(polled, { status: state[1], ended: stamp, completionSummary: 'Reported by a later output check' });
          }
        }
        const task = this.#command(call);
        if (task) {
          let details = or(dget(msg, 'details'), dget(row, 'toolUseResult'), {});
          details = isDict(details) ? details : {};
          const d = details as Dict;
          const output = isResultBlock ? contentText(dget(block, 'content', '')) : contentText(dget(msg, 'content', []));
          task.output = clipped(output);
          const monitor = toolNameOf(task) === 'monitor';
          if (monitor) {
            const stated = EXPIRES.exec(output);
            if (stated) {
              const units: Record<string, number> = { h: 3600, m: 60, s: 1 };
              let total = 0;
              for (const m of stated[1].matchAll(DURATION_PART)) total += digitsInt(m[1]) * units[m[2]];
              task.expirySeconds = total;
            }
            if (typeof task.expirySeconds !== 'number' && typeof task.timeoutMs === 'number' && task.timeoutMs > 0) {
              task.expirySeconds = task.timeoutMs / 1000;
            }
          }
          let asyncInfo = dget(d, 'async', {});
          asyncInfo = isDict(asyncInfo) ? asyncInfo : {};
          const a = asyncInfo as Dict;
          if (typeof dget(d, 'timeoutSeconds') === 'number') task.timeoutSeconds = d.timeoutSeconds;
          let job = or(dget(d, 'backgroundTaskId'), dget(a, 'jobId'));
          if (!truthy(job) && monitor) {
            // A Monitor watch: "Monitor started (task <id>, expires in ...". It ends with a task-notification.
            const match = MONITOR_STARTED.exec(output);
            job = match ? match[1] : null;
          }
          if (!truthy(job)) {
            // Only the tool's own opening line counts; a command that merely printed this text must not become a "running" job.
            const match = BACKGROUNDED.exec(output);
            const lead = lstrip(output);
            if (
              match &&
              (truthy(task.background) || lead.startsWith('Command running in background') || lead.startsWith('Backgrounded as job'))
            ) {
              job = match[1];
            }
          }
          if (truthy(job)) {
            const state = dget(a, 'state');
            const immediate = TERMINAL_STATUSES.includes(state as string) ? state : null;
            Object.assign(task, { jobId: job, background: true, status: or(immediate, 'running') });
            if (truthy(immediate) && !truthy(task.ended)) task.ended = stamp;
            this.jobCalls.set(pyStr(job), call);
          } else {
            Object.assign(task, {
              status: failed ? 'failed' : 'completed',
              ended: stamp,
              durationMs: dget(d, 'wallTimeMs'),
              exitCode: dget(d, 'exitCode'),
            });
          }
        }
      }
      const raw = or(dget(block, 'text'), typeof dget(block, 'content') === 'string' ? block.content : '', '');
      this.applyNotifications(needStr(raw), stamp);
    }
    // Claude Code also stores notifications outside message blocks: queue records and queued-command attachments.
    if (typeof row.content === 'string' && row.type === 'queue-operation') this.applyNotifications(row.content, stamp);
    const attachment = dget(row, 'attachment');
    if (isDict(attachment) && attachment.type === 'queued_command') {
      const prompt = dget(attachment, 'prompt');
      this.applyNotifications(typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? contentText(prompt) : '', stamp);
    }
    const details = dget(row, 'details', {});
    if (row.customType === 'async-result' && isDict(details)) {
      for (const job of iterate(dget(details, 'jobs', []))) {
        if (!isDict(job)) continue;
        const task = this.#jobCommand(pyStr(dget(job, 'jobId')));
        const status = dget(job, 'status');
        if (task && ['completed', 'failed', 'cancelled', 'killed'].includes(status as string)) {
          Object.assign(task, { status, ended: stamp, durationMs: dget(job, 'durationMs'), output: clipped(contentText(content)) });
        }
      }
    }
  }

  applyNotifications(raw: string, stamp: Json): void {
    for (const match of raw.matchAll(NOTICE)) {
      const notice = parseNotice(match[0]);
      if (notice === null) continue;
      const said = findtext(notice.children, 'status');
      const status = said === 'stopped' ? 'killed' : said === 'canceled' ? 'cancelled' : said;
      if (status === null || !(TERMINAL_STATUSES.includes(status) || status === 'running')) continue;
      const jobs = notice.children.filter((c) => c.tag === 'task-id' && c.text).map((c) => c.text as string);
      if (TERMINAL_STATUSES.includes(status)) { for (const job of jobs) this.endedIds.add(job); }
      for (const job of jobs.length ? jobs : [null]) {
        const call = jobs.length <= 1 ? findtext(notice.children, 'tool-use-id') : null;
        const task = this.#command(call) ?? (job === null ? this.commands.get(hkey(null)) : this.#jobCommand(job));
        if (!task) continue;
        if (status === 'running' && TERMINAL_STATUSES.includes(task.status as string)) continue; // a replayed record must not revive a job
        Object.assign(task, {
          status,
          background: true,
          jobId: or(job, dget(task, 'jobId')),
          completionSummary: clipped(or(findtext(notice.children, 'summary'), ''), 500),
        });
        if (status !== 'running' && !truthy(dget(task, 'ended'))) task.ended = stamp;
      }
    }
  }

  refresh(): Promise<this> {
    return this.lock.run(() => this.#refresh());
  }

  #reset(): void {
    this.offset = 0;
    this.number = 0;
    this.events = [];
    this.meta = {};
    this.imageOffsets = new Map();
    this.anchor = new Uint8Array(0);
    this.commands = new Map();
    this.jobCalls = new Map();
    this.stopCalls = new Map();
    this.pollCalls = new Map();
    this.endedIds = new Set();
    this.planMarks = [];
    this.thinkingAt = [];
    this.flaggedCalls = new Set();
  }

  /** One record (a whole line); returns false to stop reading (an unfinished last record). */
  #line(line: Uint8Array, start: number, end: number, whole: boolean): boolean {
    let row: Json | undefined;
    if (!whole) {
      // A writer can still be appending this record; a last record that is already whole JSON is complete.
      row = loadsBytes(line);
      if (!isDict(row)) return false;
    }
    this.offset = end;
    if (isBlank(line)) return true; // blank separator between records: not a record
    this.number += 1;
    if (skippableRow(line)) return true;
    if (row === undefined) row = loadsBytes(line);
    if (!isDict(row)) return true;
    updateMetadata(this.meta, row);
    this.trackCommands(row);
    const found = normalize(row, this.number);
    if (found.some((event) => Object.hasOwn(event, 'images'))) this.imageOffsets.set(this.number, start);
    for (const event of found) {
      if (event.kind === 'thinking') this.thinkingAt.push(this.events.length);
      else {
        const mark = planMark(event, this.flaggedCalls);
        if (mark) this.planMarks.push([this.events.length, mark]);
      }
      this.events.push(event);
    }
    return true;
  }

  async #refresh(): Promise<this> {
    const stat = await statSig(this.path);
    if (this.signature && this.signature[0] === stat.size && this.signature[1] === stat.mtimeNs) return this;
    Transcript.parses += 1;
    const file = await Deno.open(this.path, { read: true });
    try {
      // Start over when the file shrank, was rewritten in place, or no longer continues the bytes already read
      // (a larger replacement would otherwise be resumed in the middle of a line and lose a record).
      if (stat.size < this.offset || (this.signature && stat.size === this.offset) || !(await this.#continues(file))) this.#reset();
      await file.seek(this.offset, Deno.SeekMode.Start);
      let carry = new Uint8Array(0);
      let position = this.offset; // file position of carry[0]
      let lines = 0;
      let stop = false;
      const buffer = new Uint8Array(READ_CHUNK);
      for (;;) {
        const n = await file.read(buffer);
        if (n === null || n === 0) break;
        const data = carry.length ? concatBytes(carry, buffer.subarray(0, n)) : buffer.slice(0, n);
        let from = 0;
        for (;;) {
          const nl = data.indexOf(10, from);
          if (nl < 0) break;
          const line = data.subarray(from, nl + 1);
          if (!this.#line(line, position + from, position + nl + 1, true)) {
            stop = true;
            break;
          }
          from = nl + 1;
          if (++lines % YIELD_EVERY === 0) await yieldNow();
        }
        if (stop) break;
        carry = data.slice(from);
        position += from;
      }
      if (!stop && carry.length) this.#line(carry, position, position + carry.length, false);
    } finally {
      file.close();
    }
    if (truthy(this.meta._cwds)) this.meta.cwd = projectCwd(this.meta, this.path);
    const tail = await Deno.open(this.path, { read: true });
    try {
      await tail.seek(Math.max(0, this.offset - 64), Deno.SeekMode.Start);
      this.anchor = await readExactly(tail, Math.min(64, this.offset));
    } finally {
      tail.close();
    }
    this.signature = [stat.size, stat.mtimeNs];
    return this;
  }

  /** True while the bytes just before the read offset are still the ones already parsed. */
  async #continues(file: Deno.FsFile): Promise<boolean> {
    if (!this.offset) return true;
    await file.seek(Math.max(0, this.offset - this.anchor.length), Deno.SeekMode.Start);
    const bytes = await readExactly(file, this.anchor.length);
    return bytes.length === this.anchor.length && bytes.every((b, i) => b === this.anchor[i]);
  }

  /**
   * The older events the page's plan fold needs for a page of events that begins at position `start` (among the events the page
   * sees: without 'thinking' ones when thinkingHidden): the turn holding the latest plan-setting update_plan with its patches,
   * wrap-ups, background launches, finishes and user boundaries, plus earlier launches still running then. Copies marked ctx.
   */
  planContext(start: number, thinkingHidden = false): Event[] {
    let full = start;
    if (thinkingHidden) {
      for (;;) { // position among visible events -> position among all events
        const next = start + bisectRight(this.thinkingAt, full);
        if (next === full) break;
        full = next;
      }
    }
    const marks = this.planMarks.slice(0, bisectLeftPairs(this.planMarks, full));
    if (!marks.length) return [];
    let lastSet = -1;
    marks.forEach(([, mark], i) => mark === 'set' && (lastSet = i));
    let q: number;
    if (lastSet >= 0) {
      q = lastSet; // start of the turn holding it: the user message before it
      while (q > 0 && marks[q][1] !== 'user') q--;
    } else q = marks.length;
    // Background launches before that turn that are still running by then.
    const openAt = new Map<string, number>();
    for (const [index, mark] of marks.slice(0, q)) {
      if (mark !== 'launch' && mark !== 'finish' && mark !== 'user') continue;
      const event = this.events[index];
      const text = or(event.text, '') as string;
      if (mark === 'launch' && event.kind !== 'tool') {
        const found = BG_ID.exec(text);
        if (found) openAt.set(found[1] ?? found[2], index);
      }
      for (const job of mark !== 'launch' ? finishedIds(text) : []) openAt.delete(job);
      if (event.kind === 'task-done') { for (const job of pySplit(text)) openAt.delete(job); }
    }
    const chosen = [...new Set([...openAt.values(), ...marks.slice(q).map(([i]) => i)])].sort((a, b) => a - b).slice(-CONTEXT_LIMIT);
    return chosen.map((index) => {
      const event: Event = { ...this.events[index], ctx: true };
      const label = pyStr(event.label);
      if (
        event.kind === 'tool' && truthy(event.id) && (or(event.text, '') as string).includes('run_in_background') &&
        !PLAN_TOOL.test(label) &&
        !WRAP_TOOL.test(label)
      ) {
        event.text = '{"run_in_background": true}'; // the command itself is not needed
      }
      if (event.kind === 'user' && !FINISH_TEXT.test(or(event.text, '') as string)) event.text = '';
      return event;
    });
  }

  /** [media type, bytes] of image block `index` in record `number`; ValueError if there is none. */
  async image(number: number, index: number, sub: number | null = null): Promise<[string, Uint8Array]> {
    const start = this.imageOffsets.get(number);
    if (start === undefined) throw new ValueError('Unknown image');
    const file = await Deno.open(this.path, { read: true });
    let line: Uint8Array;
    try {
      await file.seek(start, Deno.SeekMode.Start);
      line = await readLine(file);
    } finally {
      file.close();
    }
    let row = loadsBytes(line);
    if (row === undefined) throw new ValueError('Expecting value: line 1 column 1 (char 0)');
    row = isDict(row) ? asMessage(row) : row;
    const msg = isDict(row) ? dget(row, 'message', row) : {};
    const content = isDict(msg) ? dget(msg, 'content') : null;
    if (!Array.isArray(content) || !(index >= 0 && index < content.length) || !isDict(content[index])) {
      throw new ValueError('Unknown image');
    }
    let block = content[index] as Dict;
    if (sub !== null) { // a picture inside a tool_result block's own content list
      const inner = block.type === 'tool_result' ? dget(block, 'content') : null;
      if (!Array.isArray(inner) || !(sub >= 0 && sub < inner.length) || !isDict(inner[sub])) throw new ValueError('Unknown image');
      block = inner[sub] as Dict;
    }
    const [media, data] = imageBlock(block);
    if (!media) throw new ValueError('Unknown image');
    const raw = b64decodeStrict(data!);
    if (raw.length > IMAGE_LIMIT) throw new ValueError('Image too large');
    return [media, raw];
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export async function readExactly(file: Deno.FsFile, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const r = await file.read(out.subarray(got));
    if (r === null || r === 0) break;
    got += r;
  }
  return out.subarray(0, got);
}

/** f.read(): the rest of the file. */
export async function readToEnd(file: Deno.FsFile): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const buffer = new Uint8Array(1 << 16);
  for (;;) {
    const n = await file.read(buffer);
    if (n === null || n === 0) break;
    parts.push(buffer.slice(0, n));
    total += n;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** stream.readline() in binary mode: up to and including the next b'\n'. */
async function readLine(file: Deno.FsFile): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const buffer = new Uint8Array(1 << 16);
  for (;;) {
    const n = await file.read(buffer);
    if (n === null || n === 0) break;
    const nl = buffer.subarray(0, n).indexOf(10);
    if (nl >= 0) {
      parts.push(buffer.slice(0, nl + 1));
      break;
    }
    parts.push(buffer.slice(0, n));
  }
  return parts.reduce((a, b) => concatBytes(a, b), new Uint8Array(0));
}

function bisectRight(list: number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value < list[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** bisect_left(marks, (full, '')): the number of marks whose index is below `full`. */
function bisectLeftPairs(list: [number, Mark][], full: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] < full) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
