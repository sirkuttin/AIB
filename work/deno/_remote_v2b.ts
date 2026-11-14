/** Phone UI v2 part 2 test helpers: an in-process AIB with phone access on, an added project, and a fake agent host that answers
 * connect / prompt / disconnect / agent-options (remote_v2b_test.ts, remote_v2b_review_test.ts, remote_phone_v2b_e2e_test.ts).
 * Its prompt behaves like Connection.prompt: refused while the chat is not ready or busy, a repeat of a clientMessageId with the
 * same text is a duplicate (accepted, nothing sent again), the same id with other text is refused; a prompt it takes adds the
 * user event (with its clientMessageId) to the chat. */
import { assertEquals } from './_assert.ts';
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { projectId } from '../../outputs/agent-studio/server/remote/projects.ts';
import { DEVICE_HEADER } from '../../outputs/agent-studio/server/remote/server.ts';
import { setAgentRows } from '../../outputs/agent-studio/server/remote/newchat.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { type FakeChat, fakeTailscale, pc, phoneHeaders, raw, type RemoteStudio, remoteStudio, serveStatus } from './_remote_fixture.ts';

type Json = Record<string, unknown>;

export const AGENT_ROWS = [
  { id: 'omp', enabled: true, found: true },
  { id: 'claude', enabled: true, found: true },
  { id: 'codex', enabled: false, found: true },
  { id: 'kimi', beta: true, name: 'Kimi', enabled: true, found: true, signin: { state: 'signin' } },
];
export const OPTIONS = {
  model: {
    kind: 'config',
    configId: 'model',
    current: 'sonnet',
    choices: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }],
  },
  mode: {
    kind: 'mode',
    current: 'default',
    choices: [{ value: 'default', name: 'Ask before edits' }, { value: 'bypassPermissions', name: 'Bypass permissions' }],
  },
};

export function liveChat(id: string, cwd: string, over: Partial<FakeChat> & Json = {}): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd,
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: new Date(Date.now() - 60000).toISOString(), busySince: null },
    subagents: {},
    events: [{ seq: 1, kind: 'user', time: Date.now() / 1000 - 120, data: { text: 'Fix the checkout' } }],
    permissions: [],
    elicitations: [],
    ...over,
  } as FakeChat;
}

/** What the fake agent host does next (tests change it): the start picks' results; whether a new chat is ready at once; how long a
 * disconnect takes to close the chat; an error connect or prompt answers with. */
export interface FakeNext {
  results: Json[];
  ready?: boolean;
  endMs?: number;
  connectError?: string;
  promptError?: string;
}

/** Phone access on, an added project with saved transcripts, the fake agent host answering connect / prompt / disconnect /
 * agent-options; `pick` sets what the next new chat's start picks report (and the rest of FakeNext). */
export async function v2Studio(): Promise<RemoteStudio & { pick: FakeNext; projectId: string }> {
  setAgentRows(() => Promise.resolve(AGENT_ROWS));
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', { on: true });
  assertEquals(status, 200);
  const pick: FakeNext = { results: [] as Json[] };
  let n = 0;
  const receipts = new Map<string, string>(); // chat id + clientMessageId -> text
  s.answerLive((name, body) => {
    if (name === 'agent-options') return [200, { agent: body.agent, options: OPTIONS }];
    if (name === 'connect') {
      if (pick.connectError) return [500, { error: pick.connectError }];
      const id = `new-${++n}`;
      s.chats.push(
        liveChat(id, String(body.cwd), {
          provider: String(body.provider),
          sessionId: `s-new-${n}`,
          events: [],
          pickResults: pick.results,
          ...(pick.ready === false ? { ready: false } : {}),
        }),
      );
      return [200, { id, provider: body.provider }];
    }
    if (name === 'disconnect') {
      const c = s.chats.find((x) => x.id === body.id);
      if (c && pick.endMs) setTimeout(() => (c.closed = true), pick.endMs);
      else if (c) c.closed = true;
      return [200, { ok: true }];
    }
    if (name === 'prompt') return fakePrompt(s, receipts, pick, body);
    return [200, { ok: true, accepted: true }];
  });
  return Object.assign(s, { pick, projectId: projectId(projectKey(s.project)) });
}

/** Connection.prompt, as the fake agent host answers it (status 400 for its ValueErrors, as the real host). */
function fakePrompt(s: RemoteStudio, receipts: Map<string, string>, pick: FakeNext, body: Json): [number, unknown] {
  const c = s.chats.find((x) => x.id === body.id);
  const text = String(body.text ?? '');
  const mid = typeof body.clientMessageId === 'string' ? body.clientMessageId : '';
  if (pick.promptError) return [500, { error: pick.promptError }];
  const known = mid && c ? receipts.get(`${c.id}|${mid}`) : undefined;
  if (known !== undefined) {
    if (known !== text) return [400, { error: 'This client message ID was already used for different text', errorType: 'ValueError' }];
    return [200, { accepted: true, duplicate: true, clientMessageId: mid, turnState: 'done' }];
  }
  if (!c || c.closed || c.ready === false) return [400, { error: 'This connection is not ready', errorType: 'ValueError' }];
  if (c.busy) {
    return [400, { error: 'Wait for the current turn, or interrupt it before sending another prompt', errorType: 'ValueError' }];
  }
  if (mid) receipts.set(`${c.id}|${mid}`, text);
  const seq = (Number(c.events.at(-1)?.seq) || 0) + 1;
  c.events.push({ seq, kind: 'user', time: Date.now() / 1000, data: { text, sessionId: c.sessionId, clientMessageId: mid || null } });
  return [200, { accepted: true, duplicate: false, clientMessageId: mid || null, turnState: 'working' }];
}

export function phoneCall(s: RemoteStudio, token: string, method: string, path: string, body?: unknown) {
  return raw(
    s.phonePort(),
    method,
    path,
    phoneHeaders({ [DEVICE_HEADER]: token }, method),
    body === undefined ? undefined : JSON.stringify(body),
  );
}
