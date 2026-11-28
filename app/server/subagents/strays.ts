/**
 * Subagent worktrees that have no record (owner 2026-11-28: a chat's three subagents made worktrees in the distro, but their
 * records never reached AIB's list). Every record is written BEFORE its worktree exists, so a worktree with no record is one whose
 * record was lost (a crash, a half-written file, an older build). It is never silently left and never deleted: it is taken up as a
 * record in state `stopped` with its real facts read from git, so the swarm hands its work to the main agent (land, diff or discard),
 * exactly as it does for any stopped subagent. A worktree some process still works in is left for the next look (it is not over).
 */
import * as osp from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { pyStrip } from '../core/py.ts';
import { ownSubagentPath, type SubagentRecord, type SubagentWorktrees } from './service.ts';

const SLUG = /^sub-([A-Za-z0-9]{8})-(\d{1,4})$/;
export const STRAY_WHY = 'AIB found this worktree with no record of it (the record was lost); its work is kept for you';

/** True when some process has its working directory inside `path` (Linux /proc; elsewhere false). */
export function processInside(path: string): boolean {
  try {
    const top = osp.normcase(osp.normpath(path)).replace(/[\\/]+$/, '');
    for (const e of Deno.readDirSync('/proc')) {
      if (!/^\d+$/.test(e.name)) continue;
      try {
        const cwd = osp.normcase(Deno.readLinkSync(`/proc/${e.name}/cwd`));
        if (cwd === top || cwd.startsWith(top + '/')) return true;
      } catch { /* gone, or not ours to look at */ }
    }
  } catch { /* no /proc */ }
  return false;
}

function listDirs(path: string): string[] {
  try {
    return [...Deno.readDirSync(path)].filter((e) => e.isDirectory && !e.isSymlink).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Takes up the worktrees under `root` (<root>/<repo hash>/sub-<chat>-<n>, and a Codex or Gemini chat's .cx-/.gem- folder inside it)
 * that no record names. Returns the records made. `chatFor` maps the 8-letter chat prefix of the name to the open chat's id and
 * lasting name when the chat is known here (else the prefix stands for it and the swarm treats the work as its project's).
 */
export async function adoptStrays(
  service: SubagentWorktrees,
  root: string,
  chatFor: (prefix: string) => { id: string; lasting: string } | null = () => null,
  busy: (path: string) => boolean = processInside,
): Promise<SubagentRecord[]> {
  const made: SubagentRecord[] = [];
  const known = new Set<string>();
  for (const r of service.all()) {
    if (r.path) known.add(osp.normcase(osp.normpath(r.path)));
    known.add(r.slug);
  }
  const candidates: string[] = [];
  for (const hash of listDirs(root)) {
    if (hash.startsWith('.')) continue;
    for (const name of listDirs(osp.join(root, hash))) {
      if (SLUG.test(name)) candidates.push(osp.join(root, hash, name));
      else if (/^\.(gem|cx)-[A-Za-z0-9_-]{1,64}$/.test(name)) {
        for (const inner of listDirs(osp.join(root, hash, name))) if (SLUG.test(inner)) candidates.push(osp.join(root, hash, name, inner));
      }
    }
  }
  for (const path of candidates) {
    const slug = osp.basename(path);
    if (known.has(osp.normcase(osp.normpath(path))) || known.has(slug)) continue;
    try {
      if (!osp.isfile(osp.join(path, '.git'))) continue; // not a linked worktree
      const common = pyStrip((await wt.git(['rev-parse', '--git-common-dir'], path, { check: false })).stdout);
      if (!common) continue;
      const commonDir = osp.isabs(common) ? common : osp.join(path, common);
      const top = osp.normpath(osp.dirname(osp.normpath(commonDir)));
      if (osp.basename(commonDir) !== '.git' || !osp.isdir(top)) continue;
      const branch = pyStrip((await wt.git(['symbolic-ref', '--short', '-q', 'HEAD'], path, { check: false })).stdout);
      if (branch !== `studio/${slug}`) continue; // not made by AIB (or moved): never claimed
      const probe = { path, project: top };
      if (!ownSubagentPath(root, probe)) continue; // not exactly AIB's own folder for that project
      if (busy(path)) continue; // something still works there: not over, looked at again later
      const created = (await wt.git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], top, { check: false })).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      let snapshot = created.at(-1) ?? '';
      if (!snapshot) {
        const head = pyStrip((await wt.git(['rev-parse', 'HEAD'], top, { check: false })).stdout);
        const tip = pyStrip((await wt.git(['rev-parse', 'HEAD'], path, { check: false })).stdout);
        if (head && tip) snapshot = pyStrip((await wt.git(['merge-base', head, tip], top, { check: false })).stdout);
      }
      if (!snapshot) continue;
      const tree = pyStrip((await wt.git(['rev-parse', `${snapshot}^{tree}`], top, { check: false })).stdout);
      const prefix = SLUG.exec(slug)![1];
      const chat = chatFor(prefix);
      let at = Date.now() / 1000;
      try {
        const st = Deno.statSync(path);
        at = (st.birthtime ?? st.mtime ?? new Date()).getTime() / 1000;
      } catch { /* now */ }
      const id = 'sa_' + crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const rec: SubagentRecord = {
        id,
        kind: 'subagent',
        chat: chat?.id ?? prefix,
        lasting: chat?.lasting ?? '',
        project: top,
        folder: top,
        slug,
        branch,
        path,
        snapshot,
        tree,
        state: 'stopped',
        toolUseId: '',
        agentId: '',
        agentType: '',
        description: `Subagent worktree ${slug}`,
        createdAt: at,
        stoppedAt: Date.now() / 1000,
        stoppedWhy: STRAY_WHY,
      };
      made.push(await service.addRecord(rec));
    } catch (error) {
      console.error(`AIB-wsl-helper: could not take up the worktree ${path} (${error instanceof Error ? error.message : error})`);
    }
  }
  return made;
}
