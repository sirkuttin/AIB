/**
 * The page and the server can't drift: the page's editor bundle (vendor/docs/editor.js, built from server/docs/schema.ts) has the
 * server's exact schema, the bundle and the Deno server pin the same package versions, and a doc goes both ways between them
 * through Yjs updates (the server's y-tiptap and the bundle's y-tiptap, two copies of the libraries) unchanged.
 */
import { assertEquals } from './_assert.ts';
import { LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { parseDoc, type PMJson, schema } from '../../outputs/agent-studio/server/docs/markdown.ts';
import { SCHEMA_VERSION, schemaSummary } from '../../outputs/agent-studio/server/docs/schema.ts';

const ROOT = new URL('../../', import.meta.url);
await import(new URL('outputs/agent-studio/vendor/docs/editor.js', ROOT).href);
const page = (globalThis as unknown as {
  AIBDocEditor: {
    schemaVersion: number;
    schemaSummary(): unknown;
    docJSON(update: Uint8Array): PMJson;
    encode(json: PMJson): Uint8Array;
  };
}).AIBDocEditor;

Deno.test('the page bundle has the server schema', () => {
  assertEquals(page.schemaVersion, SCHEMA_VERSION);
  assertEquals(page.schemaSummary(), schemaSummary(schema as never));
});

Deno.test('the page bundle and the Deno server pin the same versions of the shared packages', () => {
  const deno = JSON.parse(Deno.readTextFileSync(new URL('outputs/agent-studio/deno.json', ROOT))).imports as Record<string, string>;
  const pkg = JSON.parse(Deno.readTextFileSync(new URL('tools/docs-vendor/package.json', ROOT))).dependencies as Record<string, string>;
  let shared = 0;
  for (const [name, spec] of Object.entries(deno)) {
    const m = /^npm:\/?(@?[^@]+)@([^/]+)\/?$/.exec(spec);
    if (!m || !(m[1] in pkg)) continue;
    assertEquals(pkg[m[1]], m[2], name);
    shared++;
  }
  assertEquals(shared, Object.keys(deno).length); // every server import is also in the bundle, at the same version
});

Deno.test('a doc goes server -> page and page -> server through Yjs updates unchanged', () => {
  const text = Deno.readTextFileSync(new URL('work/deno/docs_fixtures/constructs.md', ROOT));
  const live = new LiveDoc();
  live.replaceAll(parseDoc(text).blocks.map((b) => b.node), live.system);
  const server = { type: 'doc', content: live.topBlocks().map((b) => b.node) };
  const seen = page.docJSON(live.encode()); // the page reads the server's state (and checks it against its schema)
  assertEquals(seen, server);
  const back = new LiveDoc(page.encode(seen)); // the page writes a doc, the server reads it
  assertEquals({ type: 'doc', content: back.topBlocks().map((b) => b.node) }, server);
  // an agent edit (with its mark) reads the same on the page
  live.edit([{
    op: 'replace',
    target: { kind: 'find', text: 'Plain paragraph' },
    with: { from: { kind: 'inline', content: 'A paragraph' }, as: 'text' },
  }], live.originFor('agent', 'claude'));
  assertEquals(page.docJSON(live.encode()), { type: 'doc', content: live.topBlocks().map((b) => b.node) });
});
