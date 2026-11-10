/**
 * Transcript fixtures for the monitor tests: the record shapes the Python tests build (test_history_paging, test_history_cache,
 * test_plan_context, test_transcript_images, test_tool_images, test_monitor_processes, test_subagent_history, test_subagent_roster,
 * test_titles, test_project_cwd), an edge-case transcript, the work/*-fixture generators, and a large synthetic chat. No real data.
 * Every file's mtime is set to a whole millisecond so Python (100 ns) and Deno (1 ms) read the same st_mtime.
 */
import { join } from '../../outputs/agent-studio/server/transcripts/purepath.ts';
import { python, WORK } from './_parity.ts';

type Row = Record<string, unknown>;
const enc = new TextEncoder();

export function lines(rows: unknown[], finalNewline = true): string {
  const text = rows.map((r) => JSON.stringify(r) + '\n').join('');
  return finalNewline ? text : text.slice(0, -1);
}

export function write(path: string, content: string | Uint8Array, agoSeconds?: number): string {
  Deno.mkdirSync(path.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  if (typeof content === 'string') Deno.writeTextFileSync(path, content);
  else Deno.writeFileSync(path, content);
  const at = new Date(Math.floor(Date.now() - (agoSeconds ?? 0) * 1000));
  Deno.utimeSync(path, at, at);
  return path;
}

export function writeRows(path: string, rows: unknown[], agoSeconds?: number): string {
  return write(path, lines(rows), agoSeconds);
}

/** Set every file's mtime under `root` to a whole millisecond (keeps relative ages). */
export function alignTimes(root: string): void {
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) walk(path);
      else if (entry.isFile) {
        const info = Deno.statSync(path);
        const ms = Math.floor(info.mtime!.getTime());
        Deno.utimeSync(path, new Date(ms), new Date(ms));
      }
    }
  };
  walk(root);
}

export function iso(agoSeconds: number): string {
  return new Date(Date.now() - agoSeconds * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
}

// ---- test_history_paging ----
export function pagingRows(turns = 420, tag = 'user'): Row[] {
  const rows: Row[] = [];
  const two = (n: number) => String(n).padStart(2, '0');
  for (let n = 1; n <= turns; n++) {
    const t = `2026-01-01T${two(Math.floor(n / 3600))}:${two(Math.floor(n / 60) % 60)}:${two(n % 60)}Z`;
    const msg = `MSG-${String(n).padStart(3, '0')}`;
    rows.push({ type: 'user', timestamp: t, message: { role: 'user', content: `${msg} ${tag}` } });
    rows.push({
      type: 'assistant',
      timestamp: t,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `c${n}`, name: 'Read', input: { file_path: `f${n}.txt` } }] },
    });
    rows.push({
      type: 'user',
      timestamp: t,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${n}`, content: 'ok' }] },
    });
    rows.push({ type: 'assistant', timestamp: t, message: { role: 'assistant', content: [{ type: 'text', text: `${msg} reply` }] } });
  }
  return rows;
}

// ---- test_history_cache ----
export function cacheRows(tag: string, count: number, blobs = true, notice: string | null = null): Row[] {
  const stamp = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;
  const rows: Row[] = [{
    type: 'user',
    sessionId: tag,
    cwd: 'C:/fixture',
    timestamp: stamp(1),
    message: { role: 'user', content: 'hello ' + tag },
  }];
  for (let i = 0; i < count; i++) {
    rows.push({
      type: 'assistant',
      timestamp: stamp(2),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${tag} ${i}` }, {
          type: 'tool_use',
          id: `${tag}-c${i}`,
          name: 'Bash',
          input: { command: 'echo x', description: `job ${i}`, run_in_background: true },
        }],
      },
    });
    rows.push({
      type: 'user',
      timestamp: stamp(3),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `${tag}-c${i}`, content: `Command running in background with ID: ${tag}j${i}.` }],
      },
      toolUseResult: { backgroundTaskId: `${tag}j${i}` },
    });
    if (blobs) {
      rows.push({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2000) }] } });
      rows.push({ type: 'file-history-snapshot', snapshot: { files: ['a'.repeat(500)] } });
    }
  }
  if (notice) rows.push({ type: 'api-request-blob', message: { role: 'system', content: [{ type: 'text', text: notice }] } });
  return rows;
}

export function cacheFamily(root: string, subagents: number, turns = 3, session = 'chat'): string {
  const main = writeRows(join(root, 'proj', session + '.jsonl'), cacheRows(session, turns));
  for (let n = 0; n < subagents; n++) {
    writeRows(
      join(root, 'proj', session, 'subagents', `agent-a${String(n).padStart(3, '0')}.jsonl`),
      cacheRows(`a${String(n).padStart(3, '0')}`, turns),
    );
  }
  return main;
}

// ---- test_plan_context ----
const pu = (text: string, n: number): Row => ({
  type: 'user',
  timestamp: `2026-11-08T15:${String(n % 60).padStart(2, '0')}:00Z`,
  message: { role: 'user', content: text },
});
const pa = (blocks: unknown[], n: number): Row => ({
  type: 'assistant',
  timestamp: `2026-11-08T15:${String(n % 60).padStart(2, '0')}:01Z`,
  message: { role: 'assistant', content: blocks },
});
const use = (id: string, name: string, args: Row) => ({ type: 'tool_use', id, name, input: args });
const pr = (id: string, text: string): Row => ({
  type: 'user',
  timestamp: '2026-11-08T15:00:02Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const chatter = (count: number, start = 100) =>
  Array.from({ length: count }, (_, k) => pa([{ type: 'text', text: `step ${start + k}` }], start + k));
export const PLAN = pa([
  use('p1', 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }),
], 1);

export function planFixtures(folder: string): Record<string, string> {
  const notice = {
    type: 'attachment',
    timestamp: '2026-11-08T15:09:00Z',
    attachment: {
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: '<task-notification><task-id>bx1</task-id><status>completed</status></task-notification>',
    },
  };
  const think = pa([{ type: 'thinking', thinking: 'hmm' }], 2);
  const earlier = [
    pu('one', 0),
    pa([use('b1', 'Bash', { command: 'x', run_in_background: true })], 1),
    pr('b1', 'Command running in background with ID: bx1.'),
    pu('two', 3),
    PLAN,
    ...chatter(5),
  ];
  const sets: Record<string, Row[]> = {
    older: [pu('go', 0), PLAN, ...chatter(300)],
    stops: [pu('go', 0), PLAN, ...chatter(20)],
    latest: [
      pu('one', 0),
      PLAN,
      pu('two', 2),
      pa([use('p2', 'mcp__ccd_turn__update_plan', { items: [{ content: 'Z', status: 'in_progress' }] })], 3),
      pa([use('p3', 'mcp__ccd_turn__update_plan', { advance: true })], 4),
      pa([use('w1', 'mcp__ccd_turn__wrap_up', { recap: 'r' })], 5),
      ...chatter(10),
    ],
    background: [
      pu('go', 0),
      PLAN,
      pa([use('b1', 'Bash', { command: 'sleep 99 '.repeat(50), run_in_background: true })], 3),
      pr('b1', 'Command running in background with ID: bx1.'),
      pa([use('b2', 'Bash', { command: 'long', run_in_background: true })], 4),
      pr('b2', 'Command running in background with ID: bx2.'),
      notice,
      ...chatter(5),
    ],
    earlier,
    late: [
      ...earlier.slice(0, 3),
      pu('<task-notification><task-id>bx1</task-id><status>completed</status></task-notification>', 2),
      ...earlier.slice(3, 5),
      ...chatter(5),
    ],
    noplan: [pu('hi', 0), ...chatter(30)],
    thinking: [pu('go', 0), think, think, PLAN, think, ...chatter(10)],
    todo: [
      pu('go', 0),
      pa([use('t1', 'TodoWrite', { todos: [{ content: 'x', status: 'pending' }] })], 1),
      pa([use('t2', 'TodoWrite', { start: 2 })], 2),
      pa([use('t3', 'x__update_plan', { done: [1] })], 3),
      pa([use('t4', 'update_plan', { start: true })], 4),
      pa([use('t5', 'update_plan', { start: 1.5 })], 5),
      pa([use('a1', 'Agent', { prompt: 'x', run_in_background: true })], 6),
      pr('a1', 'Async agent launched successfully. agentId: agent-77 (use it)'),
      pu('[Subagent hand-back] <agent-message from="agent-77">done</agent-message>', 7),
      pr('zz', 'Successfully stopped task: bq9'),
      ...chatter(130),
    ],
  };
  const out: Record<string, string> = {};
  for (const [name, rows] of Object.entries(sets)) out[name] = writeRows(join(folder, name + '.jsonl'), rows);
  return out;
}

// ---- test_transcript_images / test_tool_images ----
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export const PNG = b64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 0x1a, 10, ...enc.encode('0'.repeat(32))]));
const image = (media = 'image/png', data = PNG) => ({ type: 'image', source: { type: 'base64', media_type: media, data } });
const claudeUser = (...blocks: unknown[]): Row => ({
  type: 'user',
  timestamp: '2026-11-08T15:00:00Z',
  message: { role: 'user', content: blocks },
});
const toolResult = (content: unknown): Row => ({
  type: 'user',
  timestamp: '2026-11-08T15:00:00Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
});

export function imageRows(): Row[] {
  return [
    claudeUser({ type: 'text', text: 'hi' }),
    claudeUser(image(), { type: 'text', text: 'shot' }),
    { type: 'attachment', attachment: { type: 'queued_command', prompt: [image('image/webp'), { type: 'text', text: 'later' }] } },
    claudeUser(image(), { type: 'text', text: 'look at this' }, { type: 'text', text: '[Image: source: C:\\t\\16.png]' }),
    claudeUser(image(), image('image/jpeg')),
    { type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/webp', data: PNG }] } },
    claudeUser(image('image/svg+xml')),
    claudeUser({ type: 'text', text: 'see [Image #1] here' }),
    claudeUser({ type: 'text', text: '[Image #1] [Image #2]' }),
    {
      type: 'attachment',
      timestamp: '2026-11-08T22:21:34Z',
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [image(), { type: 'text', text: 'we missed a message?' }] },
    },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'one more thing' } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'bash', prompt: 'ls' } },
    { type: 'attachment', attachment: { type: 'file', prompt: 'x' } },
    toolResult([{ type: 'text', text: 'Took a screenshot' }, image(), { type: 'image', mimeType: 'image/jpeg', data: PNG }]),
    toolResult([image('image/svg+xml')]),
    toolResult('plain'),
    claudeUser(image('image/png', 'QQ=')), // bad base64: listed, then refused when fetched
    claudeUser(image('image/png', 'not base64!')),
    claudeUser(image('image/gif')),
  ];
}

// ---- test_monitor_processes ----
const TMP_OUT = 'C:\\x\\tasks\\%s.output';
const muse = (cid: string, name: string, ago: number, input: Row): Row => ({
  type: 'assistant',
  isSidechain: true,
  timestamp: iso(ago),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: cid, name, input }] },
});
const mres = (cid: string, text: string, ago: number, extra: Row = {}): Row => ({
  type: 'user',
  isSidechain: true,
  timestamp: iso(ago),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: cid, content: text, is_error: false }] },
  ...extra,
});
const monitorStarted = (cid: string, job: string, ago: number) =>
  mres(
    cid,
    `Monitor started (task ${job}, expires in 30m unless the source ends first; you get one notice at expiry \u2014 re-arm if you still need the watch). You will be notified on each event. Keep working \u2014 do not poll or sleep.`,
    ago,
  );
const bashStarted = (cid: string, job: string, ago: number) =>
  mres(
    cid,
    `Command running in background with ID: ${job}. Output is being written to: ${
      TMP_OUT.replace('%s', job)
    }. You will be notified when it completes.`,
    ago,
  );
const noticeText = (job: string, cid: string, status: string, summary: string, event = '') =>
  `<task-notification>\n<task-id>${job}</task-id>\n<tool-use-id>${cid}</tool-use-id>\n<output-file>${
    TMP_OUT.replace('%s', job)
  }</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n${event}</task-notification>`;
const mnotice = (job: string, cid: string, status: string, summary: string, ago: number, event = ''): Row => ({
  type: 'attachment',
  isSidechain: true,
  timestamp: iso(ago),
  attachment: { type: 'queued_command', prompt: noticeText(job, cid, status, summary, event), commandMode: 'task-notification' },
});

/** One chat family per Python process test case: claude/<case>/sess.jsonl with subagent agent-a1. */
export function processFixtures(claude: string): string[] {
  const read = [muse('m0', 'Read', 900, { file_path: 'C:\\x\\a.py' })];
  const launch = [
    muse('t1', 'Monitor', 60, {
      command: 'until grep -q OK C:\\x\\log; do sleep 5; done',
      description: 'full Python suite finish',
      timeout_ms: 1800000,
    }),
    monitorStarted('t1', 'bo91', 59),
  ];
  const bash = [
    muse('b1', 'Bash', 60, { command: 'cd C:\\x && python -m unittest', timeout: 900000, run_in_background: true }),
    bashStarted('b1', 'bn7j', 59),
  ];
  const stopMsg = 'Successfully stopped task: bx1 (sleep 600)';
  const bare = (cid: string, job: string, ago: number) => mres(cid, `Monitor started (task ${job})`, ago);
  const persistent = (cid: string, job: string, ago: number) => mres(cid, `Monitor started (task ${job}, persistent until stopped)`, ago);
  const both = [
    muse('t1', 'Monitor', 60, { command: 'x', description: 'mon', timeout_ms: 1800000 }),
    monitorStarted('t1', 'bs1', 59),
    muse('b1', 'Bash', 58, { command: 'z', run_in_background: true }),
    bashStarted('b1', 'bs2', 57),
  ];
  const cases: Record<string, [Row[], Row[], { meta?: Row; subAgo?: number }?]> = {
    monitorRunning: [read, launch],
    monitorDone: [read, [
      ...launch,
      mnotice('bo91', 't1', 'completed', 'Monitor "full Python suite finish" stream ended', 5, '<event>OK</event>\n'),
    ]],
    bashRunning: [read, bash],
    bashDone: [read, [...bash, {
      type: 'user',
      timestamp: iso(5),
      message: {
        role: 'user',
        content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n' +
          noticeText('bn7j', 'b1', 'completed', 'Background command "x" completed (exit code 0)'),
      },
    }]],
    stopped: [read, [
      muse('t1', 'Monitor', 60, { command: 'sleep 600; echo tick', description: 'wait tick', timeout_ms: 700000 }),
      monitorStarted('t1', 'bx1', 59),
      muse('s1', 'TaskStop', 30, { task_id: 'bx1' }),
      mres('s1', JSON.stringify({ message: stopMsg, task_id: 'bx1', task_type: 'monitor' }), 29, {
        toolUseResult: { message: stopMsg, task_id: 'bx1', task_type: 'monitor' },
      }),
    ]],
    stoppedNotice: [read, [
      muse('t1', 'Monitor', 60, { command: 'x', description: 'd' }),
      monitorStarted('t1', 'bx2', 59),
      mnotice('bx2', 't1', 'stopped', 'Monitor "d" stopped', 5),
    ]],
    counts: [[muse('m1', 'Bash', 90, { command: 'python deploy.py', run_in_background: true }), bashStarted('m1', 'bm1', 89)], [
      muse('t1', 'Monitor', 60, { command: 'x', description: 'one' }),
      monitorStarted('t1', 'bt1', 59),
      muse('t2', 'Monitor', 58, { command: 'y', description: 'two' }),
      monitorStarted('t2', 'bt2', 57),
      muse('b1', 'Bash', 56, { command: 'z', run_in_background: true }),
      bashStarted('b1', 'bb1', 55),
      mnotice('bt2', 't2', 'completed', 'Monitor "two" stream ended', 5),
    ]],
    expired: [read, [
      muse('t1', 'Monitor', 2000, { command: 'x', description: 'old', timeout_ms: 1800000 }),
      monitorStarted('t1', 'bo1', 1999),
      muse('t2', 'Monitor', 60, { command: 'y', description: 'fresh', timeout_ms: 1800000 }),
      monitorStarted('t2', 'bf1', 59),
    ]],
    expiryFallback: [read, [
      muse('t1', 'Monitor', 400, { command: 'x', description: 'by timeout', timeout_ms: 300000 }),
      bare('t1', 'bg1', 399),
      muse('t2', 'Monitor', 400, { command: 'y', description: 'compound', timeout_ms: 3600000 }),
      mres('t2', 'Monitor started (task bg2, expires in 4m 20s unless the source ends first)', 399),
    ]],
    persistent: [
      [
        muse('t1', 'Monitor', 3 * 3600, { command: 'x', description: 'young', persistent: true }),
        persistent('t1', 'bp1', 3 * 3600 - 1),
        muse('t2', 'Monitor', 25 * 3600, { command: 'y', description: 'aged', persistent: true }),
        persistent('t2', 'bp2', 25 * 3600 - 1),
      ].map((r) => ({ ...r, isSidechain: false })),
      [],
    ],
    finishedSidecar: [[muse('m0', 'Read', 900, { file_path: 'a.py' })], both, { meta: { finished: true } }],
    killedByMain: [[mnotice('a1', 'tu', 'killed', 'Agent stopped', 5)], both],
    quiet: [[muse('m0', 'Read', 900, { file_path: 'a.py' })], [
      muse('t1', 'Monitor', 6 * 3600, { command: 'x', description: 'mon', timeout_ms: 30 * 3600 * 1000 }),
      monitorStarted('t1', 'bq1', 6 * 3600 - 1),
    ], { subAgo: 6 * 3600 }],
    mainMonitor: [
      [
        muse('t1', 'Monitor', 60, { command: 'x', description: 'm', timeout_ms: 1800000 }),
        monitorStarted('t1', 'bn1', 59),
        mnotice('bn1', 't1', 'completed', 'done', 5),
      ].map((r) => ({ ...r, isSidechain: false })),
      [],
    ],
  };
  const keys: string[] = [];
  for (const [name, [main, sub, extra]] of Object.entries(cases)) {
    writeRows(join(claude, name, 'sess.jsonl'), main);
    writeRows(join(claude, name, 'sess', 'subagents', 'agent-a1.jsonl'), sub, extra?.subAgo);
    if (extra?.meta) write(join(claude, name, 'sess', 'subagents', 'agent-a1.meta.json'), JSON.stringify(extra.meta));
    keys.push(`claude/${name}/sess.jsonl`);
  }
  return keys;
}

// ---- test_subagent_history / test_subagent_roster ----
export function subagentFixtures(claude: string): void {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const common = { sessionId: 'sess', cwd: 'C:/x', timestamp: now, isSidechain: true };
  writeRows(join(claude, 'enc', 'sess.jsonl'), [{
    type: 'user',
    sessionId: 'sess',
    timestamp: now,
    message: { role: 'user', content: 'go' },
  }]);
  const subs = join(claude, 'enc', 'sess', 'subagents');
  const user = (text: unknown) => ({ ...common, type: 'user', message: { role: 'user', content: text } });
  const assistant = (text: string, extra: Row = {}) => ({
    ...common,
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], ...extra },
  });
  writeRows(join(subs, 'agent-aaa.jsonl'), [
    user('Parent task'),
    {
      ...common,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'c1',
          name: 'Bash',
          input: { command: 'python -m http.server', run_in_background: true, description: 'Serve' },
        }],
      },
    },
    {
      ...common,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Command running in background with ID: bg1' }],
      },
    },
  ]);
  writeRows(join(subs, 'agent-bbb.jsonl'), [user('Child task'), assistant('Child says hello', { stop_reason: 'end_turn' })]);
  write(join(subs, 'agent-aaa.meta.json'), JSON.stringify({ description: 'Parent', agentType: 'general-purpose' }));
  write(
    join(subs, 'agent-bbb.meta.json'),
    JSON.stringify({ description: 'Child', agentType: 'Explore', parentAgentId: 'aaa', toolUseId: 'toolu_9', finished: true }),
  );
  // roster
  writeRows(join(claude, 'ros', 'sess.jsonl'), [{
    type: 'user',
    sessionId: 'sess',
    timestamp: now,
    message: { role: 'user', content: 'go' },
  }]);
  const rs = join(claude, 'ros', 'sess', 'subagents');
  writeRows(join(rs, 'agent-aaa.jsonl'), [user('Audit the importer\nin detail'), assistant('Done.', { stop_reason: 'end_turn' })]);
  writeRows(join(rs, 'agent-bbb.jsonl'), [user('Run the build'), assistant('API Error'), {
    ...common,
    type: 'assistant',
    isApiErrorMessage: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 500' }] },
  }]);
  writeRows(join(rs, 'agent-ccc.jsonl'), [user('<system-reminder>x</system-reminder>Still going'), {
    ...common,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  }]);
  writeRows(join(rs, 'agent-ddd.jsonl'), [user('Has a name')]);
  write(join(rs, 'agent-ddd.meta.json'), JSON.stringify({ description: 'W3c HUD 16:9', agentType: 'general-purpose', status: 'Errored' }));
  writeRows(join(rs, 'nested', 'agent-zzz.jsonl'), [{
    type: 'assistant',
    sessionId: 'sess',
    timestamp: now,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  }]);
  write(join(rs, 'agent-eee.meta.json'), '\ufeff{"description": "bom"}');
  writeRows(join(rs, 'agent-eee.jsonl'), [user('With a BOM sidecar')]);
}

// ---- test_titles / test_project_cwd ----
export const REMINDER =
  '<system-reminder>\nThe user started this session without choosing a project folder, so your working directory is a scratch workspace the app created for it: C:\\Users\\x\\scratch\n</system-reminder>';
export const CONTINUED =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request: fix the build';
const tuser = (text: string, extra: Row = {}): Row => ({
  type: 'user',
  sessionId: 's',
  cwd: 'C:\\w',
  timestamp: '2026-11-07T10:00:00Z',
  message: { role: 'user', content: text },
  ...extra,
});
const tassistant = (text: string): Row => ({
  type: 'assistant',
  sessionId: 's',
  timestamp: '2026-11-07T10:00:05Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

export function titleFixtures(folder: string): void {
  const filler = Array.from({ length: 300 }, () => tassistant('y'.repeat(2000)));
  const sets: Row[][] = [
    [
      tuser(REMINDER, { isMeta: true }),
      tuser('<local-command-caveat>x</local-command-caveat>', { isMeta: true }),
      tuser(CONTINUED),
      tuser('<command-name>/compact</command-name>'),
      tassistant('ok'),
    ],
    [tuser(REMINDER), tuser('Refactor the parser'), tassistant('ok')],
    [tuser('Base directory for this skill: C:\\skills\\demo\n\n# DEMO', { isMeta: true }), tuser('run demo on the exe'), tassistant('ok')],
    [tuser('some long rambling first message'), tassistant('ok'), { type: 'ai-title', aiTitle: 'Work completion status', sessionId: 's' }],
    [tuser('some long rambling first message'), tassistant('ok'), { type: 'ai-title', aiTitle: 'Work completion status', sessionId: 's' }, {
      type: 'custom-title',
      customTitle: 'Strata setup on PC',
      sessionId: 's',
    }],
    [{ type: 'summary', summary: 'Fixing the flaky login test', leafUuid: 'u' }, tuser('please look at this'), tassistant('ok')],
    [{ type: 'summary', summary: 'Fixing the flaky login test', leafUuid: 'u' }, tuser('please look at this'), tassistant('ok'), {
      type: 'ai-title',
      aiTitle: 'Login test fix',
      sessionId: 's',
    }],
    [tuser('Hello: x'), tassistant('ok'), { type: 'title', title: 'Triage open bugs' }],
    [tuser('x'), tassistant('ok'), { type: 'ai-title', aiTitle: '<img src=x onerror=alert(1)> **hostile**' }],
    [tuser('first'), ...filler, { type: 'ai-title', aiTitle: 'Late title' }, ...filler.slice(0, 3)],
    [
      ...Array.from({ length: 100 }, () => ({ type: 'attachment', attachment: { type: 'environment' } })),
      tuser('Explain the scheduler'),
      tassistant('ok'),
    ],
    [tuser(REMINDER), tassistant('ok')],
    [tuser('## **Fix** the `parser` bug in [the docs](http://x.test/a)'), tassistant('ok')],
    [tuser('Fix this:\n\nthe login form crashes on submit'), tassistant('ok')],
    [tuser('word '.repeat(100)), tassistant('ok')],
    [tuser('Ünïcødé 😀 title with an emoji and more words to pass the limit of ninety characters '.repeat(2)), tassistant('ok')],
  ];
  sets.forEach((rows, i) => writeRows(join(folder, `t${String(i).padStart(2, '0')}.jsonl`), rows));
}

const cwdRows = (...cwds: string[]) =>
  cwds.map((c) =>
    JSON.stringify({ type: 'user', cwd: c, sessionId: 's', timestamp: '2026-11-08T10:00:00Z', message: { role: 'user', content: 'hi' } }) +
    '\n'
  ).join('');

export function projectFixtures(root: string): void {
  write(join(root, 'C--repo-app', 'a.jsonl'), cwdRows('C:\\scratch\\x', 'C:\\repo\\app', 'C:\\repo\\app\\outputs\\web'));
  write(join(root, 'C--repo-app', 'b.jsonl'), cwdRows('C:\\repo\\app\\src'));
  const filler = cwdRows(...Array(3000).fill('C:\\scratch\\x'));
  const big = JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: 'y'.repeat(400000) } }) + '\n';
  write(join(root, 'C--repo-app', 'c.jsonl'), filler + cwdRows('C:\\repo\\app') + filler + big);
  write(join(root, 'C--repo-app', 'd.jsonl'), cwdRows('/c/repo/app/src'));
  write(join(root, '-home-u-proj', 'e.jsonl'), cwdRows('/home/u/proj/src:x', '/home/u/other'));
  write(join(root, 'plain', 'f.jsonl'), cwdRows('C:\\elsewhere'));
}

// ---- edge cases: odd and hostile records, OMP shapes, partial lines ----
export function edgeRows(): string {
  const long = '😀'.repeat(20000) + 'x'.repeat(5000);
  const rows: unknown[] = [
    { type: 'session', id: 'omp-1', cwd: '/home/u/proj', timestamp: '2026-11-08T10:00:00.123456+02:00', parentSession: null },
    { type: 'model_change', model: 'gpt-x' },
    { type: 'session_init', task: '  Port the parser\nsecond line', resolvedModel: 'm-1' },
    { type: 'session_init' },
    {
      type: 'message',
      timestamp: '2026-11-08T10:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: '<studio-context>note</studio-context>  Fix **it** now' }] },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'oc1', name: 'bash', arguments: { command: 'ls', i: 'list' }, intent: 'Listing' }],
        timestamp: '2026-11-08T10:00:02Z',
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'oc1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'a\nb' }],
        details: { wallTimeMs: 12, exitCode: 0 },
      },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'oc2', name: 'bash', arguments: { command: 'sleep 9', async: true } }],
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'oc2',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'started' }],
        details: { async: { jobId: 'j-9', state: 'running' }, timeoutSeconds: 30 },
      },
    },
    {
      type: 'custom_message',
      customType: 'async-result',
      details: { jobs: [{ jobId: 'j-9', status: 'completed', durationMs: 900 }, 'x', 5] },
      message: { role: 'custom', content: 'job j-9 done' },
    },
    { type: 'custom_message', customType: 'async-result', details: { jobs: 'abc' }, content: 'text' },
    { type: 'message', message: { role: 'bashExecution', content: 'echo hi' } },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'deep thought' }, { type: 'text', text: long }] },
    },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 5 }, { type: 'text', text: '' }, { type: 'text', text: ['a'] }] },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-x',
        provider: 'anthropic',
        content: [{ type: 'tool_use', id: 'k1', name: 'KillShell', input: { shell_id: 'sh1' } }],
      },
      timestamp: '2026-11-08T10:01:00Z',
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'BashOutput', input: { bash_id: 'j-9' } }] },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'p1', content: [{ type: 'text', text: '<status>failed</status>' }] }],
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'sh',
          name: 'PowerShell',
          input: { command: 'Get-Date', run_in_background: true, timeout_ms: 5000 },
        }],
      },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sh', content: 'Backgrounded as job sh1 (pid 4)' }] },
    },
    {
      type: 'user',
      toolUseResult: { message: 'Successfully killed shell: sh1', shell_id: 'sh1' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'k1', content: 'ok' }] },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'fg', name: 'Bash', input: { command: 'cat log', description: 'Show log' } }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'fg', content: 'Command running in background with ID: fake', is_error: true }],
      },
    },
    { type: 'queue-operation', content: '<task-notification><task-id>sh1</task-id><status>running</status></task-notification>' },
    {
      type: 'user',
      message: {
        role: 'user',
        content:
          '<task-notification><task-id>a</task-id><task-id>b</task-id><status>canceled</status><summary>x &amp; y</summary></task-notification> <task-notification><task-id>c &nbsp;</task-id><status>completed</status></task-notification>',
      },
    },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta prompt' } },
    { type: 'user', isSidechain: true, agentId: 'ag-1', cwd: '/home/u/proj/sub', message: { role: 'user', content: 'side' } },
    { type: 'ai-title', aiTitle: '   ' },
    { type: 'custom-title', title: 'From title key' },
    { type: 'summary', summary: 7, title: 'Summary title fallback' },
    { type: 'user', message: { role: 'user', content: '' } },
    { type: 'user', message: { role: 'user', content: [] } },
    { type: 'user', message: { role: 'user', content: { odd: true } } },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_use', id: 9, name: 'Read', input: { x: [1, 2.5, { y: null }], '': {} } }, 'str', null],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'no role' }] } },
    {
      type: 'assistant',
      timestamp: 17,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'r' } }] },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'Successfully stopped task: q1' }] }],
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'st', name: 'TaskStop', input: { task_id: 'j-9' } }] },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'st', content: '{"message": "Successfully stopped task: j-9", "task_id": "j-9"}' }],
      },
    },
    {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt: [{ type: 'text', text: '<task-notification><task-id>zz</task-id><status>killed</status></task-notification>' }],
      },
    },
    {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt: '<task-notification><task-id>yy</task-id><status>running</status></task-notification>',
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
    },
    {
      type: 'assistant',
      isSidechain: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'synthetic' }] },
    },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: 'skipped' }] } },
  ];
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  // blank lines, a non-object line, broken JSON, invalid UTF-8, a BOM line, \r\n endings, and an unfinished last record
  return '\ufeff' + body + '\n\n   \n[1, 2]\n{"broken": \n' + '{"type":"user","message":{"role":"user","content":"crlf"}}\r\n' +
    '{"type": "user", "message": {"role": "user", "content": "partial';
}

export function edgeFixture(folder: string): string {
  const text = edgeRows();
  const at = text.indexOf('\n\n   \n');
  const parts = [
    enc.encode(text.slice(0, at)),
    enc.encode('\n{"type":"user","message":{"role":"user","content":"bad '),
    new Uint8Array([0xff]),
    enc.encode('"}}'),
    enc.encode(text.slice(at).replace('[1, 2]\n', '')),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return write(join(folder, 'edge.jsonl'), out);
}

/** Run a work/*-fixture generator in a temp copy (it writes next to itself) and return its folder. */
export async function runGenerator(name: string, into: string): Promise<string> {
  const folder = join(into, name);
  Deno.mkdirSync(folder, { recursive: true });
  const source = new URL(`${name}/make_fixture.py`, WORK);
  Deno.copyFileSync(source, join(folder, 'make_fixture.py'));
  const out = await new Deno.Command(python(), { args: ['-X', 'utf8', 'make_fixture.py'], cwd: folder, stdout: 'null', stderr: 'piped' })
    .output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  alignTimes(folder);
  return folder;
}

/** A large synthetic Claude Code chat: every record shape the parser handles, `turns` times over. */
export function bigRows(turns: number): string {
  const parts: string[] = [];
  const two = (n: number) => String(n).padStart(2, '0');
  for (let n = 0; n < turns; n++) {
    const t = `2026-02-${two(1 + (n % 27))}T${two(n % 24)}:${two(n % 60)}:${two((n * 7) % 60)}.${String(n % 1000).padStart(3, '0')}Z`;
    const common = { sessionId: 'big', cwd: n % 50 ? 'C:\\repo\\app' : 'C:\\repo\\app\\sub' + (n % 7), timestamp: t, uuid: `u${n}` };
    const row = (r: Row) => parts.push(JSON.stringify({ ...common, ...r }));
    row({
      type: 'user',
      message: {
        role: 'user',
        content: n % 9 ? `Turn ${n}: please look at **item** ${n} [docs](x)` : [{ type: 'text', text: `pic ${n}` }, image()],
      },
    });
    row({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: `thinking about ${n} `.repeat(5) }] },
    });
    row({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `Answer ${n} `.repeat(20 + (n % 30)) }] },
    });
    if (n % 5 === 0) {
      row({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [use(`b${n}`, 'Bash', { command: `npm test -- ${n}`, description: `Tests ${n}`, run_in_background: n % 10 === 0 })],
        },
      });
      row({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: `b${n}`,
            content: n % 10 === 0 ? `Command running in background with ID: job${n}.` : `ok ${n}`,
          }],
        },
        toolUseResult: n % 10 === 0 ? { backgroundTaskId: `job${n}` } : { exitCode: 0, wallTimeMs: n },
      });
    }
    if (n % 20 === 3) {
      row({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'task-notification',
          prompt: `<task-notification>\n<task-id>job${n - 3}</task-id>\n<tool-use-id>b${
            n - 3
          }</tool-use-id>\n<status>completed</status>\n<summary>done ${n}</summary>\n</task-notification>`,
        },
      });
    }
    if (n % 40 === 1) {
      row({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [use(`p${n}`, 'mcp__ccd_turn__update_plan', { items: [{ content: `step ${n}`, status: 'in_progress' }] })],
        },
      });
    }
    if (n % 40 === 2) {
      row({ type: 'assistant', message: { role: 'assistant', content: [use(`q${n}`, 'mcp__ccd_turn__update_plan', { advance: true })] } });
    }
    if (n % 7 === 0) {
      row({ type: 'assistant', message: { role: 'assistant', content: [use(`r${n}`, 'Read', { file_path: `src/f${n}.ts`, limit: 50 })] } });
    }
    if (n % 7 === 0) {
      row({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `r${n}`, content: [{ type: 'text', text: 'line\n'.repeat(40) }] }],
        },
      });
    }
    if (n % 11 === 0) {
      parts.push(
        JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: 'z'.repeat(3000) }] } }),
      );
    }
    if (n % 13 === 0) parts.push(JSON.stringify({ type: 'file-history-snapshot', snapshot: { files: [`f${n}`] } }));
    if (n % 97 === 0) row({ type: 'ai-title', aiTitle: `Big chat ${n}` });
  }
  return parts.join('\n') + '\n';
}
