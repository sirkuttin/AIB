/**
 * Connection methods: starting a session (initialize, authenticate, session/new and load, start picks) and sign-in.
 * Moved out of connection.ts (no change).
 */
import { augmentInitialize, checkMode, type McpServer, optionValues, selectMcpServers, sessionCapabilities, advertisesFork } from './breadth.ts';
import { LineMerger } from '../history/lines.ts';
import { describeAuthMethods, isAuthRequired, RpcError } from './rpc_errors.ts';
import { findOption as findPickOption } from '../state/agent_options.ts';
import { betaAgent } from '../agents/beta_catalog.ts';
import { offeredModeIds, resolveMode } from '../agents/mode_ids.ts';
import { isClaudeFamily } from '../agents/claude_family.ts';
import { APP_VERSION } from '../core/app.ts';
import { clip, isDict, isStr, pyTypeName, ValueError } from '../core/py.ts';
import { log, type Json, RuntimeError, TimeoutError, errorText, pget, get, pyEq, now } from './conn_util.ts';
import { ThreadEvent } from './thread_text.ts';
import { type AuthState, type Pending } from './conn_types.ts';
import { MAX_LINES_NOTE_BYTES, linesWithin } from './conn_limits.ts';
import { CODEX_MCP_STARTUP_WAIT_MS } from './prompts.ts';
import { isOwnArtifactEntry } from './tool_tracking.ts';
import { TERMINAL_SIGNIN_PROVIDERS } from './conn_steer.ts';
import { ReplayWindow } from './replay_window.ts';
import type { Connection } from './connection.ts';

export const setupMethods = {
  /** self.settings.setdefault('modes', {}): a non-dict value fails as item assignment does. */
  $modes(this: Connection): Json {
    if (!Object.hasOwn(this.settings, 'modes')) this.settings.modes = {};
    const modes = this.settings.modes;
    if (!isDict(modes)) {
      throw new TypeError(
        `'${pyTypeName(modes)}' object does not support item assignment`,
      );
    }
    return modes;
  },

  /** Kill the agent's client terminals; never throws. */
  $shutdownCaps(this: Connection): Promise<void> {
    try {
      return Promise.resolve(this.caps.shutdown()).catch((error) => log.exception(error, 'Stopping client terminals failed'));
    } catch (error) {
      log.exception(error, 'Stopping client terminals failed');
      return Promise.resolve();
    }
  },

  releaseLease(this: Connection): void {
    const lease = this.sessionLease;
    this.sessionLease = null;
    if (lease) lease.release();
    const hook = this.onRelease;
    if (hook) {
      try {
        const result = hook(this);
        if (result instanceof Promise) {
          result.catch((error) => log.exception(error, 'on_release hook failed'));
        }
      } catch (error) {
        log.exception(error, 'on_release hook failed');
      }
    }
  },

  $pausedForUser(this: Connection): boolean {
    return !!(this.elicitations.size || this.permissions.size ||
      (this.auth && !this.auth.working));
  },

  /** Like request(), but the timeout clock stops while a person is being asked something. */
  async setupRequest(
    this: Connection,
    method: string,
    params: unknown,
    timeout: number,
  ): Promise<unknown> {
    if (method === 'initialize') params = augmentInitialize(params as Json);
    this.counter += 1;
    const key = this.counter;
    const entry: Pending = { done: new ThreadEvent(), method, params };
    this.pending.set(key, entry);
    try {
      this.write({ jsonrpc: '2.0', id: key, method, params });
      let waited = 0;
      while (!(await entry.done.wait(250))) {
        if (!this.$pausedForUser()) waited += 0.25;
        if (waited >= timeout) {
          throw new TimeoutError(
            `${method} did not respond within ${timeout} seconds`,
          );
        }
      }
      const response = entry.response!;
      if (Object.hasOwn(response, 'error')) throw new RpcError(response.error);
      return Object.hasOwn(response, 'result') ? response.result : {};
    } finally {
      this.pending.delete(key);
    }
  },

  $checkSetupAbort(this: Connection): void {
    if (this.setupAbort) throw new ValueError(this.setupAbort);
  },

  /** Fail connection setup now (e.g. the person declined a setup question). */
  abortSetup(this: Connection, message: string): void {
    this.setupAbort = this.setupAbort || message;
    for (const entry of [...this.pending.values()]) {
      if (!entry.done.isSet()) {
        entry.response = { error: { message, code: null } };
        entry.done.set();
      }
    }
    this.authResponse = ['cancel', null];
    this.authEvent.set();
  },

  async $setupSessionCall(this: Connection, method: string, params: Json): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await this.setupRequest(method, params, 90);
        this.$checkSetupAbort();
        return result;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        this.$checkSetupAbort();
        if (!isAuthRequired(error)) throw error;
        if (attempt === 3) {
          throw new ValueError(
            'The agent still reports that sign-in is required. ' +
              error.message,
          );
        }
        await this.$awaitAuth(error);
      }
    }
    throw new ValueError('Sign-in did not complete');
  },

  /** Hold connection setup until the person signs in, retries, or cancels. */
  async $awaitAuth(this: Connection, error: RpcError): Promise<void> {
    const auth: AuthState = {
      methods: [...this.authMethods],
      message: clip(error.message, 500),
      error: '',
      working: false,
    };
    this.auth = auth;
    this.authResponse = null;
    this.authEvent.clear();
    this.event('auth_required', {
      methods: auth.methods,
      message: auth.message,
    });
    const deadline = now() + 1800;
    try {
      while (true) {
        if (!(await this.authEvent.wait(250))) {
          if (this.closed) {
            throw new RuntimeError(
              'The agent disconnected while waiting for sign-in',
            );
          }
          if (now() > deadline) {
            throw new ValueError(
              'Sign-in timed out. The conversation was not opened.',
            );
          }
          continue;
        }
        this.authEvent.clear();
        this.$checkSetupAbort();
        const [action, methodId] = this.authResponse ?? ['cancel', null];
        if (action === 'cancel') {
          throw new ValueError(
            'Sign-in was cancelled, so the conversation was not opened.',
          );
        }
        if (action === 'retry') return;
        auth.working = true;
        auth.error = '';
        try {
          await this.setupRequest('authenticate', this.authenticateParams(methodId), 120);
          this.$checkSetupAbort();
          return;
        } catch (failure) {
          if (
            !(failure instanceof RpcError) && !(failure instanceof TimeoutError)
          ) throw failure;
          this.$checkSetupAbort();
          if (this.closed) throw failure;
          auth.working = false;
          auth.error = 'Sign-in failed: ' + clip(failure.message, 300);
        }
      }
    } finally {
      this.auth = null;
    }
  },

  /**
   * The params of ACP uthenticate. A Beta agent whose API key method takes the key in _meta['api-key'] (Gemini) gets the key AIB
   * passes in its environment (Settings > AIB Linking > Beta agents); every other method is just {methodId}.
   */
  authenticateParams(this: Connection, methodId: unknown): Json {
    const params: Json = { methodId };
    const agent = betaAgent(this.provider);
    const keyEnv = agent?.signin.keyEnv;
    const key = keyEnv && this.env ? this.env[keyEnv] : '';
    if (agent && key && agent.signin.keyMethod && agent.signin.keyMethod === methodId) params._meta = { 'api-key': key };
    return params;
  },

  /**
   * Beta agents whose session/new reports a model they do not use until the client sets one (GitHub Copilot CLI, github/copilot-cli#5363):
   * right after session/new (and the New chat picks), set the model explicitly to the one the agent reports, through its model config
   * option, else through session/set_model (the models shape). A refusal is logged, never thrown: the chat still opens. True = sent.
   */
  async applyModelQuirk(this: Connection): Promise<boolean> {
    if (!betaAgent(this.provider)?.setModelAfterNew || !this.sessionId) return false;
    try {
      const option = findPickOption(this.settings, 'model');
      if (option && isStr(option.currentValue) && option.currentValue) {
        await this.setConfig(option.id, option.currentValue);
        return true;
      }
      const models = isDict(this.settings.models) ? this.settings.models as Json : null;
      const current = models && isStr(models.currentModelId) ? models.currentModelId : '';
      if (current) {
        await this.request('session/set_model', { sessionId: this.sessionId, modelId: current });
        return true;
      }
    } catch (error) {
      log.warning('Setting the model of %s after session/new failed: %s', this.provider, errorText(error));
    }
    return false;
  },

  /** The agent's own words of the current turn (its message chunks since the last user message), clipped; '' when none. */
  $turnAgentText(this: Connection): string {
    const parts: string[] = [];
    for (let i = this.events.length - 1; i >= 0 && parts.length < 200; i--) {
      const e = this.events[i];
      if (e.kind === 'user') break;
      if (e.kind !== 'update' || !isDict(e.data)) continue;
      const update = get(e.data, 'update');
      if (!isDict(update) || get(update, 'sessionUpdate') !== 'agent_message_chunk') continue;
      const content = get(update, 'content');
      const piece = isDict(content) ? get(content, 'text') : null;
      if (isStr(piece)) parts.push(piece);
    }
    return clip(parts.reverse().join('').trim(), 1000);
  },

  /** A prompt failed with ACP auth_required mid-session: show the sign-in card and keep the message for one resend (Deno only). */
  $holdForSignIn(this: Connection, error: RpcError, seq: number): void {
    const said = this.$turnAgentText();
    const again = this.$authResent;
    this.$authResent = false;
    this.error = '';
    const detail = clip([said, error.message].filter(Boolean).join('\n'), 1500);
    this.auth = {
      methods: [...this.authMethods],
      message: clip(error.message, 500),
      error: again ? 'AIB sent your message again after the sign-in, but the agent still asks for sign-in. Try again.' : '',
      working: false,
      during: 'prompt',
      detail,
    };
    const last = this.$lastPrompt;
    this.$authRetry = last && last.seq === seq ? { text: last.text, attachments: last.attachments } : this.$authRetry;
    this.$queueNoteOutcome(null, false);
    this.event('auth_required', { methods: this.auth.methods, message: this.auth.message, during: 'prompt', detail });
  },

  /** The person's answer to a mid-session sign-in card: authenticate in-app, retry after a terminal sign-in, or dismiss. */
  $answerPromptAuth(this: Connection, auth: AuthState, action: unknown, methodId: unknown): void {
    if (action === 'cancel') {
      this.auth = null;
      this.$authRetry = null;
      this.event('error', { message: auth.detail || auth.message || 'Sign-in required' });
      void this.$queuePump();
      return;
    }
    if (action === 'retry') {
      void this.$resumeAfterSignIn();
      return;
    }
    if (action !== 'authenticate') throw new ValueError('Action must be authenticate, retry, or cancel');
    const method = isStr(methodId) ? auth.methods.find((m) => m.id === methodId) ?? null : null;
    if (method === null) throw new ValueError('Unknown sign-in method');
    if (method.kind !== 'agent') {
      throw new ValueError('This sign-in runs in a terminal: choose Sign in on the card, or finish it outside AIB, then choose Try again.');
    }
    auth.working = true;
    auth.error = '';
    void (async () => {
      try {
        await this.request('authenticate', this.authenticateParams(method.id), 900);
      } catch (failure) {
        if (this.auth === auth) {
          auth.working = false;
          auth.error = 'Sign-in failed: ' + clip(errorText(failure), 300);
          this.$scheduleSnapshot();
        }
        return;
      }
      if (this.auth === auth) await this.$resumeAfterSignIn();
    })();
  },

  /** Signed in again: the card goes and the message that failed is sent once more (nothing to send: the queue goes on). */
  async $resumeAfterSignIn(this: Connection): Promise<void> {
    const retry = this.$authRetry;
    this.auth = null;
    this.$authRetry = null;
    if (!retry || this.closed || !this.ready || (this.busy && !this.autonomous)) {
      void this.$queuePump();
      return;
    }
    this.$authResent = true;
    try {
      await this.prompt(retry.text, null, retry.attachments);
    } catch (error) {
      this.$authResent = false;
      this.event('error', { message: 'AIB could not send your message again after the sign-in: ' + errorText(error) });
    }
  },

  /** Called from the HTTP layer: choose an in-app method, retry after an external sign-in, or cancel. */
  answerAuth(this: Connection, action: unknown, methodId: unknown = null): void {
    const auth = this.auth;
    if (!auth) {
      throw new ValueError('No sign-in is pending for this connection');
    }
    if (auth.working) throw new ValueError('Sign-in is already in progress');
    if (auth.during === 'prompt') return this.$answerPromptAuth(auth, action, methodId);
    if (action === 'authenticate') {
      const method = isStr(methodId) ? auth.methods.find((m) => m.id === methodId) ?? null : null;
      if (method === null) throw new ValueError('Unknown sign-in method');
      if (method.kind !== 'agent') {
        throw new ValueError(
          'This sign-in must be completed outside AIB. Follow the instructions shown, then choose Retry.',
        );
      }
    } else if (action !== 'retry' && action !== 'cancel') {
      throw new ValueError('Action must be authenticate, retry, or cancel');
    } else {
      methodId = null;
    }
    this.authResponse = [action as string, methodId as string | null];
    this.authEvent.set();
  },

  async setup(this: Connection, resume: string | null = null): Promise<void> {
    this.$refuseReadOnly();
    this.ready = false;
    if (resume) this.knownSessions.add(resume);
    this.initial = await this.setupRequest('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'agent-studio',
        title: 'AIB',
        version: APP_VERSION,
      },
      clientCapabilities: {
        ...this.caps.capabilities(),
        subagents: {},
        elicitation: { form: {}, url: {} },
        // A Beta agent that signs in through a terminal: AIB runs that sign-in itself (its own terminal, Settings > AIB Linking), so the
        // agent may offer its terminal-type methods (ACP auth.terminal); the chat's sign-in card then has a Sign in button.
        // Claude Code too (Deno only): its "claude-ai-login" / "console-login" terminal methods run in an AIB terminal from the chat's
        // sign-in card (terminal_routes.ts builtinSigninCommand), never a separate console window.
        ...(betaAgent(this.provider)?.signin.kind === 'terminal' || (TERMINAL_SIGNIN_PROVIDERS.has(this.provider) && !isClaudeFamily(this.provider) || this.provider === 'claude')
          ? { auth: { terminal: true } }
          : {}),
      },
    }, 45);
    this.$checkSetupAbort();
    const mcpServers = this.$applyInitialize();
    let result: unknown;
    let continuedUpdates: ReplayWindow | null = null; // a reopened chat's setup replay (only its outside turns are shown)
    if (resume) {
      const resumeCaps = sessionCapabilities(this.initial);
      if (!resumeCaps.loadSession && !resumeCaps.resume) {
        throw new ValueError(
          'This agent does not advertise session loading. Start a new conversation instead.',
        );
      }
      this.sessionId = resume;
      // AIB's own lines of this conversation (turn ends, AIB notes) go back in after the turns the transcript replays. They are
      // written to the keeper's record first (before session/load): a rebuild merges the very same lines at the same places.
      // A reopened chat that goes on in its history store has them there already, with everything else: the replay is not shown.
      const continued = this.$continued && !!resumeCaps.loadSession;
      if (this.lines && !this.$replaying && !continued) {
        const kept = linesWithin(this.lines.read(this.provider, resume), MAX_LINES_NOTE_BYTES);
        if (kept.length) {
          if (this.channel) await this.channel.sendNote({ t: 'lines', lines: kept });
          this.$merger = new LineMerger(kept);
        }
      }
      if (continued) this.$reload = { window: new ReplayWindow(), discard: false };
      try {
        result = await this.$setupSessionCall(
          resumeCaps.loadSession ? 'session/load' : 'session/resume',
          {
            sessionId: resume,
            cwd: this.agentCwd,
            mcpServers: this.$acpMcp(mcpServers),
            ...this.artifactPrompt(this.mcpInConfig() ? this.mcpServers : mcpServers),
            ...this.extraFolders(),
            ...this.claudeMeta(),
            ...this.codexMeta(),
          },
        );
      } finally {
        if (continued) {
          continuedUpdates = this.$reload?.window ?? new ReplayWindow();
          this.$reload = null;
        }
        this.$continued = false; // (an agent that only resumes replays nothing: nothing to drop)
      }
    } else {
      const params = () => ({
        cwd: this.agentCwd,
        mcpServers: this.$acpMcp(mcpServers),
        ...this.artifactPrompt(this.mcpInConfig() ? this.mcpServers : mcpServers),
        ...this.extraFolders(),
        ...this.claudeMeta(),
        ...this.codexMeta(),
      });
      // A fork: the agent copies the session itself when it advertises session/fork; otherwise (or when it refuses) a new session
      // starts and the caller sends a written summary of the chat as its first message (forkHow tells which).
      if (this.forkFrom) {
        if (advertisesFork(this.initial)) {
          try {
            result = await this.$setupSessionCall('session/fork', { sessionId: this.forkFrom, ...params() });
            this.forkHow = 'copy';
          } catch (error) {
            if (!(error instanceof RpcError)) throw error;
            log.info('session/fork refused by %s (%s): starting a new session with a summary', this.provider, error.message);
          }
        }
        if (!this.forkHow) this.forkHow = 'summary';
      }
      result ??= await this.$setupSessionCall('session/new', params());
    }
    this.$takeSession(result, resume);
    if (!resume) {
      // Live setup only (a keeper replay never comes here): the New chat page's picks go in before the chat is ready, so the
      // first prompt runs with them. Their set_config_option / set_mode calls are in the keeper's record like any other, so a
      // rebuild replays their answers and never sends them again.
      this.startSettings = structuredClone(result) as Json;
      await this.applyStartPicks();
      await this.applyModelQuirk();
      this.$checkSetupAbort();
    }
    await this.$awaitToolsServed();
    this.$markReady();
    if (continuedUpdates) this.$showOutsideTurns(continuedUpdates);
  },

  /**
   * Codex family, servers in CODEX_CONFIG: codex-acp's startup wait (`_meta.mcpStartupAwaitTimeoutMs`) covers only servers listed in
   * session/new, so AIB waits itself, up to the same time, until AIB's tool server has answered this chat's first tools/list (the
   * chat shows "starting" meanwhile). Without it a first prompt can find no studio_artifact tools yet (a slow forwarder start).
   * Best effort: no hook, a chat whose tool server leaves no record (dev stdio) or a late server just ends the wait.
   */
  async $awaitToolsServed(this: Connection): Promise<void> {
    const served = this.toolsServed;
    // only the keeper forwarder's and the WSL tunnel's tools/list leave a record (artifacts/served.ts)
    const forwarded = this.mcpServers.some((s) => isOwnArtifactEntry(s) && 'args' in s && s.args[0] === 'mcp-forward');
    if (!served || !this.mcpInConfig() || !forwarded) return;
    const until = Date.now() + CODEX_MCP_STARTUP_WAIT_MS;
    while (!served(this.processStartedAt) && Date.now() < until && !this.closed) await new Promise((r) => setTimeout(r, 50));
  },

  /** What the `initialize` result (this.initial) sets; returns the MCP servers this agent gets. Live setup and replay share it. */
  $applyInitialize(this: Connection): McpServer[] {
    if (
      !isDict(this.initial) || !pyEq(get(this.initial, 'protocolVersion'), 1)
    ) {
      throw new ValueError(
        'The agent did not negotiate supported ACP protocol version 1',
      );
    }
    let advertised = pget(
      get(this.initial, 'agentCapabilities', {}),
      'promptCapabilities',
      {},
    );
    advertised = isDict(advertised) ? advertised : {};
    this.promptCaps = Object.fromEntries(
      ['image', 'audio', 'embeddedContext'].map((
        key,
      ) => [key, get(advertised as Json, key) === true]),
    );
    this.imageSupported = this.promptCaps.image;
    this.authMethods = describeAuthMethods(
      get(this.initial, 'authMethods'),
      this.provider,
    );
    const [mcpServers, skipped] = selectMcpServers(
      this.mcpServers,
      this.initial,
    );
    this.breadth.skippedMcp = skipped;
    this.$sessionMcp = mcpServers; // a session/load after an open-elsewhere hand-off sends the same
    return mcpServers;
  },

  /** What a session/new, session/load or session/resume result sets: the chat is ready. Replay uses it as is. */
  $applySession(this: Connection, result: unknown, resume: string | null): void {
    this.$takeSession(result, resume);
    this.$markReady();
  },

  /** The session id and settings of a session/new, session/load or session/resume result. Live setup and replay share it. */
  $takeSession(this: Connection, result: unknown, resume: string | null): void {
    this.$mergeDone(); // the transcript replay is over: the last replayed turn's lines
    if (resume) this.sessionId = resume;
    else this.sessionId = isDict(result) ? get(result, 'sessionId') as string | null : null;
    if (!isDict(result) || !isStr(this.sessionId) || !this.sessionId) {
      throw new ValueError('The agent returned an invalid session response');
    }
    this.$withModels(result); // ACP `models` (Gemini): shown, and remembered through startSettings, as the model option
    Object.assign(this.settings, result);
    this.$withModels(this.settings);
    this.knownSessions.add(this.sessionId);
  },

  /** The chat is ready: prompts are accepted from now on. */
  $markReady(this: Connection): void {
    this.ready = true;
    this.event('connected', {
      sessionId: this.sessionId,
      provider: this.provider,
    });
  },

  /**
   * Apply the New chat page's picks to the session that was just made, each validated against what the agent reports NOW (a remembered
   * model may be gone). A pick equal to the current value is skipped. A refusal is recorded, never thrown: the chat still opens, with
   * the agent's own setting, and the page says which pick did not apply.
   */
  async applyStartPicks(this: Connection): Promise<Json[]> {
    const picks = this.startPicks;
    this.pickResults = [];
    if (!picks) return this.pickResults;
    for (const kind of ['model', 'mode', 'effort'] as const) {
      const value = picks[kind];
      if (!isStr(value) || !value) continue;
      const entry: Json = { kind, value, ok: false };
      try {
        const modes = isDict(this.settings.modes) ? this.settings.modes : null;
        if (kind === 'mode' && modes && Array.isArray(modes.availableModes) && modes.availableModes.length) {
          const offered = offeredModeIds(modes);
          // A helper names a list of acceptable ids (first offered wins, never a broader one); a remembered default that holds a
          // renamed id (codex `auto` -> `workspace-write`) is matched to its twin. Neither offered: refused, naming what is offered.
          const want = picks.modeAnyOf?.length ? picks.modeAnyOf : [value];
          const use = resolveMode(offered, want, !picks.modeAnyOf?.length);
          if (!use) {
            entry.offered = offered;
            throw new ValueError(`${want.join(' or ')} is not one of the modes this agent offers (${offered.join(', ')})`);
          }
          entry.value = use;
          checkMode(this.settings, use);
          if (modes.currentModeId !== use) await this.setMode(use);
        } else {
          const option = findPickOption(this.settings, kind);
          if (!option) throw new ValueError(`This agent does not offer a ${kind} setting in this chat`);
          entry.configId = option.id;
          if (!optionValues(option).includes(value)) throw new ValueError('No longer offered by the agent');
          if (option.currentValue !== value) await this.setConfig(option.id, value);
        }
        entry.ok = true;
      } catch (error) {
        entry.message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof RpcError) && !(error instanceof ValueError) && !(error instanceof TypeError)) {
          log.exception(error, 'Applying a start pick failed');
        }
      }
      this.pickResults.push(entry);
    }
    return this.pickResults;
  },

  /**
   * A quiet look at what a new session of this agent offers: initialize, session/new in this folder with no MCP servers, read the
   * reply, close the session when the agent can. Never signs in: an agent that needs sign-in simply has no list. The caller closes
   * the process. Returns the session/new reply (sessionId, modes, configOptions, ...).
   */
  async probeSettings(this: Connection, timeoutSeconds = 30): Promise<Json> {
    return await this.$probeSettings(timeoutSeconds);
  },
};

export type SetupMethods = typeof setupMethods;
