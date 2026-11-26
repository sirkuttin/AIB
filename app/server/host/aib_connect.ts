/**
 * Aib methods: opening a chat (connect) and wiring a connection to the host.
 * Moved out of aib.ts (no change).
 */
import { Connection, type ConnectionOptions, errorText } from '../acp/connection.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import { isBeta } from '../agents/beta_catalog.ts';
import { baseAgent, isClaudeFamily, isCodexFamily, isModelServerId, isQwenFamily, serverIdOf } from '../agents/claude_family.ts';
import { WSL_TOOL_GROUPS } from '../artifacts/mcp.ts';
import { wslSubagentChatClosed } from '../wsl/subagents.ts';
import * as codexSub from '../subagents/codex.ts';
import * as qwenSub from '../subagents/qwen.ts';
import * as gemini from '../subagents/gemini.ts';
import * as agySub from '../subagents/antigravity.ts';
import { isAntigravity } from '../subagents/antigravity.ts';
import * as nativeOff from '../subagents/native_off.ts';
import { isDict, isStr, pyLen, ValueError } from '../core/py.ts';
import { OwnershipConflict, SessionLease } from '../ownership/ownership.ts';
import { folderOnlyNote } from '../ownership/probe.ts';
import { expandUser } from '../platform/pypath.ts';
import { isdir, realpath } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { movedTo as movedChatTo } from '../state/moved_chats.ts';
import { wslChatLocalOnly } from '../wsl/local_only.ts';
import { helperOf, readHelpers } from '../swarm/registry.ts';
import { refOf } from '../platform/location.ts';
import { readyHost, wslLoc } from '../wsl/access.ts';
import { wslEnsure, wslIsRemoved, WslPlan, wslPlanWithReason, wslRecord, wslSetSession } from '../wsl/worktrees.ts';
import { wslSyncChat } from '../wsl/sync.ts';
import { log } from './aib_util.ts';
import { type ConnectOptions, OWN_CONTEXT } from './aib_options.ts';
import { HOOKS_OFF, NO_GIT_BASH, SUBAGENTS_OFF_NO_BASH, WSL_HOOKS_UNAVAILABLE, recheckSubagentHooks, offHooks } from './aib_helpers.ts';
import type { Aib } from './aib.ts';

export const connectMethods = {
  // ---- connect ------------------------------------------------------------------------------------------------------------
  async connect(this: Aib, provider: string, cwd: string, resume: string | null = null, options: ConnectOptions = {}): Promise<Connection> {
    const background = options.background ?? false;
    const continueAnyway = options.continueAnyway ?? false;
    if (resume !== null && resume !== undefined && (!isStr(resume) || pyLen(resume) > 512)) {
      throw new ValueError('Invalid saved session ID');
    }
    resume = resume || null;
    if (agentRegistry.isRetired(provider)) throw new ValueError(agentRegistry.RETIRED_NOTE); // OMP chats are read-only history
    await this.ready;
    this.evictClosed();
    if (!isStr(cwd)) throw new TypeError(`expected str, bytes or os.PathLike object, not ${cwd === null ? 'NoneType' : typeof cwd}`);
    // A WSL project (design section 2): its ref is the chat's folder; nothing about it is looked up on Windows, its worktree (if any)
    // is made and kept by its distro's helper (wsl/worktrees.ts), and its agent starts in the distro's Linux keeper (wslLaunch).
    let wsl = wslLoc(cwd);
    let workspace = wsl ? refOf({ kind: 'wsl', ...wsl }) : realpath(expandUser(cwd));
    // Build plan 1b, 4.4 (MF 4): an old copy chat that the owner's migration script moved to its project folder carries on there
    // (state/moved_chats.ts, read only). Read first, so a page that still sends the copy path lands there too. A WSL chat's mapping
    // is a ref of its distro's project folder.
    const movedTo = resume && this.hasStateDir ? movedChatTo(this.stateDir, provider, resume) : null;
    const movedWsl = movedTo ? wslLoc(movedTo) : null;
    if (movedWsl) {
      wsl = movedWsl;
      workspace = refOf({ kind: 'wsl', ...movedWsl });
    } else if (movedTo && !wsl && isdir(movedTo)) workspace = realpath(movedTo);
    else if (!wsl && this.worktrees && this.worktrees.isRemoved(workspace, resume ? `${provider}:${resume}` : null)) {
      throw new wt.WorktreeGone(wt.GONE_MESSAGE); // discarded (or being removed): readable, not continuable
    }
    let record: (wt.WorktreeRecord & { key: string }) | null = !wsl && this.worktrees && !movedTo ? this.worktrees.forChat(provider, resume, workspace) : null; // a chat that has a worktree keeps it
    if (record) workspace = realpath(await this.worktrees!.ensure(record)); // made again from its branch if deleted
    if (!wsl && !isdir(workspace)) throw new ValueError('Choose an existing workspace folder');
    if (!agentRegistry.isProvider(provider)) throw new ValueError('Choose an agent');
    const launch = wsl ? await this.wslLaunch(provider, wsl, !resume, !!resume && !options.auto) : null;
    if (launch && this.worktrees && !movedWsl) {
      // the same two lookups in the distro: a discarded worktree is not continued; a chat that has one keeps it (made again if deleted)
      const session = resume ? `${provider}:${resume}` : null;
      if (await wslIsRemoved(workspace, session)) throw new wt.WorktreeGone(wt.GONE_MESSAGE);
      const found = await wslRecord(workspace, session);
      if (found) {
        const linuxPath = await wslEnsure(found);
        wsl = { distro: found.distro, linuxPath };
        workspace = refOf({ kind: 'wsl', ...wsl });
        launch.spawn = { ...launch.spawn, linuxPath };
        record = found;
      }
    }
    if (launch) {
      const stat = await readyHost(wsl!.distro).call('fs.stat', { path: wsl!.linuxPath });
      if (!stat.isDir) throw new ValueError('Choose an existing workspace folder');
    }
    const [command, env] = launch ? [launch.command, launch.extra] : await this.agentLaunch(provider, !resume);
    // its agent may still run in the distro's keeper (a take-over at start that failed or never asked): taken over, never a second one
    if (launch && resume) await this.$wslTakeOverFirst(wsl!.distro);
    for (const connection of this.connections.values()) {
      if (resume && connection.provider === provider && connection.sessionId === resume && !connection.closed) {
        if (!connection.ready) throw new OwnershipConflict('This conversation is already opening in AIB. Wait for it to finish.');
        return connection;
      }
    }
    // A saved chat whose agent still runs in the keeper it would start in (a WSL chat: its distro's) is taken over, never started twice
    const keeperOfChat = launch ? launch.link : this.keeper;
    const running = resume && keeperOfChat ? await this.$runningInKeeper(provider, resume, keeperOfChat, launch ? wsl!.distro : null) : null;
    if (running) {
      if (!running.ready) throw new OwnershipConflict('This conversation is already opening in AIB. Wait for it to finish.');
      return running;
    }
    let plan: wt.Plan | null = null;
    let startNote = ''; // a new chat's start note: where it started when that is not the obvious, or why it works in place
    // Swarm: a helper is one from its first moment (helperOf) or because the registry lists it (reopened after a restart, a Continue).
    const asHelper = options.helperOf ?? null;
    const known = !asHelper && this.hasStateDir
      ? helperOf(readHelpers(this.stateDir), { lasting: resume ? `${provider}:${resume}` : null, path: record ? String(record.path) : null })
      : null;
    if (asHelper && resume) throw new ValueError('A helper is a new chat');
    if (asHelper && !this.worktrees) throw new ValueError('Helpers need a worktree: this AIB has no state folder');
    // Owner decision 2026-11-16: every new chat works in the project folder (no per-chat Own copy, no pre-set; the hidden
    // worktreePerChat setting no longer decides either); a helper always gets its own copy. ownCopy: tests only (ConnectOptions).
    // `working`: another folder chat working here now, for the shared-folder start note and context line ($sharedFolderStart).
    const working = resume === null && !asHelper ? this.folderChatWorking(workspace) : null;
    const wantsCopy = resume === null && !!this.worktrees && (!!asHelper || options.ownCopy === true);
    if (wantsCopy) {
      const kind = asHelper ? 'helper' : 'chat';
      // Build plan 2.4 (MF 7): a helper of a chat that works in the project folder starts from the folder's branch, with the folder's
      // uncommitted edits (the main agent's too), and lands there (landOn in its worktree record). A WSL project's helper too: the distro plans it (wsl/worktrees.ts).
      const parentChat = asHelper ? this.connections.get(asHelper.parent) : undefined;
      const folderParent = !!parentChat && !parentChat.closed && !parentChat.worktree && parentChat.swarm?.role !== 'helper';
      const planned = wsl
        ? await wslPlanWithReason(workspace, kind, folderParent)
        : await this.worktrees!.planWithReason(workspace, null, kind, folderParent ? { onFolderBranch: true } : {}); // no plan: works in place
      plan = planned.plan;
      startNote = wt.inPlaceNote(planned.reason);
      // a helper never works in the project folder (review break 5)
      if (asHelper && !plan) throw new ValueError(`This project cannot make a worktree for a helper: ${planned.reason || 'unknown reason'}`);
    }
    const lease = resume ? await new SessionLease(this.stateDir, provider, resume).acquire() : null;
    let connection: Connection | null = null;
    let ownerNote: string | null = null; // folder-only evidence: continued without asking, said in the chat
    try {
      // The ownership check reads Windows processes and transcripts; a WSL agent's are inside the distro, so its helper checks there.
      if (resume && wsl) {
        const project = record ? wslLoc(String(record.project ?? ''))?.linuxPath ?? null : null;
        ownerNote = folderOnlyNote(await this.$wslCheckOwnership(provider, resume, wsl, project, continueAnyway));
      } else if (resume) {
        const owner = await this.ownerProbe(provider, resume, [Deno.pid]);
        if (owner !== null && owner !== undefined) {
          throw new OwnershipConflict(
            `This ${provider} conversation is already open in another agent process (PID ${owner}). Stop it in its current client before continuing here.`,
          );
        }
        ownerNote = folderOnlyNote(this.checkOwnership(provider, resume, workspace, continueAnyway));
      }
      if (ownerNote) log.info('ownership: %s %s continued with folder-only evidence: %s', provider, resume, ownerNote);
      // the keeper this chat's agent runs in (a WSL chat: its distro's Linux keeper, whatever the Windows keeper's state)
      const chatKeeper = launch ? launch.link : this.keeper && this.keeperForNew && await this.$keeperUsable() ? this.keeper : null;
      // Owner rule 2026-11-17 (a conversation is one chat; its history is permanent): a conversation whose chat has a history store
      // reopens as that chat, same id, going on in its store (after an idle quit, a crash, a lost keeper, an update, Continue).
      const reopen = resume && chatKeeper && !asHelper ? await this.$storeToContinue(provider, resume, chatKeeper) : null;
      const chatId = reopen?.id ?? null;
      // Subagent worktrees (subagents/): a Claude chat in a git project gets command hooks through the keeper's forwarder; its key and
      // id go in the agent's environment (never in settings, a command line or a URL). A WSL chat's run in its distro ($wslClaudeHooks).
      // Codex (subagents/codex.ts): its hooks go in CODEX_CONFIG; hooks off or unavailable turn its subagents off instead.
      const subagent = isClaudeFamily(provider)
        ? await this.$subagentHooks(command, plan ? plan.path : workspace, workspace, !!plan, env, wsl ? wsl.distro : null, chatId)
        : isCodexFamily(provider)
        ? await this.$codexSubagentHooks(
          command,
          plan ? plan.path : workspace,
          workspace,
          !!plan,
          env,
          launch ? launch.spawn.env ?? {} : null,
          chatId,
          wsl ? wsl.distro : null,
        )
        : isQwenFamily(provider)
        ? await this.$qwenSubagentHooks(
          command,
          plan ? plan.path : workspace,
          workspace,
          !!plan,
          env,
          launch ? launch.spawn.env ?? {} : null,
          chatId,
          wsl ? wsl.distro : null,
        )
        : isAntigravity(provider)
        ? await this.$agySubagentHooks(
          command,
          plan ? plan.path : workspace,
          workspace,
          !!plan,
          chatId,
          wsl ? wsl.distro : null,
        )
        : nativeOff.nativeOffAgent(provider)
        ? this.$nativeOffSubagents(provider, command, chatId)
        : null;
      // Gemini (subagents/gemini.ts): every chat gets the fence (an admin policy); an API-key chat in a git project also the redirect
      const gem = provider === 'gemini'
        ? await this.$geminiSubagents(plan ? plan.path : workspace, workspace, !!plan, env, !!wsl, chatId)
        : null;
      const connectionOptions: ConnectionOptions = {};
      const agentEnv = { ...env, ...subagent?.env, ...gem?.env };
      if (Object.keys(agentEnv).length) connectionOptions.env = agentEnv;
      if (subagent?.id) connectionOptions.id = subagent.id;
      if (gem?.id) connectionOptions.id = gem.id;
      if (chatId) connectionOptions.id = chatId;
      const subArgs: string[] = subagent && 'args' in subagent && Array.isArray(subagent.args) ? subagent.args : []; // a WSL Antigravity chat's --gemini-dir
      const launchCommand = subagent && 'command' in subagent && Array.isArray(subagent.command)
        ? subagent.command // Maki and Copilot (subagents/native_off.ts): the flag that turns their subagents off, in its place
        : gem
        ? [...command, ...gem.args]
        : subArgs.length
        ? [...command, ...subArgs]
        : command;
      if (launch) {
        connectionOptions.keeper = launch.link; // the distro's Linux keeper, whatever the Windows keeper's state
        // a new worktree chat's agent works in the worktree's Linux folder (cwd: its ref)
        connectionOptions.wsl = plan instanceof WslPlan ? { ...launch.spawn, linuxPath: plan.linuxPath } : launch.spawn;
      } else if (chatKeeper) connectionOptions.keeper = chatKeeper;
      if (connectionOptions.keeper) connectionOptions.history = this.historyClient();
      if (reopen && connectionOptions.history) connectionOptions.continueStore = reopen.store;
      if (plan) connectionOptions.start = false; // the agent starts in finishSetup, once its worktree exists
      // A Codex agent starts once the chat's MCP servers are known: they go in its CODEX_CONFIG (acp/codex_mcp.ts), read at its start
      const codexLate = !plan && isCodexFamily(provider);
      if (codexLate) connectionOptions.start = false;
      // A Copilot agent too: its MCP config file (agents/copilot_mcp.ts) names the chat's servers, known once the connection exists
      const copilotLate = !plan && baseAgent(provider) === 'copilot';
      if (copilotLate) connectionOptions.start = false;
      connection = Object.keys(connectionOptions).length
        ? this.connectionFactory(launchCommand, plan ? plan.path : workspace, provider, connectionOptions)
        : this.connectionFactory(launchCommand, plan ? plan.path : workspace, provider);
      const c = connection;
      if (gem) {
        if (gem.id && c.id !== gem.id) { // another id: its hook key would not check; the fence alone holds
          c.geminiSubagents = { ...gem.setup, home: '', subFolder: '', off: 'it was not set up' };
        } else c.geminiSubagents = gem.setup;
      }
      // Antigravity: with hooks (an API key: its own settings folder) its subagents work in their own worktree (c.subagentHooks.prompt);
      // otherwise AIB can only ask the agent not to start editing subagents (subagents/antigravity.ts)
      if (isAntigravity(provider)) c.subagentRule = agySub.ANTIGRAVITY_SUBAGENT_PROMPT;
      // a factory that gave the chat another id: its hooks' key would not check, so it gets none (it would fail closed otherwise)
      if (subagent) c.subagentHooks = !subagent.id || c.id === subagent.id ? subagent.hooks : offHooks('not set up');
      if (plan || record) {
        c.worktree = plan ? { branch: plan.branch, base: plan.base } : { branch: String(record!.branch), base: String(record!.base ?? '') };
        c.projectRoot = plan ? workspace : String(record!.project); // cwd is the worktree, projectRoot the project
      }
      this.$wire(c);
      c.sessionLease = lease;
      if (asHelper) c.swarm = { role: 'helper', helperId: asHelper.helperId, parent: asHelper.parent };
      else if (known) c.swarm = { role: 'helper', helperId: known.id, parent: known.parent.live };
      // every other chat can lead helpers, in its own copy or in the project folder (MF 1); WSL: only once its swarm tools are on
      else if (!wsl || WSL_TOOL_GROUPS.swarm) c.swarm = { role: 'main' };
      let toolsNotice = '';
      if (launch) {
        const tools = await this.wslMcpServers(c.id, wsl!.distro); // the tunnel, else interop, else a notice (WSL_TOOL_GROUPS)
        c.mcpServers = tools.servers;
        toolsNotice = tools.notice;
      } else {
        const forwarder = c.keeper ? await this.$mcpForwarder() : null;
        const helper = c.swarm?.role === 'helper'; // a helper gets neither the merge tools (review break 3) nor the swarm tools
        c.mcpServers = [...(this.options.mcpServers ?? []), ...this.artifactMcpServers(c.id, !!c.worktree && !helper, forwarder, this.$isMain(c))];
      }
      if (baseAgent(provider) === 'copilot') toolsNotice = await this.$copilotTools(c, launchCommand, wsl ? wsl.distro : null) || toolsNotice;
      if (codexLate || copilotLate) c.startProcess();
      c.sessionId = resume || null;
      if (!resume && options.picks) c.startPicks = { ...options.picks };
      c.recovery = this.recovery as never;
      this.connections.set(c.id, c);
      // Its folder is a project from now on (the page, auto-reconnect, a keeper take-over and agent-started chats all come here).
      if (this.addedProjects) void this.addedProjects.addOpened(c.projectRoot || workspace);
      if (resume) this.announce(c, 'opening'); // claim before session/load so other clients can see it
      const finishSetup = async () => {
        try {
          // before the snapshot: the default /aib-shared exclude is in force, so a new copy never takes the main folder's aib-shared/ (its link does)
          const mainFolder = c.worktree ? c.projectRoot : workspace;
          if (wsl) await this.$wslLocalOnlyDefault(mainFolder); // the same in the distro (its helper; never throws)
          const local = wsl ? null : await this.$localOnlyDefault(mainFolder);
          if (plan) {
            const fellBack = await this.$makeWorktree(c, plan, workspace);
            if (fellBack) startNote = wt.inPlaceNote(fellBack);
          }
          // a WSL chat: the main folder's local-only paths as Linux paths, from its distro's helper
          c.localOnly = wsl ? await wslChatLocalOnly(c.worktree ? c.projectRoot : c.cwd, !!c.worktree) : this.$localOnlyFor(c, local);
          // allow rules of a WSL chat: its folder and the distro's base facts, read while the agent starts (allow/wsl_facts.ts)
          const warming = wsl && this.allow ? c.allowWarm() : null;
          if (isBeta(provider) && baseAgent(provider) === 'gemini') await this.$trustForGemini(c, wsl ? wsl.distro : null);
          await c.setup(resume || null);
          if (warming) await warming; // bounded by the helper call's own time limit; never throws
          if (isClaudeFamily(c.provider) && c.subagentHooks?.off === HOOKS_OFF) { // design 2.6: said up front, before a subagent edits the folder (P0 A7)
            c.recordedEvent('studio_note', {
              message: `Subagents that edit files are off in this chat: hooks are off in your Claude Code settings ` +
                `(${c.subagentHooks.detail}), so AIB can't give them their own worktree. Read-only subagents (Explore, Plan) still work.`,
              sessionId: c.sessionId,
            });
          } else if (isClaudeFamily(c.provider) && c.subagentHooks?.off === WSL_HOOKS_UNAVAILABLE) { // WSL: said up front, never unisolated
            c.recordedEvent('studio_note', {
              message: `Subagents are off in this chat: AIB could not set up their own worktree in this WSL distro (${c.subagentHooks.detail}).`,
              sessionId: c.sessionId,
            });
          } else if (c.subagentHooks?.off === NO_GIT_BASH) {
            c.recordedEvent('studio_note', { message: SUBAGENTS_OFF_NO_BASH, sessionId: c.sessionId });
          } else if (subagent && 'note' in subagent && subagent.note && !(resume && nativeOff.nativeOffAgent(provider))) { // Codex, Maki, Copilot: its subagents are off (Maki and Copilot: said once, in a new chat)
            c.recordedEvent('studio_note', { message: subagent.note, sessionId: c.sessionId });
          }
          if (isQwenFamily(provider) && c.subagentHooks?.prompt) {
            // Qwen advertises no system prompt capability: the rule goes in front of the next prompt, once per opening
            if (!c.supportsSystemPrompt()) this.addPromptContext(c, c.subagentHooks.prompt);
            if (!resume && c.subagentHooks.adopted === true && !c.subagentHooks.off) {
              c.recordedEvent('studio_note', { message: qwenSub.QWEN_SUBAGENT_NOTE, sessionId: c.sessionId });
            }
          }
          if (nativeOff.nativeOffAgent(provider) && c.subagentHooks?.prompt) {
            // neither Maki nor Copilot advertises a system prompt capability: the rule goes in front of the next prompt, once per opening
            if (!c.supportsSystemPrompt()) this.addPromptContext(c, c.subagentHooks.prompt);
          }
          if (isAntigravity(provider)) {
            // hooks given (an API key: AIB's own settings folder): its subagents work in their own worktree; else only asked for
            const h = c.subagentHooks;
            const enforced = !!h && h.adopted === true && !h.off && !!h.prompt;
            // no system prompt capability (session/new could not carry the rule): it goes in front of the next prompt, once per opening
            if (!c.supportsSystemPrompt()) this.addPromptContext(c, enforced ? h!.prompt! : agySub.ANTIGRAVITY_SUBAGENT_PROMPT);
            if (!resume) {
              const message = enforced ? agySub.ANTIGRAVITY_ISOLATED_NOTE : agySub.antigravityAskedNote(h?.detail || agySub.SIGNIN_WHY);
              c.recordedEvent('studio_note', { message, sessionId: c.sessionId });
            }
          }
          if (c.geminiSubagents?.off) { // the fence only: said up front (owner rule: refused, never in the folder)
            c.recordedEvent('studio_note', { message: gemini.GEMINI_TEXTS.off(c.geminiSubagents.off), sessionId: c.sessionId });
          }
          if (plan instanceof WslPlan) {
            if (c.worktree) await wslSetSession(plan, provider, c.sessionId!);
          } else if (plan && this.worktrees!.registry.get(plan.key)) await this.worktrees!.setSession(plan.key, provider, c.sessionId!);
          const note = plan && c.worktree ? plan.note : startNote;
          if (note) c.recordedEvent('studio_note', { message: note, sessionId: c.sessionId });
          if (!c.worktree && c.swarm?.role !== 'helper' && working && !working.closed && working !== c) this.$sharedFolderStart(c, working);
          if (toolsNotice) c.recordedEvent('studio_note', { message: toolsNotice, sessionId: c.sessionId }); // a WSL chat's tools
          if (ownerNote) c.recordedEvent('studio_note', { message: ownerNote, sessionId: c.sessionId }); // another agent in its folder

          if (!lease) {
            const newLease = await new SessionLease(this.stateDir, provider, c.sessionId!).acquire();
            if (c.closed) {
              newLease.release();
              throw new Error('The agent disconnected while opening the conversation');
            }
            c.sessionLease = newLease;
          }
          if (c.closed) throw new Error('The agent disconnected while opening the conversation');
          this.rememberOptions(c);
          void this.limits.refresh(c); // chat opened: Codex / Vibe limits (at most once a minute per account)
          if (this.recovery) this.recovery.connectionReady(c);
          this.announce(c, 'ready');
          this.handoff.refresh(); // its Claude config folder is watched from now on (open elsewhere)
          if (this.liveSync && !wsl) {
            try {
              await this.liveSync.chatOpened(c); // watch its project, catch it up on the user's saved edits
            } catch (error) {
              log.exception(error, 'Starting live sync failed');
            }
          } else if (this.wslSync && wsl) await this.wslSync.chatOpened(c); // the same, in its distro's helper (never throws)
        } catch (error) {
          log.exception(error, 'Opening the conversation failed');
          c.error = errorText(error);
          await c.close();
          if (plan && !c.sessionId) await this.$discardPlan(plan).catch(() => {}); // the chat never began
          if (c.sessionLease === null && lease) lease.release();
          if (!background) throw error;
        } finally {
          c.openDone.set();
        }
      };
      if (background) {
        void finishSetup().catch(() => {});
        return c;
      }
      await finishSetup();
    } catch (error) {
      log.exception(error, 'Connecting to the agent failed');
      if (connection) {
        connection.error = errorText(error);
        await connection.close();
      } else if (lease) {
        lease.release();
      }
      throw error;
    }
    return connection!;
  },

  /** AIB's hooks on one connection (turn start and end, live sync, release) and its client capabilities. */
  $wire(this: Aib, c: Connection): void {
    c.lines = this.conversationLines;
    c.promptServed = (prompt, base) => this.served?.prompt(c.id, prompt, base);
    c.toolsServed = (since) => (this.$toolsAnsweredAt.get(c.id) ?? 0) >= since;
    c.beforeQueuedSend = () => this.restartIfStale(c, 'before-send');
    if (this.allow) {
      c.allowGate = this.allow;
      // a helper's test command from its brief (the allow rules answer it; read when asked, the registry lists the helper by then)
      c.helperTestCmd = () => {
        const id = c.swarm?.role === 'helper' ? c.swarm.helperId : '';
        const brief = id && this.hasStateDir ? readHelpers(this.stateDir)[id]?.brief : null;
        return typeof brief?.test_cmd === 'string' ? brief.test_cmd : '';
      };
      if (!c.wsl) c.scratchDir = this.allow.scratchFor(c.id); // a Windows scratch folder is no folder for an agent in a distro (its additionalDirectories must be Linux paths)
    }
    c.onRelease = (conn) => {
      this.withdraw(conn);
      if (conn.wsl && this.subagents) { // its distro removes the chat's spare and unused worktrees; bound ones stay for landing
        const distro = conn.wsl.distro, subagents = this.subagents;
        void wslSubagentChatClosed(distro, conn.id).then(() => subagents.refreshWsl(distro)).catch((error) => log.exception(error, 'Removing a WSL chat\'s spare subagent worktrees failed'));
      }
      void this.subagents?.chatClosed(conn.id).catch((error) => log.exception(error, 'Removing spare subagent worktrees failed'))
        .then(() => { // after its spare went: the Gemini chat's home (junctions unlinked first), policy and empty subagent folder
          this.geminiSubagents?.chatClosed(conn.id);
          if (conn.geminiSubagents) gemini.tearDown(conn.geminiSubagents);
          if (isCodexFamily(conn.provider) && conn.subagentHooks?.subFolder) codexSub.removeSubagentFolder(conn.subagentHooks.subFolder);
          agySub.forgetChat(conn.id);
        });
      if (conn.channel) this.$keeperNoLongerNeeded();
      this.handoff.refresh();
    };
    // open elsewhere (ownership/handoff.ts): who else holds its session; letting go withdraws AIB's owner announcement
    c.holderNow = () => this.handoff.holderNow(c);
    queueMicrotask(() => this.handoff.refresh()); // a chat rebuilt from the keeper comes only through here (connect() refreshes again once ready)
    c.onElsewhere = (conn, what) => {
      if (!conn.sessionId) return;
      if (what === 'released') {
        this.probe.noteReleased(conn.provider, conn.sessionId);
        this.owners?.withdraw(conn.provider, conn.sessionId);
      } else this.announce(conn);
    };
    c.onTurnEnd = (conn) => this.turnEnded(conn);
    if ((isCodexFamily(c.provider) || isQwenFamily(c.provider)) && this.subagents) { // a stopped turn stops its subagents (kept, never landed by themselves)
      const subagents = this.subagents;
      c.onTurnCancelled = (conn) => subagents.turnCancelled(conn.id);
      c.subagentActivity = () => subagents.activity(c.id); // P3's Activity line (codex-acp's child session id is the agent_id)
    }
    // Antigravity: Activity's subagent lines (a stopped turn does not stop its subagents: they run in the background, as Claude's do)
    if (isAntigravity(c.provider) && this.subagents) c.subagentActivity = () => this.subagents!.activity(c.id);
    if (isModelServerId(c.provider)) { // the model picker lists the server's models, not Anthropic's
      const server = this.settings.modelServer(serverIdOf(c.provider) ?? '');
      if (server) c.serverModels = this.$serverModelsFor(server);
    }
    if (isClaudeFamily(c.provider) && this.subagents) { // subagent worktrees P2: what the parent's stream says of its subagents
      const subagents = this.subagents;
      // a stopped turn stops only the subagents it was waiting on: background ones run on and land (owner, 2026-11-16)
      c.onTurnCancelled = (conn) => subagents.turnCancelled(conn.id, 'claude');
      c.subagentInBackground = (child) => subagents.inBackground(c.id, child);
      c.onClaudeTool = (conn, tool, toolUseId, input, status, agentId) => {
        void subagents.claudeTool(conn.id, tool, toolUseId, input, status, agentId).catch((error) => log.exception(error, 'Subagent tool update failed'));
      };
      c.subagentActivity = () => subagents.activity(c.id);
      c.onBackgroundTask = (conn, task, callId) => subagents.noteTask(conn.id, task, callId);
      c.ownRuns = (conn) => subagents.ownWaiting(conn.id);
      c.onSubagentEnded = (conn, agentId, how) => {
        void subagents.acpEnded(conn.id, agentId, how).catch((error) => log.exception(error, 'Subagent end failed'));
      };
    }
    c.subagentWorktree = (toolUseId) => this.subagents?.worktreeOf(c.id, toolUseId) ?? null; // allow-rule parity (design 2.4)
    // a subagent in its own worktree never keeps the chat from being idle for a landing (finished ones land beside a running one)
    c.subagentIsolated = (child) => this.subagents?.isolated(c.id, child) ?? false;
    if (c.provider === 'gemini' && this.subagents && this.geminiSubagents) { // Gemini subagents start and end in the parent's stream
      const subagents = this.subagents, gem = this.geminiSubagents;
      c.onTurnCancelled = async (conn) => {
        gem.turnOver(conn.id);
        await subagents.turnCancelled(conn.id);
      };
      const told = new Map<string, { state: string; agent: string }>();
      c.onGeminiTool = (conn, callId, title, status) => {
        gem.toolUpdate(conn.id, callId, title, status);
        // its Activity card (with P3's worktree line), from the call: Gemini's stream has no child session for it
        const update = gemini.cardUpdate(callId, title, status, told);
        if (update) conn.recordedEvent('update', { sessionId: conn.sessionId, update });
      };
      c.subagentActivity = () => subagents.activity(c.id); // P3's {where, landing} per subagent (keyed by its call id)
    }
    c.onLimits = (conn, kind, raw, at) => this.limits.fromAgent(conn, kind, raw, at);
    c.onWritesDone = (conn, paths) => this.$writesDone(conn, paths); // the file editor reads those files (files/live_files.ts)
    const sync = this.liveSync;
    const wsl = this.wslSync; // a WSL chat in its own copy: its distro's helper runs the hooks (wsl/sync.ts)
    c.onTurnStart = (conn) => {
      recheckSubagentHooks(conn); // hooks turned off mid-chat (should-fix 7)
      if (sync) return wslSyncChat(conn) && wsl ? wsl.turnStarted(conn) : sync.turnStarted(conn);
    };
    // Every chat (build plan SF 11): live sync's note for a copy, then AIB's own one-time lines ($ownContext), in one prompt.
    c.contextForPrompt = async (conn) => {
      const synced = sync ? await (wslSyncChat(conn) && wsl ? wsl.contextFor(conn) : sync.contextFor(conn)) as [string, unknown] | null : null;
      const own = this.$ownContext.get(conn.id) ?? [];
      if (!synced && !own.length) return null;
      const ownText = own.length ? `<studio-context>${own.join('\n')}</studio-context>` : '';
      const text = [synced ? synced[0] : '', ownText].filter(Boolean).join('\n');
      return [text, { [OWN_CONTEXT]: true, sync: synced ? synced[1] : null, synced: !!synced, own: own.length }];
    };
    c.contextSent = async (conn, token) => {
      const t = isDict(token) && token[OWN_CONTEXT] ? token : null;
      if (!t) return;
      if (t.synced && sync) await (wslSyncChat(conn) && wsl ? wsl.contextSent(conn, t.sync) : sync.contextSent(conn, t.sync));
      const own = this.$ownContext.get(conn.id);
      if (own && Number(t.own) > 0) {
        own.splice(0, Number(t.own));
        if (!own.length) this.$ownContext.delete(conn.id);
      }
    };
    const caps = c.caps as { configure?: (terminal: boolean, fs: 'read' | 'readwrite' | null) => void };
    caps.configure?.(!!this.options.enableClientTerminal, this.options.enableClientFs ?? null);
  },
};

export type ConnectMethods = typeof connectMethods;
