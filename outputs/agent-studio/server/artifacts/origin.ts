/**
 * The artifact origin (artifact_origin.py): a second, separate HTTP listener (Studio port + 1) that serves artifact snapshots, GET
 * only.
 *
 * It is a different origin from Studio on purpose: artifact pages are untrusted, so nothing here knows the Studio token, sends CORS
 * headers or shares code paths with the Studio server. Pages are meant to be shown in a sandboxed iframe without allow-same-origin.
 * Answers (status, body, the headers below) are those of the Python listener for the same store; work/deno/artifact_origin_test.ts
 * runs both on the same folder and compares them.
 *
 *   const origin = OriginServer.start(store.root, studioPort);   // origin.url -> store.origin
 *   await origin.stop();
 */
import { PY_SPACE, pyRepr, pyStrip } from '../core/py.ts';
import { pathOf } from '../state/paths.ts';
import { decodeReplace, pureName, pureStem, pureSuffix } from './artifacts.ts';
import { serve, type Server as HttpServer } from '../platform/http_serve.ts';

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';

export const CSP_TEMPLATE =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob: 'self'; " +
  "media-src data: blob: 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
  'frame-ancestors http://127.0.0.1:{port} http://localhost:{port}; ' +
  'sandbox allow-scripts allow-forms allow-popups allow-downloads'; // same flags as the Studio viewer frame; never allow-same-origin

export function csp(studioPort: number): string {
  return CSP_TEMPLATE.replaceAll('{port}', String(studioPort));
}

export const CSP_KINDS = ['.html', '.htm', '.svg', '.md', '.markdown'];
export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
/**
 * Python falls back to mimetypes.guess_type() for other extensions: on Windows the registry's "Content Type" of HKCR\<ext>
 * wins (read here with reg.exe, once per extension), else its built-in table, of which this is the part a snapshot can hold.
 * A snapshot holds only its entry file, whose extension is always in MIME, so this matters only for files put there by hand.
 */
const BUILTIN_TYPES: Readonly<Record<string, string>> = {
  '.xml': 'text/xml',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/x-wav',
  '.bmp': 'image/bmp',
  '.ico': 'image/vnd.microsoft.icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mjs': 'application/javascript',
  '.bin': 'application/octet-stream',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
};
const registryTypes = new Map<string, string | null>();

function registryType(ext: string): string | null {
  if (!WIN || !/^\.[\w.+-]{1,40}$/.test(ext)) return null;
  if (registryTypes.has(ext)) return registryTypes.get(ext)!;
  let found: string | null = null;
  try {
    const out = new Deno.Command('reg', {
      args: ['query', 'HKCR' + String.fromCharCode(92) + ext, '/v', 'Content Type'],
      stdout: 'piped',
      stderr: 'null',
    }).outputSync();
    const match = out.success ? /Content Type\s+REG_SZ\s+(\S[^\r\n]*)/.exec(new TextDecoder().decode(out.stdout)) : null;
    found = match && /^[\x20-\x7e]+$/.test(match[1].trim()) ? match[1].trim() : null;
  } catch { /* no reg.exe: the built-in table */ }
  registryTypes.set(ext, found);
  return found;
}

/** mimetypes.guess_type(name)[0] */
export function guessType(name: string): string | null {
  const ext = pureSuffix(name).toLowerCase();
  if (!ext) return null;
  return registryType(ext) ?? (Object.hasOwn(BUILTIN_TYPES, ext) ? BUILTIN_TYPES[ext] : null);
}

/** Python's PATH_RE (`.` matches anything but a newline; `$` also matches before one trailing newline). */
export const PATH_RE = /^\/a\/([0-9a-f]{16})\/v([0-9]{1,6})\/([^\n]+)\n?$/;

export const SCROLL_SCRIPT = `<script>(function(){try{var m=/studio-scroll=(-?[0-9.]+),(-?[0-9.]+)/.exec(location.hash);
function go(){if(m)window.scrollTo(+m[1],+m[2]);}
if(m){go();window.addEventListener('load',function(){go();setTimeout(go,60);});}
var t=0;window.addEventListener('scroll',function(){if(t)return;t=requestAnimationFrame(function(){t=0;
try{parent.postMessage({type:'studio-artifact-scroll',x:window.scrollX,y:window.scrollY},'*');}catch(e){}});},{passive:true});}catch(e){}})();</script>`;

const S = `[${PY_SPACE}]`; // Python's \s
const NS = `[^${PY_SPACE}]`; // Python's \S
const W = '[\\p{L}\\p{N}_]'; // Python's \w (str.isalnum() or '_')
const D = '\\p{Nd}'; // Python's \d

const BODY_CLOSE = new RegExp(`</body${S}*>`, 'gi');

export function injectScroll(data: Uint8Array): Uint8Array {
  let text = decodeReplace(data);
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(BODY_CLOSE)) last = match;
  if (last) text = text.slice(0, last.index) + SCROLL_SCRIPT + text.slice(last.index);
  else text += SCROLL_SCRIPT;
  return new TextEncoder().encode(text);
}

// ---- small Python stand-ins ---------------------------------------------------------------------

/** html.escape(text, quote) */
export function htmlEscape(text: string, quote = true): string {
  let out = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (quote) out = out.replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
  return out;
}

/**
 * html.unescape for the text it sees here: every '&' of the source was escaped first, so only the references html.escape writes
 * (and numeric ones) can occur. Single pass, left to right, as Python's.
 */
export function htmlUnescape(text: string): string {
  if (!text.includes('&')) return text;
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|(amp|lt|gt|quot|apos);)/g, (_whole, dec, hex, name) => {
    if (name) return named[name];
    const num = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (num === 0 || (num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return String.fromCharCode(0xfffd);
    return String.fromCodePoint(num);
  });
}

/** urllib.parse.unquote(text) (UTF-8, errors='replace'; text outside ASCII runs is kept as it is). */
export function pyUnquote(text: string): string {
  if (!text.includes('%')) return text;
  // deno-lint-ignore no-control-regex -- Python matches these exact characters
  return text.replace(/[\x00-\x7f]+/g, (run) => {
    if (!run.includes('%')) return run;
    const bytes: number[] = [];
    for (let i = 0; i < run.length; i++) {
      if (run[i] === '%' && /^[0-9a-fA-F]{2}$/.test(run.slice(i + 1, i + 3))) {
        bytes.push(parseInt(run.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(run.charCodeAt(i));
    }
    return decodeReplace(new Uint8Array(bytes));
  });
}

/** urllib.parse.parse_qs(query) with its defaults (blank values dropped, '&' separator, '+' is a space). */
export function parseQs(query: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const field of query.split('&')) {
    if (!field) continue;
    const at = field.indexOf('=');
    if (at < 0 || at === field.length - 1) continue;
    const name = pyUnquote(field.slice(0, at).replaceAll('+', ' '));
    const value = pyUnquote(field.slice(at + 1).replaceAll('+', ' '));
    (Object.hasOwn(out, name) ? out[name] : (out[name] = [])).push(value);
  }
  return out;
}

/** urllib.parse.urlsplit(target): [path, query]. */
export function splitTarget(target: string): [string, string] {
  let url = target;
  const hash = url.indexOf('#');
  if (hash >= 0) url = url.slice(0, hash);
  let query = '';
  const mark = url.indexOf('?');
  if (mark >= 0) {
    query = url.slice(mark + 1);
    url = url.slice(0, mark);
  }
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(url);
  if (scheme) url = url.slice(scheme[0].length);
  if (url.startsWith('//')) {
    const slash = url.indexOf('/', 2);
    url = slash < 0 ? '' : url.slice(slash);
  }
  return [url, query];
}

// ---- Markdown viewer (rendered here, raw HTML escaped; the page itself runs no script of its own) -------------------------

const SAFE_LINK = new RegExp(`^(https?://|mailto:|#|/|\\./|\\.\\./|[${W.slice(1, -1)}.\\-%]+(/|$))`, 'iu');

function safeUrl(raw: string): string | null {
  const url = pyStrip(raw);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(url) && !/^(https?|mailto):/iu.test(url)) return null;
  return SAFE_LINK.test(url) || url === '' ? url : null;
}

const CODE_SPAN = /`([^`]+)`/g;
const IMAGE = new RegExp(`!\\[([^\\]]*)\\]\\(([^)${PY_SPACE}]+)(?:${S}+"[^"]*")?\\)`, 'gu');
const LINK = new RegExp(`\\[([^\\]]+)\\]\\(([^)${PY_SPACE}]+)(?:${S}+&quot;[^)]*&quot;)?\\)`, 'gu');
const BARE_URL = new RegExp(`(?<![${W.slice(1, -1)}"=>])(https?://[^${PY_SPACE}<)]+[^${PY_SPACE}<).,;:!?])`, 'gu');
const BOLD = /\*\*([^\n]+?)\*\*|__([^\n]+?)__/gu;
const EM_STAR = new RegExp(`(?<![${W.slice(1, -1)}*])\\*(?!${S})([^\\n]+?)(?<!${S})\\*(?![${W.slice(1, -1)}*])`, 'gu');
const EM_UNDER = new RegExp(`(?<![${W.slice(1, -1)}_])_(?!${S})([^\\n]+?)(?<!${S})_(?![${W.slice(1, -1)}_])`, 'gu');
const STRIKE = /~~([^\n]+?)~~/gu;

function inline(source: string): string {
  const codes: string[] = [];
  let text = source.replace(CODE_SPAN, (_m, code: string) => {
    codes.push('<code>' + htmlEscape(code) + '</code>');
    return `\x00${codes.length - 1}\x00`;
  });
  text = htmlEscape(text, false);
  text = text.replace(IMAGE, (_m, alt: string, target: string) => {
    const src = safeUrl(htmlUnescape(target));
    if (src === null || /^(mailto:)/iu.test(src)) return htmlEscape(alt);
    return `<img alt="${htmlEscape(htmlUnescape(alt))}" src="${htmlEscape(src)}">`;
  });
  text = text.replace(LINK, (_m, label: string, target: string) => {
    const href = safeUrl(htmlUnescape(target));
    if (href === null) return label;
    return `<a href="${htmlEscape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(BARE_URL, (_m, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  text = text.replace(BOLD, (_m, a: string | undefined, b: string | undefined) => `<strong>${a || b}</strong>`);
  text = text.replace(EM_STAR, (_m, a: string) => `<em>${a}</em>`);
  text = text.replace(EM_UNDER, (_m, a: string) => `<em>${a}</em>`);
  text = text.replace(STRIKE, (_m, a: string) => `<del>${a}</del>`);
  // deno-lint-ignore no-control-regex -- Python matches these exact characters
  return text.replace(/\x00([0-9]+)\x00/g, (_m, index: string) => {
    const code = codes[Number(index)];
    if (code === undefined) throw new RangeError('list index out of range'); // Python raises IndexError here too
    return code;
  });
}

function cells(row: string): string[] {
  let line = pyStrip(row);
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|')) line = line.slice(0, -1);
  return line.split('|').map((cell) => pyStrip(cell));
}

function lstrip(text: string): string {
  return text.replace(new RegExp(`^${S}+`), '');
}

const FENCE = new RegExp(`^${S}*(\`\`\`|~~~)${S}*([${W.slice(1, -1)}+-]*)`, 'u');
const HEADING = new RegExp(`^(#{1,6})${S}+([^\\n]*?)${S}*#*${S}*$`, 'u');
const RULE = new RegExp(`^${S}*([-*_])(${S}*\\1){2,}${S}*$`, 'u');
const QUOTE_MARK = new RegExp(`^${S}*>${S}?`, 'u');
const TABLE_RULE = new RegExp(`^${S}*\\|?${S}*:?-{2,}:?${S}*(\\|${S}*:?-{2,}:?${S}*)*\\|?${S}*$`, 'u');
const ITEM = new RegExp(`^${S}*([-*+]|${D}+[.)])${S}+`, 'u');
const ORDERED = new RegExp(`^${S}*${D}`, 'u');
const CONTINUATION = new RegExp(`^${S}{2,}${NS}`, 'u');
const TASK = new RegExp(`^\\[([ xX])\\]${S}+([^\\n]*)$`, 'u');
const BLOCK_START = new RegExp(`^(#{1,6}${S}|${S}*(\`\`\`|~~~)|${S}*>|${S}*([-*+]|${D}+[.)])${S}+)`, 'u');

export function renderMarkdown(source: string): string {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    let heading: RegExpExecArray | null;
    if (fence) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !pyStrip(lines[i]).startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push('<pre><code>' + htmlEscape(body.join('\n')) + '</code></pre>');
    } else if (!pyStrip(line)) {
      i++;
    } else if ((heading = HEADING.exec(line))) {
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
    } else if (RULE.test(line)) {
      out.push('<hr>');
      i++;
    } else if (lstrip(line).startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lstrip(lines[i]).startsWith('>')) body.push(lines[i++].replace(QUOTE_MARK, ''));
      out.push('<blockquote>' + renderMarkdown(body.join('\n')) + '</blockquote>');
    } else if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && pyStrip(lines[i])) rows.push(cells(lines[i++]));
      let table = '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      table += rows.map((row) => '<tr>' + row.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('');
      out.push(table + '</tbody></table>');
    } else if (ITEM.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length && ITEM.test(lines[i])) {
        let item = lines[i].replace(ITEM, '');
        i++;
        while (i < lines.length && pyStrip(lines[i]) && CONTINUATION.test(lines[i]) && !ITEM.test(lines[i])) {
          item += ' ' + pyStrip(lines[i]);
          i++;
        }
        const task = TASK.exec(item);
        items.push(task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ` + inline(task[2]) : inline(item));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((x) => `<li>${x}</li>`).join('') + `</${tag}>`);
    } else {
      const body: string[] = [];
      while (i < lines.length && pyStrip(lines[i]) && !BLOCK_START.test(lines[i])) body.push(pyStrip(lines[i++]));
      if (!body.length) body.push(pyStrip(lines[i++])); // a line that matched no block rule at all: take it as text so the loop always advances
      out.push('<p>' + inline(body.join(' ')) + '</p>');
    }
  }
  return out.join('\n');
}

export const VIEWER_CSS =
  'body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:46rem;margin:0 auto;padding:1.5rem 1.25rem 4rem;color:#1f2328;background:#fff}' +
  '@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#58a6ff}code,pre{background:#161b22!important}th,td{border-color:#30363d!important}blockquote{border-color:#30363d!important}}' +
  'h1,h2,h3{line-height:1.25}h1,h2{border-bottom:1px solid #8884;padding-bottom:.25em}code{font:90% ui-monospace,Consolas,monospace;background:#8882;padding:.1em .3em;border-radius:4px}' +
  'pre{background:#8882;padding:.8rem 1rem;border-radius:6px;overflow:auto}pre code{background:none;padding:0}blockquote{margin:1em 0;padding:0 1em;border-left:4px solid #8886;color:#8b949e}' +
  'table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #d0d7de;padding:.35em .7em}img{max-width:100%}hr{border:0;border-top:1px solid #8884}';

export function markdownPage(source: string, title: string): Uint8Array {
  return new TextEncoder().encode(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${
      htmlEscape(title)
    }</title>` +
      `<style>${VIEWER_CSS}</style></head><body>${renderMarkdown(source)}${SCROLL_SCRIPT}</body></html>`,
  );
}

// ---- the server -----------------------------------------------------------------------------------------

const REFUSED = new Set(['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const DISPOSITION_UNSAFE = new RegExp(`[^${W.slice(1, -1)}.\\- ]`, 'gu');

function stripVerbatim(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

function strictReal(path: string): string {
  return stripVerbatim(Deno.realPathSync(path));
}

function relativeTo(path: string, base: string): boolean {
  const norm = (p: string) => (WIN ? p.toLowerCase() : p);
  const a = norm(path), b = norm(base);
  return a === b || a.startsWith(b.endsWith(SEP) ? b : b + SEP);
}

function respond(
  status: number,
  body: Uint8Array | string,
  mime: string,
  studioPort: number,
  extra: Record<string, string> = {},
  withCsp = false,
): Response {
  const headers = new Headers();
  headers.set('Content-Type', mime);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store');
  if (withCsp) headers.set('Content-Security-Policy', csp(studioPort));
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new Response(bytes as Uint8Array<ArrayBuffer>, { status, headers });
}

/** The request handler for an origin serving `root` (the artifact store folder), framed by Studio on `studioPort`. */
export function makeHandler(root: string, studioPort: number, ownPort: () => number): (request: Request) => Response {
  const base = pathOf(String(root));
  const text = 'text/plain; charset=utf-8';
  const send = (status: number, body: Uint8Array | string, mime = text, extra: Record<string, string> = {}, withCsp = false) =>
    respond(status, body, mime, studioPort, extra, withCsp);
  return (request: Request): Response => {
    if (request.method !== 'GET') {
      if (REFUSED.has(request.method)) return send(405, 'Method not allowed', text, { Allow: 'GET' });
      return send(501, `Unsupported method (${pyRepr(request.method)})`);
    }
    const port = ownPort();
    const host = request.headers.get('Host');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, 'Forbidden');
    // Deno builds request.url as 'http://' + Host + the raw request target (no normalization), so the target is what follows.
    const prefix = `http://${host}`;
    const target = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : request.url;
    const [rawPath, rawQuery] = splitTarget(target);
    const query = parseQs(rawQuery);
    const unquoted = pyUnquote(rawPath);
    const match = !rawPath.includes('%00') && !unquoted.includes('\\') ? PATH_RE.exec(unquoted) : null;
    if (!match) return send(404, 'Not found');
    const [, artifactId, numberText, rest] = match;
    const folder = pathOf(base, artifactId, `v${Number(numberText)}`);
    let resolved: string;
    try {
      resolved = strictReal(pathOf(folder, rest));
      if (!relativeTo(resolved, strictReal(folder)) || !Deno.statSync(resolved).isFile) throw new Error('outside');
    } catch {
      return send(404, 'Not found');
    }
    if (rest.split('/').slice(0, -1).some((part) => part === '' || part === '.' || part === '..') || rest.endsWith('/')) {
      return send(404, 'Not found');
    }
    const ext = pureSuffix(resolved).toLowerCase();
    let mime = (Object.hasOwn(MIME, ext) ? MIME[ext] : guessType(pureName(resolved))) || 'application/octet-stream';
    let data: Uint8Array;
    try {
      data = Deno.readFileSync(resolved);
    } catch {
      return send(404, 'Not found');
    }
    const extra: Record<string, string> = {};
    const one = (name: string) => Object.hasOwn(query, name) && query[name].length === 1 ? query[name][0] : null;
    if (one('download') === '1') {
      extra['Content-Disposition'] = `attachment; filename="${pureName(resolved).replace(DISPOSITION_UNSAFE, '_')}"`;
    } else if ((ext === '.md' || ext === '.markdown') && one('view') === '1') {
      data = markdownPage(decodeReplace(data), pureStem(resolved));
      mime = 'text/html; charset=utf-8';
    } else if (ext === '.html' || ext === '.htm') {
      data = injectScroll(data);
    }
    return send(200, data, mime, extra, CSP_KINDS.includes(ext));
  };
}

/** The listener: tries Studio port + 1, then any free port. GET only, 127.0.0.1 only. */
export class OriginServer {
  private constructor(readonly server: HttpServer, readonly port: number) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  static start(root: string, studioPort: number): OriginServer {
    const ports = studioPort && studioPort < 65535 ? [studioPort + 1, 0] : [0];
    let bound = 0;
    const handler = makeHandler(root, studioPort, () => bound);
    for (const port of ports) {
      let server: HttpServer;
      try {
        server = serve({ hostname: '127.0.0.1', port, onListen() {}, onError: () => new Response('', { status: 500 }) }, handler);
      } catch {
        continue;
      }
      bound = server.addr.port;
      return new OriginServer(server, bound);
    }
    throw new Error('Could not open the artifact origin port');
  }

  async stop(): Promise<void> {
    await this.server.shutdown();
  }
}
