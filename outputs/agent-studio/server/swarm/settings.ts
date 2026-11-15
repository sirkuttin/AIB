/**
 * Swarm settings (<state>/swarm-settings.json), apart from Settings (state/settings.ts keeps the Python reference's exact shape). Phase 1
 * has one: whether the main agent may start Claude Code helpers. The Settings › Helpers page comes in phase 2; until then the file is the
 * switch ({"claudeHelpers": false} turns them off).
 */
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { isDict } from '../core/py.ts';

export const FILE = 'swarm-settings.json';
/** Claude Code as a helper provider by default (owner decision 2026-11-13: on). The one place to flip it. */
export const CLAUDE_HELPERS_DEFAULT = true;

export function claudeHelpers(stateDir: string | null): boolean {
  if (!stateDir) return CLAUDE_HELPERS_DEFAULT;
  try {
    const [status, raw] = readJsonFile(pathOf(stateDir, FILE));
    if (status === 'ok' && isDict(raw) && typeof raw.claudeHelpers === 'boolean') return raw.claudeHelpers;
  } catch { /* unreadable: the default */ }
  return CLAUDE_HELPERS_DEFAULT;
}

/** Swarm phase 1 is off by default for the public beta (it is still being finished): the main agent is offered no helper tools. */
export const SWARM_ENABLED_DEFAULT = false;

function readAll(stateDir: string): Record<string, unknown> {
  try {
    const [status, raw] = readJsonFile(pathOf(stateDir, FILE));
    if (status === 'ok' && isDict(raw)) return { ...raw };
  } catch { /* unreadable: start clean */ }
  return {};
}

export function swarmEnabled(stateDir: string | null): boolean {
  if (!stateDir) return SWARM_ENABLED_DEFAULT;
  const v = readAll(stateDir).enabled;
  return typeof v === 'boolean' ? v : SWARM_ENABLED_DEFAULT;
}

export function setSwarmEnabled(stateDir: string, on: boolean): void {
  saveJson(pathOf(stateDir, FILE), { ...readAll(stateDir), enabled: on }, '.swarm-settings-');
}

export function setClaudeHelpers(stateDir: string, on: boolean): void {
  saveJson(pathOf(stateDir, FILE), { ...readAll(stateDir), claudeHelpers: on }, '.swarm-settings-');
}
