"""Contract: the auth gate, page files and bootstrap, over HTTP only (runs against either server; see server_under_test.py)."""
import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from server_under_test import APP, Server, server_kind, shape  # noqa: E402


class GateContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.server.__exit__(None, None, None)

    # ---- bootstrap ----
    def test_bootstrap_hands_out_a_token_and_the_documented_fields(self):
        reply = self.server.bootstrap()
        self.assertEqual(reply.status, 200)
        self.assertTrue(reply.headers['content-type'].startswith('application/json'))
        body = reply.json()
        self.assertRegex(body['token'], r'^\S{20,}$')
        for key in ('instanceId', 'webInstanceId', 'pid', 'launchNonce', 'hostMode', 'stateDir', 'artifactOrigin', 'server', 'features', 'connections'):
            self.assertIn(key, body)
        for key in ('version', 'versionLabel', 'aboutLine', 'protocol', 'webPort'):
            self.assertIn(key, body['server'])
        self.assertEqual(body['server']['webPort'], 0)   # the --port flag as given
        self.assertEqual(body['connections'], [])
        self.assertTrue(all(isinstance(v, (bool, str)) for v in body['features'].values()))
        self.assertTrue(body['artifactOrigin'].startswith('http://127.0.0.1:'))

    def test_bootstrap_has_the_reference_keys(self):
        """Key for key the Python reference's bootstrap: top level, server block and features (values differ per process)."""
        if server_kind() == 'python':
            self.skipTest('compares the server under test with the Python reference')
        with Server(kind='python') as reference:
            mine, theirs = self.server.bootstrap().json(), reference.bootstrap().json()
        self.assertEqual(sorted(mine), sorted(theirs))
        self.assertEqual(sorted(mine['server']), sorted(theirs['server']))
        self.assertEqual(sorted(mine['features']), sorted(theirs['features']))
        for key in ('launchNonce', 'connections', 'migration', 'hostTakeoverWaiting', 'sandboxNotice', 'hostCodeWarning', 'packageContext'):
            self.assertEqual(mine[key], theirs[key], key)
        for key in ('version', 'versionLabel', 'aboutLine', 'webPort'):   # protocol is the agent host's (the in-process reference has none)
            self.assertEqual(mine['server'][key], theirs['server'][key], key)
        self.assertEqual(mine['hostMode'], 'in-process' if '--in-process' in self.server.command() else 'split')
        if mine['hostMode'] == 'in-process':   # the agents run in the web server, as in the reference
            self.assertEqual((mine['hostPid'], mine['instanceId']), (mine['pid'], mine['webInstanceId']))

    def test_bootstrap_refuses_a_cross_site_page(self):
        reply = self.server.request('GET', '/api/live/bootstrap', self.server.page_headers(token=False, Sec_Fetch_Site='cross-site'))
        self.assertEqual(reply.status, 403)
        self.assertEqual(reply.json(), {'error': 'Request must come from the Studio page'})

    # ---- the gate ----
    def test_api_without_token_is_refused(self):
        reply = self.server.get('/api/live/list', token=False)
        self.assertEqual((reply.status, reply.json()), (403, {'error': 'Invalid local session token'}))

    def test_api_with_wrong_token_is_refused(self):
        reply = self.server.request('GET', '/api/live/list', self.server.page_headers(X_Studio_Token='x' * 40))
        self.assertEqual(reply.status, 403)

    def test_foreign_host_is_refused(self):
        reply = self.server.request('GET', '/api/live/list', self.server.page_headers(Host='evil.example:80'))
        self.assertEqual((reply.status, reply.json()), (403, {'error': 'Not a Studio address'}))

    def test_foreign_origin_is_refused(self):
        reply = self.server.request('GET', '/api/live/list', self.server.page_headers(Origin='http://evil.example'))
        self.assertEqual((reply.status, reply.json()), (403, {'error': 'Request must come from the Studio page'}))

    def test_navigation_to_an_api_route_is_refused(self):
        reply = self.server.request('GET', '/api/live/list', self.server.page_headers(Sec_Fetch_Mode='navigate'))
        self.assertEqual(reply.status, 403)

    def test_same_site_artifact_origin_is_refused(self):
        reply = self.server.request('GET', '/api/live/list', self.server.page_headers(Sec_Fetch_Site='same-site'))
        self.assertEqual(reply.status, 403)

    def test_post_without_origin_and_fetch_metadata_is_refused(self):
        headers = self.server.page_headers(Origin=None, Sec_Fetch_Site=None)
        reply = self.server.request('POST', '/api/live/read-state', headers, {})
        self.assertEqual((reply.status, reply.json()), (403, {'error': 'Request must come from the Studio page'}))

    def test_unknown_api_route_is_404(self):
        for method in ('GET', 'POST'):
            reply = self.server.request(method, '/api/live/no-such-route', self.server.page_headers(), {} if method == 'POST' else None)
            self.assertEqual(reply.status, 404, method)

    def test_post_needs_a_json_object_body(self):
        for body, status in ((b'', 400), (b'[1]', 400), (b'{not json', 400)):
            reply = self.server.request('POST', '/api/live/read-state', self.server.page_headers(), body)
            self.assertEqual(reply.status, status, body)
            self.assertIn('error', reply.json())

    # ---- page files ----
    def test_chat_page_and_its_scripts_are_served_without_a_token(self):
        page = self.server.request('GET', '/', {'Host': f'127.0.0.1:{self.server.port}', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate'})
        self.assertEqual(page.status, 200)
        self.assertEqual(page.headers['content-type'], 'text/html; charset=utf-8')
        # The Deno server adds the saved view preferences as a JSON data block (server/web/server.ts withViewPrefs); the rest is the file.
        served = re.sub(rb'<script type="application/json" id="aibViewPrefs">[^<]*</script>', b'', page.body)
        self.assertEqual(served, (APP / 'chat.html').read_bytes())
        if server_kind() != 'python':
            self.assertIn(b'<script type="application/json" id="aibViewPrefs">{"prefs":{', page.body)
        scripts = re.findall(r'<script[^>]+src="/?([a-z0-9-]+\.js)"', page.text)
        styles = re.findall(r'<link[^>]+href="/?([a-z0-9-]+\.css)"', page.text)
        self.assertGreater(len(scripts), 10)
        for name in scripts + styles:
            reply = self.server.request('GET', '/' + name, {'Host': f'127.0.0.1:{self.server.port}', 'Sec-Fetch-Site': 'same-origin'})
            self.assertEqual(reply.status, 200, name)
            self.assertEqual(reply.body, (APP / name).read_bytes(), name)
            kind = 'text/javascript' if name.endswith('.js') else 'text/css'
            self.assertEqual(reply.headers['content-type'], kind + '; charset=utf-8', name)

    def test_page_responses_carry_the_security_headers(self):
        page = self.server.request('GET', '/', {'Host': f'127.0.0.1:{self.server.port}'})
        csp = page.headers.get('content-security-policy', '')
        self.assertIn("default-src 'self'", csp)
        self.assertIn('frame-src', csp)
        self.assertEqual(page.headers.get('x-content-type-options'), 'nosniff')

    def test_files_outside_the_page_set_are_not_served(self):
        for path in ('/studio.py', '/../studio.py', '/docs/VISION.md', '/.git/config', '/Chat.js', '/deno.json'):
            reply = self.server.request('GET', path, {'Host': f'127.0.0.1:{self.server.port}'})
            self.assertIn(reply.status, (403, 404), path)

    # ---- simple state routes ----
    def test_list_and_state_shapes(self):
        listing = self.server.get('/api/live/list')
        self.assertEqual(listing.status, 200)
        body = listing.json()
        for key in ('conversationRevision', 'projectsRevision', 'readStateRevision', 'settingsRevision', 'webInstanceId'):
            self.assertIn(key, body)
        for path in ('/api/live/conversation-state', '/api/live/read-state', '/api/live/project-prefs', '/api/live/settings'):
            reply = self.server.get(path)
            self.assertEqual(reply.status, 200, path)
            self.assertIsInstance(reply.json(), dict, path)

    def test_read_state_round_trip_only_moves_forward(self):
        key = 'claude:contract-session-1'
        reply = self.server.post('/api/live/read-state', {'set': {key: {'seenAt': 1000.5, 'seenIndex': 7}}})   # stored as a whole number
        self.assertEqual(reply.status, 200)
        body = reply.json()
        self.assertIs(body.get('ok'), True)
        stored = self.server.get('/api/live/read-state').json()
        self.assertEqual(shape({k: v for k, v in body.items() if k != 'ok'}), shape(stored))
        found = [v for v in stored.values() if isinstance(v, dict) and key in v]
        self.assertTrue(found, stored)
        self.assertEqual({k: found[0][key][k] for k in ('seenAt', 'seenIndex')}, {'seenAt': 1000, 'seenIndex': 7})
        self.server.post('/api/live/read-state', {'set': {key: {'seenAt': 999.0, 'seenIndex': 9}}})   # older: ignored
        again = [v for v in self.server.get('/api/live/read-state').json().values() if isinstance(v, dict) and key in v][0][key]
        self.assertEqual((again['seenAt'], again['seenIndex']), (1000, 7))
        for bad in ({}, {'set': []}, {'set': {key: {'seenAt': 'x'}}}):
            self.assertEqual(self.server.post('/api/live/read-state', bad).status, 400, bad)


if __name__ == '__main__':
    unittest.main()
