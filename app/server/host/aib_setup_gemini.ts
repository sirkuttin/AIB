/**
 * Aib methods: Gemini chat setup (subagent policy and folders).
 * Moved out of aib.ts (no change).
 */
import { errorText } from '../acp/connection.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { FORWARD_FILE } from '../artifacts/mcp_http.ts';
import { hookForwarderOf } from '../keeper/client.ts';
import * as qwenSub from '../subagents/qwen.ts';
import * as gemini from '../subagents/gemini.ts';
import * as copilotMcp from '../agents/copilot_mcp.ts';
import { pyStrip } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { testHomeEnv } from '../acp/connection.ts';
import { log } from './aib_util.ts';
import type { Aib } from './aib.ts';

export const geminiSetupMethods = {
  $sweepGeminiWithoutKeeper(this: Aib, root: string): void {
    if (!this.keeper && this.hasStateDir) qwenSub.sweepSettings(this.stateDir, new Set(this.connections.keys())); // no keeper: no Qwen chat still runs
    if (!this.keeper && this.hasStateDir) copilotMcp.sweepConfigs(this.stateDir, new Set(this.connections.keys())); // nor a Copilot chat
    if (!this.keeper && this.hasStateDir) gemini.sweep(this.stateDir, root, new Set(this.connections.keys()));
  },

  /** The open Gemini chat with the redirect on (its folder and subagent folder), or null. */
  $geminiChat(this: Aib, id: string): { folder: string; subFolder: string } | null {
    const c = this.connections.get(id);
    return c && !c.closed && c.provider === 'gemini' && c.geminiSubagents?.subFolder ? { folder: c.cwd, subFolder: c.geminiSubagents.subFolder } : null;
  },

  /**
   * A new Gemini chat's subagent rule (subagents/gemini.ts): always the fence (`--admin-policy`); with an API-key sign-in in a git
   * project, also the redirect (its own GEMINI_CLI_HOME with AIB's BeforeTool hook, the subagent folder in --include-directories),
   * with a fixed chat id (its hook key is bound to it). Null under test unless a real agent was allowed, or with no state folder.
   */
  async $geminiSubagents(
    this: Aib,
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wsl: boolean,
    chatId: string | null = null, // a reopened chat keeps its id
  ): Promise<{ id: string; args: string[]; env: Record<string, string>; setup: gemini.GeminiSetup } | null> {
    if (!this.subagents || !this.hasStateDir || !this.worktrees) return null;
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && !realAllowed) return null;
    const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
    let gitProject: '' | 'not a git project' | 'the repository has no commits yet' = '';
    if (!aibWorktree && !wsl) {
      const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
      if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) gitProject = 'not a git project';
      else if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
        gitProject = 'the repository has no commits yet';
      }
    }
    const agentEnv = { ...Deno.env.toObject(), ...testHomeEnv(['gemini']), ...env };
    const forwarder = wsl || gitProject ? null : await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
    const dir = join(this.stateDir, 'gemini', id);
    try {
      if (forwarder) this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const made = gemini.setUp({
        stateDir: this.stateDir,
        root: this.worktrees.registry.root,
        chatId: id,
        project,
        folder,
        env: agentEnv,
        gitProject,
        forwarder,
        addressFile: join(this.stateDir, FORWARD_FILE),
        hookKey: forwarder ? artifactKeys.issueHookKey(id) : null,
        wsl,
      });
      return { id, ...made };
    } catch (error) {
      log.exception(error, 'Could not set up the Gemini subagent rule; the chat runs with the fence only');
      const policyDir = join(dir, 'policy');
      try { // the fence alone: every subagent edit denied
        Deno.mkdirSync(policyDir, { recursive: true });
        Deno.writeTextFileSync(join(policyDir, 'aib-subagents.toml'), gemini.policyToml(gemini.BUILTIN_AGENTS, null));
      } catch { /* the chat still opens; logged above */ }
      const setup = { policyDir, home: '', subFolder: '', off: `AIB could not set it up (${errorText(error)})`, dir };
      return { id, args: ['--admin-policy', policyDir], env: {}, setup };
    }
  },
};

export type GeminiSetupMethods = typeof geminiSetupMethods;
