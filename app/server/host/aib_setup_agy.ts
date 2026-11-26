/**
 * Aib methods: Antigravity (agy) chat setup (subagent hooks, WSL hooks) and the agy hook route call.
 * Moved out of aib.ts (no change).
 */
import { Connection, errorText } from '../acp/connection.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { FORWARD_FILE } from '../artifacts/mcp_http.ts';
import { hookForwarderKnowsAgy, hookForwarderOf, keyForForwarder } from '../keeper/client.ts';
import { denyAgy as agyDenyHook, type HookAnswer } from '../subagents/service.ts';
import * as agySub from '../subagents/antigravity.ts';
import { isAntigravity } from '../subagents/antigravity.ts';
import { isDict, pyStrip } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { isFixture } from '../acp/connection.ts';
import { wslHost, wslLoc } from '../wsl/access.ts';
import { log } from './aib_util.ts';
import { MAX_PRE_TOOL_WAITING, WSL_HOOKS_UNAVAILABLE, SUBAGENT_BUSY, offHooks } from './aib_helpers.ts';
import type { Aib } from './aib.ts';

export const agySetupMethods = {
  /**
   * An Antigravity chat's hook call (subagents/antigravity.ts), key already checked. Only an Antigravity chat that was given hooks
   * answers; its invoke_subagent calls are limited like Claude's Agent calls (MAX_PRE_TOOL_WAITING at once). Never throws.
   */
  async $agyHookCall(this: Aib, event: string, conversation: string, body: unknown): Promise<HookAnswer> {
    const chat = this.$subagentChat(conversation);
    if (!chat || !isAntigravity(chat.provider) || !chat.hooks || !isDict(body)) {
      return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
    }
    const tool = isDict(body.toolCall) ? String((body.toolCall as Record<string, unknown>).name ?? '') : '';
    const spawn = event === 'agy-pre-tool' && tool === 'invoke_subagent';
    const waiting = this.$preToolWaiting.get(conversation) ?? 0;
    if (spawn && waiting >= MAX_PRE_TOOL_WAITING) return agyDenyHook(SUBAGENT_BUSY);
    if (spawn) this.$preToolWaiting.set(conversation, waiting + 1);
    try {
      // a WSL chat's hook runs in its distro (the helper runs agyHook over its own records; SubagentWorktrees.hook hands it over)
      if (chat.wsl) return await this.subagents!.hook(event, conversation, body);
      return await agySub.agyHook(this.subagents!, event, chat, body as Record<string, unknown>);
    } catch (error) {
      log.exception(error, 'Antigravity subagent hook %s failed', event);
      return event === 'agy-pre-tool'
        ? agyDenyHook(`AIB couldn't check this call against the subagent's worktree: ${errorText(error)}`)
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
   * The hooks a new Antigravity chat gets (subagents/antigravity.ts). With an API key saved the agent runs with --gemini-dir <AIB's own
   * folder> (the launch command says so; a WSL chat's folder is made in its distro): AIB writes its entry in <that folder>/config/
   * hooks.json and puts the chat's hook key, chat id and agy's subagent worktrees folder in the agent's environment. Without it (a
   * Google sign-in uses ~/.gemini; AIB writes neither that nor the project), or when the hooks can't be written, nothing is enforced:
   * the chat says why and asks the agent not to start editing subagents. A project that is not a git project has no worktree to give:
   * its subagents run as before (AIB_HOOK_PASS). Null: under test, a fixture or a run that allows no real agent (left as it is).
   */
  async $agySubagentHooks(
    this: Aib,
    command: string[],
    folder: string,
    project: string,
    aibWorktree: boolean,
    chatId: string | null,
    wslDistro: string | null = null,
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; args?: string[] } | null> {
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && (isFixture(command) || !realAllowed)) return null;
    if (!this.subagents || !this.hasStateDir) return { hooks: offHooks('AIB has no state folder', 'AIB has no state folder') };
    const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
    const off = (why: string, detail: string, extra: Record<string, string> = {}, args?: string[]) => ({
      id,
      env: { AIB_HOOK_PASS: '1', ...extra }, // an entry of ours left in the folder's hooks.json lets everything through for this chat
      hooks: offHooks(why, detail),
      ...(args ? { args } : {}),
    });
    const hasKey = !!this.settings.betaKey('antigravity');
    if (wslDistro) return await this.$wslAgyHooks(id, wslDistro, folder, project, aibWorktree, hasKey, off);
    const dir = agySub.geminiDirOf(command);
    if (!dir) return { id, hooks: offHooks('Google sign-in', agySub.SIGNIN_WHY) };
    try {
      const stopHooks = (why: string, detail: string) => {
        agySub.writeHooksFile(dir, null); // AIB's own entry of an earlier chat goes: nothing of ours runs for this chat
        return off(why, detail);
      };
      if (!aibWorktree) { // as the other agents': no worktree can be made outside git (nothing changes for its subagents)
        const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
        if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) return stopHooks('not a git project', 'this folder is not a git project');
        if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
          return stopHooks('no commits', 'the repository has no commits yet');
        }
      }
      const forwarder = await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
      if (!forwarder) return stopHooks("AIB's keeper program can't run hooks", "AIB's keeper program can't run hooks");
      if (!hookForwarderKnowsAgy(forwarder)) return stopHooks("AIB's keeper program is too old", "AIB's keeper program is too old for Antigravity hooks");
      const entry = agySub.agyHooksEntry(forwarder, join(this.stateDir, FORWARD_FILE));
      if (!entry) return stopHooks("AIB's folder can't be named in a hook command", "AIB's keeper folder has a space or a sign Antigravity hooks can't run from");
      this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const key = artifactKeys.issueHookKey(id);
      if (!key) return stopHooks('AIB has no key secret', 'AIB has no key secret');
      const problem = agySub.writeHooksFile(dir, entry);
      if (problem) return stopHooks('hooks could not be written', problem);
      return {
        id,
        env: {
          AIB_HOOK_KEY: keyForForwarder(forwarder, 'hook-key', key),
          AIB_HOOK_CHAT: id,
          AIB_HOOK_SUBROOT: agySub.worktreesRootOf(dir),
        },
        hooks: { ...offHooks(''), adopted: true, readOnly: [], prompt: agySub.ANTIGRAVITY_ISOLATED_PROMPT, agyDir: dir },
      };
    } catch (error) {
      log.exception(error, 'Could not set up Antigravity subagent hooks; its subagents are not isolated');
      return off('AIB could not set up its hooks', `AIB could not set up its hooks (${errorText(error)})`);
    }
  },

  /**
   * The WSL side of $agySubagentHooks: the distro's helper makes the chat's gemini folder in the distro (settings.json for the key,
   * config/hooks.json with the hooks on the helper's socket) and names it; the agent is started with --gemini-dir <that folder>. No
   * key: no folder, nothing enforced (as a Windows sign-in chat).
   */
  async $wslAgyHooks(
    this: Aib,
    id: string,
    distro: string,
    folder: string,
    project: string,
    aibWorktree: boolean,
    hasKey: boolean,
    off: (why: string, detail: string, extra?: Record<string, string>, args?: string[]) => { id: string; env: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']> },
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; args?: string[] }> {
    const unavailable = (detail: string) => ({ hooks: { ...offHooks(WSL_HOOKS_UNAVAILABLE, detail) } });
    try {
      if (!hasKey) return { id, hooks: offHooks('Google sign-in', agySub.SIGNIN_WHY) };
      const host = wslHost(distro);
      const tunnel = host?.hookTunnel ?? null;
      const where = wslLoc(folder), home = wslLoc(project);
      if (!host || !tunnel || !where || !home) return unavailable("this distro's AIB helper can't give subagents their own worktree yet");
      const key = artifactKeys.issueHookKey(id);
      const entry = key ? agySub.agyHooksEntry(tunnel.forwarder, tunnel.socket, 'linux', true) : null;
      const remote = await host.call('subagent.setup', {
        agent: 'antigravity',
        project: home.linuxPath,
        folder: where.linuxPath,
        aibWorktree,
        chatId: id,
        antigravity: { hooks: entry },
      }, { timeoutMs: 60_000 });
      if (remote.git) return off('not a git project', remote.git);
      if (!remote.geminiDir) return unavailable('the distro could not make the settings folder');
      const args = ['--gemini-dir', remote.geminiDir];
      if (!entry || !key) return off("AIB's keeper folder can't be named in a hook command", "the keeper's folder in the distro can't be named in a hook command", {}, args);
      return {
        id,
        env: { AIB_HOOK_KEY: key, AIB_HOOK_CHAT: id, AIB_HOOK_SUBROOT: agySub.worktreesRootOf(remote.geminiDir) },
        hooks: { ...offHooks(''), adopted: true, readOnly: [], prompt: agySub.ANTIGRAVITY_ISOLATED_PROMPT, agyDir: remote.geminiDir },
        args,
      };
    } catch (error) {
      log.exception(error, 'Could not set up Antigravity subagent hooks in the distro');
      return unavailable(`the distro could not be asked (${errorText(error)})`);
    }
  },
};

export type AgySetupMethods = typeof agySetupMethods;
