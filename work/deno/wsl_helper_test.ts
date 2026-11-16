/**
 * server/wsl/helper_main.ts and server/wsl/helper/*: the WSL helper's methods run in-process against a temp git repo (the logic is
 * path-agnostic, so it runs on Windows too), its JSON-RPC line handling, the login-environment capture (with a fake shell), the
 * BROWSER shim's URL rules and rate limit, and the start-up checks. Parts that need Linux (open.fifo, the POSIX rules of files.ts
 * safeParts) are ignored elsewhere; wsl_bridge_e2e_test.ts runs the real thing in a distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { git, HAVE_GIT, TempRepo, write } from './_git_repo.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';
import { safeParts } from '../../outputs/agent-studio/server/worktrees/files.ts';
import { safeRelpath } from '../../outputs/agent-studio/server/worktrees/changes.ts';
import {
  agentEnv,
  captureLoginEnv,
  cleanPath,
  ENV_MARK,
  loginShell,
  parseEnvDump,
} from '../../outputs/agent-studio/server/wsl/helper/env.ts';
import {
  BAD_PARAMS,
  handleLine,
  lineWriter,
  MAX_LINE,
  NO_METHOD,
  PARSE_ERROR,
  serveLines,
} from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import {
  checkUrl,
  LineSplitter,
  MAX_URL_BYTES,
  RateLimit,
  serveOpenFifo,
  shimScript,
  takeLine,
} from '../../outputs/agent-studio/server/wsl/helper/browser.ts';
import { encodeBase64, makeMethods } from '../../outputs/agent-studio/server/wsl/helper/methods.ts';
import { cleanOldVersions, refusal, wslRoot } from '../../outputs/agent-studio/server/wsl/helper_main.ts';
import type { HelperMethods } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { helperCompileArgs, modeFor, TARGETS, WSL_HELPER_ENTRY, wslTarget } from '../../tools/build.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const WIN = Deno.build.os === 'windows';

const methods = makeMethods({
  env: () =>
    Promise.resolve({
      env: Deno.env.toObject(),
      shell: '/bin/sh',
      home: osp.home(),
      arch: 'amd64',
    }),
});
async function call<M extends keyof HelperMethods>(
  method: M,
  params: HelperMethods[M]['params'] | Record<string, unknown>,
) {
  const reply = await handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    methods,
  );
  return reply as {
    result?: HelperMethods[M]['result'] & Record<string, unknown>;
    error?: { code: number; message: string; data?: { code?: string } };
  };
}
const gitTest = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HAVE_GIT, fn });

// ---- login environment ------------------------------------------------------------------------------------------------------

Deno.test('the env dump is read after the last mark, NUL-separated, with values that hold newlines', () => {
  const dump = enc(
    `motd noise${ENV_MARK}junk${ENV_MARK}PATH=/usr/bin:/mnt/c/Windows\0MULTI=a\nb\0_=/usr/bin/env\0SHLVL=2\0bad key=x\0`,
  );
  assertEquals(parseEnvDump(dump), {
    PATH: '/usr/bin:/mnt/c/Windows',
    MULTI: 'a\nb',
  });
  assertEquals(parseEnvDump(enc('PATH=/bin\0')), null);
});

Deno.test('PATH loses every /mnt folder, empties and repeats; agents get BROWSER and AIB_OPEN_FIFO', () => {
  assertEquals(
    cleanPath(
      '/home/u/.nvm/bin::/usr/bin:/mnt/c/Windows/system32:/usr/bin:/mnt:/mntx/ok',
    ),
    '/home/u/.nvm/bin:/usr/bin:/mntx/ok',
  );
  const env = agentEnv({ PATH: '/mnt/c/x:/bin', HOME: '/home/u' }, {
    browser: '/r/v/aib-open',
    openFifo: '/r/d/helper/open.fifo',
  });
  assertEquals(env, {
    PATH: '/bin',
    HOME: '/home/u',
    BROWSER: '/r/v/aib-open',
    AIB_OPEN_FIFO: '/r/d/helper/open.fifo',
  });
  assertEquals(
    agentEnv({ PATH: '/mnt/c/only' }).PATH,
    '/usr/local/bin:/usr/bin:/bin',
  );
});

Deno.test('the login shell is $SHELL, else the passwd entry of this uid, else /bin/sh', () => {
  const passwd = 'root:x:0:0:root:/root:/bin/bash\nkirk:x:1000:1000:,,,:/home/kirk:/usr/bin/zsh\n';
  assertEquals(loginShell({ SHELL: '/bin/fish' }, passwd, 1000), '/bin/fish');
  assertEquals(loginShell({ SHELL: 'zsh' }, passwd, 1000), '/usr/bin/zsh');
  assertEquals(loginShell({}, passwd, 4242), '/bin/sh');
});

Deno.test('capture runs -lic, then -lc, then falls back to the own environment; the shell starts from a clean environment', async () => {
  const seen: [string, string[], Record<string, string>][] = [];
  const dump = enc(`${ENV_MARK}PATH=/home/u/bin:/usr/bin\0HOME=/home/u\0`);
  const got = await captureLoginEnv(
    '/bin/zsh',
    { HOME: '/home/u', USER: 'u', PATH: '/mnt/c/win', WINDOWS_THING: 'x' },
    (shell, args, env) => {
      seen.push([shell, args, env]);
      return Promise.resolve(args[0] === '-lic' ? null : dump);
    },
  );
  assertEquals(got, {
    env: { PATH: '/home/u/bin:/usr/bin', HOME: '/home/u' },
    shell: '/bin/zsh',
    how: '-lc',
  });
  assertEquals(seen.map((s) => s[1][0]), ['-lic', '-lc']);
  assertEquals(seen[0][2], {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TERM: 'dumb',
    SHELL: '/bin/zsh',
    HOME: '/home/u',
    USER: 'u',
  });
  assert(seen[0][1][1].includes('env -0'));
  const none = await captureLoginEnv(
    '/bin/sh',
    { HOME: '/h', SHLVL: '3' },
    () => Promise.resolve(enc('no mark')),
  );
  assertEquals(none, { env: { HOME: '/h' }, shell: '/bin/sh', how: 'none' });
});

// ---- JSON-RPC lines ---------------------------------------------------------------------------------------------------------

Deno.test('requests are answered; bad JSON, unknown methods and bad params get JSON-RPC errors; notifications get nothing', async () => {
  const h = {
    echo: (p: Record<string, unknown>) => p,
    boom: () =>
      Promise.reject(
        Object.assign(new Error('nope'), { code: 'bad_path', status: 400 }),
      ),
  };
  assertEquals(
    await handleLine(
      '{"jsonrpc":"2.0","id":7,"method":"echo","params":{"a":1}}',
      h,
    ),
    {
      jsonrpc: '2.0',
      id: 7,
      result: { a: 1 },
    },
  );
  assertEquals((await handleLine('{not json', h))?.error, {
    code: PARSE_ERROR,
    message: 'Not JSON',
  });
  assertEquals(
    ((await handleLine('{"id":1,"method":"nope"}', h))?.error as {
      code: number;
    }).code,
    NO_METHOD,
  );
  assertEquals(
    ((await handleLine('{"id":1,"method":"echo","params":[1]}', h))?.error as {
      code: number;
    }).code,
    BAD_PARAMS,
  );
  assertEquals((await handleLine('{"id":"x","method":"boom"}', h))?.error, {
    code: -32000,
    message: 'nope',
    data: { code: 'bad_path', status: 400 },
  });
  assertEquals(await handleLine('{"method":"echo"}', h), null);
  assertEquals(
    ((await handleLine('{"id":1,"method":"__proto__"}', h))?.error as {
      code: number;
    }).code,
    NO_METHOD,
  );
});

Deno.test('serveLines handles split chunks and concurrent requests, drops an over-long line and ends with its input', async () => {
  const out: Record<string, unknown>[] = [];
  const send = lineWriter((bytes) => {
    out.push(JSON.parse(new TextDecoder().decode(bytes)));
    return Promise.resolve();
  });
  const slow = () => new Promise((r) => setTimeout(() => r('slow'), 50));
  const chunks = [
    '{"id":1,"method":"slow"}\n{"id":2,',
    '"method":"fast"}\n',
    'x'.repeat(MAX_LINE + 10),
    'tail}\n{"id":3,"method":"fast"}',
  ];
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc(chunk));
      c.close();
    },
  });
  await serveLines(input, send, { slow, fast: () => 'fast' });
  assertEquals(out.map((m) => m.id).slice(-1), [1]); // the slow one does not hold up the others
  assertEquals(out.map((m) => String(m.id)).sort(), ['1', '2', '3', 'null']);
  assertEquals(
    (out.find((m) => m.id === null)!.error as { message: string }).message,
    'Line too long',
  );
});

// ---- the BROWSER shim -------------------------------------------------------------------------------------------------------

Deno.test('only http and https links of at most 2048 bytes are passed on', () => {
  assertEquals(checkUrl('  https://claude.ai/oauth?code=1  '), {
    url: 'https://claude.ai/oauth?code=1',
  });
  assertEquals(checkUrl('http://localhost:54545/callback'), {
    url: 'http://localhost:54545/callback',
  });
  for (
    const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://x',
      '',
      'https://a\u0007b',
      'nothing',
      'xhttps://a',
    ]
  ) {
    assert('refused' in checkUrl(bad), bad);
  }
  assert('url' in checkUrl('https://x/' + 'a'.repeat(2038)));
  assert('refused' in checkUrl('https://x/' + 'a'.repeat(2039)));
});

Deno.test('at most 3 links a minute', () => {
  let t = 0;
  const limit = new RateLimit(3, 60_000, () => t);
  assertEquals([limit.take(), limit.take(), limit.take(), limit.take()], [
    true,
    true,
    true,
    false,
  ]);
  t = 60_001;
  assert(limit.take());
});

Deno.test('FIFO lines: one URL a line, an over-long line dropped whole, the fourth link in a minute refused', () => {
  const lines = new LineSplitter();
  assertEquals(lines.push(enc('https://a/1\nhttps://a/')), ['https://a/1']);
  assertEquals(lines.push(enc('2\n' + 'x'.repeat(3000))), ['https://a/2']);
  assertEquals(lines.push(enc('still the long one\nhttps://a/3\n')), [
    'https://a/3',
  ]);
  const limit = new RateLimit(3, 60_000, () => 0);
  const taken = [
    'https://a/1',
    'file:///etc/passwd',
    'https://a/2',
    'https://a/3',
    'https://a/4',
  ].map((l) => takeLine(l, limit));
  assertEquals(taken.map((r) => ('url' in r ? 'ok' : r.refused)), [
    'ok',
    'file: links are not opened',
    'ok',
    'ok',
    'more than 3 links a minute',
  ]);
});

Deno.test('the aib-open script writes to AIB_OPEN_FIFO opened read-write and refuses what is not a web link', () => {
  const text = shimScript();
  assert(text.startsWith('#!/bin/sh\n'));
  assert(
    text.includes('exec 3<>"$f"'),
    'opened read-write: never blocks when no helper reads',
  );
  assert(
    text.includes('http://*|https://*)') &&
      text.includes(`-gt ${MAX_URL_BYTES}`),
  );
});

Deno.test({
  name: 'open.fifo is 0600 in a 0700 folder; the script hands https links on and refuses file:',
  ignore: WIN,
  fn: async () => {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-open-' });
    const got: string[] = [];
    const fifo = await serveOpenFifo(`${dir}/helper`, (url) => got.push(url));
    const shim = `${dir}/aib-open`;
    Deno.writeTextFileSync(shim, shimScript(), { mode: 0o755 });
    const run = (url: string) =>
      new Deno.Command('/bin/sh', {
        args: [shim, url],
        env: { AIB_OPEN_FIFO: fifo.path },
        stderr: 'piped',
      }).output();
    try {
      assertEquals((Deno.statSync(`${dir}/helper`).mode ?? 0) & 0o777, 0o700);
      assertEquals((Deno.statSync(fifo.path).mode ?? 0) & 0o777, 0o600);
      assertEquals((await run('https://example.com/a')).code, 0);
      const refused = await run('file:///etc/passwd');
      assert(
        refused.code === 1 &&
          new TextDecoder().decode(refused.stderr).includes('refused'),
      );
      for (let i = 0; i < 50 && !got.length; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(got, ['https://example.com/a']);
    } finally {
      fifo.close();
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

// ---- start-up checks --------------------------------------------------------------------------------------------------------

Deno.test('the AIB folder is AIB_WSL_ROOT (absolute) or ~/.aib-server; musl is refused', () => {
  assertEquals(wslRoot({ HOME: '/home/u' }), '/home/u/.aib-server');
  assertEquals(
    wslRoot({ HOME: '/home/u', AIB_WSL_ROOT: '/tmp/aib-wsl-test-x/' }),
    '/tmp/aib-wsl-test-x',
  );
  assertEquals(
    wslRoot({ HOME: '/home/u', AIB_WSL_ROOT: 'relative' }),
    '/home/u/.aib-server',
  );
  assert(refusal('/nowhere', null, () => true).startsWith('musl: '));
  assertEquals(refusal('/nowhere', null, () => false), '');
});

Deno.test({
  name: 'a group- or world-writable AIB folder is refused',
  ignore: WIN,
  fn: () => {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-perms-' });
    try {
      Deno.chmodSync(dir, 0o700);
      assertEquals(refusal(dir, null, () => false), '');
      Deno.chmodSync(dir, 0o770);
      assert(refusal(dir, null, () => false).startsWith('perms: '));
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test('older <ver> folders go unless a running program comes from them; data and other folders stay', async () => {
  const root = Deno.makeTempDirSync({ prefix: 'aib-wsl-root-' }).replaceAll(
    '\\',
    '/',
  );
  try {
    for (
      const n of [
        '0.9.0-beta.3-0123abcd',
        '0.9.1-89abcdef',
        '1.0.0-deadbeef',
        'data-0123456789ab',
        'notes',
      ]
    ) {
      Deno.mkdirSync(`${root}/${n}`);
    }
    const self = `${root}/1.0.0-deadbeef/AIB-wsl-helper`;
    // /proc unreadable, or the list does not even hold the helper itself: nothing goes
    assertEquals(
      await cleanOldVersions(
        root,
        '1.0.0-deadbeef',
        self,
        () => Promise.resolve(null),
      ),
      [],
    );
    assertEquals(
      await cleanOldVersions(
        root,
        '1.0.0-deadbeef',
        self,
        () => Promise.resolve(['/usr/bin/zsh']),
      ),
      [],
    );
    const running = [self, `${root}/0.9.1-89abcdef/AIB-keeper`, '/usr/bin/zsh'];
    const removed = await cleanOldVersions(
      root,
      '1.0.0-deadbeef',
      self,
      () => Promise.resolve(running),
    );
    assertEquals(removed, ['0.9.0-beta.3-0123abcd']);
    assertEquals([...Deno.readDirSync(root)].map((e) => e.name).sort(), [
      '0.9.1-89abcdef',
      '1.0.0-deadbeef',
      'data-0123456789ab',
      'notes',
    ]);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

// ---- path rules: Windows unchanged, POSIX relaxed ---------------------------------------------------------------------------

Deno.test('Windows path rules are unchanged; on POSIX a backslash and a colon are name characters', () => {
  if (WIN) {
    assertEquals(safeParts('a\\b/c'), ['a', 'b', 'c']);
    for (const bad of ['C:/x', 'a/b:c', '\\\\srv\\share', '/abs', 'a/../b']) {
      let threw = false;
      try {
        safeParts(bad);
      } catch {
        threw = true;
      }
      assert(threw, bad);
    }
    assertEquals([
      safeRelpath('a\\b'),
      safeRelpath('c:x/y'),
      safeRelpath('a/b:c'),
      safeRelpath('a/b'),
    ], [false, false, true, true]);
  } else {
    assertEquals(safeParts('a\\b/c:d'), ['a\\b', 'c:d']);
    assertEquals([
      safeRelpath('a\\b'),
      safeRelpath('a/b:c'),
      safeRelpath('/a'),
      safeRelpath('a/../b'),
    ], [true, true, false, false]);
  }
  let hidden = '';
  try {
    safeParts('x/.git/config');
  } catch (e) {
    hidden = (e as { code: string }).code;
  }
  assertEquals(hidden, 'hidden');
});

// ---- methods ----------------------------------------------------------------------------------------------------------------

Deno.test('the ready line can list every method of the contract', () => {
  const names: (keyof HelperMethods)[] = [
    'env.get',
    'which',
    'agents.detect',
    'fs.stat',
    'fs.listDirs',
    'folder.check',
    'git.init',
    'files.list',
    'files.search',
    'files.read',
    'files.readBytes',
    'files.gitInfo',
    'files.outside',
    'codex.limits',
    'project.inspect',
    'project.trash',
    'folder.project',
    'folder.createProject',
    'changes.get',
    'changes.diff',
    'changes.branchEntries',
    'chat.repoBranch',
    'transcripts.sessions',
    'transcripts.read',
    'transcripts.mentions',
    'docs.fs',
    'transcripts.query',
    'ownership.check',
    'ownership.hints',
    'proc.tree',
    'env.prereqs',
    'agents.signinStatus',
    'localOnly.ensure',
    'localOnly.chat',
    'localOnly.list',
    'localOnly.search',
    'localOnly.read',
    'localOnly.exclude',
    'localOnly.moveStrays',
    'localOnly.backup',
  ];
  assertEquals(Object.keys(methods).sort(), [...names].sort());
});

gitTest(
  'files.list, search, read and gitInfo answer what files.ts answers; reads are base64 and capped',
  async () => {
    using r = new TempRepo();
    write(r.p('new.txt'), 'hello\n');
    write(r.p('mod.txt'), 'a\nB\nc\nd\n');
    const list = (await call('files.list', { root: r.repo })).result!;
    const names = (list.entries as { name: string; status: string }[]).map((
      e,
    ) => `${e.name}:${e.status}`);
    assertEquals(names, [
      'sub:',
      'gone.txt:',
      'mod.txt:M',
      'new.txt:U',
      'old.txt:',
      'pic.bin:',
    ]);
    const page = (await call('files.list', { root: r.repo, offset: 1, limit: 2 })).result!;
    assertEquals([
      (page.entries as { name: string }[]).map((e) => e.name),
      page.truncated,
    ], [['gone.txt', 'mod.txt'], true]);
    const sub = (await call('files.list', { root: r.repo, rel: 'sub' }))
      .result!;
    assertEquals((sub.entries as { path: string }[]).map((e) => e.path), [
      'sub/in.txt',
    ]);
    const found = (await call('files.search', { root: r.repo, query: 'in' }))
      .result!;
    assertEquals((found.matches as { path: string }[])[0].path, 'sub/in.txt');
    const read = (await call('files.read', { root: r.repo, rel: 'pic.bin' }))
      .result!;
    assertEquals([read.bytesB64, read.size, read.truncated, read.path], [
      encodeBase64(new Uint8Array([0, 1, 2, 3])),
      4,
      false,
      'pic.bin',
    ]);
    const cut = (await call('files.read', { root: r.repo, rel: 'old.txt', maxBytes: 4 }))
      .result!;
    assertEquals([atob(cut.bytesB64), cut.size, cut.truncated], [
      'keep',
      28,
      true,
    ]);
    const outside = await call('files.read', {
      root: r.repo,
      rel: '../outside.txt',
    });
    assertEquals(outside.error?.data?.code, 'bad_path');
    assertEquals(
      (await call('files.read', { root: r.repo, rel: '.git/config' })).error
        ?.data?.code,
      'hidden',
    );
    assertEquals(
      (await call('files.read', { root: 'relative/root', rel: 'x' })).error
        ?.code,
      BAD_PARAMS,
    );
    const info = (await call('files.gitInfo', { root: r.p('sub') })).result!;
    assertEquals([osp.normcase(info.top as string), info.prefix], [
      osp.normcase(r.repo),
      'sub/',
    ]);
  },
);

gitTest(
  'changes.get, diff, branchEntries and chat.repoBranch answer what changes.ts answers',
  async () => {
    using r = new TempRepo();
    const base = git(r.repo, 'rev-parse', 'HEAD').trim();
    write(r.p('mod.txt'), 'a\nB\nc\nd\n');
    write(r.p('new.txt'), 'one\ntwo\n');
    const changes = (await call('changes.get', { folder: r.repo })).result!;
    assertEquals(
      (changes.files as { path: string; status: string }[]).map((f) => `${f.status} ${f.path}`),
      ['M mod.txt', 'U new.txt'],
    );
    assertEquals(changes.scope, 'uncommitted');
    const diff = (await call('changes.diff', { folder: r.repo, path: 'mod.txt' })).result!;
    assertEquals([diff.added, diff.removed, diff.status], [1, 1, 'M']);
    assertEquals(
      (await call('changes.diff', { folder: r.repo, path: 'old.txt' })).error
        ?.data?.code,
      'not_changed',
    );
    git(r.repo, 'add', '-A');
    git(
      r.repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '-m',
      'two',
    );
    write(r.p('later.txt'), 'x\n');
    const branch = (await call('changes.get', { folder: r.repo, base }))
      .result!;
    assertEquals([
      branch.scope,
      (branch.files as { path: string }[]).map((f) => f.path),
    ], ['branch', ['later.txt', 'mod.txt', 'new.txt']]);
    const entries = (await call('changes.branchEntries', { folder: r.repo, base })).result!;
    assertEquals(entries.entries, [['U', 'later.txt', '', true], [
      'M',
      'mod.txt',
      '',
      false,
    ], ['A', 'new.txt', '', false]]);
    assertEquals([entries.git, entries.base, entries.cut], [true, base, false]);
    const head = (await call('changes.branchEntries', { folder: r.repo }))
      .result!;
    assertEquals([head.base, head.entries], ['HEAD', [[
      'U',
      'later.txt',
      '',
      true,
    ]]]);
    const rb = (await call('chat.repoBranch', { folder: r.p('sub') })).result!;
    assertEquals([osp.normcase(rb.repo!), rb.branch], [
      osp.normcase(r.repo),
      git(r.repo, 'branch', '--show-current').trim(),
    ]);
    const none = Deno.makeTempDirSync({ prefix: 'aib-wsl-nogit-' });
    try {
      assertEquals((await call('changes.get', { folder: none })).result, {
        git: false,
      });
      assertEquals((await call('chat.repoBranch', { folder: none })).result, {
        repo: null,
        branch: null,
      });
    } finally {
      Deno.removeSync(none, { recursive: true });
    }
  },
);

gitTest(
  'fs.stat, fs.listDirs, folder.check and git.init for the folder browser and New project',
  async () => {
    using r = new TempRepo();
    const st = (await call('fs.stat', { path: r.p('mod.txt') })).result!;
    assertEquals([st.exists, st.isFile, st.isDir, st.size], [
      true,
      true,
      false,
      8,
    ]);
    assertEquals((await call('fs.stat', { path: r.p('missing') })).result, {
      exists: false,
      isDir: false,
      isFile: false,
      size: 0,
      mtimeMs: 0,
    });
    Deno.mkdirSync(osp.join(r.root, 'plain'));
    const dirs = (await call('fs.listDirs', { path: r.root })).result!;
    assertEquals(dirs.dirs, [{ name: 'plain', isGit: false }, {
      name: 'repo',
      isGit: true,
    }]);
    assertEquals([dirs.truncated, osp.normcase(dirs.parent!)], [
      false,
      osp.normcase(osp.dirname(r.root)),
    ]);
    assertEquals(
      (await call('fs.listDirs', { path: r.root, limit: 1 })).result!.truncated,
      true,
    );
    assertEquals(
      (await call('fs.listDirs', { path: r.p('nope') })).error?.data?.code,
      'not_found',
    );
    const ok = (await call('folder.check', { path: r.repo })).result!;
    assertEquals([ok.ok, ok.reason, ok.isGit, osp.normcase(ok.realPath)], [
      true,
      'existing',
      true,
      osp.normcase(r.repo),
    ]);
    const fresh = osp.join(r.root, 'fresh');
    const newOne = (await call('folder.check', { path: fresh })).result!;
    assertEquals([newOne.ok, newOne.reason, newOne.isGit, newOne.exists], [
      true,
      'new',
      false,
      false,
    ]);
    const file = (await call('folder.check', { path: r.p('mod.txt') })).result!;
    assertEquals([file.ok, file.reason], [false, 'not_a_folder']);
    assertEquals((await call('git.init', { path: fresh })).result, {
      ok: true,
    });
    assert(osp.isdir(osp.join(fresh, '.git')));
    assertEquals(
      (await call('git.init', { path: osp.join(r.root, 'plain') })).result,
      { ok: true },
    );
    assertEquals(
      (await call('git.init', { path: r.p('mod.txt') })).result?.ok,
      false,
    );
    assertEquals(
      (await call('git.init', { path: osp.join(r.root, 'a', 'b') })).error?.data
        ?.code,
      'parent_missing',
    );
  },
);

Deno.test('which and agents.detect answer in the contract shape', async () => {
  const w = (await call('which', { name: 'definitely-not-a-program-aib' }))
    .result!;
  assertEquals(w, { path: null });
  if (HAVE_GIT) assert((await call('which', { name: 'git' })).result!.path);
  assertEquals((await call('which', { name: '' })).error?.code, BAD_PARAMS);
  const found = (await call('agents.detect', {
    ids: ['claude', 'codex', 'omp', 'mystery'],
  })).result!;
  assertEquals(found.agents.map((a) => a.id), [
    'claude',
    'codex',
    'omp',
    'mystery',
  ]);
  for (const a of found.agents) {
    assertEquals(typeof a.found, 'boolean');
    if (a.found) {
      assert(
        a.command && a.command.length > 0,
        `${a.id} found without a command`,
      );
    } else assert(a.note, `${a.id} missing without a note`);
  }
  assertEquals(
    (await call('agents.detect', { ids: 'claude' })).error?.code,
    BAD_PARAMS,
  );
});

// ---- the build ----------------------------------------------------------------------------------------------------------------

Deno.test('tools/build.ts: a Windows build ships the Linux pair of its own arch; the helper is compiled with no network', () => {
  const t = (id: string) => TARGETS.find((x) => x.id === id)!;
  assertEquals([
    wslTarget(t('windows-x64')).id,
    wslTarget(t('windows-arm64')).id,
  ], ['linux-x64', 'linux-arm64']);
  const args = helperCompileArgs(
    wslTarget(t('windows-x64')),
    'out/AIB-wsl-helper-linux',
  );
  assertEquals(args.slice(0, 4), [
    'compile',
    '--no-check',
    '--target',
    'x86_64-unknown-linux-gnu',
  ]);
  for (
    const flag of [
      '--allow-read',
      '--allow-write',
      '--allow-run',
      '--allow-env',
      '--allow-sys=uid',
      '--deny-net',
    ]
  ) assert(args.includes(flag), flag);
  assert(
    !args.some((a) => a === '-A' || a === '--allow-all' || a.startsWith('--allow-net')),
    args.join(' '),
  );
  assert(args[args.length - 1].endsWith(WSL_HELPER_ENTRY));
  assertEquals([
    modeFor('wsl/AIB-keeper-linux', false),
    modeFor('wsl/AIB-wsl-helper-linux', false),
    modeFor('wsl/notes.txt', false),
  ], [
    0o755,
    0o755,
    0o644,
  ]);
});
