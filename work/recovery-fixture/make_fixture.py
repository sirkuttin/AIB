"""Create transcripts and empty folders for the recovery browser check (fixture data only)."""
import json
import pathlib

base = pathlib.Path(__file__).resolve().parent
for name in ('state', 'omp', 'workspace', 'claude/encoded-project'):
    (base / name).mkdir(parents=True, exist_ok=True)
root = base / 'claude' / 'encoded-project'
common = {'sessionId': 'fixture-big', 'cwd': str(base / 'workspace'), 'timestamp': '2026-11-07T01:00:00Z'}
rows = [dict(common, type='user', message={'role': 'user', 'content': 'start'})]
for i in range(400):
    role = 'assistant' if i % 2 else 'user'
    rows.append(dict(common, type=role, message={'role': role, 'content': f'message number {i}'}))
rows.append(dict(common, type='assistant', message={'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'bg1', 'name': 'Bash', 'input': {'command': 'sleep 600', 'run_in_background': True, 'description': 'Long build'}}]}))
rows.append(dict(common, type='user', message={'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'bg1', 'content': 'started'}]}, toolUseResult={'backgroundTaskId': 'job-looks-live'}))
(root / 'fixture-big.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
subs = root / 'fixture-big' / 'subagents'
subs.mkdir(parents=True, exist_ok=True)
sub_rows = [dict(common, type='assistant', agentId='abc1', message={'role': 'assistant', 'content': [{'type': 'text', 'text': f'sub line {i}'}]}) for i in range(300)]
(subs / 'agent-abc1.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in sub_rows), encoding='utf-8')
(subs / 'agent-abc1.meta.json').write_text(json.dumps({'description': 'Verify slice 06 importer', 'agentType': 'fork', 'finished': True}), encoding='utf-8')
