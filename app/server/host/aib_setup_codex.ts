/**
 * Aib methods: Codex chat setup (subagent hooks) and the Codex hook route call.
 * Moved out of aib.ts (no change).
 */
import { Connection, errorText } from '../acp/connection.ts';
import { isCodexFamily } from '../agents/claude_family.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { FORWARD_FILE } from '../artifacts/mcp_http.ts';
import { hookForwarderOf, hookForwarderTagsShells, keyForForwarder } from '../keeper/client.ts';
import { deny as denyHook, type HookAnswer } from '../subagents/service.ts';
import * as codexSub from '../subagents/codex.ts';
import { isDict, pyStrip } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { isFixture, testHomeEnv } from '../acp/connection.ts';
import { wslHost, wslLoc } from '../wsl/access.ts';
import { log } from './aib_util.ts';
import { HOOKS_OFF, MAX_PRE_TOOL_WAITING, SUBAGENT_BUSY, offHooks } from './aib_helpers.ts';
import type { Aib } from './aib.ts';
import type { ConnectHook } from './aib_connect_hooks.ts';

export const codexSetupMethods = {
  /**
   * A Codex chat's hook call (subagents/codex.ts), key already checked. Only a Codex chat that was given hooks answers; its
   * spawn_agent calls are limited like Claude's Agent calls (MAX_PRE_TOOL_WAITING at once). Never throws.
   */
  async $codexHookCall(this: Aib, event: string, conversation: string, body: unknown): Promise<HookAnswer> {
    const chat = this.$subagentChat(conversation);
    if (!chat || !isCodexFamily(chat.provider) || !chat.hooks || !isDict(body)) {
      return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
    }
    const spawn = event === 'codex-pre-tool' && !body.agent_id;
    const waiting = this.$preToolWaiting.get(conversation) ?? 0;
    if (spawn && waiting >= MAX_PRE_TOOL_WAITING) return denyHook(SUBAGENT_BUSY);
    if (spawn) this.$preToolWaiting.set(conversation, waiting + 1);
    try {
      // a WSL chat's hook runs in its distro (the helper runs codexHook over its own records; SubagentWorktrees.hook hands it over)
      if (chat.wsl) return await this.subagents!.hook(event, conversation, body);
      return await codexSub.codexHook(this.subagents!, event, chat, body as Record<string, unknown>);
    } catch (error) {
      log.exception(error, 'Codex subagent hook %s failed', event);
      return event === 'codex-pre-tool'
        ? denyHook(`AIB couldn't check this call against the subagent's worktree: ${errorText(error)}`)
        : { status: 500, body: 'AIB could not answer this hook', type: 'text/plain' };
    } finally {
      if (spawn) {
        const left = (this.$preToolWaiting.get(conversation) ?? 1) - 1;
        if (left > 0) this.$preToolWaiting.set(conversation, left);
        else this.$preToolWaiting.delete(conversation);
      }
    }
  },

  /**
   * The hooks a new Codex chat gets (subagents/codex.ts): CODEX_CONFIG with AIB's hooks (the user's own CODEX_CONFIG merged in) and
   * the chat's hook key in the agent's environment; or, when hooks are off or AIB can't give them (owner rule 2026-11-16), the same
   * CODEX_CONFIG with features.multi_agent = false, and a chat line. `wslEnv`: the distro's environment of a WSL chat (its hooks
   * would run in the distro: not yet, so off). Null: under test, a fixture or a run that allows no real agent (left as it is).
   */
  async $codexSubagentHooks(
    this: Aib,
    command: string[],
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wslEnv: Record<string, string> | null,
    chatId: string | null = null, // a reopened chat keeps its id (its hook key and subagent folder are bound to it)
    wslDistro: string | null = null,
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; note?: string } | null> {
    const result = await this.$codexHooksFor(command, folder, project, aibWorktree, env, wslEnv, chatId, wslDistro);
    if (!result) return null;
    // open elsewhere (ownership/handoff.ts): its threads unload as soon as AIB lets go of them, so another app can open them at once
    const agentEnv = wslEnv ? { ...wslEnv, ...env } : { ...Deno.env.toObject(), ...env };
    const config = codexSub.withUnloadNow(result.env?.CODEX_CONFIG ?? agentEnv.CODEX_CONFIG);
    return config === null ? result : { ...result, env: { ...result.env, CODEX_CONFIG: config } };
  },

  async $codexHooksFor(
    this: Aib,
    command: string[],
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wslEnv: Record<string, string> | null,
    chatId: string | null,
    wslDistro: string | null = null,
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; note?: string } | null> {
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && (isFixture(command) || !realAllowed)) return null;
    const agentEnv = wslEnv ? { ...wslEnv, ...env } : { ...Deno.env.toObject(), ...testHomeEnv(command), ...env };
    // a WSL chat's config files are the distro's: only its CODEX_CONFIG is read
    const setup = wslEnv
      ? codexSub.readCodexSetup('', agentEnv.CODEX_CONFIG ? { CODEX_CONFIG: agentEnv.CODEX_CONFIG } : {})
      : codexSub.readCodexSetup(project, agentEnv);
    if (setup.configError) return { hooks: offHooks(setup.configError) }; // codex-acp refuses it as well: nothing to merge into
    const off = (why: string, detail: string) => ({
      env: { CODEX_CONFIG: JSON.stringify(codexSub.withSubagentsOff(setup.config)) },
      hooks: { ...offHooks(why, detail), prompt: codexSub.CODEX_SUBAGENTS_OFF_PROMPT },
      note: `Subagents are off in this chat: ${detail}, so AIB can't give them their own worktree.`,
    });
    if (!this.subagents || !this.hasStateDir) return off('AIB has no state folder', 'AIB has no state folder');
    if (wslEnv) { // its hooks run in the distro through the helper's tunnel; what AIB can't read of the distro's Codex setup, the helper does
      try {
        const host = wslDistro ? wslHost(wslDistro) : null;
        const tunnel = host?.hookTunnel ?? null;
        const where = wslLoc(folder), home = wslLoc(project);
        if (!host || !tunnel || !where || !home) return off('WSL hooks unavailable', "this distro's AIB helper can't give subagents their own worktree yet");
        const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
        const remote = await host.call('subagent.setup', {
          agent: 'codex',
          project: home.linuxPath,
          folder: where.linuxPath,
          aibWorktree,
          chatId: id,
          env: { ...(agentEnv.CODEX_CONFIG ? { CODEX_CONFIG: agentEnv.CODEX_CONFIG } : {}), ...(agentEnv.CODEX_HOME ? { CODEX_HOME: agentEnv.CODEX_HOME } : {}) },
        }, { timeoutMs: 60_000 });
        if (remote.configError) return { hooks: offHooks(remote.configError) };
        if (remote.git) return { hooks: offHooks(remote.git) };
        if (remote.hooksOff) return off(HOOKS_OFF, remote.hooksOff);
        const hooks = codexSub.codexHooks(tunnel.forwarder, tunnel.socket, where.linuxPath, remote.config?.hooks, 'linux', true);
        if (!hooks) return off("AIB's keeper folder can't be named in a hook command", "the keeper's folder in the distro has a quote or a line break Codex hooks can't run from");
        const key = artifactKeys.issueHookKey(id);
        if (!key) return off('AIB has no key secret', 'AIB has no key secret');
        if (!remote.subFolder) return off('no subagent folder', "the distro could not make the folder for the subagents' worktrees");
        return {
          id,
          env: { AIB_HOOK_KEY: key, AIB_HOOK_CHAT: id, CODEX_CONFIG: JSON.stringify(codexSub.withCodexHooks(remote.config, hooks)) },
          // a subagent's shell calls get AIB's cookie and the distro's helper shuts down what they left (a helper without subagent.reaps: untagged)
          hooks: { ...offHooks(''), adopted: true, prompt: codexSub.CODEX_SUBAGENT_PROMPT, subFolder: remote.subFolder, ...(host.hookShellTag === true ? { shellTag: true } : {}) },
        };
      } catch (error) {
        log.exception(error, 'Could not set up Codex subagent hooks in the distro; its subagents are off');
        return off('AIB could not set up its hooks', `AIB could not set up its hooks (${errorText(error)})`);
      }
    }
    try {
      if (!aibWorktree) { // as Claude's: no worktree can be made outside git (nothing changes for its subagents)
        const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
        if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) return { hooks: offHooks('not a git project') };
        if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
          return { hooks: offHooks('the repository has no commits yet') };
        }
      }
      if (setup.hooksOff) return off(HOOKS_OFF, setup.hooksOff);
      const forwarder = await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
      if (!forwarder) return off("AIB's keeper program can't run hooks", "AIB's keeper program can't run hooks");
      const hooks = codexSub.codexHooks(forwarder, join(this.stateDir, FORWARD_FILE), folder, setup.config?.hooks);
      if (!hooks) return off("AIB's folder can't be named in a hook command", "AIB's folder has a space or a sign Codex hooks can't run from");
      this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
      const key = artifactKeys.issueHookKey(id);
      if (!key) return off('AIB has no key secret', 'AIB has no key secret');
      // its subagents' worktrees go in a folder of this chat's own, a writable root of its sandbox (Connection.extraFolders)
      const subFolder = codexSub.subagentFolder(this.subagents.root, project, id);
      Deno.mkdirSync(subFolder, { recursive: true });
      return {
        id,
        env: { AIB_HOOK_KEY: keyForForwarder(forwarder, 'hook-key', key), AIB_HOOK_CHAT: id, CODEX_CONFIG: JSON.stringify(codexSub.withCodexHooks(setup.config, hooks)) },
        hooks: { ...offHooks(''), adopted: true, prompt: codexSub.CODEX_SUBAGENT_PROMPT, subFolder, ...(hookForwarderTagsShells(forwarder) ? { shellTag: true } : {}) },
      };
    } catch (error) {
      log.exception(error, 'Could not set up Codex subagent hooks; its subagents are off');
      return off('AIB could not set up its hooks', `AIB could not set up its hooks (${errorText(error)})`);
    }
  },
};

export type CodexSetupMethods = typeof codexSetupMethods;

/** Codex's rules in Aib.connect (aib_connect_hooks.ts). */
export const codexConnectHook: ConnectHook = {
  // Codex (subagents/codex.ts): its hooks go in CODEX_CONFIG; hooks off or unavailable turn its subagents off instead.
  prepare(this: Aib, x) {
    return this.$codexSubagentHooks(x.command, x.cwd, x.workspace, x.worktree, x.env, x.spawnEnv, x.chatId, x.distro);
  },
  // A Codex agent starts once the chat's MCP servers are known: they go in its CODEX_CONFIG (acp/codex_mcp.ts), read at its start
  startsLate: true,
};
