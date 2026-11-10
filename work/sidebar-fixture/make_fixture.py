"""Fake saved transcripts for several projects and both vendors, with messy first messages. No model, no real transcripts.

  python work/sidebar-fixture/make_fixture.py
  deno run -A outputs/agent-studio/server/main.ts --port 8802 --state-dir work/sidebar-fixture/data/state \
    --omp-sessions work/sidebar-fixture/data/omp --claude-projects work/sidebar-fixture/data/claude \
    --owners-dir work/sidebar-fixture/data/owners --no-owner-announcements \
    --node-command python --claude-launcher work/combined-fixture/agent.py
"""
import json
import os
import pathlib
import shutil
import time

base = pathlib.Path(__file__).resolve().parent / 'data'
shutil.rmtree(base, ignore_errors=True)
for name in ('state', 'omp', 'claude', 'owners'):
    (base / name).mkdir(parents=True)

REMINDER = '<system-reminder>\nThe user started this session without choosing a project folder.\n</system-reminder>'
CONTINUED = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.'
# (provider, session, cwd as the vendor recorded it, first user message(s), explicit title rows, age in minutes)
SESSIONS = [
    ('claude', 'c-alpha-1', 'C:\\Repos\\Alpha', [REMINDER + '\nRefactor the parser module'], [], 5),
    ('claude', 'c-alpha-2', 'c:/repos/alpha/', ['<command-message>debug</command-message>\n<command-name>/debug</command-name>\n<command-args>login test is flaky</command-args>'], [], 70),
    ('claude', 'c-alpha-3', 'C:\\Repos\\Alpha\\', [CONTINUED, 'Plan the release notes'], [{'type': 'ai-title', 'aiTitle': 'Release notes plan'}], 300),
    ('omp', 'o-alpha-1', 'C:\\Repos\\Alpha', ['## **Investigate** slow build'], [], 20),
    ('claude', 'c-beta-1', 'C:\\Repos\\Beta', ['<local-command-caveat>Caveat: ran locally</local-command-caveat>', 'Add dark mode toggle'], [], 15),
    ('omp', 'o-beta-1', 'C:\\Repos\\Beta', ['Draft migration guide'], [{'type': 'title', 'title': 'Migration guide draft'}], 600),
    ('claude', 'c-alpha-d', 'D:\\Work\\Alpha', ['Audit dependencies for the other alpha'], [], 40),
    ('omp', 'o-gamma-1', '/home/dev/gamma', ['<img src=x onerror=alert(1)> hostile title'], [], 2000),
    ('claude', 'c-gamma-1', '/home/dev/gamma', ['Tune the cache'], [{'type': 'summary', 'summary': 'Cache tuning notes', 'leafUuid': 'x'}], 3000),
    ('claude', 'c-delta-1', 'C:\\Repos\\Delta', ['Write onboarding doc'], [], 90),
]
now = time.time()
for provider, session, cwd, prompts, extras, age in SESSIONS:
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now - age * 60))
    rows = []
    if provider == 'omp':
        rows.append({'type': 'session', 'id': session, 'cwd': cwd, 'timestamp': stamp})
        for p in prompts:
            rows.append({'type': 'message', 'timestamp': stamp, 'message': {'role': 'user', 'content': [{'type': 'text', 'text': p}]}})
        rows.append({'type': 'message', 'timestamp': stamp, 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Done.'}]}})
        folder = base / 'omp' / 'proj'
    else:
        for p in prompts:
            rows.append({'type': 'user', 'sessionId': session, 'cwd': cwd, 'timestamp': stamp, 'message': {'role': 'user', 'content': p}})
        rows.append({'type': 'assistant', 'sessionId': session, 'cwd': cwd, 'timestamp': stamp, 'message': {'role': 'assistant', 'model': 'fixture', 'content': [{'type': 'text', 'text': 'Done.'}]}})
        folder = base / 'claude' / 'encoded-project'
    rows.extend(extras)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f'{session}.jsonl'
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    os.utime(path, (now - age * 60, now - age * 60))
print('fixture ready under', base)
