# Contributing

Thanks for looking. AIB (Agent Integration Bay) is beta software and the first release is in a feature freeze: bug fixes, tests, documentation and small polish are welcome; new features should be discussed in an issue first.

## Layout

- `app/server/` the app: TypeScript on Deno (`main.ts` is the entry point). All OS-specific code lives in `server/platform/`.
- `app/page/*.js, *.css, *.html` the page: plain browser JavaScript and CSS, served as they are.
- `tools/build.ts` builds the desktop app for all six targets.
- `work/` the tests and the fixtures that generate their own data (fake agents, demo data). Python is only for the fake agents and a few end-to-end helpers.

## No build step for the page

The page is plain classic scripts. There is no bundler or transpiler for it. See `docs/FRONTEND.md`.

## Tests

You need Deno 2.9.8, Node.js 20+ and Python 3.10+ (Python only for the tests: the fake agents, the lock helper and the end-to-end suite).

There are four levels besides `test:affected`. Times are for a 24-core Windows machine, `--jobs 3`.

**Affected: while you work. Run this, not a guess at which files matter.**

```text
cd app
deno task test:affected            # only the tests that cover what you changed since your base branch, in every suite
deno task test:affected --list     # what would run, and which changed file pulls each test in
deno task test:affected --why server/web/server.ts   # the chain of imports and mentions from each test to that file
deno task test:affected stream-ui.js server/x.ts      # these files instead of the git diff
```

It reads the changes since your base branch (committed, staged, unstaged and untracked; the base is `main` or the
`integration/*` branch you have the fewest commits since, or `--base REF`) and runs the Deno files, node page tests, keeper Go
tests and Python contract/end-to-end runs that cover them. The map is built from the code every time (`tools/affected.ts`):
imports and requires, files a test names (page files, fixtures, parity modules), the scripts an HTML page loads, and two broad
rules: a test that starts the whole server covers all of `server/`, a browser test covers every page file. A slow file that only
a broad rule reaches is listed, not run (`--all-slow` runs it). A change to `deno.json`, `deno.lock`, `package-lock.json` or
`go.mod` runs everything. `deno run -A tools/test.ts --help` has every option.

**Smoke: after every step (about 2 minutes).**

```text
cd app
deno task test:smoke   # every Deno file that takes under 5 s in the recent logs (about 230 files, ~1,600 tests, ~100 s) + the node page tests (~1,700 tests, ~8 s)
deno task check        # type check
deno task lint
```

The files are chosen from data, not a list: `tools/test.ts` reads per-file seconds from the newest three `.test-logs/*deno-all.log` files (this worktree's, then the main checkout's). With no logs it uses `tools/test-timings.json`, a committed snapshot (refresh it with `deno run -A ../../tools/test.ts --logs DIR --write-timings`), and only then the `SLOW`/`HINT` tables.

**Full: before a merge or a test build (about 30 minutes, ~2,900 tests).**

```text
cd app
deno task test        # every Deno file except the two perf files (~30 min at --jobs 3)
cd ../..
python work/run_parallel.py contract   # HTTP contract tests (~15 s)
python work/run_parallel.py e2e        # worktree end-to-end suite (~2 min)
```

**Pre-release: before a feed build or a release (the full suite plus about 8 minutes).**

```text
cd app
deno task test:prerelease   # the full suite (all three attention modes), then perf_e2e and perf_reading_e2e alone, then test:update-e2e
```

`test:update-e2e` is the real-binary update test with the keeper (`keeper_update_e2e_test.ts`: two deno desktop builds, Windows only, ~2 min). The perf files are long soaks that measure CPU and memory (about 3.5 and 2.5 minutes), so they run alone, on a quiet machine, and only here (name one on the command line to run it: `deno task test perf_e2e`).

`deno task test` runs each file in `work/deno/` in its own `deno test` process, 3 at a time (more has crashed a PC), slowest first (`tools/test.ts`). Files can't see each other's environment variables, the same as when a file runs alone. `deno task test:slow` and `test:fast` split on the `SLOW` list in `tools/test.ts`; a new file is in the fast tier unless you add it there.

- Run some files only: `deno task test worktree host_` (names containing either). Pass options to `deno test` after `--`: `deno task test -- --filter "parity"`.
- `attention_modes_test.ts` runs one of its three host modes (in-process, keeper, split host) per run, in rotation (`.test-logs/attention-rotation.json`); `--attention-all` and `test:prerelease` run all three.
- A file that fails in the pool gets only its failed tests run again (`deno test --filter`), two files at a time. A test that failed in the pool and passed alone is a flake: the summary lists it and `.test-logs/flaky.json` counts it per test. Fix those; do not rerun until green. A test listed in `tools/test-quarantine.json` (file, exact test name or `*`, reason, date) still runs and is reported, but its failure does not fail the run. The list starts empty.
- At the end of every run the runner kills any `AIB-keeper.exe` under `%TEMP%\aib-keeper-*` that this run started and whose parent is gone, with its children, and reports the count in the summary.
- `--jobs N` sets how many files run at once. `--junit DIR` writes a JUnit file per test file. `deno task test:serial` is the old run: one process, every file in turn.
- Every run of `tools/test.ts` (all, fast, slow, smoke, filtered, affected) writes `.test-logs/<YYYYMMDD-HHMMSS>-<suite>.log` in your
  worktree: the first line is `commit <HEAD hash> clean=<yes|no>`, then the whole output (every file's own output too), and a
  one-line summary last. Add `.test-logs/` to `.git/info/exclude`. `--no-log` turns it off.
- `SHARDS` in `tools/test.ts` runs the longest files whose tests are independent (scroll and layout e2e, the worktree sync and clash
  files) as several processes, each with every N-th test (`--no-shard` runs whole files). A browser e2e file starts one headless
  Chrome per process and gives each scenario its own tab and its own AIB (`AIB_LAB_FRESH_BROWSER=1`: one Chrome per scenario).
- `--jobs 12` is faster on an idle 24-core machine, but browser e2e tests then miss deadlines; the default (3) passes.
- Ports: a test never names a port. Everything it starts binds port 0 and the test reads the port back (`work/deno/_ports.ts`);
  `port_guard_test.ts` fails on a fixed or guessed port. Each test gets its own temp data folder.
- When a file fails while others run, only its failed tests run once more on their own (see above). A test that fails alone too fails the run. `--no-rerun` turns the second try off.
- `run_parallel.py e2e` runs one `python -m unittest` process per end-to-end test class, each with its own temp state folder and servers. `--serial` is the plain unittest run (~2 min). The plain `cd work && python -m unittest test_worktree_e2e` still works. The HTTP contract checks (the auth gate, the routes, the artifact origin) are Deno tests: `work/deno/contract_*_test.ts`.

`AIB_SERVER` picks the server the end-to-end tests start (`deno-split` by default, `deno` for in-process). Tests use temporary data folders and fake agents only; they never touch your real data folder or `~/.claude`.

## Lint and formatting

```text
npm run lint      # ESLint on the page
npm run format    # Prettier on the page and its tests (120 columns, single quotes)
```

Deno code follows `deno fmt` settings in `app/deno.json` (140 columns, single quotes).

## Pull requests

Keep a change small and say what you ran. Add or update a test with the change. Do not add dependencies without a reason. By contributing you agree your work is released under the AGPL-3.0, like the rest of the project.
