"""Fixtures for checking the ownership UI by hand. No model, no real transcripts, no real agents.

  python work/ownership-fixture/fixture.py setup            # (re)create transcripts under work/ownership-fixture/data
  python work/ownership-fixture/fixture.py append SESSION   # pretend another app is writing SESSION's transcript, until killed
  python work/ownership-fixture/fixture.py announce SESSION # pretend another client announced SESSION, until killed

Start Studio against it with (agent.py is the fake launcher for the Claude provider):
  deno run -A app/server/main.ts --port 8799 --state-dir work/ownership-fixture/data/state \
    --omp-sessions work/ownership-fixture/data/omp --claude-projects work/ownership-fixture/data/claude \
    --owners-dir work/ownership-fixture/data/owners --node-command python --claude-launcher work/ownership-fixture/agent.py
"""
import json
import os
import pathlib
import shutil
import socket
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / 'data'
WORKSPACE = DATA / 'workspace'
PROJECT = DATA / 'claude' / 'ownership-fixture-workspace'
SESSIONS = {
    'idle-session': ('Idle conversation (written an hour ago)', 3600),
    'active-session': ('Another app is writing this one', 3600),
    'announced-session': ('Announced by another client', 3600),
    'quiet-session': ('No evidence either way', 900),
}


def rows(session, title):
    stamp = '2026-11-07T10:00:00.000Z'
    return [
        {'type': 'user', 'sessionId': session, 'cwd': str(WORKSPACE), 'timestamp': stamp, 'message': {'role': 'user', 'content': f'Hello from {title}'}},
        {'type': 'assistant', 'sessionId': session, 'cwd': str(WORKSPACE), 'timestamp': stamp, 'message': {'role': 'assistant', 'model': 'fixture', 'content': [{'type': 'text', 'text': f'Fixture reply for {title}'}]}},
        {'type': 'ai-title', 'sessionId': session, 'title': title},
    ]


def setup():
    if DATA.exists():
        shutil.rmtree(DATA)
    WORKSPACE.mkdir(parents=True)
    PROJECT.mkdir(parents=True)
    (DATA / 'omp').mkdir()
    for session, (title, age) in SESSIONS.items():
        path = PROJECT / f'{session}.jsonl'
        path.write_text(''.join(json.dumps(r) + '\n' for r in rows(session, title)), encoding='utf-8')
        os.utime(path, (time.time() - age, time.time() - age))
    print('fixture ready under', DATA)


def append(session):
    path = PROJECT / f'{session}.jsonl'
    n = 0
    print('appending to', path, 'as PID', os.getpid(), flush=True)
    while True:
        n += 1
        with path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'type': 'assistant', 'sessionId': session, 'cwd': str(WORKSPACE), 'timestamp': '2026-11-07T10:00:00.000Z',
                                     'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': f'working {n}'}]}}) + '\n')
        time.sleep(1)


def announce(session):
    """Write the announcement file the way an owner registry does (agent-session-owner v1), refreshed every 5 seconds."""
    import datetime
    import hashlib
    owners = DATA / 'owners'
    owners.mkdir(parents=True, exist_ok=True)
    prefix = hashlib.sha256(('claude' + chr(0) + session).encode('utf-8')).hexdigest()[:32]
    path = owners / f'{prefix}--fixtureother.json'
    stamp = lambda: datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    first = stamp()
    print('announcing', session, 'as PID', os.getpid(), 'host', socket.gethostname(), flush=True)
    while True:
        body = {'format': 'agent-session-owner', 'version': 1, 'provider': 'claude', 'sessionId': session,
                'client': {'name': 'fixture-other-client', 'version': '0', 'instanceId': 'fixture-other'},
                'pid': os.getpid(), 'pidStart': None, 'hostname': socket.gethostname(), 'cwd': str(WORKSPACE), 'state': 'working',
                'announcedAt': first, 'heartbeatAt': stamp(), 'ttlSeconds': 30}
        temporary = path.with_suffix(f'.{os.getpid()}.tmp')
        temporary.write_text(json.dumps(body), encoding='utf-8')
        os.replace(temporary, path)
        time.sleep(5)


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'setup':
        setup()
    elif command == 'append' and len(sys.argv) == 3:
        append(sys.argv[2])
    elif command == 'announce' and len(sys.argv) == 3:
        announce(sys.argv[2])
    else:
        sys.exit(__doc__)
