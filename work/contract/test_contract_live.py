"""Contract, differential: the live routes answered by the agent host (state, ownership, live ops, agent install and sign-in status) give
the same status and payload from the server under test as from the Python reference, and POST /api/live/shutdown stops only the web
server. Each server has its own agent host and state folder."""
import pathlib
import sys
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from server_under_test import Server  # noqa: E402

VOLATILE = {'now', 'checkedAt', 'instanceId', 'hostId', 'pid', 'startedAt', 'elapsedMs'}


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k not in VOLATILE}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


class LiveContract(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.subject = Server().__enter__()
        cls.reference = Server(kind='python').__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.subject.__exit__(None, None, None)
        cls.reference.__exit__(None, None, None)

    def same_get(self, path):
        a, b = self.subject.get(path), self.reference.get(path)
        self.assertEqual((a.status, strip(a.json())), (b.status, strip(b.json())), path)
        return a

    def same_post(self, path, body):
        a, b = self.subject.post(path, body), self.reference.post(path, body)
        self.assertEqual((a.status, strip(a.json())), (b.status, strip(b.json())), f'{path} {body}')
        return a

    def test_state_of_an_unknown_connection(self):
        reply = self.same_get('/api/live/state?id=no-such-connection&after=0')
        self.assertEqual(reply.status, 404)
        self.same_get('/api/live/state?id=x&after=notanumber')

    def test_ownership(self):
        self.same_get('/api/live/ownership?provider=claude&id=abc&cwd=')
        reply = self.same_get('/api/live/ownership?provider=claude&id=abc&cwd=%5C%5Cserver%5Cshare')
        self.assertEqual(reply.status, 400)

    def test_live_ops_refuse_bad_requests_the_same_way(self):
        for name, body in (('discover', {'provider': 'nope'}), ('connect', {}), ('prompt', {'id': 'missing', 'text': 'hi'}), ('cancel', {'id': 'missing'}),
                           ('queue', {'id': 'missing'}), ('disconnect', {'id': 'missing'}), ('session-op', {'id': 'missing', 'op': 'x'}),
                           ('forget', {'provider': 'claude', 'sessionId': ''})):
            self.same_post(f'/api/live/{name}', body)

    def test_agent_install_and_signin_status(self):
        for agent in ('claude', 'codex', 'nope'):
            self.same_get(f'/api/live/agents/install?agent={agent}')
        self.same_post('/api/live/agents/install', {'agent': 5})
        self.same_post('/api/live/agents/signin', {'agent': None})
        self.same_post('/api/live/agents/signin/check', {'agent': 7})

    def test_z_shutdown_stops_the_web_server_only(self):
        server = Server().__enter__()
        try:
            reply = server.post('/api/live/shutdown', {})
            self.assertEqual((reply.status, reply.json()), (200, {'ok': True}))
            for _ in range(100):
                if server.process.poll() is not None:
                    break
                time.sleep(0.1)
            self.assertIsNotNone(server.process.poll(), 'the web server did not exit')
            info = (server.state_dir / 'agent-host.json')
            self.assertTrue(info.exists() or '--in-process' in server.command(), 'the agent host stopped with the web server')
        finally:
            server.__exit__(None, None, None)


if __name__ == '__main__':
    unittest.main()
