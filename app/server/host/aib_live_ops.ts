/**
 * The live calls (Aib.$liveCall): ONE table, op name -> {post, run}. It is the single source of truth for which calls exist and which
 * of them the page may POST (/api/live/<name>); LIVE_POST_OPS is derived from it (web/live_routes.ts routes exactly those).
 * A new live op is one entry here. `post: false` is internal (host-to-host or web-server calls): no page route reaches it.
 * Moved out of aib_calls.ts (no change in behaviour).
 */
import { NotStoppable } from '../acp/connection.ts';
import type { Connection } from '../acp/connection.ts';
import { sessionOp } from '../acp/breadth.ts';
import { isCodexFamily } from '../agents/claude_family.ts';
import { isDict, isStr, ValueError } from '../core/py.ts';
import { wslLoc } from '../wsl/access.ts';
import { projectKey } from '../desktop/project_delete.ts';
import { type Json, KeyError, log, need, SWARM_ACTION_LABELS, SWARM_NOTE_ACTIONS, SWARM_NOTE_KINDS } from './aib_util.ts';
import { LANDING_TTL_MS, readHelperOf, readOwnCopy, readPicks } from './aib_options.ts';
import type { Aib } from './aib.ts';

type Reply = [number, unknown];
export type LiveRun = (this: Aib, body: Json) => Promise<Reply> | Reply;
export interface LiveOp {
  /** True: the page may POST it (the generic POST /api/live/<name> routes). False: internal. */
  post: boolean;
  run: LiveRun;
}

const LIVE_OPS = new Map<string, LiveOp>();
const op = (name: string, post: boolean, run: LiveRun) => {
  if (LIVE_OPS.has(name)) throw new KeyError(name);
  LIVE_OPS.set(name, { post, run });
};
/** An op on one open chat: the chat is looked up first (this.$connection), like every chat call. */
const onChat = (name: string, post: boolean, run: (this: Aib, c: Connection, body: Json) => Promise<Reply> | Reply) =>
  op(name, post, function (body) {
    return run.call(this, this.$connection(body), body);
  });
/** The "handled" mark of a reply that acted for the person (replying, queueing, scheduling). */
async function markHandled(this: Aib, c: Connection, result: { duplicate?: boolean }): Promise<void> {
  if (c.provider && c.sessionId && !result.duplicate) await this.$mark('handled', c);
}
const OK: Reply = [200, { ok: true }];

// ---- the page's calls (POST /api/live/<name>); keep this order (LIVE_POST_OPS follows it) -----------------------------------
op('connect', true, async function (body) {
  const background = body.background ?? false;
  if (typeof background !== 'boolean') throw new ValueError('background must be a boolean');
  const continueAnyway = body.continueAnyway ?? false;
  if (typeof continueAnyway !== 'boolean') throw new ValueError('continueAnyway must be a boolean');
  const provider = need(body, 'provider');
  const cwd = need(body, 'cwd');
  // Second guard: a page that starts a chat in "its" project names that project; a folder of another project is refused, so a
  // window with a stale or unknown project can never start a chat somewhere else.
  if (body.project !== undefined && body.project !== null && body.project !== '') {
    if (!isStr(body.project)) throw new ValueError('project must be text');
    if (projectKey(cwd) !== body.project) {
      throw new ValueError(`This chat was asked to start in project ${body.project}, but the folder ${String(cwd)} belongs to another project. Nothing was started.`);
    }
  }
  const connection = await this.connect(provider as string, cwd as string, (body.resume ?? null) as string | null, {
    background,
    continueAnyway,
    picks: readPicks(body.picks),
    helperOf: readHelperOf(body.helperOf),
    forkFrom: typeof body.forkFrom === 'string' && body.forkFrom.length < 200 ? body.forkFrom : null,
    ownCopy: readOwnCopy(body.ownCopy),
  });
  return [200, connection.public()];
});
op('discover', true, async function (body) { return [200, await this.listAgentSessions(need(body, 'provider'), body.cwd ?? null, body.cursor ?? null)]; });
op('forget', true, function (body) { return [200, { ok: true, forgotten: this.forgetRecovered(body.provider, body.sessionId) }]; });
onChat('prompt', true, async function (c, body) {
  const result = await c.prompt(body.text ?? '', (body.clientMessageId ?? null) as string | null, body.attachments ?? null);
  await markHandled.call(this, c, result); // replying is acting
  return [200, { ok: true, ...result }];
});
onChat('cancel', true, function (c, body) {
  c.cancel(body.subagentSessionId ?? null);
  return OK;
});
onChat('permission', true, function (c, body) {
  c.permission(need(body, 'key'), body.option ?? null);
  return OK;
});
onChat('authenticate', true, function (c, body) {
  c.answerAuth(need(body, 'action'), body.methodId ?? null);
  return OK;
});
onChat('elicitation', true, function (c, body) {
  c.answerElicitation(need(body, 'key'), need(body, 'action'), body.content ?? null);
  return OK;
});
onChat('config', true, async function (c, body) {
  const result = await c.changeSetting('config', need(body, 'configId'), need(body, 'value')); // queued during a turn
  this.rememberOptions(c);
  return [200, { ok: true, ...result }];
});
onChat('mode', true, async function (c, body) {
  const result = await c.changeSetting('mode', null, need(body, 'modeId'));
  this.rememberOptions(c);
  return [200, { ok: true, ...result }];
});
onChat('cancel-pending', true, function (c, body) { return [200, { ok: true, pendingChanges: c.cancelPending(need(body, 'key')) }]; });
onChat('session-op', true, async function (c, body) {
  if (body.op === 'open-here') {
    // open elsewhere: Open here / Open here anyway on the chat's line (ownership/handoff.ts); nothing is sent to the agent but session/load
    return [200, { ok: true, ...(await c.reclaim(body.force === true)) }];
  }
  if (body.op === 'let-go') {
    // the Let go icon on a Codex chat: let another app open it now (idle only; ownership/handoff.ts)
    if (!isCodexFamily(c.provider)) throw new ValueError('Let go is for Codex chats.');
    if (c.elsewhere?.released) return [200, { ok: true, state: 'already' }];
    const state = await c.letGoIdle(
      { pid: 0, entrypoint: 'let-go', status: '', app: 'another app' },
      'AIB let go of this chat so another app can open it. Open it here to take it back.',
    );
    return [200, {
      ok: true,
      state,
      ...(state === 'busy' ? { message: 'This chat is working, so AIB did not let go. Try again when it is idle.' } : {}),
      ...(state === 'no' ? { message: 'AIB could not let go of this chat right now.' } : {}),
    }];
  }
  const deletedRef = body.op === 'delete' ? [c.provider, c.sessionId] : null;
  const result = await sessionOp(c as never, body);
  const payload: Json = { ok: true, ...result };
  if (deletedRef && result.done === 'delete') payload._deleted = deletedRef; // the web layer owns conversation marks and removes this key
  return [200, payload];
});
onChat('disconnect', true, async function (c) {
  await c.close();
  if (c.worktree) {
    void this.retireMerged().then(() => this.retireStoppedHelpers()).catch((error) => log.exception(error, 'Removing merged copies failed'));
  }
  return OK;
});
onChat('queue', true, async function (c, body) {
  const result = await c.queueAdd(body.text ?? '', (body.clientMessageId ?? null) as string | null, body.attachments ?? null);
  await markHandled.call(this, c, result); // queueing is acting
  return [200, { ok: true, ...result }];
});
onChat('queue-edit', true, async function (c, body) {
  const edited = await c.queueEdit(need(body, 'messageId') as string, need(body, 'action'), (body.leaseId ?? null) as string | null, body.text ?? null);
  return [200, edited];
});
onChat('queue-remove', true, async function (c, body) { return [200, await c.queueRemove(need(body, 'messageId') as string)]; });
onChat('queue-move', true, async function (c, body) { return [200, await c.queueMove(need(body, 'messageId') as string, need(body, 'to'))]; });
onChat('queue-resume', true, async function (c) { return [200, await c.queueResume()]; });
onChat('queue-send-now', true, async function (c, body) { return [200, await c.queueSendNow(need(body, 'messageId') as string, body.interrupt === true)]; });
onChat('steer', true, async function (c, body) { // send now while the agent works (steer-on-send); idle: an ordinary prompt
  const result = await c.steer(body.text ?? '', (body.clientMessageId ?? null) as string | null, body.attachments ?? null);
  await markHandled.call(this, c, result); // replying is acting
  return [200, { ok: true, ...result }];
});
onChat('tool-stop', true, async function (c, body) { // Stop on a "Still running in the background" row
  try {
    return [200, await c.stopBackgroundTool(need(body, 'toolCallId'))];
  } catch (error) {
    if (error instanceof NotStoppable) return [409, { error: error.message, code: 'not_stoppable' }];
    throw error;
  }
});
onChat('schedule', true, async function (c, body) { // Send later: the message waits for `at` (epoch ms), then joins the queue like any Send
  const result = await c.scheduleAdd(body.text ?? '', need(body, 'at'), (body.clientMessageId ?? null) as string | null, body.attachments ?? null);
  await markHandled.call(this, c, result); // scheduling is acting
  return [200, result];
});
onChat('schedule-edit', true, async function (c, body) { return [200, await c.scheduleEdit(need(body, 'messageId') as string, body.text ?? null, body.at ?? null)]; });
onChat('schedule-cancel', true, async function (c, body) { return [200, await c.scheduleCancel(need(body, 'messageId') as string)]; });
onChat('schedule-send-now', true, async function (c, body) { return [200, await c.scheduleSendNow(need(body, 'messageId') as string)]; });
op('dismiss-unknown', true, function (body) {
  let { provider, sessionId } = body;
  const messageId = body.clientMessageId;
  if (isStr(body.id) && this.connections.has(body.id)) {
    const connection = this.connections.get(body.id)!;
    provider = connection.provider;
    sessionId = connection.sessionId;
  }
  if (!(this.store && isStr(provider) && isStr(sessionId) && isStr(messageId))) {
    throw new ValueError('provider, sessionId and clientMessageId are required');
  }
  return [200, { ok: true, dismissed: this.store.dismissReceipt(provider, sessionId, messageId) }];
});
op('worktree-archive', true, async function (body) { return [200, await this.worktreeArchive(body)]; });

// ---- internal calls (post: false): host and web-server code only; no page route reaches them --------------------------------
op('agent-options', false, async function (body) { return [200, await this.agentOptionsFor(body)]; }); // POST /api/live/agent-options (web/live_routes.ts, its own route)
op('tool-servers', false, async function (body) { return [200, await this.$toolServersCall(body)]; }); // POST /api/live/tool-servers (web/live_routes.ts, its own route)
op('agent-title', false, function (body) { // web/server.ts chat-name, remote rename
  const queued = this.agentTitles.request(String(need(body, 'provider')), String(need(body, 'sessionId')), String(body.title ?? ''), isStr(body.cwd) ? body.cwd : '');
  return [200, { ok: true, queued }];
});
op('agent-title-state', false, function () { return [200, { waiting: this.agentTitles.waiting(), done: this.agentTitles.done }]; }); // tests
op('bg-gone', false, async function (body) { return [200, await this.backgroundStatus(String(need(body, 'sessionId')), body.calls)]; }); // web/server.ts
op('worktree-note', false, function (body) { // worktrees/merge.ts
  const connection = this.$connection(body);
  const data: Json = { message: [...String(need(body, 'message'))].slice(0, 300).join(''), sessionId: connection.sessionId };
  const actions = (Array.isArray(body.actions) ? body.actions : [])
    .filter((a) => isDict(a) && (a.id === 'keep-mine' || a.id === 'leave')) // buttons in the note: only AIB's own two
    .map((a) => ({ id: (a as Json).id, label: [...String((a as Json).label || (a as Json).id)].slice(0, 40).join('') }));
  if (actions.length) data.actions = actions;
  connection.recordedEvent('studio_note', data);
  return OK;
});
op('swarm-note', false, function (body) { // swarm/service.ts: a swarm line in the main chat
  const connection = this.$connection(body);
  const kind = String(body.kind ?? '');
  if (!SWARM_NOTE_KINDS.includes(kind)) throw new ValueError('Unknown swarm note');
  const data: Json = {
    message: [...String(need(body, 'message'))].slice(0, 300).join(''),
    sessionId: connection.sessionId,
    kind,
    helper: String(body.helper ?? '').slice(0, 20),
  };
  const actions = (Array.isArray(body.actions) ? body.actions : []).filter((a) => isDict(a) && SWARM_NOTE_ACTIONS.includes(String(a.id)))
    .map((a) => ({ id: (a as Json).id, label: SWARM_ACTION_LABELS[String((a as Json).id)], helper: data.helper }));
  if (actions.length) data.actions = actions;
  connection.recordedEvent('studio_note', data);
  return OK;
});
// Build plan 1b, 2.3 (MF 2): the landing lock and its friends (swarm/service.ts, worktrees/merge.ts).
const landing = (name: 'landing-lock' | 'landing-renew' | 'landing-release') =>
  op(name, false, function (body) {
    const connection = this.$connection(body);
    const lock = String(need(body, 'lock'));
    const ttl = Math.min(Math.max(Number(body.ttlMs) || LANDING_TTL_MS, 50), 10 * 60_000);
    if (name === 'landing-lock') {
      const why = connection.landingLock(lock, String(body.owner ?? ''), String(body.title ?? '').slice(0, 120), ttl, body.builder === true);
      return [200, { ok: !why, reason: why }];
    }
    if (name === 'landing-renew') return [200, { ok: connection.landingRenew(lock, ttl) }];
    return [200, { ok: connection.landingRelease(lock) }];
  });
landing('landing-lock');
landing('landing-renew');
landing('landing-release');
op('worktree-retire', false, async function () { // P4b: merged helpers' copies, stopped helpers' copies after 7 days (web: after the take-over)
  const removed = await this.retireMerged();
  const stopped = await this.retireStoppedHelpers().catch((error) => (log.exception(error, 'Stopped helpers failed'), [] as string[]));
  return [200, { ok: true, removed, stopped }];
});
op('subagent-release', false, async function (body) { // swarm/service.ts: a landed / empty / discarded subagent's worktree goes (P2)
  if (!this.subagents) return [404, { error: 'No subagent worktrees here' }];
  return [200, { ok: true, result: await this.subagents.release(String(need(body, 'subagent'))) }];
});
op('helper-end', false, async function (body) { // swarm/service.ts #endHelper: a finished helper's chat ends, so its agent and everything under it stop
  const connection = this.$connection(body);
  const processes = connection.processCount();
  await connection.close(); // the keeper channel's job (Windows) or process group is killed: exact for every provider
  if (connection.worktree) void this.retireMerged().catch((error) => log.exception(error, 'Removing merged copies failed'));
  return [200, { ok: true, processes }];
});
op('helper-release', false, async function (body) { // swarm/service.ts #cleanup: a merged helper's worktree and branch go (the swarm checked it is merged and clean)
  const path = String(body.path ?? '');
  const record = path && this.worktrees ? await this.$worktreeRecord(path, null) : null;
  if (!record) return [200, { ok: true, result: 'gone' }];
  const branch = String(record.branch ?? '');
  if (!branch.startsWith('studio/helper-') || branch !== String(body.branch ?? '') || wslLoc(path)) {
    return [409, { error: 'Not a helper copy of this host' }]; // never any other chat's worktree
  }
  const session = String(record.session ?? '');
  const at = session.indexOf(':');
  if (this.$connectionsIn(path).length || (at > 0 && (await this.$openAnywhere(session.slice(0, at), session.slice(at + 1), path)))) {
    return [200, { ok: true, result: 'open' }];
  }
  return [200, { ok: true, result: await this.$removeWorktree({ ...record }, false) }]; // never confirmed: git refuses a worktree with edits
});
op('history-forget', false, async function (body) { // web/shared.ts conversationAction: the person deleted the chat
  return [200, { ok: true, removed: await this.forgetHistory(String(body.provider ?? ''), String(body.sessionId ?? '')) }];
});
op('files-changed', false, function (body) { // files/live_files.ts: write calls that finished since `after`
  const after = Number(body.after) || 0;
  return [200, { instance: this.instanceId, seq: this.$filesSeq, events: this.$filesChanged.filter((e) => e.seq > after) }];
});
op('prompt-context', false, function (body) { // a one-time line in front of this chat's next prompt (a landing told it what changed)
  const connection = this.$connection(body);
  const replace = typeof body.replace === 'string' ? body.replace.slice(0, 600) : '';
  const max = Math.min(Math.max(Number(body.max) || 2000, 1), 9000); // a fork's summary is longer than a note
  this.addPromptContext(connection, [...String(need(body, 'line'))].slice(0, max).join(''), replace);
  return OK;
});
op('folder-chats', false, function (body) { // the open chats that work in this folder itself (not copies, not helpers)
  const chats = this.folderChats(String(need(body, 'folder'))).map((c) => ({
    id: c.id,
    title: this.chatTitle(c),
    idle: c.landingIdleReason(),
    landing: c.landing ? c.landing.title : '',
  }));
  return [200, { chats }];
});

/** The op's entry, or undefined (an unknown name is a 404 in $liveCall). */
export function liveOp(name: string): LiveOp | undefined {
  return LIVE_OPS.get(name);
}

/** Aib.LIVE_POST_OPS: the generic POST /api/live/<name> calls, derived from the table (web/live_routes.ts routes exactly these). */
export const LIVE_POST_OPS: ReadonlySet<string> = new Set([...LIVE_OPS].filter(([, entry]) => entry.post).map(([name]) => name));
