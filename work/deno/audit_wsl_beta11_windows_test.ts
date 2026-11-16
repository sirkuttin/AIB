/**
 * WSL audit (docs/wsl/audit-beta10.md), multi-window (integration/beta11, feat/mw-*): a WSL project's window request, URL and saved
 * restore. The modules exist only once integration/beta11 is merged: on this branch every test is skipped (the import is dynamic).
 * Run on the merged tree: deno test -A ../../work/deno/audit_wsl_beta11_windows_test.ts (from outputs/agent-studio).
 */
import { assert, assertEquals } from './_assert.ts';

const base = new URL('../../outputs/agent-studio/server/desktop/', import.meta.url);
const has = (() => {
  try {
    Deno.statSync(new URL('windows_contract.ts', base));
    return true;
  } catch {
    return false;
  }
})();
const T = { ignore: !has, sanitizeResources: false, sanitizeOps: false };
const REF = 'wsl://ubuntu/home/u/app';
const KEY = 'p:wsl:/ubuntu/home/u/app'; // project_delete.projectKey(REF) = notify-rules.js pathKey(REF)

Deno.test({
  name: 'beta11 windows: "Open in new window" for a WSL project parses, builds its URL from the key, and is one window per project',
  ...T,
  async fn() {
    const C = await import(new URL('windows_contract.ts', base).href);
    const req = C.parseWindowsRequest({ op: 'open', from: 'm', project: { key: KEY, name: 'app', path: REF } });
    assertEquals(req.req.project.path, REF);
    const url = C.windowPath({ w: 'w2', kind: 'project', project: KEY });
    assertEquals(new URLSearchParams(url.slice(2)).get('project'), KEY);
    assert(C.showsAlready({ w: 'w2', kind: 'project', project: KEY }, req.req));
    const doc = C.parseWindowsRequest({ op: 'popout', from: 'm', doc: { project: KEY, name: 'notes' } });
    assertEquals(doc.req.doc.project, KEY);
  },
});

Deno.test({
  name: 'beta11 windows: a saved WSL project window is restored (its folder is never looked up on the Windows disk)',
  ...T,
  async fn() {
    const W = await import(new URL('windows.ts', base).href);
    const { FolderPresence } = await import(new URL('folder_presence.ts', base).href);
    const looked: string[] = [];
    const presence = new FolderPresence({ stat: (p: string) => (looked.push(p), false), now: () => 0 });
    const saved = W.cleanSavedList({
      version: 1,
      windows: [
        { id: 'm', kind: 'main', width: 1200, height: 800 },
        { id: 'w2', kind: 'project', project: { key: KEY, name: 'app', path: REF }, width: 1000, height: 700 },
      ],
    });
    const plan = W.restorePlan(saved, { folderGone: (p: string) => presence.isGone(p) });
    assertEquals(plan.map((w: { id: string }) => w.id), ['m', 'w2']);
    assertEquals(looked, []);
  },
});
