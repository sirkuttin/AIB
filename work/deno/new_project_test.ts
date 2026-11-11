/**
 * New project with a name: GET /api/live/folders/check?path=&name= and POST /api/live/folders/create {path, name} make or use
 * <folder>\<name> inside an existing folder. The real route handlers from studioRoutes() are called with a minimal context; every
 * folder is a temp folder, git is never run (gitInit false, or a fake runner).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import {
  checkProject,
  createProject,
  FolderError,
  FolderMemory,
  normalizeFolder,
  validateName,
} from '../../outputs/agent-studio/server/desktop/folders.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';

const WIN = Deno.build.os === 'windows';

function tempDir(): string {
  return Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'studio-newproj-' }));
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof FolderError) return error.code;
    throw error;
  }
  return 'ok';
}

Deno.test('the Folder box is tidied: drive letter case, trailing separators, / vs \\', () => {
  assertEquals(normalizeFolder('c:\\REPOS\\', true), 'C:\\REPOS');
  assertEquals(normalizeFolder(' c:/REPOS// ', true), 'C:\\REPOS');
  assertEquals(normalizeFolder('d:\\', true), 'D:\\');
  assertEquals(normalizeFolder('C:\\\\', true), 'C:\\');
  assertEquals(normalizeFolder('C:\\a\\b', true), 'C:\\a\\b');
  assertEquals(normalizeFolder('relative\\', true), 'relative\\', 'left as is for validatePath to refuse');
  assertEquals(normalizeFolder('\\\\srv\\share\\', true), '\\\\srv\\share\\', 'network paths are not touched');
  assertEquals(normalizeFolder('/home/me/', false), '/home/me');
  assertEquals(normalizeFolder('/', false), '/');
  assertEquals(normalizeFolder('', true), '');
  assertEquals(normalizeFolder(5, true), '');
});

Deno.test('project names: one level, nothing Windows refuses, no . or .., not empty', () => {
  const cases: Record<string, string> = {
    spaghetti: 'ok',
    '  spaghetti  ': 'ok',
    'my app': 'ok',
    'app.v2': 'ok',
    '': 'empty_name',
    '   ': 'empty_name',
    '.': 'escape',
    '..': 'escape',
    '..\\x': 'escape',
    'a/b': 'escape',
    'a\\b': 'escape',
    'C:x': 'invalid_name',
    'a<b': 'invalid_name',
    'a|b': 'invalid_name',
    'a?': 'invalid_name',
    'a*': 'invalid_name',
    '"q"': 'invalid_name',
    'dot.': 'invalid_name',
    CON: 'invalid_name',
    con: 'invalid_name',
    'nul.txt': 'invalid_name',
    COM1: 'invalid_name',
    LPT9: 'invalid_name',
    COM10: 'ok',
    console: 'ok',
    'tab\there': 'invalid_name',
  };
  for (const [name, expected] of Object.entries(cases)) assertEquals(code(() => validateName(name, true)), expected, JSON.stringify(name));
  assertEquals(validateName('  spaghetti ', true), 'spaghetti');
  assertEquals(code(() => validateName('x'.repeat(256), true)), 'invalid_name');
  assertEquals(code(() => validateName('a\\b', false)), 'ok', 'a backslash is an ordinary character on POSIX');
  assertEquals(code(() => validateName('a/b', false)), 'escape');
  assertEquals(code(() => validateName('CON', false)), 'ok');
  assertEquals(code(() => validateName(null, true)), 'empty_name');
});

Deno.test({ name: 'check with a name: creates, uses an existing one, refuses bad names (Windows)', ignore: !WIN }, () => {
  const dir = tempDir();
  try {
    // The owner's case, with a lower-case drive letter and a trailing backslash.
    const typed = dir[0].toLowerCase() + dir.slice(1) + '\\';
    const fresh = checkProject(typed, 'spaghetti');
    assertEquals(
      [fresh.valid, fresh.exists, fresh.reason, fresh.path, fresh.folder, fresh.name, fresh.field],
      [true, false, 'new', dir + '\\spaghetti', dir, 'spaghetti', ''],
    );
    assert(!osp.exists(dir + '\\spaghetti'), 'a check never creates anything');
    Deno.mkdirSync(dir + '\\old');
    const old = checkProject(dir, ' old ');
    assertEquals([old.valid, old.exists, old.reason, old.path], [true, true, 'existing', dir + '\\old']);
    // Without a name: the folder itself, as before, trailing backslash or not.
    const self = checkProject(dir + '\\', '');
    assertEquals([self.valid, self.exists, self.path, self.folder], [true, true, dir, undefined]);
    const selfNew = checkProject(dir + '\\made\\', '   ');
    assertEquals([selfNew.valid, selfNew.exists, selfNew.reason, selfNew.path], [true, false, 'new', dir + '\\made']);
    // Bad names belong to the name box; the folder is fine.
    for (const [name, reason] of [['CON', 'invalid_name'], ['..', 'escape'], ['a\\b', 'escape'], ['a:b', 'invalid_name']]) {
      const bad = checkProject(dir, name);
      assertEquals([bad.valid, bad.reason, bad.field, bad.folder], [false, reason, 'name', dir], name);
      assert(bad.message.length > 0);
    }
    Deno.writeTextFileSync(dir + '\\f.txt', 'x');
    const file = checkProject(dir, 'f.txt');
    assertEquals([file.valid, file.reason, file.field], [false, 'not_a_folder', 'name']);
    // A missing folder with a name: two levels are never made.
    const missing = checkProject(dir + '\\nope', 'x');
    assertEquals([missing.valid, missing.reason, missing.field], [false, 'folder_missing', 'folder']);
    assert(missing.message.includes("doesn't exist"));
    // Traversal in the folder is refused before anything else.
    const escape = checkProject(dir + '\\..\\x', 'y');
    assertEquals([escape.valid, escape.reason, escape.field], [false, 'escape', 'folder']);
    const unc = checkProject('\\\\srv\\share', 'y');
    assertEquals([unc.valid, unc.reason], [false, 'relative']);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test(
  { name: 'createProject makes one level, uses an existing folder, never runs git when asked not to (Windows)', ignore: !WIN },
  async () => {
    const dir = tempDir();
    try {
      const made = await createProject(dir + '\\', 'spaghetti', false);
      assertEquals([made.path, made.git, made.existed], [dir + '\\spaghetti', false, undefined]);
      assert(osp.isdir(made.path));
      Deno.writeTextFileSync(made.path + '\\keep.txt', 'data');
      const again = await createProject(dir, 'spaghetti', true, () => {
        throw new Error('git must not run for an existing folder');
      });
      assertEquals([again.path, again.existed, again.git], [dir + '\\spaghetti', true, false]);
      assertEquals(Deno.readTextFileSync(made.path + '\\keep.txt'), 'data');
      const runs: string[][] = [];
      const withGit = await createProject(dir, 'repo', true, (command) => {
        runs.push(command);
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      });
      assertEquals(withGit.git, true);
      assertEquals(runs.length, 1);
      assertEquals(runs[0].slice(1), ['init']);
      for (const [folder, name] of [[dir, ''], [dir, '..'], [dir, 'a\\b'], [dir, 'CON'], [dir + '\\nope', 'x'], [dir + '\\..', 'x']]) {
        await assertRejects(() => createProject(folder, name, false), FolderError);
      }
      assertEquals([...Deno.readDirSync(dir)].map((e) => e.name).sort(), ['repo', 'spaghetti']);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
);

// ---- the routes ------------------------------------------------------------------------------------------------------
type Reply = [number, Record<string, unknown>];

function routeCtx(): WebContext {
  return { folderMemory: new FolderMemory(null) } as unknown as WebContext;
}

async function getCheck(ctx: WebContext, path: string, name?: string): Promise<Reply> {
  const handler = studioRoutes().get('GET /api/live/folders/check')!;
  const url = new URL('http://127.0.0.1/api/live/folders/check');
  url.searchParams.set('path', path);
  if (name !== undefined) url.searchParams.set('name', name);
  return await handler(ctx, url, null, new Request(url)) as Reply;
}

async function postCreate(ctx: WebContext, body: Record<string, unknown>): Promise<Reply> {
  const handler = studioRoutes().get('POST /api/live/folders/create')!;
  const url = new URL('http://127.0.0.1/api/live/folders/create');
  return await handler(ctx, url, body, new Request(url, { method: 'POST' })) as Reply;
}

Deno.test({ name: 'routes: check and create with a name (Windows)', ignore: !WIN }, async () => {
  const dir = tempDir();
  const ctx = routeCtx();
  try {
    const typed = dir[0].toLowerCase() + dir.slice(1) + '\\';
    const [status, check] = await getCheck(ctx, typed, 'spaghetti');
    assertEquals([status, check.valid, check.exists, check.path, check.folder], [200, true, false, dir + '\\spaghetti', dir]);
    // Create: the server makes the folder and remembers the folder it went in.
    const [s1, made] = await postCreate(ctx, { path: typed, name: 'spaghetti', gitInit: false });
    assertEquals([s1, made.path, made.git], [200, dir + '\\spaghetti', false]);
    assert(osp.isdir(dir + '\\spaghetti'));
    assertEquals(ctx.folderMemory.get(), dir);
    // Again: the existing folder is used, not an error.
    const [s2, used] = await postCreate(ctx, { path: dir, name: 'spaghetti', gitInit: false });
    assertEquals([s2, used.path, used.existed], [200, dir + '\\spaghetti', true]);
    const [, nowThere] = await getCheck(ctx, dir, 'spaghetti');
    assertEquals([nowThere.valid, nowThere.exists], [true, true]);
    // Invalid names and traversal: 400 with a message, nothing made.
    for (const name of ['CON', '..', '..\\..\\x', 'a/b', 'x?', '   ']) {
      const [s, err] = await postCreate(ctx, { path: dir, name, gitInit: false });
      assertEquals(s, 400, name);
      assert(typeof err.error === 'string' && err.error.length > 0, name);
    }
    const [s3, err3] = await postCreate(ctx, { path: dir + '\\..\\elsewhere', name: 'x', gitInit: false });
    assertEquals([s3, err3.code], [400, 'escape']);
    const [, badCheck] = await getCheck(ctx, dir, 'nul.txt');
    assertEquals([badCheck.valid, badCheck.field], [false, 'name']);
    const refused = await assertRejects(() => postCreate(ctx, { path: dir, name: 5 }), Error) as Error;
    assertEquals(refused.message, 'Invalid request');
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ['spaghetti']);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({ name: 'routes: no name keeps the old behaviour, with a tidied folder (Windows)', ignore: !WIN }, async () => {
  const dir = tempDir();
  const ctx = routeCtx();
  try {
    const [, self] = await getCheck(ctx, dir + '\\');
    assertEquals([self.valid, self.exists, self.reason, self.path], [true, true, 'existing', dir]);
    assert(!('folder' in self), 'the no-name answer has the old shape');
    const [s1, made] = await postCreate(ctx, { path: dir + '\\fresh\\', gitInit: false });
    assertEquals([s1, made.path], [200, dir + '\\fresh']);
    const [s2, again] = await postCreate(ctx, { path: dir + '\\fresh', gitInit: false });
    assertEquals([s2, again.code], [400, 'exists']);
    const [s3] = await postCreate(ctx, { path: dir + '\\a\\b', gitInit: false });
    assertEquals(s3, 400, 'never two levels');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
