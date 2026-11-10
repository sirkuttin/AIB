"""Contract, differential: the transcript viewer routes (monitor.py) give the same replies from the server under test as from the
Python reference server, over the same generated fixture transcripts. Against AIB_SERVER=python this compares Python with itself
(a sanity check of the harness); against AIB_SERVER=deno it is the parity check of server/transcripts/."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from server_under_test import Server  # noqa: E402

WORK = pathlib.Path(__file__).resolve().parent.parent
VOLATILE = {'now'}   # wall-clock time of the reply


def generate(name):
    """Run work/<name>/make_fixture.py in a temp copy (it writes next to itself); returns the copy's folder."""
    folder = pathlib.Path(tempfile.mkdtemp(prefix=f'aib-{name}-'))
    shutil.copy(WORK / name / 'make_fixture.py', folder / 'make_fixture.py')
    subprocess.run([sys.executable, str(folder / 'make_fixture.py')], cwd=str(folder), check=True, capture_output=True, timeout=60)
    return folder


def close(a, b):
    """Equal, except that file times may differ by 2 ms (seconds with a fraction, or nanoseconds): Deno reads file times in milliseconds, Python in
    100 ns (rewrite spec risk list). Everything else must be identical."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        if a == b or abs(a - b) <= 0.002:
            return True
        return abs(a) > 1e15 and abs(a - b) <= 2_000_000   # a nanosecond file time (transcript revision): 2 ms
    return a == b


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k not in VOLATILE}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


class TranscriptContract(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.fixtures = [generate('subagents-fixture'), generate('design-fixture')]
        roots = cls.fixtures[1]
        claude = roots / 'claude' if (roots / 'claude').is_dir() else cls.fixtures[0] / 'claude'
        omp = roots / 'omp' if (roots / 'omp').is_dir() else roots / 'empty-omp'
        omp.mkdir(exist_ok=True)   # both servers must show the same folders (the reply names them)
        cls.subject = Server(claude_dir=claude, omp_dir=omp).__enter__()
        cls.reference = Server(claude_dir=claude, omp_dir=omp, kind='python').__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.subject.__exit__(None, None, None)
        cls.reference.__exit__(None, None, None)
        for folder in cls.fixtures:
            shutil.rmtree(folder, ignore_errors=True)

    def same(self, path):
        a, b = self.subject.get(path), self.reference.get(path)
        self.assertEqual(a.status, b.status, path)
        if b.headers.get('content-type', '').startswith('application/json'):
            mine, theirs = strip(a.json()), strip(b.json())
            if not close(mine, theirs):
                self.assertEqual(mine, theirs, path)
        else:
            self.assertEqual(a.body, b.body, path)
        return b

    def test_every_route_over_every_session_and_agent(self):
        sessions = self.same('/api/sessions').json()['sessions']
        self.assertTrue(sessions, 'the fixtures produced no sessions')
        checked = 0
        for session in sessions:
            sid = session.get('key') or session.get('id') or ''
            agents = self.same(f'/api/agents?session={sid}').json().get('agents', [])
            self.same(f'/api/commands?session={sid}')
            self.same(f'/api/commands?session={sid}&running=1')
            self.same(f'/api/activity?session={sid}')
            for agent in agents:
                key = agent['key']
                for query in ('', '&limit=2', '&before=3&limit=2', '&after=1&limit=3', '&kind=tools', '&kind=messages', '&kind=errors',
                              '&thinking=1', '&q=the', '&q=NOTHING-MATCHES'):
                    self.same(f'/api/transcript?key={key}{query}')
                    checked += 1
        self.assertGreater(checked, 10)

    def test_refusals_and_bad_input(self):
        for path in ('/api/transcript?key=..%2F..%2Fx', '/api/transcript?key=', '/api/transcript?key=x&limit=abc', '/api/command?session=x&id=nope',
                     '/api/transcript/image?key=x&n=0&i=0', '/api/agents?session=does-not-exist'):
            self.same(path)


if __name__ == '__main__':
    unittest.main()
