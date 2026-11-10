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

```text
cd outputs/agent-studio
deno task test        # unit and parity tests
deno task check       # type check
deno task lint
cd ../..
npm install
npm test              # page tests (node --test work/test_*.js)
python -m unittest discover -s work/contract   # HTTP contract tests
cd work && python -m unittest test_worktree_e2e  # worktree end-to-end suite
```

`AIB_SERVER` picks the server the contract and end-to-end tests start (`deno-split` by default, `deno` for in-process, `python` for the reference). Tests use temporary data folders and fake agents only; they never touch your real data folder or `~/.claude`.

## Lint and formatting

```text
npm run lint      # ESLint on the page
npm run format    # Prettier on the page and its tests (120 columns, single quotes)
```

Deno code follows `deno fmt` settings in `outputs/agent-studio/deno.json` (140 columns, single quotes).

## Pull requests

Keep a change small and say what you ran. Add or update a test with the change. Do not add dependencies without a reason. By contributing you agree your work is released under the AGPL-3.0, like the rest of the project.
