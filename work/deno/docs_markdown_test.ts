/**
 * Local docs' Markdown: every construct both ways, and the round trip through the real path (file -> Y.Doc via y-tiptap -> file)
 * on real Markdown files: an unchanged file comes out byte for byte (LF and CRLF), and every block written fresh parses back to the
 * same block. AIB_DOCS_CORPUS=<folder> adds a folder of .md files (the editor evaluation's 27 files).
 */
import { assert, assertEquals } from './_assert.ts';
import { DocStore } from '../../outputs/agent-studio/server/docs/store.ts';
import { blockMarkdown, normalize, parseDoc, parseInline, type PMJson } from '../../outputs/agent-studio/server/docs/markdown.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REPO_FILES = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  'keeper/PROTOCOL.md',
  'outputs/agent-studio/README.md',
  'outputs/agent-studio/docs/CAPABILITIES.md',
  'outputs/agent-studio/docs/DESKTOP.md',
  'outputs/agent-studio/docs/FRONTEND.md',
  'outputs/agent-studio/docs/THEMES.md',
  'outputs/agent-studio/docs/acp-v2-evaluation.md',
  'outputs/agent-studio/docs/agent-host.md',
  'outputs/agent-studio/docs/client-capabilities.md',
  'outputs/agent-studio/docs/models-and-settings.md',
  'outputs/agent-studio/docs/ownership-design.md',
  'work/demo-studio/README.md',
  'work/files-fixture/notes.md',
  'work/deno/docs_fixtures/constructs.md',
];

const types = (nodes: PMJson[]): unknown =>
  nodes.map((n) => (n.content && n.type !== 'paragraph' && n.type !== 'heading' ? [n.type, types(n.content)] : n.type));

Deno.test('Markdown in: links, images, tables, task lists, nested lists, fences, quotes, rules, front matter, raw HTML, CRLF', () => {
  const text = Deno.readTextFileSync(`${ROOT}work/deno/docs_fixtures/constructs.md`).replace(/\r\n/g, '\n');
  for (const eol of ['\n', '\r\n']) {
    const doc = parseDoc(text.replace(/\n/g, eol));
    assertEquals(doc.eol, eol);
    const nodes = doc.blocks.map((b) => normalize(b.node));
    const byType = (t: string) => nodes.filter((n) => n.type === t);
    assertEquals(nodes[0], {
      type: 'rawBlock',
      attrs: { kind: 'frontmatter', text: '---\ntitle: Constructs test\ntags: [docs, test]\n---' },
    });
    assertEquals(byType('heading').map((h) => h.attrs!.level), [1, 1, 2, 2, 2, 2, 2]);
    assertEquals(byType('taskList').length, 1);
    assertEquals(byType('taskList')[0].content![1].attrs, { checked: true });
    assertEquals(types([byType('orderedList')[0]]), [['orderedList', [['listItem', ['paragraph', ['bulletList', [['listItem', [
      'paragraph',
      [
        'bulletList',
        [['listItem', ['paragraph']]],
      ],
    ]]]]]], ['listItem', ['paragraph', ['orderedList', [['listItem', ['paragraph']], ['listItem', ['paragraph']]]]]]]]]);
    assertEquals(byType('orderedList')[1].attrs!.start, 3);
    const table = byType('table')[0];
    assertEquals(table.content![0].content!.map((c) => [c.type, c.attrs!.align]), [['tableHeader', 'left'], ['tableHeader', 'center'], [
      'tableHeader',
      'right',
    ]]);
    assertEquals(table.content![1].content![0].content![0].content, [{ type: 'text', text: 'a ' }, {
      type: 'text',
      text: 'x|y',
      marks: [{ type: 'code' }],
    }]);
    assertEquals(byType('codeBlock').map((c) => [c.attrs!.language, c.content?.[0].text]), [
      ['ts', 'const x: number = 1;'],
      [null, 'tilde fence, no language'],
      [null, 'indented code'],
    ]);
    assertEquals(byType('rawBlock').map((r) => r.attrs!.kind), ['frontmatter', 'html', 'html', 'linkdef']);
    assertEquals(byType('rawBlock')[1].attrs!.text, '<details>\n<summary>More</summary>');
    assertEquals(byType('blockquote')[0].content!.map((c) => c.type), ['paragraph', 'bulletList']);
    assertEquals(byType('horizontalRule').length, 1);
    const last = byType('paragraph').at(-1)!.content!;
    assertEquals(last[0], { type: 'image', attrs: { src: 'img.png', alt: 'Alt', title: 'Title', width: null, height: null, href: null } });
    assertEquals(last.at(-1)!.attrs!.href, 'https://example.com/ci');
  }
  // inline details
  assertEquals(parseInline('a **b *c* d** e'), [
    { type: 'text', text: 'a ' },
    { type: 'text', text: 'b ', marks: [{ type: 'bold' }] },
    { type: 'text', text: 'c', marks: [{ type: 'bold' }, { type: 'italic' }] },
    { type: 'text', text: ' d', marks: [{ type: 'bold' }] },
    { type: 'text', text: ' e' },
  ]);
  assertEquals(parseInline('snake_case_name and 2 * 3 * 4'), [{ type: 'text', text: 'snake_case_name and 2 * 3 * 4' }]);
  assertEquals(parseInline('x <kbd>K</kbd>').map((n) => n.type), ['text', 'htmlInline', 'text', 'htmlInline']);
});

Deno.test('Markdown out: each construct written fresh parses back to the same block', () => {
  const text = Deno.readTextFileSync(`${ROOT}work/deno/docs_fixtures/constructs.md`);
  for (const b of parseDoc(text).blocks) {
    const out = blockMarkdown(b.node, b.style ?? {});
    assert(!out.lossy, `${b.node.type} does not round-trip: ${out.md}`);
  }
  assertEquals(
    blockMarkdown({ type: 'paragraph', content: [{ type: 'text', text: '# not a heading *really*' }] }).md,
    '\\# not a heading \\*really\\*',
  );
});

async function roundTrip(
  store: DocStore,
  project: string,
  name: string,
  text: string,
): Promise<{ same: boolean; lossy: number; blocks: number }> {
  await Deno.writeTextFile(`${project}${sep}docs${sep}${name}.md`, text);
  const doc = await store.open(project, name);
  await store.flush(doc);
  const after = await Deno.readTextFile(doc.mirrorPath);
  let lossy = 0;
  const blocks = doc.live.topBlocks();
  for (const b of blocks) {
    if (blockMarkdown(b.node).lossy) {
      lossy++;
      console.log('lossy:', name, JSON.stringify(b.node).slice(0, 300)); // shows what to fix
    }
  }
  return { same: after === text, lossy, blocks: blocks.length };
}

Deno.test('round trip through the Y.Doc: unchanged files come out byte for byte (LF and CRLF), every block re-parses the same', async () => {
  const root = Deno.realPathSync(await Deno.makeTempDir({ prefix: 'aib-docs-rt-' })).replace(/^\\\\\?\\/, '');
  const project = `${root}${sep}project`;
  await Deno.mkdir(`${project}${sep}docs`, { recursive: true });
  const store = new DocStore(`${root}${sep}state`, { idleMs: 60_000 });
  const files: [string, string][] = REPO_FILES.map((f) => [f, Deno.readTextFileSync(`${ROOT}${f}`)]);
  const extra = Deno.env.get('AIB_DOCS_CORPUS');
  if (extra) {
    for (const e of [...Deno.readDirSync(extra)].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.endsWith('.md')) files.push([`corpus/${e.name}`, Deno.readTextFileSync(`${extra}${sep}${e.name}`)]);
    }
  }
  try {
    let n = 0, same = 0, lossy = 0, blocks = 0;
    const bad: string[] = [];
    for (const [path, text] of files) {
      const variants = path.startsWith('corpus/') ? [text] : [text, text.replace(/\r?\n/g, '\r\n')];
      for (const v of variants) {
        const r = await roundTrip(store, project, `f${n++}`, v);
        if (r.same) same++;
        else bad.push(path);
        lossy += r.lossy;
        blocks += r.blocks;
      }
    }
    console.log(`round trip: ${same}/${n} files byte-identical; ${blocks - lossy}/${blocks} top-level blocks re-parse the same`);
    if (extra) {
      const corpus = files.filter(([p]) => p.startsWith('corpus/')).length;
      console.log(`AIB_DOCS_CORPUS: ${corpus} files included`);
    }
    assertEquals(bad, []);
    assertEquals(lossy, 0);
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
