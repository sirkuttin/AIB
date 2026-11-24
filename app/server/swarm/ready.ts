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

export interface ReadyContext {
  agentOptions: AgentOptions;
  settings: unknown;
  host: Pick<LiveBackend, 'signinCall'>;
}

const nameOf = (id: string) => agentRegistry.BUILTIN_NAMES[id] ?? (agentRegistry.BETA_NAMES as Record<string, string>)[id] ?? id;

export async function agentProblem(ctx: ReadyContext, provider: string): Promise<string> {
  const base = baseAgent(provider);
  const name = nameOf(base);
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
