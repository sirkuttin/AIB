"""Contract, differential, end to end: a fake ACP agent (work/combined-fixture, run as "Claude Code") driven over HTTP through the
server under test and through the Python reference, step for step: connect, state polling, a prompt that asks for approval, the
approval, a long turn that is retried (receipt) and cancelled, the live list, a config change, disconnect. Every reply must match
the reference once volatile values (ids, times, folders, pids) are masked. Works for an in-process server and for a split one
(AIB_SERVER=deno-split: the Deno agent host runs the agent)."""
import json
import pathlib
import sys
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from server_under_test import Server, WORK  # noqa: E402

FIXTURE = WORK / 'combined-fixture' / 'agent.py'
VOLATILE = {'id', 'time', 'instanceId', 'hostId', 'pid', 'startedAt', 'turnEndedAt', 'busySince', 'openedAt', 'lastSeen', 'at', 'queuedAt', 'checkedAt',
            'elapsedMs', 'webInstanceId', 'conversationRevision', 'projectsRevision', 'readStateRevision', 'settingsRevision', 'inUse',
            'leaseId', 'key', 'now'}


def masked(value, server):
    """The reply with this server's own folders replaced and volatile values dropped."""
    text = json.dumps(value)
    for folder in (server.workspace, server.temp):
        for spelling in {str(folder), str(folder).replace('\\', '/')}:
            text = text.replace(json.dumps(spelling)[1:-1], '<tmp>')
    value = json.loads(text)
    if server.effective_kind() in ('deno', 'deno-split'):
        value = drop_steer(value)
    return strip(value)


# Deno-only (beta.9 steer-on-send): a connection snapshot's steer keys (work/deno/steer_*_test.ts cover them); the reference has none.
STEER_KEYS = ('steerable', 'autonomous', 'steerAgent', 'steerLane', 'toolBackground')


def drop_steer(value):
    """The value without the steer keys of every connection snapshot in it (a dict that has steerLane)."""
    if isinstance(value, dict):
        snapshot = 'steerLane' in value
        return {k: drop_steer(v) for k, v in value.items() if not (snapshot and k in STEER_KEYS)}
    if isinstance(value, list):
        return [drop_steer(v) for v in value]
    return value


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k not in VOLATILE}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


def start(kind=None):
    server = Server(kind=kind, extra_args=['--node-command', sys.executable, '--claude-launcher', str(FIXTURE)]).__enter__()
    server.workspace = pathlib.Path(server.temp) / 'workspace'
    server.workspace.mkdir()
    return server


class AgentContract(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.servers = [start(), start('python')]   # [subject, reference]

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers:
            server.__exit__(None, None, None)

    # ---- helpers: the same step on both servers ----
    def both(self, method, path, body=None, ids=None):
        replies = []
        for n, server in enumerate(self.servers):
            real = path.replace('{id}', ids[n]) if ids else path
            payload = None if body is None else json.loads(json.dumps(body).replace('"{id}"', json.dumps(ids[n])) if ids else json.dumps(body))
            reply = server.get(real) if method == 'GET' else server.post(real, payload)
            replies.append(reply)
        return replies

    def same(self, method, path, body=None, ids=None, what=''):
        a, b = self.both(method, path, body, ids)
        self.assertEqual((a.status, masked(a.json(), self.servers[0])), (b.status, masked(b.json(), self.servers[1])), what or path)
        return a.json(), b.json()

    def wait(self, ids, condition, what, seconds=30):
        deadline = time.time() + seconds
        while time.time() < deadline:
            states = [s.get(f'/api/live/state?id={i}&after=0').json() for s, i in zip(self.servers, ids)]
            if all(condition(state) for state in states):
                return states
            time.sleep(0.1)
        self.fail(f'timed out waiting for {what}')

    def kinds(self, state):
        return [(e['kind'], (e.get('data') or {}).get('update', {}).get('sessionUpdate') if isinstance(e.get('data'), dict) else None)
                for e in state['events']]

    def drop_steer_keys(self, state, what):
        """A raw (unmasked) Deno snapshot carries every steer key; they are dropped for the comparison."""
        if self.servers[0].effective_kind() not in ('deno', 'deno-split'):
            return
        for key in STEER_KEYS:
            self.assertIn(key, state, f'{what}: {key}')
            state.pop(key)

    def compare_states(self, states, what):
        """Same state, same events. The agent's notifications and Studio's own events race (even Python against Python), so the
        events are compared as a sorted list without their sequence numbers."""
        a, b = (masked(s, server) for s, server in zip(states, self.servers))
        if self.servers[0].effective_kind() in ('deno', 'deno-split'):
            # Deno-only (commit 63e00d6, CHANGELOG "Limits chip after Ctx"): the state carries the account's usage limits. The
            # fixture never sends a rate limit, so it must be there and empty; the reference has no such key.
            self.assertIn('limits', a, f'{what}: limits')
            self.assertIsNone(a.pop('limits'), f'{what}: the fixture sends no usage limits')
        self.assertEqual(sorted(self.kinds(a)), sorted(self.kinds(b)), f'{what}: event kinds')
        for state in (a, b):
            state['events'] = sorted((json.dumps({k: v for k, v in e.items() if k != 'seq'}, sort_keys=True) for e in state['events']))
        self.assertEqual(a, b, what)

    # ---- the conversation ----
    def test_a_full_conversation_matches_the_reference(self):
        body = {'provider': 'claude', 'background': True}
        connected = []
        for server in self.servers:
            reply = server.post('/api/live/connect', dict(body, cwd=str(server.workspace)))
            self.assertEqual(reply.status, 200, reply.text)
            connected.append(reply.json())
        self.drop_steer_keys(connected[0], 'connect payload')
        self.assertEqual(sorted(connected[0]), sorted(connected[1]), 'connect payload keys')
        ids = [c['id'] for c in connected]
        states = self.wait(ids, lambda s: s['ready'], 'ready')
        self.compare_states(states, 'state after connect')
        self.same('GET', '/api/live/list', what='list with one ready chat')

        # A prompt that asks for approval, answered over HTTP.
        self.same('POST', '/api/live/prompt', {'id': '{id}', 'text': 'approve', 'clientMessageId': 'turn-1'}, ids, 'prompt')
        states = self.wait(ids, lambda s: s['permissions'], 'approval request')
        self.assertEqual(masked(states[0]['permissions'], self.servers[0]), masked(states[1]['permissions'], self.servers[1]))
        keys = [s['permissions'][0]['key'] for s in states]
        self.assertEqual(self.servers[0].get('/api/live/list').json()['connections'][0]['attention']['state'], 'needs_you')
        a, b = (s.post('/api/live/permission', {'id': i, 'key': k, 'option': 'yes'}) for s, i, k in zip(self.servers, ids, keys))
        self.assertEqual((a.status, a.json()), (b.status, b.json()))
        states = self.wait(ids, lambda s: not s['busy'], 'approved turn ends')
        self.compare_states(states, 'state after the approved turn')

        # A long turn: busy, a retried send is recognised, cancel ends it.
        self.same('POST', '/api/live/prompt', {'id': '{id}', 'text': 'wait', 'clientMessageId': 'turn-2'}, ids, 'long prompt')
        self.wait(ids, lambda s: s['busy'], 'busy')
        retry, _ = self.same('POST', '/api/live/prompt', {'id': '{id}', 'text': 'wait', 'clientMessageId': 'turn-2'}, ids, 'retried prompt')
        self.assertTrue(retry['duplicate'])
        self.same('POST', '/api/live/prompt', {'id': '{id}', 'text': 'other', 'clientMessageId': 'turn-2'}, ids, 'reused message id')
        self.same('POST', '/api/live/prompt', {'id': '{id}', 'text': 'more', 'clientMessageId': 'turn-3'}, ids, 'second prompt while busy')
        self.same('POST', '/api/live/cancel', {'id': '{id}'}, ids, 'cancel')
        states = self.wait(ids, lambda s: not s['busy'], 'cancelled')
        self.assertTrue(any(e['kind'] == 'turn_end' and e['data'].get('stopReason') == 'cancelled' for e in states[0]['events']))
        self.compare_states(states, 'state after cancel')
        cursor = [s['cursor'] for s in states]
        a, b = (s.get(f'/api/live/state?id={i}&after={c}').json() for s, i, c in zip(self.servers, ids, cursor))
        self.assertEqual((a['events'], a['reset']), (b['events'], b['reset']), 'nothing new after the cursor')

        # Settings and session ops answer the same way.
        self.same('POST', '/api/live/mode', {'id': '{id}', 'modeId': 'no-such-mode'}, ids, 'unknown mode')
        self.same('POST', '/api/live/config', {'id': '{id}', 'configId': 'nope', 'value': 1}, ids, 'unknown config')
        self.same('POST', '/api/live/session-op', {'id': '{id}', 'op': 'list'}, ids, 'session list')
        self.same('POST', '/api/live/queue', {'id': '{id}', 'text': 'queued', 'clientMessageId': 'q-1'}, ids, 'queue while idle')
        self.same('GET', '/api/live/list', what='list after the turns')

        # Disconnect: the chat is listed as closed, then a state read says so.
        self.same('POST', '/api/live/disconnect', {'id': '{id}'}, ids, 'disconnect')
        states = self.wait(ids, lambda s: s['closed'], 'closed')
        self.compare_states(states, 'state after disconnect')
        self.same('POST', '/api/live/prompt', {'id': '{id}', 'text': 'after', 'clientMessageId': 'turn-9'}, ids, 'prompt after disconnect')
        boot = [s.bootstrap().json() for s in self.servers]
        self.assertEqual(boot[0]['connections'], boot[1]['connections'], 'no open connections left')


if __name__ == '__main__':
    unittest.main()
