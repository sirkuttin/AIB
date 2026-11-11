/**
 * "Delete project…" (server/desktop/project_delete.ts, server/web/project_routes.ts). Temp folders only, never a real folder.
 * The OS trash is mocked except for one real Recycle Bin run on Windows, done in a child process on an invisible desktop.
 */
import { assert, assertEquals } from './_assert.ts';
import {
  deleteFolder,
  type Guard,
  inspect,
  osTrash,
  projectKey,
  refusal,
  Refused,
  RemovedProjects,
  type TrashKind,
  type TrashLayer,
  worktreeOf,
} from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { afterConnect, bringBack, projectRemove, restoreFolders } from '../../outputs/agent-studio/server/web/project_routes.ts';
import { ConversationState } from '../../outputs/agent-studio/server/state/store.ts';

const WINDOWS = Deno.build.os === 'windows';
const SEP = WINDOWS ? '\\' : '/';

async function temp(): Promise<{ root: string; state: string; project: string; cleanup: () => Promise<void> }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: 'aib-project-delete-' }));
  const state = `${root}${SEP}state`, project = `${root}${SEP}work${SEP}alpha`;
  await Deno.mkdir(state, { recursive: true });
  await Deno.mkdir(`${project}${SEP}src`, { recursive: true });
  await Deno.writeTextFile(`${project}${SEP}src${SEP}a.txt`, 'hello');
  return { root, state, project, cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}) };
}
const exists = async (p: string) => {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
};
/** A trash that records what it was asked and "moves" the folder by deleting it. */
function mockTrash(kind: TrashKind): TrashLayer & { calls: [string, TrashKind][] } {
  const calls: [string, TrashKind][] = [];
  return {
    calls,
    kind: () => Promise.resolve(kind),
    async trash(path, k) {
      calls.push([path, k]);
      await Deno.remove(path, { recursive: true });
    },
  };
}
const guardFor = (state: string, projects: string[] = [], home = WINDOWS ? 'C:\\Users\\nobody-here' : '/home/nobody-here'): Guard => ({
  home,
  own: [state],
  projects,
  remoteDrive: () => false,
});
function ctxFor(state: string, layer: TrashLayer, projects: string[] = []) {
  return {
    stateDir: state,
    conversations: new ConversationState(state),
    removedProjects: new RemovedProjects(state),
    trashLayer: layer,
    guard: (others: string[]) => guardFor(state, others.concat(projects)),
  };
}

Deno.test('project keys match the page (sidebar-ui.js pathKey)', () => {
  assertEquals(projectKey('C:\\Repos\\App\\'), 'w:c:/repos/app');
  assertEquals(projectKey('c:/repos//app'), 'w:c:/repos/app');
  assertEquals(projectKey('/home/me/app'), 'p:home/me/app');
  assertEquals(projectKey(''), '');
});

Deno.test('remove from AIB is remembered in the data folder and survives a reload; the folder stays on disk', async () => {
  const t = await temp();
  try {
    const ctx = ctxFor(t.state, mockTrash('recycle'));
    const [status, payload] = await projectRemove(ctx, { path: t.project, disk: false });
    assertEquals(status, 200);
    assertEquals(payload.disk, 'kept');
    assert(await exists(`${t.project}${SEP}src${SEP}a.txt`), 'the folder is untouched');
    assert(await exists(`${t.state}${SEP}studio-removed-projects.json`), 'saved in the data folder');
    // A new Studio (a restart, or another window) reading the same data folder: the project is still gone.
    const again = new RemovedProjects(t.state);
    assert(again.has(t.project));
    assertEquals(Object.keys(again.public().removed), [projectKey(t.project)]);
    assertEquals(again.public().removed[projectKey(t.project)].path, t.project);
  } finally {
    await t.cleanup();
  }
});

Deno.test('a new chat started in the folder brings the project back; a failed connect does not', async () => {
  const t = await temp();
  try {
    const removed = new RemovedProjects(t.state);
    await removed.remove(t.project);
    await afterConnect(removed, { cwd: t.project, provider: 'claude' }, 500);
    assert(removed.has(t.project), 'a connect that failed changes nothing');
    await afterConnect(removed, { cwd: t.project.toUpperCase(), provider: 'claude' }, 200);
    assertEquals(new RemovedProjects(t.state).has(t.project), !WINDOWS, 'same folder, other case: back on Windows');
    await afterConnect(removed, { cwd: t.project, provider: 'claude' }, 200);
    assert(!new RemovedProjects(t.state).has(t.project), 'the project is back, also for a fresh reader');
  } finally {
    await t.cleanup();
  }
});

Deno.test('restoring one of its chats from Recently deleted brings the project back', async () => {
  const t = await temp();
  try {
    const conversations = new ConversationState(t.state);
    const removed = new RemovedProjects(t.state);
    await conversations.apply('delete', 'claude', 's1', 'A chat', t.project, false, '', t.project);
    await removed.remove(t.project);
    const body = { action: 'restore', provider: 'claude', sessionId: 's1' };
    const folders = restoreFolders(conversations, body);
    await conversations.apply('restore', 'claude', 's1');
    await bringBack(removed, folders);
    assert(!removed.has(t.project));
    assertEquals(restoreFolders(conversations, { action: 'delete', provider: 'claude', sessionId: 's1' }), [], 'only restore');
  } finally {
    await t.cleanup();
  }
});

Deno.test('delete from disk: to the trash the server named, then removed from AIB', async () => {
  const t = await temp();
  try {
    const layer = mockTrash('recycle');
    const ctx = ctxFor(t.state, layer);
    const [, info] = await projectRemove(ctx, { check: true, path: t.project });
    assertEquals([info.exists, info.refusal, info.trash, info.worktreeOf], [true, '', 'recycle', '']);
    assert(await exists(t.project), 'check changes nothing');
    const [status, payload] = await projectRemove(ctx, { path: t.project, disk: true, expect: 'recycle' });
    assertEquals(status, 200);
    assertEquals(payload.disk, 'recycle');
    assertEquals(layer.calls.length, 1);
    assert(!(await exists(t.project)));
    assert(ctx.removedProjects.has(t.project));
  } finally {
    await t.cleanup();
  }
});

Deno.test('delete from disk with no trash: permanent only when the page said so', async () => {
  const t = await temp();
  try {
    const layer = mockTrash('permanent');
    const ctx = ctxFor(t.state, layer);
    const [, info] = await projectRemove(ctx, { check: true, path: t.project });
    assertEquals(info.trash, 'permanent');
    const [refused, why] = await projectRemove(ctx, { path: t.project, disk: true, expect: 'recycle' });
    assertEquals(refused, 409);
    assert(String(why.error).includes('permanently'));
    assert(await exists(t.project), 'nothing deleted');
    assert(!ctx.removedProjects.has(t.project), 'and not removed from AIB either');
    const [ok, payload] = await projectRemove(ctx, { path: t.project, disk: true, expect: 'permanent' });
    assertEquals([ok, payload.disk], [200, 'permanent']);
    assert(!(await exists(t.project)));
    assertEquals(layer.calls.length, 0, 'the trash was never asked');
  } finally {
    await t.cleanup();
  }
});

Deno.test('a folder that does not exist is only removed from AIB', async () => {
  const t = await temp();
  try {
    const layer = mockTrash('recycle');
    const ctx = ctxFor(t.state, layer);
    const gone = `${t.root}${SEP}not-there`;
    const [, info] = await projectRemove(ctx, { check: true, path: gone });
    assertEquals([info.exists, info.refusal], [false, '']);
    const [status, payload] = await projectRemove(ctx, { path: gone, disk: true, expect: 'recycle' });
    assertEquals([status, payload.disk], [200, 'missing']);
    assert(ctx.removedProjects.has(gone));
    assertEquals(layer.calls.length, 0);
  } finally {
    await t.cleanup();
  }
});

Deno.test('every refusal: drive root, home and its standard folders, AIB folders, other projects, network paths', async () => {
  const t = await temp();
  try {
    const home = `${t.root}${SEP}home`;
    for (const n of ['Documents', 'Desktop', 'Downloads', 'code']) await Deno.mkdir(`${home}${SEP}${n}`, { recursive: true });
    const other = `${t.root}${SEP}work${SEP}alpha${SEP}nested`;
    await Deno.mkdir(other, { recursive: true });
    const g: Guard = { home, own: [t.state, `${t.root}${SEP}app`], projects: [other, `${t.root}${SEP}outer`], remoteDrive: () => false };
    const says = (p: string, word: RegExp) => assert(word.test(refusal(p, g)), `${p}: "${refusal(p, g)}"`);
    says(WINDOWS ? 'C:\\' : '/', /drive root/);
    if (WINDOWS) says('D:', /drive root/);
    says(home, /home folder/);
    says(t.root, /home folder/); // holds the home folder
    says(`${home}${SEP}Documents`, /Documents/);
    says(`${home}${SEP}Desktop`, /Desktop/);
    says(`${home}${SEP}Downloads`, /Downloads/);
    assertEquals(refusal(`${home}${SEP}code`, g), '', 'any other folder in home is fine');
    says(t.state, /AIB's own/);
    says(`${t.state}${SEP}sub`, /AIB's own/);
    says(`${t.root}${SEP}app`, /AIB's own/);
    says(t.project, /holds another AIB project/);
    says(`${t.root}${SEP}outer${SEP}inner`, /inside another AIB project/);
    says('\\\\server\\share\\project', /network/);
    says('//server/share/project', /network/);
    if (WINDOWS) {
      const remote: Guard = { ...g, remoteDrive: (root) => root === 'Z:\\' };
      assert(/network/.test(refusal('Z:\\work\\proj', remote)), 'a mapped network drive');
    }
    // Through the route: refused before anything happens, and the dialog learns why from the check.
    const layer = mockTrash('recycle');
    const ctx = { ...ctxFor(t.state, layer), guard: () => g };
    const [, info] = await projectRemove(ctx, { check: true, path: t.project });
    assert(/holds another AIB project/.test(String(info.refusal)));
    const [status, payload] = await projectRemove(ctx, { path: t.project, disk: true, expect: 'recycle' });
    assertEquals([status, payload.code], [409, 'refused']);
    assert(await exists(t.project) && layer.calls.length === 0 && !ctx.removedProjects.has(t.project));
    await assertRefused(() => deleteFolder(home, g, 'recycle', layer));
  } finally {
    await t.cleanup();
  }
});
async function assertRefused(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Refused) return;
    throw error;
  }
  throw new Error('expected a refusal');
}

Deno.test('a git worktree of another repo is named, so the warning can say so', async () => {
  const t = await temp();
  try {
    await Deno.writeTextFile(`${t.project}${SEP}.git`, `gitdir: ${t.root}${SEP}repo${SEP}.git${SEP}worktrees${SEP}alpha\n`);
    const repo = `${t.root}${SEP}repo`;
    assertEquals(await worktreeOf(t.project), repo);
    const info = await inspect(t.project, guardFor(t.state), mockTrash('recycle'));
    assertEquals(info.worktreeOf, repo);
    await Deno.remove(`${t.project}${SEP}.git`);
    await Deno.mkdir(`${t.project}${SEP}.git`);
    assertEquals(await worktreeOf(t.project), '', 'a normal repo is not a worktree');
  } finally {
    await t.cleanup();
  }
});

Deno.test({
  name: 'Windows: a real temp folder goes to the Recycle Bin silently (child process on an invisible desktop)',
  ignore: !WINDOWS,
  async fn() {
    const { HiddenDesktop } = await import('./_hidden_desktop.ts');
    const t = await temp();
    const desk = new HiddenDesktop();
    try {
      assertEquals(await osTrash.kind(t.project), 'recycle', 'the temp drive has a Recycle Bin');
      const out = `${t.root}${SEP}result.txt`;
      const child = `${t.root}${SEP}child.ts`;
      const mod = new URL('../../outputs/agent-studio/server/desktop/project_delete.ts', import.meta.url).href;
      await Deno.writeTextFile(
        child,
        `import { osTrash } from ${JSON.stringify(mod)};\n` +
          `const [path, out] = Deno.args;\n` +
          `try { await osTrash.trash(path, 'recycle'); await Deno.writeTextFile(out, 'ok'); }\n` +
          `catch (e) { await Deno.writeTextFile(out, 'error: ' + e.message); }\n`,
      );
      const pid = desk.spawn([Deno.execPath(), 'run', '-A', '--no-lock', child, t.project, out], t.root);
      let result = '';
      for (let i = 0; i < 120 && !result; i++) {
        await new Promise((r) => setTimeout(r, 250));
        result = await Deno.readTextFile(out).catch(() => '');
      }
      // Anything but the child's own console (it runs on the invisible desktop) would be a dialog or progress window.
      const shown = desk.windows().filter((w) =>
        w.visible && w.title && !/^(Default IME|MSCTFIME UI)$/.test(w.title) &&
        !/^(ConsoleWindowClass|PseudoConsoleWindow|CASCADIA_HOSTING_WINDOW_CLASS)$/.test(w.cls)
      );
      try {
        Deno.kill(pid);
      } catch { /* already gone */ }
      assertEquals(result, 'ok');
      assert(!(await exists(t.project)), 'the folder left its place');
      assertEquals(shown.map((w) => w.title), [], 'no dialog or window');
    } finally {
      desk.close();
      await t.cleanup();
    }
  },
});
