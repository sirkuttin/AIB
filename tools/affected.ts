/**
 * Which tests cover which files: the map behind `deno task test:affected`. It is generated from the code on every run (a second or
 * two), so it never goes stale; the only hand-kept parts are EXTRA_EDGES and the UI fallback below.
 *
 * Nodes are tracked files (git ls-files, plus untracked ones). A file depends on:
 *   - what it imports or requires (static and dynamic imports, require(), Python `import x` / `from x import`), resolved to files;
 *   - files it names in a string: page files ('chat.js', '/chat.html'), work/ helpers and fixtures ('combined-fixture/agent.py'),
 *     Python reference modules it calls through the parity bridge (py.call('attachments', ...)), tools ('build.ts');
 *   - for an HTML page: every script and stylesheet its tags load (the node harness loads chat.html's scripts that way);
 *   - EXTRA_EDGES: links no import shows (keeper/client.ts builds the Go keeper; build.ts bundles the whole app).
 * Two edges are BROAD: a test that starts the whole server (names main.ts) depends on everything main.ts imports, and a test that
 * drives a headless browser (_doc_browser.ts, --headless) depends on every page file. Through broad edges almost any change reaches
 * them, so a slow-tier file reached only that way is listed, not run, unless --all-slow is given. Fast files run either way.
 *
 * A test is affected when a changed file is in its dependency closure, or is the test itself.
 */
const HERE = new URL('.', import.meta.url);
export const ROOT = decodeURIComponent(new URL('..', HERE).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const APP = 'outputs/agent-studio';

/** Links that no import shows. */
const EXTRA_EDGES: Record<string, string[]> = {
  'tools/build.ts': [`${APP}/server/main.ts`, 'keeper/', '@ui'], // bundles the server, the keeper and every page file
};

export type Kind = 'deno' | 'node' | 'go' | 'python-e2e' | 'python-contract';
export interface Graph {
  files: Set<string>;
  precise: Map<string, Set<string>>;
  broad: Map<string, Set<string>>;
}

function git(args: string[]): string {
  const r = new Deno.Command('git', { args: ['-C', ROOT, ...args], stdout: 'piped', stderr: 'piped' }).outputSync();
  if (!r.success) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout);
}

const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export function allFiles(): Set<string> {
  return new Set([...lines(git(['ls-files'])), ...lines(git(['ls-files', '--others', '--exclude-standard']))]);
}

function read(file: string): string {
  try {
    return Deno.readTextFileSync(`${ROOT}/${file}`);
  } catch {
    return '';
  }
}

const dirOf = (f: string) => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
function join(dir: string, rel: string): string {
  const parts = (dir ? dir.split('/') : []);
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

/** Page files a browser test may load: the app's root files, its vendor/ and icons/ folders. */
export function isUiFile(f: string): boolean {
  if (!f.startsWith(`${APP}/`)) return false;
  const rest = f.slice(APP.length + 1);
  return (!rest.includes('/') && /\.(?:js|css|html|json|svg|png|ico)$/.test(rest)) || rest.startsWith('vendor/') ||
    rest.startsWith('icons/');
}

export function buildGraph(files = allFiles()): Graph {
  const precise = new Map<string, Set<string>>(), broad = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, from: string, to: string) => {
    if (from === to) return;
    if (!map.has(from)) map.set(from, new Set());
    map.get(from)!.add(to);
  };
  // Name indexes for mentions.
  const byName = new Map<string, string[]>(); // 'chat.js' -> [outputs/agent-studio/chat.js]
  const index = (name: string, file: string) => byName.set(name, [...(byName.get(name) ?? []), file]);
  const pyRef = new Map<string, string>(); // 'attachments' -> work/python-reference/attachments.py
  const workDirs = new Map<string, string>(); // 'combined-fixture' -> 'work/combined-fixture/'
  const ui: string[] = [];
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    if (isUiFile(f)) ui.push(f);
    if (f.startsWith(`${APP}/`) && !f.slice(APP.length + 1).includes('/')) index(base, f);
    if (/^work\/[^/]+$/.test(f)) index(base, f);
    if (/^work\/deno\/_[^/]+\.ts$/.test(f)) index(base, f);
    if (/^tools\/[^/]+\.ts$/.test(f)) index(base, f);
    const m = f.match(/^work\/([^/]+)\//);
    if (m && m[1].endsWith('-fixture')) workDirs.set(m[1], `work/${m[1]}/`); // a fixture folder: named, it is used whole
    // Python modules the parity bridge calls by name (py.call('shims', ...)): the parity shims first, then the reference.
    const py = f.match(/^work\/(?:python-reference|parity)\/([A-Za-z_]\w*)\.py$/);
    if (py && !(pyRef.get(py[1]) ?? '').startsWith('work/parity/')) pyRef.set(py[1], f);
  }
  index('main.ts', `${APP}/server/main.ts`);
  const prefixed = (prefix: string) => [...files].filter((f) => f.startsWith(prefix));

  for (const f of files) {
    if (!/\.(?:ts|js|mjs|py|html|go)$/.test(f) || f.includes('/vendor/') || f.startsWith('node_modules/')) continue;
    const text = read(f);
    if (!text) continue;
    const dir = dirOf(f);
    const resolve = (spec: string): string | null => {
      if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
      const base = spec.startsWith('/') && f.endsWith('.html') ? `${APP}${spec}` : join(dir, spec);
      for (const c of [base, `${base}.js`, `${base}.ts`, `${base}/index.js`]) if (files.has(c)) return c;
      return null;
    };
    if (/\.(?:ts|js|mjs)$/.test(f)) {
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
        const to = resolve(m[1]);
        if (to) add(precise, f, to);
      }
      // require(path.join(APP_DIR, 'stream-ui.js')) and friends are caught as mentions below.
    }
    if (f.endsWith('.py')) {
      for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm)) {
        for (const name of (m[1] ?? m[2]).split(',').map((s) => s.trim().split(/\s+/)[0].split('.')[0])) {
          const sibling = `${dir}/${name}.py`;
          if (files.has(sibling)) add(precise, f, sibling);
          else if (pyRef.has(name)) add(precise, f, pyRef.get(name)!);
          else if (files.has(`work/${name}.py`)) add(precise, f, `work/${name}.py`);
          else if (files.has(`work/contract/${name}.py`)) add(precise, f, `work/contract/${name}.py`);
        }
      }
    }
    if (f.endsWith('.html')) {
      for (const m of text.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"'?#]+)/gi)) {
        const to = resolve(m[1].startsWith('/') ? m[1] : `./${m[1]}`);
        if (to) add(precise, f, to);
      }
    }
    if (f.endsWith('.go')) continue;
    // Mentions: names inside string literals of tests, helpers and tools (not the app's own modules: their imports say it all).
    const isTestSide = (f.startsWith('work/') && !f.startsWith('work/python-reference/')) || f.startsWith('tools/');
    if (!isTestSide) continue;
    const parity = /py\.call|PyParity|python-reference|_parity/.test(text);
    // keeperBinary() builds the Go keeper from keeper/ when no built one is next to the app: only files that call it run it.
    if (/\bkeeperBinary\(/.test(text)) for (const to of prefixed('keeper/')) if (!to.endsWith('_test.go')) add(precise, f, to);
    for (const lit of text.matchAll(/'([^'\n]{1,300})'|"([^"\n]{1,300})"|`([^`]{1,600})`/g)) {
      const s = lit[1] ?? lit[2] ?? lit[3];
      for (const token of s.split(/[^\w.\-]+/)) {
        if (!token) continue;
        if (token === 'main.ts') continue; // starting the whole server: decided below
        for (const to of byName.get(token) ?? []) add(precise, f, to);
        if (workDirs.has(token)) for (const to of prefixed(workDirs.get(token)!)) add(precise, f, to);
        if (parity && pyRef.has(token)) add(precise, f, pyRef.get(token)!);
      }
    }
    // Starts the whole server as a process: names main.ts or uses MAIN, or calls a fixture method that does. _host_fixture.ts itself
    // only defines those, so a test importing it for until() or sleep() is not tied to the whole server.
    const definesOnly = f === 'work/deno/_host_fixture.ts';
    if (!definesOnly && (/['"`/\\]main\.ts\b|\bMAIN\b/.test(text) || /\.(?:startWeb|startHost|runCli|startOn)\(/.test(text))) {
      add(broad, f, `${APP}/server/main.ts`);
    }
    if (/--headless|_doc_browser\.ts/.test(text) || f === 'work/deno/_doc_browser.ts') for (const to of ui) add(broad, f, to);
  }
  for (const [from, tos] of Object.entries(EXTRA_EDGES)) {
    for (const to of tos) {
      if (to === '@ui') for (const u of ui) add(precise, from, u);
      else if (to.endsWith('/')) for (const t of prefixed(to)) if (!t.endsWith('_test.go')) add(precise, from, t);
      else add(precise, from, to);
    }
  }
  return { files, precise, broad };
}

/** Everything `start` depends on. preciseOnly: follow import and mention edges only, not the two broad ones. */
export function closure(graph: Graph, start: string, preciseOnly = false): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const f = stack.pop()!;
    for (const map of preciseOnly ? [graph.precise] : [graph.precise, graph.broad]) {
      for (const to of map.get(f) ?? []) {
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
  }
  return seen;
}

export interface Suite {
  kind: Kind;
  /** Test entry points of this kind, as repo paths. */
  tests: string[];
}

export function suites(files: Set<string>): Suite[] {
  const all = [...files].sort();
  return [
    { kind: 'deno', tests: all.filter((f) => /^work\/deno\/[^/]+_test\.ts$/.test(f)) },
    { kind: 'node', tests: all.filter((f) => /^work\/test_[^/]+\.js$/.test(f)) },
    { kind: 'go', tests: all.filter((f) => /^keeper\/.*_test\.go$/.test(f)) },
    { kind: 'python-e2e', tests: all.filter((f) => f === 'work/test_worktree_e2e.py') },
    { kind: 'python-contract', tests: all.filter((f) => /^work\/contract\/test_[^/]+\.py$/.test(f)) },
  ];
}

/** Files that make every test suspect: what decides the dependency versions every test runs with. */
const EVERYTHING = [/(?:^|\/)deno\.json$/, /(?:^|\/)deno\.lock$/, /^package-lock\.json$/, /^keeper\/go\.(?:mod|sum)$/];

export interface Affected {
  base: string;
  changed: string[];
  /** Per suite: tests to run, with the changed file that reached each (for the report). */
  run: Map<Kind, Map<string, string>>;
  /** Slow-tier Deno files reached only through a broad edge (whole server / every page file). */
  broadOnly: Map<string, string>;
  /** Changed files no test reaches. */
  uncovered: string[];
  everything: boolean;
}

/** The branch this one came from: of main and the local integration/* branches, the one with the fewest commits since. */
export function defaultBase(): string {
  const refs = lines(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/integration/', 'refs/remotes/origin/main']));
  let best = '', fewest = Infinity;
  for (const ref of refs) {
    let n: number;
    try {
      n = Number(git(['rev-list', '--count', `${ref}..HEAD`]).trim());
    } catch {
      continue;
    }
    if (n < fewest || (n === fewest && ref.startsWith('integration/'))) [best, fewest] = [ref, n];
  }
  if (!best) throw new Error('no base branch found (main or integration/*): pass --base REF');
  return best;
}

/** Files changed since the merge base with `base`: committed, staged, unstaged and untracked. */
export function changedFiles(base: string): string[] {
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  return [...new Set([...lines(git(['diff', '--name-only', mergeBase])), ...lines(git(['ls-files', '--others', '--exclude-standard']))])]
    .filter((f) => !f.startsWith('.test-logs/'))
    .sort();
}

export function affected(changed: string[], slow: Set<string>, base = '', allSlow = false): Affected {
  const graph = buildGraph();
  const result: Affected = { base, changed, run: new Map(), broadOnly: new Map(), uncovered: [], everything: false };
  result.everything = changed.some((f) => EVERYTHING.some((r) => r.test(f)));
  const reached = new Set<string>();
  for (const suite of suites(graph.files)) {
    const picked = new Map<string, string>();
    for (const test of suite.tests) {
      const name = test.slice(test.lastIndexOf('/') + 1);
      if (result.everything) {
        picked.set(test, 'a runner or config file changed');
        continue;
      }
      const full = closure(graph, test);
      const hit = changed.find((c) => full.has(c) || (suite.kind === 'go' && c.startsWith('keeper/')));
      if (!hit) continue;
      for (const c of changed) if (full.has(c)) reached.add(c);
      if (suite.kind === 'deno' && slow.has(name) && !allSlow) {
        const exact = closure(graph, test, true);
        const direct = changed.find((c) => exact.has(c));
        if (!direct) {
          result.broadOnly.set(name, hit);
          continue;
        }
        picked.set(test, direct);
        continue;
      }
      picked.set(test, hit);
    }
    if (suite.kind === 'go' && picked.size) {
      // `go test ./...` runs the package as one: one entry stands for it.
      result.run.set('go', new Map([['keeper', [...picked.values()][0]]]));
      for (const c of changed) if (c.startsWith('keeper/')) reached.add(c);
    } else if (picked.size) result.run.set(suite.kind, picked);
  }
  for (const [, hit] of result.broadOnly) reached.add(hit);
  result.uncovered = changed.filter((c) => !reached.has(c) && !result.everything && /\.(?:ts|js|py|go|html|css)$/.test(c));
  return result;
}

/** The chain of edges by which `test` reaches `changed` (for --why), or null. */
export function why(graph: Graph, test: string, changed: string): string[] | null {
  const parent = new Map<string, string>([[test, '']]);
  const queue = [test];
  while (queue.length) {
    const f = queue.shift()!;
    if (f === changed) {
      const path = [f];
      for (let p = parent.get(f)!; p; p = parent.get(p)!) path.unshift(p);
      return path;
    }
    for (const map of [graph.precise, graph.broad]) {
      for (const to of map.get(f) ?? []) {
        if (!parent.has(to)) {
          parent.set(to, f);
          queue.push(to);
        }
      }
    }
  }
  return null;
}
