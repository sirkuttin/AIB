/**
 * Which repository a project is (sync between PCs, slice V3): the normalized git remote and the project's place inside the repo.
 * Two PCs call two clones "the same project" only when both match. `readRepoIdentity` runs git natively (Windows, Linux, and inside a
 * WSL distro's helper as `git.identity`); the answer carries no folder path, only the remote text and the place in the repo.
 */
import { GIT_TIMEOUT, runGit } from '../worktrees/changes.ts';

export interface RepoIdentity {
  /** The folder is inside a git work tree. */
  git: boolean;
  /** The raw remote URL (origin, else the first remote), or null. Normalize it with normalizeRemote. */
  url: string | null;
  /** The folder's path inside the repository ('' at the top, else 'sub/dir'). */
  prefix: string;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();

/** The identity of a folder on this machine (git runs here). A folder that is not in a repository answers {git: false}. */
export async function readRepoIdentity(folder: string): Promise<RepoIdentity> {
  const [prefixOut, , prefixCode] = await runGit(['rev-parse', '--show-prefix'], folder, GIT_TIMEOUT, 4096);
  if (prefixCode !== 0) return { git: false, url: null, prefix: '' };
  const prefix = decode(prefixOut).replace(/\/+$/, '');
  let [out, , code] = await runGit(['config', '--get', 'remote.origin.url'], folder, GIT_TIMEOUT, 4096);
  let url = code === 0 ? decode(out) : '';
  if (!url) {
    const [names] = await runGit(['remote'], folder, GIT_TIMEOUT, 4096);
    const first = decode(names).split(/\r?\n/)[0]?.trim();
    if (first && /^[A-Za-z0-9._-]+$/.test(first)) {
      [out, , code] = await runGit(['config', '--get', `remote.${first}.url`], folder, GIT_TIMEOUT, 4096);
      url = code === 0 ? decode(out) : '';
    }
  }
  return { git: true, url: url ? url.slice(0, 500) : null, prefix: prefix.slice(0, 300) };
}

/**
 * `host/owner/repo`, lowercase, the same for the ssh, https and `.git` forms of one remote (user name, port, `.git` and a trailing
 * slash are dropped). null for no remote, a local path or a file:// remote: those say nothing about another PC's clone.
 */
export function normalizeRemote(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  if (!text || text.length > 500 || /^file:/i.test(text)) return null;
  let host = '';
  let path = '';
  const schemed = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d*)?\/(.+)$/i.exec(text);
  if (schemed) {
    host = schemed[2];
    path = schemed[3];
  } else {
    // scp form: [user@]host:path (a Windows drive such as C:\repo is not a host)
    const scp = /^(?:[^@/\\\s]+@)?([^:/\\\s]{2,}):(?!\\)(.+)$/.exec(text);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }
  path = path.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !path || !/^[a-z0-9.-]+$/i.test(host)) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}
