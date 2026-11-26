/**
 * Aib methods: Qwen chat setup (subagent hooks, WSL hooks) and the Qwen hook route call.
 * Moved out of aib.ts (no change).
 */
import { Connection, errorText } from '../acp/connection.ts';
import { isQwenFamily } from '../agents/claude_family.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { FORWARD_FILE } from '../artifacts/mcp_http.ts';
import { hookForwarderKnowsQwen, hookForwarderOf, keyForForwarder } from '../keeper/client.ts';
import { deny as denyHook, type HookAnswer } from '../subagents/service.ts';
import * as qwenSub from '../subagents/qwen.ts';
import { isDict, pyStrip } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { isFixture, testHomeEnv } from '../acp/connection.ts';
import { wslHost, wslLoc } from '../wsl/access.ts';
import { log } from './aib_util.ts';
import { HOOKS_OFF, MAX_PRE_TOOL_WAITING, WSL_HOOKS_UNAVAILABLE, SUBAGENT_BUSY, offHooks } from './aib_helpers.ts';
import type { Aib } from './aib.ts';

export const qwenSetupMethods = {
  /**
   * A Qwen chat's hook call (subagents/qwen.ts), key already checked. Only a Qwen chat that was given hooks answers; its `agent` calls
   * are limited like Claude's Agent calls (MAX_PRE_TOOL_WAITING at once). Never throws.
   */
  async $qwenHookCall(this: Aib, event: string, conversation: string, body: unknown): Promise<HookAnswer> {
    const chat = this.$subagentChat(conversation);
    if (!chat || !isQwenFamily(chat.provider) || !chat.hooks || !isDict(body)) {
      return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
    }
    const spawn = event === 'qwen-pre-tool' && !body.agent_id && String(body.tool_name ?? '').toLowerCase() === 'agent';
    const waiting = this.$preToolWaiting.get(conversation) ?? 0;
    if (spawn && waiting >= MAX_PRE_TOOL_WAITING) return denyHook(SUBAGENT_BUSY);
    if (spawn) this.$preToolWaiting.set(conversation, waiting + 1);
    try {
      // a WSL chat's hook runs in its distro (the helper runs qwenHook over its own records; SubagentWorktrees.hook hands it over)
      if (chat.wsl) return await this.subagents!.hook(event, conversation, body);
      return await qwenSub.qwenHook(this.subagents!, event, chat, body as Record<string, unknown>);
    } catch (error) {
      log.exception(error, 'Qwen subagent hook %s failed', event);
      return event === 'qwen-pre-tool'
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
   * The hooks a new Qwen chat gets (subagents/qwen.ts): a system settings file of AIB's own (QWEN_CODE_SYSTEM_SETTINGS_PATH; the
   * user's own system settings merged in; never ~/.qwen) with AIB's hooks, and the chat's hook key in the agent's environment; or,
   * when hooks are off or AIB can't give them, the same file with `agent` denied (owner rule: never unisolated), and a chat line.
   * A WSL chat's file is written in its distro by the helper, and its hooks run there through the tunnel. Null: under test, a fixture
   * or a run that allows no real agent (left as it is).
   */
  async $qwenSubagentHooks(
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
    if (!this.subagents || !this.hasStateDir) return { hooks: offHooks('AIB has no state folder') };
    const agentEnv = wslEnv ? { ...wslEnv, ...env } : { ...Deno.env.toObject(), ...testHomeEnv(command), ...env };
    const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
    const offRecord = (why: string, detail: string, file: string): { id: string; env: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; note: string } => ({
      id,
      env: file ? { QWEN_CODE_SYSTEM_SETTINGS_PATH: file } : {},
      hooks: { ...offHooks(why, detail), ...(file ? { prompt: qwenSub.QWEN_SUBAGENTS_OFF_PROMPT } : {}) },
      note: qwenSub.qwenOffNote(detail),
    });
    if (wslEnv) return await this.$wslQwenHooks(id, wslDistro, folder, project, aibWorktree, agentEnv, offRecord);
    try {
      if (!aibWorktree) { // as Claude's and Codex's: no worktree can be made outside git (nothing changes for its subagents)
        const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
        if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) return { hooks: offHooks('not a git project') };
        if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
          return { hooks: offHooks('the repository has no commits yet') };
        }
      }
      const setup = qwenSub.readQwenSetup(project, agentEnv);
      const file = qwenSub.settingsFileOf(this.stateDir, id);
      const write = (fragment: qwenSub.QwenFragment) => qwenSub.writeSettingsFile(file, qwenSub.mergeSystemSettings(setup.system, fragment));
      const off = (why: string, detail: string) => offRecord(why, detail, write(qwenSub.offFragment()));
      if (setup.systemError) return off('your Qwen settings can not be read', `${setup.systemError}, so AIB could not merge its own settings with it`);
      if (setup.hooksOff) return off(HOOKS_OFF, setup.hooksOff);
      const forwarder = await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
      if (!forwarder) return off("AIB's keeper program can't run hooks", "AIB's keeper program can't run hooks");
      if (!hookForwarderKnowsQwen(forwarder)) return off("AIB's keeper program is too old for Qwen hooks", "AIB's keeper program is too old for Qwen hooks");
      const hooks = qwenSub.qwenHooks(forwarder, join(this.stateDir, FORWARD_FILE));
      if (!hooks) return off("AIB's folder can't be named in a hook command", "AIB's keeper folder has a space or a sign Qwen hooks can't run from");
      this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const key = artifactKeys.issueHookKey(id);
      if (!key) return off('AIB has no key secret', 'AIB has no key secret');
      return {
        id,
        env: {
          AIB_HOOK_KEY: keyForForwarder(forwarder, 'hook-key', key),
          AIB_HOOK_CHAT: id,
          AIB_HOOK_READONLY: qwenSub.QWEN_READ_ONLY_TYPES.join(','),
          QWEN_CODE_SYSTEM_SETTINGS_PATH: write(qwenSub.onFragment(hooks)),
        },
        hooks: { ...offHooks(''), adopted: true, readOnly: qwenSub.QWEN_READ_ONLY_TYPES, prompt: qwenSub.QWEN_SUBAGENT_PROMPT },
      };
    } catch (error) {
      log.exception(error, 'Could not set up Qwen subagent hooks; its subagents are off');
      try { // the file with `agent` denied, if it can still be written
        const system = qwenSub.readQwenSetup(project, agentEnv).system;
        const file = qwenSub.writeSettingsFile(qwenSub.settingsFileOf(this.stateDir, id), qwenSub.mergeSystemSettings(system, qwenSub.offFragment()));
        return offRecord('AIB could not set up its hooks', `AIB could not set up its hooks (${errorText(error)})`, file);
      } catch {
        return { hooks: offHooks(`AIB could not set up its hooks (${errorText(error)})`) };
      }
    }
  },

  /** The WSL side of $qwenSubagentHooks: the distro's helper reads the distro's Qwen settings and writes the chat's settings file there. */
  async $wslQwenHooks(
    this: Aib,
    id: string,
    distro: string | null,
    folder: string,
    project: string,
    aibWorktree: boolean,
    agentEnv: Record<string, string>,
    offRecord: (why: string, detail: string, file: string) => { id: string; env: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; note: string },
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; note?: string }> {
    const unavailable = (detail: string) => ({ hooks: { ...offHooks(WSL_HOOKS_UNAVAILABLE, detail) }, note: `Subagents can't get their own worktree in this chat: ${detail}.` });
    try {
      const host = distro ? wslHost(distro) : null;
      const tunnel = host?.hookTunnel ?? null;
      const where = wslLoc(folder), home = wslLoc(project);
      if (!host || !tunnel || !where || !home) return unavailable("this distro's AIB helper can't give subagents their own worktree yet");
      const key = artifactKeys.issueHookKey(id);
      const hooks = key ? qwenSub.qwenHooks(tunnel.forwarder, tunnel.socket, 'linux', true) : null;
      const off = qwenSub.offFragment();
      const remote = await host.call('subagent.setup', {
        agent: 'qwen',
        project: home.linuxPath,
        folder: where.linuxPath,
        aibWorktree,
        chatId: id,
        env: Object.fromEntries(['QWEN_HOME', 'QWEN_CODE_SYSTEM_SETTINGS_PATH'].filter((n) => agentEnv[n]).map((n) => [n, agentEnv[n]])),
        qwen: { on: hooks ? qwenSub.onFragment(hooks) : off, off },
      }, { timeoutMs: 60_000 });
      if (remote.git) return { hooks: offHooks(remote.git) };
      if (!remote.settingsFile) return unavailable('the distro could not write the settings file');
      if (remote.configError) return offRecord('your Qwen settings can not be read', `${remote.configError}, so AIB could not merge its own settings with it`, remote.settingsFile);
      if (remote.hooksOff) return offRecord(HOOKS_OFF, remote.hooksOff, remote.settingsFile);
      if (!hooks || !key) return offRecord("AIB's keeper folder can't be named in a hook command", "the keeper's folder in the distro can't be named in a hook command", remote.settingsFile);
      return {
        id,
        env: { AIB_HOOK_KEY: key, AIB_HOOK_CHAT: id, AIB_HOOK_READONLY: qwenSub.QWEN_READ_ONLY_TYPES.join(','), QWEN_CODE_SYSTEM_SETTINGS_PATH: remote.settingsFile },
        hooks: { ...offHooks(''), adopted: true, readOnly: qwenSub.QWEN_READ_ONLY_TYPES, prompt: qwenSub.QWEN_SUBAGENT_PROMPT },
      };
    } catch (error) {
      log.exception(error, 'Could not set up Qwen subagent hooks in the distro');
      return unavailable(`the distro could not be asked (${errorText(error)})`);
    }
  },
};

export type QwenSetupMethods = typeof qwenSetupMethods;
