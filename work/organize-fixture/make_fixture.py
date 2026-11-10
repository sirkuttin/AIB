"""Fake saved Claude transcripts for checking pin / archive / delete by hand. No model, no real transcripts.

  python work/organize-fixture/make_fixture.py
  deno run -A outputs/agent-studio/server/main.ts --port 8800 --state-dir work/organize-fixture/state \
    --omp-sessions work/organize-fixture/omp --claude-projects work/organize-fixture/claude \
    --no-owner-announcements --node-command python --claude-launcher work/combined-fixture/agent.py
"""
import json
import os
import pathlib
import shutil
import time

base = pathlib.Path(__file__).resolve().parent
for name in ('state', 'omp', 'claude', 'workspace'):
    shutil.rmtree(base / name, ignore_errors=True)
    (base / name).mkdir(parents=True)
root = base / 'claude' / 'encoded-project'
root.mkdir()
TITLES = ['Refactor the parser', 'Fix flaky login test', 'Plan the release notes', 'Investigate slow build', 'Draft migration guide',
          'Review pull request 41', 'Tune the cache', 'Explain the scheduler', 'Add dark mode', 'Triage open bugs',
          'Prototype search box', 'Audit dependencies', '<img src=x onerror=alert(1)> hostile title', 'Write onboarding doc',
          'Benchmark startup', 'Clean up the CSS']
now = time.time()
for index, title in enumerate(TITLES):
    session = f'organize-{index:02d}'
    common = {'sessionId': session, 'cwd': str(base / 'workspace'), 'timestamp': '2026-11-07T01:00:00Z'}
    rows = [dict(common, type='user', message={'role': 'user', 'content': f'Hello: {title}'}),
            dict(common, type='assistant', message={'role': 'assistant', 'model': 'fixture', 'content': [{'type': 'text', 'text': f'Reply for {title}'}]}),
            dict(common, type='ai-title', title=title)]
    path = root / f'{session}.jsonl'
    path.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    stamp = now - 3600 * (index + 2)
    os.utime(path, (stamp, stamp))
print('fixture ready under', base)
