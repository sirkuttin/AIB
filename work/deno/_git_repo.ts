/** Temp git repositories for the changes / chat_folders tests (work/test_changes.py make_repo). Needs git on PATH. */
import { which } from '../../outputs/agent-studio/server/platform/pypath.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';

export const HAVE_GIT = which('git') !== null;

/** Run git in `repo` with a fixed identity; throws on failure. Returns stdout. */
export function git(repo: string, ...args: string[]): string {
  const out = new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    cwd: repo,
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  if (out.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout);
}

export const write = (path: string, text: string) => Deno.writeTextFileSync(path, text);
export const writeBytes = (path: string, bytes: number[]) => Deno.writeFileSync(path, new Uint8Array(bytes));

/** A temp folder holding repo/ with mod.txt, gone.txt, old.txt, pic.bin and sub/in.txt committed. */
export class TempRepo {
  readonly root: string;
  readonly repo: string;

  constructor() {
    this.root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'studio-changes-' }));
    this.repo = osp.join(this.root, 'repo');
    Deno.mkdirSync(this.repo);
    git(this.repo, 'init', '-q');
    write(this.p('mod.txt'), 'a\nb\nc\nd\n');
    write(this.p('gone.txt'), '1\n2\n');
    write(this.p('old.txt'), 'keep\nthis\nfile\ncontent\nhere\n');
    writeBytes(this.p('pic.bin'), [0, 1, 2, 3]);
    Deno.mkdirSync(this.p('sub'));
    write(this.p('sub', 'in.txt'), 'x\n');
    git(this.repo, 'add', '-A');
    git(this.repo, 'commit', '-q', '-m', 'base');
  }

  p(...parts: string[]): string {
    return osp.join(this.repo, ...parts);
  }

  [Symbol.dispose](): void {
    try {
      Deno.removeSync(this.root, { recursive: true });
    } catch { /* a git process may still hold a file for a moment on Windows */ }
  }
}
