/** Files outside a chat's folder: the transcript-mention guard, every refusal, the folder label, and discovered (non-AIB) chats. */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { git, HAVE_GIT, write } from './_git_repo.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';
import * as outside from '../../outputs/agent-studio/server/worktrees/outside_files.ts';
import { FilesError } from '../../outputs/agent-studio/server/worktrees/files.ts';
import { _mentioned, filesRoutes } from '../../outputs/agent-studio/server/web/files_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';

const WIN = Deno.build.os === 'windows';
const SID = '0d6a1f2e-1111-4222-8333-944455556666';

/** temp/ with other/notes.ts (outside any chat folder), big.txt (over 1 MB), blob.bin, state/ (AIB's data folder) and a saved
 * Claude Code transcript under projects/ that names some of them, plus a subagent transcript naming one more. */
function fixture() {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-outside-' }));
  const p = (...parts: string[]) => osp.join(root, ...parts);
  Deno.mkdirSync(p('other'));
  write(p('other', 'notes.ts'), 'export const a = 1;\n');
  write(p('other', 'secret.ts'), 'never named\n');
  write(p('other', 'by-sub.ts'), 'named by a subagent\n');
  Deno.writeFileSync(p('other', 'big.txt'), new Uint8Array(1024 * 1024 + 10).fill(65));
  Deno.writeFileSync(p('other', 'blob.bin'), new Uint8Array([1, 0, 2, 0]));
  Deno.mkdirSync(p('state'));
  write(p('state', 'settings.json'), '{}');
  Deno.mkdirSync(p('projects', 'C--proj'), { recursive: true });
  const named = [p('other', 'notes.ts'), p('other', 'big.txt'), p('other', 'blob.bin'), p('state', 'settings.json')];
  const rows = named.map((f) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: f } }] },
    })
  );
  write(p('projects', 'C--proj', SID + '.jsonl'), rows.join('\n') + '\n');
  Deno.mkdirSync(p('projects', 'C--proj', SID, 'subagents'), { recursive: true });
  write(
    p('projects', 'C--proj', SID, 'subagents', 'agent-x.jsonl'),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: p('other', 'by-sub.ts') } }] } }) + '\n',
  );
  return { root, p, dispose: () => Deno.removeSync(root, { recursive: true }) };
}

function ctxFor(root: string, live: Record<string, unknown> = {}): WebContext {
  return {
    token: 'tok',
    stateDir: osp.join(root, 'state'),
    host: { liveState: (id: string) => Promise.resolve(live[id] ?? null) },
    conversations: { entries: {} },
    transcripts: { stores: new Map([['claude', { root: osp.join(root, 'projects') }]]) },
    artifacts: { store: { origin: 'http://127.0.0.1:9' }, conversations: () => [] },
  } as unknown as WebContext;
}
const ask = async (ctx: WebContext, query: Record<string, string>, token = 'tok') => {
  _mentioned.clear();
  const handler = filesRoutes().get('GET /api/live/files/outside')!;
  const url = new URL('http://127.0.0.1/api/live/files/outside?' + new URLSearchParams(query));
  return await handler(ctx, url, null, new Request(url, { headers: { 'X-Studio-Token': token } })) as [number, Record<string, unknown>];
};

Deno.test('a discovered chat (provider:session, no live connection): a file its transcript names opens; peek leaves out the text', async () => {
  const f = fixture();
  try {
    const ctx = ctxFor(f.root);
    const [s, read] = await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'notes.ts') });
    assertEquals(s, 200);
    assertEquals(read.text, 'export const a = 1;\n');
    assertEquals(read.name, 'notes.ts');
    assertEquals((read.outside as { kind: string }).kind, 'folder');
    const [s2, peek] = await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'notes.ts'), peek: '1' });
    assertEquals([s2, peek.text], [200, null]);
    // the other slash works too (the page sends what the tool row showed)
    if (WIN) assertEquals((await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'notes.ts').replaceAll('\\', '/') }))[0], 200);
    // a subagent's transcript counts as the chat's own
    assertEquals((await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'by-sub.ts') }))[0], 200);
    assertEquals((await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'notes.ts') }, 'bad'))[0], 403, 'needs the token');
  } finally {
    f.dispose();
  }
});

Deno.test('the mention guard: a path the chat never named is refused (and does not tell whether it exists); a live chat counts its events', async () => {
  const f = fixture();
  try {
    const ctx = ctxFor(f.root, { live1: { cwd: f.root, events: [{ kind: 'tool', rawInput: { file_path: f.p('other', 'secret.ts') } }] } });
    const [s, r] = await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'secret.ts') });
    assertEquals([s, r.code], [403, 'not_mentioned']);
    assertEquals((await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'nothing-here.ts') }))[1].code, 'not_mentioned');
    assertEquals((await ask(ctx, { id: 'claude:other-session', path: f.p('other', 'notes.ts') }))[1].code, 'not_mentioned', 'another chat');
    assertEquals((await ask(ctx, { id: 'live1', path: f.p('other', 'secret.ts') }))[0], 200, 'named by the live chat');
    // a longer name that starts with a named path is not a mention
    write(f.p('other', 'notes.ts.bak'), 'x');
    assertEquals((await ask(ctx, { id: 'claude:' + SID, path: f.p('other', 'notes.ts.bak') }))[1].code, 'not_mentioned');
    assertEquals((await ask(ctx, { path: f.p('other', 'notes.ts') }))[1].code, 'bad_chat');
  } finally {
    f.dispose();
  }
});

Deno.test('refusals: network, device, relative, `..`, streams, AIB data folder, folders; big and binary files get flags, no text', async () => {
  const f = fixture();
  try {
    const shapes = [
      '\\\\srv\\share\\x.ts',
      '//srv/share/x.ts',
      '\\\\?\\C:\\x.ts',
      '\\\\.\\PhysicalDrive0',
      'C:\\x\\NUL',
      'C:\\x\\con.txt',
      'C:\\x\\COM1',
      'relative\\x.ts',
      'C:\\x\\..\\y.ts',
      '/a/../b.ts',
      'C:\\x\\a.ts:stream',
      'C:\\x\\.git\\config',
      'a\0b',
      '',
    ];
    for (const bad of shapes) {
      let threw = false;
      try {
        outside.checkShape(bad);
      } catch (e) {
        threw = e instanceof FilesError;
      }
      assert(threw, JSON.stringify(bad));
    }
    const ctx = ctxFor(f.root);
    const id = 'claude:' + SID;
    assertEquals((await ask(ctx, { id, path: '\\\\srv\\share\\x.ts' }))[1].code, 'bad_path');
    assertEquals(
      (await ask(ctx, { id, path: f.p('other') + osp.SEP + '..' + osp.SEP + 'other' + osp.SEP + 'notes.ts' }))[1].code,
      'bad_path',
    );
    // AIB's data folder: refused even though the transcript names the file
    const [sd, data] = await ask(ctx, { id, path: f.p('state', 'settings.json') });
    assertEquals([sd, data.code], [403, 'hidden']);
    // over 1 MB and binary: the read answers with flags (the page shows its note and "Open in editor"), never the text
    const [, big] = await ask(ctx, { id, path: f.p('other', 'big.txt') });
    assertEquals([big.tooBig, big.text], [true, null]);
    const [, bin] = await ask(ctx, { id, path: f.p('other', 'blob.bin') });
    assertEquals([bin.binary, bin.text], [true, null]);
    // a folder, or a named file that is gone
    assertThrows(() => outside.resolveOutside(f.p('other'), []), FilesError);
    Deno.removeSync(f.p('other', 'notes.ts'));
    assertEquals((await ask(ctx, { id, path: f.p('other', 'notes.ts') }))[0], 404);
  } finally {
    f.dispose();
  }
});

Deno.test({
  name: 'folder label: "⎇ branch · git worktree of repo", "⎇ branch" for an ordinary repo, the folder path otherwise',
  ignore: !HAVE_GIT,
  fn: () => {
    const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-outside-label-' }));
    try {
      const repo = osp.join(root, 'AIB');
      Deno.mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      write(osp.join(repo, 'a.ts'), 'a');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'base');
      const wt = osp.join(root, 'AIB-keeper-terms');
      git(repo, 'worktree', 'add', '-q', '-b', 'keeper-terms', wt);
      Deno.mkdirSync(osp.join(wt, 'work', 'deno'), { recursive: true });
      write(osp.join(wt, 'work', 'deno', 'keeper_terminal_test.ts'), 'x');
      const w = outside.folderLabel(osp.join(wt, 'work', 'deno', 'keeper_terminal_test.ts'));
      assertEquals([w.kind, w.branch, w.repo, w.text], ['worktree', 'keeper-terms', 'AIB', '⎇ keeper-terms · git worktree of AIB']);
      const r = outside.folderLabel(osp.join(repo, 'a.ts'));
      assertEquals([r.kind, r.text], ['repo', '⎇ main']);
      Deno.mkdirSync(osp.join(root, 'plain'));
      const plain = osp.join(root, 'plain', 'c.ts');
      write(plain, 'c');
      const l = outside.folderLabel(plain);
      assertEquals([l.kind, l.text], ['folder', osp.join(root, 'plain')]);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  },
});

Deno.test('mentions: whole paths only, either slash, JSON-escaped', () => {
  const p = WIN ? 'C:\\w\\x\\a.ts' : '/w/x/a.ts';
  assert(outside.mentions([JSON.stringify({ file_path: p })], p));
  assert(outside.mentions(['wrote ' + p + ' ok'], p));
  assert(!outside.mentions(['wrote ' + p + 'x'], p));
  assert(!outside.mentions(['nothing'], p));
  if (WIN) assert(outside.mentions(['C:/w/x/A.ts'], p), 'case and slash on Windows');
});
