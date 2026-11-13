/**
 * Stray copies of local-only files (Deno only): files written under a local-only path inside a chat's own copy (a worktree), where
 * they are not the shared main-folder file and would be lost when the copy is removed. findStrays lists them; moveStrays moves them
 * into the main folder (a name clash gets "<name> (from chat-…)<ext>"; a byte-identical copy is just deleted).
 *
 * STUB (contract step 0): Builder 2 fills the bodies. The signatures are fixed by the local-only contract (local_only.ts).
 */
import type { LocalOnly } from './local_only.ts';

/** Project-relative forward-slash paths of the stray files under local-only entries in `worktree` (a chat's copy). */
export function findStrays(_worktree: string, _lo: LocalOnly): Promise<string[]> {
  return Promise.resolve([]);
}

/** Moves every stray of `worktree` into lo.project. `moved` = [from (worktree-relative), to (project-relative)]; `failed` = paths left. */
export function moveStrays(_worktree: string, _lo: LocalOnly, _slug: string): Promise<{ moved: [string, string][]; failed: string[] }> {
  return Promise.resolve({ moved: [], failed: [] });
}
