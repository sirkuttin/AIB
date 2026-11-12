"""Build a fake saved Claude transcript with several subagents under work/subagents-fixture/claude (no real data)."""
import json, os, pathlib, time
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
main = HERE / 'claude' / 'C--fixture' / 'sess-fixture.jsonl'
subs = main.with_suffix('') / 'subagents'
subs.mkdir(parents=True, exist_ok=True)
now = time.time()


def iso(ago):
    return datetime.fromtimestamp(now - ago, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def write(path, rows, mtime_ago):
    path.write_text('\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')
    os.utime(path, (now - mtime_ago, now - mtime_ago))


def row(kind, text, ago, **extra):
    msg = {'role': kind, 'content': text if kind == 'user' else [{'type': 'text', 'text': text}]}
    msg.update(extra.pop('msg', {}))
    return dict({'type': kind, 'sessionId': 'sess-fixture', 'cwd': 'C:/fixture', 'timestamp': iso(ago), 'isSidechain': True, 'message': msg}, **extra)


write(main, [{'type': 'user', 'sessionId': 'sess-fixture', 'cwd': 'C:/fixture', 'timestamp': iso(4000), 'message': {'role': 'user', 'content': 'Fan out the W3 work'}}], 20)
bash = {'type': 'assistant', 'sessionId': 'sess-fixture', 'cwd': 'C:/fixture', 'timestamp': iso(200), 'isSidechain': True, 'message': {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'bg1', 'name': 'Bash', 'input': {'command': 'npm run dev', 'description': 'Dev server', 'run_in_background': True}}]}}
bash_result = {'type': 'user', 'sessionId': 'sess-fixture', 'cwd': 'C:/fixture', 'timestamp': iso(199), 'isSidechain': True, 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'bg1', 'content': 'Command running in background with ID: job1'}]}}
write(subs / 'agent-a1.jsonl', [row('user', 'Build the item engine', 300), bash, bash_result, row('assistant', 'Working on slot logic', 20, msg={'model': 'claude-sonnet-5-5', 'usage': {'input_tokens': 12, 'cache_creation_input_tokens': 2000, 'cache_read_input_tokens': 40000, 'output_tokens': 350}})], 20)
write(subs / 'agent-a7.jsonl', [row('user', 'Check slot edge cases', 100), row('assistant', 'Reading the tests', 10)], 10)
(subs / 'agent-a7.meta.json').write_text(json.dumps({'description': 'Slot edge cases', 'agentType': 'Explore', 'parentAgentId': 'a1'}), encoding='utf-8')
(subs / 'agent-a1.meta.json').write_text(json.dumps({'description': 'W3a item engine', 'agentType': 'general-purpose'}), encoding='utf-8')
write(subs / 'agent-a2.jsonl', [row('user', 'Write the 16:9 HUD', 900), row('assistant', 'HUD done and verified.', 400, msg={'stop_reason': 'end_turn', 'model': 'claude-opus-5-5', 'usage': {'input_tokens': 5, 'cache_read_input_tokens': 198000, 'output_tokens': 1200}})], 400)
(subs / 'agent-a2.meta.json').write_text(json.dumps({'description': 'W3c HUD 16:9', 'agentType': 'general-purpose', 'finished': True}), encoding='utf-8')
write(subs / 'agent-a3.jsonl', [row('user', 'Run the full build and report', 1500), row('assistant', 'API Error: 500 overloaded', 1200, isApiErrorMessage=True)], 1200)
write(subs / 'agent-a4.jsonl', [row('user', 'Audit the importer for dead code\nand list findings', 3000), row('assistant', 'Found three unused helpers.', 2800, msg={'stop_reason': 'end_turn'})], 2800)
write(subs / 'agent-a5.jsonl', [row('assistant', 'no prompt recorded', 7000, msg={'stop_reason': 'end_turn'})], 7000)
write(subs / 'agent-a6.jsonl', [row('user', 'Check the rotation tables', 9000), row('assistant', 'Tables match the spec.', 8800, msg={'stop_reason': 'end_turn'})], 8800)
print(main)
