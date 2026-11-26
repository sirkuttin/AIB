/**
 * Aib methods: the artifact tool server addresses, MCP servers per chat, and launching and calling into WSL.
 * Moved out of aib.ts (no change).
 */
import { Connection, errorText } from '../acp/connection.ts';
import type { McpServer } from '../acp/breadth.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import * as adapters from '../agents/adapters.ts';
import { betaAgent, isBeta } from '../agents/beta_catalog.ts';
import { baseAgent, isClaudeFamily, isModelServerId } from '../agents/claude_family.ts';
import { QWEN_AUTH_ARGS, codexConfigToml } from '../agents/model_servers.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { sealOrPlain } from '../state/sealed.ts';
import { artifactToolCommand } from '../artifacts/mcp.ts';
import {
  ArtifactMcpHttp,
  FORWARD_FILE,
  forwardEntry,
  HOOK_EVENT_HEADER,
  HOOK_KEY_HEADER,
  HOOK_NONCE_HEADER,
  httpEntry,
  ownForwardFile,
  tunnelEntry,
} from '../artifacts/mcp_http.ts';
import { GEMINI_TRUST_ENV, GEMINI_TRUST_FILE, trustFolders } from '../agents/gemini_trust.ts';
import { headerOf, type TunnelAnswer } from '../wsl/mcp_tunnel.ts';
import { forwarderOf } from '../keeper/client.ts';
import { isCompiled } from '../core/app.ts';
import { KeeperLink } from '../keeper/link.ts';
import { registerSecret } from '../core/log.ts';
import { ValueError } from '../core/py.ts';
import { join } from '../platform/ospath.ts';
import { type WslSpawn } from '../acp/connection.ts';
import {
  distroName,
  hostWhenReady,
  linkOf,
  readyHost,
  windowsPathInWsl,
  WSL_TOOLS_NOTICE,
  wslHost,
  wslLoc,
} from '../wsl/access.ts';
import { log, ARTIFACT_URL_FILE, wslAgentOffLine } from './aib_util.ts';
import { WSL_HOOK_EVENTS } from './aib_helpers.ts';
import type { Aib } from './aib.ts';

export const wslMethods = {
  // ---- artifact tool -----------------------------------------------------------------------------------------------------
  /** Base URL of the web server the artifact tool should call ('' when unknown; the tool then reads the URL file). */
  artifactBaseUrl(this: Aib): string {
    let url = '';
    try {
      url = this.artifactUrlProvider ? this.artifactUrlProvider() : '';
    } catch (error) {
      log.exception(error, 'The artifact URL provider failed');
      url = '';
    }
    const port = this.options.port;
    if (!url && Number.isInteger(port) && port) url = `http://127.0.0.1:${port}`;
    return url || '';
  },

  /** How agents get the artifact tool: 'http' from a built binary (see artifacts/mcp_http.ts), 'stdio' under `deno run`. */
  artifactTransport(this: Aib): 'stdio' | 'http' {
    return this.options.artifactTransport ?? (isCompiled() ? 'http' : 'stdio');
  },

  /** The HTTP artifact server of this AIB, started on first use. */
  artifactMcpHttp(this: Aib): ArtifactMcpHttp {
    if (this.$closed) throw new Error('This AIB is closed');
    if (!this.$mcpHttp) {
      this.$mcpHttp = new ArtifactMcpHttp({
        conversation: (id) => {
          const c = this.connections.get(id);
          return c && !c.closed
            ? { cwd: c.cwd, worktree: !!c.worktree && c.swarm?.role !== 'helper', restricted: !!c.wsl, main: this.$isMain(c) }
            : null;
        },
        servedTools: (id, names) => {
          this.$toolsAnsweredAt.set(id, Date.now()); // a Codex chat waits for its first tools/list (Connection.toolsServed)
          this.served?.tools(id, names);
        },
        baseUrl: () => this.artifactBaseUrl(),
        urlFile: join(this.stateDir, ARTIFACT_URL_FILE),
        // the keeper's MCP forwarder reads it, and every Claude chat's hook forwarder (subagent worktrees), in the keeper or not
        addressFile: join(this.stateDir, FORWARD_FILE),
        hook: (event, conversation, body) => this.$hookCall(event, conversation, body),
      });
    }
    this.$mcpHttp.start();
    return this.$mcpHttp;
  },

  /**
   * The `studio_artifact` MCP entries for one conversation (appended to the user's --mcp-config entries), or []. stdio: the
   * stdio entry. http: the HTTP entry first and the stdio entry as the fallback, under the same name; the connection gives the
   * agent the first one it supports (selectMcpServers), so agents that advertise mcpCapabilities.http get the HTTP one.
   */
  artifactMcpServers(this: Aib, conversationId: string, worktree = false, forwarder: string | null = null, main = false): McpServer[] {
    if (this.options.noArtifactTool || !this.hasStateDir) return [];
    const key = artifactKeys.issue(conversationId);
    if (!key) return [];
    if (forwarder) {
      // An agent in the keeper (design 3.7): the keeper's forwarder, whose program is never in an AIB version folder (an update can
      // remove the old version's files while the chat runs), posting to whichever AIB serves the tool now. stdio only: every ACP
      // agent supports it, and an HTTP entry's port would be dead after the next restart.
      const file = join(this.stateDir, FORWARD_FILE);
      try {
        this.artifactMcpHttp(); // listening, with its address published, before the agent starts the forwarder
        ownForwardFile(file);
        return [forwardEntry(forwarder, file, key, conversationId) as unknown as McpServer];
      } catch (error) {
        log.exception(error, 'Could not start the HTTP artifact tool for the keeper forwarder; the agent gets the usual entries');
      }
    }
    const stdio = this.$artifactStdioEntry(conversationId, key, worktree, main);
    if (this.artifactTransport() !== 'http') return stdio;
    let url: string;
    try {
      url = this.artifactMcpHttp().url;
    } catch (error) {
      log.exception(error, 'Could not start the HTTP artifact tool; agents get the stdio one');
      return stdio;
    }
    return [httpEntry(url, key, conversationId) as unknown as McpServer, ...stdio];
  },

  /**
   * The `studio_artifact` entry of a WSL chat (design sections 4 and 11). Either way the endpoint gives such a chat the tool groups of
   * mcp.ts WSL_TOOL_GROUPS (artifacts by content or Linux path, docs, merge in its own worktree; no swarm tools yet).
   *   - The tunnel (phase 2), when the distro's helper has one: the Linux keeper program as forwarder
   *     (`<root>/<ver>/AIB-keeper mcp-forward --helper-socket <data>/helper/mcp.sock`), the key in its environment; each message goes
   *     through the helper channel to this AIB (wslToolCall). Needs no WSL interop and opens no port.
   *   - Else the interop entry (phase 1): the Windows keeper's forwarder as `/mnt/c/.../AIB-keeper.exe mcp-forward <Windows address
   *     file>`, WSLENV handing MCP_FORWARD_HEADERS over to the Windows process.
   *   - Else no entry, and the chat says the tools are missing instead of failing silently.
   * The user's own --mcp-config entries are Windows commands and are not passed.
   */
  async wslMcpServers(this: Aib, conversationId: string, distro = ''): Promise<{ servers: McpServer[]; notice: string }> {
    if (this.options.noArtifactTool || !this.hasStateDir) return { servers: [], notice: '' };
    const key = artifactKeys.issue(conversationId);
    if (!key) return { servers: [], notice: WSL_TOOLS_NOTICE };
    const tunnel = distro ? wslHost(distro)?.mcpTunnel ?? null : null;
    if (tunnel) {
      return { servers: [tunnelEntry(tunnel.forwarder, tunnel.socket, key, conversationId) as unknown as McpServer], notice: '' };
    }
    let forwarder: string | null = null;
    try {
      forwarder = await forwarderOf(this.keeper?.options.binary ?? null, this.stateDir);
    } catch (error) {
      log.warning('wsl: no MCP forwarder for interop (%s)', errorText(error));
    }
    const program = forwarder ? windowsPathInWsl(forwarder) : null;
    if (!program) return { servers: [], notice: WSL_TOOLS_NOTICE };
    const file = join(this.stateDir, FORWARD_FILE);
    try {
      this.artifactMcpHttp(); // listening, with its address published, before the agent starts the forwarder
      ownForwardFile(file);
    } catch (error) {
      log.exception(error, 'Could not start the HTTP artifact tool for a WSL chat');
      return { servers: [], notice: WSL_TOOLS_NOTICE };
    }
    const entry = forwardEntry(program, file, key, conversationId, forwarder!) as { env: { name: string; value: string }[] };
    entry.env.push({ name: 'WSLENV', value: 'MCP_FORWARD_HEADERS' }); // the agent's variable crosses into the Windows forwarder
    return { servers: [entry as unknown as McpServer], notice: '' };
  },

  /**
   * One tool call from an agent in a WSL distro, through the tunnel (wsl/mcp_tunnel.ts): only for a live chat of this AIB in that same
   * distro, then the HTTP endpoint's own key check and reply (ArtifactMcpHttp.tunneled).
   */
  async wslToolCall(this: Aib, request: { distro: string; key: string; conversation: string; body: string; headers?: Record<string, string> }): Promise<TunnelAnswer> {
    if (this.$closed) return { status: 503, body: '', error: 'AIB is closed, so this tool cannot answer now. Try again later, once AIB is open again.' };
    const c = this.connections.get(request.conversation);
    if (!c || c.closed || !c.wsl || c.wsl.distro.toLowerCase() !== request.distro.toLowerCase()) {
      const refused = { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'AIB refused the artifact key for this conversation' } };
      return { status: 401, body: JSON.stringify(refused) };
    }
    const hookEvent = headerOf(request.headers ?? {}, HOOK_EVENT_HEADER);
    if (hookEvent) return await this.$wslHookCall(hookEvent, request);
    return await this.artifactMcpHttp().tunneled(request.key, request.conversation, request.body);
  },

  /**
   * A subagent hook from an agent in a WSL distro, through the same tunnel (`AIB-keeper hook <event> --helper-socket <socket>`,
   * keeper/hooksocket.go). The chat is a live WSL chat of that distro (wslToolCall checked); the hook key is its own (not the artifact
   * key) and is checked before the body is read, exactly as the HTTP route does (artifacts/mcp_http.ts #hook). The answer goes back as
   * an envelope {status, body, proof}: the tunnel carries no headers, and the proof is the HTTP form's X-Studio-Hook-Proof, which the
   * forwarder checks with the chat's key, so an answer that is not AIB's blocks the call.
   */
  async $wslHookCall(this: Aib, event: string, request: { conversation: string; body: string; headers?: Record<string, string> }): Promise<TunnelAnswer> {
    const headers = request.headers ?? {};
    const key = headerOf(headers, HOOK_KEY_HEADER);
    const nonce = headerOf(headers, HOOK_NONCE_HEADER);
    let signed = false;
    const answer = (status: number, text: string): TunnelAnswer => {
      const proof = signed && /^[0-9a-f]{16,128}$/.test(nonce) ? artifactKeys.hookProof(key, nonce, status, new TextEncoder().encode(text)) : '';
      return { status: 200, body: JSON.stringify({ status, body: text, proof }) };
    };
    if (!artifactKeys.checkHookKey(key, request.conversation)) return answer(401, 'AIB refused the hook key for this conversation');
    signed = true;
    if (!WSL_HOOK_EVENTS.test(event)) return answer(404, 'Not found');
    if (request.body.length > 4 * 1024 * 1024) return answer(413, 'Request too large');
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      return answer(400, 'The hook input is not JSON');
    }
    const result = await this.$hookCall(event, request.conversation, body);
    return answer(result.status, result.body);
  },

  /**
   * What a chat in a WSL project starts (design sections 4 and 5): the agent as the distro has it (the helper's `agents.detect`; a
   * custom agent's command found with `which`), the distro's login environment, and the Linux keeper link it runs in. Throws
   * ValueError with the line the user sees when the distro is not ready or the agent is not installed there.
   * On/Off (docs/wsl/linking-design.md section 12): a WSL chat reads only its distro's own switch (settings.distroAgentEnabled), never
   * the Windows one; an agent turned off for the distro is refused for a new chat (`fresh`) and for the person's Continue
   * (`continued`), never for the automatic reconnect at start.
   */
  async wslLaunch(
    this: Aib,
    provider: string,
    wsl: { distro: string; linuxPath: string },
    fresh = false,
    continued = false,
  ): Promise<{ command: string[]; extra: Record<string, string>; spawn: WslSpawn; link: KeeperLink }> {
    const name = distroName(wsl.distro);
    if ((fresh || continued) && !this.settings.distroAgentEnabled(wsl.distro, provider)) throw new ValueError(wslAgentOffLine(provider, name, this.settings));
    const host = await hostWhenReady(wsl.distro); // the first chat after a Windows start waits for its distro
    let command: string[];
    let extra: Record<string, string> = {};
    if (agentRegistry.isCustom(provider)) {
      const agent = this.settings.customAgent(provider);
      if (agent === null) throw new ValueError('That agent is not in Settings (it may have been removed)');
      for (const e of agent.env) registerSecret(e.value);
      command = [agent.command, ...agent.args];
      extra = Object.fromEntries(agent.env.map((e) => [e.name, e.value]));
    } else {
      const server = isModelServerId(provider) ? this.$modelServerOf(provider) : null;
      const detectId = baseAgent(provider); // a model server entry runs the distro's adapter of its base agent
      const label = isBeta(detectId) ? betaAgent(detectId)!.name : agentRegistry.agentName(detectId);
      const detected = await host.call('agents.detect', { ids: [detectId] });
      const row = detected.agents.find((a) => a.id === detectId);
      if (!row?.found || !row.command?.length) throw new ValueError(`${label} is not installed in ${name}`);
      command = row.command.map(String);
      if (server && detectId === 'qwen') command = [...command, ...QWEN_AUTH_ARGS];
      if (isBeta(provider)) extra = this.betaEnv(provider);
      if (isBeta(provider) && baseAgent(provider) === 'gemini') { // the distro's trust file, with this chat's project folder in it
        delete extra[GEMINI_TRUST_ENV];
        try {
          extra[GEMINI_TRUST_ENV] = (await host.call('geminitrust.write', { folders: [wsl.linuxPath] })).path;
        } catch (error) {
          log.warning('Gemini folder trust in %s could not be set up (an older helper?): %s', name, errorText(error)); // Gemini then asks as before
        }
      }
      if (server) { // same env as a Windows chat; no reachability test from here (see WSL_LOOPBACK_NOTE)
        extra = this.modelServerEnv(provider);
        if (detectId === 'codex') { // its own CODEX_HOME inside the distro, with the same generated config.toml
          const key = this.settings.betaKey(server.id);
          const toml = codexConfigToml(server, await this.$codexWire(server, key));
          extra.CODEX_HOME = (await host.call('codexhome.write', { id: server.id, toml })).path;
        }
      }
    }
    const env = await host.env();
    if (isClaudeFamily(provider)) extra = { ...adapters.claudeEnv(env), ...extra };
    const which = async (program: string) => (await host.call('which', { name: program })).path;
    const program = command[0].includes('/') ? command[0] : await which(command[0]);
    if (!program) throw new ValueError(`${command[0]} was not found in ${name}`);
    const link = linkOf(host);
    this.$followWslLink(link);
    return {
      command,
      extra,
      spawn: { distro: wsl.distro, linuxPath: wsl.linuxPath, env, program, caps: { env: () => host.env(), which } },
      link,
    };
  },

  /**
   * Owner decision 2026-11-24: a Gemini chat's project folder and the AIB worktree copy it works in are trusted for Gemini, in AIB's
   * own trust file (agents/gemini_trust.ts), so Gemini starts AIB's tool server. Only those two folders; never ~/.gemini.
   */
  async $trustForGemini(this: Aib, c: Connection, distro: string | null): Promise<void> {
    try {
      const folders = [...new Set([c.worktree ? c.projectRoot : c.cwd, c.agentCwd].filter((f) => !!f))];
      if (distro) {
        const linux = folders.map((f) => wslLoc(f)?.linuxPath ?? f).filter((f) => f.startsWith('/'));
        if (linux.length) await readyHost(distro).call('geminitrust.write', { folders: linux });
      } else if (this.hasStateDir) trustFolders(join(this.stateDir, GEMINI_TRUST_FILE), folders);
    } catch (error) {
      log.warning('Gemini folder trust could not be updated for chat %s: %s', c.id, errorText(error));
    }
  },

  $followWslLink(this: Aib, link: KeeperLink): void {
    if (this.$wslLinks.has(link)) return;
    this.$wslLinks.add(link);
    const before = link.onLost;
    link.onLost = (channels) => {
      before?.(channels);
      this.$keeperLost(channels);
    };
  },

  $artifactStdioEntry(this: Aib, conversationId: string, key: string, worktree: boolean, main = false): McpServer[] {
    const env: Record<string, string> = {
      STUDIO_ARTIFACT_URL: this.artifactBaseUrl(),
      STUDIO_ARTIFACT_URL_FILE: join(this.stateDir, ARTIFACT_URL_FILE),
      STUDIO_ARTIFACT_KEY: sealOrPlain('artifact-key', key), // sealed on Windows: this entry is in the agent's journal and note
      STUDIO_CONVERSATION_ID: conversationId,
    };
    if (worktree) env.STUDIO_WORKTREE = '1'; // only a worktree chat is offered the merge tools
    if (main) env.STUDIO_MAIN = '1'; // swarm: only a main chat is offered the helper tools (the route checks again)
    return [{
      name: 'studio_artifact',
      ...artifactToolCommand(), // `<deno> run -A --quiet main.ts mcp-artifact` (or `<binary> mcp-artifact`): artifacts/mcp.ts
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    } as McpServer];
  },
};

export type WslMethods = typeof wslMethods;
