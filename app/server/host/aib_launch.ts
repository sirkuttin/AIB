/**
 * Aib methods: the command and environment an agent starts with (model servers, beta agents).
 * Moved out of aib.ts (no change).
 */
import * as agentRegistry from '../agents/agent_registry.ts';
import * as adapters from '../agents/adapters.ts';
import { betaAgent, isBeta } from '../agents/beta_catalog.ts';
import { baseAgent, isModelServerId, serverIdOf } from '../agents/claude_family.ts';
import {
  betaServerEnv,
  CODEX_KEY_ENV,
  QWEN_AUTH_ARGS,
  codexConfigToml,
  codexWireApi,
  DUMMY_KEY,
  modelServerEnv,
  notAnsweringLine,
  type ModelServer,
} from '../agents/model_servers.ts';
import { resolveBeta, withKeyHome } from '../agents/beta_agents.ts';
import { GEMINI_TRUST_ENV, GEMINI_TRUST_FILE } from '../agents/gemini_trust.ts';
import { registerSecret } from '../core/log.ts';
import { ValueError } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import { builtinLaunch } from '../web/shared.ts';
import type { Aib } from './aib.ts';

export const launchMethods = {
  /**
   * [argv, extra environment] that starts this agent. Never a shell string. fresh=true is a brand-new chat: an agent turned off in
   * Settings is refused there, but its saved chats can still be reopened.
   */
  async agentLaunch(this: Aib, provider: string, fresh = false): Promise<[string[], Record<string, string>]> {
    if (agentRegistry.isRetired(provider)) throw new ValueError(agentRegistry.RETIRED_NOTE); // read-only history: no adapter ever starts
    if ((agentRegistry.BUILTIN_IDS as readonly string[]).includes(provider)) {
      if (fresh && !this.settings.builtinEnabled(provider)) {
        throw new ValueError(`${agentRegistry.BUILTIN_NAMES[provider]} is turned off in Settings`);
      }
      const row = await builtinLaunch(this.$agentOptions(), this.settings, provider);
      if (!row.found) throw new ValueError(`${agentRegistry.BUILTIN_NAMES[provider]} is not available: ${row.problem}`);
      return [row.argv, provider === 'claude' ? adapters.claudeEnv(Deno.env.toObject()) : {}];
    }
    if (isModelServerId(provider)) return await this.$modelServerLaunch(provider);
    if (isBeta(provider)) return await this.$betaLaunch(provider, fresh);
    const agent = agentRegistry.isCustom(provider) ? this.settings.customAgent(provider) : null;
    if (agent === null) throw new ValueError('That agent is not in Settings (it may have been removed)');
    if (fresh && !agent.enabled) throw new ValueError(`${agent.name} is turned off in Settings`);
    for (const e of agent.env) registerSecret(e.value); // custom agent env values (often API keys) never reach a log line
    return [[agentRegistry.checkCommand(agent.command), ...agent.args], Object.fromEntries(agent.env.map((e) => [e.name, e.value]))];
  },

  /** The model server behind an `<agent>@<slug>` entry, or a ValueError (it may have been removed in Settings). */
  $modelServerOf(this: Aib, provider: string) {
    const server = this.settings.modelServer(serverIdOf(provider) ?? '');
    if (!server) throw new ValueError('That model server is not in Settings (it may have been removed)');
    return server;
  },

  /**
   * The environment an `<agent>@<slug>` entry gets on top of its base agent's (the same on Windows and in a distro): the server's
   * address, key (or a dummy) and model in the variables that agent reads. Codex: the key in CODEX_KEY_ENV (its config.toml names it);
   * its CODEX_HOME is added by the launch (a folder AIB owns, different on Windows and in a distro).
   */
  modelServerEnv(this: Aib, provider: string): Record<string, string> {
    const server = this.$modelServerOf(provider);
    const key = this.settings.betaKey(server.id); // stored under the server's id
    if (key) registerSecret(key); // never in a log line
    const base = baseAgent(provider);
    if (base === 'claude') return modelServerEnv(server, key);
    if (base === 'codex') return { [CODEX_KEY_ENV]: key || DUMMY_KEY };
    return betaServerEnv(base, server, key);
  },

  /** Codex's wire API for this server, from the API kinds the server answered to (the kept health answer; asked when there is none). */
  async $codexWire(this: Aib, server: ModelServer, key: string): Promise<'responses' | 'chat'> {
    const inspection = await this.modelServerInspect(server, key).catch(() => null);
    return codexWireApi(inspection ? inspection.kinds.filter((k) => k.speaks).map((k) => k.kind) : []);
  },

  /** Writes a Codex entry's own CODEX_HOME (<data folder>/codex-home/<server id>/config.toml) and returns the folder. */
  async $codexHomeFor(this: Aib, server: ModelServer, key: string): Promise<string> {
    const dir = join(this.stateDir, 'codex-home', server.id);
    const toml = codexConfigToml(server, await this.$codexWire(server, key));
    Deno.mkdirSync(dir, { recursive: true });
    const file = join(dir, 'config.toml');
    let same = false;
    try {
      same = Deno.readTextFileSync(file) === toml;
    } catch { /* not written yet */ }
    if (!same) Deno.writeTextFileSync(file, toml);
    return dir;
  },

  /**
   * An `<agent>@<slug>` entry starts the SAME adapter as its base agent (Claude Code, Codex, Maki, Qwen Code) with its server's
   * environment. The server is asked once first (GET /v1/models, a few seconds at most): a server that is down gives one plain line
   * naming the address instead of a chat that waits. The base agent's own entry is never changed by a server.
   */
  async $modelServerLaunch(this: Aib, provider: string): Promise<[string[], Record<string, string>]> {
    const server = this.$modelServerOf(provider);
    const base = baseAgent(provider);
    const builtin = (agentRegistry.BUILTIN_IDS as readonly string[]).includes(base);
    const label = builtin ? agentRegistry.BUILTIN_NAMES[base] : betaAgent(base)?.name ?? base;
    const row = builtin ? await builtinLaunch(this.$agentOptions(), this.settings, base) : await this.$betaRow(base);
    if (!row.found) throw new ValueError(`${label} is not available: ${row.problem}`);
    const env = this.modelServerEnv(provider);
    const key = this.settings.betaKey(server.id);
    const result = await this.modelServerCheck(server.url, key);
    if (!result.reachable) throw new ValueError(result.error);
    if (result.models.length) this.$serverModels.set(server.id, result.models);
    if (base === 'codex') {
      if (!this.hasStateDir) throw new ValueError('Codex on a model server needs AIB\'s data folder');
      env.CODEX_HOME = await this.$codexHomeFor(server, key);
    }
    // Qwen Code reads OPENAI_* only when its auth type is openai: a stale selectedType in the owner's ~/.qwen/settings.json (the ended
    // qwen-oauth) would answer "Authentication required" (tested 0.27.2). The flag wins over settings and touches no file.
    const argv = base === 'qwen' ? [...row.argv, ...QWEN_AUTH_ARGS] : row.argv;
    if (base === 'qwen') env.QWEN_CODE_LEGACY_MCP_BLOCKING = '1'; // as in betaEnv: without it AIB's MCP tools never reach the model
    return [argv, { ...(base === 'claude' ? adapters.claudeEnv(Deno.env.toObject()) : {}), ...env }];
  },

  /**
   * Swarm: '' when the server behind an `<agent>@<server id>` entry answers (the kept 30 s health answer, never a new probe per
   * helper), else the plain line "strata is not answering at 127.0.0.1:8080".
   */
  async modelServerDown(this: Aib, provider: string): Promise<string> {
    const server = this.settings.modelServer(serverIdOf(provider) ?? '');
    if (!server) return '';
    const check = await this.modelServerInspect(server, this.settings.betaKey(server.id)).catch(() => null);
    return check && check.reachable ? '' : notAnsweringLine(server.name, server.url);
  },

  /** What a model-server chat's model picker offers: the server's list (the configured model first, kept even if unlisted). */
  $serverModelsFor(this: Aib, server: { id: string; model: string }): { models: string[]; model: string } {
    const listed = this.$serverModels.get(server.id) ?? [];
    const models = [...new Set([...(server.model ? [server.model] : []), ...listed])];
    return { models, model: server.model || models[0] || '' };
  },

  /** A Beta agent (beta_catalog.ts): refused for a new chat while it is off; its API key, when one is stored, goes in its environment. */
  async $betaLaunch(this: Aib, provider: string, fresh: boolean): Promise<[string[], Record<string, string>]> {
    const agent = betaAgent(provider)!;
    if (fresh && !this.settings.betaEnabled(provider)) throw new ValueError(`${agent.name} is turned off in Settings`);
    const row = await this.$betaRow(provider);
    if (!row.found) throw new ValueError(`${agent.name} is not available: ${row.problem}`);
    return [row.argv, this.betaEnv(provider)];
  },

  /** How a Beta agent starts on this PC: with its own keyHome folder flag when an API key is saved (Antigravity's --gemini-dir). */
  async $betaRow(this: Aib, provider: string) {
    const stateDir = this.hasStateDir ? this.stateDir : null;
    const row = await resolveBeta(provider, { stateDir, nodeCommand: this.options.nodeCommand || '' });
    const hasKey = !!betaAgent(provider)?.signin.keyEnv && !!this.settings.betaKey(provider);
    return withKeyHome(row, provider, stateDir, hasKey);
  },

  /**
   * The environment a Beta agent gets on top of AIB's: its stored API key under the agent's variable (registered as a secret), and
   * its stored API address (Qwen: OPENAI_BASE_URL) when one is set.
   */
  betaEnv(this: Aib, provider: string): Record<string, string> {
    const agent = betaAgent(provider);
    const out: Record<string, string> = {};
    // A Beta agent's own entry uses its own settings only (its card key and, from before addresses moved to Model servers, its saved
    // address). A model server never changes it: a server switched on for the agent is its own separate entry (maki@strata).
    const key = agent?.signin.keyEnv ? this.settings.betaKey(provider) : '';
    if (agent?.signin.keyEnv && key) {
      registerSecret(key); // never in a log line
      out[agent.signin.keyEnv] = key;
    }
    const url = agent?.signin.baseUrlEnv ? this.settings.betaUrl(provider) : '';
    if (agent?.signin.baseUrlEnv && url) out[agent.signin.baseUrlEnv] = url;
    // Qwen starts MCP discovery in the background and builds the model's tool list before it ends, so AIB's tools never reach the
    // model. This switch makes it wait (0.15 facts, Qwen Code 0.27.2: the tools are then named in its request).
    if (baseAgent(provider) === 'qwen') out.QWEN_CODE_LEGACY_MCP_BLOCKING = '1';
    // Gemini starts no MCP server in a folder it does not trust: it gets AIB's own trust file (agents/gemini_trust.ts). A WSL chat's
    // is the distro's (wslLaunch sets it again).
    if (baseAgent(provider) === 'gemini' && this.hasStateDir) out[GEMINI_TRUST_ENV] = join(this.stateDir, GEMINI_TRUST_FILE);
    return out;
  },

  $agentOptions(this: Aib) {
    return { ...this.options, stateDir: this.hasStateDir ? this.stateDir : null };
  },

  async agentCommand(this: Aib, provider: string): Promise<string[]> {
    return (await this.agentLaunch(provider))[0];
  },
};

export type LaunchMethods = typeof launchMethods;
