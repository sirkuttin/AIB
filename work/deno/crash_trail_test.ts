/**
 * The crash trail (core/crash_trail.ts; 0.12.1 blocker: the desktop app exited silently). Every end of the process leaves a line in
 * <data>/crash.log: an uncaught exception (with its stack, and the runtime's own stderr text through SetStdHandle on Windows), an
 * unhandled rejection (logged; the process keeps running), Deno.exit with its code and caller, and an end that leaves nothing at all
 * (V8 out of memory) is reported by the next start with the last heartbeat's memory.
 * Each case runs work/deno/_crash_child.ts in its own process.
 */
import { assert, assertEquals } from './_assert.ts';

const CHILD = new URL('./_crash_child.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function child(dir: string, how: string, v8 = ''): Promise<number> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', ...(v8 ? [`--v8-flags=${v8}`] : []), CHILD, dir, how],
    stdout: 'null',
    stderr: 'null',
  }).output();
  return out.code;
}

const read = (dir: string) => Deno.readTextFileSync(`${dir}/crash.log`);
const run = (dir: string) => JSON.parse(Deno.readTextFileSync(`${dir}/crash-run.json`));

Deno.test("crash trail: an uncaught exception leaves its stack (and on Windows the runtime's stderr) in crash.log", async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-crash-' });
  try {
    assertEquals(await child(dir, 'throw'), 1);
    const text = read(dir);
    assert(text.includes('uncaught exception (AIB ends): Error: boom from the child'), text);
    assert(text.includes('_crash_child.ts:'), 'with the stack');
    assert(text.includes('run end: exit code 1 (uncaught exception)'), text);
    if (Deno.build.os === 'windows') {
      assert(text.includes('error: Uncaught Error: boom from the child'), "the runtime's own stderr text: " + text);
    }
    assertEquals(run(dir).ended.code, 1);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('crash trail: an unhandled rejection is logged and the process keeps running; Deno.exit is logged with its code', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-crash-' });
  try {
    assertEquals(await child(dir, 'reject'), 0);
    let text = read(dir);
    assert(text.includes('unhandled promise rejection (AIB keeps running): Error: orphan rejection'), text);
    assert(text.includes('still running after the rejection'), text);
    assertEquals(await child(dir, 'exit'), 3);
    text = read(dir);
    assert(/run end: exit code 3 \(Deno\.exit from .*_crash_child\.ts/.test(text), text);
    assert(!text.includes('ended without a clean exit'), 'clean ends are not reported as crashes');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('crash trail: a V8 out-of-memory abort is reported by the next start with the last heartbeat', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-crash-' });
  try {
    const code = await child(dir, 'oom', '--max-old-space-size=64');
    assert(code !== 0, `the child died (${code})`);
    const dead = run(dir);
    assertEquals(dead.ended, undefined, 'nothing could mark the end');
    assertEquals(await child(dir, 'done'), 0);
    const text = read(dir);
    assert(text.includes(`the previous run (AIB test, pid ${dead.pid}`) && text.includes('ended without a clean exit'), text);
    assert(text.includes('its last sign of life was'), text);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('crash trail: crash.log is rotated at start once it is large', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-crash-' });
  try {
    Deno.writeTextFileSync(`${dir}/crash.log`, 'x'.repeat(1024 * 1024 + 10));
    assertEquals(await child(dir, 'done'), 0);
    assertEquals(Deno.statSync(`${dir}/crash.1.log`).size, 1024 * 1024 + 10);
    assert(Deno.statSync(`${dir}/crash.log`).size < 10_000);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
