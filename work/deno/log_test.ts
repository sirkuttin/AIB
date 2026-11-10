/** server/core/log.ts: the cases of work/test_log_setup.py that exercise log_setup.py directly, plus parity and same-file interop with Python. */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  addHandler,
  DEBUG,
  defaultLevel,
  ENV_LEVEL,
  ERROR,
  forgetSecrets,
  formatMessage,
  getLogger,
  type Handler,
  INFO,
  levelName,
  parseLevel,
  redact,
  REDACTED,
  registerSecret,
  removeHandler,
  rootState,
  RotatingFileHandler,
  setLevel,
  setup,
  WARNING,
} from '../../outputs/agent-studio/server/core/log.ts';
import { configure, issue } from '../../outputs/agent-studio/server/artifacts/keys.ts';
import { join } from '../../outputs/agent-studio/server/platform/path.ts';

const TOKEN = 'tok_AbCdEf0123456789-_xyzXYZ0123456789abcdefg';
const LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} (DEBUG|INFO|WARNING|ERROR|CRITICAL) [\w.]+: /;

/** Put logging back as it was: our handlers closed, level WARNING, no secrets. */
function reset(): void {
  setup('test', { level: 'WARNING', stream: false });
  forgetSecrets();
}

class Capture implements Handler {
  lines: string[] = [];
  emit(line: string): void {
    this.lines.push(line);
  }
  close(): void {}
  get text(): string {
    return this.lines.join('\n');
  }
}

function capture(level = DEBUG): Capture & Disposable {
  const handler = new Capture() as Capture & Disposable;
  const before = rootState().level;
  setLevel(level);
  addHandler(handler);
  handler[Symbol.dispose] = () => {
    removeHandler(handler);
    setLevel(before);
    forgetSecrets();
  };
  return handler;
}

Deno.test('setup creates the log file in the state folder and writes to it', () => {
  const folder = Deno.makeTempDirSync();
  try {
    const path = setup('studio', { level: 'WARNING', stateDir: join(folder, 'sub'), filename: 'studio.log', stream: false });
    assertEquals(path, join(folder, 'sub', 'studio.log'));
    getLogger('some_module').warning('something odd');
    const text = Deno.readTextFileSync(path!);
    for (const part of ['WARNING', 'some_module', 'something odd']) assert(text.includes(part), part);
    assert(LINE.test(text), text);
  } finally {
    reset();
    Deno.removeSync(folder, { recursive: true });
  }
});

Deno.test('setup respects the level, and setting up again replaces the handlers', () => {
  const folder = Deno.makeTempDirSync();
  try {
    const path = setup('studio', { level: 'ERROR', stateDir: folder, filename: 'studio.log', stream: false })!;
    getLogger('m').warning('quiet one');
    getLogger('m').error('loud one');
    let text = Deno.readTextFileSync(path);
    assert(!text.includes('quiet one') && text.includes('loud one'), text);
    const count = rootState().handlers.length;
    setup('studio', { level: 'DEBUG', stateDir: folder, filename: 'studio.log', stream: false });
    assertEquals(rootState().handlers.length, count, 'no duplicate handlers');
    getLogger('m').debug('debug one');
    text = Deno.readTextFileSync(path);
    assert(text.includes('debug one'));
    assert(text.includes(`log_setup: studio logging at DEBUG, file ${path}`), 'the setup line, as Python writes it');
  } finally {
    reset();
    Deno.removeSync(folder, { recursive: true });
  }
});

Deno.test('level parsing, default and environment; same as Python', async () => {
  await using py = new PyParity();
  assertEquals(parseLevel(null), WARNING);
  assertEquals(parseLevel('info'), INFO);
  assertEquals(parseLevel('nonsense'), WARNING);
  assertEquals(parseLevel(10), 10);
  for (const value of [null, '', 'info', ' Debug ', 'WARN', 'fatal', 'notset', 'nonsense', '15', 10, 'error']) {
    assertEquals(parseLevel(value), await py.call('log_setup', 'parse_level', [value]), JSON.stringify(value));
  }
  assertEquals(parseLevel('x', 'ERROR'), ERROR);
  assertEquals([levelName(10), levelName(30), levelName(15)], ['DEBUG', 'WARNING', 'Level 15']);
  const old = Deno.env.get(ENV_LEVEL);
  try {
    Deno.env.delete(ENV_LEVEL);
    assertEquals(defaultLevel(), 'WARNING');
    Deno.env.set(ENV_LEVEL, 'ERROR');
    assertEquals(defaultLevel(), 'ERROR');
  } finally {
    if (old === undefined) Deno.env.delete(ENV_LEVEL);
    else Deno.env.set(ENV_LEVEL, old);
  }
});

Deno.test('an unwritable state folder does not stop the program', () => {
  const folder = Deno.makeTempDirSync();
  const original = console.error;
  const said: string[] = [];
  console.error = (...args: unknown[]) => said.push(args.join(' '));
  try {
    const blocker = join(folder, 'file');
    Deno.writeTextFileSync(blocker, 'x');
    assertEquals(setup('studio', { level: 'WARNING', stateDir: join(blocker, 'inside'), filename: 'studio.log', stream: false }), null);
    assert(said[0]?.startsWith(`studio: could not open the log file in ${join(blocker, 'inside')}: `), said.join('\n'));
  } finally {
    console.error = original;
    reset();
    Deno.removeSync(folder, { recursive: true });
  }
});

Deno.test('nothing is written before setup', () => {
  reset();
  assertEquals(rootState().handlers.length, 0);
  getLogger('quiet').error('nobody hears this'); // no handler, no throw
});

Deno.test('a registered token never appears in a line or a stack', () => {
  using out = capture();
  registerSecret(TOKEN);
  const log = getLogger('redaction_test');
  log.warning('request failed for %s', TOKEN);
  log.warning(`plain ${TOKEN} in text`);
  log.exception(new RangeError(`boom with ${TOKEN}`), 'it broke');
  assert(!out.text.includes(TOKEN), out.text);
  assert(out.text.includes(REDACTED) && out.text.includes('it broke') && out.text.includes('RangeError'), out.text);
  assert(out.lines.every((line) => LINE.test(line)));
});

Deno.test('header and field patterns are redacted without registration; ordinary text is untouched', () => {
  using out = capture();
  const log = getLogger('redaction_test');
  log.warning('X-Studio-Token: abcDEF123456 and X-Studio-Artifact-Key=%s', 'k'.repeat(20));
  log.warning('Authorization: Bearer abcdefghijklmnop');
  log.warning('{"token": "supersecretvalue", "api_key": "sk-123456789"}');
  log.warning('key %s', 'a1'.repeat(32));
  for (const leaked of ['abcDEF123456', 'k'.repeat(20), 'abcdefghijklmnop', 'supersecretvalue', 'sk-123456789', 'a1'.repeat(32)]) {
    assert(!out.text.includes(leaked), leaked);
  }
  log.warning('Auto-reconnect of claude in C:\\work failed (try 1 of 3)');
  assert(out.text.includes('Auto-reconnect of claude in C:\\work failed (try 1 of 3)'));
});

Deno.test('redact matches Python', async () => {
  await using py = new PyParity();
  const samples = [
    'X-Studio-Token: abcDEF123456 and X-Studio-Artifact-Key=kkkkkkkkkkkkkkkkkkkk',
    'Authorization: Bearer abcdefghijklmnop',
    'authorization=bearer xyz123',
    '{"token": "supersecretvalue", "api_key": "sk-123456789"}',
    "password='hunter2hunter2', passwd: x; secret=a,b",
    'my-auth_token_v2 = "abc def"',
    'tokenizer: fine? token:value&next=1',
    'Bearer short and bearer   LongEnough.Token~+/=-',
    'key ' + 'a1'.repeat(32) + ' and ' + 'f'.repeat(65) + ' and x' + 'b'.repeat(64),
    'Auto-reconnect of claude in C:\\work failed (try 1 of 3)',
    'ünïcødé_token=sécret😀 and Ωtoken: v',
    'ApiKey=1 API-KEY: 2 artifact_key=3 ARTIFACTKEY:4',
    'token\u00a0=\u00a0spaced and token=\u2028x',
    '',
  ];
  for (const text of samples) assertEquals(redact(text), await py.call('log_setup', 'redact', [text]), text);
  registerSecret('registered-secret-value');
  await py.call('log_setup', 'register_secret', ['registered-secret-value']);
  registerSecret('short');
  await py.call('log_setup', 'register_secret', ['short']);
  for (const text of ['has registered-secret-value inside', 'short stays']) {
    assertEquals(redact(text), await py.call('log_setup', 'redact', [text]), text);
  }
  forgetSecrets();
});

Deno.test('formatMessage handles the %-conversions the code uses', () => {
  assertEquals(formatMessage('%s logging at %s%s', ['studio', 'INFO', '']), 'studio logging at INFO');
  assertEquals(formatMessage('100% sure', []), '100% sure');
  assertEquals(formatMessage('%d items, %r, %%', [3.7, 'x']), "3 items, 'x', %");
});

Deno.test('the real handlers carry the filter, and an issued artifact key is registered', () => {
  const folder = Deno.makeTempDirSync();
  try {
    registerSecret(TOKEN);
    const path = setup('studio', { level: 'WARNING', stateDir: folder, filename: 'studio.log', stream: false })!;
    getLogger('x').error('token is %s', TOKEN);
    assert(!Deno.readTextFileSync(path).includes(TOKEN));
    configure(join(folder, 'state'));
    const key = issue('conv-1')!;
    assert(!redact(`the key was ${key}`).includes(key));
  } finally {
    configure(null);
    reset();
    Deno.removeSync(folder, { recursive: true });
  }
});

Deno.test('rotation keeps two old files, like RotatingFileHandler', () => {
  const folder = Deno.makeTempDirSync();
  const path = join(folder, 'studio.log');
  const handler = new RotatingFileHandler(path, 200, 2);
  try {
    for (let i = 0; i < 20; i++) handler.emit(`line ${i} ` + 'x'.repeat(40));
  } finally {
    handler.close();
  }
  assertEquals([...Deno.readDirSync(folder)].map((e) => e.name).sort(), ['studio.log', 'studio.log.1', 'studio.log.2']);
  for (const name of ['studio.log', 'studio.log.1', 'studio.log.2']) assert(Deno.statSync(join(folder, name)).size < 200, name);
  assert(Deno.readTextFileSync(path).includes('line 19'));
  assert(Deno.readTextFileSync(path + '.1').includes('line 1'));
  Deno.removeSync(folder, { recursive: true });
});

Deno.test('Python and Deno lines in one studio.log look the same (format and line ends)', async () => {
  await using py = new PyParity();
  const folder = Deno.makeTempDirSync();
  try {
    const path = await py.call('log_shim', 'write_line', [
      folder,
      'studio.log',
      'artifacts',
      'WARNING',
      'watcher failed for %s',
      'conv-1',
    ]) as string;
    const pythonBytes = Deno.readFileSync(path).length;
    setup('studio', { level: 'WARNING', stateDir: folder, filename: 'studio.log', stream: false });
    getLogger('artifacts').warning('watcher failed for %s', 'conv-1');
    reset();
    const raw = Deno.readTextFileSync(path);
    const lines = raw.split('\n').filter(Boolean);
    const shaped = lines.map((line) => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} /, 'T '));
    const expected = 'T WARNING artifacts: watcher failed for conv-1' + (Deno.build.os === 'windows' ? '\r' : '');
    assertEquals(
      shaped.filter((l) => !l.includes('log_setup')),
      [expected, expected],
      'Python line, then Deno line: identical apart from the time',
    );
    assert(raw.length > pythonBytes);
  } finally {
    reset();
    Deno.removeSync(folder, { recursive: true });
  }
});
