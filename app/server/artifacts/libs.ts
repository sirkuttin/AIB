/**
 * Libraries for artifact pages that work offline (Deno only; the Python reference origin has none).
 *
 * The artifact origin serves pinned copies of Mermaid, Chart.js and Vega / Vega-Lite / vega-embed from vendor/artifact-libs/ at
 * /_lib/<file>, and HTML pages that load them by their usual CDN URL (jsDelivr, unpkg, cdnjs) are served with that URL changed to
 * the local path. Markdown ```mermaid fences use the local Mermaid (origin.ts markdownPage).
 *
 * Why rewrite the page instead of adding an import map: an import map only remaps ES module specifiers, and these libraries are
 * nearly always loaded with a classic <script src>, which no import map touches. A map would also be one more script injected into
 * every page, and a page may have its own. The rewrite adds no script and no power: it swaps a known library URL (in quotes, as in
 * src="..." or import '...') for the same library served locally, and the page CSP only gains script-src for /_lib/ on this origin.
 * Other URLs are left alone. Versions match loosely by major version; a major the local copy can't stand in for (Chart.js 2,
 * Mermaid 12, ...) keeps its CDN URL and needs the network as before.
 *
 *   rewriteLibUrls('<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>')  // '<script src="/_lib/chart.umd.min.js"></script>'
 *   libAsset('chart.umd.min.js')                                                      // the file's bytes, or null
 */
import { APP_ROOT } from '../core/app.ts';
import { pathOf } from '../state/paths.ts';

/** Where /_lib/ lives on this origin. */
export const LIB_PREFIX = '/_lib/';
export const LIB_DIR = pathOf(APP_ROOT, 'vendor', 'artifact-libs');

type Lib = {
  /** Package names as jsDelivr/unpkg (npm) and cdnjs spell them, lower case. */
  names: string[];
  /** Major versions the local copy stands in for; a URL without a version (or @latest) always matches. */
  majors: number[];
  /** File names (the last path part) that are the browser build. */
  files: RegExp;
  local: string;
  /** The ES module entry, for libraries a page may `import`. */
  esm?: { files: RegExp; local: string };
};

export const LIBS: readonly Lib[] = [
  {
    names: ['mermaid'],
    majors: [10, 11],
    files: /^mermaid(\.min)?\.js$/,
    local: 'mermaid.min.js',
    esm: { files: /^mermaid(\.esm)?(\.min)?\.mjs$/, local: 'mermaid.esm.min.mjs' },
  },
  { names: ['chart.js'], majors: [4], files: /^chart\.umd(\.min)?\.js$/, local: 'chart.umd.min.js' },
  { names: ['vega'], majors: [5, 6], files: /^vega(\.min)?\.js$/, local: 'vega.min.js' },
  { names: ['vega-lite'], majors: [5, 6], files: /^vega-lite(\.min)?\.js$/, local: 'vega-lite.min.js' },
  { names: ['vega-embed'], majors: [6, 7], files: /^vega-embed(\.min)?\.js$/, local: 'vega-embed.min.js' },
];

/** /_lib/mermaid.esm.min.mjs: loads the classic build next to it, then exports it, so `import mermaid from` works too. */
export const MERMAID_ESM = `const url = new URL('mermaid.min.js', import.meta.url).href;
if (!globalThis.mermaid) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load ' + url));
    (document.head || document.documentElement).appendChild(script);
  });
}
export default globalThis.mermaid;
`;

const VERSION = /^(?:latest|[~^]?([0-9]+)(?:\.(?:[0-9]+|x))*)$/i;
const CDN = /^(?:https?:)?\/\/(cdn\.jsdelivr\.net\/npm|unpkg\.com|cdnjs\.cloudflare\.com\/ajax\/libs)\/(.+)$/i;

function versionFits(lib: Lib, version: string): boolean {
  if (version === '') return true;
  const match = VERSION.exec(version);
  if (!match) return false;
  return match[1] === undefined || lib.majors.includes(Number(match[1]));
}

/** The /_lib/ path standing in for a CDN URL of one of these libraries, or null to leave the URL alone. */
export function localLibUrl(url: string): string | null {
  const cdn = CDN.exec(url);
  if (!cdn || /[?#]/.test(url)) return null;
  let name: string, version: string, path: string;
  if (cdn[1].toLowerCase().startsWith('cdnjs')) {
    // cdnjs: /ajax/libs/<name>/<version>/<file>, the version is always given
    const parts = /^([^/]+)\/([^/]+)\/(.+)$/.exec(cdn[2]);
    if (!parts) return null;
    [, name, version, path] = parts;
  } else {
    // jsDelivr and unpkg: /<package>[@<version>][/<path>]
    const parts = /^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]*))?(\/.*)?$/.exec(cdn[2]);
    if (!parts) return null;
    name = parts[1];
    version = parts[2] ?? '';
    path = (parts[3] ?? '').replace(/^\//, '');
  }
  const lib = LIBS.find((l) => l.names.includes(name.toLowerCase()));
  if (!lib || !versionFits(lib, version)) return null;
  const file = path.split('/').pop() ?? '';
  if (path === '' || lib.files.test(file)) return LIB_PREFIX + lib.local;
  if (lib.esm && (path === '+esm' || lib.esm.files.test(file))) return LIB_PREFIX + lib.esm.local;
  return null;
}

const CDN_HOSTS = /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/i;
/** A CDN URL in quotes (an attribute value, a JS string): group 1 the quote, group 2 the URL. */
const QUOTED_CDN_URL =
  /(["'`])((?:https?:)?\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|cdnjs\.cloudflare\.com\/ajax\/libs)\/[^"'`\s<>]+)\1/gi;
const SCRIPT_TAG = /<script\b[^>]*>/gi;
/** integrity="..." (the hash is the CDN file's, which a local copy needn't match) and crossorigin. */
const CDN_ONLY_ATTRIBUTE = /\s(?:integrity|crossorigin)(?=[\s=>/])(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi;

function swap(text: string): [string, boolean] {
  let changed = false;
  const out = text.replace(QUOTED_CDN_URL, (whole, quote: string, url: string) => {
    const local = localLibUrl(url);
    if (local === null) return whole;
    changed = true;
    return quote + local + quote;
  });
  return [out, changed];
}

/** A page's text with the CDN URLs of the vendored libraries changed to their /_lib/ paths. */
export function rewriteLibUrls(html: string): string {
  if (!CDN_HOSTS.test(html)) return html;
  // A <script> tag whose src is swapped loses integrity/crossorigin; then every other quoted URL (imports, script.src = '...').
  const tags = html.replace(SCRIPT_TAG, (tag) => {
    const [out, changed] = swap(tag);
    return changed ? out.replace(CDN_ONLY_ATTRIBUTE, '') : tag;
  });
  return swap(tags)[0];
}

/** The same for page bytes: the same array back when nothing changes, so other pages are served byte for byte. */
export function rewriteLibBytes(data: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(data); // only looked at; a page with nothing to swap keeps its bytes
  if (!CDN_HOSTS.test(text)) return data;
  const out = rewriteLibUrls(text);
  return out === text ? data : new TextEncoder().encode(out);
}

const cache = new Map<string, Uint8Array>();

/** The bytes served at /_lib/<name>, or null when there is no such library file. */
export function libAsset(name: string): Uint8Array | null {
  if (name === 'mermaid.esm.min.mjs') return new TextEncoder().encode(MERMAID_ESM);
  if (!LIBS.some((l) => l.local === name)) return null;
  const hit = cache.get(name);
  if (hit) return hit;
  try {
    const data = Deno.readFileSync(pathOf(LIB_DIR, name));
    cache.set(name, data);
    return data;
  } catch {
    return null;
  }
}
