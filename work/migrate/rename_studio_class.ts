/**
 * One-time rename inside the app move (2026-11-24): `class Studio` -> `Aib` (host/aib.ts), StudioOptions -> AibOptions,
 * StudioConstruct -> AibConstruct, StudioHandler -> AibHandler, studioRoutes -> aibRoutes, studioAsset -> pageAsset.
 * Wire names (X-Studio-*, AIB.Studio, studio-*.json, agent-studio-host) are never touched. Already applied; kept as the record.
 *   deno run -A work/migrate/rename_studio_class.ts [--apply]
 */
const apply = Deno.args.includes('--apply');

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (e.name !== 'node_modules' && e.name !== 'vendor') yield* walk(p);
    } else if (p.endsWith('.ts')) yield p;
  }
}

const importsAib = /from\s+['"][^'"]*\/aib\.ts['"]|from\s+['"]\.\/aib\.ts['"]/;

function rewrite(text: string): string {
  let out = text
    .replace(/\bStudioOptions\b/g, 'AibOptions')
    .replace(/\bStudioConstruct\b/g, 'AibConstruct')
    .replace(/\bStudioHandler\b/g, 'AibHandler')
    .replace(/\bstudioRoutes\b/g, 'aibRoutes')
    .replace(/\bstudioAsset\b/g, 'pageAsset');
  if (importsAib.test(out) || /class Studio\b/.test(out)) {
    out = out
      .replace(/\bclass Studio\b/g, 'class Aib')
      .replace(/\bnew Studio\b/g, 'new Aib')
      .replace(/\bStudio\.(?=prototype\b|[A-Z_]{3,}\b)/g, 'Aib.')
      .replace(/(\bas |\bas unknown as |\btypeof |\bextends |: |<|\| |& )Studio\b(?=[ |&>,;)\[\]=]|$)/gm, '$1Aib')
      .replace(/\bStudio(?=( \||\[\]|>\)))/g, 'Aib')
      .replace(/(import\s*\{[^}]*?)\bStudio\b/g, '$1Aib')
      .replace(/(import\s+type\s*\{[^}]*?)\bStudio\b/g, '$1Aib');
  }
  return out;
}

let changed = 0;
for (const root of ['app/server', 'work/deno', 'tools']) {
  for await (const file of walk(root)) {
    const text = await Deno.readTextFile(file);
    const out = rewrite(text);
    if (out === text) continue;
    changed++;
    console.log(file);
    if (apply) await Deno.writeTextFile(file, out);
  }
}
console.log(`${changed} files ${apply ? 'changed' : 'would change'}`);
