/**
 * Re-filing old copy chats of WSL projects, in the distro (build plan 1b 4.5 SF 9, 4.6; owner decision 2026-11-16: every chat works
 * in the project folder, old copy chats are re-filed and their backups kept forever). worktrees/refile.ts runs whole here, natively,
 * with Linux path rules: the Claude Code transcript moves from `~/.claude/projects/<enc copy>/` to `~/.claude/projects/<enc project>/`
 * (Linux encoding: `/home/u/shop` -> `-home-u-shop`) with its cwd lines rewritten; Codex's rollout is only backed up here (AIB then
 * opens the chat once in the project folder, in the distro, and Codex re-indexes it itself). Backups go to `<data>/refiled/<provider>/`
 * and are never deleted.
 *
 * Safety: the copy folder (`from`) must be under this AIB's worktrees root in the distro (`<data>/worktrees`), so nothing on the
 * channel can move a transcript of any other folder; `transcripts.cleanEmpty` removes only empty folders whose name is the encoding of
 * a path under that root, with a plain (non-recursive) rmdir.
 */
import * as osp from '../../platform/ospath.ts';
import { backup, cleanEmptyCopyFolders, findCodexRollout, isCopyNamed, refileClaude } from '../../worktrees/refile.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';
import type { HelperContext } from './methods.ts';

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function absPath(p: Record<string, unknown>, name: string, optional = false): string {
  const value = str(p, name, optional);
  if (!value && optional) return '';
  if (!value || value.length > 4096 || value.includes('\0') || !osp.isabs(value)) throw new RpcError(`${name} must be an absolute path`, BAD_PARAMS);
  return osp.normpath(value);
}

/** Claude Code's projects folder of the distro user: `claudeDir` when AIB names it (tests), else CLAUDE_CONFIG_DIR, else ~/.claude. */
async function claudeProjects(ctx: HelperContext, p: Record<string, unknown>): Promise<string> {
  const asked = absPath(p, 'claudeDir', true);
  const login = await ctx.env();
  const dir = asked || login.env.CLAUDE_CONFIG_DIR || osp.join(login.home || login.env.HOME || '/', '.claude');
  return osp.join(osp.normpath(dir), 'projects');
}

/** CODEX_HOME of the distro user: `codexDir` when AIB names it (tests), else CODEX_HOME, else ~/.codex. */
async function codexHome(ctx: HelperContext, p: Record<string, unknown>): Promise<string> {
  const asked = absPath(p, 'codexDir', true);
  const login = await ctx.env();
  return osp.normpath(asked || login.env.CODEX_HOME || osp.join(login.home || login.env.HOME || '/', '.codex'));
}

/** transcripts.refile and transcripts.cleanEmpty over `data` (the Linux keeper's data folder: backups and the worktrees root). */
export function refileMethods(ctx: HelperContext, data: string): Handlers {
  const root = osp.join(osp.normpath(data), 'worktrees');
  const under = (path: string) => osp.normcase(path).startsWith(osp.normcase(root) + osp.SEP);
  return {
    'transcripts.refile': async (p) => {
      const provider = str(p, 'provider');
      const sessionId = str(p, 'sessionId');
      if (provider !== 'claude' && provider !== 'codex') throw new RpcError('provider must be claude or codex', BAD_PARAMS);
      if (!SESSION_ID.test(sessionId)) throw new RpcError('sessionId is not a session id', BAD_PARAMS);
      const from = absPath(p, 'from');
      const to = absPath(p, 'to');
      if (!under(from)) throw new RpcError('from must be a copy under this AIB\'s worktrees folder', BAD_PARAMS);
      if (under(to) || to === root) throw new RpcError('to must be a project folder', BAD_PARAMS);
      if (provider === 'codex') {
        const rollout = findCodexRollout(await codexHome(ctx, p), sessionId);
        if (!rollout) return { outcome: 'missing', message: 'no rollout found', path: '', backup: '', fromFolder: '' };
        try {
          return { outcome: 'saved', message: '', path: rollout, backup: backup(data, 'codex', sessionId, rollout), fromFolder: '' };
        } catch (error) {
          return { outcome: 'failed', message: `could not back the rollout up: ${error instanceof Error ? error.message : error}`, path: '', backup: '', fromFolder: '' };
        }
      }
      const projectsRoot = await claudeProjects(ctx, p);
      const done = refileClaude({ stateDir: data, projectsRoot, sessionId, from, to });
      if (done.outcome === 'moved' && done.fromFolder && isCopyNamed(osp.basename(done.fromFolder), root)) {
        try {
          Deno.removeSync(done.fromFolder); // only when empty (not recursive): a folder with memory/ or any file stays
        } catch { /* kept */ }
      }
      return { ...done };
    },

    'transcripts.cleanEmpty': async (p) => {
      const [removed, kept] = cleanEmptyCopyFolders(await claudeProjects(ctx, p), root);
      return { removed, kept };
    },
  };
}
