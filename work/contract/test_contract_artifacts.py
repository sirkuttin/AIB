"""Contract, differential: the artifact routes (/api/live/artifacts*) and the artifact origin give the same answers from the server under
test as from the Python reference. Both stores are pre-filled with the same artifacts by the Python artifacts module (the same ids, so
replies compare directly); the origin's address and new artifacts' random ids are normalised. Publish is checked with the page token and
with an agent tool key made from each server's own key secret (artifact_keys)."""
import importlib
import json
import pathlib
import re
import shutil
import sys
import tempfile
import unittest
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from server_under_test import PY_REF, Server  # noqa: E402

sys.path.insert(0, str(PY_REF))
artifacts = importlib.import_module('artifacts')
artifact_keys = importlib.import_module('artifact_keys')

VOLATILE = {'updatedAt', 'createdAt', 'at'}
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000') + b'\0' * 20
CHAT = 'claude:art'


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k not in VOLATILE}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


class ArtifactContract(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.project = pathlib.Path(tempfile.mkdtemp(prefix='aib-contract-art-')).resolve()
        (cls.project / 'outputs').mkdir()
        (cls.project / 'outputs' / 'page.html').write_text('<html><title>From disk</title><body>disk</body></html>', encoding='utf-8')
        (cls.project / 'notes.txt').write_text('plain\n', encoding='utf-8')
        cls.subject = Server().__enter__()
        cls.reference = Server(kind='python').__enter__()
        store = artifacts.ArtifactStore(cls.subject.state_dir / 'artifacts')
        page = store.create(CHAT, 'A page', 'html', 'page.html', b'<html><body>one\ntwo\n</body></html>', project=str(cls.project))
        store.add_version(page['id'], b'<html><body>one\nTWO\nthree\n</body></html>', by='tool', note='second')
        notes = store.create(CHAT, 'Notes', 'md', 'notes.md', '# Title\n\n* a\n* b\n\n`code` and **bold**\n'.encode('utf-8'))
        image = store.create(CHAT, 'Picture', 'image', 'pic.png', PNG)
        other = store.create('claude:other', 'Data', 'json', 'data.json', b'{"a": 1}')
        cls.ids = {'page': page['id'], 'notes': notes['id'], 'image': image['id'], 'other': other['id']}
        shutil.copytree(cls.subject.state_dir / 'artifacts', cls.reference.state_dir / 'artifacts', dirs_exist_ok=True)
        for server in (cls.subject, cls.reference):   # the chat's project folder is known from its mark
            server.post('/api/live/conversation-state', {'action': 'delete', 'provider': 'claude', 'sessionId': 'art', 'cwd': str(cls.project)})

    @classmethod
    def tearDownClass(cls):
        cls.subject.__exit__(None, None, None)
        cls.reference.__exit__(None, None, None)
        shutil.rmtree(cls.project, ignore_errors=True)

    # ---- helpers ----
    def origin_of(self, server):
        return server.bootstrap().json()['artifactOrigin']

    def normalize(self, data, server):
        text = json.dumps(data).replace(self.origin_of(server), '<origin>')
        known = set(self.ids.values())
        text = re.sub(r'\b[0-9a-f]{16}\b', lambda m: m.group(0) if m.group(0) in known else '<new>', text)
        return strip(json.loads(text))

    def compare(self, a, b, what):
        self.assertEqual((a.status, self.normalize(a.json(), self.subject)), (b.status, self.normalize(b.json(), self.reference)), what)

    def same_get(self, path, **headers):
        a, b = self.subject.get(path, **headers), self.reference.get(path, **headers)
        self.compare(a, b, path)
        return a

    def same_post(self, path, body, **headers):
        a, b = self.subject.post(path, body, **headers), self.reference.post(path, body, **headers)
        self.compare(a, b, f'{path} {body}')
        return a

    def agent_request(self, server, method, path, body=None, key=None, conversation=CHAT, **extra):
        if key is None:
            artifact_keys.configure(str(server.state_dir))
            key = artifact_keys.issue(conversation) or ''
            artifact_keys.configure(None)
        headers = {'Host': f'127.0.0.1:{server.port}', 'X-Studio-Artifact-Key': key, **extra}
        return server.request(method, path, headers, body)

    def same_agent(self, method, path, body=None, **kwargs):
        a = self.agent_request(self.subject, method, path, body, **kwargs)
        b = self.agent_request(self.reference, method, path, body, **kwargs)
        self.compare(a, b, f'agent {method} {path} {body} {kwargs}')
        return a

    # ---- page-side reads ----
    def test_a_list_item_source_diff(self):
        listed = self.same_get(f'/api/live/artifacts?conversationId={CHAT}')
        self.assertEqual(len(listed.json()['artifacts']), 3)
        for path in ('/api/live/artifacts', '/api/live/artifacts?conversationId=', '/api/live/artifacts?conversationId=claude:other',
                     '/api/live/artifacts?conversationId=nobody'):
            self.same_get(path)
        self.same_get(f'/api/live/artifacts?conversationId={CHAT}', X_Studio_Token='wrong')
        for name, ident in self.ids.items():
            self.same_get(f'/api/live/artifacts/item?id={ident}')
            self.same_get(f'/api/live/artifacts/source?id={ident}')
            self.same_get(f'/api/live/artifacts/diff?id={ident}')
        page = self.ids['page']
        for query in (f'id={page}&version=1', f'id={page}&version=2', f'id={page}&version=9', f'id={page}&version=abc', 'id=', 'id=zz',
                      'id=0123456789abcdef'):
            self.same_get('/api/live/artifacts/source?' + query)
        for query in (f'id={page}&from=1&to=2', f'id={page}&from=2&to=1', f'id={page}&to=1', f'id={page}&to=9', f'id={page}&from=x', 'id=nope'):
            self.same_get('/api/live/artifacts/diff?' + query)
        self.same_get(f'/api/live/artifacts/item?id={page}', X_Studio_Token='wrong')
        self.same_get('/api/live/artifacts/nope')

    # ---- page-side writes ----
    def test_b_pin_restore_preview(self):
        page, notes = self.ids['page'], self.ids['notes']
        for body in ({'id': notes, 'pinned': True}, {'id': notes, 'pinned': True}, {'id': notes, 'pinned': 'yes'}, {'id': 'nope', 'pinned': True},
                     {'id': notes, 'pinned': False}, {}):
            self.same_post('/api/live/artifacts/pin', body)
        for body in ({'id': page, 'version': 1}, {'id': page, 'version': 1}, {'id': page, 'version': 'x'}, {'id': page, 'version': 99},
                     {'id': page, 'version': True}, {'id': 'nope', 'version': 1}):
            self.same_post('/api/live/artifacts/restore', body)
        restored = self.same_get(f'/api/live/artifacts/item?id={page}')
        self.assertEqual(len(restored.json()['versions']), 3, restored.text)
        made = self.same_post('/api/live/artifacts/preview', {'conversationId': CHAT, 'path': 'outputs/page.html'})
        self.assertEqual((made.status, made.json().get('title')), (200, 'From disk'), made.text)
        for body in ({'conversationId': CHAT, 'path': 'outputs/page.html'}, {'conversationId': CHAT, 'path': 'outputs/page.html'},
                     {'conversationId': CHAT, 'path': str(self.project / 'outputs' / 'page.html')},
                     {'conversationId': CHAT, 'path': 'missing.html'}, {'conversationId': CHAT, 'path': '../outside.html'},
                     {'conversationId': CHAT, 'path': 'notes.txt'}, {'conversationId': CHAT, 'path': ''}, {'conversationId': CHAT},
                     {'conversationId': 'claude:nofolder', 'path': 'x.html'}, {'conversationId': '', 'path': 'x.html'}, {'path': 'x.html'}):
            self.same_post('/api/live/artifacts/preview', body)
        self.same_get(f'/api/live/artifacts?conversationId={CHAT}')
        self.same_post('/api/live/artifacts/pin', {'id': notes, 'pinned': True}, X_Studio_Token='wrong')
        self.same_post('/api/live/artifacts/nope', {'id': notes})
        for server in (self.subject, self.reference):   # a list body is treated as {}; a broken one is a 400
            server.list_reply = server.post('/api/live/artifacts/pin', [1, 2])
            server.empty_reply = server.request('POST', '/api/live/artifacts/pin', server.page_headers(), b'')
        self.compare(self.subject.list_reply, self.reference.list_reply, 'list body')
        self.compare(self.subject.empty_reply, self.reference.empty_reply, 'empty body')

    # ---- publish: page token and agent key ----
    def test_c_publish(self):
        page = self.ids['page']
        for body in ({'conversationId': CHAT, 'content': '<p>made</p>', 'title': 'Made'}, {'conversationId': CHAT, 'content': 'x', 'path': 'y'},
                     {'conversationId': CHAT}, {'conversationId': CHAT, 'content': 5}, {'conversationId': CHAT, 'content': 'a,b\n', 'filename': 'd.csv'},
                     {'conversationId': CHAT, 'content': 'x', 'kind': 'image'}, {'conversationId': CHAT, 'content': 'x', 'kind': 'nope'},
                     {'conversationId': CHAT, 'content': 'x', 'filename': 'a.exe'}, {'conversationId': CHAT, 'id': page, 'content': '<p>v</p>'},
                     {'conversationId': 'claude:other', 'id': page, 'content': 'x'}, {'conversationId': CHAT, 'path': 'outputs/page.html', 'title': 7},
                     {'conversationId': CHAT, 'path': 'outputs/page.html', 'note': 'n', 'toolCallId': 't1'}):
            self.same_post('/api/live/artifacts/publish', body)
        made = self.same_agent('POST', '/api/live/artifacts/publish', {'conversationId': CHAT, 'content': '# by agent', 'filename': 'agent.md'})
        self.assertEqual(made.status, 200, made.text)
        self.same_agent('POST', '/api/live/artifacts/publish', {'conversationId': 'claude:other', 'content': 'x'})   # key of another chat
        self.same_agent('POST', '/api/live/artifacts/publish', {'conversationId': CHAT, 'content': 'x'}, key='not-a-key')
        self.same_agent('POST', '/api/live/artifacts/publish', {'content': 'x'})
        self.same_agent('POST', '/api/live/artifacts/publish', {'conversationId': CHAT, 'content': 'x'}, Origin='http://127.0.0.1:1')
        self.same_agent('POST', '/api/live/artifacts/pin', {'id': page, 'pinned': True})   # the key is for publish and list only
        listed = self.same_agent('GET', f'/api/live/artifacts?conversationId={CHAT}')
        self.assertEqual(listed.status, 200, listed.text)
        self.same_agent('GET', '/api/live/artifacts?conversationId=claude:other')
        self.same_agent('GET', f'/api/live/artifacts/item?id={page}')
        self.same_get(f'/api/live/artifacts?conversationId={CHAT}')

    # ---- the artifact origin ----
    def test_d_origin(self):
        def fetch(server, path, host=None):
            origin = self.origin_of(server)
            port = int(origin.rsplit(':', 1)[1])
            probe = Server.__new__(Server)
            probe.port = port
            return probe.request('GET', path, {'Host': host or f'127.0.0.1:{port}'}), port

        def same(path, host_of=None):
            (a, pa), (b, pb) = fetch(self.subject, path, host_of and host_of(self.subject)), fetch(self.reference, path, host_of and host_of(self.reference))
            self.assertEqual(a.status, b.status, path)
            self.assertEqual(a.body.replace(str(self.subject.port).encode(), b'<studio>'), b.body.replace(str(self.reference.port).encode(), b'<studio>'), path)
            for name in ('content-type', 'content-security-policy', 'cache-control', 'x-content-type-options', 'cross-origin-resource-policy'):
                mine = a.headers.get(name) or ''
                if name == 'content-security-policy' and mine and self.subject.effective_kind() in ('deno', 'deno-split'):
                    # Deno-only (commit 5980b2b, CHANGELOG "Artifacts: Mermaid, Chart.js and Vega / Vega-Lite load from AIB itself"):
                    # script-src also allows this origin's /_lib/ (the vendored libraries) and nothing else of it. Require exactly
                    # that addition, then compare the rest with the reference's policy.
                    libs = f'https://unpkg.com http://127.0.0.1:{pa}/_lib/ http://localhost:{pa}/_lib/;'
                    self.assertIn(libs, mine, f'{path}: script-src gains this origin /_lib/')
                    mine = mine.replace(libs, 'https://unpkg.com;')
                self.assertEqual(mine.replace(str(self.subject.port), '<studio>'),
                                 (b.headers.get(name) or '').replace(str(self.reference.port), '<studio>'), f'{path} {name}')
            self.assertEqual(pa, self.subject.port + 1, 'the artifact origin is on the Studio port + 1')

        ids = self.ids
        for path in (f'/a/{ids["page"]}/v1/page.html', f'/a/{ids["page"]}/v2/page.html', f'/a/{ids["notes"]}/v1/notes.md',
                     f'/a/{ids["notes"]}/v1/notes.md?view=1', f'/a/{ids["image"]}/v1/pic.png', f'/a/{ids["other"]}/v1/data.json',
                     f'/a/{ids["page"]}/v9/page.html', f'/a/{ids["page"]}/v1/other.html', '/a/zz/v1/x.html', '/', '/a/' + urllib.parse.quote('..') + '/x'):
            same(path)
        same(f'/a/{ids["page"]}/v1/page.html', host_of=lambda s: f'127.0.0.1:{s.port}')   # the Studio's own Host is refused here
        # and the artifact origin is refused as a Studio Host / Origin
        for server in (self.subject, self.reference):
            origin = self.origin_of(server)
            server.as_host = server.request('GET', '/api/live/list', dict(server.page_headers(), Host=origin[len('http://'):]))
            server.as_origin = server.request('GET', '/api/live/list', dict(server.page_headers(), Origin=origin))
        self.assertEqual((self.subject.as_host.status, self.subject.as_host.json()), (self.reference.as_host.status, self.reference.as_host.json()))
        self.assertEqual((self.subject.as_origin.status, self.subject.as_origin.json()), (self.reference.as_origin.status, self.reference.as_origin.json()))
        self.assertEqual(self.subject.as_origin.status, 403)

    def test_e_csp_names_the_artifact_origin(self):
        for server in (self.subject, self.reference):
            policy = server.get('/api/live/settings').headers.get('content-security-policy', '')
            origin = self.origin_of(server)
            self.assertIn(f"frame-src 'self' {origin}", policy)
            self.assertIn(f"img-src 'self' {origin}", policy)

    def test_g_watcher_versions_a_changed_source_file(self):
        """An artifact with a source file gets a new version when the file changes (the watcher), once, on both servers."""
        import time
        listed = {id(s): s.get(f'/api/live/artifacts?conversationId={CHAT}').json()['artifacts'] for s in (self.subject, self.reference)}
        source = str(self.project / 'outputs' / 'page.html')

        def item(server):
            found = next(a for a in listed[id(server)] if a.get('sourcePath') == source)
            return server.get(f'/api/live/artifacts/item?id={found["id"]}').json()
        before = {id(s): len(item(s)['versions']) for s in (self.subject, self.reference)}
        (self.project / 'outputs' / 'page.html').write_text('<html><title>From disk</title><body>changed</body></html>', encoding='utf-8')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and any(len(item(s)['versions']) == before[id(s)] for s in (self.subject, self.reference)):
            time.sleep(0.3)
        time.sleep(4)   # long enough for a second watcher (there must be none) to add another version
        a, b = item(self.subject), item(self.reference)
        self.assertEqual(len(a['versions']), before[id(self.subject)] + 1)
        self.assertEqual(self.normalize(a, self.subject), self.normalize(b, self.reference))
        self.assertEqual(a['versions'][-1]['by'], 'watch')

    def test_f_artifact_web_file_names_this_server(self):
        data = json.loads((self.subject.state_dir / 'artifact-web.json').read_text(encoding='utf-8'))
        self.assertEqual(data['url'], self.subject.origin)
        self.assertEqual(sorted(data), ['pid', 'url'])


if __name__ == '__main__':
    unittest.main()
