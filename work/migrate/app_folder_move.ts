/**
 * One-time rewrite for the move outputs/agent-studio -> app/ (page files -> app/page/, host/studio.ts -> host/aib.ts,
 * web/studio_routes.ts -> web/aib_routes.ts). Already applied (2026-11-24); kept as the record of what changed.
 *
 *   deno run -A work/migrate/app_folder_move.ts          dry run: lists every file it would change
 *   deno run -A work/migrate/app_folder_move.ts --apply  writes the changes
 *
 * Not touched: aib-shared/ (history), CHANGELOG.md, release-bodies/, binary files, this script and the guard test.
 */
const apply = Deno.args.includes('--apply');
const run = async (args: string[]) =>
  new TextDecoder().decode((await new Deno.Command('git', { args, stdout: 'piped' }).output()).stdout);

const pageNames = (await run(['ls-files', 'app/page'])).split('\n').filter(Boolean).map((p) => p.slice('app/page/'.length));
const escaped = pageNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const pageRe = new RegExp(`outputs/agent-studio/(${escaped.join('|')})(?![A-Za-z0-9_-])`, 'g');
const skip = /^(aib-shared\/|CHANGELOG\.md$|release-bodies\/|work\/migrate\/app_folder_move\.ts$|work\/deno\/app_folder_guard_test\.ts$)/;
const binary = /\.(png|ico|icns|jpg|jpeg|gif|webp|woff2?|zip|gz|exe|dll|so|lock|lockb|pdf|wasm)$/i;

function rewrite(text: string): string {
  return text
    .replace(pageRe, 'app/page/$1')
    .replace(/outputs\/agent-studio\/\*\.\{js,css\}/g, 'app/page/*.{js,css}')
    .replace(/outputs\/agent-studio\/\*\.(js|css|html)/g, 'app/page/*.$1')
    .replace(/outputs\\\\agent-studio\\\\(?=[a-z0-9-]+\.(?:js|css|html))/g, 'app\\\\page\\\\')
    .replace(/outputs\\agent-studio\\(?=[a-z0-9-]+\.(?:js|css|html))/g, 'app\\page\\')
    .replace(/outputs\/agent-studio/g, 'app')
    .replace(/outputs\\\\agent-studio/g, 'app')
    .replace(/outputs\\agent-studio/g, 'app')
    .replace(/(['"`])((?:\.\.?\/)(?:[a-z_./]*\/)?)host\/studio\.ts/g, '$1$2host/aib.ts')
    .replace(/'\.\/studio\.ts'/g, "'./aib.ts'")
    .replace(/web\/studio_routes\.ts/g, 'web/aib_routes.ts')
    .replace(/'\.\/studio_routes\.ts'/g, "'./aib_routes.ts'")
    .replace(/host\/studio\.ts/g, 'host/aib.ts');
}

let changed = 0;
for (const file of (await run(['ls-files'])).split('\n').filter(Boolean)) {
  if (skip.test(file) || binary.test(file)) continue;
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  const out = rewrite(text);
  if (out === text) continue;
  changed++;
  console.log(file);
  if (apply) await Deno.writeTextFile(file, out);
}
console.log(`${changed} files ${apply ? 'changed' : 'would change'}`);
