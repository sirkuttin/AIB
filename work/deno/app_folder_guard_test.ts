/**
 * Guards for the app layout (decided 2026-11-24): the app lives in app/ (not outputs/agent-studio/), its browser files are all in
 * app/page/ and are served at the same top-level URLs as before (/chat.js, not /page/chat.js).
 */
import { assert, assertEquals } from './_assert.ts';
import { APP_ROOT, PAGE_ROOT, REPO_ROOT, repoRoot, servedFile, TESTS_DIR, testsDir } from '../../app/server/core/app.ts';
import { pageAsset } from '../../app/server/web/server.ts';
import { REMOTE_STATIC } from '../../app/server/remote/server.ts';
import { PC_STATIC } from '../../app/server/remote/pc_page.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
const norm = (p: string) => p.replaceAll('\\', '/');

Deno.test('the app folder is <repo>/app, the tests folder <repo>/work, and the page files are in app/page/', () => {
  assertEquals(norm(APP_ROOT), norm(REPO_ROOT) + '/app');
  assertEquals(norm(TESTS_DIR), norm(REPO_ROOT) + '/work');
  assertEquals(norm(PAGE_ROOT), norm(APP_ROOT) + '/page');
  assertEquals(norm(testsDir('/x/y/app')), '/x/y/work');
  assertEquals(norm(repoRoot('/x/y/app')), '/x/y');
  assertEquals(norm(testsDir('C:\\a\\b\\app')).endsWith('/work'), true);
  Deno.statSync(`${REPO_ROOT}${sep}work${sep}_paths.js`);
});

Deno.test('no page file (JS, CSS, HTML) sits at the top of app/: they are all in app/page/', () => {
  const top = [...Deno.readDirSync(APP_ROOT)].filter((e) => e.isFile && /\.(js|css|html)$/.test(e.name)).map((e) => e.name);
  assertEquals(top, []);
  const page = [...Deno.readDirSync(PAGE_ROOT)].map((e) => e.name);
  for (const must of ['chat.html', 'chat.js', 'phone.html', 'remote-loader.html', 'doc.html', 'chat.css']) assert(page.includes(must), must);
  assert(page.length > 100, `${page.length} page files`);
});

Deno.test('every page file is served at its top-level URL from app/page/, and vendor/, pwa/, icons/ stay beside it', () => {
  assertEquals(servedFile('chat.js'), `${PAGE_ROOT}${sep}chat.js`);
  assertEquals(servedFile('pwa/sw.js'), `${APP_ROOT}${sep}pwa${sep}sw.js`);
  assertEquals(servedFile(`pwa${sep}sw.js`), `${APP_ROOT}${sep}pwa${sep}sw.js`);
  assertEquals(servedFile('icons/icon.png'), `${APP_ROOT}${sep}icons${sep}icon.png`);
  assertEquals(servedFile('vendor/xterm/xterm.js'), `${APP_ROOT}${sep}vendor${sep}xterm${sep}xterm.js`);
  assertEquals(pageAsset('/'), 'chat.html');
  assertEquals(pageAsset('/page/chat.js'), null); // the folder name is not part of any URL
  for (const e of Deno.readDirSync(PAGE_ROOT)) {
    if (/\.(js|css)$/.test(e.name)) {
      assertEquals(pageAsset('/' + e.name), e.name, e.name);
      Deno.statSync(servedFile(e.name));
    }
  }
});

Deno.test('the phone port and the computer page name only files that exist', () => {
  for (const [url, file] of [...Object.entries(REMOTE_STATIC), ...Object.entries(PC_STATIC)]) Deno.statSync(servedFile(file));
  Deno.statSync(servedFile('remote-loader.html'));
  Deno.statSync(servedFile('chat.html'));
  Deno.statSync(servedFile('doc.html'));
  assert(REMOTE_STATIC['/sw.js'] && Object.keys(REMOTE_STATIC).includes('/phone.html'));
});

/** Tracked text files where the old folder name may still appear: history (aib-shared, changelog, release texts) and these scripts. */
const ALLOWED = [/^aib-shared\//, /^CHANGELOG\.md$/, /^release-bodies\//, /^work\/migrate\/(app_folder_move|rename_studio_class)\.ts$/, /^work\/deno\/app_folder_guard_test\.ts$/, /^work\/deno\/artifacts_test\.ts$/];

Deno.test('outputs/agent-studio does not come back in code, scripts, tests or docs', () => {
  const root = norm(REPO_ROOT);
  const old = [/outputs[\\/]+agent-studio/, /outputs\\\\agent-studio/, /['"`]outputs['"`]\s*,\s*['"`]agent-studio/, /outputs['"`]\s*\+\s*\w*SEP\w*\s*\+\s*['"`]agent-studio/];
  const hits: string[] = [];
  const skipDir = new Set(['.git', 'node_modules', 'dist', '.claude']);
  const text = /\.(ts|js|mjs|jsx|json|md|mdx|py|go|astro|html|css|yml|yaml|toml|cmd|ps1|sh|txt)$/;
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (!skipDir.has(e.name) && !(dir === root && e.name === 'outputs')) walk(path);
      } else if (e.isFile && (text.test(e.name) || e.name === '.gitignore')) {
        const rel = path.slice(root.length + 1);
        if (ALLOWED.some((re) => re.test(rel))) continue;
        let body: string;
        try {
          body = Deno.readTextFileSync(path);
        } catch {
          continue;
        }
        if (old.some((re) => re.test(body))) hits.push(rel);
      }
    }
  };
  walk(root);
  assertEquals(hits, [], 'these files still name the old app folder outputs/agent-studio (it is app/ now)');
});
