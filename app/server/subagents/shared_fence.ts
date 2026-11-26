/**
 * The project's `aib-shared/` and the subagent fences (owner rule 2026-11-25). That folder lives only in the project's main folder and
 * is linked into every worktree (worktrees/shared_link.ts), so a design or research builder writes its report there. The fences of
 * Codex, Qwen and Antigravity (codex.ts, qwen.ts, antigravity.ts) refuse the main folder by its name and allow only paths inside the
 * subagent's worktree; this module is the one exception they share: a path or a shell command that reaches the project's
 * `<project>/aib-shared/` by its main-folder path passes. Nothing else of the main folder does.
 *
 * Paths are resolved, not just read: the target must have no `.` or `..` part, and its real location (links followed, for the deepest
 * part that exists) must lie inside the real `aib-shared/`, so a second link inside it, or one that replaces it, cannot lead out.
 * (Gemini needs nothing: its redirect already turns a main-folder path into the worktree's, whose `aib-shared` link is inside the
 * allowed folder; gemini.ts relativeInside.) Runs the same in the distro's helper for a WSL chat, with Linux paths.
 */
import { SHARED_DIR } from '../worktrees/shared_link.ts';

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';

/** The main folder's shared folder of `project` (its `aib-shared`); '' for no project. */
export function sharedFolderOf(project: string): string {
  if (!project) return '';
  return project.replace(/[\\/]+$/, '') + SEP + SHARED_DIR;
}

/** Separators as `\`, doubled ones single, lowercased on Windows. */
function canon(text: string): string {
  const t = text.replaceAll('/', '\\').replace(/\\{2,}/g, '\\').replace(/^\\\\\?\\/, '');
  return WIN ? t.toLowerCase() : t;
}

/** `path` with its links followed as far as it exists, the rest appended as written. */
function realOf(path: string): string | null {
  const rest: string[] = [];
  let here = path.replace(/[\\/]+$/, '');
  for (let i = 0; i < 64; i++) {
    try {
      const real = Deno.realPathSync(here);
      return rest.length ? real.replace(/[\\/]+$/, '') + SEP + rest.reverse().join(SEP) : real;
    } catch {
      const cut = Math.max(here.lastIndexOf('/'), here.lastIndexOf('\\'));
      if (cut <= 0) return null;
      rest.push(here.slice(cut + 1));
      here = here.slice(0, cut);
    }
  }
  return null;
}

/**
 * `path` is an absolute path inside the shared folder `shared` (a `sharedFolderOf` result; `orIsIt`: the folder itself counts): no `.`
 * or `..` part, written inside it, and really inside the real folder once links are followed.
 */
export function inSharedFolder(path: string, shared: string, orIsIt = false): boolean {
  if (!shared || !path || path.includes('\0') || !/^([A-Za-z]:[\\/]|\/)/.test(path)) return false;
  if (path.split(/[\\/]/).some((part) => part === '.' || part === '..')) return false;
  const base = canon(shared).replace(/\\+$/, '');
  const here = canon(path).replace(/\\+$/, '');
  if (!(here.startsWith(base + '\\') || (orIsIt && here === base))) return false;
  const realBase = realOf(shared), realPath = realOf(path);
  if (!realBase || !realPath) return false;
  const rb = canon(realBase).replace(/\\+$/, ''), rp = canon(realPath).replace(/\\+$/, '');
  return rp.startsWith(rb + '\\') || (orIsIt && rp === rb);
}

const NAME_CHAR = /[A-Za-z0-9_.-]/;

/**
 * `text` (a command in `canon` form) with every path into one of the `shared` folders replaced by a NUL, so the main-folder check
 * does not see it. A path is the folder and what follows it up to a space, quote or shell operator; it is kept (so the check still
 * refuses it) when it has a `..` part, a variable or substitution, or really leads outside the shared folder.
 */
export function maskShared(text: string, shared: string[]): string {
  for (const s of shared.filter((f) => !!f)) {
    const f = canon(s).replace(/\\+$/, '');
    const forms = [f];
    const drive = /^([a-z]):\\(.*)$/i.exec(f);
    if (drive) forms.push(`\\${drive[1]}\\${drive[2]}`); // /c/Users/... in Git Bash
    for (const form of forms) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(form, from);
        if (at < 0) break;
        const after = at + form.length;
        const next = text[after] ?? '';
        from = at + 1;
        if (next !== '' && next !== '\\' && NAME_CHAR.test(next)) continue; // aib-shared-old, aib-shared.bak
        let end = after;
        while (end < text.length && !/[\s"'`;|&<>()]/.test(text[end])) end++;
        const token = text.slice(at, end);
        if (/[$%`]/.test(token) || token.split('\\').some((p) => p === '..' || p === '.')) continue;
        // the path as the OS reads it: Git Bash's \c\... is C:\..., and on Linux the separators are slashes again
        let real = token;
        if (form !== f && WIN) real = `${drive![1]}:${token.slice(2)}`;
        if (!WIN) real = token.replaceAll('\\', '/');
        if (!inSharedFolder(real.replace(/[\\/]+$/, '') || real, s, true)) continue;
        text = text.slice(0, at) + '\u0000' + text.slice(end);
        from = at + 1;
      }
    }
  }
  return text;
}
