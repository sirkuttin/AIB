"""Artifacts: files (HTML pages, diagrams, reports...) the agent made or the user chose to preview, kept as versioned snapshots.

Layout: <state_dir>/artifacts/<id>/manifest.json plus v1/, v2/... (each a snapshot of the artifact's entry file).
Everything here is standard library only. See docs/design/artifacts-contract.md for the data model and routes.
The pages themselves are served by artifact_origin.py on a separate origin; nothing here runs artifact content.
"""
import difflib
import hashlib
import json
import logging
import os
import pathlib
import re
import secrets
import shutil
import threading
import time
import urllib.parse

import security

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())   # a library logger: quiet until a program configures logging (log_setup.py)

KIND_BY_EXT = {'.html': 'html', '.htm': 'html', '.svg': 'svg', '.md': 'md', '.markdown': 'md', '.png': 'image', '.jpg': 'image',
               '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.pdf': 'pdf', '.csv': 'csv', '.json': 'json', '.txt': 'text', '.log': 'text'}
KINDS = ('html', 'svg', 'md', 'image', 'pdf', 'csv', 'json', 'text')
TEXT_KINDS = ('html', 'svg', 'md', 'csv', 'json', 'text')
DEFAULT_EXT = {'html': '.html', 'svg': '.svg', 'md': '.md', 'csv': '.csv', 'json': '.json', 'text': '.txt'}
MAX_VERSIONS = 30
MAX_BYTES = 200 * 1024 * 1024
FOLD_SECONDS = 3.0
SETTLE_SECONDS = 0.6
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_DIFF_CHARS = 1024 * 1024
MAX_BODY_BYTES = 40 * 1024 * 1024
MAX_TRACKED_WRITES = 500
ID_RE = re.compile(r'^[0-9a-f]{16}$')
WRITE_TOOLS = ('write', 'edit', 'multiedit', 'notebookedit')   # Claude Code's own tool names (lower case)
PATH_KEYS = ('file_path', 'notebook_path', 'path', 'filePath', 'filename')


class ArtifactError(Exception):
    def __init__(self, message, status=400, code='invalid'):
        super().__init__(message)
        self.status, self.code = status, code


def kind_for(name):
    return KIND_BY_EXT.get(pathlib.PurePath(str(name)).suffix.lower())


def previewable(name):
    return kind_for(name) is not None


def path_key(path):
    """Comparison key for a file path (Windows is case-insensitive)."""
    try:
        return os.path.normcase(os.path.realpath(str(path)))
    except (OSError, ValueError):
        return os.path.normcase(os.path.abspath(str(path)))


def inside(path, folder):
    """True when path resolves to a location at or below folder."""
    try:
        a, b = path_key(path), path_key(folder)
        return os.path.commonpath([a, b]) == b
    except ValueError:
        return False


def safe_entry_name(name, fallback='artifact'):
    base = os.path.basename(str(name or '').replace('\\', '/'))
    base = re.sub(r'[^\w.\- ()\[\]]+', '_', base, flags=re.UNICODE).strip(' .')
    return base[:120] or fallback


def _atomic_write(path, data):
    path = pathlib.Path(path)
    tmp = path.with_name(f'.{path.name}.{secrets.token_hex(4)}.tmp')
    with open(tmp, 'wb') as handle:
        handle.write(data)
        handle.flush()
        try:
            os.fsync(handle.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


class ArtifactStore:
    def __init__(self, root, clock=time.time):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.lock = threading.RLock()
        self.origin = ''        # 'http://127.0.0.1:<port>' once the artifact origin listener is up
        self._cache = {}        # id -> (mtime_ns, size, manifest)

    # ---- reading -------------------------------------------------------------------------------
    def folder(self, artifact_id):
        if not isinstance(artifact_id, str) or not ID_RE.match(artifact_id):
            raise ArtifactError('Unknown artifact', 404, 'not_found')
        return self.root / artifact_id

    def get(self, artifact_id):
        folder = self.folder(artifact_id)
        manifest_path = folder / 'manifest.json'
        try:
            stat = manifest_path.stat()
        except OSError:
            raise ArtifactError('Unknown artifact', 404, 'not_found')
        with self.lock:
            cached = self._cache.get(artifact_id)
            if cached and cached[:2] == (stat.st_mtime_ns, stat.st_size):
                return json.loads(json.dumps(cached[2]))
            try:
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                raise ArtifactError('Unknown artifact', 404, 'not_found')
            self._cache[artifact_id] = (stat.st_mtime_ns, stat.st_size, manifest)
            return json.loads(json.dumps(manifest))

    def all(self):
        found = []
        try:
            names = [p.name for p in self.root.iterdir() if p.is_dir() and ID_RE.match(p.name)]
        except OSError:
            return found
        for name in names:
            try:
                found.append(self.get(name))
            except ArtifactError:
                continue
        return found

    def version_url(self, manifest, version):
        entry = version.get('entry') or manifest['entry']
        return f"{self.origin}/a/{manifest['id']}/v{version['n']}/{urllib.parse.quote(entry)}"

    def summary(self, manifest):
        latest = manifest['versions'][-1]
        out = {'id': manifest['id'], 'title': manifest['title'], 'kind': manifest['kind'], 'version': latest['n'], 'versions': len(manifest['versions']),
               'updatedAt': manifest['updatedAt'], 'pinned': bool(manifest.get('pinned')), 'sourcePath': manifest.get('sourcePath'),
               'conversationId': manifest.get('conversationId'), 'url': self.version_url(manifest, latest), 'link': 'studio-artifact://' + manifest['id']}
        if manifest['kind'] == 'md':
            out['viewUrl'] = out['url'] + '?view=1'
        if manifest.get('sourceMissing'):
            out['sourceMissing'] = True
        return out

    def item(self, artifact_id):
        manifest = self.get(artifact_id)
        manifest['url'] = self.version_url(manifest, manifest['versions'][-1])
        manifest['link'] = 'studio-artifact://' + manifest['id']
        for version in manifest['versions']:
            version['url'] = self.version_url(manifest, version)
        return manifest

    def list(self, conversation_id=None, also=()):
        wanted = {conversation_id, *also}
        items = [m for m in self.all() if conversation_id is None or m.get('conversationId') in wanted]
        items.sort(key=lambda m: (not m.get('pinned'), -m['updatedAt']))
        return [self.summary(m) for m in items]

    def find_by_source(self, conversation_id, path):
        key = path_key(path)
        for manifest in self.all():
            if manifest.get('conversationId') == conversation_id and manifest.get('sourcePath') and path_key(manifest['sourcePath']) == key:
                return manifest
        return None

    # ---- writing -------------------------------------------------------------------------------
    def _save(self, manifest):
        _atomic_write(self.folder(manifest['id']) / 'manifest.json', json.dumps(manifest, ensure_ascii=False, indent=1).encode('utf-8'))
        self._cache.pop(manifest['id'], None)

    def _write_version(self, artifact_id, number, entry, data):
        """Write v<number>/<entry> atomically (temp folder, then rename over any previous one)."""
        folder = self.folder(artifact_id)
        tmp = folder / f'.v{number}.{secrets.token_hex(4)}.tmp'
        tmp.mkdir(parents=True)
        try:
            (tmp / entry).write_bytes(data)
            final = folder / f'v{number}'
            if final.exists():
                old = folder / f'.v{number}.{secrets.token_hex(4)}.old'
                os.replace(final, old)
                os.replace(tmp, final)
                shutil.rmtree(old, ignore_errors=True)
            else:
                os.replace(tmp, final)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise

    def create(self, conversation_id, title, kind, entry, data, project=None, source_path=None, by='tool', tool_call_id=None, note=''):
        """New artifact with version 1. Returns the manifest."""
        if kind not in KINDS:
            raise ArtifactError('Unsupported kind')
        now = self.clock()
        with self.lock:
            while True:
                artifact_id = secrets.token_hex(8)
                if not self.folder(artifact_id).exists():
                    break
            self.folder(artifact_id).mkdir(parents=True)
            version = {'n': 1, 'at': now, 'hash': hashlib.sha256(data).hexdigest(), 'size': len(data), 'by': by, 'toolCallId': tool_call_id, 'note': note or '', 'entry': entry}
            manifest = {'id': artifact_id, 'title': (title or entry)[:200], 'kind': kind, 'project': project, 'conversationId': conversation_id,
                        'sourcePath': str(source_path) if source_path else None, 'entry': entry, 'createdAt': now, 'updatedAt': now, 'pinned': False, 'versions': [version]}
            self._write_version(artifact_id, 1, entry, data)
            self._save(manifest)
            return manifest

    def add_version(self, artifact_id, data, entry=None, by='tool', tool_call_id=None, note='', title=None, source_path=None):
        """Returns (manifest, changed). Identical content to the latest version adds nothing; a watcher change within
        FOLD_SECONDS of the latest version replaces it instead of adding one."""
        digest = hashlib.sha256(data).hexdigest()
        with self.lock:
            manifest = self.get(artifact_id)
            latest = manifest['versions'][-1]
            entry = entry or latest.get('entry') or manifest['entry']
            dirty = False
            if title and title != manifest['title']:
                manifest['title'], dirty = title[:200], True
            if source_path and str(source_path) != manifest.get('sourcePath'):
                manifest['sourcePath'], dirty = str(source_path), True
            if manifest.pop('sourceMissing', None):
                dirty = True
            if digest == latest['hash']:
                if dirty:
                    self._save(manifest)
                return manifest, dirty
            now = self.clock()
            if by == 'watch' and now - latest['at'] < FOLD_SECONDS:
                number = latest['n']
                self._write_version(artifact_id, number, entry, data)
                latest.update({'at': now, 'hash': digest, 'size': len(data), 'entry': entry})
                if note:
                    latest['note'] = note
            else:
                number = max(v['n'] for v in manifest['versions']) + 1
                self._write_version(artifact_id, number, entry, data)
                manifest['versions'].append({'n': number, 'at': now, 'hash': digest, 'size': len(data), 'by': by, 'toolCallId': tool_call_id, 'note': note or '', 'entry': entry})
            manifest['entry'] = entry
            manifest['updatedAt'] = now
            self._retain(manifest)
            self._save(manifest)
            return manifest, True

    def _retain(self, manifest):
        """Keep the newest MAX_VERSIONS / MAX_BYTES; v1 and the latest stay; pinned artifacts keep everything."""
        if manifest.get('pinned'):
            return
        versions = manifest['versions']
        while True:
            total = sum(v.get('size', 0) for v in versions)
            if len(versions) <= MAX_VERSIONS and total <= MAX_BYTES:
                return
            removable = versions[1:-1]
            if not removable:
                return
            victim = removable[0]
            versions.remove(victim)
            shutil.rmtree(self.folder(manifest['id']) / f"v{victim['n']}", ignore_errors=True)

    def set_pinned(self, artifact_id, pinned):
        with self.lock:
            manifest = self.get(artifact_id)
            if bool(manifest.get('pinned')) == bool(pinned):
                return manifest, False
            manifest['pinned'] = bool(pinned)
            self._save(manifest)
            return manifest, True

    def set_source_missing(self, artifact_id, missing):
        with self.lock:
            manifest = self.get(artifact_id)
            if bool(manifest.get('sourceMissing')) == bool(missing):
                return manifest, False
            if missing:
                manifest['sourceMissing'] = True
            else:
                manifest.pop('sourceMissing', None)
            self._save(manifest)
            return manifest, True

    def restore(self, artifact_id, number):
        with self.lock:
            manifest = self.get(artifact_id)
            version = next((v for v in manifest['versions'] if v['n'] == number), None)
            if version is None:
                raise ArtifactError('That version no longer exists', 404, 'not_found')
            entry = version.get('entry') or manifest['entry']
            data = (self.folder(artifact_id) / f'v{number}' / entry).read_bytes()
            return self.add_version(artifact_id, data, entry=entry, by='tool', note=f'Restored from v{number}')

    def version_file(self, manifest, number):
        version = next((v for v in manifest['versions'] if v['n'] == number), None)
        if version is None:
            raise ArtifactError('That version does not exist', 404, 'not_found')
        return self.folder(manifest['id']) / f'v{number}' / (version.get('entry') or manifest['entry'])

    def source(self, artifact_id, number=None):
        manifest = self.get(artifact_id)
        if manifest['kind'] not in TEXT_KINDS:
            raise ArtifactError('Only text artifacts have a source view', 400, 'not_text')
        number = number or manifest['versions'][-1]['n']
        with open(self.version_file(manifest, number), 'rb') as handle:
            data = handle.read(MAX_SOURCE_BYTES + 1)
        return {'text': data[:MAX_SOURCE_BYTES].decode('utf-8', 'replace'), 'truncated': len(data) > MAX_SOURCE_BYTES}

    def diff(self, artifact_id, a, b):
        manifest = self.get(artifact_id)
        if manifest['kind'] not in TEXT_KINDS:
            raise ArtifactError('Only text artifacts can be compared', 400, 'not_text')
        texts = []
        for number in (a, b):
            with open(self.version_file(manifest, number), 'rb') as handle:
                texts.append(handle.read(MAX_SOURCE_BYTES).decode('utf-8', 'replace').splitlines(keepends=True))
        # A last line without a line break gets one plus the "\ No newline at end of file" line (else "-old+new" is glued).
        text = ''.join(line + '\n\\ No newline at end of file\n' if line and line.splitlines() == [line] else line
                       for line in difflib.unified_diff(texts[0], texts[1], f'v{a}', f'v{b}'))
        if text and not text.endswith('\n'):
            text += '\n'
        return {'diff': text[:MAX_DIFF_CHARS], 'truncated': len(text) > MAX_DIFF_CHARS}


# ---- agent tool key hook (agent C fills this in) ---------------------------------------------------
def authorize_tool_key(handler, conversation_id):
    """True when the request carries a valid X-Studio-Artifact-Key for exactly this conversation.
    The publish and list routes accept either the Studio page token or this returning True. Keys come from artifact_keys
    (an HMAC of the conversation id, shared by the web server and the agent host through the state folder)."""
    try:
        import artifact_keys
        return artifact_keys.check(handler.headers.get('X-Studio-Artifact-Key'), conversation_id)
    except Exception:  # a missing or unreadable secret means "no", never a crash
        log.exception('Artifact key authorization failed; treated as not authorized')
        return False


_TITLE_RE = re.compile(rb'<title[^>]*>(.*?)</title>', re.I | re.S)


def guess_title(path, kind, data):
    name = pathlib.PurePath(str(path)).stem.replace('_', ' ').replace('-', ' ').strip() or 'Artifact'
    if kind == 'html':
        match = _TITLE_RE.search(data[:65536])
        if match:
            text = re.sub(r'\s+', ' ', match.group(1).decode('utf-8', 'replace')).strip()
            if text:
                return text[:200]
    return name[:200]


def read_capped(path):
    size = os.path.getsize(path)
    if size > MAX_FILE_BYTES:
        raise ArtifactError('That file is too large to preview (limit 25 MB)', 413, 'too_large')
    with open(path, 'rb') as handle:
        return handle.read()


class Service:
    """Routes and sync logic. `cwd_for(conversation_id)` returns the project folder or None;
    `emit(conversation_id, event)` pushes a live event to the page.
    `chat_of(id)` turns a live connection id into the chat's lasting id ("provider:sessionId"), so a chat keeps its
    artifacts when it reconnects under a new connection; ids it does not know pass through unchanged."""

    def __init__(self, store, token_getter, cwd_for, emit=None, chat_of=None, root_for=None):
        self.store, self.token_getter, self.cwd_for, self.emit = store, token_getter, cwd_for, emit
        self.root_for = root_for or cwd_for   # `root_for(conversation_id)`: the chat's projectRoot, which artifacts are tagged with; today the cwd
        self.chat_of = chat_of or (lambda ident: ident)

    def project_root_for(self, conversation_id):
        return self.root_for(conversation_id) or self.cwd_for(conversation_id)

    def _chat(self, ident):
        try:
            chat = self.chat_of(ident)
        except Exception:
            log.exception('Looking up the chat for conversation %s failed', ident)
            chat = None
        return chat if isinstance(chat, str) and chat else ident

    def _event(self, manifest):
        summary = self.store.summary(manifest)
        if self.emit and manifest.get('conversationId'):
            try:
                self.emit(manifest['conversationId'], {'type': 'artifact', 'conversationId': manifest['conversationId'], 'artifact': summary})
            except Exception:
                log.exception('Emitting the artifact event failed')
        return summary

    def _token_ok(self, handler):
        return security.token_matches(handler.headers.get('X-Studio-Token', ''), self.token_getter())

    @staticmethod
    def _denied(handler):
        """The 403 when neither token nor key passed: name the key when one was sent."""
        return 403, {'error': 'Invalid artifact key' if handler.headers.get('X-Studio-Artifact-Key') is not None else 'Invalid local session token'}

    def _authorized(self, handler, conversation_id, tool_route):
        if self._token_ok(handler):
            return True
        return bool(tool_route and isinstance(conversation_id, str) and conversation_id and authorize_tool_key(handler, conversation_id))

    def resolve_path(self, conversation_id, raw):
        cwd = self.cwd_for(conversation_id)
        if not cwd:
            raise ArtifactError('This chat has no known project folder.', 404, 'unknown_folder')
        if not isinstance(raw, str) or not raw or '\0' in raw or len(raw) > 2000:
            raise ArtifactError('Choose a file')
        candidate = pathlib.Path(raw)
        if not candidate.is_absolute():
            candidate = pathlib.Path(cwd) / candidate
        if not inside(candidate, cwd):
            raise ArtifactError("That file is outside the chat's project folder.", 403, 'outside_project')
        real = pathlib.Path(os.path.realpath(candidate))
        if not real.is_file():
            raise ArtifactError('That file does not exist.', 404, 'not_found')
        if kind_for(real.name) is None:
            raise ArtifactError('That kind of file cannot be previewed.', 400, 'unsupported_kind')
        return cwd, real

    def sync_file(self, conversation_id, real, by, cwd=None, title=None, tool_call_id=None, note='', project_root=None):
        """Create the artifact for a file in this chat, or add a version if its content changed. Returns (manifest, changed)."""
        data = read_capped(real)
        kind = kind_for(real.name)
        with self.store.lock:
            existing = self.store.find_by_source(conversation_id, real)
            if existing:
                return self.store.add_version(existing['id'], data, entry=safe_entry_name(real.name), by=by, tool_call_id=tool_call_id, note=note, title=title)
            manifest = self.store.create(conversation_id, title or guess_title(real, kind, data), kind, safe_entry_name(real.name), data, project=project_root or cwd,
                                         source_path=str(real), by=by, tool_call_id=tool_call_id, note=note)
            return manifest, True

    @staticmethod
    def _int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ArtifactError('Invalid version')

    # ---- GET ----
    def handle_get(self, handler, path, args):
        one = lambda name, default='': args.get(name, [default])[0]
        if path == '/api/live/artifacts':
            conversation_id = one('conversationId')
            if not self._authorized(handler, conversation_id, True):
                return self._denied(handler)
            if not conversation_id:
                return 400, {'error': 'Choose a chat', 'code': 'invalid'}
            return 200, {'artifacts': self.store.list(self._chat(conversation_id), also=(conversation_id,))}
        if not self._token_ok(handler):
            return 403, {'error': 'Invalid local session token'}
        try:
            if path == '/api/live/artifacts/item':
                return 200, self.store.item(one('id'))
            if path == '/api/live/artifacts/source':
                return 200, self.store.source(one('id'), self._int(one('version')) if one('version') else None)
            if path == '/api/live/artifacts/diff':
                manifest = self.store.get(one('id'))
                to = self._int(one('to')) if one('to') else manifest['versions'][-1]['n']
                frm = self._int(one('from')) if one('from') else max(1, to - 1)
                return 200, self.store.diff(one('id'), frm, to)
        except ArtifactError as error:
            return error.status, {'error': str(error), 'code': error.code}
        except OSError as error:
            return 400, {'error': str(error)}
        return 404, {'error': 'Not found'}

    # ---- POST ----
    def handle_post(self, handler, path, body):
        if not isinstance(body, dict):
            return 400, {'error': 'Invalid request'}
        publish = path == '/api/live/artifacts/publish'
        if not self._authorized(handler, body.get('conversationId') if publish else None, publish):
            return self._denied(handler)
        try:
            if path == '/api/live/artifacts/preview':
                return 200, self._preview(body)
            if publish:
                return 200, self._publish(body)
            if path == '/api/live/artifacts/pin':
                if not isinstance(body.get('pinned'), bool):
                    raise ArtifactError('pinned must be true or false')
                manifest, changed = self.store.set_pinned(body.get('id'), body['pinned'])
                return 200, self._event(manifest) if changed else self.store.summary(manifest)
            if path == '/api/live/artifacts/restore':
                number = body.get('version')
                if not isinstance(number, int) or isinstance(number, bool):
                    raise ArtifactError('Choose a version')
                manifest, changed = self.store.restore(body.get('id'), number)
                return 200, self._event(manifest) if changed else self.store.summary(manifest)
        except ArtifactError as error:
            return error.status, {'error': str(error), 'code': error.code}
        except OSError as error:
            return 400, {'error': str(error)}
        return 404, {'error': 'Not found'}

    @staticmethod
    def _conversation(body, chat=None):
        conversation_id = body.get('conversationId')
        if not isinstance(conversation_id, str) or not conversation_id or len(conversation_id) > 600:
            raise ArtifactError('Choose a chat')
        return chat(conversation_id) if chat else conversation_id

    def _preview(self, body):
        conversation_id = Service._conversation(body, self._chat)
        cwd, real = self.resolve_path(conversation_id, body.get('path'))
        manifest, changed = self.sync_file(conversation_id, real, 'preview', cwd=cwd, project_root=self.project_root_for(conversation_id))
        return self._event(manifest) if changed else self.store.summary(manifest)

    def _publish(self, body):
        conversation_id = Service._conversation(body, self._chat)
        has_path, has_content = body.get('path') is not None, body.get('content') is not None
        if has_path == has_content:
            raise ArtifactError('Give exactly one of path or content')
        title = body.get('title')
        if title is not None and not isinstance(title, str):
            raise ArtifactError('title must be text')
        note = body.get('note') if isinstance(body.get('note'), str) else ''
        tool_call_id = body.get('toolCallId') if isinstance(body.get('toolCallId'), str) else None
        kind = body.get('kind')
        if kind is not None and kind not in KINDS:
            raise ArtifactError('Unsupported kind')
        existing = None
        if body.get('id') is not None:
            existing = self.store.get(body['id'])
            if existing.get('conversationId') not in (conversation_id, body.get('conversationId')):
                raise ArtifactError('That artifact belongs to another chat', 403, 'wrong_conversation')
        if has_path:
            cwd, real = self.resolve_path(conversation_id, body['path'])
            if existing:
                manifest, changed = self.store.add_version(existing['id'], read_capped(real), entry=safe_entry_name(real.name), by='tool', tool_call_id=tool_call_id,
                                                           note=note, title=title or None, source_path=str(real))
            else:   # the same file in the same chat is the same artifact (the watcher may already have made it)
                manifest, changed = self.sync_file(conversation_id, real, 'tool', cwd=cwd, project_root=self.project_root_for(conversation_id), title=title or None, tool_call_id=tool_call_id, note=note)
        else:
            content = body['content']
            if not isinstance(content, str):
                raise ArtifactError('content must be text')
            data = content.encode('utf-8')
            if len(data) > MAX_FILE_BYTES:
                raise ArtifactError('Content too large (limit 25 MB)', 413, 'too_large')
            if existing:
                manifest, changed = self.store.add_version(existing['id'], data, by='tool', tool_call_id=tool_call_id, note=note, title=title or None)
            else:
                filename = body.get('filename')
                if isinstance(filename, str) and filename.strip():
                    entry = safe_entry_name(filename)
                    kind = kind or kind_for(entry)
                    if kind is None:
                        raise ArtifactError('That kind of file cannot be previewed.', 400, 'unsupported_kind')
                else:
                    kind = kind or 'html'
                    entry = safe_entry_name(re.sub(r'\s+', '-', (title or 'artifact').strip()).lower(), 'artifact')
                if kind not in TEXT_KINDS:
                    raise ArtifactError('Content can only be published as html, svg, md, csv, json or text')
                if kind_for(entry) != kind:
                    entry = pathlib.PurePath(entry).stem + DEFAULT_EXT[kind]
                manifest = self.store.create(conversation_id, title or guess_title(entry, kind, data), kind, entry, data, project=self.project_root_for(conversation_id),
                                             by='tool', tool_call_id=tool_call_id, note=note)
                changed = True
        return self._event(manifest) if changed else self.store.summary(manifest)


# ---- write tracking --------------------------------------------------------------------------------
class WriteTracker:
    """The files one conversation's agent has written, learned from its ACP session/update notifications.

    Only the agent's own write-like tool calls count (kind edit, diff content, or Claude Code's Write / Edit / MultiEdit /
    NotebookEdit). Reads, searches and shell commands never do. This is the only thing that lets the Watcher attach a file to a chat."""

    def __init__(self, cwd=''):
        self.cwd = str(cwd or '')
        self.lock = threading.Lock()
        self.paths = {}      # path -> last time it was written (insertion ordered, oldest dropped)
        self.calls = {}      # toolCallId -> True when that call is a write (later updates may omit the kind)

    @staticmethod
    def _tool_name(update):
        meta = update.get('_meta')
        claude = meta.get('claudeCode') if isinstance(meta, dict) else None
        name = (claude.get('toolName') if isinstance(claude, dict) else None) or update.get('toolName')
        return name.rsplit('__', 1)[-1].lower() if isinstance(name, str) else ''

    @staticmethod
    def _is_write(update):
        content = update.get('content')
        if isinstance(content, list) and any(isinstance(i, dict) and i.get('type') == 'diff' for i in content):
            return True
        return update.get('kind') == 'edit' or WriteTracker._tool_name(update) in WRITE_TOOLS

    def observe(self, params, now=None):
        """Feed one session/update `params`. Returns the paths it recorded."""
        update = params.get('update') if isinstance(params, dict) else None
        if not isinstance(update, dict) or update.get('sessionUpdate') not in ('tool_call', 'tool_call_update'):
            return []
        call_id = update.get('toolCallId')
        with self.lock:
            write = self._is_write(update)
            if isinstance(call_id, (str, int)):
                if write:
                    self.calls[call_id] = True
                    while len(self.calls) > 200:
                        self.calls.pop(next(iter(self.calls)))
                elif update.get('kind') in (None, '') and call_id in self.calls:
                    write = True   # a later update of a call already known to be a write
            if not write:
                return []
            found = []
            content = update.get('content')
            for item in content if isinstance(content, list) else []:
                if isinstance(item, dict) and item.get('type') == 'diff':
                    found.append(item.get('path'))
            locations = update.get('locations')
            for loc in locations if isinstance(locations, list) else []:
                found.append(loc.get('path') if isinstance(loc, dict) else None)
            raw = update.get('rawInput')
            if isinstance(raw, dict):
                found.extend(raw.get(key) for key in PATH_KEYS)
            recorded = []
            for path in found:
                if not isinstance(path, str) or not path.strip() or len(path) > 2000 or '\0' in path:
                    continue
                if not os.path.isabs(path) and self.cwd:
                    path = os.path.join(self.cwd, path)
                path = os.path.normpath(path)
                self.paths.pop(path, None)
                self.paths[path] = time.time() if now is None else now
                recorded.append(path)
            while len(self.paths) > MAX_TRACKED_WRITES:
                self.paths.pop(next(iter(self.paths)))
            return recorded

    def written(self):
        with self.lock:
            return list(self.paths)


# ---- watcher ---------------------------------------------------------------------------------------
class Watcher:
    """Turns files a chat's own agent wrote into that chat's artifacts, and keeps existing artifacts' versions current.

    A file becomes an artifact of conversation C only when C's agent wrote it (conversations() gives each open chat as
    {'id', 'cwd', 'writes': [paths its agent wrote]}) and it lies in <cwd>/outputs/. Nothing else attaches a file to a chat: not a
    git merge, another chat's agent, or an edit from another app. Artifacts that already have a sourcePath (the agent's, or one made
    with Preview) get a new version when that file changes, about once a second."""

    def __init__(self, service, conversations, interval=1.0, settle=SETTLE_SECONDS, clock=time.monotonic, list_every=2.0):
        self.service, self.conversations, self.interval, self.settle, self.clock = service, conversations, interval, settle, clock
        self.list_every = list_every
        self.stop_event = threading.Event()
        self.thread = None
        self.seen = {}        # (conversation id, path key) -> {'stat', 'since', 'pending'}
        self._convs, self._convs_at = [], -1e9

    def start(self):
        self.thread = threading.Thread(target=self._run, daemon=True, name='artifact-watcher')
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(3)

    def _run(self):
        while not self.stop_event.wait(self.interval):
            try:
                self.tick()
            except Exception:
                log.exception('Artifact watcher tick failed; will retry')

    @staticmethod
    def _stat(path):
        try:
            st = os.stat(path)
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size)

    def tick(self, now=None):
        now = self.clock() if now is None else now
        if now - self._convs_at >= self.list_every:
            try:
                self._convs = [c for c in self.conversations() if c.get('id') and c.get('cwd')]
            except Exception:
                log.exception('Artifact watcher could not list conversations; keeping the previous list')
            self._convs_at = now
        store = self.service.store
        candidates = {}   # (conversation id, path key) -> (path, cwd, projectRoot)
        for conv in self._convs:
            cid, cwd = conv['id'], conv['cwd']
            root = conv.get('projectRoot') or cwd
            outputs = pathlib.Path(cwd) / 'outputs'
            for path in conv.get('writes') or []:
                if previewable(path) and not os.path.basename(path).startswith('.') and inside(path, outputs):
                    candidates[(cid, path_key(path))] = (path, cwd, root)
        known = {}
        for manifest in store.all():
            if manifest.get('sourcePath') and manifest.get('conversationId'):
                known[(manifest['conversationId'], path_key(manifest['sourcePath']))] = manifest
        for key, manifest in known.items():
            if key not in candidates:
                candidates[key] = (manifest['sourcePath'], manifest.get('project'), manifest.get('project'))
        for key, (path, cwd, root) in candidates.items():
            manifest = known.get(key)
            stat = self._stat(path)
            if stat is None:
                if manifest:
                    updated, changed = store.set_source_missing(manifest['id'], True)
                    if changed:
                        self.service._event(updated)
                self.seen.pop(key, None)
                continue
            record = self.seen.get(key)
            if record is None:
                record = self.seen[key] = {'stat': stat, 'since': now, 'pending': True}
            elif record['stat'] != stat:
                record.update(stat=stat, since=now, pending=True)
            if record['pending'] and now - record['since'] >= self.settle:
                record['pending'] = False
                try:
                    real = pathlib.Path(os.path.realpath(path))
                    if manifest:
                        updated, changed = store.add_version(manifest['id'], read_capped(real), entry=safe_entry_name(real.name), by='watch', source_path=str(real))
                    else:
                        updated, changed = self.service.sync_file(key[0], real, 'watch', cwd=cwd, project_root=root)
                    if changed:
                        self.service._event(updated)
                except (ArtifactError, OSError):
                    pass
