/**
 * Built AIB for the real-binary tests, made once per source and version and shared: by the tests in a run, by later runs, and by
 * other worktrees with the same code. app_update, keeper_update, keeper_quit and remember_ui each built AIB once or twice per run
 * (seven `deno desktop` builds for the four); now a build happens only when its inputs changed.
 *
 * The key is a SHA-256 of every file the build reads (outputs/agent-studio, keeper/, tools/: tracked and untracked, by content),
 * the Deno version and the version string, so an edit anywhere in them builds again. The builds live in %TEMP%/aib-test-builds/<key>
 * (the newest few are kept). The tests only read a build's folder: they unzip it into their own temp folders.
 *
 * Two runs that need the same build at once: the first takes <key>.lock (create-new), builds into a temp folder and renames it into
 * place; the other waits for the folder (up to 20 minutes) and takes over a lock left by a run that died (older than 20 minutes).
 */
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../../outputs/agent-studio/server/core/app.ts';

/** The newer version the update tests build as "B". One string for all of them, so they share that build too. */
export const NEXT_VERSION = '0.1.0-beta.99';

const CACHE = `${Deno.env.get('TEMP') ?? Deno.env.get('TMPDIR') ?? '/tmp'}/aib-test-builds`;
const KEEP = 6;
const LOCK_STALE_MS = 20 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sourceKey(version: string): string {
  const r = new Deno.Command('git', {
    args: ['-C', REPO_ROOT, 'ls-files', '-co', '--exclude-standard', '--', 'outputs/agent-studio', 'keeper', 'tools'],
    stdout: 'piped',
    stderr: 'piped',
  }).outputSync();
  if (!r.success) throw new Error(`git ls-files: ${new TextDecoder().decode(r.stderr)}`);
  const files = new TextDecoder().decode(r.stdout).split(/\r?\n/).filter(Boolean).sort();
  const hash = createHash('sha256');
  hash.update(`deno ${Deno.version.deno}\nversion ${version}\nos ${Deno.build.target}\n`);
  for (const f of files) {
    let data: Uint8Array;
    try {
      data = Deno.readFileSync(`${REPO_ROOT}/${f}`);
    } catch {
      continue; // deleted in the working tree
    }
    hash.update(`${f}\0${data.length}\0`);
    hash.update(data);
  }
  return hash.digest('hex').slice(0, 24);
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function build(out: string, version: string): Promise<void> {
  const args = ['run', '-A', `${REPO_ROOT}/tools/build.ts`, '--targets', 'windows-x64', '--out', out, '--no-smoke'];
  if (version) args.push('--version', version);
  const r = await new Deno.Command(Deno.execPath(), { args, stdout: 'piped', stderr: 'piped' }).output();
  if (!r.success) throw new Error(`build failed: ${new TextDecoder().decode(r.stderr)}`);
}

function prune(): void {
  try {
    const dirs = [...Deno.readDirSync(CACHE)].filter((e) => e.isDirectory && /^[0-9a-f]{24}$/.test(e.name))
      .map((e) => ({ path: `${CACHE}/${e.name}`, at: Deno.statSync(`${CACHE}/${e.name}`).mtime?.getTime() ?? 0 }))
      .sort((a, b) => b.at - a.at);
    for (const d of dirs.slice(KEEP)) Deno.removeSync(d.path, { recursive: true });
  } catch { /* another run prunes too */ }
}

/**
 * The folder with AIB-<version>-windows-x64.zip (and the rest of build.ts's output) for the current source. `version` '' is the
 * source's own APP_VERSION. Reports whether it was built now or reused, and how long it took.
 */
export async function builtDist(version = ''): Promise<string> {
  const started = Date.now();
  const key = sourceKey(version);
  const dir = `${CACHE}/${key}`;
  const lock = `${dir}.lock`;
  Deno.mkdirSync(CACHE, { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;
  while (!exists(dir)) {
    let mine = false;
    try {
      Deno.openSync(lock, { createNew: true, write: true }).close();
      mine = true;
    } catch {
      const age = Date.now() - (Deno.statSync(lock).mtime?.getTime() ?? 0);
      if (age > LOCK_STALE_MS) {
        Deno.removeSync(lock); // a run that died while building
        continue;
      }
    }
    if (mine) {
      const tmp = `${dir}.tmp-${Deno.pid}`;
      try {
        await build(tmp, version);
        Deno.renameSync(tmp, dir);
      } finally {
        try {
          Deno.removeSync(tmp, { recursive: true });
        } catch { /* renamed */ }
        Deno.removeSync(lock);
      }
      console.log(`build ${version || 'APP_VERSION'}: built in ${((Date.now() - started) / 1000).toFixed(0)} s (${dir})`);
      prune();
      return dir;
    }
    if (Date.now() > deadline) throw new Error(`gave up waiting for another run's build of ${dir}`);
    await sleep(1000);
  }
  const now = new Date();
  Deno.utimeSync(dir, now, now); // recently used: kept by prune()
  console.log(`build ${version || 'APP_VERSION'}: reused (${dir})`);
  return dir;
}
