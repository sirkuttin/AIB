/**
 * Guard for the `$name` members of Connection and Aib. They were `#private` before the two classes were split into method
 * modules; they are public now only so the modules of one class can share them. This test keeps them private by convention:
 *   - outside the class file and its own method modules, no `.$name` access at all;
 *   - inside a Connection module (acp/connection.ts, acp/conn_*.ts), `.$name` only on `this` or `Connection`; inside an Aib
 *     module (host/aib.ts, host/aib_*.ts), only on `this` or `Aib`. A Connection module reaching an Aib member (or the other
 *     way round) has a different receiver (`c.$x`, `aib.$x`) and fails.
 * Add a file to ALLOWED (with a reason) when it really needs one.
 */
import { assertEquals } from './_assert.ts';

const ROOT = new URL('../../app/', import.meta.url);
const ALLOWED: Record<string, string> = {
  // 'server/x/y.ts': 'why it may read a `$` member',
};

const CONNECTION_FILE = /^server\/acp\/(connection|conn_[a-z_]+)\.ts$/;
const AIB_FILE = /^server\/host\/(aib|aib_[a-z_]+)\.ts$/;
// `.$name` or `?.$name` after an identifier, `)` or `]`: a member access (not `${...}`, not a lone `$` identifier).
const MEMBER = /([A-Za-z_]\w*|\)|\])\??\.\$[A-Za-z_]\w*/g;

async function* sources(dir: URL, rel: string): AsyncGenerator<[string, URL]> {
  for await (const entry of Deno.readDir(dir)) {
    const path = rel + entry.name;
    if (entry.isDirectory) yield* sources(new URL(entry.name + '/', dir), path + '/');
    else if (/\.(ts|js)$/.test(entry.name)) yield [path, new URL(entry.name, dir)];
  }
}

function accesses(text: string): { line: number; receiver: string; text: string }[] {
  const found: { line: number; receiver: string; text: string }[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').replace(/'[^']*'|"[^"]*"/g, "''"); // no comment tails, no quoted strings
    for (const m of line.matchAll(MEMBER)) found.push({ line: i + 1, receiver: m[1], text: m[0] });
  });
  return found;
}

Deno.test('$ members of Connection and Aib are used only by their own class modules', async () => {
  const bad: string[] = [];
  // app/page is browser code (its `sel.$from` is ProseMirror) and never holds a Connection, so only server/ is scanned.
  for (const root of ['server/']) {
    for await (const [path, url] of sources(new URL(root, ROOT), root)) {
      if (path in ALLOWED) continue;
      const own = CONNECTION_FILE.test(path) ? ['this', 'Connection'] : AIB_FILE.test(path) ? ['this', 'Aib'] : [];
      for (const a of accesses(await Deno.readTextFile(url))) {
        if (!own.includes(a.receiver)) bad.push(`${path}:${a.line}  ${a.text}`);
      }
    }
  }
  assertEquals(bad, [], 'a `$` member is private by convention: use a public method, or add the file to ALLOWED with a reason');
});

Deno.test('the $ scan finds member accesses and skips comments, strings and template holes (self-check)', () => {
  const sample = ["conn.$steerPump(); // c.$x", "const s = 'a.$b'; this.$ok; `${a.b}`"].join('\n');
  assertEquals(accesses(sample).map((a) => a.text), ['conn.$steerPump', 'this.$ok']);
});
