/**
 * Aib methods: worktree records, removing and retiring merged or stopped helper copies.
 * Moved out of aib.ts (no change).
 */
import { Connection } from '../acp/connection.ts';
import { isdir } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { applyProject as cleanupApply, dropChatRefs, logLine as cleanupLog } from '../worktrees/cleanup.ts';
import { helperOf, readHelpers, Registry as HelperRegistry } from '../swarm/registry.ts';
import { wslLoc } from '../wsl/access.ts';
import { isWslRecord, wslRecord, wslRemove } from '../wsl/worktrees.ts';
import { log, STOPPED_HELPER_DAYS } from './aib_util.ts';
import type { Aib } from './aib.ts';

export const worktreeMethods = {
  // ---- worktree removal (Discard, archive, delete) ------------------------------------------------------------------------
  /** The worktree record of a chat folder (or saved session): a WSL ref's is asked of its distro's helper (wsl/worktrees.ts). */
  async $worktreeRecord(this: Aib, path: string | null = null, session: string | null = null): Promise<(wt.WorktreeRecord & { key: string }) | null> {
    if (!this.worktrees) return null;
    if (path && wslLoc(path)) return await wslRecord(path, session, true);
    return this.worktrees.registry.find(path, session);
  },

  $connectionsIn(this: Aib, path: string): Connection[] {
    // a WSL ref is compared as the ref it is (never resolved on Windows)
    const here = wslLoc(path) ? (c: Connection) => c.cwd === path : (c: Connection) => wt.same(c.cwd, path);
    return [...this.connections.values()].filter((c) => !c.closed && here(c));
  },

  async $removeWorktree(this: Aib, record: wt.WorktreeRecord & { key: string }, confirmed: boolean): Promise<wt.RemoveOutcome> {
    if (isWslRecord(record)) return await wslRemove(record, confirmed);
    const outcome = await this.worktrees!.remove(record.key, confirmed);
    // decision 6 (5.3): every refs/studio/<slug>/* of the chat's branch goes with it (the U pin and anything later added there)
    if (outcome === 'removed' && record.project && isdir(String(record.project))) {
      await dropChatRefs(String(record.project), String(record.branch ?? '')).catch((error) => log.exception(error, 'Dropping refs failed'));
    }
    return outcome;
  },

  // ---- after a copy is gone: the chat carries on in the project folder (build plan 1b 4.3-4.5; owner 2026-11-16) ------------
  /** True when the saved chat (or a copy folder) is a helper's: helper transcripts are never moved, helpers never move to the folder. */
  $isHelperCopy(this: Aib, record: wt.WorktreeRecord): boolean {
    if (String(record.branch ?? '').startsWith('studio/helper-')) return true;
    if (!this.hasStateDir) return false;
    return !!helperOf(readHelpers(this.stateDir), { lasting: String(record.session ?? '') || null, path: String(record.path ?? '') || null });
  },

  /** True while the saved chat runs anywhere: a chat of this host, a keeper channel or another agent process (VS Code, a terminal). */
  async $openAnywhere(this: Aib, provider: string, sessionId: string, path: string): Promise<boolean> {
    for (const c of this.connections.values()) {
      if (c.closed) continue;
      if (c.provider === provider && c.sessionId === sessionId) return true;
      if (path && wt.same(c.cwd, path)) return true;
    }
    if (this.takingOver()) return true; // its agent may still be in the keeper, about to be taken over
    try {
      const owner = await this.ownerProbe(provider, sessionId, [Deno.pid]);
      if (owner !== null && owner !== undefined) return true;
    } catch {
      return true; // cannot tell: not now
    }
    return false;
  },

  /**
   * Build plan 1b 5.3 (MF 5): the copies of helpers that stopped or failed go 7 days after they stopped, when their chat is closed (not
   * open anywhere), their main chat is not open here and nothing in the copy is unmerged. The removal is cleanup.ts applyProject for
   * that one copy: this install's records only (per-install scope), a fresh scan under the repo lock, silent only without unmerged
   * work (5.2: files against the user base, commits on the branch count), never a running chat's copy. A helper that stopped before
   * this build has no stop time: its 7 days count from the first time this runs. WSL has no helpers. Returns the helper ids done.
   */
  async retireStoppedHelpers(this: Aib, now = Date.now() / 1000): Promise<string[]> {
    const done: string[] = [];
    if (!this.worktrees || !this.hasStateDir || this.takingOver()) return done;
    const helpers = new HelperRegistry(this.stateDir);
    for (const h of Object.values(readHelpers(this.stateDir))) {
      if (h.state !== 'stopped' && h.state !== 'failed') continue;
      const path = String(h.worktree?.path ?? '');
      if (!path || wslLoc(path)) continue;
      if (!(Number(h.endedAt) > 0)) {
        await helpers.patch(h.id, { endedAt: now });
        continue;
      }
      if (now - Number(h.endedAt) < STOPPED_HELPER_DAYS * 86_400) continue;
      const record = this.worktrees.registry.find(path, null);
      if (!record || record.status !== 'ready' || !record.project) continue;
      if (this.$connectionsIn(path).length) continue;
      const lasting = String(h.chat?.lasting ?? '');
      const at = lasting.indexOf(':');
      if (at > 0 && (await this.$openAnywhere(lasting.slice(0, at), lasting.slice(at + 1), path))) continue;
      const open = [...this.connections.values()].filter((c) => !c.closed);
      if (open.some((c) => c.id === h.parent?.live || (!!c.sessionId && `${c.provider}:${c.sessionId}` === h.parent?.lasting))) continue;
      const live = open.flatMap((c) => [c.cwd, ...(c.sessionId ? [`${c.provider}:${c.sessionId}`] : [])]);
      const id = `copy:${record.key}`;
      try {
        const result = await cleanupApply(this.stateDir, String(record.project), [], { live, only: [id] });
        if (result.removed.includes(id)) {
          done.push(h.id);
          cleanupLog(this.stateDir, `stopped helper ${h.id} (${h.state} ${Math.floor((now - Number(h.endedAt)) / 86_400)} days ago): removed its copy ${path}`);
        } else {
          const item = result.scan.items.find((i) => i.id === id);
          const why = result.left[id] || result.scan.skipped || (item?.unmerged ? 'unmerged work' : item?.live ? 'in use' : 'not found');
          log.info('Kept the copy of stopped helper %s: %s', h.id, why);
        }
      } catch (error) {
        log.exception(error, 'Removing the copy of stopped helper %s failed', h.id);
      }
    }
    return done;
  },

  /**
   * P4b (decision 6, 5.3; MF 5): the copies of merged helpers whose chat is closed (not open anywhere) and that hold nothing new
   * since the merge are removed (worktree, branch, refs, git's record). A copy with work after its merge is kept: unmerged work is
   * never removed silently. An old main chat's copy (from before every chat worked in the project folder) is left alone: the owner's
   * one-off migration script (work/migrate/folder_chats_migrate.ts) moves those chats to their project folder. Runs when a chat is
   * closed, after a merge, and once the take-over at start is done. Returns the keys removed.
   */
  retireMerged(this: Aib): Promise<string[]> {
    if (this.$retiring) return this.$retiring.then(() => this.retireMerged());
    const run = this.$retireMerged().finally(() => (this.$retiring = null));
    this.$retiring = run;
    return run;
  },

  async $retireMerged(this: Aib): Promise<string[]> {
    const done: string[] = [];
    if (!this.worktrees) return done;
    for (const [key, record] of Object.entries(this.worktrees.registry.all())) {
      if (record.status !== 'ready' || !record.mergedAt || !this.$isHelperCopy(record)) continue;
      const path = String(record.path ?? '');
      const session = String(record.session ?? '');
      const at = session.indexOf(':');
      if (this.$connectionsIn(path).length) continue; // its chat is open here
      if (at > 0 && (await this.$openAnywhere(session.slice(0, at), session.slice(at + 1), path))) continue;
      if (at < 0 && this.takingOver()) continue;
      try {
        if (await this.worktrees.hasChanges(record)) continue; // work since the merge: kept until merged or discarded
        const outcome = await this.$removeWorktree({ ...record, key }, false);
        if (outcome !== 'removed') continue;
        done.push(key);
      } catch (error) {
        log.exception(error, 'Removing the merged copy %s failed', path);
      }
    }
    return done;
  },
};

export type WorktreeMethods = typeof worktreeMethods;
