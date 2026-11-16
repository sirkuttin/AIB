/**
 * WSL end-to-end (docs/wsl/design.md 7), Track A's side: the real Linux keeper and helper in a real distro, driven the way AIB will
 * drive them, through `wsl.exe ... AIB-keeper bridge` stdio. Runs only with AIB_WSL_E2E=<distro> on Windows; otherwise ignored.
 *
 *   bridge   magic line and preamble, hello over stdio, a second bridge shares the keeper, `--unix-only` (no TCP listener, `ss -ltnp`)
 *   helper   as a keeper pipe channel: helper.ready, env.get (PATH without /mnt, BROWSER), which, files.* and changes.* on a temp
 *            repo with case-distinct Foo/foo, a backslash in a name, an exec-bit change and an untracked file
 *   shim     $BROWSER https://... reaches AIB as browser.open; file: is refused
 *   hold     `bridge --hold` is a keeper client and exits with its stdin
 *
 * Isolation: everything lives in /tmp/aib-wsl-test-<random> (AIB_WSL_ROOT), removed at the end; the owner's ~/.aib-server, ~/.claude
 * and ~/.codex are never touched; no agent runs. wsl.exe gets a minimal environment (WSL_UTF8=1, WSLENV empty) and the test process's
 * hidden console, so no window opens. Only processes this test started are stopped; never `wsl --shutdown` or `--terminate`.
 * The binaries come from tools/build.ts buildWslBinaries (cached by source hash).
 */
import { assert, assertEquals } from './_assert.ts';
import { encodeFrame, FrameReader } from '../../outputs/agent-studio/server/keeper/client.ts';
import { BRIDGE_MAGIC, type BridgePreamble, WSL_HELPER_LABEL } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { buildWslBinaries, REPO, TARGETS, WSL_HELPER, WSL_KEEPER, wslTarget } from '../../tools/build.ts';

const DISTRO = Deno.env.get('AIB_WSL_E2E') ?? '';
const WSL = `${Deno.env.get('SystemRoot') ?? 'C:\\Windows'}\\System32\\wsl.exe`;
const ENC = new TextEncoder(), DEC = new TextDecoder();
type Json = Record<string, unknown>;

function wslEnv(): Record<string, string> {
  return {
    SystemRoot: Deno.env.get('SystemRoot') ?? 'C:\\Windows',
    WSL_UTF8: '1',
    WSLENV: '',
  };
}

/** Runs argv in the distro (`--exec`, no shell unless asked), bytes on stdin. */
async function inDistro(
  argv: string[],
  stdin?: Uint8Array,
): Promise<{ code: number; out: string; err: string }> {
  const child = new Deno.Command(WSL, {
    args: ['--distribution', DISTRO, '--cd', '/', '--exec', ...argv],
    env: wslEnv(),
    clearEnv: true,
    stdin: stdin ? 'piped' : 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  if (stdin) {
    const w = child.stdin.getWriter();
    await w.write(stdin);
    await w.close();
  }
  const out = await child.output();
  return {
    code: out.code,
    out: DEC.decode(out.stdout),
    err: DEC.decode(out.stderr),
  };
}

/** One `AIB-keeper bridge` over wsl.exe: the preamble, then keeper frames both ways. */
class Bridge {
  readonly child: Deno.ChildProcess;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  preamble!: BridgePreamble;
  #frames = new FrameReader();
  #next = 1;
  #waits = new Map<number, (h: Json) => void>();
  #events: [Json, Uint8Array][] = [];
  #listeners = new Set<() => void>();
  #ready: Promise<void>;
  closed = false;

  constructor(binary: string, args: string[]) {
    this.child = new Deno.Command(WSL, {
      args: [
        '--distribution',
        DISTRO,
        '--cd',
        '~',
        '--exec',
        binary,
        'bridge',
        ...args,
      ],
      env: wslEnv(),
      clearEnv: true,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    this.writer = this.child.stdin.getWriter();
    this.#ready = this.#read();
  }

  async #read(): Promise<void> {
    const reader = this.child.stdout.getReader();
    let head = new Uint8Array(0);
    let gotPreamble = false;
    let resolveReady!: () => void, rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => [resolveReady, rejectReady] = [res, rej]);
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!gotPreamble) {
            const joined = new Uint8Array(head.length + value.length);
            joined.set(head);
            joined.set(value, head.length);
            head = joined;
            const text = DEC.decode(head);
            const at = text.indexOf(BRIDGE_MAGIC + '\n');
            const end = at < 0 ? -1 : text.indexOf('\n', at + BRIDGE_MAGIC.length + 1);
            if (end < 0) continue;
            this.preamble = JSON.parse(
              text.slice(at + BRIDGE_MAGIC.length + 1, end),
            );
            gotPreamble = true;
            resolveReady();
            this.#push(
              head.subarray(ENC.encode(text.slice(0, end + 1)).length),
            );
            continue;
          }
          this.#push(value);
        }
      } catch { /* closed */ }
      this.closed = true;
      if (!gotPreamble) {
        rejectReady(
          new Error(
            `no preamble from the bridge; got ${JSON.stringify(DEC.decode(head))}`,
          ),
        );
      }
      for (const l of this.#listeners) l();
    })();
    return await ready;
  }

  #push(bytes: Uint8Array): void {
    for (const [h, body] of this.#frames.push(bytes)) {
      if (typeof h.re === 'number' && this.#waits.has(h.re)) {
        this.#waits.get(h.re)!(h);
        this.#waits.delete(h.re);
      } else if (h.ev) this.#events.push([h, body]);
    }
    for (const l of this.#listeners) l();
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async call(op: string, fields: Json = {}, body?: Uint8Array): Promise<Json> {
    const id = this.#next++;
    const reply = new Promise<Json>((resolve) => this.#waits.set(id, resolve));
    await this.writer.write(encodeFrame({ op, id, ...fields } as never, body));
    return await within(reply, 20_000, `${op}: no reply`);
  }

  async must(op: string, fields: Json = {}, body?: Uint8Array): Promise<Json> {
    const r = await this.call(op, fields, body);
    if (r.ok !== true) {
      throw new Error(`${op} ${JSON.stringify(fields)}: ${JSON.stringify(r)}`);
    }
    return r;
  }

  /** Waits until pred holds for the events so far (they stay, so later waits see them too). */
  async until<T>(
    pred: (events: [Json, Uint8Array][]) => T | undefined,
    ms: number,
    what: string,
  ): Promise<T> {
    let listener = () => {};
    const found = new Promise<T>((resolve) => {
      listener = () => {
        const v = pred(this.#events);
        if (v !== undefined) resolve(v);
      };
      this.#listeners.add(listener);
      listener();
    });
    try {
      return await within(found, ms, what);
    } finally {
      this.#listeners.delete(listener);
    }
  }

  /** The text of a channel's records of `kind` so far. */
  text(channel: string, kind = 'out'): string {
    return this.#events.filter(([h]) => h.ev === 'record' && h.channel === channel && h.kind === kind).map(([, b]) => DEC.decode(b)).join(
      '',
    );
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch { /* closed */ }
    const done = await Promise.race([
      this.child.status,
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (done === null) {
      try {
        this.child.kill();
      } catch { /* gone */ }
      await this.child.status;
    }
  }
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((
      _,
      rej,
    ) => (timer = setTimeout(() => rej(new Error(what)), ms))),
  ]).finally(() => clearTimeout(timer));
}

/** JSON-RPC to the helper channel: each request is a `write`; each answer an `out` line. */
class Helper {
  #id = 100;
  constructor(
    readonly bridge: Bridge,
    readonly channel: string,
    readonly epoch: number,
  ) {}

  lines(): Json[] {
    return this.bridge.text(this.channel).split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  async call(method: string, params: Json = {}): Promise<Json> {
    const id = this.#id++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    await this.bridge.must('write', {
      channel: this.channel,
      epoch: this.epoch,
    }, ENC.encode(line));
    const reply = await this.bridge.until(
      () => this.lines().find((m) => m.id === id),
      30_000,
      `${method}: no answer`,
    );
    if (reply.error) {
      throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    }
    return reply.result as Json;
  }
}

Deno.test({
  name: 'WSL: bridge, unix-only keeper, helper methods, BROWSER shim and hold in a real distro',
  ignore: !DISTRO || Deno.build.os !== 'windows',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const root = `/tmp/aib-wsl-test-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const ver = '0.0.0-e2e-0123abcd';
    const bin = `${root}/${ver}`;
    const data = `${root}/data-e2e`;
    const bridges: Bridge[] = [];
    const open = (args: string[]) => {
      const b = new Bridge(`${bin}/AIB-keeper`, args);
      bridges.push(b);
      return b;
    };
    try {
      const local = `${REPO}/dist/wsl/e2e-linux-x64`;
      await buildWslBinaries(
        wslTarget(TARGETS.find((x) => x.id === 'windows-x64')!),
        local,
      );
      assertEquals(
        (await inDistro(['mkdir', '-m', '700', '-p', root])).code,
        0,
      );
      assertEquals((await inDistro(['mkdir', '-m', '700', bin])).code, 0);
      for (
        const [from, to] of [[WSL_KEEPER, 'AIB-keeper'], [
          WSL_HELPER,
          'AIB-wsl-helper',
        ]]
      ) {
        const copy = await inDistro([
          'sh',
          '-c',
          'cat > "$1.part" && chmod 0755 "$1.part" && mv "$1.part" "$1"',
          'sh',
          `${bin}/${to}`,
        ], await Deno.readFile(`${local}/${from}`));
        assertEquals(copy.code, 0, copy.err);
      }

      const main = open(['--data', data]);
      let pid = 0;
      await t.step(
        'the bridge writes the magic line and the preamble, then carries hello',
        async () => {
          await within(main.ready(), 30_000, 'no preamble');
          const p = main.preamble;
          assertEquals([
            p.ev,
            p.bridge,
            p.keeper,
            typeof p.token,
            p.token.length,
            p.arch,
          ], ['bridge', 1, '1.6.0', 'string', 64, 'amd64']);
          assert(
            p.home.startsWith('/') && p.uid > 0 && p.pid > 0,
            JSON.stringify(p),
          );
          pid = p.pid;
          const hello = await main.must('hello', {
            token: p.token,
            min: 1,
            max: 1,
            client: 'AIB e2e',
          });
          for (const f of ['scrollback', 'labels', 'hold']) {
            assert((hello.features as string[]).includes(f), f);
          }
        },
      );

      await t.step(
        'a second bridge shares the keeper; the keeper listens on its unix socket only',
        async () => {
          const second = open(['--data', data]);
          await within(second.ready(), 30_000, 'no preamble');
          assertEquals(second.preamble.pid, pid);
          assertEquals(
            (await second.call('hello', {
              token: second.preamble.token,
              min: 1,
              max: 1,
              client: 'AIB e2e 2',
            })).ok,
            true,
          );
          await second.close();
          const info = JSON.parse(
            (await inDistro(['cat', `${data}/keeper/keeper.json`])).out,
          );
          assertEquals([info.transport, info.address], [
            'unix',
            `${data}/keeper/keeper.sock`,
          ]);
          const ss = await inDistro(['ss', '-ltnpH']);
          assertEquals(ss.code, 0, ss.err);
          assert(
            !ss.out.includes(`pid=${pid},`),
            `the keeper has a TCP listener:\n${ss.out}`,
          );
        },
      );

      const spawn = await main.must('spawn', {
        channel: 'helper',
        command: `${bin}/AIB-wsl-helper`,
        args: ['--data', data],
        cwd: root,
        env: {
          HOME: main.preamble.home,
          PATH: '/usr/bin:/bin:/mnt/c/Windows/System32',
          AIB_WSL_ROOT: root,
          LANG: 'C.UTF-8',
        },
        label: JSON.stringify({ ...WSL_HELPER_LABEL, v: ver }),
        scrollback: 1 << 20,
      });
      await main.must('attach', { channel: 'helper', from: 0 });
      const helper = new Helper(main, 'helper', Number(spawn.epoch));
      const repo = `${root}/repo`;

      await t.step(
        'the helper says helper.ready and serves its login environment',
        async () => {
          const ready = await main.until(
            () => helper.lines().find((m) => m.method === 'helper.ready'),
            30_000,
            'no helper.ready',
          );
          assertEquals(
            helper.lines()[0].method,
            'helper.ready',
            'helper.ready is the first line',
          );
          const params = ready.params as {
            protocol: number;
            methods: string[];
          };
          assertEquals(params.protocol, 1);
          assert(
            params.methods.includes('changes.get') &&
              params.methods.includes('files.read'),
          );
          const env = await helper.call('env.get') as {
            env: Record<string, string>;
            home: string;
            arch: string;
            shell: string;
          };
          assert(
            !env.env.PATH.split(':').some((d) => d.startsWith('/mnt/')),
            env.env.PATH,
          );
          assertEquals(env.env.BROWSER, `${bin}/aib-open`);
          assertEquals(env.env.AIB_OPEN_FIFO, `${data}/helper/open.fifo`);
          assertEquals([env.home, env.arch], [main.preamble.home, 'amd64']);
          assertEquals(
            (await helper.call('which', { name: 'git' })).path,
            '/usr/bin/git',
          );
        },
      );

      await t.step(
        'files.* and changes.* on a Linux repo: case-distinct names, a backslash, an exec bit, an untracked file',
        async () => {
          const setup = [
            `mkdir "${repo}" && cd "${repo}" && git init -q && git config user.name t && git config user.email t@t`,
            `printf 'upper\\n' > Foo && printf 'lower\\n' > foo && printf 'b\\n' > 'back\\slash' && printf '#!/bin/sh\\n' > run.sh`,
            `git add -A && git commit -q -m base && printf 'UPPER\\n' > Foo && chmod +x run.sh && printf 'new\\n' > new.txt && echo setup-done`,
          ].join(' && ');
          const s = await main.must('spawn', {
            channel: 'setup',
            command: '/bin/sh',
            args: ['-c', setup],
            cwd: root,
            env: { PATH: '/usr/bin:/bin', HOME: root },
          });
          assert(s.ok);
          await main.must('attach', { channel: 'setup', from: 0 });
          await main.until(
            (ev) => ev.find(([h]) => h.channel === 'setup' && h.kind === 'exit') ? true : undefined,
            30_000,
            'setup did not finish',
          );
          assert(
            main.text('setup').includes('setup-done'),
            main.text('setup') + main.text('setup', 'err'),
          );

          const list = await helper.call('files.list', { root: repo });
          const names = (list.entries as { name: string; status: string }[])
            .map((e) => `${e.name}:${e.status}`).sort();
          assertEquals(names, [
            'Foo:M',
            'back\\slash:',
            'foo:',
            'new.txt:U',
            'run.sh:M',
          ]);
          const read = await helper.call('files.read', {
            root: repo,
            rel: 'back\\slash',
          });
          assertEquals(atob(read.bytesB64 as string), 'b\n');
          assertEquals(
            atob(
              (await helper.call('files.read', { root: repo, rel: 'foo' }))
                .bytesB64 as string,
            ),
            'lower\n',
          );
          const search = await helper.call('files.search', {
            root: repo,
            query: 'foo',
          });
          assertEquals(
            (search.matches as { path: string }[]).map((m) => m.path).sort(),
            ['Foo', 'foo'],
          );
          const changes = await helper.call('changes.get', { folder: repo });
          assertEquals(
            (changes.files as { path: string; status: string }[]).map((f) => `${f.status} ${f.path}`),
            ['M Foo', 'M run.sh', 'U new.txt'],
          );
          const diff = await helper.call('changes.diff', {
            folder: repo,
            path: 'Foo',
          });
          assertEquals([
            diff.added,
            diff.removed,
            (diff.hunks as { lines: string[] }[])[0].lines,
          ], [1, 1, ['-upper', '+UPPER']]);
          assertEquals(
            (await helper.call('changes.diff', {
              folder: repo,
              path: 'run.sh',
            })).status,
            'M',
          );
          const branch = await helper.call('chat.repoBranch', { folder: repo });
          assertEquals(branch.repo, repo);
          assert(typeof branch.branch === 'string' && branch.branch.length > 0);
          assertEquals(
            (await helper.call('files.gitInfo', { root: repo })).prefix,
            '',
          );
          const dirs = await helper.call('fs.listDirs', { path: root });
          assert(
            (dirs.dirs as { name: string; isGit: boolean }[]).some((d) => d.name === 'repo' && d.isGit),
          );
          const check = await helper.call('folder.check', { path: repo });
          assertEquals([check.ok, check.isGit, check.realPath], [
            true,
            true,
            repo,
          ]);
          assertEquals(
            await helper.call('git.init', { path: `${root}/fresh` }),
            { ok: true },
          );
          assertEquals(
            (await helper.call('fs.stat', { path: `${root}/fresh/.git` }))
              .isDir,
            true,
          );
        },
      );

      await t.step(
        'BROWSER: an https link reaches AIB as browser.open; file: is refused',
        async () => {
          const env = (await helper.call('env.get')).env as Record<
            string,
            string
          >;
          const script = '"$BROWSER" https://example.com/aib-e2e; echo rc=$?; "$BROWSER" file:///etc/passwd; echo rc=$?';
          await main.must('spawn', {
            channel: 'shim',
            command: '/bin/sh',
            args: ['-c', script],
            cwd: root,
            env,
          });
          await main.must('attach', { channel: 'shim', from: 0 });
          await main.until(
            (ev) => ev.find(([h]) => h.channel === 'shim' && h.kind === 'exit') ? true : undefined,
            30_000,
            'the shim did not finish',
          );
          assertEquals(
            main.text('shim').trim().split('\n'),
            ['rc=0', 'rc=1'],
            main.text('shim', 'err'),
          );
          assert(
            main.text('shim', 'err').includes('refused: only http and https'),
            main.text('shim', 'err'),
          );
          const opened = helper.lines().filter((m) => m.method === 'browser.open').map((m) => (m.params as { url: string }).url);
          assertEquals(opened, ['https://example.com/aib-e2e']);
        },
      );

      await t.step(
        'bridge --hold is a keeper client and exits with its stdin',
        async () => {
          const hold = open([
            '--data',
            data,
            '--hold',
            '--poll',
            '200ms',
            '--grace',
            '1h',
          ]);
          await within(hold.ready(), 30_000, 'no hold preamble');
          assertEquals(hold.preamble.pid, pid);
          let clients: string[] = [];
          for (let i = 0; i < 50 && !clients.includes('AIB WSL hold'); i++) {
            clients = (await main.must('status')).clients as string[];
            await new Promise((r) => setTimeout(r, 100));
          }
          assert(clients.includes('AIB WSL hold'), JSON.stringify(clients));
          await hold.writer.close();
          const st = await within(
            hold.child.status,
            10_000,
            'the hold did not exit at stdin EOF',
          );
          assertEquals(st.code, 0);
        },
      );

      await main.must('kill', { channel: 'helper', epoch: helper.epoch });
      await main.must('shutdown', { force: true });
    } finally {
      for (const b of bridges) await b.close();
      if (root.startsWith('/tmp/aib-wsl-test-')) {
        await inDistro([
          'sh',
          '-c',
          'k=$(sed -n \'s/.*"pid": *\\([0-9]*\\).*/\\1/p\' "$1/data-e2e/keeper/keeper.json" 2>/dev/null); [ -n "$k" ] && kill "$k"; sleep 0.3; rm -rf -- "$1"',
          'sh',
          root,
        ]);
      }
    }
  },
});
