/**
 * Runs the Deno test files (work/deno/*_test.ts) in parallel: each file in its own `deno test` process, several at a time,
 * longest first. A file runs exactly as `deno test -A <file>` would run it alone, so files cannot see each other's
 * environment variables or working folder (in-process `deno test --parallel` would share them: several files set
 * AGENT_STUDIO_STATE_DIR and friends).
 *
 * Usage (from outputs/agent-studio, through the tasks in deno.json):
 *   deno task test             every file (the full suite: before a merge or a release)
 *   deno task test:fast        skips the SLOW files below (the builder loop: about a minute)
 *   deno task test:slow        only the SLOW files
 *   deno task test:serial      the old way: one process, one file after another
 * Options: --jobs N (default: half the cores, at most 8), --junit DIR (a JUnit file per test file), name filters
 * (`deno task test worktree host_` runs the files whose name contains either), and anything after `--` goes to deno test.
 *
 * Output: one line per file as it finishes; a failing file's whole output is printed; the slowest files at the end.
 *
 * A file that fails in the pool is run once more on its own afterwards (--no-rerun turns this off). A few tests wait on real
 * processes and sockets and can miss a deadline when every core is busy; such a file passing alone is listed as
 * "timing-sensitive" in the summary (look at it, it is a latent race), and a file failing alone too fails the run.
 */
const HERE = new URL('.', import.meta.url);
const TESTS = new URL('../work/deno/', HERE);
const APP = new URL('../outputs/agent-studio/', HERE);
const native = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');

/**
 * The slow tier: git-heavy worktree files, real agent hosts and web servers, and the Python interop runs. Each takes 10 s to
 * 3 min alone (seconds measured on Windows, serial). The fast tier is everything else; together they are the full suite.
 */
export const SLOW: Record<string, number> = {
  'worktree_sync_interop_test.ts': 103,
  'worktree_sync_test.ts': 86,
  'worktree_merge_clash_test.ts': 52,
  'agent_host_test.ts': 45,
  'worktree_merge_test.ts': 38,
  'worktrees_test.ts': 33,
  'artifact_mcp_test.ts': 17,
  'monitor_golden_test.ts': 16,
  'host_proxy_test.ts': 16,
};
/** Rough serial seconds of the slower fast-tier files, so they start first too. Unlisted files count as 3 s. */
const HINT: Record<string, number> = {
  'connection_parity_test.ts': 14,
  'host_lifecycle_test.ts': 14,
  'host_takeover_test.ts': 14,
  'deploy_test.ts': 12,
  'host_client_test.ts': 11,
  'terminal_test.ts': 14,
  'installer_test.ts': 12,
  'connection_test.ts': 10,
  'updater_test.ts': 10,
  'state_store_parity_test.ts': 9,
  'ownership_probe_test.ts': 8,
  'changes_test.ts': 8,
  'desktop_serve_test.ts': 7,
  'monitor_test.ts': 7,
  'connection_queue_test.ts': 7,
  'migrate_test.ts': 7,
  'chat_folders_test.ts': 6,
  'signin_test.ts': 6,
};
const weight = (file: string) => SLOW[file] ?? HINT[file] ?? 3;

type Result = { file: string; ok: boolean; seconds: number; summary: string; output: string };

function parseArgs(args: string[]) {
  const options = { tier: 'all' as 'all' | 'fast' | 'slow', serial: false, rerun: true, jobs: 0, junit: '', filters: [] as string[], extra: [] as string[] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      options.extra = args.slice(i + 1);
      break;
    } else if (arg === '--fast') options.tier = 'fast';
    else if (arg === '--slow') options.tier = 'slow';
    else if (arg === '--serial') options.serial = true;
    else if (arg === '--no-rerun') options.rerun = false;
    else if (arg === '--jobs') options.jobs = Number(args[++i]);
    else if (arg === '--junit') options.junit = args[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.filters.push(arg);
  }
  if (!options.jobs) options.jobs = Math.min(8, Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)));
  return options;
}

export function testFiles(tier: 'all' | 'fast' | 'slow', filters: string[] = []): string[] {
  const all = [...Deno.readDirSync(TESTS)].filter((e) => e.isFile && e.name.endsWith('_test.ts')).map((e) => e.name).sort();
  return all
    .filter((f) => tier === 'all' || (tier === 'slow') === f in SLOW)
    .filter((f) => !filters.length || filters.some((part) => f.includes(part)))
    .sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
}

async function runFile(file: string, extra: string[], junit: string): Promise<Result> {
  const started = performance.now();
  const args = ['test', '-A', ...extra];
  if (junit) args.push(`--junit-path=${junit}/${file.replace(/\.ts$/, '.xml')}`);
  args.push(native(new URL(file, TESTS)));
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: native(APP),
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    env: { NO_COLOR: '1' },
  }).spawn();
  const [status, out, err] = await Promise.all([child.status, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = out + err;
  const summary = output.match(/^(?:ok|FAILED) \| .*$/m)?.[0] ?? `exit code ${status.code}`;
  return { file, ok: status.success, seconds: (performance.now() - started) / 1000, summary, output };
}

async function main(): Promise<number> {
  const options = parseArgs(Deno.args);
  if (options.junit) Deno.mkdirSync(options.junit, { recursive: true });
  const files = testFiles(options.tier, options.filters);
  if (!files.length) {
    console.error('no test files match');
    return 1;
  }
  const started = performance.now();
  if (options.serial) {
    const args = ['test', '-A', ...options.extra, ...files.map((f) => native(new URL(f, TESTS)))];
    const status = await new Deno.Command(Deno.execPath(), { args, cwd: native(APP), stdin: 'null' }).spawn().status;
    console.log(`\n${files.length} files in one process: ${((performance.now() - started) / 1000).toFixed(0)} s`);
    return status.code;
  }
  console.log(`${files.length} test files (${options.tier}), ${options.jobs} at a time`);
  const results: Result[] = [];
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const result = await runFile(file, options.extra, options.junit);
      results.push(result);
      console.log(`${result.ok ? 'ok    ' : 'FAILED'} ${result.seconds.toFixed(1).padStart(6)} s  ${file}  ${result.summary.replace(/^(ok|FAILED) \| /, '')}`);
      if (!result.ok) console.log(`\n----- ${file} -----\n${result.output}\n----- end of ${file} -----\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, files.length) }, worker));
  const sensitive: string[] = [];
  if (options.rerun) {
    for (const first of results.filter((r) => !r.ok)) {
      console.log(`rerunning ${first.file} on its own`);
      const again = await runFile(first.file, options.extra, options.junit);
      console.log(`${again.ok ? 'ok    ' : 'FAILED'} ${again.seconds.toFixed(1).padStart(6)} s  ${again.file} (alone)  ${again.summary.replace(/^(ok|FAILED) \| /, '')}`);
      if (!again.ok) console.log(`
----- ${again.file} (alone) -----
${again.output}
----- end of ${again.file} -----
`);
      else sensitive.push(first.file);
      results[results.indexOf(first)] = again;
    }
  }
  const failed = results.filter((r) => !r.ok);
  const counts = results.reduce((sum, r) => {
    const n = (word: string) => Number(r.summary.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    return [sum[0] + n('passed'), sum[1] + n('failed'), sum[2] + n('ignored')];
  }, [0, 0, 0]);
  console.log('\nslowest files:');
  for (const r of [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5)) console.log(`  ${r.seconds.toFixed(1).padStart(6)} s  ${r.file}`);
  console.log(
    `\n${failed.length ? 'FAILED' : 'ok'} | ${results.length} files | ${counts[0]} passed | ${counts[1]} failed | ${counts[2]} ignored | ` +
      `${((performance.now() - started) / 1000).toFixed(0)} s`,
  );
  for (const file of sensitive) console.log(`  timing-sensitive: ${file} failed in the pool, passed alone`);
  for (const r of failed) console.log(`  failed: ${r.file}`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main());
