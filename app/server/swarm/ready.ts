/**
 * Up-front check before a helper starts (start_helper): is the chosen agent installed, and signed in? The answer is one plain line
 * the main agent can pass on, instead of a helper that opens and then fails ("Failed: Codex isn't signed in").
 *
 * Reuses what Settings uses: the agent's launch row (installed?) and the sign-in check (the cache in <state>/agents/<id>/signin.json,
 * refreshed through the agent host when older than a minute: studio.signinCall('check')). A model-server entry (`claude@strata`) needs
 * no sign-in, only its base agent installed; its server's health is checked apart (service.ts #serverDown).
 * Only a clear "signed out" refuses; an agent whose sign-in cannot be checked is let through, as the open step still checks it.
 */
import * as agentRegistry from '../agents/agent_registry.ts';
import { baseAgent, isServerEntry } from '../agents/claude_family.ts';
import { resolveBeta } from '../agents/beta_agents.ts';
import { isDict } from '../core/py.ts';
import { builtinLaunch, type AgentOptions, type SettingsLike } from '../web/shared.ts';
import type { LiveBackend } from '../host/backend.ts';
import { hostWhenReady } from '../wsl/access.ts';

export interface ReadyContext {
  agentOptions: AgentOptions;
  settings: unknown;
  host: Pick<LiveBackend, 'signinCall'>;
}

const nameOf = (id: string) => agentRegistry.BUILTIN_NAMES[id] ?? (agentRegistry.BETA_NAMES as Record<string, string>)[id] ?? id;

/**
 * A WSL project's helper runs its agent inside the distro: installed there (agents.detect) and signed in there (agents.signinStatus),
 * asked of the distro's helper. Only a clear "not found" or "signed out" refuses; a distro that cannot answer is let through (the
 * open step still checks), as an agent whose sign-in cannot be checked is on Windows.
 */
async function wslAgentProblem(distro: string, base: string, name: string, serverEntry: boolean): Promise<string> {
  try {
    const host = await hostWhenReady(distro);
    const found = (await host.call('agents.detect', { ids: [base] })).agents.find((a) => a.id === base);
    if (found && !found.found) return `${name} isn't installed in ${distro}: install it from Settings › AIB Linking`;
    if (serverEntry) return '';
    const sign = (await host.call('agents.signinStatus', { ids: [base] })).agents.find((a) => a.id === base);
    if (sign?.state === 'signed_out') return `${name} isn't signed in in ${distro}: sign in from Settings › AIB Linking`;
  } catch {
    return '';
  }
  return '';
}

export async function agentProblem(ctx: ReadyContext, provider: string, distro = ''): Promise<string> {
  const base = baseAgent(provider);
  const name = nameOf(base);
  if (distro) return await wslAgentProblem(distro, base, name, isServerEntry(provider));
  const builtin = (agentRegistry.BUILTIN_IDS as readonly string[]).includes(base);
  const found = builtin
    ? (await builtinLaunch(ctx.agentOptions, ctx.settings as SettingsLike, base)).found
    : (await resolveBeta(base, { stateDir: ctx.agentOptions.stateDir ?? null, nodeCommand: ctx.agentOptions.nodeCommand || '' })).found;
  if (!found) return `${name} isn't installed on this PC: install it from Settings › AIB Linking`;
  if (isServerEntry(provider)) return ''; // a model server needs no sign-in
  const [code, payload] = await ctx.host.signinCall('check', base).catch(() => [500, null] as [number, unknown]);
  if (code === 200 && isDict(payload) && payload.state === 'signin') {
    return `${name} isn't signed in on this PC: sign in from Settings › AIB Linking`;
  }
  return '';
}
