# Contributing

Thanks for looking. AIB (Agent Integration Bay) is beta software and the first release is in a feature freeze: bug fixes, tests, documentation and small polish are welcome; new features should be discussed in an issue first.

## Layout

- `outputs/agent-studio/server/` the app: TypeScript on Deno (`main.ts` is the entry point). All OS-specific code lives in `server/platform/`.
- `outputs/agent-studio/*.js, *.css, *.html` the page: plain browser JavaScript and CSS, served as they are.
- `tools/build.ts` builds the desktop app for all six targets.
- `work/` the tests and the fixtures that generate their own data (fake agents, demo data). `work/python-reference/` is the original Python server, kept only as the reference the parity and contract tests compare against.

## No build step for the page

The page is plain classic scripts. There is no bundler or transpiler for it. See `outputs/agent-studio/docs/FRONTEND.md`.

## Tests

You need Deno 2.9.8, Node.js 20+ and Python 3.10+ (Python only for the tests: the parity bridge, the contract runner and the fake agents).

There are two tiers. Times are for a 24-core Windows machine.

**Fast: while you work (about 1 minute in all).**

```text
cd outputs/agent-studio
deno task test:fast   # Deno unit and parity tests without the slow files (~40 s, ~860 tests)
deno task check       # type check
deno task lint
cd ../..
npm install
npm test              # page tests (node --test work/test_*.js, ~2 s)
```

**Full: before a merge or a release (about 4 minutes in all).**

```text
cd outputs/agent-studio
deno task test        # every Deno test file (~2.5 min, ~1,000 tests)
deno task test:update-e2e   # the real-binary update test (two deno desktop builds, Windows only, ~1 min)
cd ../..
python work/run_parallel.py contract   # HTTP contract tests (~15 s)
python work/run_parallel.py e2e        # worktree end-to-end suite (~45 s)
```

`deno task test` runs each file in `work/deno/` in its own `deno test` process, up to 8 at a time, longest first (`tools/test.ts`). Files can't see each other's environment variables, the same as when a file runs alone. The slow tier (`deno task test:slow`) is the `SLOW` list in `tools/test.ts`: the git-heavy worktree files, real agent hosts and the long Python interop runs. Everything else is the fast tier. A new test file is in the fast tier unless you add it to `SLOW`. Put it there if it takes more than about 15 s alone.

- Run some files only: `deno task test worktree host_` (names containing either). Pass options to `deno test` after `--`: `deno task test -- --filter "parity"`.
- `--jobs N` sets how many files run at once. `--junit DIR` writes a JUnit file per test file. `deno task test:serial` is the old run: one process, every file in turn (~11 min).
- When a file fails while others run, the runner runs it once more on its own afterwards. If it passes alone, the summary lists it as `timing-sensitive`. That means a real race that only shows under load, so look into it. A file that fails alone too fails the run. `--no-rerun` turns the second try off.
- `run_parallel.py` runs one `python -m unittest` process per contract file or per end-to-end test class, each with its own temp state folder and servers. `test_contract_artifacts` runs after the others because it checks that the artifact origin is on the Studio port + 1. `--serial` is the plain unittest run (contract ~40 s, end-to-end ~2 min). The plain `python -m unittest discover -s work/contract` and `cd work && python -m unittest test_worktree_e2e` still work.

`AIB_SERVER` picks the server the contract and end-to-end tests start (`deno-split` by default, `deno` for in-process, `python` for the reference). Tests use temporary data folders and fake agents only; they never touch your real data folder or `~/.claude`.

## Lint and formatting

```text
npm run lint      # ESLint on the page
npm run format    # Prettier on the page and its tests (120 columns, single quotes)
```

Deno code follows `deno fmt` settings in `outputs/agent-studio/deno.json` (140 columns, single quotes).

## Pull requests

Keep a change small and say what you ran. Add or update a test with the change. Do not add dependencies without a reason. By contributing you agree your work is released under the AGPL-3.0, like the rest of the project.
