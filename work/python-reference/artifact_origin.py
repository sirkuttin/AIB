"""The artifact origin: a second, separate HTTP listener (Studio port + 1) that serves artifact snapshots, GET only.

It is a different origin from Studio on purpose: artifact pages are untrusted, so nothing here knows the Studio token, sends CORS
headers or shares code paths with the Studio server. Pages are meant to be shown in a sandboxed iframe without allow-same-origin.
"""
import html
import http.server
import mimetypes
import pathlib
import re
import socketserver
import threading
import urllib.parse

import artifacts
import security

CSP_TEMPLATE = ("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; "
                "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob: 'self'; "
                "media-src data: blob: 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; "
                "frame-ancestors http://127.0.0.1:{port} http://localhost:{port}; "
                "sandbox allow-scripts allow-forms allow-popups allow-downloads")   # same flags as the Studio viewer frame; never allow-same-origin, so a page opened in its own tab gets an opaque origin too
CSP_KINDS = ('.html', '.htm', '.svg', '.md', '.markdown')
MIME = {'.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.csv': 'text/plain; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
        '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'}
PATH_RE = re.compile(r'^/a/([0-9a-f]{16})/v([0-9]{1,6})/(.+)$')

SCROLL_SCRIPT = """<script>(function(){try{var m=/studio-scroll=(-?[0-9.]+),(-?[0-9.]+)/.exec(location.hash);
function go(){if(m)window.scrollTo(+m[1],+m[2]);}
if(m){go();window.addEventListener('load',function(){go();setTimeout(go,60);});}
var t=0;window.addEventListener('scroll',function(){if(t)return;t=requestAnimationFrame(function(){t=0;
try{parent.postMessage({type:'studio-artifact-scroll',x:window.scrollX,y:window.scrollY},'*');}catch(e){}});},{passive:true});}catch(e){}})();</script>"""


def inject_scroll(data):
    text = data.decode('utf-8', 'replace')
    match = None
    for match in re.finditer(r'</body\s*>', text, re.I):
        pass
    if match:
        text = text[:match.start()] + SCROLL_SCRIPT + text[match.start():]
    else:
        text += SCROLL_SCRIPT
    return text.encode('utf-8')


# ---- Markdown viewer (rendered here, raw HTML escaped; the page itself runs no script of its own) -------------------------
_SAFE_LINK = re.compile(r'^(https?://|mailto:|#|/|\./|\.\./|[\w.\-%]+(/|$))', re.I)


def _safe_url(url):
    url = url.strip()
    if re.match(r'^[a-z][a-z0-9+.\-]*:', url, re.I) and not re.match(r'^(https?|mailto):', url, re.I):
        return None
    return url if _SAFE_LINK.match(url) or url == '' else None


def _inline(text):
    codes = []

    def stash(match):
        codes.append('<code>' + html.escape(match.group(1)) + '</code>')
        return f'\x00{len(codes) - 1}\x00'
    text = re.sub(r'`([^`]+)`', stash, text)
    text = html.escape(text, quote=False)

    def image(match):
        src = _safe_url(html.unescape(match.group(2)))
        if src is None or re.match(r'^(mailto:)', src, re.I):
            return html.escape(match.group(1))
        return f'<img alt="{html.escape(html.unescape(match.group(1)), quote=True)}" src="{html.escape(src, quote=True)}">'

    def link(match):
        href = _safe_url(html.unescape(match.group(2)))
        if href is None:
            return match.group(1)
        return f'<a href="{html.escape(href, quote=True)}" target="_blank" rel="noopener noreferrer">{match.group(1)}</a>'
    text = re.sub(r'!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)', image, text)
    text = re.sub(r'\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)', link, text)
    text = re.sub(r'(?<![\w"=>])(https?://[^\s<)]+[^\s<).,;:!?])', lambda m: f'<a href="{m.group(1)}" target="_blank" rel="noopener noreferrer">{m.group(1)}</a>', text)
    text = re.sub(r'\*\*(.+?)\*\*|__(.+?)__', lambda m: f'<strong>{m.group(1) or m.group(2)}</strong>', text)
    text = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<em>\1</em>', text)
    text = re.sub(r'(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])', r'<em>\1</em>', text)
    text = re.sub(r'~~(.+?)~~', r'<del>\1</del>', text)
    return re.sub(r'\x00(\d+)\x00', lambda m: codes[int(m.group(1))], text)


def _cells(line):
    line = line.strip()
    if line.startswith('|'):
        line = line[1:]
    if line.endswith('|'):
        line = line[:-1]
    return [c.strip() for c in line.split('|')]


def render_markdown(source):
    lines = source.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        fence = re.match(r'^\s*(```|~~~)\s*([\w+-]*)', line)
        if fence:
            i += 1
            body = []
            while i < len(lines) and not lines[i].strip().startswith(fence.group(1)):
                body.append(lines[i])
                i += 1
            i += 1
            out.append('<pre><code>' + html.escape('\n'.join(body)) + '</code></pre>')
        elif not line.strip():
            i += 1
        elif re.match(r'^(#{1,6})\s+(.*?)\s*#*\s*$', line):
            m = re.match(r'^(#{1,6})\s+(.*?)\s*#*\s*$', line)
            out.append(f'<h{len(m.group(1))}>{_inline(m.group(2))}</h{len(m.group(1))}>')
            i += 1
        elif re.match(r'^\s*([-*_])(\s*\1){2,}\s*$', line):
            out.append('<hr>')
            i += 1
        elif line.lstrip().startswith('>'):
            body = []
            while i < len(lines) and lines[i].lstrip().startswith('>'):
                body.append(re.sub(r'^\s*>\s?', '', lines[i]))
                i += 1
            out.append('<blockquote>' + render_markdown('\n'.join(body)) + '</blockquote>')
        elif '|' in line and i + 1 < len(lines) and re.match(r'^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$', lines[i + 1]):
            head = _cells(line)
            i += 2
            rows = []
            while i < len(lines) and '|' in lines[i] and lines[i].strip():
                rows.append(_cells(lines[i]))
                i += 1
            table = '<table><thead><tr>' + ''.join(f'<th>{_inline(c)}</th>' for c in head) + '</tr></thead><tbody>'
            table += ''.join('<tr>' + ''.join(f'<td>{_inline(c)}</td>' for c in row) + '</tr>' for row in rows)
            out.append(table + '</tbody></table>')
        elif re.match(r'^\s*([-*+]|\d+[.)])\s+', line):
            ordered = bool(re.match(r'^\s*\d', line))
            items = []
            while i < len(lines) and re.match(r'^\s*([-*+]|\d+[.)])\s+', lines[i]):
                item = re.sub(r'^\s*([-*+]|\d+[.)])\s+', '', lines[i])
                i += 1
                while i < len(lines) and lines[i].strip() and re.match(r'^\s{2,}\S', lines[i]) and not re.match(r'^\s*([-*+]|\d+[.)])\s+', lines[i]):
                    item += ' ' + lines[i].strip()
                    i += 1
                task = re.match(r'^\[([ xX])\]\s+(.*)$', item)
                items.append(('<input type="checkbox" disabled%s> ' % (' checked' if task and task.group(1) != ' ' else '') + _inline(task.group(2))) if task else _inline(item))
            tag = 'ol' if ordered else 'ul'
            out.append(f'<{tag}>' + ''.join(f'<li>{x}</li>' for x in items) + f'</{tag}>')
        else:
            body = []
            while i < len(lines) and lines[i].strip() and not re.match(r'^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s+)', lines[i]):
                body.append(lines[i].strip())
                i += 1
            if not body:   # a line that matched no block rule at all: take it as text so the loop always advances
                body.append(lines[i].strip())
                i += 1
            out.append('<p>' + _inline(' '.join(body)) + '</p>')
    return '\n'.join(out)


VIEWER_CSS = ("body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:46rem;margin:0 auto;padding:1.5rem 1.25rem 4rem;color:#1f2328;background:#fff}"
              "@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#58a6ff}code,pre{background:#161b22!important}th,td{border-color:#30363d!important}blockquote{border-color:#30363d!important}}"
              "h1,h2,h3{line-height:1.25}h1,h2{border-bottom:1px solid #8884;padding-bottom:.25em}code{font:90% ui-monospace,Consolas,monospace;background:#8882;padding:.1em .3em;border-radius:4px}"
              "pre{background:#8882;padding:.8rem 1rem;border-radius:6px;overflow:auto}pre code{background:none;padding:0}blockquote{margin:1em 0;padding:0 1em;border-left:4px solid #8886;color:#8b949e}"
              "table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #d0d7de;padding:.35em .7em}img{max-width:100%}hr{border:0;border-top:1px solid #8884}")


def markdown_page(source, title):
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>'
            f'<style>{VIEWER_CSS}</style></head><body>{render_markdown(source)}{SCROLL_SCRIPT}</body></html>').encode('utf-8')


# ---- the server -----------------------------------------------------------------------------------------
class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def make_handler(root, studio_port):
    root = pathlib.Path(root)

    class Handler(security.BodyDrainMixin, http.server.BaseHTTPRequestHandler):
        server_version = 'ArtifactOrigin'
        protocol_version = 'HTTP/1.0'

        def log_message(self, *_):
            pass

        def send(self, status, body=b'', mime='text/plain; charset=utf-8', extra=None, csp=False):
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Cache-Control', 'no-store')
            if csp:
                self.send_header('Content-Security-Policy', CSP_TEMPLATE.format(port=studio_port))
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def host_ok(self):
            port = self.server.server_port
            return self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}')

        def do_GET(self):
            if not self.host_ok():
                return self.send(403, b'Forbidden')
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            match = PATH_RE.match(urllib.parse.unquote(parsed.path)) if '%00' not in parsed.path and '\\' not in urllib.parse.unquote(parsed.path) else None
            if not match:
                return self.send(404, b'Not found')
            artifact_id, number, rest = match.group(1), int(match.group(2)), match.group(3)
            base = (root / artifact_id / f'v{number}')
            try:
                resolved = (base / rest).resolve(strict=True)
                if not resolved.is_relative_to(base.resolve(strict=True)) or not resolved.is_file():
                    raise OSError
            except (OSError, ValueError, RuntimeError):
                return self.send(404, b'Not found')
            if any(part in ('', '.', '..') for part in rest.split('/')[:-1]) or rest.endswith('/'):
                return self.send(404, b'Not found')
            ext = resolved.suffix.lower()
            mime = MIME.get(ext) or mimetypes.guess_type(resolved.name)[0] or 'application/octet-stream'
            try:
                data = resolved.read_bytes()
            except OSError:
                return self.send(404, b'Not found')
            extra = {}
            if query.get('download') == ['1']:
                extra['Content-Disposition'] = 'attachment; filename="%s"' % re.sub(r'[^\w.\- ]', '_', resolved.name)
            elif ext in ('.md', '.markdown') and query.get('view') == ['1']:
                data, mime = markdown_page(data.decode('utf-8', 'replace'), resolved.stem), 'text/html; charset=utf-8'
            elif ext in ('.html', '.htm'):
                data = inject_scroll(data)
            self.send(200, data, mime, extra, csp=ext in CSP_KINDS)

        def _refuse(self):
            self.send(405, b'Method not allowed', extra={'Allow': 'GET'})
        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _refuse

    return Handler


class OriginServer:
    def __init__(self, root, studio_port):
        self.httpd = None
        for port in ([studio_port + 1] if studio_port and studio_port < 65535 else []) + [0]:
            try:
                self.httpd = _Server(('127.0.0.1', port), make_handler(root, studio_port))
                break
            except OSError:
                continue
        if self.httpd is None:
            raise OSError('Could not open the artifact origin port')
        self.port = self.httpd.server_port
        self.url = f'http://127.0.0.1:{self.port}'
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True, name='artifact-origin')
        self.thread.start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(3)
