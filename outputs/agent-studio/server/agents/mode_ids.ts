/**
 * Mode ids that changed between adapter versions. codex-acp 2.6.0 renamed Codex's modes: `auto` (edit the workspace, ask outside it)
 * became `workspace-write`, and `full-access` became `agent-full-access` (`agent` is "Auto review", a different mode, never mapped).
 * A saved default or a helper's wanted mode can still hold the old id, so a wanted id is matched against what the agent offers NOW.
 * An alias only ever maps to the same-breadth mode, never a broader one.
 */
const RENAMED: Readonly<Record<string, readonly string[]>> = {
  auto: ['workspace-write'],
  'workspace-write': ['auto'],
  'full-access': ['agent-full-access'],
  'agent-full-access': ['full-access'],
};

/** The first of `wanted` (each tried with its renamed twin only when `aliases`) that the agent offers; '' when none. */
export function resolveMode(offered: readonly string[], wanted: string | readonly string[], aliases = false): string {
  const list = typeof wanted === 'string' ? [wanted] : wanted;
  for (const id of list) {
    if (id && offered.includes(id)) return id;
  }
  if (aliases) {
    for (const id of list) {
      for (const twin of RENAMED[id] ?? []) if (offered.includes(twin)) return twin;
    }
  }
  return '';
}

/** The ids of an ACP `modes.availableModes` list. */
export function offeredModeIds(modes: unknown): string[] {
  const list = modes && typeof modes === 'object' ? (modes as { availableModes?: unknown }).availableModes : null;
  if (!Array.isArray(list)) return [];
  return list.map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : null)).filter((x): x is string => typeof x === 'string');
}
