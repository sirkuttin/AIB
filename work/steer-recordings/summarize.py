"""Prints a compact timeline of a steer recording (skips text/thought chunks, shows their text joined)."""
import json, sys
buf = []
def flush():
    global buf
    if buf:
        print('      text:', repr(''.join(buf))[:300]); buf = []
for l in open(sys.argv[1], encoding='utf8'):
    r = json.loads(l)
    if r['dir'] == 'note':
        flush(); print(r['t'], 'NOTE', r['note'][:250]); continue
    if r['dir'] == 'stderr':
        continue
    m = r.get('msg', {})
    u = (m.get('params') or {}).get('update') or {}
    su = u.get('sessionUpdate')
    if su in ('agent_message_chunk', 'agent_thought_chunk'):
        c = u.get('content', {}); buf.append(c.get('text', '') if su == 'agent_message_chunk' else ''); continue
    flush()
    if su in ('available_commands_update', 'config_option_update'): continue
    meta = u.get('_meta') or {}
    cc = meta.get('claudeCode') or {}
    extra = ''
    if su == 'usage_update': extra = json.dumps({k: v for k, v in meta.items() if k != 'quota'})[:300] + ' used=' + str(u.get('used'))
    elif su and su.startswith('tool_call'):
        extra = f"{cc.get('toolName')} id={u.get('toolCallId')} status={u.get('status')} title={u.get('title')!r} " + (('raw=' + repr(u.get('rawOutput'))[:300]) if u.get('rawOutput') else '') + (' bgTask=' + str((cc.get('toolResponse') or {}).get('backgroundTaskId')) if isinstance(cc.get('toolResponse'), dict) else '')
    elif su: extra = json.dumps(u)[:300]
    else: extra = json.dumps(m)[:300]
    print(r['t'], r['dir'], m.get('method') or ('resp#' + str(m.get('id'))), su or '', extra)
flush()
