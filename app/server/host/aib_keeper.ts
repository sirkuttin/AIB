/**
 * Aib methods: taking over chats from the keeper (Windows and WSL): adopt, rebuild, drop duplicates and orphan terminals.
 * Moved out of aib.ts (no change).
 */
import { Connection, type ConnectionOptions, type ContinueStore, errorText, MAX_EVENTS } from '../acp/connection.ts';
import type { McpServer } from '../acp/breadth.ts';
import { isClaudeFamily, isCodexFamily, isQwenFamily } from '../agents/claude_family.ts';
import { FORWARD_FILE, ownForwardFile, ownTunnelEntry } from '../artifacts/mcp_http.ts';
import { WSL_TOOL_GROUPS } from '../artifacts/mcp.ts';
import * as qwenSub from '../subagents/qwen.ts';
import * as gemini from '../subagents/gemini.ts';
import { isAntigravity } from '../subagents/antigravity.ts';
import * as nativeOff from '../subagents/native_off.ts';
import * as copilotMcp from '../agents/copilot_mcp.ts';
import { type ChannelInfo, type KeeperClient, KeeperError, missingFeatures } from '../keeper/client.ts';
import { KeeperLink, noteKeeperTakeoverProblem } from '../keeper/link.ts';
import { CLIENT_TERMINAL_PREFIX } from '../acp/keeper_terminal.ts';
import { announce } from '../core/log.ts';
import { PhaseTimer, rebuildPhases } from '../core/timing.ts';
import { isDict, isStr } from '../core/py.ts';
import { SessionLease } from '../ownership/ownership.ts';
import { join } from '../platform/ospath.ts';
import { helperOf, readHelpers } from '../swarm/registry.ts';
import { heldDistro, isAibInternalLabel } from '../keeper/link.ts';
import { distroName, hostWhenReady, linkOf, wslHost, wslLoc } from '../wsl/access.ts';
import { log, type Json } from './aib_util.ts';
import { hooksFromNote, isForwardEntry, chatIdOfChannel, providerOfCommand, testTakeOverDelay } from './aib_helpers.ts';
import type { Aib } from './aib.ts';

export const keeperMethods = {
  // ---- the keeper: chats that outlive this process -------------------------------------------------------------------------
  /**
   * Without the keeper for new chats (a fallback), the keeper only holds chats from before (keeperForNew false): once the last of them has ended, let go of the
   * keeper connection, so the keeper exits by itself (no live channel, no client) instead of staying for as long as AIB runs.
   */
  $keeperNoLongerNeeded(this: Aib): void {
    if (!this.keeper || this.keeperForNew || this.$closed) return;
    if ([...this.connections.values()].some((c) => !c.closed && c.channel && !c.channel.lost)) return;
    announce('studio', 'keeper: the last chat the keeper held from before has ended; letting the keeper go');
    this.keeper.disconnect();
  },

  /**
   * At start (before the automatic reconnect): every chat whose agent still runs in the keeper is rebuilt from the keeper's record
   * and goes on live, its turn, question and queue included. Nothing is sent again. Returns how many chats were taken over.
   * Ended channels older than a week are removed; a live channel without a chat note (an AIB that crashed while starting it)
   * is stopped.
   */
  adoptKeeper(this: Aib): Promise<number> {
    if (!this.$adopting) {
      // The Windows keeper first (its keep-alives name the distros to ask), then each distro's Linux keeper. The WSL part (it may
      // have to boot the distro and install the Linux programs) never holds up the Windows chats: adoptKeeperWindows() resolves
      // as soon as they are taken over, and the app's window never waits for either (main.ts).
      const windows = (this.keeper ? this.$adoptFrom(this.keeper, null) : Promise.resolve(0)).catch((error) => {
        log.exception(error, 'keeper: taking chats over failed');
        return 0;
      }).finally(() => (this.$windowsAdoptDone = true));
      this.$adoptingWindows = windows;
      this.$adopting = windows.then(async (n) => n + await this.$adoptWsl()).catch((error) => {
        log.exception(error, 'keeper: taking chats over failed');
        return 0;
      }).finally(() => (this.$adoptDone = true));
    }
    return this.$adopting;
  },

  /** True while the take-over at start (the Windows keeper's or a distro's) still runs. */
  takingOver(this: Aib): boolean {
    return !!this.$adopting && !this.$adoptDone;
  },

  /** The take-over from the Windows keeper only (started by adoptKeeper()): the WSL distros' may still be on their way. */
  adoptKeeperWindows(this: Aib): Promise<number> {
    void this.adoptKeeper();
    return this.$adoptingWindows!;
  },

  /**
   * True while the take-over at start may still rebuild the chat of this folder (the page shows it as Reconnecting…, never as
   * Not running, until its keeper has been asked).
   */
  $takeOverPending(this: Aib, cwd: string): boolean {
    if (!this.$adopting || this.$adoptDone) return false;
    const loc = wslLoc(cwd);
    return loc ? !this.$wslAsked.has(loc.distro) : !this.$windowsAdoptDone;
  },

  async $adoptWsl(this: Aib): Promise<number> {
    let adopted = 0;
    for (const distro of this.$wslDistrosToAdopt()) {
      try {
        adopted += await this.adoptWslKeeper(distro);
      } catch (error) {
        log.warning('keeper: taking WSL chats over from %s failed: %s', distro, errorText(error));
      }
    }
    return adopted;
  },

  /**
   * The distros whose Linux keeper may still hold chats of this data folder: those of the chats on the recovery list (they ran when
   * the previous AIB stopped). Only those are asked, so a start never boots a distro no chat of AIB ran in.
   */
  $wslDistrosToAdopt(this: Aib): string[] {
    const out = new Set<string>(this.$heldDistros); // a live keep-alive in the Windows keeper: that distro's keeper holds work
    for (const item of this.store ? [...this.store.conversations.values()] : []) {
      const loc = wslLoc(item.cwd);
      if (loc) out.add(loc.distro);
    }
    return [...out];
  },

  /**
   * Before a WSL chat is continued: if this process has not yet asked its distro's keeper (the take-over at start failed or never
   * asked), ask now, so an agent still running there is taken over instead of a second one started for the same session.
   */
  async $wslTakeOverFirst(this: Aib, distro: string): Promise<void> {
    if (this.$adopting && !this.$adoptDone) await this.$adopting; // the take-over at start first
    if (this.$wslAsked.has(distro)) return;
    let run = this.$wslAsking.get(distro);
    if (!run) {
      run = this.adoptWslKeeper(distro).catch((error) => {
        log.warning('keeper: taking WSL chats over from %s failed: %s', distro, errorText(error));
        return 0;
      }).finally(() => this.$wslAsking.delete(distro));
      this.$wslAsking.set(distro, run);
    }
    await run;
  },

  /**
   * Rebuild the chats a distro's Linux keeper still runs (an AIB restart or update while WSL agents worked; the hold kept them alive).
   * Same rules as the Windows keeper's take-over. The distro is started for this (only distros a chat on the recovery list ran in are
   * asked: $wslDistrosToAdopt). Returns how many were taken over.
   */
  async adoptWslKeeper(this: Aib, distro: string): Promise<number> {
    let host;
    try {
      host = await hostWhenReady(distro, 120_000);
    } catch (error) {
      log.warning('keeper: %s is not ready, so its chats were not taken over: %s', distro, errorText(error));
      return 0;
    }
    const link = linkOf(host);
    this.$followWslLink(link);
    return await this.$adoptFrom(link, distro);
  },

  /**
   * Take over the chats of one keeper: the Windows keeper (distro null) or a distro's Linux keeper. `check`: the look before a saved
   * chat's agent starts ($runningInKeeper): only live chat channels this AIB holds no chat for are rebuilt; nothing is stopped or
   * removed, and a keeper that cannot be asked throws instead of counting as empty.
   */
  $adoptFrom(this: Aib, keeper: KeeperLink, distro: string | null, check = false): Promise<number> {
    return this.$adoptGate.run(() => this.$adoptFromNow(keeper, distro, check));
  },

  /**
   * Before a saved chat's agent starts: is that session's agent still running in the keeper it would start in? Then that chat is
   * taken over (rebuilt from its channel) and returned instead, so one session never runs as two agents. This covers a take-over
   * at start that failed or timed out (a distro slow to answer), and a keeper link that was given up while its agents kept running.
   * null: no agent of that session runs there. A distro's keeper that cannot be asked is an error (starting blind could make a
   * second agent; the auto-reconnect tries again); the Windows keeper's is logged and the chat starts as before.
   */
  async $runningInKeeper(this: Aib, provider: string, sessionId: string, keeper: KeeperLink, distro: string | null): Promise<Connection | null> {
    try {
      await this.$adoptFrom(keeper, distro, true);
    } catch (error) {
      if (distro) throw new Error(`AIB could not ask ${distroName(distro)} whether this chat still runs there: ${errorText(error)}`);
      log.warning('keeper: could not ask the keeper whether %s %s still runs: %s', provider, sessionId, errorText(error));
    }
    return [...this.connections.values()].find((c) => c.provider === provider && c.sessionId === sessionId && !c.closed) ?? null;
  },

  /**
   * Owner rule 2026-11-17 (a conversation is one chat; the owner's chat history, AIB's own lines too, is permanent): reopening a
   * conversation whose chat has a history store goes on in that store under the same chat id, whatever ended the agent (an idle
   * quit, a crash, a lost keeper, an update, a closed chat). Where one conversation has several stores (it came back under new ids
   * before this rule), the newest one (by its last event) is continued. null: no store, or none can go on now (a new id and store).
   */
  async $storeToContinue(this: Aib, provider: string, sessionId: string, keeper: KeeperLink): Promise<{ id: string; store: ContinueStore } | null> {
    const h = this.historyClient();
    if (!h) return null;
    let found: { chat: string }[] = [];
    try {
      found = await h.find(provider, sessionId);
    } catch (error) {
      log.warning('history: could not look for the stores of %s %s: %s', provider, sessionId, errorText(error));
      return null;
    }
    for (const { chat } of found) {
      const old = this.connections.get(chat);
      if (old && !old.closed) continue; // its chat is open (a live one was returned before this); never two chats on one store
      if (old) { // ended in this AIB: its keeper channel's removal and its store's close are done first (one writer per store)
        await old.channelRemoved.catch(() => {});
        await old.historyDetach();
      }
      if (!(await this.$freeChannel(keeper, chat))) continue;
      try {
        const info = await h.open(chat, {});
        if (!info.last || !info.eventsId) {
          await h.close(chat).catch(() => {});
          continue;
        }
        const tail = await h.before(chat, info.last + 1, { session: null, limit: MAX_EVENTS, bytes: 32 * 1024 * 1024 });
        await h.close(chat);
        log.info('history: %s %s reopens as chat %s, going on in its store from seq %s', provider, sessionId, chat, info.last);
        return {
          id: chat,
          store: { eventsId: info.eventsId, sequence: info.last, events: tail.events.map((r) => JSON.parse(r.data) as Json) },
        };
      } catch (error) {
        log.warning('history: the store of %s could not be read to reopen it: %s', chat, errorText(error));
        await h.close(chat).catch(() => {});
      }
    }
    return null;
  },

  /**
   * The keeper channel name `chat-<id>` free for a reopened chat: an ended channel of it (its agent exited, or the keeper came back
   * after a crash with it on disk) is removed. False when it is live (its agent still runs there) or the keeper cannot say.
   */
  async $freeChannel(this: Aib, keeper: KeeperLink, chat: string): Promise<boolean> {
    const name = `chat-${chat}`;
    try {
      // the keeper the agent will start in (started now if it is not running, as the spawn would): one that starts again keeps the
      // ended channels of its journal folder, so "not running" does not mean "no channel"
      const client = await keeper.check();
      const info = (await client.list()).find((i) => i.channel === name);
      if (!info) return true;
      if (info.live) return false;
      await keeper.removeEnded(client, name);
      return true;
    } catch (error) {
      log.warning('keeper: could not free the channel of chat %s to reopen it: %s', chat, errorText(error));
      return false;
    }
  },

  /** The person deleted the conversation: its chat's history stores go too (every one of them). Returns the chat ids removed. */
  async forgetHistory(this: Aib, provider: string, sessionId: string): Promise<string[]> {
    const h = this.historyClient();
    if (!h || !provider || !sessionId) return [];
    const live = [...this.connections.values()].some((c) => !c.closed && c.provider === provider && c.sessionId === sessionId);
    if (live) return []; // a delete of a live chat is refused before this (conversationAction)
    for (const c of this.connections.values()) {
      if (c.provider === provider && c.sessionId === sessionId) await c.historySettled().catch(() => {});
    }
    const removed = await h.forget(provider, sessionId);
    if (removed.length) log.info('history: %s %s was deleted: removed its store(s) %s', provider, sessionId, removed.join(', '));
    return removed;
  },

  async $adoptFromNow(this: Aib, keeper: KeeperLink, distro: string | null, check: boolean): Promise<number> {
    let client;
    try {
      client = await keeper.client(false); // only a keeper that already runs: nothing to take over otherwise
    } catch (error) {
      if (check) throw error;
      log.warning('keeper: could not reach the keeper: %s', errorText(error));
      // A keeper that answers but refuses this AIB (another protocol): its chats keep running there; the page says so.
      if (!distro && error instanceof KeeperError && error.code !== 'closed') {
        noteKeeperTakeoverProblem(`the keeper refused this AIB: ${errorText(error)}`);
      }
      return 0;
    }
    if (!client) {
      if (distro) this.$wslAsked.add(distro); // no Linux keeper runs: nothing of it to take over
      return 0;
    }
    const missing = missingFeatures(client.features);
    if (missing.length) {
      // The same rule as Install now's (release.json keeper.needs): a keeper without what this AIB needs is not taken over, and
      // nothing in it is stopped.
      const why = `the running keeper (${client.keeperVersion || 'unknown version'}) lacks ${missing.join(', ')}`;
      announce('studio', 'keeper: not taking chats over: %s', why);
      if (!distro && !check) noteKeeperTakeoverProblem(why); // a distro's keeper version is wsl/hosts.ts's business (it replaces or adopts)
      return 0;
    }
    if (!distro && !check) noteKeeperTakeoverProblem('');
    let adopted = 0;
    const started = performance.now();
    const listed = await client.list();
    if (distro) this.$wslAsked.add(distro);
    if (!distro && !check && this.hasStateDir && this.worktrees) { // Gemini chat folders no running or open chat uses any more
      const keep = new Set([...this.connections.keys()]);
      for (const info of listed) if (info.live) for (const id of gemini.idsInArgs([info.command, ...(info.args ?? [])])) keep.add(id);
      try {
        gemini.sweep(this.stateDir, this.worktrees.registry.root, keep);
      } catch (error) {
        log.exception(error, 'Sweeping Gemini chat folders failed');
      }
      // Qwen chats' system settings files (subagents/qwen.ts): a chat running in the keeper keeps its file
      const keepQwen = new Set([...this.connections.keys()]);
      for (const info of listed) if (info.live) keepQwen.add(chatIdOfChannel(info.channel));
      qwenSub.sweepSettings(this.stateDir, keepQwen);
      copilotMcp.sweepConfigs(this.stateDir, keepQwen); // Copilot chats' MCP config files (agents/copilot_mcp.ts), kept the same way
    }
    let rebuilt = 0;
    for (const info of listed) {
      try {
        if (info.kind !== 'pipe') continue;
        if (info.channel.startsWith(CLIENT_TERMINAL_PREFIX)) continue; // an agent's client terminal: its chat takes it over
        if (isAibInternalLabel(info.label)) { // AIB's own WSL hold or helper: never a chat, never stopped as an orphan
          const held = !distro && info.live ? heldDistro(info.label) : '';
          if (held) this.$heldDistros.add(held);
          continue;
        }
        if (keeper.channels.has(info.channel)) continue; // one of this AIB's own (a chat it runs, or one starting right now)
        if (!info.live) {
          if (!check && info.ended && Date.now() - info.ended > 7 * 86400_000) await keeper.removeEnded(client, info.channel);
          continue;
        }
        const timer = new PhaseTimer();
        const facts = await keeper.channelFacts(client, info.channel);
        let note = facts.note;
        timer.mark('note');
        if (!note || note.t !== 'chat' || !isStr(note.id) || !isStr(note.provider) || !isStr(note.cwd)) {
          if (check) continue; // only the start acts on a channel without a chat record
          const chatId = chatIdOfChannel(info.channel);
          if (!chatId) { // not a chat's channel at all (another program's, or an old build's): stopped as before
            announce('studio', 'keeper: stopping channel %s: it has no chat record', info.channel);
            await keeper.stopUnknown(client, info.channel);
            continue;
          }
          // A chat's channel is never stopped for a missing record (owner rule: quitting or updating AIB never kills a working chat):
          // its record is made again from what the keeper and AIB still know, and the chat is taken over with it.
          note = this.$recordFromKeeper(info, chatId, facts.sessionId, distro);
          if (!note) {
            announce(
              'studio',
              'keeper: channel %s has no chat record and names no session; it keeps running in the keeper (not taken over)',
              info.channel,
            );
            continue;
          }
          announce(
            'studio',
            'keeper: channel %s had no chat record%s; rebuilt it from the keeper: %s %s in %s',
            info.channel,
            facts.timedOut ? ' (reading it timed out)' : '',
            note.provider,
            note.resume,
            note.cwd,
          );
        }
        if (!isStr(note.id)) continue;
        const known = this.connections.get(note.id);
        // A chat whose link to this channel was given up (the keeper could not be reached for a while) while its agent kept running
        // is rebuilt under its own id; any other chat this AIB has (open, or closed by the user) keeps the channel as it is.
        if (known && !(check && known.closed && known.channel?.lost)) continue;
        // Between chats, the page's requests get their turn: a big chat's note parse and replay are synchronous work, and the
        // window is open while this runs (main.ts).
        if (rebuilt++) await new Promise((resolve) => setTimeout(resolve, 0));
        if (!check) await testTakeOverDelay();
        const done = await this.$rebuildChat(info, note, keeper, distro, timer);
        if (done) {
          const rebuilt = this.connections.get(note.id);
          if (!rebuilt || !await this.$dropDuplicate(rebuilt)) adopted++;
          timer.mark('duplicate check');
        }
        const session = this.connections.get(note.id)?.sessionId ?? (isStr(note.resume) ? note.resume : '');
        timer.log(`${note.provider} ${session || '-'} ${note.id}${done ? '' : ' (not taken over)'}`);
      } catch (error) {
        log.exception(error, 'keeper: taking over channel failed');
      }
    }
    if (!check) await this.$dropOrphanTerminals(client, listed, keeper);
    if (adopted) {
      announce('studio', 'keeper: %s chat(s) taken over from the keeper in %s ms', adopted, Math.round(performance.now() - started));
      // Their artifact tool is the keeper's forwarder: it needs this AIB's HTTP endpoint and its published address.
      const forwarded = [...this.connections.values()].some((c) => c.channel && !c.closed && c.mcpServers.some(isForwardEntry));
      if (forwarded && !this.options.noArtifactTool) {
        try {
          this.artifactMcpHttp();
          ownForwardFile(join(this.stateDir, FORWARD_FILE));
        } catch (error) {
          log.exception(error, 'Could not start the HTTP artifact tool for the chats taken over from the keeper');
        }
      }
    }
    return adopted;
  },

  /**
   * Client terminals whose chat is gone (it ended while no AIB ran, or could not be taken over): stopped and removed. Those of a chat
   * that was taken over were re-attached by it (Connection, from its clientTerminal notes) and are left alone.
   */
  async $dropOrphanTerminals(this: Aib, client: KeeperClient, listed: ChannelInfo[], keeper: KeeperLink): Promise<void> {
    for (const info of listed) {
      if (!info.channel.startsWith(CLIENT_TERMINAL_PREFIX) || keeper.channels.has(info.channel)) continue;
      if (isAibInternalLabel(info.label)) continue; // AIB's own WSL hold or helper
      let chat = '';
      try {
        chat = String(JSON.parse(info.label ?? '{}').chat ?? '');
      } catch { /* no label */ }
      const owner = chat ? this.connections.get(chat) : undefined;
      if (owner && !owner.closed) continue; // a read-only chat keeps its agent's terminals as they are
      try {
        if (info.live) {
          announce('studio', 'keeper: stopping client terminal %s: its chat is gone', info.channel);
          await keeper.stopUnknown(client, info.channel);
        }
        await keeper.removeEnded(client, info.channel);
      } catch (error) {
        log.warning('keeper: could not remove client terminal %s: %s', info.channel, errorText(error));
      }
    }
  },

  /**
   * A keeper can hold two agents for one session (an earlier AIB that could not take its chat over started another one for it).
   * Both would be listed as the same chat twice. Keep the one that is working, else the first; the other agent is stopped (the
   * session's own transcript is shared, so nothing is lost). True when `c` was the one dropped.
   */
  async $dropDuplicate(this: Aib, c: Connection): Promise<boolean> {
    if (!c.sessionId || c.closed) return false;
    const other = [...this.connections.values()].find((o) =>
      o !== c && !o.closed && o.provider === c.provider && o.sessionId === c.sessionId
    );
    if (!other) return false;
    const loser = c.busy && !other.busy ? other : c;
    announce('studio', 'keeper: %s %s was running twice; stopping the %s one (%s)', c.provider, c.sessionId, loser === c ? 'second' : 'first', loser.id);
    try {
      await loser.close();
    } catch (error) {
      log.warning('keeper: could not stop the duplicate chat %s: %s', loser.id, errorText(error));
    }
    return loser === c;
  },

  /**
   * A chat note made again for a chat channel whose own is gone (a journal truncated past it, or one that never had it): the chat id
   * from the channel name, the session from the agent's lines, the provider, folder and project from AIB's recovery list (else
   * from the agent's command and the keeper's folder). null: no session is known, so nothing can continue it.
   */
  $recordFromKeeper(this: Aib, info: ChannelInfo, chatId: string, sessionId: string | null, distro: string | null): Json | null {
    if (!sessionId) return null;
    const saved = this.store
      ? [...this.store.conversations.values()].find((c) => c.sessionId === sessionId) ?? null
      : null;
    const command = [info.command, ...(info.args ?? [])].map(String);
    const provider = saved?.provider || providerOfCommand(command);
    // a distro's keeper knows the Linux folder; AIB's list has the wsl:// one the rebuild needs
    const cwd = (distro ? saved?.cwd : info.cwd || saved?.cwd) || '';
    if (!provider || !cwd) return null;
    return {
      t: 'chat',
      id: chatId,
      provider,
      cwd,
      loc: { kind: 'win' },
      projectRoot: saved?.projectRoot || cwd,
      worktree: null,
      resume: sessionId,
      command,
      mcpServers: [],
      rebuiltRecord: true,
    };
  },

  async $rebuildChat(
    this: Aib,
    info: ChannelInfo,
    note: Json,
    keeper: KeeperLink,
    distro: string | null,
    timer = new PhaseTimer(),
  ): Promise<boolean> {
    const command = Array.isArray(note.command) ? note.command.map(String) : [];
    const cwd = String(note.cwd);
    const provider = String(note.provider);
    const options: ConnectionOptions = { keeper, id: String(note.id), rebuild: info, start: false, history: this.historyClient(String(note.id)) };
    // A distro's keeper holds only that distro's chats: the note's loc (or its ref) says where the agent works; it starts nothing.
    const loc = isDict(note.loc) && note.loc.kind === 'wsl' && isStr(note.loc.linuxPath) ? note.loc : null;
    const wsl = distro ? (loc ? { distro, linuxPath: String(loc.linuxPath) } : wslLoc(cwd)) : null;
    if (distro && !wsl) {
      announce('studio', 'keeper: %s in %s has no WSL folder; not taken over', note.id, distro);
      return false;
    }
    if (wsl) {
      const host = wslHost(wsl.distro);
      const which = async (name: string) => host ? (await host.call('which', { name })).path : null;
      // the agent's later client terminals still run in the distro, with its environment
      options.wsl = { distro: wsl.distro, linuxPath: wsl.linuxPath, ...(host ? { caps: { env: () => host.env(), which } } : {}) };
    }
    const c = this.connectionFactory(command, cwd, provider, options);
    c.adopted = true;
    if (isDict(note.worktree)) c.worktree = { branch: String(note.worktree.branch ?? ''), base: String(note.worktree.base ?? '') };
    c.projectRoot = isStr(note.projectRoot) && note.projectRoot ? note.projectRoot : cwd;
    if (isClaudeFamily(provider) || isCodexFamily(provider) || isQwenFamily(provider) || isAntigravity(provider) || nativeOff.nativeOffAgent(provider)) c.subagentHooks = hooksFromNote(note.subagentHooks); // as the chat started (should-fix 6)
    if (provider === 'gemini' && this.hasStateDir && this.worktrees) { // its fence and redirect as launched (subagents/gemini.ts)
      c.geminiSubagents = gemini.restore(this.stateDir, this.worktrees.registry.root, c.id, c.projectRoot || cwd);
    }
    this.$wire(c);
    if (wsl && this.allow) void c.allowWarm(); // allow rules: the rebuilt WSL chat's distro facts (allow/wsl_facts.ts; never throws)
    const helper = this.hasStateDir
      ? helperOf(readHelpers(this.stateDir), { lasting: isStr(note.resume) && note.resume ? `${provider}:${note.resume}` : null, path: cwd })
      : null;
    c.swarm = helper
      ? { role: 'helper', helperId: helper.id, parent: helper.parent.live }
      : !wsl || WSL_TOOL_GROUPS.swarm // the same rule as a new chat: every non-helper chat is main, in a worktree or the project folder
      ? { role: 'main' }
      : null;
    c.mcpServers = Array.isArray(note.mcpServers) ? note.mcpServers as McpServer[] : [];
    if (wsl) for (const entry of c.mcpServers) ownTunnelEntry(entry); // its tunnel entry is still AIB's own tool after a restart
    c.sessionId = isStr(note.resume) && note.resume ? note.resume : null;
    c.recovery = this.recovery as never;
    this.connections.set(c.id, c);
    const label = `${provider} ${c.sessionId ?? ''} in ${cwd}`.replace('  ', ' ');
    timer.mark('setup');
    try {
      await c.rebuilt;
    } catch { /* read-only (rebuildError says why) or the keeper went away */ }
    // subagent worktrees P3: a subagent that ended while AIB was down (its SubagentStop hook failed open) is settled from the replayed
    // stream, so it never stays "running"
    if (isClaudeFamily(provider) && this.subagents) {
      await this.subagents.reconcileEnded(c.id, c.endedSubagents()).catch((error) => log.exception(error, 'Subagent take-over check failed'));
    }
    rebuildPhases(timer, c.rebuildTimes);
    try {
      if (c.closed) return false;
      if (c.rebuildError) {
        announce('studio', 'keeper: %s stays read-only: %s', label, c.rebuildError);
        return false;
      }
      if ((!c.ready || !c.sessionId) && note.rebuiltRecord === true) {
        // A record made again from the keeper that did not bring the chat back: its agent keeps running (never stopped for a lost
        // record); the chat stays read-only here.
        announce('studio', 'keeper: %s (record rebuilt from the keeper) did not come back ready; its agent keeps running', label);
        return false;
      }
      if (!c.ready || !c.sessionId) {
        c.error = 'AIB restarted while this chat was opening, so it was stopped. Open it again.';
        await c.close();
        return false;
      }
      try {
        c.sessionLease = await new SessionLease(this.stateDir, provider, c.sessionId).acquire();
      } catch (error) {
        log.warning('keeper: no session lease for %s: %s', label, errorText(error));
      }
      timer.mark('lease');
      if (this.recovery) {
        this.recovery.connectionReady(c);
        const saved = this.recovery.queues?.get(provider, c.sessionId) ?? [];
        if (saved.length) await c.queueContinue(saved); // the turn never stopped, so neither does its queue
      }
      this.announce(c, 'ready');
      timer.mark('queue and announce');
      if (this.wslSync && wsl) await this.wslSync.chatOpened(c); // its distro's helper watches it (never throws)
      else if (this.liveSync) {
        try {
          await this.liveSync.chatOpened(c);
        } catch (error) {
          log.exception(error, 'Starting live sync failed');
        }
      }
      timer.mark('live sync');
      announce('studio', 'keeper: rebuilt %s (%s)', label, c.busy ? 'turn running' : 'idle');
      console.error(`Keeper: continued ${label}`);
      return true;
    } finally {
      c.openDone.set();
    }
  },
};

export type KeeperMethods = typeof keeperMethods;
