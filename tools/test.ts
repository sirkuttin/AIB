/**
 * Runs the Deno test files (work/deno/*_test.ts) in parallel: each file in its own `deno test` process, several at a time,
 * longest first. A file runs exactly as `deno test -A <file>` would run it alone, so files cannot see each other's
 * environment variables or working folder (in-process `deno test --parallel` would share them: several files set
 * AGENT_STUDIO_STATE_DIR and friends). With --affected it runs only the tests that cover your changes, in every suite.
 *
 * `deno run -A tools/test.ts --help` prints the usage (HELP below).
 *
 * A file that fails in the pool is run once more on its own afterwards (--no-rerun turns this off). A few tests wait on real
 * processes and sockets and can miss a deadline when every core is busy; such a file passing alone is listed as
 * "timing-sensitive" in the summary (look at it, it is a latent race), and a file failing alone too fails the run.
 */
import { affected, type Affected, buildGraph, changedFiles, defaultBase, ROOT, why } from './affected.ts';

const HERE = new URL('.', import.meta.url);
const TESTS = new URL('../work/deno/', HERE);
const APP = new URL('../outputs/agent-studio/', HERE);
const native = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');

const HELP = `Usage (from outputs/agent-studio):
  deno task test                every Deno test file: the full suite, for a merge or a release batch
  deno task test:fast           without the slow tier (SLOW in tools/test.ts)
  deno task test:slow           only the slow tier
  deno task test:affected       only the tests that cover what you changed, in every suite (Deno, node page tests, the
                                keeper's Go tests, the Python contract and worktree e2e runs): use this while you build
  deno task test:serial         the old way: one process, one file after another
  deno task test worktree host_ the files whose name contains either word

Options:
  --jobs N        files at once (default: half the cores, at most 8)
  --junit DIR     a JUnit file per test file
  --no-rerun      do not run a failed file again on its own
  --no-log        do not write the log file (see Logs)
  --no-shard      run each file in one process (SHARDS in tools/test.ts splits a few long files into several)
  --help          this text
  -- ARGS         passed on to deno test (deno task test -- --filter "parity")

Affected tests (--affected):
  deno task test:affected                       changes since the base branch: committed, staged, unstaged and untracked
  deno task test:affected --base main           another base (default: of main and the local integration/* branches,
                                                the one this branch has the fewest commits since)
  deno task test:affected server/web/x.ts ...   these files instead (paths from the repo root or from outputs/agent-studio)
  --list          print what would run, and why, without running it
  --why FILE      the chain of imports and mentions by which FILE reaches each test it runs
  --all-slow      also run slow-tier files that only the broad rules reach (see below)
  The map is built from the code on every run (tools/affected.ts): imports and requires, files a test names in a string
  (page files, fixtures, parity modules), the scripts and styles an HTML page loads, and two broad rules: a test that starts
  the whole server depends on all of server/, and a test that drives a headless browser depends on every page file. A slow
  file reached only through a broad rule is listed, not run, unless --all-slow. A change to deno.json, deno.lock,
  package-lock.json or go.mod/go.sum runs everything. Full runs stay for release batches.

Logs:
  Every run writes .test-logs/<YYYYMMDD-HHMMSS>-<suite>.log in the worktree (git-ignored through .git/info/exclude): first
  line "commit <HEAD hash> clean=<yes|no>", then the whole output (each file's own output too), and last a one-line summary.`;

/**
 * The slow tier: git-heavy worktree files, real agent hosts and web servers, and the Python interop runs. Each takes 10 s to
 * 3 min alone (seconds measured on Windows, serial). The fast tier is everything else; together they are the full suite.
 */
export const SLOW: Record<string, number> = {
  'scroll_e2e_test.ts': 250, // 31 chat scrolling scenarios, each a Studio + headless Chrome; known-failing ones ignored
  'layout_e2e_test.ts': 200, // layout audit: scroll containers and resizable panes against size changes, each a Studio + headless Chrome
  'perf_e2e_test.ts': 230, // a long chat streaming for 3 min in headless Chrome: memory, DOM nodes, listeners, CPU, typing
  'worktree_sync_interop_test.ts': 103,
  'worktree_sync_test.ts': 86,
  'worktree_merge_clash_test.ts': 52,
  'agent_host_test.ts': 45,
  'worktree_merge_test.ts': 38,
  'worktrees_test.ts': 33,
  'worktree_from_main_test.ts': 15,
  'artifact_mcp_test.ts': 17,
  'monitor_golden_test.ts': 16,
  'host_proxy_test.ts': 16,
  'drawing_page_test.ts': 15, // a headless Chrome or Edge on the drawing page
  'remote_phone_e2e_test.ts': 30, // phone access: real AIBs with a fake Tailscale CLI, and the phone page in a headless Chrome
  'attention_modes_test.ts': 60, // the attention watcher through the real agent hosts: in-process, the keeper (Go) and a split host
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
/**
 * Long files whose tests do not depend on each other (each builds its own fixture), run as N processes of every N-th test
 * (work/deno/_shard_preload.ts, loaded with --preload; the file is unchanged). Together the shards run each test once.
 */
export const SHARDS: Record<string, number> = {
  'scroll_e2e_test.ts': 4, // 57 scenarios, each its own Lab (Studio + a tab in the shard's one headless Chrome)
  'layout_e2e_test.ts': 3, // 37 scenarios, the same
  'worktree_sync_interop_test.ts': 3,
  'worktree_sync_test.ts': 3,
  'worktree_merge_clash_test.ts': 2,
};
const weight = (file: string) => (SLOW[file] ?? HINT[file] ?? 3) / (SHARDS[file] ?? 1);

/** A pool entry: a file, or one shard of it ("worktree_sync_test.ts [2/3]"). */
type Entry = { file: string; shard?: [number, number] };
const label = (e: Entry) => e.shard ? `${e.file} [${e.shard[0]}/${e.shard[1]}]` : e.file;
const entries = (files: string[], shard: boolean): Entry[] =>
  files.flatMap((file) =>
    shard && SHARDS[file] ? Array.from({ length: SHARDS[file] }, (_, i) => ({ file, shard: [i + 1, SHARDS[file]] as [number, number] })) : [{ file }]
  );

type Result = { file: string; ok: boolean; seconds: number; summary: string; output: string; entry: Entry };

interface Options {
  tier: 'all' | 'fast' | 'slow';
  serial: boolean;
  rerun: boolean;
  jobs: number;
  junit: string;
  filters: string[];
  extra: string[];
  log: boolean;
  help: boolean;
  affected: boolean;
  base: string;
  list: boolean;
  why: string;
  allSlow: boolean;
  shard: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    tier: 'all',
    serial: false,
    rerun: true,
    jobs: 0,
    junit: '',
    filters: [],
    extra: [],
    log: true,
    help: false,
    affected: false,
    base: '',
    list: false,
    why: '',
    allSlow: false,
    shard: true,
  };
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
    else if (arg === '--log') options.log = true;
    else if (arg === '--no-log') options.log = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--affected') options.affected = true;
    else if (arg === '--base') options.base = args[++i];
    else if (arg === '--list') options.list = true;
    else if (arg === '--why') options.why = args[++i];
    else if (arg === '--all-slow') options.allSlow = true;
    else if (arg === '--no-shard') options.shard = false;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg} (--help lists them)`);
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

// ---- the log file --------------------------------------------------------------------------------------------------------

function gitText(args: string[]): string {
  try {
    const r = new Deno.Command('git', { args: ['-C', ROOT, ...args], stdout: 'piped', stderr: 'null' }).outputSync();
    return r.success ? new TextDecoder().decode(r.stdout).trim() : '';
  } catch {
    return '';
  }
}

/** .test-logs/<stamp>-<suite>.log: "commit <hash> clean=<yes|no>", the whole output as it happens, a one-line summary last. */
export class RunLog {
  readonly path: string;
  #file: Deno.FsFile | null = null;
  #enc = new TextEncoder();

  constructor(suite: string, enabled: boolean) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    this.path = `${ROOT}/.test-logs/${stamp}-${suite.replace(/[^\w.-]+/g, '_').slice(0, 60)}.log`;
    if (!enabled) return;
    Deno.mkdirSync(`${ROOT}/.test-logs`, { recursive: true });
    this.#file = Deno.openSync(this.path, { create: true, write: true, truncate: true });
    const clean = gitText(['status', '--porcelain']) === '' ? 'yes' : 'no';
    this.raw(`commit ${gitText(['rev-parse', 'HEAD']) || 'unknown'} clean=${clean}\n`);
  }

  /** To the console and the log. */
  say(text = ''): void {
    console.log(text);
    this.raw(text + '\n');
  }

  /** To the log only (a passing file's own output). */
  raw(text: string): void {
    this.#file?.writeSync(this.#enc.encode(text));
  }

  close(summary: string): void {
    if (!this.#file) return;
    this.raw(`summary: ${summary}\n`);
    this.#file.close();
    this.#file = null;
    console.log(`log: ${this.path}`);
  }
}

// ---- running ---------------------------------------------------------------------------------------------------------------

async function runFile(entry: Entry, extra: string[], junit: string): Promise<Result> {
  const started = performance.now();
  const { file, shard } = entry;
  const args = ['test', '-A', ...extra];
  const env: Record<string, string> = { NO_COLOR: '1' };
  if (shard) {
    args.push(`--preload=${native(new URL('_shard_preload.ts', TESTS))}`);
    env.AIB_TEST_SHARD = `${shard[0]}/${shard[1]}`;
  }
  if (junit) args.push(`--junit-path=${junit}/${file.replace(/\.ts$/, shard ? `.${shard[0]}of${shard[1]}.xml` : '.xml')}`);
  args.push(native(new URL(file, TESTS)));
  const child = new Deno.Command(Deno.execPath(), { args, cwd: native(APP), stdin: 'null', stdout: 'piped', stderr: 'piped', env }).spawn();
  const [status, out, err] = await Promise.all([child.status, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = out + err;
  const summary = output.match(/^(?:ok|FAILED) \| .*$/m)?.[0] ?? `exit code ${status.code}`;
  return { file: label(entry), ok: status.success, seconds: (performance.now() - started) / 1000, summary, output, entry };
}

/** The Deno pool. Returns the summary line and whether every file passed. */
async function runDeno(files: string[], options: Options, log: RunLog, tier: string): Promise<{ ok: boolean; line: string }> {
  const started = performance.now();
  const pool = entries(files, options.shard);
  const sharded = pool.length - files.length;
  log.say(`${files.length} test files (${tier}), ${options.jobs} at a time${sharded ? `; ${pool.filter((e) => e.shard).map((e) => e.file).filter((f, i, a) => a.indexOf(f) === i).join(', ')} in shards` : ''}`);
  // Type-check every file once, in one process, then run each with --no-check: after an edit, the first files in the pool used to
  // check the same server modules side by side (up to 5 s each). Same checks, done once. If it fails, each file checks itself as
  // before, so only the files with the type error fail.
  let extra = options.extra;
  if (!extra.some((a) => /^--(?:no-)?check\b/.test(a))) {
    const t = performance.now();
    const check = await new Deno.Command(Deno.execPath(), {
      args: ['check', ...files.map((f) => native(new URL(f, TESTS)))],
      cwd: native(APP),
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      env: { NO_COLOR: '1' },
    }).output();
    const seconds = ((performance.now() - t) / 1000).toFixed(1);
    if (check.success) {
      extra = ['--no-check', ...extra];
      log.say(`type check: ok in ${seconds} s (each file then runs with --no-check)`);
    } else {
      log.say(`type check failed in ${seconds} s; each file checks itself:\n${new TextDecoder().decode(check.stderr)}`);
    }
  }
  const results: Result[] = [];
  const queue = [...pool];
  const report = (r: Result, alone = '') => {
    log.say(`${r.ok ? 'ok    ' : 'FAILED'} ${r.seconds.toFixed(1).padStart(6)} s  ${r.file}${alone}  ${r.summary.replace(/^(ok|FAILED) \| /, '')}`);
    if (!r.ok) log.say(`\n----- ${r.file}${alone} -----\n${r.output}\n----- end of ${r.file}${alone} -----\n`);
    else log.raw(`----- output of ${r.file} -----\n${r.output}\n----- end of ${r.file} -----\n`);
  };
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const result = await runFile(entry, extra, options.junit);
      results.push(result);
      report(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, pool.length) }, worker));
  const sensitive: string[] = [];
  if (options.rerun) {
    for (const first of results.filter((r) => !r.ok)) {
      log.say(`rerunning ${first.file} on its own`);
      const again = await runFile(first.entry, extra, options.junit);
      report(again, ' (alone)');
      if (again.ok) sensitive.push(first.file);
      results[results.indexOf(first)] = again;
    }
  }
  const failed = results.filter((r) => !r.ok);
  const counts = results.reduce((sum, r) => {
    const n = (word: string) => Number(r.summary.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    return [sum[0] + n('passed'), sum[1] + n('failed'), sum[2] + n('ignored')];
  }, [0, 0, 0]);
  log.say('\nslowest files:');
  for (const r of [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5)) log.say(`  ${r.seconds.toFixed(1).padStart(6)} s  ${r.file}`);
  const line = `${failed.length ? 'FAILED' : 'ok'} | ${files.length} files${sharded ? ` (${pool.length} processes)` : ''} | ${counts[0]} passed | ${counts[1]} failed | ${counts[2]} ignored | ` +
    `${((performance.now() - started) / 1000).toFixed(0)} s`;
  log.say(`\n${line}`);
  for (const file of sensitive) log.say(`  timing-sensitive: ${file} failed in the pool, passed alone`);
  for (const r of failed) log.say(`  failed: ${r.file}`);
  return { ok: !failed.length, line: `deno ${line}` };
}

/** Another suite's command (node, go, python): its output goes to the log; to the console only its tail, or all of it on failure. */
async function runCommand(name: string, cmd: string[], cwd: string, log: RunLog): Promise<{ ok: boolean; line: string }> {
  const started = performance.now();
  log.say(`\n== ${name}: ${cmd.join(' ')}`);
  const out = await new Deno.Command(cmd[0], { args: cmd.slice(1), cwd, stdin: 'null', stdout: 'piped', stderr: 'piped', env: { NO_COLOR: '1' } })
    .output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  if (out.success) {
    log.raw(text.endsWith('\n') ? text : text + '\n');
    for (const l of text.trimEnd().split(/\r?\n/).slice(-6)) console.log(`  ${l}`);
  } else log.say(text);
  const line = `${name} ${out.success ? 'ok' : 'FAILED'} (exit ${out.code}) ${seconds} s`;
  log.say(line);
  return { ok: out.success, line };
}

const python = () => Deno.build.os === 'windows' ? 'python' : 'python3';
const relApp = (f: string) => f.startsWith('outputs/agent-studio/') ? f.slice('outputs/agent-studio/'.length) : f;

/** Repo-relative paths for the files named on the command line (from the repo root, from outputs/agent-studio, or absolute). */
function repoPaths(names: string[]): string[] {
  const root = Deno.realPathSync(ROOT).replaceAll('\\', '/');
  const inRepo = (abs: string) => {
    const a = abs.replaceAll('\\', '/');
    return a.toLowerCase().startsWith(root.toLowerCase() + '/') ? a.slice(root.length + 1) : null;
  };
  return names.map((n) => {
    for (const candidate of [n, `${Deno.cwd()}/${n}`, `${ROOT}/${n}`, `${ROOT}/outputs/agent-studio/${n}`]) {
      try {
        const rel = inRepo(Deno.realPathSync(candidate));
        if (rel) return rel;
      } catch { /* not this one */ }
    }
    return n.replaceAll('\\', '/').replace(/^(?:\.\.\/)+/, ''); // a deleted file: as given, from the repo root
  });
}

function describe(a: Affected, log: RunLog): void {
  log.say(`changed (${a.changed.length})${a.base ? ` since ${a.base}` : ''}:`);
  for (const f of a.changed) log.say(`  ${f}`);
  if (a.everything) log.say('a runner or config file changed: everything runs');
  for (const [kind, tests] of a.run) {
    log.say(`${kind}: ${tests.size} to run`);
    for (const [test, hit] of tests) log.say(`  ${test.split('/').pop()}  <- ${relApp(hit)}`);
  }
  if (a.broadOnly.size) {
    log.say(`slow files reached only through a broad rule (not run; --all-slow runs them):`);
    for (const [test, hit] of a.broadOnly) log.say(`  ${test}  <- ${relApp(hit)}`);
  }
  if (a.uncovered.length) {
    log.say('changed files no test reaches (add a test, or check the map with --why):');
    for (const f of a.uncovered) log.say(`  ${f}`);
  }
  if (!a.run.size) log.say('nothing to run');
}

async function mainAffected(options: Options): Promise<number> {
  const base = options.filters.length ? '' : (options.base || defaultBase());
  const changed = options.filters.length ? repoPaths(options.filters) : changedFiles(base);
  const log = new RunLog('affected', options.log && !options.list && !options.why);
  const a = affected(changed, new Set(Object.keys(SLOW)), base, options.allSlow);
  describe(a, log);
  if (options.why) {
    const graph = buildGraph();
    const target = repoPaths([options.why])[0];
    for (const [, tests] of a.run) {
      for (const test of tests.keys()) {
        if (test === 'keeper') continue;
        const chain = why(graph, test, target);
        if (chain) console.log(`\n${chain.join('\n  -> ')}`);
      }
    }
    return 0;
  }
  if (options.list || !a.run.size) {
    log.close(options.list ? 'listed only' : 'nothing to run');
    return 0;
  }
  const lines: string[] = [];
  let ok = true;
  const deno = a.run.get('deno');
  if (deno) {
    const files = [...deno.keys()].map((f) => f.split('/').pop()!).sort((x, y) => weight(y) - weight(x) || x.localeCompare(y));
    const r = await runDeno(files, options, log, 'affected');
    ok &&= r.ok;
    lines.push(r.line);
  }
  const node = a.run.get('node');
  if (node) {
    const r = await runCommand('node', ['node', '--test', ...node.keys()], ROOT, log);
    ok &&= r.ok;
    lines.push(r.line);
  }
  if (a.run.get('go')) {
    const r = await runCommand('go', ['go', 'test', '-count=1', './...'], `${ROOT}/keeper`, log);
    ok &&= r.ok;
    lines.push(r.line);
  }
  for (const [kind, suite] of [['python-contract', 'contract'], ['python-e2e', 'e2e']] as const) {
    if (!a.run.get(kind)) continue;
    const r = await runCommand(kind, [python(), 'work/run_parallel.py', suite], ROOT, log);
    ok &&= r.ok;
    lines.push(r.line);
  }
  const summary = `${ok ? 'ok' : 'FAILED'} | affected | ${lines.join(' ; ')}`;
  log.say(`\n${summary}`);
  log.close(summary);
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  const options = parseArgs(Deno.args);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.affected) return await mainAffected(options);
  if (options.junit) Deno.mkdirSync(options.junit, { recursive: true });
  const files = testFiles(options.tier, options.filters);
  if (!files.length) {
    console.error('no test files match');
    return 1;
  }
  const suite = `deno-${options.serial ? 'serial' : options.tier}${options.filters.length ? '-' + options.filters.join('-') : ''}`;
  const log = new RunLog(suite, options.log);
  if (options.serial) {
    const started = performance.now();
    const args = ['test', '-A', ...options.extra, ...files.map((f) => native(new URL(f, TESTS)))];
    const out = await new Deno.Command(Deno.execPath(), { args, cwd: native(APP), stdin: 'null', stdout: 'piped', stderr: 'piped' }).spawn();
    const pump = async (stream: ReadableStream<Uint8Array>, to: typeof Deno.stdout) => {
      for await (const chunk of stream) {
        to.writeSync(chunk);
        log.raw(new TextDecoder().decode(chunk));
      }
    };
    await Promise.all([pump(out.stdout, Deno.stdout), pump(out.stderr, Deno.stderr)]);
    const status = await out.status;
    const line = `${status.success ? 'ok' : 'FAILED'} | ${files.length} files in one process | ${((performance.now() - started) / 1000).toFixed(0)} s`;
    log.say(`\n${line}`);
    log.close(line);
    return status.code;
  }
  const r = await runDeno(files, options, log, options.tier);
  log.close(r.line.replace(/^deno /, ''));
  return r.ok ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main());
