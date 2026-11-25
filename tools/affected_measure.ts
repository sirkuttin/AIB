/**
 * How good is `deno task test:affected`? For each recent commit that changed app, keeper or tools code and a few test files, ask
 * the map which tests the code change selects and check that the tests the commit changed along with it are among them (the
 * "miss" rate: a test that changed with the code but would not have been run). Also prints how many tests and how many seconds
 * the selection costs, against the whole suite. Commits that touch more than 6 tests or 30 files are skipped (mass edits).
 *
 *   deno run -A ../tools/affected_measure.ts [COMMITS=300] [--slow-from DIR]   (from app)
 *
 * It uses the map of the current tree for every commit, so a file that no longer exists is skipped. The seconds come from the newest
 * full-run logs (tools/test.ts timingsFromLogs; --slow-from names another .test-logs folder).
 */
import { affected, allFiles, suites } from './affected.ts';
import { timingsFromLogs } from './test.ts';

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const args = Deno.args.filter((a) => !a.startsWith('--'));
const commitsWanted = Number(args[0]) || 300;
const extraDirs = Deno.args.includes('--slow-from') ? [Deno.args[Deno.args.indexOf('--slow-from') + 1]] : [];

const git = (a: string[]) => new TextDecoder().decode(new Deno.Command('git', { args: ['-C', ROOT, ...a], stdout: 'piped' }).outputSync().stdout);
const files = allFiles();
const all = suites(files);
const tests = new Set(all.flatMap((s) => s.tests));
const isTest = (f: string) => tests.has(f) && !f.endsWith('.go');
const codeLike = (f: string) => /^(app\/(server|page)\/|keeper\/|tools\/)/.test(f) && !f.endsWith('_test.go');
const { seconds } = timingsFromLogs([...extraDirs, `${ROOT}/.test-logs`]);
const secs = (t: string) => seconds[t.slice(t.lastIndexOf('/') + 1)] ?? 3;
const slow = new Set(Object.entries(seconds).filter(([, s]) => s >= 5).map(([f]) => f));
const total = [...tests].reduce((n, t) => n + secs(t), 0);

let commits = 0, wanted = 0, found = 0, deferredHits = 0;
const selected: number[] = [], selectedSeconds: number[] = [];
const missed: string[] = [];
for (const h of git(['log', '--no-merges', '-n', String(commitsWanted), '--format=%H']).split('\n').filter(Boolean)) {
  const changedAll = git(['show', '--name-only', '--format=', h]).split('\n').filter(Boolean).filter((f) => files.has(f));
  const code = changedAll.filter((f) => !isTest(f) && codeLike(f));
  const co = changedAll.filter(isTest);
  if (!code.length || !co.length || co.length > 6 || changedAll.length > 30) continue;
  commits++;
  const a = affected(code, slow);
  const run = new Set([...a.run.values()].flatMap((m) => [...m.keys()]));
  selected.push(run.size);
  selectedSeconds.push([...run].reduce((n, t) => n + secs(t), 0));
  for (const t of co) {
    wanted++;
    if (run.has(t)) found++;
    else {
      if (a.broadOnly.has(t.slice(t.lastIndexOf('/') + 1))) deferredHits++;
      missed.push(`${h.slice(0, 8)} ${t} <- ${code.slice(0, 3).join(', ')}`);
    }
  }
}
const q = (xs: number[], p: number) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
console.log(`commits measured: ${commits} of the last ${commitsWanted}`);
console.log(`tests selected: median ${q(selected, 0.5)}, p90 ${q(selected, 0.9)} of ${tests.size}`);
console.log(`test seconds selected (summed): median ${q(selectedSeconds, 0.5).toFixed(0)}, p90 ${q(selectedSeconds, 0.9).toFixed(0)} of ${total.toFixed(0)} for the whole suite`);
console.log(`co-changed tests selected: ${found}/${wanted} (${((100 * found) / Math.max(1, wanted)).toFixed(1)}%); ${deferredHits} of the rest were slow files left to the batch run`);
if (Deno.args.includes('--misses')) console.log(missed.join('\n'));
