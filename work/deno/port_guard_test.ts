/**
 * No test or helper uses a fixed port. Fixed ports collide: two builders run the same test at once, a demo Studio sits on the number,
 * the live AIB owns 8767/8768/8777/8778. Every port a test binds comes from the OS (port 0, read back; _ports.ts says how).
 *
 * Scans every Deno test and helper, the node page tests, the Python e2e and contract tests, the keeper's Go tests and tools/build.ts,
 * and fails on:
 *   - a listener given a literal port (Deno.listen / Deno.serve / serve / listen / net.Listen / socket.bind with a number);
 *   - a literal on --port, --host-port or --remote-debugging-port (args arrays, `--port=N`, `--port N`);
 *   - a port constant (`const PORT = 8821`, `let port = 8821`, `CDP = 8946`, Go `port := 8950`, Python `PORT = 8821`);
 *   - a scan over a port range (`for (let p = 8851; p <= 8869 ...)`, `range(20000, 40000`);
 *   - a guess-a-free-port helper (freePort / free_port / findFreePort): bind 0, close, hand the number on, hope;
 *   - a literal port saved for the app to reuse (desktop-port.json) or passed to the host fixture (startWeb(..., { port: N })).
 * A line where a number only plays a port (a URL a pure function parses, an owner-file record, a command line that is never run)
 * ends with `port-guard: not bound` and says why. Port 0 is always fine.
 */
import { assert, assertEquals } from './_assert.ts';

const ROOT = new URL('../../', import.meta.url);
const native = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');

const PORT = String.raw`[1-9]\d{0,4}`; // a nonzero literal port
export const RULES: [string, RegExp][] = [
  [
    'a listener on a literal port',
    new RegExp(
      String
        .raw`\b(?:listen|serve|Listen|startDemo|startRedirect|startBlank)\s*\(.*\bport\s*:\s*${PORT}\b`,
    ),
  ],
  [
    'a listener on a literal port',
    new RegExp(
      String
        .raw`\b(?:listen|startDemo|startRedirect|startBlank)\s*\(\s*${PORT}\b`,
    ),
  ],
  [
    'a listener on a literal port',
    new RegExp(String.raw`net\.Listen\([^)]*"[^"]*:${PORT}"`),
  ],
  [
    'a listener on a literal port',
    new RegExp(String.raw`\.bind\(\(\s*['"][^'"]*['"]\s*,\s*${PORT}\s*\)`),
  ],
  [
    'a literal on a port flag',
    new RegExp(
      String
        .raw`--(?:port|host-port|remote-debugging-port)['"]\s*,\s*['"]?${PORT}\b`,
    ),
  ],
  [
    'a literal on a port flag',
    new RegExp(
      String.raw`--(?:port|host-port|remote-debugging-port)(?:=|\s+)${PORT}\b`,
    ),
  ],
  [
    'a port constant',
    new RegExp(
      String
        .raw`\b(?:const|let|var)\s+\w*(?:PORT|Port|port|CDP|cdp)\w*\s*(?::\s*number\s*)?=\s*${PORT}\b`,
    ),
  ],
  [
    'a port constant',
    new RegExp(String.raw`^\s*\w*(?:PORT|CDP)\w*\s*=\s*${PORT}\b`),
  ],
  [
    'a port constant',
    new RegExp(String.raw`\b\w*(?:port|Port|PORT)\w*\s*:=\s*${PORT}\b`),
  ],
  [
    'a port range scan',
    new RegExp(
      String
        .raw`for\s*\(\s*let\s+\w+\s*=\s*\d{4,5}\s*;\s*\w+\s*<=?\s*\d{4,5}\s*(?:;|&&)`,
    ),
  ],
  ['a port range scan', new RegExp(String.raw`for\s+\w+\s*:=\s*\d{4,5}\s*;`)],
  [
    'a port range scan',
    new RegExp(String.raw`randrange\(\s*\d{4,5}\s*,\s*\d{4,5}`),
  ],
  [
    'a guess-a-free-port helper',
    /\b(?:freePort|free_port|findFreePort|find_free_port)\b/,
  ],
  [
    'a literal port saved for the app',
    new RegExp(String.raw`desktop-port\.json.*\bport\s*:\s*${PORT}\b`),
  ],
  [
    'a literal port for the host fixture',
    new RegExp(String.raw`\bstart\w*\(.*\{[^}]*\bport\s*:\s*${PORT}\b`),
  ],
];
const ALLOWED = /port-guard: not bound/;

/** Every file the guard reads: test files and helpers in every language, and the build's smoke check. */
export function guardedFiles(): string[] {
  const files: string[] = [];
  const add = (dir: string, match: (name: string) => boolean) => {
    for (const e of Deno.readDirSync(native(new URL(dir, ROOT)))) {
      if (e.isFile && match(e.name)) files.push(`${dir}${e.name}`);
    }
  };
  add('work/deno/', (n) => n.endsWith('.ts'));
  add(
    'work/',
    (n) => /^(?:test_.*|_.*|chat_harness|fake_.*|run_parallel)\.(?:js|py)$/.test(n),
  );
  add('work/contract/', (n) => n.endsWith('.py'));
  add('keeper/', (n) => n.endsWith('_test.go'));
  files.push('tools/build.ts', 'tools/test.ts');
  return files.sort();
}

export function violations(path: string, text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (ALLOWED.test(line)) return;
    for (const [what, rule] of RULES) {
      if (rule.test(line)) {
        found.push(`${path}:${i + 1}: ${what}: ${line.trim()}`);
        break;
      }
    }
  });
  return found;
}

Deno.test('port guard: no test or helper uses a fixed or guessed port', () => {
  const self = 'work/deno/port_guard_test.ts';
  const found = guardedFiles()
    .filter((f) => f !== self)
    .flatMap((f) => violations(f, Deno.readTextFileSync(native(new URL(f, ROOT)))));
  assertEquals(
    found,
    [],
    `\n${found.join('\n')}\nLet the OS pick the port (port 0, read back): see work/deno/_ports.ts.`,
  );
});

Deno.test('port guard: catches each kind of fixed port, and leaves port 0 and marked lines alone', () => {
  const bad = [
    `const PORT = 8821;`,
    `let port = 8821;`,
    `const CDP = 8946;`,
    `PORT = 8823`,
    `\tport := 8950`,
    `const server = Deno.serve({ hostname: '127.0.0.1', port: 8793 }, handler);`,
    `const l = Deno.listen({ hostname: '127.0.0.1', port });`.replace(
      'port }',
      'port: 8920 }',
    ),
    `port = await server.listen(8851);`,
    `l, err := net.Listen("tcp", "127.0.0.1:8950")`,
    `probe.bind(('127.0.0.1', 20000))`,
    `fx.spawn([DENO, MAIN, 'serve', '--port', '8941'], 'serve');`,
    `const first = await fx.startWeb(['--host-port', '8946']);`,
    `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',`,
    `args: ['serve', '--port=8812'],`,
    `for (let p = 8851; p <= 8869 && !port; p++) {`,
    `\tfor p := 8950; p <= 8999; p++ {`,
    `        port = random.randrange(20000, 40000, 2)`,
    `function freePort(): number {`,
    `def free_port():`,
    `Deno.writeTextFileSync(\`\${fx.state}/desktop-port.json\`, JSON.stringify({ port: 8912 }));`,
    `const web = await fixture.startWeb([], { port: 8825 });`,
  ];
  for (const line of bad) assertEquals(violations('x', line).length, 1, line);
  const good = [
    `for (let c = 1024; c < 1024 * 40; c += 51) assertEquals(formatSize(c), 1);`,
    `const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler);`,
    `const port = await server.listen(0);`,
    `'--remote-debugging-port=0',`,
    `args: ['serve', '--in-process', '--port', '0'],`,
    `args := append([]string{"serve", "--data", data, "--port", "0"}, extra...)`,
    `assertEquals(portGiven(['--port', '8890']), true); // port-guard: not bound (argv parsing)`,
    `const port = pickPort(true);`,
    `const studioPort = studioHold.port;`,
    `assertEquals(redirectTarget('http://127.0.0.1:51234/', 'http://127.0.0.1:8777/'), 'http://127.0.0.1:8777/');`,
    `const claim = await claimFolder(fx.state, { mode: 'server', port: 8813 });`,
  ];
  for (const line of good) assertEquals(violations('x', line), [], line);
  assert(
    guardedFiles().includes('work/deno/_host_fixture.ts') &&
      guardedFiles().includes('keeper/harness_test.go'),
  );
});
