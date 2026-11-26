/**
 * Connection methods: subagent, helper, shell and background-tool tracking, and the held-turn / settle timers.
 * Moved out of connection.ts (no change).
 */
import { killVerified } from '../platform/kill_verified.ts';
import { baseAgent } from '../agents/claude_family.ts';
import { type Descendant, descendants, refreshDescendants } from '../platform/descendants.ts';
import { refreshWslDescendants, wslDescendants, wslKillVerified } from '../wsl/procs.ts';
import { clip, isDict, isStr, pyStrip } from '../core/py.ts';
import { log, type Json, get, now } from './conn_util.ts';
import {
  mcpOf,
  copilotMcpOf,
  CLAUDE_SUBAGENT_TOOLS,
  backgroundTask,
  toolEnded,
  toolEcho,
  type BackgroundTool,
  HELPER_BACKGROUND_TEXT,
  NotStoppable,
  subagentEnd,
} from './tool_tracking.ts';
import { AUTONOMOUS_ORIGINS, steerTiming } from './conn_steer.ts';
import type { Connection } from './connection.ts';

export const toolMethods = {
  /** Remember what the agent says each child can do (RFD form: capabilities.cancel). */
  $trackSubagent(this: Connection, params: unknown, at?: number): void {
    const update = isDict(params) ? get(params, 'update') : null;
    if (!isDict(update)) return;
    if (get(update, 'sessionUpdate') !== 'subagent_update') {
      // the child's own config_option_update names the model it runs (the phone's subagent row says it)
      const sid = isDict(params) ? get(params, 'sessionId') : null;
      const own = isStr(sid) ? this.subagents.get(sid) : undefined;
      if (own && get(update, 'sessionUpdate') === 'config_option_update') {
        const options = get(update, 'configOptions');
        for (const o of Array.isArray(options) ? options : []) {
          if (!isDict(o) || (o.id !== 'model' && o.category !== 'model') || !isStr(o.currentValue) || !o.currentValue) continue;
          const pick = (Array.isArray(o.options) ? o.options : []).find((x) => isDict(x) && x.value === o.currentValue);
          const label = isDict(pick) && isStr(pick.name) ? pick.name : '';
          own.model = clip(label || o.currentValue, 80);
        }
      }
      return;
    }
    const child = get(update, 'sessionId');
    if (!isStr(child) || !child || child === this.sessionId) return;
    let entry = this.subagents.get(child);
    if (!entry) this.subagents.set(child, entry = { capabilities: {} });
    // when it started (first seen) and ended, in seconds: the phone's row says how long it has run
    if (typeof at === 'number' && Number.isFinite(at)) {
      if (!(typeof entry.startedAt === 'number')) entry.startedAt = at;
    }
    {
      const sub = isDict(get(update, 'subagent')) ? (get(update, 'subagent') as Json) : update;
      const meta = isDict(get(sub, '_meta')) ? (get(sub, '_meta') as Json) : {};
      const cc = isDict(meta.claudeCode) ? (meta.claudeCode as Json) : {};
      const m = [get(sub, 'model'), meta.model, cc.model, get(update, 'model')].find((v) => isStr(v) && v.trim());
      if (isStr(m)) entry.model = clip(m, 80);
    }
    for (const name of ['title', 'description']) {
      const value = get(update, name);
      if (isStr(value) && pyStrip(value)) entry[name] = clip(value, 500);
    }
    // Where the child works, when the agent says (worktrees/merge.ts: only a helper inside the chat's own worktree holds a merge).
    for (const name of ['cwd', 'worktree', 'worktreePath', 'workingDirectory']) {
      const value = get(update, name);
      if (isStr(value) && pyStrip(value)) entry.cwd = clip(value, 1000);
    }
    if (isDict(get(update, 'capabilities'))) {
      entry.capabilities = update.capabilities;
    }
    const raw = get(update, 'state');
    const state = isDict(raw) ? get(raw, 'state') : raw;
    if (isStr(state)) {
      const was = subagentEnd(entry);
      entry.state = state;
      const why = isDict(raw) ? get(raw, 'stopReason') : null;
      if (isStr(why)) entry.stopReason = clip(why, 40);
      else delete entry.stopReason;
      const how = subagentEnd(entry);
      if (how !== null && typeof entry.endedAt !== 'number' && typeof at === 'number' && Number.isFinite(at)) entry.endedAt = at;
      else if (how === null) delete entry.endedAt;
      // subagent worktrees P3: its end, once per end; and its start again after an end (a SendMessage continued it: in the RFD form
      // that call is not shown as a tool call), as null
      if ((how !== null) !== (was !== null) && this.onSubagentEnded) {
        try {
          this.onSubagentEnded(this, child, how);
        } catch (error) {
          log.exception(error, 'onSubagentEnded failed');
        }
      }
    }
    while (this.subagents.size > 200) {
      this.subagents.delete(this.subagents.keys().next().value!);
    }
  },

  // ---- Claude Code's held turns and the cycles it starts on its own ------------------------------------------------------------
  /**
   * The Claude Code adapter (claude-agent-acp) holds a prompt's response open while background helpers (Agent with
   * run_in_background) that the turn started still run: the reply has ended, but the response comes only once they finish, or when
   * the next prompt arrives (the adapter then settles the held turn at once). It also starts model cycles on its own when a
   * background task finishes, with no prompt at all. Its updates say both: the usage_update of a result carries
   * `_meta['_claude/origin']` (no other update does), `human` for a prompt's result, `task-notification` (and the other kinds in
   * AUTONOMOUS_ORIGINS) for a cycle it started. Only this adapter announces `agentCapabilities._meta.claudeCode`.
   */
  $claudeHolds(this: Connection): boolean {
    const caps = isDict(this.initial) ? get(this.initial, 'agentCapabilities') : null;
    const meta = isDict(caps) ? get(caps, '_meta') : null;
    return isDict(meta) && isDict(get(meta, 'claudeCode'));
  },

  /**
   * Background helpers of this chat still run although no turn may be working (Claude Code's held turns): the chat must not be cut
   * off (Aib.busyList), but it is not busy for the page or the queue.
   */
  helpersRunning(this: Connection): boolean {
    return !this.closed && this.$liveHelpers.size > 0;
  },

  /**
   * A Claude Code background shell of this chat still runs (a long test run started with Bash run_in_background, its reply long
   * ended): like helpersRunning, the chat must not be cut off on quit, update or idle exit (Aib.busyList 'background'), but it is
   * not busy for the page or the queue. Claude Code tells a client like AIB only that the command went to the background (the Bash
   * result's `_meta.claudeCode.toolResponse.backgroundTaskId`), never that it ended, so the end is read from the OS: the agent's
   * processes that started with the command are gone (platform/descendants.ts). A shell whose processes could not be listed counts
   * until a task-notification cycle of Claude Code (it starts one when a background task ends).
   */
  backgroundShellsRunning(this: Connection): boolean {
    if (this.closed || !this.$bgShells.size) return false;
    const now = this.$descendants();
    if (now) {
      const live = new Set(now.map((d) => d.pid));
      for (const [task, pids] of [...this.$bgShells]) {
        if (pids !== null && !pids.some((p) => live.has(p))) {
          this.$bgShells.delete(task);
          log.info('chat %s: background shell %s ended', this.id, task);
        }
      }
    }
    return this.$bgShells.size > 0;
  },

  /** How many processes run under the agent right now (what ending a finished helper's chat takes down); 0 when they cannot be listed. */
  processCount(this: Connection): number {
    return this.$descendants(true)?.length ?? 0;
  },

  /** The background shells this chat counts as running now (task ids), for tests and the log. */
  backgroundShells(this: Connection): string[] {
    return this.backgroundShellsRunning() ? [...this.$bgShells.keys()] : [];
  },

  /**
   * The agent's processes now (platform/descendants.ts), or null when they cannot be listed. A WSL chat's agent is a Linux process:
   * its distro's helper lists them (wsl/procs.ts), from a snapshot a few seconds old at most, else null while a new one is fetched.
   * `fresh`: a Windows snapshot taken now; a WSL snapshot asked for from now on (so null at first: see $afterWslTree).
   */
  $descendants(this: Connection, fresh = false): Descendant[] | null {
    const pid = this.process?.pid;
    if (!pid) return null;
    if (this.wsl) return wslDescendants(this.wsl.distro, pid, fresh ? Date.now() : 0);
    if (fresh) refreshDescendants();
    return descendants(pid);
  },

  /** A WSL chat: `then` with a process snapshot of its distro asked for from now on, once the helper answered (null: it did not). */
  $afterWslTree(this: Connection, then: (now: Descendant[] | null) => void): void {
    const pid = this.process?.pid;
    if (!this.wsl || !pid) return;
    const asked = Date.now();
    const distro = this.wsl.distro;
    void refreshWslDescendants(distro, pid).then(() => {
      if (!this.closed) then(wslDescendants(distro, pid, asked));
    });
  },

  /** The agent's processes now, as the turn begins (an MCP server, the PowerShell tool's own shell): see $markBackground. */
  $noteTurnProcesses(this: Connection): void {
    this.$turnProcesses = null;
    const pid = this.process?.pid;
    if (this.$replaying || !pid) return;
    const now = this.$descendants(true);
    if (now) this.$turnProcesses = new Set(now.map((d) => d.pid));
    else if (this.wsl) {
      // the snapshot comes a moment later: only processes that were already running when the turn began count as the turn's
      const seq = this.promptSeq + 1; // $startTurn counts the turn just after this
      const began = Date.now() / 1000;
      this.$afterWslTree((later) => {
        if (!later || this.promptSeq !== seq || this.$turnProcesses !== null) return;
        // No shell call of this turn yet when the answer came: the distro listed them before any command ran, so all are the
        // turn's. Else by start time (to the hundredth of a second, never later than the real one: wsl/procs.ts; an older helper's
        // whole seconds could make one started a moment before the turn look newer, and Stop would end it with the command).
        const before = ![...this.$tools.values()].some((t) => t.shell && t.turn === seq);
        this.$turnProcesses = new Set(later.filter((d) => before || (d.started !== null && d.started < began)).map((d) => d.pid));
      });
    }
  },

  /**
   * Every agent's tool calls (any session: a helper's shells run in the same agent): which are shell commands, their status, and
   * which moved to the background (Claude Code's backgroundTaskId, the result text; see backgroundTask), so the
   * page can mark the row and Stop can end it. Also notes main-session output for the steer rules (B1, B13).
   */
  $watchTools(this: Connection, params: Json): void {
    if (!this.ready || this.closed) return;
    const update = get(params, 'update');
    if (!isDict(update)) return;
    const kind = get(update, 'sessionUpdate');
    const main = get(params, 'sessionId') === this.sessionId;
    this.$lastOutputAt = this.$now(); // S3: anything on the stream means the agent is not quiet
    if (main && kind === 'tool_call') {
      const m = get(update, '_meta');
      const cc = isDict(m) ? get(m, 'claudeCode') : null;
      const title = get(update, 'title');
      if (!(isDict(cc) && get(cc as Json, 'parentToolUseId')) && isStr(title) && title.trim()) {
        this.$lastStep = title.replace(/\s+/g, ' ').trim().slice(0, 200);
      }
    }
    const meta = get(update, '_meta');
    const claude = isDict(meta) ? get(meta, 'claudeCode') : null;
    if (
      main && this.busy && !this.autonomous &&
      (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') &&
      !(isDict(claude) && get(claude, 'parentToolUseId'))
    ) this.$mainOutput();
    // Subagent worktrees P3: in the adapter's subagents (RFD) form a launch's Agent/Task call and a SendMessage are never shown as tool
    // calls; each becomes a session_message whose messageId is the call's tool_use_id, from the calling session to the child (its
    // session id is its agentId; claude-agent-acp native-subagents.js linkedSessionMessages). That is the stream's word that the call
    // was made, for that agent: the same as the Agent tool call's (onClaudeTool), which the agent can't forge.
    if (kind === 'session_message' && this.onClaudeTool && !this.$replaying) {
      const use = get(update, 'messageId'), to = get(update, 'recipientSessionId'), from = get(update, 'senderSessionId');
      if (isStr(use) && /^toolu_/.test(use) && isStr(to) && to && isStr(from) && from && to !== this.sessionId && this.subagents.has(to)) {
        try {
          this.onClaudeTool(this, 'Agent', use, {}, '', to);
        } catch (error) {
          log.exception(error, 'onClaudeTool failed');
        }
      }
    }
    if (kind === 'session_message' || kind === 'subagent_update') return this.$watchHelper(update, kind, main);
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return;
    const id = get(update, 'toolCallId');
    if (!isStr(id) || !id) return;
    const toolName = isDict(claude) ? get(claude, 'toolName') : null;
    let seen = this.$tools.get(id);
    if (kind === 'tool_call' && !seen) {
      // A shell command: Claude Code's Bash or PowerShell; for the other agents an `execute` tool (Codex exec_command).
      // Never an MCP tool or WebFetch, whatever kind it reports.
      const shell = isStr(toolName) ? toolName === 'Bash' || toolName === 'PowerShell' : get(update, 'kind') === 'execute';
      const parent = isDict(claude) ? get(claude, 'parentToolUseId') : null;
      const toolKind = get(update, 'kind');
      seen = {
        shell,
        edit: toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move',
        toolName: isStr(toolName) ? toolName : null,
        status: '',
        title: isStr(get(update, 'title')) ? get(update, 'title') as string : '',
        since: this.$now(),
        main,
        turn: this.promptSeq,
        parent: isStr(parent) ? parent : null,
        mcp: mcpOf(get(update, 'rawInput')) ?? (baseAgent(this.provider) === 'copilot' ? copilotMcpOf(update) : null),
        echo: !main || isStr(parent) ? toolEcho(update) : null,
      };
      this.$tools.set(id, seen);
      while (this.$tools.size > 300) this.$tools.delete(this.$tools.keys().next().value!);
      if (shell) {
        if (!this.$shellCalls.has(id)) this.$shellCalls.set(id, seen.since);
        while (this.$shellCalls.size > 200) this.$shellCalls.delete(this.$shellCalls.keys().next().value!);
      }
    }
    const status = get(update, 'status');
    if (seen && isStr(status)) seen.status = status;
    // Subagent worktrees (P2): the main agent's Agent / SendMessage / TaskStop calls, from the stream the agent can't forge
    const named = seen?.toolName ?? (isStr(toolName) ? toolName : null);
    if (main && this.onClaudeTool && named && CLAUDE_SUBAGENT_TOOLS.has(named) && !seen?.parent) {
      const raw = get(update, 'rawInput');
      try {
        const response = isDict(claude) ? get(claude, 'toolResponse') : null;
        const agentId = isDict(response) ? get(response, 'agentId') : null;
        this.onClaudeTool(this, named, id, isDict(raw) ? raw : {}, isStr(status) ? status : '', isStr(agentId) ? agentId : '');
      } catch (error) {
        log.exception(error, 'onClaudeTool failed');
      }
    }
    const delegating = /^Delegating to agent/.test(String(get(update, 'title') ?? ''));
    if (main && this.onGeminiTool && isStr(status) && (this.$geminiCalls.has(id) || id.startsWith('invoke_agent') || delegating)) {
      this.$geminiCalls.add(id); // its later updates may carry another title (an error's)
      while (this.$geminiCalls.size > 100) this.$geminiCalls.delete(this.$geminiCalls.values().next().value!);
      const title = get(update, 'title');
      try {
        this.onGeminiTool(this, id, isStr(title) ? title : '', status);
      } catch (error) {
        log.exception(error, 'onGeminiTool failed');
      }
    }
    if (kind !== 'tool_call_update') return;
    const background = this.$bgTools.get(id);
    if (background) {
      // Codex: the command's completed update comes after the turn.
      if (background.state === 'running' && toolEnded(update, this.$claudeHolds())) this.$backgroundEnded(id, background, 'done');
      return;
    }
    const task = backgroundTask(update, this.$claudeHolds());
    if (task) this.$markBackground(id, task);
    if (seen?.shell && this.queue.steer.length && (task || toolEnded(update, this.$claudeHolds()))) void this.$steerPump();
  },

  /**
   * The tool `id` went on running in the background as `task`. Notes the agent's processes that started with the command: not there
   * when the turn began, and not older than its tool call (two seconds of slack for ps's whole-second start times). An older one (an
   * MCP server, the PowerShell tool's own shell) is not it. None: the command already ended. A process of unknown age counts as
   * running (never cut one off) but makes Stop unavailable. Stop is offered only for a shell command whose processes cannot belong
   * to another command (no other shell command running, none started since this one) and whose start times are known.
   */
  $markBackground(this: Connection, id: string, task: string, onlyIfRunning = false): void {
    try {
      this.onBackgroundTask?.(this, task, id);
    } catch (error) {
      log.exception(error, 'onBackgroundTask failed');
    }
    if (this.$bgShells.has(task) || this.$bgTools.has(id)) return;
    const since = this.$shellCalls.get(id) ?? this.$tools.get(id)?.since ?? this.$now() - 10;
    const now = this.$descendants(true); // the command started a moment ago: a snapshot from before it would not have it
    const before = this.$turnProcesses;
    const commandOf = (list: Descendant[] | null) => {
      const turn = this.$turnProcesses ?? before; // a WSL turn's own snapshot may have come in meanwhile
      const mine = list ? list.filter((d) => !turn?.has(d.pid) && (d.started === null || d.started >= since - 2)) : null;
      const taken = new Set([...this.$bgTools.values()].filter((t) => t.state === 'running').flatMap((t) => t.procs ?? []).map((p) => p.pid));
      return mine ? mine.filter((d) => !taken.has(d.pid)) : null;
    };
    const pids = commandOf(now);
    const at = this.$now();
    const shell = this.$tools.get(id)?.shell ?? this.$shellCalls.has(id);
    const others = () =>
      [...this.$tools].some(([other, t]) =>
        other !== id && t.shell &&
        (t.since >= since - 2 || !['completed', 'failed'].includes(t.status) || this.$bgTools.get(other)?.state === 'running')
      );
    if (this.wsl && pids === null) {
      // A WSL chat's snapshot comes a moment later from its distro: until then the command counts as running (pids unknown) and has
      // no Stop; then its processes are noted (Stop offered on the same terms as on Windows, `others` asked again: a shell call
      // started meanwhile would share the snapshot), or, with none, it is done (as when a Windows snapshot finds none).
      this.$afterWslTree((later) => {
        const found = commandOf(later);
        const t = this.$bgTools.get(id);
        if (found === null || this.$bgShells.get(task) !== null || t?.state !== 'running') return;
        if (!found.length) return this.$backgroundEnded(id, t, 'done');
        this.$bgShells.set(task, found.map((d) => d.pid));
        if (shell && this.$turnProcesses !== null && found.every((d) => d.started !== null) && !others()) {
          t.procs = found.map((d) => ({ pid: d.pid, started: d.started as number }));
          t.stoppable = true;
          this.$announceBackground(id);
        }
        log.info('chat %s: background tool %s runs as processes %s%s', this.id, id, found.map((d) => d.pid).join(', '), t.stoppable ? '' : ', no Stop');
      });
    }
    if (pids && !pids.length) {
      if (onlyIfRunning) return;
      this.$bgTools.set(id, { task, state: 'done', procs: null, stoppable: false, since, at, endedAt: at });
      this.$trimBackground();
      this.$announceBackground(id);
      return;
    }
    this.$bgShells.set(task, pids ? pids.map((d) => d.pid) : null);
    this.$shellSince.set(task, at);
    this.$shellsSeen = null;
    while (this.$bgShells.size > 100) this.$bgShells.delete(this.$bgShells.keys().next().value!);
    const known = pids !== null && before !== null && pids.every((d) => d.started !== null);
    const stoppable = shell && known && !others();
    const procs = stoppable ? pids!.map((d) => ({ pid: d.pid, started: d.started as number })) : null;
    this.$bgTools.set(id, { task, state: 'running', procs, stoppable, since, at, endedAt: null });
    this.$trimBackground();
    this.$announceBackground(id);
    log.info(
      'chat %s: tool %s went to the background as %s (%s%s)',
      this.id,
      id,
      task,
      pids ? `processes ${pids.map((d) => d.pid).join(', ')}` : 'processes unknown',
      stoppable ? '' : ', no Stop',
    );
  },

  /**
   * Claude Code helpers (recording C2): a steer moves a foreground helper to the background, and the adapter says so in the main
   * session with a session_message `<toolUseId>:reply` from the helper's session, "Async agent launched successfully". Its row (the
   * Agent tool call, and the helper's card in the Activity pane) is marked running in the background, without Stop; it is done once
   * the helper's subagent_update leaves running.
   */
  $watchHelper(this: Connection, update: Json, kind: unknown, main: boolean): void {
    if (kind === 'subagent_update') {
      const child = get(update, 'sessionId');
      let state = get(update, 'state');
      state = isDict(state) ? get(state, 'state') : state;
      if (!isStr(child) || !isStr(state) || state === 'running' || state === 'requires_action') return;
      for (const [id, t] of this.$bgTools) {
        if (t.helper === child && t.state === 'running') this.$backgroundEnded(id, t, 'done');
      }
      return;
    }
    if (!main) return;
    const messageId = get(update, 'messageId');
    const sender = get(update, 'senderSessionId');
    if (!isStr(messageId) || !messageId.endsWith(':reply') || !isStr(sender) || sender === this.sessionId) return;
    const content = get(update, 'content');
    const text = (Array.isArray(content) ? content : []).map((b) => (isDict(b) && isStr(b.text) ? b.text : '')).join('');
    if (!HELPER_BACKGROUND_TEXT.test(text)) return;
    const id = messageId.slice(0, -':reply'.length);
    if (!id || this.$bgTools.has(id) || !this.$liveHelpers.has(sender)) return;
    const at = this.$now();
    this.$bgTools.set(id, {
      task: `helper:${sender}`,
      state: 'running',
      procs: null,
      stoppable: false,
      since: this.$tools.get(id)?.since ?? at,
      at,
      endedAt: null,
      helper: sender,
    });
    this.$trimBackground();
    this.$announceBackground(id);
    log.info('chat %s: helper %s (%s) went on in the background', this.id, sender, id);
  },

  /**
   * The page reads a tool row's background state from the row's updates (`update.background = {state, stoppable}`): each change is
   * a tool_call_update of AIB's own for that row. A recorded event (keeper note), so a rebuild has it in the same place; never made
   * while replaying (the note brings it back).
   */
  $announceBackground(this: Connection, id: string): void {
    const t = this.$bgTools.get(id);
    if (!t || this.$replaying) return;
    this.recordedEvent('update', {
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        ...(this.$tools.get(id)?.echo ?? {}),
        background: {
          state: t.state,
          stoppable: t.state === 'running' && t.stoppable && !this.closed,
          ...(t.helper ? { helper: t.helper } : {}),
        },
      },
    });
  },

  $trimBackground(this: Connection): void {
    while (this.$bgTools.size > 100) this.$bgTools.delete(this.$bgTools.keys().next().value!);
  },

  $backgroundEnded(this: Connection, id: string, background: BackgroundTool, state: 'done' | 'stopped'): void {
    background.state = state;
    background.endedAt = this.$now();
    this.$bgShells.delete(background.task);
    log.info('chat %s: background tool %s %s', this.id, id, state === 'done' ? 'ended' : 'was stopped');
    this.$announceBackground(id);
  },

  /**
   * Codex keeps running a command past its turn's end (recording X1): an execute tool of the main session still open when the turn
   * ends, whose processes still run, is a background command from then on (its completed update comes later, with no new turn).
   */
  $backgroundOpenTools(this: Connection, seq: number): void {
    if (this.$claudeHolds()) return; // Claude Code says so itself (backgroundTaskId); its turn never ends with a tool open
    for (const [id, seen] of [...this.$tools]) {
      if (seen.turn !== seq || !seen.main || !seen.shell || this.$bgTools.has(id)) continue;
      if (seen.status === 'completed' || seen.status === 'failed') continue;
      this.$markBackground(id, `open:${id}`, true);
    }
  },

  /** The background tools as the page sees them (snapshot `toolBackground`): {toolCallId: {state, stoppable}}. */
  toolBackground(this: Connection): Record<string, { state: string; stoppable: boolean; helper?: string }> {
    if (!this.$bgTools.size) return {};
    this.backgroundShellsRunning(); // drops shells whose processes ended
    const out: Record<string, { state: string; stoppable: boolean; helper?: string }> = {};
    for (const [id, t] of this.$bgTools) {
      if (t.helper) {
        // a helper ends with its subagent_update; one AIB no longer counts as live (an agent restart) is over too
        if (t.state === 'running' && (this.closed || !this.$liveHelpers.has(t.helper))) this.$backgroundEnded(id, t, 'done');
      } else if (t.state === 'running' && !this.$bgShells.has(t.task)) this.$backgroundEnded(id, t, 'done');
      out[id] = { state: t.state, stoppable: t.state === 'running' && t.stoppable && !this.closed, ...(t.helper ? { helper: t.helper } : {}) };
    }
    return out;
  },

  /**
   * Stop a command running in the background (POST /api/live/tool-stop): AIB kills the processes it noted when the command moved
   * there, re-verified now (still the agent's, same start time) together with what they started since, leaf first
   * (platform/kill_verified.ts; a WSL chat's in its distro: helper `proc.stop`). Refused (NotStoppable, HTTP 409) for anything else:
   * an MCP tool, a command whose processes could not be told apart, one that already ended. The agent learns of it on its own (Claude
   * Code's task notification).
   */
  async stopBackgroundTool(this: Connection, toolCallId: unknown): Promise<Json> {
    this.$refuseReadOnly();
    const background = isStr(toolCallId) ? this.$bgTools.get(toolCallId) : undefined;
    if (!background) throw new NotStoppable('That tool is not running in the background.');
    this.toolBackground();
    if (background.helper) {
      throw new NotStoppable("AIB can't stop a subagent by itself: it runs inside the agent's own process. Ask the agent to stop it.");
    }
    if (background.state !== 'running') throw new NotStoppable('That command is no longer running.');
    if (!background.stoppable || !background.procs?.length) {
      throw new NotStoppable('AIB cannot tell which processes belong to this command, so it cannot stop it.');
    }
    const pid = this.process?.pid;
    if (this.closed || !pid) throw new NotStoppable('The agent is not running.');
    // a WSL chat's pids are the distro's: its helper runs the same verified kill there (never killVerified here, on Windows processes)
    const result = this.wsl ? await wslKillVerified(this.wsl.distro, pid, background.procs) : await killVerified(pid, background.procs);
    if (!result) throw new NotStoppable('AIB cannot list the processes right now. Try again.');
    if (!result.killed.length) {
      this.$backgroundEnded(toolCallId as string, background, 'done');
      return { ok: true, toolCallId, state: 'done', killed: 0 };
    }
    this.$backgroundEnded(toolCallId as string, background, 'stopped');
    log.info('chat %s: stopped background tool %s (processes %s)', this.id, toolCallId, result.killed.map((k) => k.pid).join(', '));
    return { ok: true, toolCallId, state: 'stopped', killed: result.killed.length };
  },

  /** A helper started during the current prompt turn is still running (or waits for the user). */
  $helpersRunning(this: Connection): boolean {
    for (const child of this.$turnHelpers) {
      const state = this.subagents.get(child)?.state;
      if (state === 'running' || state === 'requires_action') return true;
    }
    return false;
  },

  /** Main-session output of the running prompt turn: a steer before it was read (B13), and a pending early end is off (B1). */
  $mainOutput(this: Connection): void {
    this.$steerTurn.outputAfter = true;
    this.$steerTurn.unread = [];
    this.$clearSettle();
  },

  $clearSettle(this: Connection): void {
    if (this.$settleTimer !== null) clearTimeout(this.$settleTimer);
    this.$settleTimer = null;
  },

  /** End the held turn early once steerTiming.settleMs pass with no main-session output (which clears the timer). */
  $armSettle(this: Connection, early: { seq: number; fire: () => void }): void {
    this.$clearSettle();
    this.$settleTimer = setTimeout(() => {
      this.$settleTimer = null;
      if (this.$endEarly !== early || !this.busy || this.autonomous || this.cancelSeq >= early.seq || !this.$helpersRunning()) return;
      this.$endEarly = null;
      early.fire();
    }, steerTiming.settleMs);
  },

  /**
   * One session/update seen (after it is recorded): ends a prompt turn whose reply ended while its helpers still run, and shows a
   * cycle Claude Code started on its own as working until its result. Same on a rebuild from the keeper's record, which replays the
   * same lines. Returns a promise when the turn's end must be handled before the next line is read.
   */
  $watchHeldTurn(this: Connection, params: Json): Promise<void> | void {
    if (!this.ready || this.closed || !this.$claudeHolds()) return;
    const update = get(params, 'update');
    if (!isDict(update)) return;
    const kind = get(update, 'sessionUpdate');
    if (kind === 'subagent_update') {
      const child = get(update, 'sessionId');
      let state = get(update, 'state');
      state = isDict(state) ? get(state, 'state') : state;
      const live = state === 'running' || state === 'requires_action';
      if (isStr(child) && live && this.busy && !this.autonomous) {
        this.$turnHelpers.add(child);
      }
      if (isStr(child) && live) {
        this.$liveHelpers.add(child);
        if (!this.$helperSince.has(child)) this.$helperSince.set(child, this.$now());
      } else if (isStr(child) && isStr(state)) {
        const had = this.$liveHelpers.size;
        this.$liveHelpers.delete(child);
        this.$helperSince.delete(child);
        if (had && !this.$liveHelpers.size) this.$workEndedAt = this.$now(); // the follow-up window starts (inbox-rules.js)
      }
      return;
    }
    if (get(params, 'sessionId') !== this.sessionId) return; // a subagent's own updates
    const meta = get(update, '_meta');
    if (kind === 'usage_update') {
      const origin = isDict(meta) ? get(meta, '_claude/origin') : null;
      if (!isDict(origin)) return; // usage during the turn, not a result
      if (get(origin, 'kind') === 'task-notification') {
        // A background task ended: one shell whose processes could not be listed stops counting (the others are read from the OS).
        const unknown = [...this.$bgShells].find(([, pids]) => pids === null);
        if (unknown) this.$bgShells.delete(unknown[0]);
        // ...and a row marked running in the background whose processes are gone is done now, not at the next snapshot (the process
        // list is cached for a second): Claude Code sends nothing else for the command (recording C1); a WSL chat's, once its
        // distro answered
        if (this.wsl) this.$afterWslTree(() => this.toolBackground());
        else refreshDescendants();
        this.toolBackground();
      }
      if (this.autonomous) return this.$endAutonomous('end_turn');
      const early = this.$endEarly;
      if (
        early && this.busy && !AUTONOMOUS_ORIGINS.has(get(origin, 'kind') as string) && this.cancelSeq < early.seq &&
        this.$helpersRunning()
      ) {
        // B1: a steer interrupts the running cycle, which then ends with a result of its own; the steered message's reply comes
        // after it (in the same cycle, or a cycle of its own, recording C4). So with a steer in this turn, only a result after
        // main-session output that came after the last steer can end the turn early, and only once no more output follows for a
        // moment. A human result is never a turn end by itself.
        if (this.$steerTurn.injected) {
          if (this.$steerTurn.outputAfter) this.$armSettle(early);
          return;
        }
        this.$endEarly = null;
        early.fire();
        return new Promise((resolve) => setTimeout(resolve, 0)); // the turn's end is recorded before what comes after it
      }
      return;
    }
    // Claude Code's own cycle: model output of the main conversation while no prompt runs.
    if (
      !this.busy && (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') &&
      !(isDict(meta) && isDict(get(meta, 'claudeCode')) && get(get(meta, 'claudeCode') as Json, 'parentToolUseId'))
    ) {
      this.autonomous = true;
      this.busy = true;
      this.turnStartedAt = now();
      this.error = '';
    }
  },

  /** Claude Code's own cycle ended (its result came, or it was stopped): the chat is idle again and the queue goes on. */
  $endAutonomous(this: Connection, stopReason: string): Promise<void> {
    this.autonomous = false;
    this.turnEndedAt = this.$now();
    if (stopReason !== 'cancelled') this.$noteAsks();
    const result = { stopReason };
    this.$queueNoteOutcome(result, false);
    this.event('turn_end', result);
    const done = (async () => {
      const hook = this.onTurnEnd;
      if (hook && !this.$replaying && stopReason !== 'cancelled') {
        try {
          await hook(this);
        } catch (error) {
          log.exception(error, 'on_turn_end hook failed');
        }
      }
      if (this.onTurnCancelled && !this.$replaying && stopReason === 'cancelled') {
        await Promise.resolve(this.onTurnCancelled(this)).catch((error) => log.exception(error, 'on_turn_cancelled hook failed'));
      }
      await this.$finishTurn();
      await this.$queueAfterTurn();
      if (!this.$replaying) this.$scheduleSnapshot();
    })().catch((error) => log.exception(error, 'Ending a cycle the agent started on its own failed'));
    this.turn = done;
    return new Promise((resolve) => setTimeout(resolve, 0));
  },
};

export type ToolMethods = typeof toolMethods;
