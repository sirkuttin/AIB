/**
 * Local, read-only OMP and Claude Code transcript viewer (monitor.py): the data layer and the GET handlers as plain functions.
 * The web server (server/web/) authorizes each request with ROUTES and security.authorize, then calls handleGet() and writes
 * the reply (JSON bodies may hold JSON.rawJSON values: the transcript revision's nanosecond mtime does not fit a double).
 *
 * Split by concern: normalize.ts (records -> events, titles, metadata), transcript.ts (one file read incrementally),
 * store.ts (folders, cards, agents, cache, model in use), pycompat.ts / purepath.ts / xml_notice.ts (Python behaviour).
 */
import { pyStr, pyStrip, ValueError } from '../core/py.ts';
import { RouteTable, SCOPE_IMAGE, SCOPE_READ } from '../web/security.ts';
import { type Dict, type Event, type Json, TEXT_LIMIT } from './normalize.ts';
import { casefold, clipped, concat, isOSError, isoTimestamp, parseQs, pyInt, PyTypeError, strCmp, truthy } from './pycompat.ts';
import { isDir, isFile, isRelativeTo, join, name, purePath, resolveLoose, rglobTail, statSig, stem, withoutSuffix } from './purepath.ts';
import { wslSavedSessionsQuick, wslTranscriptGet } from '../wsl/transcripts.ts';
import { type KeptLine, placeLines } from '../history/lines.ts';
import { Catalog, COMMAND_LIST_TTL, now, QUIET_UNKNOWN_SECONDS, type Resolved, type Source, Store } from './store.ts';
import { Mutex, readExactly, type Task, type Transcript } from './transcript.ts';

export * from './normalize.ts';
export * from './store.ts';
export { skippableRow, TERMINAL_STATUSES, Transcript } from './transcript.ts';
export type { Task } from './transcript.ts';

const RUNNING = ['running', 'in-progress'];
const toolNameOf = (task: Task) => pyStr(truthy(task.tool) ? task.tool : '').toLowerCase();

/** (path, size, mtime) of the chat's transcript and every sub-agent transcript: what commandList's answer depends on. */
async function familySignature(source: Source, session: Json): Promise<string> {
  const { store, path } = await source.resolve(session);
  const folder = withoutSuffix(path);
  const paths = [path];
  if (await isDir(folder)) {
    const real = await resolveLoose(folder);
    if (isRelativeTo(real, store.root)) paths.push(...(await rglobTail(folder, '.jsonl')).sort());
  }
  const out: string[] = [];
  for (const p of paths) {
    try {
      const st = await statSig(p);
      out.push(`${p}\u0000${st.size}\u0000${st.mtimeNs}`);
    } catch (error) {
      if (!isOSError(error)) throw error;
    }
  }
  return out.join('\u0001');
}

/** Background commands of a chat and its sub-agents. Built once and reused while no transcript file changed (and for at most
 * COMMAND_LIST_TTL seconds, since idle times are clock based), so /api/agents and /api/commands in one poll share one pass. */
export async function commandList(source: Source, session: Json): Promise<Task[]> {
  const key = typeof session === 'string' ? session : JSON.stringify(session);
  // A request that arrives while another builds this chat's list shares that run (the page polls /api/agents and /api/commands
  // together, and several views poll at once): re-checking a big family's files costs hundreds of stats per request.
  const running = inFlight.get(source)?.get(key);
  if (running) return [...(await running)];
  let lock = source.commandLocks.get(key);
  if (!lock) source.commandLocks.set(key, lock = new Mutex());
  if (source.commandLocks.size > 64) {
    source.commandLocks.clear();
    source.commandMemo.clear();
  }
  let runs = inFlight.get(source);
  if (!runs) inFlight.set(source, runs = new Map());
  const run = lock.run(async () => {
    const signature = await familySignature(source, session);
    const memo = source.commandMemo.get(key);
    if (memo && memo[0] === signature && now() - memo[1] < COMMAND_LIST_TTL) return memo[2];
    const tasks = await buildCommandList(source, session);
    source.commandMemo.set(key, [signature, now(), tasks]);
    return tasks;
  });
  runs.set(key, run);
  try {
    return [...(await run)];
  } finally {
    if (runs.get(key) === run) runs.delete(key);
  }
}

const inFlight = new WeakMap<Source, Map<string, Promise<Task[]>>>();

/** How long a page request waits for commandList before it is answered from what is already known (COMMAND_QUICK_MS). */
export let COMMAND_QUICK_MS = 250;
export function setCommandQuickMs(ms: number): void {
  COMMAND_QUICK_MS = ms;
}

/**
 * commandList for the page's polls (/api/commands, /api/agents' running counts), never kept waiting: the first build of a chat
 * with a big family reads every subagent transcript (hundreds of MB for a long lead chat: seconds, half a minute while the PC is
 * busy) and the page's poll waited for it, history and all. Waits at most COMMAND_QUICK_MS for the current list; past that it
 * answers with the last list built for this chat (`stale`) or none yet (`pending`), and the build goes on behind it, so the next
 * poll gets it. Errors that come back within the wait (an unknown chat) still throw.
 */
export async function commandListQuick(
  source: Source,
  session: Json,
  waitMs = COMMAND_QUICK_MS,
): Promise<{ tasks: Task[]; pending: boolean; stale: boolean }> {
  const key = typeof session === 'string' ? session : JSON.stringify(session);
  const known = source.commandMemo.get(key);
  const build = commandList(source, session);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
  try {
    const done = await Promise.race([build, late]);
    if (done) return { tasks: done, pending: false, stale: false };
  } finally {
    clearTimeout(timer);
  }
  build.catch(() => {}); // still building: a later error is the next poll's
  return known ? { tasks: [...known[2]], pending: false, stale: true } : { tasks: [], pending: true, stale: false };
}

function startedAt(task: Task): number {
  return isoTimestamp(pyStr(task.started).replaceAll('Z', '+00:00'));
}

async function buildCommandList(source: Source, session: Json): Promise<Task[]> {
  const tasks: Task[] = [];
  const t0 = now();
  const agents = await source.agents(session);
  await source.hold(agents.map((a) => a.key as string), async () => {
    // Ids the main chat saw finish or stop (a background agent's task-notification, TaskStop): their own tasks ended with them.
    let reported = new Set<string>();
    for (const agent of agents) {
      if (truthy(agent.main)) {
        const main = await loadKey(source, agent.key);
        reported = await main.lock.run(() => new Set(main.endedIds));
      }
    }
    for (const agent of agents) {
      const transcript = await loadKey(source, agent.key);
      const modified = Object.hasOwn(agent, 'modified') ? agent.modified as number : t0;
      const idle = Math.max(0, t0 - modified);
      const ownerDone = !truthy(agent.main) && Boolean(
        agent.finished === true || truthy(agent.completedMarker) || truthy(agent.failed) ||
          (typeof agent.agentId === 'string' && reported.has(agent.agentId)) || idle > QUIET_UNKNOWN_SECONDS,
      );
      const commands = await transcript.lock.run(() => [...transcript.commands.values()]);
      for (const original of commands) {
        const task: Task = {
          ...original,
          id: concat((agent.key as string) + '#', original.callId),
          agent: agent.name,
          agentKey: agent.key,
          source: 'saved',
          inferred: true,
          transcriptIdleSeconds: Math.trunc(idle),
        };
        if (!truthy(task.background)) continue;
        if (RUNNING.includes(task.status as string) && truthy(task.started)) {
          try {
            const age = t0 - startedAt(task);
            const timeout = task.timeoutSeconds;
            let expiry = task.expirySeconds as Json;
            const monitor = toolNameOf(task) === 'monitor';
            if (monitor) {
              expiry = typeof expiry === 'number' && expiry > 0 ? Math.min(expiry, 86400) : truthy(task.persistent) ? 86400 : null;
            }
            if (ownerDone) {
              task.status = 'completed';
              task.completionSummary = truthy(task.completionSummary) ? task.completionSummary : 'Ended with the agent that started it.';
            } else if (monitor && truthy(expiry) && age > (expiry as number)) {
              task.status = 'completed';
              task.completionSummary = truthy(task.completionSummary) ? task.completionSummary : 'Ended: its watch time ran out.';
            } else if (age > 86400) {
              task.status = 'unknown';
              task.completionSummary = truthy(task.completionSummary)
                ? task.completionSummary
                : 'Status unknown: no completion was saved for over a day.';
            } else if (age > QUIET_UNKNOWN_SECONDS && idle > QUIET_UNKNOWN_SECONDS) {
              // Nothing was saved by this agent for hours and no completion arrived: do not claim it still runs or that it ended.
              task.status = 'unknown';
              task.completionSummary = truthy(task.completionSummary)
                ? task.completionSummary
                : 'Status unknown: the conversation has been quiet for hours and no completion was saved.';
            } else if (typeof timeout === 'number' && timeout > 0 && age > timeout + 60) {
              // The agent said it would stop this job at its deadline; no completion record was saved.
              task.status = 'unknown';
              task.completionSummary = truthy(task.completionSummary)
                ? task.completionSummary
                : 'Probably ended: its time limit passed and no completion was saved.';
            }
          } catch (error) {
            if (!(error instanceof ValueError)) throw error;
          }
        }
        tasks.push(task);
      }
    }
  });
  const keyed = tasks.map((t) =>
    [!RUNNING.includes(t.status as string), -(truthy(t.started) ? startedAt(t) : 0), t.id as string, t] as const
  );
  keyed.sort((a, b) => Number(a[0]) - Number(b[0]) || a[1] - b[1] || strCmp(a[2], b[2]));
  return keyed.map((k) => k[3]);
}

function loadKey(source: Source, key: Json): Promise<Transcript> {
  return source.resolve(key).then((resolved: Resolved) => resolved.store.load(resolved.path));
}

/** {agent key: number of background commands still reported running} for one conversation. */
export async function runningByAgent(source: Source, session: Json, quick = false): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const task of quick ? (await commandListQuick(source, session)).tasks : await commandList(source, session)) {
    if (RUNNING.includes(task.status as string)) counts[task.agentKey as string] = (counts[task.agentKey as string] ?? 0) + 1;
  }
  return counts;
}

/** tempfile.gettempdir(): TMPDIR, TEMP or TMP, else the platform's usual folder. */
export function tempDir(): string {
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  if (Deno.build.os === 'windows') {
    const local = Deno.env.get('LOCALAPPDATA');
    return local ? join(local, 'Temp') : 'C:\\Temp';
  }
  return '/tmp';
}

/**
 * Read only a known Claude task output location, never a transcript-supplied path. `folders`: the names under `tmp` Claude Code
 * keeps its task folders in, tried in order ('claude' on Windows; Linux Claude Code uses `claude-<uid>`, see wsl/helper/bgtasks.ts).
 */
export async function commandOutput(session: string, task: Task, tmp = tempDir(), folders: readonly string[] = ['claude']): Promise<string> {
  let output = (Object.hasOwn(task, 'output') ? task.output : '') as Json;
  for (const folder of folders) {
    const found = await taskOutput(session, task, tmp, folder);
    if (found !== null) {
      output = found;
      break;
    }
  }
  return clipped(output);
}

async function taskOutput(session: string, task: Task, tmp: string, folder: string): Promise<string | null> {
  let output: string | null = null;
  if (session.startsWith('claude/') && /^[A-Za-z0-9_-]+$/.test(pyStr(truthy(task.jobId) ? task.jobId : ''))) {
    const relative = purePath(session.split('/').slice(1).join('/'), false);
    if (relative.parts.length + (relative.root ? 1 : 0) === 2) {
      const base = await resolveLoose(join(tmp, folder));
      const candidate = join(base, relative.parts[0], stem(name(relative.parts[1])), 'tasks', concat('', task.jobId) + '.output');
      const resolved = await resolveLoose(candidate);
      if (isRelativeTo(resolved, base) && (await isFile(resolved))) {
        const file = await Deno.open(resolved, { read: true });
        try {
          const size = (await file.stat()).size;
          await file.seek(Math.max(0, size - 65536), Deno.SeekMode.Start);
          const tail = new TextDecoder('utf-8').decode(await readExactly(file, 65536));
          output = tail
            ? '[Latest task output; earlier output omitted when large]\n' + [...tail].slice(-(TEXT_LIMIT - 100)).join('')
            : 'No task output has been written yet.';
        } finally {
          file.close();
        }
      }
    }
  }
  return output;
}

// Every route this server answers and the scope it needs (see security.authorize). Unknown /api/ routes are refused.
// The chat page's reads of saved transcripts. (The separate monitor page and its files, /api/bootstrap and /api/activity are gone.)
export const ROUTES = new RouteTable();
ROUTES.add('GET', '/api/transcript/image', SCOPE_IMAGE);
for (const path of ['/api/sessions', '/api/agents', '/api/commands', '/api/command', '/api/transcript']) {
  ROUTES.add('GET', path, SCOPE_READ);
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export interface Reply {
  status: number;
  /** A JSON value (may contain JSON.rawJSON numbers) or raw bytes. */
  body: unknown;
  contentType: string;
}

export interface HandlerOptions {
  /** Where Claude Code writes background task output (tempfile.gettempdir()). */
  tempDir?: string;
  /** AIB's own lines of a conversation (history/lines.ts: turn ends, AIB notes), merged into its saved transcript's pages. */
  keptLines?: (provider: string, sessionId: string) => KeptLine[];
  /**
   * Why a chat's commands stopped for good (by transcript key): '' when they did not. AIB ended a finished helper's chat, so its saved
   * transcript never says its background commands ended: they read as stopped ("stopped: helper finished"), never as running.
   */
  stoppedWhy?: (key: string) => string;
  /**
   * Why AIB shut down the processes of one call (by its tool_use_id): '' when it did not. A finished subagent's leftovers are killed by
   * their shell cookie (subagents/reap.ts), so the rows of those calls read "stopped: subagent finished", never "ended" or running.
   */
  stoppedCall?: (callId: string) => string;
}

/** The commands of a chat AIB stopped (HandlerOptions.stoppedWhy): running or unknown ones become `killed` with the reason. */
function withStopped(tasks: Task[], options: HandlerOptions): Task[] {
  if (!options.stoppedWhy && !options.stoppedCall) return tasks;
  const why = new Map<string, string>();
  return tasks.map((task) => {
    const call = options.stoppedCall && typeof task.callId === 'string' ? options.stoppedCall(task.callId) : '';
    // a call AIB shut down the processes of: its row reads that, whatever else the saved transcript made of it ("ended with the agent")
    if (call && task.status !== 'failed') return { ...task, status: 'killed', stoppedReason: call, completionSummary: `Stopped: ${call}.` };
    if (!options.stoppedWhy) return task;
    if (!RUNNING.includes(task.status as string) && task.status !== 'unknown') return task;
    const key = typeof task.agentKey === 'string' ? task.agentKey : '';
    if (!why.has(key)) why.set(key, key ? options.stoppedWhy!(key) : '');
    const reason = why.get(key)!;
    return reason
      ? { ...task, status: 'killed', stoppedReason: reason, completionSummary: `Stopped: ${reason}.` }
      : task;
  });
}

/** JSON.rawJSON (V8): a number written with exactly these digits (a nanosecond mtime exceeds a double's precision). */
const rawJson = (text: string): unknown => (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(text);

/** AIB's kept lines of a saved chat's transcript (provider: the key's first part; session: the transcript's own id). A subagent's
 * transcript (it carries its parent's session id) has none. */
function keptOf(options: HandlerOptions, key: string, transcript: Transcript): KeptLine[] {
  if (!options.keptLines) return [];
  const meta = transcript.meta;
  if (truthy(meta.agentId) || typeof meta.id !== 'string' || !meta.id) return [];
  const provider = key.split('/')[0] ?? '';
  try {
    return options.keptLines(provider, meta.id);
  } catch {
    return [];
  }
}

/**
 * The transcript page reply (monitor.py's /api/transcript), events filtered and paged. `kept`: AIB's own lines of this
 * conversation (history/lines.ts); without a search or kind filter the reply carries `lines`, the ones placed in this page:
 * {n, at, kind, data, time}, `at` the index (as `before` / `end` count) of the event each goes before, before < at <= end, so
 * the pages of one transcript carry each line once (a line after the last event comes with the newest page).
 */
export async function transcriptPage(
  transcript: Transcript,
  arg: (name: string, fallback?: string) => string,
  kept: KeptLine[] = [],
): Promise<Dict> {
  return await transcript.lock.run(() => {
    let events: Event[] = transcript.events;
    const query = pyStrip(casefold(arg('q')));
    if (query) {
      events = events.filter((e) =>
        casefold(
          concat(
            concat(concat(concat(Object.hasOwn(e, 'text') ? e.text as string : '', ' '), Object.hasOwn(e, 'label') ? e.label : ''), ' '),
            Object.hasOwn(e, 'intent') ? e.intent : '',
          ),
        ).includes(query)
      );
    }
    if (arg('thinking') !== '1') events = events.filter((e) => e.kind !== 'thinking');
    const kind = arg('kind');
    if (kind === 'tools') events = events.filter((e) => ['tool', 'result', 'error'].includes(e.kind as string));
    else if (kind === 'messages') events = events.filter((e) => !['tool', 'result', 'error', 'thinking'].includes(e.kind as string));
    else if (kind === 'errors') events = events.filter((e) => e.kind === 'error');
    const limit = Math.min(500, Math.max(1, pyInt(arg('limit', '120'))));
    let start: number;
    let end: number;
    if (arg('after') !== '') {
      // Forward cursor: events after an index the client already holds.
      start = Math.min(events.length, Math.max(0, pyInt(arg('after'))));
      end = Math.min(events.length, start + limit);
    } else {
      end = Math.min(events.length, Math.max(0, pyInt(arg('before', String(events.length)))));
      start = Math.max(0, end - limit);
    }
    const signature = transcript.signature!;
    const reply: Dict = {
      events: events.slice(start, end),
      total: events.length,
      before: start,
      end,
      revision: [signature[0], rawJson(String(signature[1]))],
      meta: { ...transcript.meta },
    };
    if (arg('after') === '' && !query && !kind && start > 0) {
      // What the plan card and "N running tasks" fold needs from before this page; not for display.
      reply.context = transcript.planContext(start, arg('thinking') !== '1');
    }
    if (kept.length && !query && !kind) {
      reply.lines = placeLines(events, kept)
        .filter((l) => l.at > start && l.at <= end)
        .map((l) => ({ n: l.n, at: l.at, kind: l.kind, data: l.data, time: l.time }));
    }
    return reply;
  });
}

/**
 * One GET request of the viewer, after authorization: `path` without the query, `query` the raw query string (no '?').
 * Errors Python answers with 400 (ValueError, TypeError, OSError) come back as {status: 400, body: {error}}; others throw.
 */
export async function handleGet(source: Source, path: string, query: string, options: HandlerOptions = {}): Promise<Reply> {
  const json = (status: number, body: unknown): Reply => ({ status, body, contentType: JSON_TYPE });
  const args = parseQs(query);
  const arg = (key: string, fallback = '') => args.get(key)?.[0] ?? fallback;
  try {
    const wsl = await wslTranscriptGet(path, args); // a saved session of a WSL project: read in its distro
    if (wsl) return json(wsl.status, wsl.body);
    if (path === '/api/sessions') {
      // saved chats of WSL projects, read in their distro (wsl/transcripts.ts); none until a distro's helper lists them. Both at once.
      const [sessions, wsl] = await Promise.all([source.sessions(), wslSavedSessionsQuick()]);
      if (wsl.length) sessions.push(...wsl);
      return json(200, { sessions, root: source.root, now: now() });
    }
    if (path === '/api/agents') {
      const agents = await source.agents(arg('session'));
      let running: Record<string, number> = {};
      try {
        running = await runningByAgent(source, arg('session'), true); // never waits long for the commands (commandListQuick)
      } catch (error) {
        if (!(isOSError(error) || error instanceof ValueError || error instanceof PyTypeError)) throw error;
      }
      for (const agent of agents) agent.runningCommands = running[agent.key as string] ?? 0;
      return json(200, { agents, now: now() });
    }
    if (path === '/api/commands') {
      const quick = await commandListQuick(source, arg('session'));
      let commands = withStopped(quick.tasks, options);
      const running = commands.filter((t) => RUNNING.includes(t.status as string)).length;
      if (arg('running') === '1') commands = commands.filter((t) => RUNNING.includes(t.status as string));
      const shown = commands.slice(0, 200).map((task) =>
        Object.fromEntries(Object.entries(task).filter(([k]) => k !== 'output' && k !== 'command'))
      );
      // pending: the first list of this chat is still being read (none to show yet); stale: the last one, a newer is being read
      return json(200, { commands: shown, running, total: commands.length, ...(quick.pending ? { pending: true } : {}), ...(quick.stale ? { stale: true } : {}) });
    }
    if (path === '/api/command') {
      const commands = withStopped(await commandList(source, arg('session')), options);
      const task = commands.find((t) => t.id === arg('id'));
      if (task === undefined) throw new ValueError('Unknown background command');
      return json(200, { ...task, output: await commandOutput(arg('session'), task, options.tempDir) });
    }
    if (path === '/api/transcript/image') {
      const transcript = await loadKey(source, arg('key'));
      const [media, raw] = await transcript.lock.run(() =>
        transcript.image(pyInt(arg('n')), pyInt(arg('i')), arg('j') !== '' ? pyInt(arg('j')) : null)
      );
      return { status: 200, body: raw, contentType: media };
    }
    if (path === '/api/transcript') {
      const transcript = await loadKey(source, arg('key'));
      return json(200, await transcriptPage(transcript, arg, keptOf(options, arg('key'), transcript)));
    }
    return json(404, { error: 'Not found' });
  } catch (error) {
    if (isOSError(error) || error instanceof ValueError || error instanceof PyTypeError) {
      return json(400, { error: (error as Error).message });
    }
    throw error;
  }
}

/** A viewer over OMP and/or Claude Code roots (monitor.create_server's store): a Catalog with a Claude root, else a Store. */
export async function openSource(root: string | null, claudeRoot: string | null = null): Promise<Source> {
  if (claudeRoot !== null) return await Catalog.open(root, claudeRoot);
  return await Store.open(root ?? '.');
}
