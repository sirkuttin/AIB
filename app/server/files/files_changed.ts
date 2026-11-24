/**
 * "Files changed" events for the file editor (architect review 2026-11-16, must-fix 7). The open files' live text lives in the web
 * server (files/live_files.ts). Two kinds of writers tell it when files on disk changed:
 *   - landings and Undo (worktrees/merge.ts landHeld, swarm/undo.ts applyChange) run in the web server too: they call
 *     emitFilesChanged here after the folder moved and the pause lock is let go;
 *   - an agent's own write tool calls happen in the agent host (Studio): the web server polls them with liveCall('files-changed')
 *     (host/aib.ts) and feeds them in through the same emit.
 * A listener reads the named files when they have settled (live_files.ts). Nothing here throws into the writer.
 */

export interface FilesChanged {
  /** The folder the paths are in (absolute), and the paths (relative with '/', or absolute when `folder` is ''). */
  folder: string;
  paths: string[];
  /** Who wrote them: a helper's or subagent's name for a landing, a chat's title for its write call, '' when unknown. */
  who: string;
  kind: 'landing' | 'undo' | 'write';
  /** The chat whose write it was (a live connection id), for the note to that chat. */
  chat?: string;
}

const listeners = new Set<(event: FilesChanged) => void>();

/** Listen; returns the function that stops listening. */
export function onFilesChanged(listener: (event: FilesChanged) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when someone listens (a landing skips its extra `git diff` otherwise). */
export function hasFilesChangedListeners(): boolean {
  return listeners.size > 0;
}

export function emitFilesChanged(event: FilesChanged): void {
  if (!event.paths.length) return;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch { /* a listener's trouble never reaches the writer */ }
  }
}
