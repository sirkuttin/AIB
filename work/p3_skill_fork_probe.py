"""P3 of "subagents work in their own worktree": does a Claude Code skill with `context: fork` go around AIB's hooks?

Real claude-agent-acp adapter, the stub model API in script mode, temp config only (reuses p0_subagent_worktree_probe.py).
The parent calls the `Skill` tool; the forked skill runs Bash (`echo from-fork > fork.txt`) and a Write into the project folder.
Recorded: every hook call (PreToolUse/PostToolUse on all tools, SubagentStart/Stop, WorktreeCreate/Remove), where fork.txt lands,
and the Skill tool's schema as offered to the model.

    python work/p3_skill_fork_probe.py <scratch-dir> <variant> [<variant> ...]

Variants: fork-gp (skill, agent: general-purpose, HTTP recorder on every tool), fork-editor (agent: editor, a custom agent),
fork-cmd (a .claude/commands file with context: fork), typed-gp / typed-cmd / typed-forced (the same, but the user types `/forker` as the prompt), fork-forced (AIB's planned command hooks: PreToolUse(Agent|Task) forces
isolation, WorktreeCreate makes <b>/wt/sub1; plus a Skill matcher and SubagentStart recorder).
Run with TEMP/TMP/TMPDIR pointed into the scratch folder (_isolation's temp state folder uses TEMP).
"""
import json
import pathlib
import sys

import p0_subagent_worktree_probe as p0

SKILL = """---
name: {name}
description: P3 probe skill that writes a marker file. Use when asked to run {name}.
context: fork
agent: {agent}
---
FORK-BODY-{name}: write the file fork.txt in the current folder with `echo from-fork > fork.txt`, then report the folder you are in.
"""

EDITOR = """---
name: editor
description: P3 probe agent that edits files.
tools: Read, Write, Bash
---
You are the P3 editor agent. Do exactly what the task says.
"""


def setup(kind, agent):
    """A make_repo that also commits the skill (or command) and, for agent: editor, the custom agent."""
    original = p0.make_repo

    def make(folder):
        project = original(folder)
        if kind == 'command':
            path = project / '.claude' / 'commands' / 'forkcmd.md'
            path.parent.mkdir(parents=True)
            path.write_text(SKILL.format(name='forkcmd', agent=agent).replace('name: forkcmd\n', ''), encoding='utf-8')
        else:
            path = project / '.claude' / 'skills' / 'forker' / 'SKILL.md'
            path.parent.mkdir(parents=True)
            path.write_text(SKILL.format(name='forker', agent=agent), encoding='utf-8')
        if agent == 'editor':
            a = project / '.claude' / 'agents' / 'editor.md'
            a.parent.mkdir(parents=True, exist_ok=True)
            a.write_text(EDITOR, encoding='utf-8')
        p0.git(project, 'add', '.claude')
        p0.git(project, 'commit', '-m', 'p3 skill')
        return project
    return original, make


def rules(skill):
    return [
        {'when': 'P0-PARENT', 'reply': {'tools': [{'id': 'toolu_pSkill01', 'name': 'Skill', 'input': {'skill': skill}}]}},
        {'when': 'FORK-BODY', 'reply': {'tools': [{'id': 'toolu_fBash01', 'name': 'Bash', 'input': {
            'command': 'echo from-fork > fork.txt && pwd && git rev-parse --show-toplevel --abbrev-ref HEAD', 'description': 'fork writes'}}]}},
        {'when': 'toolu_fBash01', 'reply': {'tools': [{'id': 'toolu_fWrite02', 'name': 'Write', 'input': {
            'file_path': '@MAIN@\\fork-write.txt', 'content': 'fork-write\n'}}]}},
        {'when': 'toolu_fWrite02', 'reply': {'text': 'FORK-DONE'}},
        {'when': 'toolu_pSkill01', 'reply': {'text': 'PARENT-DONE'}},
    ]


def record_hooks():
    http = lambda ev: [{'type': 'http', 'url': f'@HOOKS@/hooks/{ev}', 'timeout': 60}]
    hooks = {ev: [{'hooks': http(ev)}] for ev in ('SubagentStart', 'SubagentStop', 'WorktreeCreate', 'WorktreeRemove')}
    hooks['PreToolUse'] = [{'matcher': '*', 'hooks': http('PreToolUse')}]
    hooks['PostToolUse'] = [{'matcher': '*', 'hooks': http('PostToolUse')}]
    return {'hooks': hooks}


def forced_hooks(b):
    """AIB's planned command-hook set (PreToolUse Agent|Task forces isolation) plus recorders for Skill and SubagentStart."""
    return p0.cmd_hooks(b, extra={
        'PreToolUse': [{'matcher': 'Agent|Task', 'hooks': [p0.cmd(b, 'pre', '--force-isolation')]},
                       {'matcher': 'Skill', 'hooks': [p0.cmd(b, 'pre-skill')]}],
        'SubagentStart': [{'hooks': [p0.cmd(b, 'start')]}]})


def skill_schema(dump):
    """The Skill tool (description, input_schema) from the first model request that offers it."""
    for f in sorted(dump.glob('*.json')):
        try:
            body = json.loads(f.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        for t in body.get('tools') or []:
            if t.get('name') == 'Skill':
                return {'request': f.name, 'description': t.get('description'), 'input_schema': t.get('input_schema')}
    return None


def fork_requests(dump):
    """Model requests whose newest message carries the skill body: their system prompt head and message count (inherits parent?)."""
    out = []
    for f in sorted(dump.glob('*.json')):
        raw = f.read_text(encoding='utf-8')
        if 'FORK-BODY' not in raw:
            continue
        body = json.loads(raw)
        msgs = body.get('messages') or []
        sysp = body.get('system')
        sys_text = json.dumps(sysp) if sysp is not None else ''
        out.append({'request': f.name, 'messages': len(msgs), 'has_parent_prompt': 'P0-PARENT' in json.dumps(msgs),
                    'tools': [t.get('name') for t in body.get('tools') or []], 'system_head': sys_text[:300],
                    'last': json.dumps(msgs[-1])[:500] if msgs else None})
    return out


def run(b, name, kind, agent, settings_fn, recorder=(), prompt='P0-PARENT go', mode=None):
    original, make = setup(kind, agent)
    p0.make_repo = make
    try:
        settings = settings_fn(b)
        report = p0.claude_scenario(b, name, rules('forkcmd' if kind == 'command' else 'forker'), settings, recorder=list(recorder), prompt=prompt, mode=mode)
    finally:
        p0.make_repo = original
    report['skill_tool'] = skill_schema(b / 'dump')
    report['fork_requests'] = fork_requests(b / 'dump')
    report['fork_txt_found'] = sorted(str(p) for p in b.rglob('fork.txt'))
    report['fork_write_found'] = sorted(str(p) for p in b.rglob('fork-write.txt'))
    report['raw_hooks_log'] = str(b / 'hooks.log')
    return report


VARIANTS = {
    'fork-gp': lambda b: run(b, 'fork-gp', 'skill', 'general-purpose', lambda _b: record_hooks(), ['--worktree-root', str(b / 'wt')]),
    'fork-editor': lambda b: run(b, 'fork-editor', 'skill', 'editor', lambda _b: record_hooks(), ['--worktree-root', str(b / 'wt')]),
    'fork-cmd': lambda b: run(b, 'fork-cmd', 'command', 'general-purpose', lambda _b: record_hooks(), ['--worktree-root', str(b / 'wt')]),
    'fork-forced': lambda b: run(b, 'fork-forced', 'skill', 'general-purpose', forced_hooks),
    # typed by the user: the prompt itself is `/forker` (or `/forkcmd`), no Skill tool call by the model
    'typed-gp': lambda b: run(b, 'typed-gp', 'skill', 'general-purpose', lambda _b: record_hooks(), ['--worktree-root', str(b / 'wt')], prompt='/forker'),
    'typed-cmd': lambda b: run(b, 'typed-cmd', 'command', 'general-purpose', lambda _b: record_hooks(), ['--worktree-root', str(b / 'wt')], prompt='/forkcmd'),
    'typed-bypass': lambda b: run(b, 'typed-bypass', 'skill', 'general-purpose', forced_hooks, prompt='/forker', mode='bypassPermissions'),
    'typed-accept': lambda b: run(b, 'typed-accept', 'skill', 'general-purpose', forced_hooks, prompt='/forker', mode='acceptEdits'),
    'typed-forced': lambda b: run(b, 'typed-forced', 'skill', 'general-purpose', forced_hooks, prompt='/forker'),
}


def main():
    scratch = pathlib.Path(sys.argv[1]).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    before = p0.owner_snapshot()
    reports = []
    for name in sys.argv[2:]:
        base = scratch / f'{name}-{p0.RUN}'
        try:
            reports.append(VARIANTS[name](base))
        except Exception as err:  # a probe reports, it does not stop
            reports.append({'scenario': name, 'error': repr(err)})
    report = {'run': p0.RUN, 'claude_acp': str(p0.CLAUDE_ACP), 'scenarios': reports, 'owner': p0.owner_check(before, scratch)}
    out = scratch / f'report-p3-{p0.RUN}.json'
    out.write_text(json.dumps(report, indent=1), encoding='utf-8')
    print(out)


if __name__ == '__main__':
    main()
