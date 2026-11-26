/**
 * Every method-group module of Connection (acp/conn_*.ts) and Aib (host/aib_*.ts) must load first, on its own: a value import of
 * the class from its own group module is a circular import that crashes with "Cannot access ... before initialization".
 * Each module is imported in a fresh deno process (the module cache of this process would hide the problem).
 */
import { assert, assertEquals } from './_assert.ts';

const APP = new URL('../../app/', import.meta.url);
const SERVER = new URL('server/', APP);
const CHILD = new URL('./_load_module.ts', import.meta.url);

async function modules(): Promise<URL[]> {
  const found: URL[] = [];
  for (const [dir, pattern] of [['acp/', /^conn_[a-z_]+\.ts$/], ['host/', /^aib_[a-z_]+\.ts$/]] as const) {
    for await (const entry of Deno.readDir(new URL(dir, SERVER))) {
      if (entry.isFile && pattern.test(entry.name)) found.push(new URL(dir + entry.name, SERVER));
    }
  }
  return found.sort((a, b) => a.href.localeCompare(b.href));
}

Deno.test('each conn_*.ts and aib_*.ts module loads first, on its own, without an error', async () => {
  const list = await modules();
  assert(list.length > 20, 'the module list was found');
  const failures: string[] = [];
  const queue = [...list];
  const worker = async () => { // two at a time: each is a short deno process
    for (let url = queue.shift(); url; url = queue.shift()) {
      const r = await new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', '--no-lock', CHILD.href, url.href],
        cwd: APP, // app/, where deno.json (the import map) is
        stdin: 'null',
        stdout: 'null',
        stderr: 'piped',
      }).output();
      if (!r.success) {
        const err = new TextDecoder().decode(r.stderr).split('\n').find((l) => /error/i.test(l)) ?? 'failed';
        failures.push(`${url.pathname.split('/').slice(-2).join('/')}: ${err}`);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  assertEquals(failures, []);
});
