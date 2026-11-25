/**
 * A foreground Claude Agent call gets its builder's landing outcome inside its own tool result (PostToolUse additionalContext,
 * subagents/service.ts #postAgent). The hook runs in the agent host and the swarm in the web process, so the hook leaves a small marker
 * file per builder here and the swarm leaves that builder out of its wake line (swarm/service.ts #flushLanded).
 */
import { pathOf } from '../state/paths.ts';

const DIR = 'landing-told';
const KEEP_MS = 24 * 3600_000;

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/** The builder `id` was told its outcome inline. Never throws. */
export function markTold(stateDir: string, id: string): void {
  try {
    const dir = pathOf(stateDir, DIR);
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(pathOf(dir, safe(id)), String(Date.now()));
    for (const entry of Deno.readDirSync(dir)) { // old markers go
      try {
        const path = pathOf(dir, entry.name);
        const at = Deno.statSync(path).mtime?.getTime() ?? 0;
        if (Date.now() - at > KEEP_MS) Deno.removeSync(path);
      } catch { /* gone */ }
    }
  } catch { /* the wake line is sent instead: a repeat is harmless */ }
}

/** True when the builder `id` was told its outcome inline. */
export function wasTold(stateDir: string, id: string): boolean {
  try {
    Deno.statSync(pathOf(stateDir, DIR, safe(id)));
    return true;
  } catch {
    return false;
  }
}
