/**
 * Aib methods: Copilot's AIB tools and the subagent setup of agents that have native subagents off.
 * Moved out of aib.ts (no change).
 */
import { Connection, errorText } from '../acp/connection.ts';
import * as nativeOff from '../subagents/native_off.ts';
import * as copilotMcp from '../agents/copilot_mcp.ts';
import { isFixture } from '../acp/connection.ts';
import { readyHost } from '../wsl/access.ts';
import { log } from './aib_util.ts';
import { offHooks } from './aib_helpers.ts';
import type { Aib } from './aib.ts';

export const copilotSetupMethods = {
  /**
   * Copilot's tools (agents/copilot_mcp.ts): Copilot ignores the MCP servers of ACP, so the chat's servers go in a config file of AIB's
   * own (<state>/copilot/<chat>/mcp.json; a WSL chat's: in its distro, written by the helper) that Copilot is started with
   * (`--additional-mcp-config @<file>`). Returns a chat line when the chat has no AIB tools after all, else ''. Never throws.
   * Under test a fixture (not a real Copilot) is left as it is.
   */
  async $copilotTools(this: Aib, c: Connection, launched: string[], distro: string | null): Promise<string> {
    if (!this.hasStateDir || (Deno.env.get('AGENT_STUDIO_TEST') === '1' && isFixture(launched))) return '';
    const text = copilotMcp.copilotMcpConfig(c.mcpServers);
    if (!text) return '';
    const missing = "AIB's own tools (artifacts, docs, helper agents) are not available in this Copilot chat: AIB could not give Copilot its tool list.";
    try {
      const file = distro
        ? (await readyHost(distro).call('mcpconfig.write', { id: c.id, json: text })).path
        : copilotMcp.writeConfigFile(copilotMcp.configFileOf(this.stateDir, c.id), text);
      const next = copilotMcp.copilotMcpCommand(c.command, file);
      if (!next) return ''; // not a command with --acp (not the Copilot program AIB knows): left as it is
      c.useCommand(next);
      return '';
    } catch (error) {
      log.warning('Copilot MCP config for chat %s could not be written: %s', c.id, errorText(error));
      return missing;
    }
  },

  /**
   * Maki and Copilot (subagents/native_off.ts): neither can give a subagent its own worktree, so their subagents are turned off with a
   * launch flag (no file is written, no sign-in moves) and the chat says so; a launch command the flag can't be placed in is only asked
   * for. The same for a WSL chat: the flag is part of the command the distro's keeper starts. Null: under test, a fixture or a run that
   * allows no real agent (left as it is).
   */
  $nativeOffSubagents(
    this: Aib,
    provider: string,
    command: string[],
    chatId: string | null,
  ): { id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; command: string[]; note: string } | null {
    const agent = nativeOff.nativeOffAgent(provider);
    if (!agent) return null;
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && (isFixture(command) || !realAllowed)) return null;
    const r = nativeOff.nativeOffRecord(agent, command);
    return { ...(chatId ? { id: chatId } : {}), hooks: { ...offHooks(r.off, r.detail), prompt: r.prompt }, command: r.command, note: r.note };
  },
};

export type CopilotSetupMethods = typeof copilotSetupMethods;
