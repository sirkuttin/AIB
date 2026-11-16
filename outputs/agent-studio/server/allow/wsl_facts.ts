/**
 * Allow rules in a WSL chat: getting the distro facts the matcher needs (allow/linux.ts) from the distro's helper (`allow.facts`).
 * Connection.ts calls `prefetch` before it decides a live request (and before a sweep), and `warm` once when the chat starts. A helper
 * that is not ready (AIB never starts a distro for this), an older helper without the method, a time-out or a malformed answer leave
 * the facts unknown, so the request asks.
 */
import type { WslHost } from '../wsl/contract.ts';
import type { AgentConfigFacts } from './agent_config.ts';
import type { AllowGate } from './gate.ts';
import { LinuxFacts, LinuxNeeds, LinuxView } from './linux.ts';
import type { MatchContext } from './matcher.ts';

/** Where a WSL chat's facts come from. */
export interface WslFactsSource {
  /** The distro's host when it is ready, else null (never starts it). */
  host(): WslHost | null;
  /** The chat's Linux folder (the agent's cwd). */
  cwd(): string;
  /** Read the Claude settings facts (a Claude chat). */
  claude: boolean;
  /** Claude's config folder in the distro as the agent gets it (CLAUDE_CONFIG_DIR, else $HOME/.claude), when AIB knows it. */
  claudeDir(): string | undefined;
  /** The agent's PATH when AIB knows it (else the helper's login PATH). */
  pathEnv(): string | undefined;
}

export const FACTS_TIMEOUT_MS = 3000;
const ROUNDS = 4;

/** Facts for a recording run while the Claude settings facts are not known yet (only to collect what to ask; never decides). */
export const COLLECT_FACTS: AgentConfigFacts = Object.freeze({ askPrograms: new Set<string>(), askTools: new Set<string>(), riskyEnv: '' });

const isStr = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isStr) ? v as string[] : null);

/** Ask the helper for what `needs` names and keep the answers in `facts`. False when nothing could be learnt. */
export async function fetchFacts(facts: LinuxFacts, needs: LinuxNeeds, src: WslFactsSource): Promise<boolean> {
  const host = src.host();
  if (!host || host.state !== 'ready') return false;
  const paths = [...needs.paths].slice(0, 64);
  const scans = [...needs.scans].slice(0, 16);
  const pinList = [...needs.pins.entries()].slice(0, 8);
  const params: Record<string, unknown> = { paths, scans, pins: pinList.map(([, v]) => v) };
  if (needs.base) {
    const pathEnv = src.pathEnv();
    const dir = src.claudeDir();
    params.base = {
      ...(pathEnv ? { pathEnv } : {}),
      ...(src.claude ? { claude: { cwd: src.cwd(), ...(dir && dir.startsWith('/') ? { dir } : {}) } } : {}),
    };
  }
  const at = Date.now();
  let res: Record<string, unknown>;
  try {
    res = await host.call('allow.facts', params as never, { timeoutMs: FACTS_TIMEOUT_MS }) as unknown as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!res || typeof res !== 'object') return false;
  facts.trim();
  const got = Array.isArray(res.paths) ? res.paths : [];
  paths.forEach((path, i) => {
    const f = got[i] as Record<string, unknown> | undefined;
    if (!f || typeof f !== 'object') return;
    const real = isStr(f.real) && f.real.startsWith('/') ? f.real : null;
    facts.paths.set(path, { v: { real, exists: f.exists === true, isDir: f.isDir === true }, at });
  });
  const scanned = Array.isArray(res.scans) ? res.scans : [];
  scans.forEach((dir, i) => facts.scans.set(dir, { v: scanned[i] !== false, at })); // unreadable answer: holds links
  const pinned = Array.isArray(res.pins) ? res.pins : [];
  pinList.forEach(([key], i) => facts.pins.set(key, { v: isStr(pinned[i]) ? pinned[i] as string : null, at }));
  const base = res.base as Record<string, unknown> | undefined;
  if (needs.base && base && typeof base === 'object') {
    const dirs = Array.isArray(base.pathDirs) ? base.pathDirs : null;
    const own = strList(base.own);
    if (dirs && own) {
      const c = base.claude as Record<string, unknown> | null | undefined;
      const askPrograms = strList(c?.askPrograms), askTools = strList(c?.askTools);
      const claude = c && askPrograms && askTools && isStr(c.riskyEnv)
        ? { askPrograms: new Set(askPrograms), askTools: new Set(askTools), riskyEnv: c.riskyEnv }
        : null;
      facts.base = {
        v: {
          pathDirs: dirs.map((d) => {
            const x = d as Record<string, unknown>;
            return { dir: isStr(x?.dir) ? x.dir : '', real: isStr(x?.real) && x.real.startsWith('/') ? x.real : null };
          }),
          own: own.filter((o) => o.startsWith('/')),
          claude,
        },
        at,
      };
    }
  }
  return true;
}

/**
 * Learn what deciding `params` needs: run the matcher with a recording view, ask for what it named, again until nothing new is named.
 * `ctxFor` builds the chat's context for a view (Connection.allowContext). Facts read before `since` count as unknown.
 */
export async function prefetch(
  gate: AllowGate,
  facts: LinuxFacts,
  src: WslFactsSource,
  params: unknown,
  since: number,
  ctxFor: (view: LinuxView) => MatchContext,
): Promise<void> {
  for (let round = 0; round < ROUNDS; round++) {
    const needs = new LinuxNeeds();
    const view = new LinuxView(facts, { since, needs });
    gate.collect(params, ctxFor(view));
    if (needs.empty) return;
    if (!(await fetchFacts(facts, needs, src))) return;
  }
}

/** The chat's folder and the base facts, once at start (a check made straight away then has them). */
export async function warm(facts: LinuxFacts, src: WslFactsSource): Promise<void> {
  const needs = new LinuxNeeds();
  needs.base = true;
  needs.paths.add(src.cwd());
  await fetchFacts(facts, needs, src);
}

