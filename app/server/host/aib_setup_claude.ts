/**
 * Aib methods: Claude chat setup (subagent hooks, WSL hooks) and the Claude hook route call.
 * Moved out of aib.ts (no change).
 */
import { Connection, errorText } from '../acp/connection.ts';
import { isClaudeFamily } from '../agents/claude_family.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { FORWARD_FILE } from '../artifacts/mcp_http.ts';
import { hookForwarderOf, hookForwarderTagsShells, keyForForwarder } from '../keeper/client.ts';
import { deny as denyHook, type HookAnswer } from '../subagents/service.ts';
import { claudeConfigDir, gitBashPath, hookSettings, readClaudeSetup, subagentsOffSettings } from '../subagents/claude_config.ts';
import { pyStrip } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { isFixture, testHomeEnv } from '../acp/connection.ts';
import { wslHost, wslLoc } from '../wsl/access.ts';
import { log } from './aib_util.ts';
import {
  HOOKS_OFF,
  NO_GIT_BASH,
  MAX_PRE_TOOL_WAITING,
  WSL_HOOKS_UNAVAILABLE,
  WSL_SUBAGENTS_OFF,
  WSL_SUBAGENTS_OFF_PROMPT,
  SUBAGENT_BUSY,
  offHooks,
} from './aib_helpers.ts';
import type { Aib } from './aib.ts';
import type { ConnectHook } from './aib_connect_hooks.ts';

export const claudeSetupMethods = {
  /**
   * The hooks a new Claude chat gets (subagent worktrees, design v2 2.1): command hooks running the keeper's forwarder, which reads
   * AIB's address file and sends the chat's hook key. `folder`: where the agent works (a helper's worktree is made later, so it
   * counts as a git project); `project`: whose .claude settings and agents apply. Off, with the reason, when it can't hold.
   */
  async $subagentHooks(
    this: Aib,
    command: string[],
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wslDistro: string | null = null,
    chatId: string | null = null, // a reopened chat keeps its id (its hook key is bound to it)
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']> } | null> {
    if (!this.subagents || !this.hasStateDir) return { hooks: offHooks('AIB has no state folder') };
    // under test only a real agent the run allowed gets hooks (a fixture or a test's own factory runs none, and must not pay for them)
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && (isFixture(command) || !realAllowed)) return null;
    if (wslDistro) return await this.$wslClaudeHooks(wslDistro, folder, project, aibWorktree, env, chatId);
    try {
      if (!aibWorktree) {
        const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
        if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) return { hooks: offHooks('not a git project') };
        if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
          return { hooks: offHooks('the repository has no commits yet') };
        }
      }
      const agentEnv = { ...Deno.env.toObject(), ...testHomeEnv(command), ...env };
      // Claude Code runs command hooks with Git Bash; under another shell AIB's hook command fails open (security review P1, MF 7).
      // Without it: no hooks, and the chat's editing subagents are turned off by the same per-session deny rules as hooks off (P2).
      if (!gitBashPath(agentEnv)) {
        const readOnly = readClaudeSetup(project, agentEnv).readOnly;
        const configDir = claudeConfigDir(agentEnv);
        return { hooks: { ...offHooks(NO_GIT_BASH), readOnly, configDir, deny: subagentsOffSettings(project, agentEnv, readOnly) } };
      }
      const forwarder = await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
      if (!forwarder) return { hooks: offHooks("AIB's keeper program can't run hooks") };
      const configDir = claudeConfigDir(agentEnv);
      const setup = readClaudeSetup(project, agentEnv);
      if (setup.hooksOff) { // owner rule: its editing subagents are turned off instead (per-session permission deny, not hooks)
        return { hooks: { ...offHooks(HOOKS_OFF, setup.hooksOff), configDir, deny: subagentsOffSettings(project, agentEnv, setup.readOnly) } };
      }
      const shellTag = hookForwarderTagsShells(forwarder); // hook 2: a subagent's shell calls get AIB's cookie prefix (subagents/shell_tag.ts)
      const settings = hookSettings(forwarder, join(this.stateDir, FORWARD_FILE), { worktreeCreate: !setup.userWorktreeHook, shellTag });
      if (!settings) return { hooks: offHooks("AIB's folder can't be named in a hook command") };
      this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
      const key = artifactKeys.issueHookKey(id);
      if (!key) return { hooks: offHooks('AIB has no key secret') };
      return {
        id,
        env: { AIB_HOOK_KEY: keyForForwarder(forwarder, 'hook-key', key), AIB_HOOK_CHAT: id, AIB_HOOK_READONLY: setup.readOnly.join(',') },
        hooks: { settings, readOnly: setup.readOnly, userWorktreeHook: setup.userWorktreeHook, off: '', configDir, ...(shellTag ? { shellTag } : {}) },
      };
    } catch (error) {
      log.exception(error, 'Could not set up subagent hooks; the chat runs without them');
      return { hooks: offHooks(`AIB could not set up its hooks (${errorText(error)})`) };
    }
  },

  /**
   * The hooks a new Claude chat in a WSL project gets (owner 2026-11-23): the same command hooks, run in the distro by the Linux keeper
   * program (`<keeper> hook <event> --helper-socket <socket>`), reaching this AIB through the helper's tunnel (#wslHookCall). What
   * AIB can't read from Windows (the distro's Claude settings, agents, git) the distro's helper reads (`subagent.setup`). Fails closed:
   * when the hooks can't be set up (a helper without them, a setup call that fails), the chat's subagents are turned off by permission
   * rules instead, never left to edit the project folder; hooks off in the user's own settings do the same, as on Windows.
   */
  async $wslClaudeHooks(
    this: Aib,
    distro: string,
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    chatId: string | null,
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']> }> {
    const unavailable = (detail: string) => ({
      hooks: { ...offHooks(WSL_HOOKS_UNAVAILABLE, detail), deny: WSL_SUBAGENTS_OFF, prompt: WSL_SUBAGENTS_OFF_PROMPT },
    });
    try {
      const host = wslHost(distro);
      const tunnel = host?.hookTunnel ?? null;
      if (!host || !tunnel) return unavailable("this distro's AIB helper can't give subagents their own worktree yet");
      const where = wslLoc(folder), home = wslLoc(project);
      if (!where || !home) return { hooks: offHooks('not a git project') };
      const setup = await host.call('subagent.setup', {
        agent: 'claude',
        project: home.linuxPath,
        folder: where.linuxPath,
        aibWorktree,
        env: env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {},
      }, { timeoutMs: 60_000 });
      if (setup.git) return { hooks: offHooks(setup.git) };
      if (setup.hooksOff) {
        return { hooks: { ...offHooks(HOOKS_OFF, setup.hooksOff), configDir: setup.configDir, deny: setup.deny ?? WSL_SUBAGENTS_OFF } };
      }
      // hook 2: a subagent's shell calls get AIB's cookie, and the distro's helper shuts down what they left (a helper of this build)
      const shellTag = host.hookShellTag === true;
      const settings = hookSettings(tunnel.forwarder, tunnel.socket, { worktreeCreate: !setup.userWorktreeHook, viaSocket: true, shellTag });
      if (!settings) return unavailable("the keeper's folder in the distro can't be named in a hook command");
      const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
      const key = artifactKeys.issueHookKey(id);
      if (!key) return unavailable('AIB has no key secret');
      return {
        id,
        env: { AIB_HOOK_KEY: key, AIB_HOOK_CHAT: id, AIB_HOOK_READONLY: setup.readOnly.join(',') }, // a Linux process: nothing is sealed or crosses interop
        hooks: { settings, readOnly: setup.readOnly, userWorktreeHook: setup.userWorktreeHook, off: '', configDir: setup.configDir, ...(shellTag ? { shellTag } : {}) },
      };
    } catch (error) {
      log.exception(error, 'Could not set up subagent hooks in the distro; the chat\'s subagents are off');
      return unavailable(`the distro could not be asked (${errorText(error)})`);
    }
  },

  /** One key-checked hook call. More than MAX_PRE_TOOL_WAITING pre-tool calls of one chat at once: the next is denied at once. */
  async $hookCall(this: Aib, event: string, conversation: string, body: unknown): Promise<HookAnswer> {
    if (!this.subagents) return { status: 503, body: 'No state folder', type: 'text/plain' };
    if (event.startsWith('codex-')) return await this.$codexHookCall(event, conversation, body);
    if (event.startsWith('qwen-')) return await this.$qwenHookCall(event, conversation, body);
    if (event.startsWith('agy-')) return await this.$agyHookCall(event, conversation, body);
    if (event === 'gemini-before-tool') { // a Gemini chat's only (GeminiSubagents answers 503 for any other chat)
      if (this.connections.get(conversation)?.provider !== 'gemini' || !this.geminiSubagents) {
        return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
      }
      return await this.geminiSubagents.beforeTool(conversation, body);
    }
    // each route answers its own agent's chats only (a Codex chat's key can't drive the Claude routes)
    if (!isClaudeFamily(this.connections.get(conversation)?.provider)) return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
    if (event !== 'pre-tool') return await this.subagents.hook(event, conversation, body);
    const waiting = this.$preToolWaiting.get(conversation) ?? 0;
    if (waiting >= MAX_PRE_TOOL_WAITING) return denyHook(SUBAGENT_BUSY);
    this.$preToolWaiting.set(conversation, waiting + 1);
    try {
      return await this.subagents.hook(event, conversation, body);
    } finally {
      const left = (this.$preToolWaiting.get(conversation) ?? 1) - 1;
      if (left > 0) this.$preToolWaiting.set(conversation, left);
      else this.$preToolWaiting.delete(conversation);
    }
  },
};

export type ClaudeSetupMethods = typeof claudeSetupMethods;

/** Claude's rules in Aib.connect (aib_connect_hooks.ts). */
export const claudeConnectHook: ConnectHook = {
  // Subagent worktrees (subagents/): a Claude chat in a git project gets command hooks through the keeper's forwarder; its key and
  // id go in the agent's environment (never in settings, a command line or a URL). A WSL chat's run in its distro ($wslClaudeHooks).
  prepare(this: Aib, x) {
    return this.$subagentHooks(x.command, x.cwd, x.workspace, x.worktree, x.env, x.distro, x.chatId);
  },
  // design 2.6: said up front, before a subagent edits the folder (P0 A7)
  offNote(_x, c) {
    if (c.subagentHooks?.off === HOOKS_OFF) {
      return `Subagents that edit files are off in this chat: hooks are off in your Claude Code settings ` +
        `(${c.subagentHooks.detail}), so AIB can't give them their own worktree. Read-only subagents (Explore, Plan) still work.`;
    }
    // WSL: said up front, never unisolated
    if (c.subagentHooks?.off === WSL_HOOKS_UNAVAILABLE) {
      return `Subagents are off in this chat: AIB could not set up their own worktree in this WSL distro (${c.subagentHooks.detail}).`;
    }
    return null;
  },
};
