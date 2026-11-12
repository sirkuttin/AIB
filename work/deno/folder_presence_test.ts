/**
 * server/desktop/folder_presence.ts: which project folders are gone. Real temp folders only; read-only (nothing is written or deleted),
 * cached (a poll inside the TTL makes no stat), and a folder that comes back is seen again.
 */
import { assert, assertEquals } from './_assert.ts';
import { defaultHooks, FolderPresence } from '../../outputs/agent-studio/server/desktop/folder_presence.ts';
import { ROUTES } from '../../outputs/agent-studio/server/web/routes.ts';

function clock() {
  const c = { t: 1000 };
  return c;
}

Deno.test('a missing folder is gone, an existing one is not, and it is back once created (no writes, nothing deleted)', () => {
  const base = Deno.makeTempDirSync({ prefix: 'aib-presence-' });
  try {
    const here = `${base}/here`;
    const later = `${base}/later`;
    Deno.mkdirSync(here);
    const c = clock();
    const p = new FolderPresence({ stat: defaultHooks.stat, now: () => c.t }, 30_000);
    assertEquals(p.gone([here, later]), [later]);
    Deno.mkdirSync(later);
    c.t += 31_000; // past the cache time
    assertEquals(p.gone([here, later]), []);
    assertEquals([...Deno.readDirSync(base)].map((e) => e.name).sort(), ['here', 'later']); // only what the test made
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test('answers are cached: polling inside the time stats nothing, after it each folder is stat-ed once', () => {
  const base = Deno.makeTempDirSync({ prefix: 'aib-presence-' });
  try {
    const c = clock();
    const p = new FolderPresence({ stat: defaultHooks.stat, now: () => c.t }, 30_000);
    const paths = [`${base}/a`, `${base}/b`, base];
    p.gone(paths);
    assertEquals(p.stats, 3);
    for (let i = 0; i < 20; i++) {
      c.t += 1000;
      p.gone(paths);
    }
    assertEquals(p.stats, 3, '20 polls inside the cache time: no new stat');
    c.t += 30_000;
    p.gone(paths);
    assertEquals(p.stats, 6);
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test('a file in place of the folder counts as gone; empty, odd and network paths never do; errors other than "not found" stay visible', () => {
  const base = Deno.makeTempDirSync({ prefix: 'aib-presence-' });
  try {
    Deno.writeTextFileSync(`${base}/file.txt`, 'x');
    const p = new FolderPresence();
    assertEquals(p.gone([`${base}/file.txt`, '', 5, null, '//server/share/x']), [`${base}/file.txt`]);
    const denied = new FolderPresence({ stat: () => defaultHooks.stat('\0'.repeat(0) + base), now: () => 0 });
    assert(!denied.isGone(base));
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test('the route is registered as a read route', () => {
  assertEquals(ROUTES.scopes.get('GET /api/live/folders/gone'), 'read');
});
