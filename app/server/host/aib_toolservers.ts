/**
 * Aib methods: per-project tool servers (toolservers/*). connect() asks `$toolServersStep` once, right after the agent's own prepare:
 * it reads the project's choice and turns it into what this agent's launch needs (apply.ts), written only into AIB's own files, the
 * launch command, the agent's environment and the session's settings, never into the user's agent config. The chat remembers what it
 * was launched with (served-tools.json), so a later change makes it stale and an idle chat restarts itself (host/aib.ts staleWhy).
 */
import type { Connection } from '../acp/connection.ts';
import { baseAgent } from '../agents/claude_family.ts';
import { pathOf } from '../state/paths.ts';
import { join } from '../platform/ospath.ts';
import {
  type ClaudePatch,
  claudePatch,
  codexEntries,
  copilotArgs,
  geminiArgs,
  geminiPolicyToml,
  mergeQwenSettings,
  qwenFragment,
} from '../toolservers/apply.ts';
import type { Effective } from '../toolservers/store.ts';
import { agentProcesses, attribute } from '../toolservers/measure.ts';
import * as qwenSub from '../subagents/qwen.ts';
import { isDict, ValueError } from '../core/py.ts';
import { wslLoc } from '../wsl/access.ts';
import { wslWriteToolServers } from '../wsl/toolservers.ts';
import { log } from './aib_util.ts';
import type { Aib } from './aib.ts';
import type { ConnectCtx, ConnectPrepared } from './aib_connect_hooks.ts';

type Json = Record<string, unknown>;

/** What a launch got from the step; connect() puts it on the connection and the launch. */
export interface ToolServersLaunch {
  hash: string;
  effective: Effective;
  claude: ClaudePatch | null;
  codex: Record<string, Json> | null;
  /** Copilot: flags added where its MCP config flag goes ($copilotTools). */
  copilot: string[];
  /** Added to the launch command (Gemini). */
  args: string[];
  /** Added to the agent's environment (Qwen's settings file). */
  env: Record<string, string>;
  /** What could not be applied to this chat, and why (WSL files the helper can't write yet). */
  skipped: string[];
}

export const toolServersMethods = {
  /**
   * POST /api/live/tool-servers {op: 'view' | 'set', path, chats?, ...}. `path`: a project folder or '_new' (New projects). `view` answers the
   * page's section (toolservers/service.ts View); `set` changes ONE thing ({server, on} | {server, tool, toolOn} | {server, allTools: {on}}),
   * saves it in AIB's own state and answers the new view. A change reaches new chats at once; open chats restart when idle (staleScan).
   */
  async $toolServersCall(this: Aib, body: Json): Promise<unknown> {
    const ts = this.toolServers;
    if (!ts) throw new ValueError("Tool servers need AIB's state folder");
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path) throw new ValueError('Choose a project');
    const chats = Array.isArray(body.chats) ? body.chats.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
    if (body.op === 'set') {
      const server = typeof body.server === 'string' ? body.server : '';
      if (!server || server === 'studio_artifact') throw new ValueError("AIB's own tools are always on");
      const key = ts.keyOf(path);
      if (!key) throw new ValueError('Choose a project');
      try {
        if (typeof body.on === 'boolean') ts.store.update(key, { server, on: body.on });
        else if (typeof body.tool === 'string' && typeof body.toolOn === 'boolean') {
          ts.store.update(key, { server, tool: body.tool, toolOn: body.toolOn });
        } else if (isDict(body.allTools) && typeof body.allTools.on === 'boolean') {
          const names = (await ts.view(path)).servers.find((s) => s.id === server)?.tools.map((t) => t.name) ?? [];
          ts.store.update(key, { server, allTools: { on: body.allTools.on, names } });
        } else throw new ValueError('Nothing to change');
      } catch (error) {
        throw error instanceof ValueError ? error : new ValueError(error instanceof Error ? error.message : String(error));
      }
      ts.forget();
      // idle chats of the project pick it up now rather than at the next 30 s look
      setTimeout(() => void this.staleScan().catch((error) => log.exception(error, 'Stale chat scan failed')), 500).unref?.();
    } else if (body.op !== 'view') throw new ValueError('Unknown tool servers request');
    return await ts.view(path, chats);
  },

  /** The tool server launch of a new or reopened chat, or null (an agent that takes none, no state folder, nothing known). Never throws. */
  async $toolServersStep(this: Aib, x: ConnectCtx, prepared: ConnectPrepared | null): Promise<ToolServersLaunch | null> {
    const ts = this.toolServers;
    const agent = baseAgent(x.provider);
    if (!ts || !['claude', 'codex', 'gemini', 'qwen', 'copilot'].includes(agent)) return null;
    try {
      const l = await ts.launch(x.workspace);
      const e = l.effective;
      const out: ToolServersLaunch = { hash: l.hash, effective: e, claude: null, codex: null, copilot: [], args: [], env: {}, skipped: [] };
      if (!e.off.length && !Object.keys(e.tools).length) return out;
      if (agent === 'claude') out.claude = claudePatch(e);
      else if (agent === 'codex') out.codex = codexEntries(e);
      else if (agent === 'copilot') out.copilot = copilotArgs(e);
      else if (agent === 'gemini') {
        out.args = geminiArgs(e, l.found, ['studio_artifact']);
        const toml = geminiPolicyToml(e);
        if (toml) {
          if (x.wsl) {
            // the helper writes the rules in AIB's own folder in the distro; a second --admin-policy (the subagent fence's is its own)
            const dir = x.distro ? await wslWriteToolServers(x.distro, { agent: 'gemini', hash: l.hash, toml }) : null;
            if (dir) out.args.push('--admin-policy', dir);
            else out.skipped.push("single tools (this distro's AIB helper can't write Gemini's policy file yet)");
          } else {
            const have = prepared?.gemini?.policyDir;
            const dir = have || pathOf(this.stateDir, 'toolservers', `gemini-${l.hash}`);
            Deno.mkdirSync(dir, { recursive: true });
            Deno.writeTextFileSync(join(dir, 'aib-toolservers.toml'), toml);
            if (!have) out.args.push('--admin-policy', dir);
          }
        }
      } else if (agent === 'qwen') {
        const fragment = qwenFragment(e, l.found);
        if (fragment && x.wsl) {
          // the helper merges the fragment into the chat's own settings file (or the distro's system settings) and writes a file in AIB's folder
          const env: Record<string, string> = {};
          for (const n of ['QWEN_HOME', 'QWEN_CODE_SYSTEM_SETTINGS_PATH']) {
            const v = x.spawnEnv?.[n] ?? x.env[n];
            if (v) env[n] = v;
          }
          const own = prepared?.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH;
          const file = x.distro
            ? await wslWriteToolServers(x.distro, {
              agent: 'qwen',
              hash: l.hash,
              fragment,
              project: wslLoc(x.workspace)?.linuxPath,
              env,
              ...(own ? { base: own } : {}),
            })
            : null;
          if (file) out.env.QWEN_CODE_SYSTEM_SETTINGS_PATH = file;
          else out.skipped.push("servers and tools (this distro's AIB helper can't write Qwen's settings file yet)");
        } else if (fragment) {
          const own = prepared?.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH;
          const file = own || pathOf(this.stateDir, 'toolservers', `qwen-${l.hash}.json`);
          let base: Json = {};
          try {
            const text = own ? Deno.readTextFileSync(own) : '';
            const parsed = text ? JSON.parse(text) : qwenSub.readQwenSetup(x.workspace, { ...Deno.env.toObject(), ...x.env }).system;
            if (isDict(parsed)) base = parsed as Json;
          } catch { /* a settings file that can't be read: AIB's fragment alone */ }
          Deno.mkdirSync(join(file, '..'), { recursive: true });
          Deno.writeTextFileSync(file, JSON.stringify(mergeQwenSettings(base, fragment), null, 2) + '\n');
          out.env.QWEN_CODE_SYSTEM_SETTINGS_PATH = file;
        }
      }
      return out;
    } catch (error) {
      log.warning(
        'Tool servers: could not prepare the launch of a %s chat: %s',
        agent,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  },

  /** The connection exists: it carries the list it was launched with, remembers it, and tells the store which tools it sees. */
  $toolServersAttach(this: Aib, c: Connection, t: ToolServersLaunch | null): void {
    if (!t || !this.toolServers) return;
    c.toolServers = t.claude || t.codex || t.copilot.length ? { claude: t.claude, codex: t.codex, copilot: t.copilot } : null;
    const store = this.toolServers.store;
    c.onToolSeen = (server, tool) => store.sawTools(server, [tool]);
    this.served?.toolServers(c.id, t.hash, t.effective.off, t.effective.tools);
  },

  /**
   * A while after a chat opened, what its servers really cost: the processes of each server below the agent and their working set,
   * kept per server in the store (the Settings page says "measured" for those). Windows and Linux chats started here; never throws.
   */
  $toolServersMeasure(this: Aib, c: Connection): void {
    const ts = this.toolServers;
    if (!ts || c.wsl) return;
    const timer = setTimeout(async () => {
      try {
        if (c.closed) return;
        const l = await ts.launch(c.projectRoot || c.cwd);
        const on = l.found.filter((s) => s.kind === 'local' && !l.effective.off.includes(s.id));
        const pid = c.process?.pid;
        if (!pid || !on.length) return;
        const procs = agentProcesses(pid);
        if (!procs) return;
        const entries = on.map((s) => ({
          id: s.id,
          entry: (s.entries[agentOfProvider(c.provider)] ?? Object.values(s.entries)[0] ?? {}) as Json,
        }));
        for (const [id, m] of Object.entries(attribute(procs, entries))) ts.store.measured(id, m.procs, m.mb);
      } catch (error) {
        log.warning('Tool servers: measuring a chat failed: %s', error instanceof Error ? error.message : String(error));
      }
    }, 25_000);
    (timer as unknown as { unref?: () => void }).unref?.();
  },
};

function agentOfProvider(provider: string): 'claude' | 'codex' | 'gemini' | 'qwen' | 'copilot' | 'antigravity' {
  const base = baseAgent(provider);
  return (['claude', 'codex', 'gemini', 'qwen', 'copilot', 'antigravity'].includes(base) ? base : 'claude') as 'claude';
}

export type ToolServersMethods = typeof toolServersMethods;
