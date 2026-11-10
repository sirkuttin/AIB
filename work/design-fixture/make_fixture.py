"""Design-review fixture: several projects, both vendors, pinned/on-hold/archived, one chat with subagents. No model, no real data.

  python work/design-fixture/make_fixture.py
  deno run -A outputs/agent-studio/server/main.ts --port 8807 --state-dir work/design-fixture/data/state \
    --omp-sessions work/design-fixture/data/omp --claude-projects work/design-fixture/data/claude \
    --owners-dir work/design-fixture/data/owners --no-owner-announcements \
    --node-command python --claude-launcher work/combined-fixture/agent.py
"""
import json, os, pathlib, shutil, time
from datetime import datetime, timezone

base = pathlib.Path(__file__).resolve().parent / 'data'
shutil.rmtree(base, ignore_errors=True)
for n in ('state', 'omp', 'claude', 'owners'):
    (base / n).mkdir(parents=True)
now = time.time()
iso = lambda ago: datetime.fromtimestamp(now - ago, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
REM = '<system-reminder>\nSession start.\n</system-reminder>\n'
P = {'demo': 'C:\\Repos\\Demo Project', 'game': 'C:\\Repos\\game-balance', 'studio': 'C:\\Repos\\Agent Studio',
     'gamma': 'C:\\Repos\\gateway', 'notes': 'C:\\Repos\\dotfiles'}
# (provider, id, project, first message, explicit title, age minutes)
S = [
 ('claude', 'c-demo-1', 'demo', 'Trace the login flow and map the call graph', 'Trace login flow', 3),
 ('claude', 'c-demo-2', 'demo', 'The debugger hook crashes on attach, find out why', 'Debugger attach crash', 12),
 ('omp', 'o-demo-1', 'demo', 'Compare build 4.1 vs 4.2 export lists', 'Diff export lists 4.1 vs 4.2', 45),
 ('claude', 'c-demo-3', 'demo', 'Write up findings on the bundler', 'Bundler findings writeup', 180),
 ('claude', 'c-demo-4', 'demo', 'fix the thing', '', 900),
 ('claude', 'c-game-1', 'game', 'Build the item engine for W3', 'W3 item engine', 8),
 ('claude', 'c-game-2', 'game', 'Why is the win rate dropping in patch 3.2?', 'Win rate drop in patch 3.2', 60),
 ('omp', 'o-game-1', 'game', 'Regenerate the rotation tables', 'Rotation tables regen', 240),
 ('claude', 'c-game-3', 'game', 'hmm', '', 1500),
 ('claude', 'c-st-1', 'studio', 'Fan out the sidebar redesign work', 'Sidebar redesign fan-out', 1),
 ('claude', 'c-st-2', 'studio', 'Fix attention dot not clearing after viewing', 'Attention dot not clearing', 25),
 ('omp', 'o-st-1', 'studio', 'Review the ACP v2 evaluation doc', 'Review ACP v2 evaluation', 90),
 ('claude', 'c-st-3', 'studio', 'Write tests for the switcher', 'Switcher tests', 400),
 ('claude', 'c-gw-1', 'gamma', 'Rate limiter returns 500 under burst', 'Rate limiter 500 under burst', 130),
 ('omp', 'o-gw-1', 'gamma', 'Add structured logging', 'Structured logging', 700),
 ('claude', 'c-dot-1', 'notes', 'Set up the PowerShell profile', 'PowerShell profile', 3000),
]
for prov, sid, proj, msg, title, age in S:
    cwd = P[proj]
    st = iso(age * 60)
    if prov == 'omp':
        rows = [{'type': 'session', 'id': sid, 'cwd': cwd, 'timestamp': st},
                {'type': 'message', 'timestamp': st, 'message': {'role': 'user', 'content': [{'type': 'text', 'text': msg}]}},
                {'type': 'message', 'timestamp': st, 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Done.'}]}}]
        if title:
            rows.append({'type': 'title', 'title': title})
        folder = base / 'omp' / 'proj'
    else:
        rows = [{'type': 'user', 'sessionId': sid, 'cwd': cwd, 'timestamp': st, 'message': {'role': 'user', 'content': REM + msg}},
                {'type': 'assistant', 'sessionId': sid, 'cwd': cwd, 'timestamp': st, 'message': {'role': 'assistant', 'model': 'fixture', 'content': [{'type': 'text', 'text': 'Done.'}]}}]
        if title:
            rows.append({'type': 'ai-title', 'aiTitle': title})
        folder = base / 'claude' / ('proj-' + proj)
    folder.mkdir(parents=True, exist_ok=True)
    f = folder / f'{sid}.jsonl'
    f.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
    os.utime(f, (now - age * 60, now - age * 60))

# subagents under the "fan out" chat
f = base / 'claude' / 'proj-studio' / 'c-st-1.jsonl'
subs = f.with_suffix('') / 'subagents'
subs.mkdir(parents=True)


def srow(kind, text, ago, **x):
    m = {'role': kind, 'content': text if kind == 'user' else [{'type': 'text', 'text': text}]}
    m.update(x.pop('msg', {}))
    return dict({'type': kind, 'sessionId': 'c-st-1', 'cwd': P['studio'], 'timestamp': iso(ago), 'isSidechain': True, 'message': m}, **x)


def w(name, rows, ago, meta):
    p = subs / f'{name}.jsonl'
    p.write_text('\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')
    os.utime(p, (now - ago, now - ago))
    (subs / f'{name}.meta.json').write_text(json.dumps(meta), encoding='utf-8')


w('agent-a1', [srow('user', 'Rewrite sidebar rows', 300), srow('assistant', 'Editing sidebar-ui.js', 15)], 15, {'description': 'Sidebar rows', 'agentType': 'general-purpose'})
w('agent-a2', [srow('user', 'Tabs strip prototype', 300), srow('assistant', 'Prototype running', 20)], 20, {'description': 'Tab strip prototype', 'agentType': 'general-purpose'})
w('agent-a3', [srow('user', 'Write density tests', 900), srow('assistant', 'Tests pass.', 400, msg={'stop_reason': 'end_turn'})], 400, {'description': 'Density tests', 'agentType': 'general-purpose', 'finished': True})
w('agent-a4', [srow('user', 'Run full build', 1500), srow('assistant', 'API Error: 500', 1200, isApiErrorMessage=True)], 1200, {'description': 'Full build', 'agentType': 'general-purpose'})
w('agent-a5', [srow('user', 'Audit CSS for dead rules', 3000), srow('assistant', 'Found 14.', 2800, msg={'stop_reason': 'end_turn'})], 2800, {'description': 'CSS audit', 'agentType': 'general-purpose', 'finished': True})

t = now
e = {
    'claude:c-demo-1': {'pinnedAt': t - 5000},
    'claude:c-game-1': {'pinnedAt': t - 4000},
    'claude:c-demo-3': {'holdAt': t - 9000, 'holdNote': 'wait for the vendor reply on the bundler'},
    'claude:c-gw-1': {'holdAt': t - 20000, 'holdNote': 'needs staging creds'},
    'omp:o-gw-1': {'holdAt': t - 30000, 'holdNote': ''},
    'claude:c-dot-1': {'archivedAt': t - 1000},
    'claude:c-demo-4': {'archivedAt': t - 2000},
}
(base / 'state' / 'studio-conversations.json').write_text(json.dumps({'version': 1, 'savedAt': t, 'entries': e}), encoding='utf-8')
print('fixture ready under', base)
