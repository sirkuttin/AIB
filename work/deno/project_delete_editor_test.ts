/**
 * Removing a project from AIB also deletes the file editor's stored unsaved text for it (server/files/live_files.ts forgetProject,
 * called by server/web/project_routes.ts), never another project's, never the project folder or its aib-shared/ folder. Temp folders only.
 */
import { assert, assertEquals } from './_assert.ts';
import { RemovedProjects } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { projectRemove } from '../../outputs/agent-studio/server/web/project_routes.ts';
import { ConversationState } from '../../outputs/agent-studio/server/state/store.ts';
import { LiveFiles } from '../../outputs/agent-studio/server/files/live_files.ts';

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const exists = async (p: string) => {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("removing a project deletes the editor's stored unsaved text for it only; the folder and its aib-shared/ stay", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: 'aib-project-editor-' }));
  const state = `${root}${SEP}state`, alpha = `${root}${SEP}alpha`, beta = `${root}${SEP}beta`;
  try {
    await Deno.mkdir(state, { recursive: true });
    await Deno.mkdir(`${alpha}${SEP}aib-shared`, { recursive: true });
    await Deno.mkdir(beta, { recursive: true });
    await Deno.writeTextFile(`${alpha}${SEP}aib-shared${SEP}note.md`, 'mine');
    await Deno.writeTextFile(`${alpha}${SEP}a.txt`, 'hello');
    await Deno.writeTextFile(`${beta}${SEP}b.txt`, 'beta');
    const mk = () => new LiveFiles({ stateDir: state, liveCall: () => Promise.resolve([200, { ok: true }]), conversations: () => [], connectionOf: () => null });
    const first = mk();
    for (const [dir, rel] of [[alpha, 'a.txt'], [beta, 'b.txt']]) {
      const got = first.open(dir, rel);
      assert('file' in got, 'opens');
      got.file.text.insert(0, 'unsaved\n');
    }
    first.close(); // writes every unsaved file to the store
    const storeFiles = () => {
      let n = 0;
      try {
        for (const d of Deno.readDirSync(first.storeDir)) {
          for (const f of Deno.readDirSync(`${first.storeDir}${SEP}${d.name}`)) if (f.name.endsWith('.json')) n++;
        }
      } catch { /* no store */ }
      return n;
    };
    assertEquals(storeFiles(), 2);
    const live = mk();
    const ctx = {
      stateDir: state,
      conversations: new ConversationState(state),
      removedProjects: new RemovedProjects(state),
      liveFiles: live,
    };
    const [status] = await projectRemove(ctx, { path: alpha, disk: false });
    assertEquals(status, 200);
    assertEquals(live.stored(alpha).length, 0, "the removed project's text is gone");
    assertEquals(live.stored(beta).length, 1, "the other project's text is untouched");
    assertEquals(storeFiles(), 1);
    assert(await exists(`${alpha}${SEP}aib-shared${SEP}note.md`), 'aib-shared/ untouched');
    assertEquals(await Deno.readTextFile(`${alpha}${SEP}a.txt`), 'hello');
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
