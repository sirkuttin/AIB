/**
 * Differential test of server/acp/connection.ts: each script runs once through Python's acp_connection.Connection
 * (work/parity/connection_shim.py) and once through the port, against the same fake agent, and both must give the same
 * results (replies and refusals with their messages), the same event list, the same messages written to the agent, the same
 * stderr tail and the same written-file list. Times, random keys and the temp folder are scrubbed from both.
 *
 * Steps ({op, ...}): setup {resume}, setup_bg / join_setup, prompt {text, id, attachments}, fingerprint, queue_add,
 * queue {action, args}, wait {for}, sleep {ms}, permission {option, withdrawn}, elicit {action, content, withdrawn},
 * receive_elicitation {rpcId, params}, auth {action, method}, cancel {subagent}, cancel_incoming {id},
 * change {kind, configId, value}, cancel_pending {key}, request {method, params}, discover, list_sessions {cwd, cursor},
 * public {after, light}, attention, write_file {name, text}, kill, close. '<cwd>' in a step is the temp folder (with /).
 */
import { assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { FAKE, type Json, PYTHON, STREAM_AGENT, until } from './_connection.ts';
import { Connection, errorName } from '../../outputs/agent-studio/server/acp/connection.ts';

type Step = Json & { op: string };
const AGENTS: Record<string, string> = { fake: FAKE, stream: STREAM_AGENT };

function condition(c: Connection, spec: string): () => boolean {
  const [name, ...rest] = spec.split(':');
  const arg = rest.join(':');
  const updates = () => c.events.filter((e) => e.kind === 'update');
  switch (name) {
    case 'permissions':
      return () => c.permissions.size > 0;
    case 'elicitations':
      return () => c.elicitations.size > 0;
    case 'auth':
      return () => c.auth !== null && !c.auth.working;
    case 'auth_error':
      return () => c.auth !== null && !!c.auth.error;
    case 'idle':
      return () => !c.busy && !c.queue.inflight;
    case 'busy':
      return () => c.busy;
    case 'ready':
      return () => c.ready;
    case 'closed':
      return () => c.closed && !c.busy;
    case 'events': {
      const [kind, count] = arg.split(':');
      return () => c.events.filter((e) => e.kind === kind).length >= Number(count);
    }
    case 'text': {
      const cut = arg.lastIndexOf(':');
      const [sub, count] = [arg.slice(0, cut), Number(arg.slice(cut + 1))];
      return () =>
        updates().filter((e) => JSON.stringify(e.data).includes(sub)).length >=
          count;
    }
    case 'subagent': {
      const [child, state] = arg.split(':');
      return () =>
        c.subagents.has(child) &&
        (!state || c.subagents.get(child)!.state === state);
    }
  }
  throw new Error('unknown wait ' + spec);
}

const camel = (name: string) => name.replace(/_(.)/g, (_, ch: string) => ch.toUpperCase());

function withdrawnKey(c: Connection, kind: string): string {
  const event = c.events.find((e) => e.kind === 'request_withdrawn' && (e.data as Json).kind === kind)!;
  return (event.data as Json).key as string;
}

async function step(c: Connection, s: Step, state: Json): Promise<unknown> {
  switch (s.op) {
    case 'setup':
      return await c.setup((s.resume as string) ?? null);
    case 'setup_bg':
      c.setup((s.resume as string) ?? null).then(
        () => (state.setup = { ok: null }),
        (
          error,
        ) => (state.setup = {
          error: errorName(error),
          message: (error as Error).message,
        }),
      );
      return null;
    case 'join_setup': {
      await until(() => 'setup' in state, 'setup', 20);
      const outcome = state.setup;
      delete state.setup;
      return outcome;
    }
    case 'prompt':
      return await c.prompt(
        s.text,
        (s.id as string) ?? null,
        s.attachments ?? null,
      );
    case 'fingerprint':
      return c.preparePrompt(s.text, s.id ?? null, s.attachments ?? null)[3];
    case 'queue_add':
      return await c.queueAdd(
        s.text,
        (s.id as string) ?? null,
        s.attachments ?? null,
      );
    case 'queue': {
      const method = camel('queue_' + (s.action as string)) as keyof Connection;
      return await (c[method] as (...args: unknown[]) => unknown)(
        ...((s.args as unknown[]) ?? []),
      );
    }
    case 'wait':
      await until(condition(c, s.for as string), s.for as string, 20);
      return null;
    case 'sleep':
      await new Promise((resolve) => setTimeout(resolve, s.ms as number));
      return null;
    case 'permission':
      return c.permission(
        s.withdrawn ? withdrawnKey(c, 'permission') : c.permissions.keys().next().value,
        s.option ?? null,
      );
    case 'elicit':
      return c.answerElicitation(
        s.withdrawn ? withdrawnKey(c, 'elicitation') : c.elicitations.keys().next().value,
        s.action,
        s.content ?? null,
      );
    case 'receive_elicitation':
      return c.receiveElicitation(s.rpcId, s.params);
    case 'auth':
      return c.answerAuth(s.action, s.method ?? null);
    case 'cancel':
      return c.cancel(s.subagent ?? null);
    case 'cancel_incoming':
      return c.cancelIncomingRequest(s.id);
    case 'change':
      return await c.changeSetting(s.kind, s.configId ?? null, s.value);
    case 'cancel_pending':
      return c.cancelPending(s.key);
    case 'request':
      return await c.request(
        s.method as string,
        s.params,
        (s.timeout as number) ?? 30,
      );
    case 'discover':
      return await c.initializeForDiscovery();
    case 'list_sessions':
      return await c.listSessions(
        (s.cwd as string) ?? null,
        (s.cursor as string) ?? null,
      );
    case 'public': {
      const data = c.public(
        (s.after as number) ?? 0,
        (s.light as boolean) ?? false,
      );
      delete data.events;
      return data;
    }
    case 'attention':
      return c.attention();
    case 'write_file':
      Deno.writeTextFileSync(`${state.folder}/${s.name}`, s.text as string);
      return null;
    case 'kill':
      c.process!.kill('SIGKILL');
      return null;
    case 'close':
      return await c.close();
  }
  throw new Error('unknown op ' + s.op);
}

async function runPort(
  agent: string,
  flags: string[],
  steps: Step[],
  provider: string,
  options: Json,
): Promise<Json> {
  const folder = Deno.makeTempDirSync({ prefix: 'aib-conn-parity-' });
  steps = JSON.parse(
    JSON.stringify(steps).replaceAll('<cwd>', folder.replaceAll('\\', '/')),
  );
  const writes: unknown[] = [];
  const results: Json[] = [];
  const state: Json = { folder };
  const c = new Connection(
    [PYTHON, AGENTS[agent], ...flags],
    folder,
    provider,
    {
      enableTerminal: !!options.terminal,
      enableFs: (options.fs as 'read' | 'readwrite' | undefined) ?? null,
    },
  );
  const original = c.write.bind(c);
  c.write = (message) => {
    writes.push(JSON.parse(JSON.stringify(message)));
    original(message);
  };
  try {
    for (const s of steps) {
      try {
        results.push({ ok: (await step(c, s, state)) ?? null });
      } catch (error) {
        results.push({
          error: errorName(error),
          message: (error as Error).message,
        });
      }
    }
  } finally {
    await c.close();
    if (c.turn) await c.turn;
  }
  const out = {
    cwd: folder,
    results,
    events: c.events,
    writes,
    stderr: c.stderr,
    written: c.writes.written(),
  };
  try {
    Deno.removeSync(folder, { recursive: true });
  } catch { /* the OS cleans temp */ }
  return JSON.parse(JSON.stringify(out));
}

const DROP = new Set([
  'time',
  'queuedAt',
  'at',
  'turnEndedAt',
  'busySince',
  'leaseExpiresAt',
  // Steer-on-send's snapshot keys: Deno only (the Python reference never had them); work/deno/steer_*_test.ts covers them.
  'steerable',
  'autonomous',
  'steerAgent',
  'steerLane',
  'toolBackground',
]);

/** Same shape with times dropped, random keys and terminal ids numbered in order of appearance, the temp folder replaced, the connection id gone. */
function scrub(run: Json): Json {
  const cwd = run.cwd as string;
  const escaped = JSON.stringify(cwd).slice(1, -1);
  const text = JSON.stringify({ ...run, cwd: '<cwd>' }).replaceAll(
    escaped,
    '<cwd>',
  ).replaceAll(cwd.replaceAll('\\', '/'), '<cwd>');
  const names = new Map<string, string>();
  const terminals = new Map<string, string>();
  const named = text.replace(/term_[0-9a-f]{16}/g, (id) => {
    if (!terminals.has(id)) terminals.set(id, `term_T${terminals.size + 1}`);
    return terminals.get(id)!;
  });
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.has(k)) continue;
      if (
        (k === 'key' || k === 'leaseId') && typeof v === 'string' &&
        /^[A-Za-z0-9_-]{24}$/.test(v)
      ) {
        if (!names.has(v)) names.set(v, `K${names.size + 1}`);
        out[k] = names.get(v);
      } else if (
        k === 'id' && typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
      ) {
        out[k] = '<id>';
      } else out[k] = walk(v);
    }
    return out;
  };
  return walk(JSON.parse(named)) as Json;
}

/**
 * Event lists without seq, sorted: for scripts whose agent writes faster than a turn ends. Python's order there is a race, and so
 * is whether a repeated reply still finds its request (a "Duplicate response") or finds it already gone ("unknown request id").
 * Also for agents that announce things right after answering session/new or session/load: in Python those updates race the
 * setup thread, so they may come before 'connected' and be marked replay. The port always finishes setup first (not replay).
 */
function unordered(events: unknown): string[] {
  return (events as Json[]).map((e) =>
    JSON.stringify({ ...e, seq: 0, replay: undefined })
      .replace(
        /Duplicate response for request id (\S+) ignored/,
        'Late response for request id $1 ignored',
      )
      .replace(
        /Response to unknown request id (\d+) ignored/,
        'Late response for request id $1 ignored',
      )
  ).sort();
}

interface Script {
  name: string;
  agent?: string;
  flags?: string[];
  provider?: string;
  ordered?: boolean;
  options?: Json;
  steps: Step[];
}

const png = btoa(
  String.fromCharCode(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new TextEncoder().encode('pixels'),
  ),
);
const fileOf = (name: string, mimeType: string, text: string) => ({
  type: 'file',
  name,
  mimeType,
  data: btoa(String.fromCharCode(...new TextEncoder().encode(text))),
});

const SCRIPTS: Script[] = [
  {
    name: 'approval, duplicate receipt, attention and public state',
    steps: [
      { op: 'setup' },
      { op: 'public' },
      { op: 'prompt', text: 'fixture prompt', id: 'm1' },
      { op: 'prompt', text: 'fixture prompt', id: 'm1' },
      { op: 'prompt', text: 'other', id: 'm1' },
      { op: 'prompt', text: 'second' },
      { op: 'wait', for: 'permissions' },
      { op: 'attention' },
      { op: 'public', light: true },
      { op: 'permission', option: 'nope' },
      { op: 'permission', option: 'yes' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'fixture prompt', id: 'm1' },
      { op: 'public', after: 3 },
      { op: 'close' },
      { op: 'prompt', text: 'after close' },
    ],
  },
  {
    name: 'form elicitation: refused content, accepted content',
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'form' },
      { op: 'wait', for: 'elicitations' },
      { op: 'public' },
      { op: 'elicit', action: 'accept' },
      {
        op: 'elicit',
        action: 'accept',
        content: { name: 'Ada', plan: 'gold' },
      },
      { op: 'elicit', action: 'maybe' },
      { op: 'elicit', action: 'accept', content: { name: 'Ada', plan: 'pro' } },
      { op: 'wait', for: 'idle' },
      { op: 'close' },
    ],
  },
  {
    name: 'requests left open, agent $/cancel_request, stale answers',
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'leave-open' },
      { op: 'wait', for: 'idle' },
      { op: 'permission', option: 'yes', withdrawn: true },
      { op: 'elicit', action: 'cancel', withdrawn: true },
      { op: 'prompt', text: 'agent-cancel' },
      { op: 'wait', for: 'idle' },
      { op: 'close' },
    ],
  },
  {
    name: 'url elicitation, decline, agent completion, subagent routing',
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'url' },
      { op: 'wait', for: 'elicitations' },
      { op: 'elicit', action: 'decline' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'url-complete' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'child-ask' },
      { op: 'wait', for: 'permissions' },
      { op: 'public' },
      { op: 'permission', option: 'yes' },
      { op: 'wait', for: 'idle' },
      { op: 'close' },
    ],
  },
  {
    name: 'local elicitation validation and id-direction rules',
    steps: [
      { op: 'setup' },
      {
        op: 'receive_elicitation',
        rpcId: 'x',
        params: {
          mode: 'form',
          message: 'm',
          requestedSchema: { type: 'object', properties: {} },
          sessionId: 'foreign',
        },
      },
      {
        op: 'receive_elicitation',
        rpcId: 'x',
        params: {
          mode: 'url',
          message: 'm',
          url: 'https://example.org',
          requestId: 'r',
        },
      },
      {
        op: 'receive_elicitation',
        rpcId: 'x',
        params: {
          mode: 'form',
          message: 'm',
          requestedSchema: { type: 'object', properties: {} },
        },
      },
      {
        op: 'receive_elicitation',
        rpcId: 'x',
        params: {
          mode: 'form',
          message: 'm',
          requestId: true,
          requestedSchema: { type: 'object', properties: {} },
        },
      },
      {
        op: 'receive_elicitation',
        rpcId: 'x',
        params: {
          mode: 'form',
          message: 'm',
          requestId: 1,
          toolCallId: 't',
          requestedSchema: { type: 'object', properties: {} },
        },
      },
      {
        op: 'receive_elicitation',
        rpcId: 'x',
        params: {
          mode: 'form',
          message: 5,
          requestId: 1,
          requestedSchema: { type: 'object', properties: {} },
        },
      },
      {
        op: 'receive_elicitation',
        rpcId: 'x',
        params: { mode: 'chat', message: 'm' },
      },
      {
        op: 'receive_elicitation',
        rpcId: 45,
        params: {
          mode: 'form',
          message: 'Name?',
          requestId: 77,
          requestedSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      },
      { op: 'cancel_incoming', id: 77 },
      { op: 'cancel_incoming', id: '45' },
      { op: 'public' },
      { op: 'cancel_incoming', id: 45 },
      { op: 'close' },
    ],
  },
  {
    name: 'cancel-aware interrupt with a pending permission',
    flags: ['--cancel-aware'],
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'needs approval' },
      { op: 'wait', for: 'permissions' },
      { op: 'cancel' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'form' },
      { op: 'wait', for: 'elicitations' },
      { op: 'cancel' },
      { op: 'elicit', action: 'accept', content: {}, withdrawn: true },
      // The cancel answered the form with `cancel`; the agent ends that turn when the answer reaches it. Wait for that, so the
      // next prompt starts a turn of its own (which session/cancel must end with `cancelled`). Without the wait the prompt raced
      // the agent's reply on both sides: usually refused as busy, under load accepted on one side only.
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'wait' },
      { op: 'cancel' },
      { op: 'wait', for: 'idle' },
      { op: 'close' },
    ],
  },
  {
    name: 'breadth: settings queued during a turn, applied after; refusals; idle changes',
    flags: ['--breadth'],
    ordered: false,
    steps: [
      { op: 'setup' },
      { op: 'wait', for: 'events:update:4' },
      { op: 'public' },
      { op: 'prompt', text: 'wait' },
      { op: 'wait', for: 'busy' },
      { op: 'change', kind: 'config', configId: 'model', value: 'deep' },
      { op: 'change', kind: 'config', configId: 'effort', value: 'high' },
      { op: 'change', kind: 'config', configId: 'verbose', value: true },
      { op: 'change', kind: 'config', configId: 'model', value: 'fast' },
      { op: 'change', kind: 'config', configId: 'model', value: 'deep' },
      { op: 'change', kind: 'config', configId: 'dial', value: 3 },
      { op: 'change', kind: 'mode', value: 'nope' },
      { op: 'change', kind: 'mode', value: 'code' },
      { op: 'change', kind: 'bogus', value: 1 },
      { op: 'cancel_pending', key: 'config:effort' },
      { op: 'cancel_pending', key: 'config:effort' },
      { op: 'cancel' },
      { op: 'wait', for: 'idle' },
      { op: 'public' },
      { op: 'change', kind: 'config', configId: 'effort', value: 'high' },
      { op: 'change', kind: 'mode', value: 'code' },
      { op: 'prompt', text: '/compact' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'mcp' },
      { op: 'wait', for: 'idle' },
      { op: 'public' },
      { op: 'close' },
    ],
  },
  {
    name: 'refused queued settings are reported',
    flags: ['--breadth', '--reject-config'],
    ordered: false,
    steps: [
      { op: 'setup' },
      { op: 'wait', for: 'events:update:4' }, // the announcements that follow session/new (when they arrive is a race in Python)
      { op: 'prompt', text: 'wait' },
      { op: 'wait', for: 'busy' },
      { op: 'change', kind: 'config', configId: 'model', value: 'deep' },
      { op: 'cancel' },
      { op: 'wait', for: 'idle' },
      { op: 'change', kind: 'mode', value: 'code' },
      { op: 'change', kind: 'config', configId: 'verbose', value: true },
      { op: 'public' },
      { op: 'close' },
    ],
  },
  {
    name: 'message queue: interrupt hold, resume, reorder, remove, send-now, edit',
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'wait' },
      { op: 'wait', for: 'busy' },
      { op: 'queue_add', text: 'mcp', id: 'a' },
      { op: 'queue_add', text: 'mcp', id: 'b' },
      { op: 'queue_add', text: 'mcp', id: 'c' },
      { op: 'queue_add', text: 'mcp', id: 'a' },
      { op: 'queue_add', text: 'other', id: 'a' },
      { op: 'queue', action: 'move', args: ['c', 0] },
      { op: 'queue', action: 'remove', args: ['b'] },
      { op: 'queue', action: 'remove', args: ['b'] },
      { op: 'queue', action: 'edit', args: ['a', 'acquire', 'L1'] },
      { op: 'queue', action: 'edit', args: ['a', 'acquire', 'L2'] },
      { op: 'queue', action: 'send_now', args: ['a'] },
      { op: 'queue', action: 'edit', args: ['a', 'save', 'L1', 'mcp'] },
      { op: 'queue', action: 'edit', args: ['a', 'bogus'] },
      { op: 'queue', action: 'public', args: [] },
      { op: 'cancel' },
      { op: 'wait', for: 'idle' },
      { op: 'queue', action: 'public', args: [] },
      { op: 'queue', action: 'resume', args: [] },
      { op: 'wait', for: 'events:user:3' },
      { op: 'wait', for: 'idle' },
      { op: 'queue_add', text: 'mcp', id: 'c' },
      { op: 'queue_add', text: 'mcp', id: 'd' },
      { op: 'wait', for: 'events:user:4' },
      { op: 'wait', for: 'idle' },
      { op: 'public' },
      { op: 'close' },
    ],
  },
  {
    name: 'send-now during a turn interrupts and goes first',
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'wait' },
      { op: 'wait', for: 'busy' },
      { op: 'queue_add', text: 'mcp', id: 'a' },
      { op: 'queue_add', text: 'mcp', id: 'b' },
      { op: 'queue', action: 'send_now', args: ['b'] },
      { op: 'wait', for: 'events:user:3' },
      { op: 'wait', for: 'idle' },
      { op: 'close' },
    ],
  },
  {
    name: 'images, files and the prompt fingerprint',
    flags: ['--images', '--embedded-context'],
    steps: [
      { op: 'setup' },
      { op: 'fingerprint', text: 'plain ü 😀' },
      {
        op: 'fingerprint',
        text: 'pic',
        attachments: [{ type: 'image', mimeType: 'image/png', data: png }],
      },
      {
        op: 'fingerprint',
        text: 'ü',
        attachments: [
          fileOf('notes ü.txt', 'text/plain', 'line 1\nline 2 😀\n'),
          { mimeType: 'image/png', data: png },
        ],
      },
      { op: 'fingerprint', text: '', attachments: [] },
      { op: 'fingerprint', text: 'x', id: '' },
      { op: 'fingerprint', text: 'x'.repeat(200001) },
      {
        op: 'prompt',
        text: '',
        id: 'img',
        attachments: [{ type: 'image', mimeType: 'image/png', data: png }],
      },
      { op: 'wait', for: 'idle' },
      {
        op: 'prompt',
        text: 'see file',
        id: 'file',
        attachments: [fileOf('a.md', 'text/markdown', '# Title\n\nbody')],
      },
      { op: 'wait', for: 'idle' },
      {
        op: 'prompt',
        text: 'see file',
        id: 'file',
        attachments: [fileOf('a.md', 'text/markdown', '# Changed')],
      },
      { op: 'close' },
    ],
  },
  {
    name: 'files inline for an agent without embedded context; images refused',
    steps: [
      { op: 'setup' },
      {
        op: 'prompt',
        text: 'look',
        attachments: [{ type: 'image', mimeType: 'image/png', data: png }],
      },
      {
        op: 'prompt',
        text: 'see',
        attachments: [fileOf('b.txt', 'text/plain', 'inline me')],
      },
      { op: 'wait', for: 'idle' },
      {
        op: 'prompt',
        text: 'bin',
        attachments: [{
          type: 'file',
          name: 'c.bin',
          mimeType: 'application/octet-stream',
          data: 'AAECAw==',
        }],
      },
      { op: 'close' },
    ],
  },
  {
    name: 'malformed agent traffic',
    flags: ['--malformed'],
    ordered: false,
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'junk' },
      { op: 'wait', for: 'events:turn_end:1' },
      { op: 'wait', for: 'text:Fixture reply:2' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'badstop' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'die' },
      { op: 'wait', for: 'closed' },
      { op: 'cancel' },
      { op: 'public' },
    ],
  },
  {
    name: 'bad initialize and bad session results',
    flags: ['--bad-session', 'bad-modes'],
    steps: [{ op: 'setup' }, { op: 'public' }, { op: 'close' }],
  },
  {
    name: 'protocol version 2 is refused',
    flags: ['--protocol-version', '2'],
    steps: [{ op: 'setup' }, { op: 'close' }],
  },
  {
    name: 'sign-in: terminal method refused, in-app method, retry',
    flags: ['--auth-required'],
    provider: 'claude',
    steps: [
      { op: 'setup_bg' },
      { op: 'wait', for: 'auth' },
      { op: 'public' },
      { op: 'auth', action: 'authenticate', method: 'fixture-terminal' },
      { op: 'auth', action: 'authenticate', method: 'nope' },
      { op: 'auth', action: 'maybe' },
      { op: 'auth', action: 'authenticate', method: 'fixture-login' },
      { op: 'join_setup' },
      { op: 'auth', action: 'retry' },
      { op: 'public' },
      { op: 'close' },
    ],
  },
  {
    name: 'sign-in rejected, then cancelled',
    flags: ['--auth-required', '--auth-reject'],
    steps: [
      { op: 'setup_bg' },
      { op: 'wait', for: 'auth' },
      { op: 'auth', action: 'authenticate', method: 'fixture-login' },
      { op: 'wait', for: 'auth_error' },
      { op: 'public' },
      { op: 'auth', action: 'cancel' },
      { op: 'join_setup' },
      { op: 'close' },
    ],
  },
  {
    name: 'a declined setup question aborts setup',
    flags: ['--setup-question'],
    steps: [
      { op: 'setup_bg', resume: 'resumed-id' },
      { op: 'wait', for: 'elicitations' },
      { op: 'public' },
      { op: 'elicit', action: 'decline' },
      { op: 'join_setup' },
      { op: 'close' },
    ],
  },
  {
    name: 'an accepted setup question; then a setup failure',
    flags: ['--setup-question', '--setup-fail'],
    steps: [
      { op: 'setup_bg' },
      { op: 'wait', for: 'elicitations' },
      { op: 'elicit', action: 'accept', content: { label: 'x' } },
      { op: 'join_setup' },
      { op: 'close' },
    ],
  },
  {
    name: 'resume with history replay',
    flags: ['--replay-history'],
    steps: [{ op: 'setup', resume: 'old-session' }, { op: 'public' }, {
      op: 'close',
    }],
  },
  {
    name: 'resume-only agent uses session/resume; discovery lists sessions',
    flags: ['--breadth', '--resume-only'],
    ordered: false,
    steps: [
      { op: 'setup', resume: 'sess-9' },
      { op: 'list_sessions' },
      { op: 'list_sessions', cursor: 'page2' },
      {
        op: 'request',
        method: 'session/set_mode',
        params: { sessionId: 'sess-9', modeId: 'code' },
      },
      { op: 'close' },
    ],
  },
  {
    name: 'discovery without a session',
    flags: ['--list-sessions'],
    steps: [
      { op: 'discover' },
      { op: 'list_sessions', cwd: '/fixture/project' },
      { op: 'list_sessions', cursor: 'offset:2' },
      {
        op: 'close',
      },
    ],
  },
  {
    name: 'subagent announcement and cancellation',
    flags: ['--subagent'],
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'delegate' },
      { op: 'wait', for: 'subagent:child-1:running' },
      { op: 'cancel', subagent: 'unknown' },
      { op: 'cancel', subagent: 'child-1' },
      { op: 'wait', for: 'subagent:child-1:idle' },
      { op: 'cancel', subagent: 'child-1' },
      { op: 'public' },
      { op: 'cancel' },
      { op: 'wait', for: 'idle' },
      { op: 'close' },
    ],
  },
  {
    name: 'rich reply: tool calls, diffs and the files the agent wrote',
    flags: ['--rich'],
    steps: [{ op: 'setup' }, { op: 'prompt', text: 'show me' }, {
      op: 'wait',
      for: 'idle',
    }, { op: 'close' }],
  },
  {
    name: 'an agent killed mid-turn',
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'needs approval', id: 'k1' },
      { op: 'wait', for: 'permissions' },
      { op: 'kill' },
      { op: 'wait', for: 'closed' },
      { op: 'public' },
      { op: 'close' },
    ],
  },
  {
    name: 'client capabilities: fs read, refused write, terminal round trip, unknown session',
    flags: ['--client-caps'],
    options: { fs: 'read', terminal: true },
    steps: [
      { op: 'write_file', name: 'a.txt', text: 'one\ntwo\nthree\n' },
      { op: 'setup' },
      {
        op: 'prompt',
        text: 'caps:' + JSON.stringify([
          {
            method: 'fs/read_text_file',
            params: { path: '<cwd>/a.txt', line: 2, limit: 1 },
          },
          {
            method: 'fs/read_text_file',
            params: { path: '<cwd>/missing.txt' },
          },
          {
            method: 'fs/write_text_file',
            params: { path: '<cwd>/b.txt', content: 'x' },
          },
          {
            method: 'fs/read_text_file',
            params: { path: '<cwd>/a.txt', sessionId: 'someone-else' },
          },
          {
            method: 'terminal/create',
            params: { command: 'python', args: ['-c', 'print(6 * 7)'] },
          },
          { method: 'terminal/wait_for_exit', params: { terminalId: '$term' } },
          { method: 'terminal/output', params: { terminalId: '$term' } },
          { method: 'terminal/release', params: { terminalId: '$term' } },
          { method: 'terminal/output', params: { terminalId: '$term' } },
        ]),
      },
      { op: 'wait', for: 'idle' },
      { op: 'public' },
      { op: 'close' },
    ],
  },
  {
    name: 'stdout and stderr bytes: split characters, bad UTF-8, CR line ends, a 3 MB line, BOM, EOF mid-character',
    agent: 'stream',
    steps: [
      { op: 'setup' },
      { op: 'prompt', text: 'edge' },
      { op: 'wait', for: 'idle' },
      { op: 'prompt', text: 'again' },
      { op: 'wait', for: 'idle' },
      { op: 'close' },
    ],
  },
];

for (const script of SCRIPTS) {
  Deno.test(`parity: ${script.name}`, async () => {
    await using py = new PyParity();
    const agent = script.agent ?? 'fake';
    const flags = script.flags ?? [];
    const provider = script.provider ?? 'omp';
    const options = script.options ?? {};
    const expected = scrub(
      await py.call('connection_shim', 'run_script', [
        agent,
        flags,
        script.steps,
        provider,
        options,
      ]) as Json,
    );
    const actual = scrub(
      await runPort(agent, flags, script.steps, provider, options),
    );
    if (script.ordered === false) {
      assertEquals(
        unordered(actual.events),
        unordered(expected.events),
        'events (any order)',
      );
    } else {
      assertEquals(actual.events, expected.events, 'events');
    }
    assertEquals(actual.results, expected.results, 'results');
    assertEquals(actual.writes, expected.writes, 'writes to the agent');
    assertEquals(actual.stderr, expected.stderr, 'stderr tail');
    assertEquals(actual.written, expected.written, 'files written');
  });
}
