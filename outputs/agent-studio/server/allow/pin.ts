/**
 * Allow rules: the pin of a "runs project code" rule (owner decision 1a). It covers the script text and its pre/post scripts, the
 * project .npmrc, .yarnrc.yml / .yarnrc, the deno.json task and, for git commit, the hooks (.husky, .githooks, the git hooks
 * folder and core.hooksPath). Any change gives another hash, so the next run asks once more. Synchronous, small reads only.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { programName } from './catalogue.ts';

function read(path: string, max = 256 * 1024): string {
  try {
    const info = Deno.statSync(path);
    if (!info.isFile || info.size > max) return info.isFile ? `<big ${info.size} ${info.mtime?.getTime()}>` : '';
    return Deno.readTextFileSync(path);
  } catch {
    return '';
  }
}

function json(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(read(path));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function dirFiles(dir: string, depth = 0): string[] {
  const out: string[] = [];
  try {
    for (const e of Deno.readDirSync(dir)) {
      const full = join(dir, e.name);
      if (e.isFile && !e.name.endsWith('.sample')) out.push(`${e.name}\n${read(full)}`);
      else if (e.isDirectory && depth < 2) out.push(...dirFiles(full, depth + 1).map((x) => `${e.name}/${x}`));
    }
  } catch { /* none */ }
  return out.sort();
}

/** The git folder of a checkout (a worktree's .git is a file naming it) and its common folder. */
function gitDirs(cwd: string): string[] {
  const dot = join(cwd, '.git');
  let dir = dot;
  const text = read(dot);
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (m) dir = m[1].trim();
  const common = read(join(dir, 'commondir')).trim();
  return common ? [dir, join(dir, common)] : [dir];
}

/** What the pin of these rule words covers in this folder, as text (the hash input). */
export function pinText(words: string[], cwd: string): string {
  const name = programName(words[0]);
  const parts: string[] = [];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const pkg = json(join(cwd, 'package.json'));
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, unknown>;
    const script = words[1] === 'run' || words[1] === 'run-script' ? words[2] : words[1] === 't' ? 'test' : words[1];
    for (const key of [`pre${script}`, script, `post${script}`]) parts.push(`${key}=${JSON.stringify(scripts[key] ?? null)}`);
    parts.push(`.npmrc=${read(join(cwd, '.npmrc'))}`, `.yarnrc.yml=${read(join(cwd, '.yarnrc.yml'))}`, `.yarnrc=${read(join(cwd, '.yarnrc'))}`);
    parts.push(`packageManager=${JSON.stringify(pkg.packageManager ?? null)}`);
  } else if (name === 'deno') {
    for (const file of ['deno.json', 'deno.jsonc']) {
      const tasks = json(join(cwd, file)).tasks as Record<string, unknown> | undefined;
      parts.push(`${file}=${JSON.stringify(tasks?.[words[2]] ?? null)}`);
    }
  } else if (name === 'git') {
    parts.push(`husky=${dirFiles(join(cwd, '.husky')).join('\0')}`, `githooks=${dirFiles(join(cwd, '.githooks')).join('\0')}`);
    for (const dir of gitDirs(cwd)) {
      parts.push(`hooks=${dirFiles(join(dir, 'hooks')).join('\0')}`);
      const config = read(join(dir, 'config'));
      parts.push(`hooksPath=${(/^\s*hookspath\s*=.*$/gim.exec(config) ?? [''])[0]}`);
    }
  }
  return parts.join('\n');
}

export function pinHash(words: string[], cwd: string): string {
  return createHash('sha256').update(pinText(words, cwd)).digest('hex').slice(0, 32);
}
