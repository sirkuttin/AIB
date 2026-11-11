// Bundles the drawing page (Excalidraw + React + Yjs + server/docs/drawing/binding.ts) and the headless Mermaid converter into
// outputs/agent-studio/vendor/excalidraw/, copies Excalidraw's fonts (all but the 13 MB CJK Xiaolai set) and writes VERSIONS.txt
// with sizes and SHA-256. Build-time only:  cd tools/drawing && npm install && node build.mjs
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.AIB_DRAWING_OUT || join(HERE, '../../outputs/agent-studio/vendor/excalidraw'); // the env var: a trial build elsewhere
const pkg = (name) => JSON.parse(readFileSync(join(HERE, 'node_modules', name, 'package.json'), 'utf8')).version;

// server/docs/drawing/*.ts import Yjs by its bare name (outputs/agent-studio/deno.json maps it for Deno); nodePaths below points it
// at this folder's node_modules, so the page and the binding share one Yjs. npm: specifiers are mapped the same way, just in case.
const npmSpecifiers = {
  name: 'npm-specifiers',
  setup(build) {
    build.onResolve({ filter: /^npm:/ }, (args) => {
      const spec = args.path.slice(4).replace(/^(@?[^@/]+(?:\/[^@/]+)?)@[^/]+/, '$1');
      return build.resolve(spec, { resolveDir: HERE, kind: args.kind });
    });
  },
};

// Excalidraw's text-to-diagram dialog lazy-loads its own nested mermaid-to-excalidraw 2.x, which carries all of Mermaid (about
// 6 MB of chunks). Point it at the 3.x one the agent tool uses (same parseMermaidToExcalidraw API, laid out by pele, about 1 MB).
const oneMermaid = {
  name: 'one-mermaid',
  setup(build) {
    build.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, (args) =>
      args.pluginData === 'top' ? undefined : build.resolve(args.path, { resolveDir: HERE, kind: args.kind, pluginData: 'top' }));
  },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await esbuild.build({
  entryPoints: { drawing: join(HERE, 'src/drawing_page.jsx') },
  conditions: ['production'],
  outdir: OUT,
  bundle: true,
  format: 'esm',
  splitting: true, // Excalidraw's lazy parts (text-to-diagram, font subsetting) stay out of the first load
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  minify: true,
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  loader: { '.woff2': 'file', '.ttf': 'file' },
  plugins: [npmSpecifiers, oneMermaid],
  nodePaths: [join(HERE, 'node_modules')], // server/docs/drawing/*.ts live outside this folder
  legalComments: 'none',
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: { mermaid_headless: join(HERE, 'src/mermaid_headless.js') },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['browser'], // nanoid's web-crypto build, which Deno runs
  minify: true,
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
});

const fonts = join(HERE, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
for (const f of readdirSync(fonts)) if (f !== 'Xiaolai') cpSync(join(fonts, f), join(OUT, 'fonts', f), { recursive: true });
// @excalidraw/excalidraw ships no LICENSE file in its npm package (package.json says MIT); copy the ones that exist.
for (const [from, to] of [['@excalidraw/mermaid-to-excalidraw/LICENSE', 'LICENSE-mermaid-to-excalidraw'], ['pele/LICENSE', 'LICENSE-pele'], ['yjs/LICENSE', 'LICENSE-yjs'], ['react/LICENSE', 'LICENSE-react'], ['linkedom/LICENSE', 'LICENSE-linkedom']]) {
  try {
    cpSync(join(HERE, 'node_modules', from), join(OUT, to));
  } catch { /* not shipped */ }
}

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const rows = walk(OUT).filter((f) => !f.endsWith('VERSIONS.txt')).map((f) => {
  const buf = readFileSync(f);
  return { f: f.slice(OUT.length + 1).replaceAll('\\', '/'), size: buf.length, gz: gzipSync(buf).length, sha: createHash('sha256').update(buf).digest('hex') };
});
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const total = (filter) => rows.filter(filter).reduce((a, r) => [a[0] + r.size, a[1] + r.gz], [0, 0]);
// First load = drawing.js, drawing.css and every chunk reachable through static imports; the rest loads only when used.
const first = new Set(['drawing.js', 'drawing.css']);
const pending = ['drawing.js'];
while (pending.length) {
  const f = pending.pop();
  const code = readFileSync(join(OUT, f), 'utf8');
  for (const m of code.matchAll(/(?:from|import)\s*"\.\/((?:chunks\/)?[^"]+\.js)"/g)) {
    const path = f.includes('/') ? 'chunks/' + m[1].replace(/^chunks\//, '') : m[1];
    if (!first.has(path)) first.add(path), pending.push(path);
  }
}
const [pageRaw, pageGz] = total((r) => first.has(r.f));
const [lazyRaw, lazyGz] = total((r) => r.f.startsWith('chunks/') && !first.has(r.f));
const [assetRaw] = total((r) => r.f.startsWith('assets/'));
const [fontRaw] = total((r) => r.f.startsWith('fonts/'));
writeFileSync(join(OUT, 'VERSIONS.txt'), [
  'Bundled by tools/drawing/build.mjs (esbuild). Served by AIB from this folder; no CDN (window.EXCALIDRAW_ASSET_PATH points here).',
  'Licenses: Excalidraw MIT (package.json; no LICENSE file in the npm package); React, Yjs, y-protocols, mermaid-to-excalidraw, pele, linkedom: MIT/ISC.',
  '',
  `@excalidraw/excalidraw              ${pkg('@excalidraw/excalidraw')}`,
  `@excalidraw/mermaid-to-excalidraw   ${pkg('@excalidraw/mermaid-to-excalidraw')}`,
  `react, react-dom                    ${pkg('react')}`,
  `yjs                                 ${pkg('yjs')}`,
  `y-protocols                         ${pkg('y-protocols')}`,
  `linkedom                            ${pkg('linkedom')}`,
  `esbuild                             ${pkg('esbuild')}`,
  '',
  `First load (drawing.js, drawing.css and ${first.size - 2} statically imported chunks): ${kb(pageRaw)} raw, ${kb(pageGz)} gzip. Lazy chunks: ${kb(lazyRaw)} raw, ${kb(lazyGz)} gzip.`,
  `CSS assets: ${kb(assetRaw)}. Fonts: ${kb(fontRaw)} (Xiaolai CJK left out: 13 MB).`,
  '',
  ...rows.map((r) => `${r.sha}  ${String(r.size).padStart(9)}  ${r.f}`),
  '',
].join('\n'));
console.log(`page ${kb(pageRaw)} (${kb(pageGz)} gzip), lazy ${kb(lazyRaw)} (${kb(lazyGz)} gzip), mermaid ${kb(rows.find((r) => r.f === 'mermaid_headless.js').size)}, fonts ${kb(fontRaw)}`);
