#!/usr/bin/env python3
"""Local, read-only OMP and Claude Code transcript viewer. Run with --help for options."""
import argparse
import base64
import bisect
import binascii
import collections
import contextlib
from datetime import datetime
import json
import mimetypes
import pathlib
import os
import re
import tempfile
import xml.etree.ElementTree as ET
import threading
import time
import urllib.parse
import webbrowser
import secrets
from app_paths import APP_ROOT
import log_setup
import security
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = APP_ROOT
TEXT_LIMIT = 32000
QUIET_UNKNOWN_SECONDS = 4 * 3600
TERMINAL_STATUSES = ('completed', 'failed', 'killed', 'cancelled')
# Claude Code tools that stop a background job, and the argument naming the job.
STOP_TOOLS = {'taskstop': 'task_id', 'killshell': 'shell_id', 'killbash': 'shell_id'}
# Claude Code tools that report on a background job; a terminal status they print for a known job is authoritative.
POLL_TOOLS = {'bashoutput': 'bash_id', 'taskoutput': 'task_id'}
# Parsed transcripts stay in memory up to this many bytes of SOURCE file (the bytes read so far, a cheap stand-in for memory).
# Why 1.5 GB: the biggest chat seen has 130 transcripts / ~270 MB, so a family of five such chats fits. Resident size is a fraction of
# the source (text is clipped at 32,000 characters, blobs and snapshots are skipped: 34k events were ~44 MB as JSON for ~200 MB of
# source), so the cap means a few hundred MB of Python objects at most, and a single oversized transcript is still kept while in use.
TRANSCRIPT_CACHE_BUDGET = 1536 * 1024 * 1024
# command_list results are reused while no transcript file changed, for at most this long (idle seconds and "quiet" ageing are clock based).
COMMAND_LIST_TTL = 3.0
# Rows that are never displayed and carry nothing the page counts, recognised by the start of the raw line, so json.loads is skipped.
# A snapshot may still carry a task-notification (see Transcript.track_commands), so those are always parsed.
_SKIP_ROW = re.compile(rb'\A\s*\{\s*"type"\s*:\s*"(api-request-blob|file-history-snapshot)"')


def skippable_row(line):
    """True for a raw transcript line that normalize/update_metadata/track_commands would ignore entirely."""
    return _SKIP_ROW.match(line, 0, 96) is not None and b'task-notification' not in line


def tool_name_of(task):
    return str(task.get('tool') or '').lower()


def clipped(value, limit=TEXT_LIMIT):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    return text if len(text) <= limit else text[:limit] + '\n\n[Display shortened; full text remains in the original transcript.]'


# Studio's note to the agent in front of a prompt (worktree live sync, worktree_sync.py). The agent's saved history keeps it; no view shows it.
STUDIO_CONTEXT = re.compile(r'<studio-context>.*?</studio-context>\s*', re.S)


def strip_studio_context(text):
    return STUDIO_CONTEXT.sub('', text) if isinstance(text, str) and '<studio-context>' in text else text


def content_text(content):
    if isinstance(content, str):
        return strip_studio_context(content)
    if not isinstance(content, list):
        return ''
    return '\n'.join(strip_studio_context(str(b.get('text', ''))) for b in content if isinstance(b, dict) and b.get('type') == 'text')


# ---- readable conversation titles -------------------------------------------------------------
TITLE_LIMIT = 90
# Wrapper blocks that agents and the CLI inject into user turns. The block and everything inside it is dropped.
_NOISE_TAGS = ('system-reminder', 'command-message', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr',
               'user-prompt-submit-hook', 'ide_opened_file', 'ide_selection', 'ide_diagnostics', 'task-notification', 'side-sessions-event',
               'bash-input', 'bash-stdout', 'bash-stderr', 'command-stdout', 'hook-output', 'environment_details',
               'system_instruction', 'artifact-view-context', 'studio-context', 'cross-session-message', 'session-start-hook', 'post-tool-use-hook', 'pre-tool-use-hook', 'stop-hook',
               'fork-boilerplate')
_NOISE_BLOCK = re.compile(r'<(' + '|'.join(re.escape(t) for t in _NOISE_TAGS) + r')\b[^>]*>.*?</\1\s*>', re.S | re.I)
_NOISE_OPEN = re.compile(r'<(' + '|'.join(re.escape(t) for t in _NOISE_TAGS) + r')\b[^>]*>.*\Z', re.S | re.I)  # truncated block
_COMMAND_NAME = re.compile(r'<command-name>\s*(.*?)\s*</command-name>', re.S | re.I)
_COMMAND_ARGS = re.compile(r'<command-args>\s*(.*?)\s*</command-args>', re.S | re.I)
# Messages that are scaffolding rather than something the user typed; the next real user message is used instead.
_BOILERPLATE = re.compile(r'^\s*(?:'
                          # a compaction summary, also behind self-closing tags and the note about others' Artifact content
                          r'(?:<[\w-]+\s*/>\s*)*(?:the summarized conversation included artifact content[^\n]*\s*)?'
                          r'this session is being continued from a previous conversation|'
                          r'another claude session sent a message:|'
                          r'the coordinator sent a message while you were working:|'
                          r'\[system notification - not user input\]|'
                          r'\[handback-send-enforce\]|'
                          r'caveat:\s*the messages below were generated by the user while running local commands|'
                          r'\[request interrupted by user|'
                          r'base directory for this skill:|'
                          r'the user opened the file|'
                          r'<local-command-|'
                          r'continue from where you left off|'
                          r'\[image(?: #\d+)?\]\s*$)', re.I)

TITLE_ROW = re.compile(rb'"type": ?"(?:ai-title|custom-title|title|summary)"')


def tidy_title(text, limit=TITLE_LIMIT):
    """Plain-text, single-line, length-capped version of any text. Markdown and tags are removed, never rendered."""
    if not isinstance(text, str):
        return ''
    lines = [ln for ln in (l.strip() for l in text.splitlines()) if ln and not re.fullmatch(r'[`~]{3,}.*', ln) and not re.fullmatch(r'[-=_*#\s]{3,}', ln)]
    first = lines[0] if lines else ''
    # A short first line followed by more text reads better as a whole ("Fix this:" + body); a full line is a title already.
    joined = first if len(first) >= 16 else ' '.join(lines[:3])
    joined = re.sub(r'<[^>\n]{0,200}>', ' ', joined)                      # XML-ish tags
    joined = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', joined)              # images -> alt text
    joined = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', joined)               # links -> label
    joined = re.sub(r'^\s*(?:#{1,6}\s+|>+\s*|[-*+]\s+|\d+[.)]\s+)', '', joined)  # heading / quote / list markers
    joined = re.sub(r'(\*\*|__|~~|`+)', '', joined)                          # emphasis and code marks
    joined = re.sub(r'(?<![\w])[*_](?=\S)|(?<=\S)[*_](?![\w])', '', joined)
    joined = re.sub(r'\s+', ' ', joined).strip(' \t-:|')
    if len(joined) > limit:
        cut = joined[:limit]
        space = cut.rfind(' ')
        joined = (cut[:space] if space >= limit * 0.6 else cut).rstrip(' ,;:.-') + '\u2026'
    return joined


def clean_prompt(text):
    """The title candidate for one user message, or '' when the message is scaffolding (reminders, commands, continuations)."""
    if not isinstance(text, str) or not text.strip():
        return ''
    command = _COMMAND_NAME.search(text)
    command_title = ''
    if command:
        args = _COMMAND_ARGS.search(text)
        command_title = (command.group(1) + ' ' + (args.group(1) if args else '')).strip()
    body = _NOISE_OPEN.sub('', _NOISE_BLOCK.sub('', text))
    body = re.sub(r'<command-(?:name|args|message)>.*?</command-(?:name|args|message)>', '', body, flags=re.S | re.I)
    body = body.strip()
    if body and _BOILERPLATE.match(body):
        return ''
    if not body:
        return tidy_title(command_title)
    return tidy_title(body)


def derive_title(meta):
    """Best readable title: owner or adapter titles first, then Claude's summary, then the first real user message."""
    for key in ('customTitle', 'aiTitle', 'agentTitle', 'summaryTitle'):
        value = tidy_title(meta.get(key))
        if value:
            return value
    return meta.get('prompt') or ''


IMAGE_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}
IMAGE_LIMIT = 10 * 1024 * 1024
# Text the CLI adds next to a pasted image ("[Image #1]", "[Image: source: C:\...\16.png]"); the picture itself is shown instead.
IMAGE_REF = re.compile(r'(?:\s*\[Image(?: #\d+)?(?::\s*source:\s*[^\]\n]+)?\]\s*)+')


def image_block(block):
    """(media type, base64 data) of a transcript image block, or (None, None). Claude Code: {"type":"image","source":
    {"type":"base64","media_type":..,"data":..}}; OMP and ACP: {"type":"image","mimeType":..,"data":..}."""
    source = block.get('source') if isinstance(block.get('source'), dict) else None
    if source and source.get('type') == 'base64':
        media, data = source.get('media_type'), source.get('data')
    else:
        media, data = block.get('mimeType') or block.get('media_type'), block.get('data')
    if media in IMAGE_TYPES and isinstance(data, str) and data and len(data) <= IMAGE_LIMIT * 4 // 3 + 4:
        return media, data
    return None, None


def as_message(row):
    """Claude Code saves a message the user sends while the agent is working as {"type":"attachment","attachment":
    {"type":"queued_command","commandMode":"prompt","prompt": text or content blocks}}; read it as an ordinary user message."""
    att = row.get('attachment') if row.get('type') == 'attachment' else None
    if isinstance(att, dict) and att.get('type') == 'queued_command' and att.get('commandMode', 'prompt') == 'prompt':
        prompt = att.get('prompt')
        if isinstance(prompt, (str, list)) and prompt:
            return {'type': 'user', 'timestamp': row.get('timestamp') or att.get('timestamp', ''), 'queued': True,
                    'message': {'role': 'user', 'content': prompt}}
    return row


def finished_tasks(row):
    """Background tasks a queued task-notification reports as finished. Claude Code delivers these mid-turn, so they are
    not user messages; the page only needs the ids (the plan card's "N running tasks")."""
    att = row.get('attachment') if row.get('type') == 'attachment' else None
    if not (isinstance(att, dict) and att.get('type') == 'queued_command' and att.get('commandMode') == 'task-notification'):
        return []
    prompt = att.get('prompt')
    raw = prompt if isinstance(prompt, str) else content_text(prompt) if isinstance(prompt, list) else ''
    ids = []
    for match in re.finditer(r'<task-notification>(.*?)</task-notification>', raw, re.S):
        job = re.search(r'<task-id>\s*([^<\s]+)\s*</task-id>', match[1])
        status = re.search(r'<status>\s*([^<\s]+)\s*</status>', match[1])
        if job and not (status and status[1].lower() == 'running'):
            ids.append(job[1])
    return ids


def normalize(row, number):
    done = finished_tasks(row)
    if done:
        return [{'id': f'{number}-done', 'kind': 'task-done', 'label': 'Background task finished', 'text': ' '.join(done),
                 'time': row.get('timestamp', '')}]
    row = as_message(row)
    stamp = row.get('timestamp', '')
    if row.get('type') == 'session_init':
        return [{'id': f'{number}-task', 'kind': 'assignment', 'time': stamp,
                 'text': clipped(row.get('task', '')), 'label': 'Assignment'}] if row.get('task') else []
    if row.get('type') not in ('message', 'custom_message', 'user', 'assistant'):
        return []
    msg = row.get('message', row)
    role = msg.get('role', 'notice')
    content = msg.get('content', [])
    stamp = stamp or msg.get('timestamp', '')
    events = []
    if role == 'toolResult':
        events.append({'kind': 'error' if msg.get('isError') else 'result', 'label': msg.get('toolName', 'Tool result'),
                       'text': clipped(content_text(content)), 'callId': msg.get('toolCallId'), 'time': stamp})
    elif isinstance(content, str):
        shown = strip_studio_context(content) if role == 'user' else content
        if shown or not content:
            events.append({'kind': role, 'label': role.title(), 'text': clipped(shown), 'time': stamp})
    elif isinstance(content, list):
        for index, block in enumerate(content):
            if not isinstance(block, dict):
                continue
            kind = block.get('type')
            if kind in ('toolCall', 'tool_use'):
                events.append({'kind': 'tool', 'label': block.get('name', 'Tool'), 'time': stamp,
                               'text': clipped(block.get('arguments', block.get('input', {}))), 'callId': block.get('id'),
                               'intent': block.get('intent', '')})
            elif kind == 'tool_result':
                event = {'kind': 'error' if block.get('is_error') else 'result', 'label': 'Tool result',
                         'time': stamp, 'callId': block.get('tool_use_id'),
                         'text': clipped(content_text(block.get('content', '')))}
                # Pictures a tool returned (a screenshot): addresses only, fetched on demand like pasted ones.
                inner = block.get('content')
                shots = [{'n': number, 'i': index, 'j': j, 'mediaType': media} for j, part in enumerate(inner if isinstance(inner, list) else [])
                         if isinstance(part, dict) and part.get('type') == 'image' for media in [image_block(part)[0]] if media]
                if shots:
                    event['images'] = shots
                events.append(event)
            elif kind in ('text', 'thinking'):
                text = block.get('text' if kind == 'text' else 'thinking', '')
                if kind == 'text' and role == 'user':
                    text = strip_studio_context(text)
                if kind == 'text' and role == 'user' and IMAGE_REF.fullmatch(text):
                    continue
                if text:
                    events.append({'kind': role if kind == 'text' else 'thinking', 'label': role.title() if kind == 'text' else 'Thinking',
                                   'time': stamp, 'text': clipped(text)})
            elif kind == 'image':
                media, _ = image_block(block)
                if media:
                    # The picture is fetched on demand from /api/transcript/image; only its address travels with the page.
                    events.append({'kind': role, 'label': role.title(), 'time': stamp, 'text': '', 'images': [{'n': number, 'i': index, 'mediaType': media}]})
                else:
                    events.append({'kind': role, 'label': 'Image attachment', 'time': stamp, 'text': '[Image could not be shown: unsupported type or too large.]'})
    # A pasted screenshot and the words typed with it are one message: hang the pictures on that message's text.
    pictures = [e for e in events if 'images' in e]
    text = next((e for e in events if e['kind'] == role and 'images' not in e and e['text']), None)
    if pictures and text is not None:
        text['images'] = [im for e in pictures for im in e['images']]
        events = [e for e in events if 'images' not in e or e is text]
    for i, event in enumerate(events):
        event['id'] = f'{number}-{i}'
    return events


def _encoded(path):
    """Claude Code names a project's transcript folder after the folder path with every non-alphanumeric turned into '-'."""
    return re.sub(r'[^A-Za-z0-9]', '-', str(path))


def project_match(cwds, transcript):
    """The folder (or a parent of a folder) among cwds whose encoding names the transcript's project folder, else None.
    Git Bash style paths (/c/Users/...) are read as Windows paths (C:\\Users\\...)."""
    names = {p.name for p in list(pathlib.Path(transcript).parents)[:4]}
    for cwd in cwds:
        if not isinstance(cwd, str) or not cwd:
            continue
        msys = re.match(r'^/([A-Za-z])(/.*)?$', cwd) if os.name == 'nt' else None   # on POSIX /c/x is a real folder
        if msys:
            cwd = msys.group(1).upper() + ':' + (msys.group(2) or '/').replace('/', '\\')
        pure = pathlib.PureWindowsPath(cwd) if (re.match(r'^[A-Za-z]:', cwd) or '\\' in cwd) else pathlib.PurePosixPath(cwd)   # a ':' elsewhere is legal in POSIX names
        for candidate in [pure, *pure.parents]:
            if str(candidate) not in ('.', '/', '\\') and _encoded(candidate) in names:
                return str(candidate)
    return None


def project_cwd(meta, transcript):
    """The folder a chat belongs to. Claude Code files the transcript under its project folder's encoded name, so the folder
    (or a parent of a folder) the chat visited whose encoding matches wins; otherwise the first folder seen."""
    cwds = meta.get('_cwds') or ([meta['cwd']] if meta.get('cwd') else [])
    return project_match(cwds, transcript) or (cwds[0] if cwds else meta.get('cwd'))


CWD_FIELD = re.compile(rb'"cwd"\s*:\s*("(?:[^"\\]|\\.)*")')


def scan_cwds(path, limit=256, chunk=4 << 20):
    """Every distinct folder a transcript records, in order, read in chunks without parsing the records."""
    seen = []
    try:
        with open(path, 'rb') as f:
            carry = b''
            while len(seen) < limit:
                block = f.read(chunk)
                if not block:
                    break
                data = carry + block
                for match in CWD_FIELD.finditer(data):
                    try:
                        value = json.loads(match.group(1))
                    except ValueError:
                        continue
                    if isinstance(value, str) and value and value not in seen:
                        seen.append(value)
                carry = data[-4096:]
    except OSError:
        pass
    return seen


def update_metadata(meta, row):
    kind = row.get('type')
    if kind == 'session':
        meta.update({k: row.get(k) for k in ('cwd', 'id', 'parentSession', 'timestamp')})
    elif kind in ('title', 'ai-title', 'custom-title', 'summary'):
        field = {'title': ('title', 'agentTitle'), 'ai-title': ('aiTitle', 'aiTitle'), 'custom-title': ('customTitle', 'customTitle'),
                 'summary': ('summary', 'summaryTitle')}[kind]
        value = row.get(field[0]) if isinstance(row.get(field[0]), str) else row.get('title')
        if isinstance(value, str) and value.strip():
            meta[field[1]] = value
    elif kind == 'model_change':
        meta['model'] = row.get('model', '')
    elif kind == 'session_init':
        meta['model'] = row.get('resolvedModel', meta.get('model', ''))
        task = row.get('task')
        if isinstance(task, str) and task.strip() and 'task' not in meta:
            meta['task'] = task.strip().splitlines()[0][:200]
    elif kind == 'message' and isinstance(row.get('message'), dict):
        msg = row['message']
        if msg.get('role') == 'user' and 'prompt' not in meta and not row.get('isMeta'):
            prompt = clean_prompt(content_text(msg.get('content', '')))
            if prompt:
                meta['prompt'] = prompt
    elif kind in ('user', 'assistant'):
        if row.get('agentId'):
            meta['agentId'] = row['agentId']
        cwd = row.get('cwd')
        if isinstance(cwd, str) and cwd:
            # The agent can cd anywhere during a chat; keep every folder seen (bounded) and pick the chat's project later.
            seen = meta.setdefault('_cwds', [])
            if cwd not in seen and len(seen) < 64:
                seen.append(cwd)
            meta.setdefault('cwd', cwd)
        if row.get('sessionId'):
            meta['id'] = row['sessionId']
        meta.setdefault('timestamp', row.get('timestamp'))
        msg = row.get('message', {})
        if isinstance(msg, dict) and msg.get('model'):
            meta['model'] = msg['model']
        if kind == 'user' and 'prompt' not in meta and not row.get('isMeta') and not row.get('isSidechain'):
            prompt = clean_prompt(content_text(msg.get('content', '')) if isinstance(msg, dict) else '')
            if prompt:
                meta['prompt'] = prompt


# The page folds a chat's plan card, pinned plan and "N running tasks" from the rows it holds (plan-ui.js). A long turn can push the
# update_plan call that set the plan out of the newest page of events, so the transcript also remembers which events that fold
# reads, and plan_context() hands back the ones older than the page.
PLAN_TOOL = re.compile(r'(?:^|__)update_plan$|^TodoWrite$', re.I)
WRAP_TOOL = re.compile(r'(?:^|__)ccd_turn__wrap_up$')
BG_LAUNCH = re.compile(r'^[\s"{\[]*(?:Async agent launched|Command running in background with ID|Backgrounded as job)', re.I)
BG_ID = re.compile(r'agentId:\s*([\w-]+)|in background with ID:?\s*([\w-]+)', re.I)
FINISH_TEXT = re.compile(r'<task-notification\b|Successfully (?:stopped|killed) task|\[Subagent hand-back\]', re.I)
CONTEXT_LIMIT = 1500


def finished_ids(text):
    """Task ids the page's fold treats as finished in this text (mirrors finishedIds in plan-ui.js)."""
    ids = [m[1] for m in re.finditer(r'Successfully (?:stopped|killed) task:?\s*([\w-]+)', text, re.I)]
    if '[Subagent hand-back]' in text:
        sender = re.search(r'<agent-message\s+from="([\w-]+)"', text, re.I)
        if sender:
            ids.append(sender[1])
    for match in re.finditer(r'<task-notification\b[^>]*>(.*?)</task-notification>', text, re.S | re.I):
        job = re.search(r'<task-id>\s*([^<\s]+)\s*</task-id>', match[1], re.I)
        status = re.search(r'<status>\s*([^<\s]+)\s*</status>', match[1], re.I)
        if job and not (status and status[1].lower() == 'running'):
            ids.append(job[1])
    return ids


def plan_mark(event, flagged):
    """What the page's plan fold would read in this event: 'set' (an update_plan with a full list), 'patch', 'wrap', 'launch'
    (a background launch), 'finish' (a background task ending), 'user' (a turn boundary), or None. `flagged` holds the ids of
    run_in_background calls, so their results count as launches too."""
    kind, text = event['kind'], event.get('text') or ''
    if kind == 'tool':
        label = str(event.get('label') or '')
        if PLAN_TOOL.search(label):
            try:
                data = json.loads(text)
            except ValueError:
                return None
            if isinstance(data, dict):
                if any(isinstance(data.get(k), list) for k in ('todos', 'items', 'plan')):
                    return 'set'
                if data.get('advance') or isinstance(data.get('done'), list) or isinstance(data.get('start'), int):
                    return 'patch'
            return None
        if WRAP_TOOL.search(label):
            return 'wrap'
        if re.search(r'"run_in_background"\s*:\s*true', text):
            if event.get('callId'):
                flagged.add(event['callId'])
            return 'launch'
        return None
    if kind in ('result', 'error'):
        if BG_LAUNCH.match(text) or (event.get('callId') in flagged):
            return 'launch'
        return 'finish' if FINISH_TEXT.search(text) else None
    if kind == 'task-done':
        return 'finish'
    if kind == 'user':
        return 'user'
    return None


class Transcript:
    parses = 0   # refreshes that really read the file (a unit-test and timing probe; unchanged files do not count)

    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()   # one reader of this file at a time; other transcripts are not blocked
        self.offset = 0
        self.number = 0
        self.events = []
        self.plan_marks = []     # (index into events, mark) for the events plan_mark names
        self.thinking_at = []    # indexes of 'thinking' events, to map a thinking-hidden position back
        self.flagged_calls = set()
        self.image_offsets = {}  # record number -> byte offset, for records that hold an image
        self.anchor = b''  # the last bytes before `offset`, to notice a file replaced under us
        self.meta = {}
        self.signature = None
        self.commands = {}
        self.job_calls = {}
        self.stop_calls = {}
        self.poll_calls = {}
        self.ended_ids = set()  # ids a task-notification / TaskStop reported finished (an agent's id too), mapped to a command or not

    def track_commands(self, row):
        msg = row.get('message', row)
        if not isinstance(msg, dict):
            return
        stamp = row.get('timestamp') or msg.get('timestamp')
        content = msg.get('content', [])
        blocks = content if isinstance(content, list) else [{'type': 'text', 'text': content}] if isinstance(content, str) else []
        role = msg.get('role', row.get('type'))
        # Raw API snapshots are inspected only for explicit task lifecycle records.
        snapshots = row.get('type') == 'api-request-blob'
        for block in blocks:
            if not isinstance(block, dict):
                continue
            tool_name = str(block.get('name', '')).lower()
            if not snapshots and block.get('type') in ('toolCall', 'tool_use') and tool_name in STOP_TOOLS:
                args = block.get('input', block.get('arguments', {}))
                if isinstance(args, dict) and block.get('id') and args.get(STOP_TOOLS[tool_name]):
                    self.stop_calls[block['id']] = str(args[STOP_TOOLS[tool_name]])
            if not snapshots and block.get('type') in ('toolCall', 'tool_use') and tool_name in POLL_TOOLS:
                args = block.get('input', block.get('arguments', {}))
                if isinstance(args, dict) and block.get('id') and args.get(POLL_TOOLS[tool_name]):
                    self.poll_calls[block['id']] = str(args[POLL_TOOLS[tool_name]])
            if not snapshots and block.get('type') in ('toolCall', 'tool_use') and str(block.get('name', '')).lower() in ('bash', 'powershell', 'shell', 'exec_command', 'run_terminal_cmd', 'run_terminal_command', 'monitor'):
                args = block.get('arguments', block.get('input', {}))
                if not isinstance(args, dict):
                    continue
                call = block.get('id')
                if not call:
                    continue
                self.commands.setdefault(call, dict(callId=call, tool=block.get('name'), command=clipped(args.get('command', args.get('cmd', ''))),
                    title=clipped(args.get('description') or block.get('intent') or args.get('i') or args.get('command', args.get('cmd', 'Shell command')), 240),
                    description=clipped(args.get('description') or block.get('intent') or args.get('i') or '', 240),
                    started=stamp, ended=None, status='in-progress', background=bool(args.get('run_in_background') or args.get('async')) or tool_name == 'monitor',
                    output='', jobId=None, durationMs=None,
                    timeoutMs=args.get('timeout_ms') if isinstance(args.get('timeout_ms'), (int, float)) and not isinstance(args.get('timeout_ms'), bool) else None,
                    persistent=args.get('persistent') is True))
            if not snapshots and (block.get('type') == 'tool_result' or role == 'toolResult'):
                call = block.get('tool_use_id') or msg.get('toolCallId')
                stop_job = self.stop_calls.get(call)
                if stop_job and not block.get('is_error') and not msg.get('isError'):
                    result = row.get('toolUseResult')
                    if not isinstance(result, dict):
                        try:
                            result = json.loads(content_text(block.get('content', '')))
                        except (ValueError, TypeError):
                            result = {}
                    stopped = self.commands.get(self.job_calls.get(stop_job))
                    named = isinstance(result, dict) and stop_job in (result.get('task_id'), result.get('shell_id'))
                    if stopped and named and str(result.get('message', '')).startswith(('Successfully stopped task: ' + stop_job, 'Successfully killed shell: ' + stop_job)):
                        stopped.update(status='killed', ended=stamp, completionSummary=clipped(result['message'], 500))
                    if isinstance(result, dict) and stop_job == result.get('task_id') and str(result.get('message', '')).startswith('Successfully stopped task'):
                        self.ended_ids.add(stop_job)
                poll_job = self.poll_calls.get(call)
                if poll_job and not block.get('is_error') and not msg.get('isError'):
                    polled = self.commands.get(self.job_calls.get(poll_job))
                    report = content_text(block.get('content', '')) if block.get('type') == 'tool_result' else content_text(msg.get('content', []))
                    state = re.search(r'<status>\s*(completed|failed|killed|cancelled)\s*</status>', report)
                    if polled and state and polled['status'] in ('running', 'in-progress'):
                        polled.update(status=state[1], ended=stamp, completionSummary='Reported by a later output check')
                task = self.commands.get(call)
                if task:
                    details = msg.get('details') or row.get('toolUseResult') or {}
                    details = details if isinstance(details, dict) else {}
                    output = content_text(block.get('content', '')) if block.get('type') == 'tool_result' else content_text(msg.get('content', []))
                    task['output'] = clipped(output)
                    if tool_name_of(task) == 'monitor':
                        stated = re.search(r'expires in\s+((?:\d+\s*[hms]\s*)+)', output)
                        if stated:
                            units = {'h': 3600, 'm': 60, 's': 1}
                            task['expirySeconds'] = sum(int(n) * units[u] for n, u in re.findall(r'(\d+)\s*([hms])', stated[1]))
                        if not isinstance(task.get('expirySeconds'), (int, float)) and isinstance(task.get('timeoutMs'), (int, float)) and task['timeoutMs'] > 0:
                            task['expirySeconds'] = task['timeoutMs'] / 1000
                    async_info = details.get('async', {})
                    async_info = async_info if isinstance(async_info, dict) else {}
                    if isinstance(details.get('timeoutSeconds'), (int, float)) and not isinstance(details.get('timeoutSeconds'), bool):
                        task['timeoutSeconds'] = details['timeoutSeconds']
                    job = details.get('backgroundTaskId') or async_info.get('jobId')
                    if not job and tool_name_of(task) == 'monitor':
                        # A Monitor watch: "Monitor started (task <id>, expires in ...". It ends with a task-notification.
                        match = re.match(r'\s*Monitor started \(task\s+([A-Za-z0-9_-]+)', output)
                        job = match[1] if match else None
                    if not job:
                        # Only the tool's own opening line counts; a command that merely printed this text (cat of a
                        # fixture or transcript) must not turn an ordinary foreground command into a "running" job.
                        match = re.match(r'\s*(?:Backgrounded as job|Command running in background with ID:)\s*([A-Za-z0-9_-]+)', output, re.I)
                        if match and (task['background'] or output.lstrip().startswith(('Command running in background', 'Backgrounded as job'))):
                            job = match[1]
                    if job:
                        immediate = async_info.get('state') if async_info.get('state') in TERMINAL_STATUSES else None
                        task.update(jobId=job, background=True, status=immediate or 'running')
                        if immediate and not task.get('ended'):
                            task['ended'] = stamp
                        self.job_calls[str(job)] = call
                    else:
                        task.update(status='failed' if block.get('is_error') or msg.get('isError') else 'completed', ended=stamp,
                                    durationMs=details.get('wallTimeMs'), exitCode=details.get('exitCode'))
            raw = block.get('text') or (block.get('content') if isinstance(block.get('content'), str) else '') or ''
            self.apply_notifications(raw, stamp)
        # Claude Code also stores notifications outside message blocks: queue records and queued-command attachments.
        if isinstance(row.get('content'), str) and row.get('type') == 'queue-operation':
            self.apply_notifications(row['content'], stamp)
        attachment = row.get('attachment')
        if isinstance(attachment, dict) and attachment.get('type') == 'queued_command':
            prompt = attachment.get('prompt')
            self.apply_notifications(prompt if isinstance(prompt, str) else content_text(prompt) if isinstance(prompt, list) else '', stamp)
        details = row.get('details', {})
        if row.get('customType') == 'async-result' and isinstance(details, dict):
            for job in details.get('jobs', []):
                if not isinstance(job, dict):
                    continue
                task = self.commands.get(self.job_calls.get(str(job.get('jobId'))))
                if task and job.get('status') in ('completed', 'failed', 'cancelled', 'killed'):
                    task.update(status=job['status'], ended=stamp, durationMs=job.get('durationMs'), output=clipped(content_text(content)))

    def apply_notifications(self, raw, stamp):
        for match in re.finditer(r'<task-notification>.*?</task-notification>', raw, re.S):
            try:
                notice = ET.fromstring(match.group())
            except ET.ParseError:
                continue
            status = {'stopped': 'killed', 'canceled': 'cancelled'}.get(notice.findtext('status'), notice.findtext('status'))
            if status not in TERMINAL_STATUSES + ('running',):
                continue
            jobs = [j.text for j in notice.findall('task-id') if j.text]
            if status in TERMINAL_STATUSES:
                self.ended_ids.update(jobs)
            for job in jobs or [None]:
                call = notice.findtext('tool-use-id') if len(jobs) <= 1 else None
                task = self.commands.get(call) or self.commands.get(self.job_calls.get(job))
                if not task:
                    continue
                if status == 'running' and task['status'] in TERMINAL_STATUSES:
                    continue  # A replayed record must not revive a job that already ended.
                task.update(status=status, background=True, jobId=job or task.get('jobId'), completionSummary=clipped(notice.findtext('summary') or '', 500))
                if status != 'running' and not task.get('ended'):
                    task['ended'] = stamp

    def refresh(self):
        with self.lock:
            return self._refresh()

    def _refresh(self):
        stat = self.path.stat()
        signature = (stat.st_size, stat.st_mtime_ns)
        if signature == self.signature:
            return self
        Transcript.parses += 1
        with self.path.open('rb') as stream:
            # Start over when the file shrank, was rewritten in place, or no longer continues the bytes already read
            # (a larger replacement would otherwise be resumed in the middle of a line and lose a record).
            if stat.st_size < self.offset or (self.signature and stat.st_size == self.offset) or not self.continues(stream):
                self.offset, self.number, self.events, self.meta, self.image_offsets, self.anchor = 0, 0, [], {}, {}, b''
                self.commands, self.job_calls, self.stop_calls, self.poll_calls, self.ended_ids = {}, {}, {}, {}, set()
                self.plan_marks, self.thinking_at, self.flagged_calls = [], [], set()
            stream.seek(self.offset)
            while True:
                start = stream.tell()
                line = stream.readline()
                if not line:
                    break
                if not line.endswith(b'\n'):
                    # A writer can still be appending this record; a last record that is already whole JSON is complete.
                    try:
                        if not isinstance(json.loads(line), dict):
                            break
                    except (ValueError, UnicodeError):
                        break
                self.offset = stream.tell()
                if not line.strip():
                    continue  # blank separator between records: not a record
                self.number += 1
                if skippable_row(line):
                    continue
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(row, dict):
                    continue
                update_metadata(self.meta, row)
                self.track_commands(row)
                found = normalize(row, self.number)
                if any('images' in event for event in found):
                    self.image_offsets[self.number] = start
                for event in found:
                    if event['kind'] == 'thinking':
                        self.thinking_at.append(len(self.events))
                    else:
                        mark = plan_mark(event, self.flagged_calls)
                        if mark:
                            self.plan_marks.append((len(self.events), mark))
                    self.events.append(event)
        if self.meta.get('_cwds'):
            self.meta['cwd'] = project_cwd(self.meta, self.path)
        with self.path.open('rb') as stream:
            stream.seek(max(0, self.offset - 64))
            self.anchor = stream.read(min(64, self.offset))
        self.signature = signature
        return self

    def plan_context(self, start, thinking_hidden=False):
        """The older events the page's plan fold needs, for a page of events that begins at position `start` (a position among the
        events the page sees: without 'thinking' ones when thinking_hidden). That is the turn holding the latest plan-setting
        update_plan, with its patches, wrap-ups, background launches and finishes and the user boundaries, plus earlier background
        launches that have not finished by then. Found from the marks kept while reading, not by rescanning events. These are
        copies marked ctx for the page to fold with and not draw."""
        full = start
        if thinking_hidden:
            while True:   # position among visible events -> position among all events
                nxt = start + bisect.bisect_right(self.thinking_at, full)
                if nxt == full:
                    break
                full = nxt
        marks = self.plan_marks[:bisect.bisect_left(self.plan_marks, (full, ''))]
        if not marks:
            return []
        sets = [i for i, (_, mark) in enumerate(marks) if mark == 'set'][-1:]
        if sets:
            q = sets[0]   # start of the turn holding it: the user message before it
            while q > 0 and marks[q][1] != 'user':
                q -= 1
        else:
            q = len(marks)
        # Background launches before that turn that are still running by then.
        open_at = {}
        for index, mark in marks[:q]:
            if mark not in ('launch', 'finish', 'user'):
                continue
            event = self.events[index]
            text = event.get('text') or ''
            if mark == 'launch' and event['kind'] != 'tool':
                found = BG_ID.search(text)
                if found:
                    open_at[found[1] or found[2]] = index
            for job in finished_ids(text) if mark != 'launch' else []:
                open_at.pop(job, None)
            if event['kind'] == 'task-done':
                for job in text.split():
                    open_at.pop(job, None)
        chosen = sorted(set(open_at.values()) | {i for i, _ in marks[q:]})[-CONTEXT_LIMIT:]
        context = []
        for index in chosen:
            event = dict(self.events[index], ctx=True)
            if event['kind'] == 'tool' and event['id'] and 'run_in_background' in (event.get('text') or '') and not PLAN_TOOL.search(str(event.get('label'))) and not WRAP_TOOL.search(str(event.get('label'))):
                event['text'] = '{"run_in_background": true}'   # the command itself is not needed
            if event['kind'] == 'user' and not FINISH_TEXT.search(event.get('text') or ''):
                event['text'] = ''
            context.append(event)
        return context

    def continues(self, stream):
        """True while the bytes just before the read offset are still the ones already parsed."""
        if not self.offset:
            return True
        stream.seek(max(0, self.offset - len(self.anchor)))
        return stream.read(len(self.anchor)) == self.anchor

    def image(self, number, index, sub=None):
        """(media type, bytes) of image block `index` in record `number`; ValueError if there is none."""
        start = self.image_offsets.get(number)
        if start is None:
            raise ValueError('Unknown image')
        with self.path.open('rb') as stream:
            stream.seek(start)
            row = json.loads(stream.readline())
        row = as_message(row) if isinstance(row, dict) else row
        msg = row.get('message', row) if isinstance(row, dict) else {}
        content = msg.get('content') if isinstance(msg, dict) else None
        if not isinstance(content, list) or not 0 <= index < len(content) or not isinstance(content[index], dict):
            raise ValueError('Unknown image')
        block = content[index]
        if sub is not None:  # a picture inside a tool_result block's own content list
            inner = block.get('content') if block.get('type') == 'tool_result' else None
            if not isinstance(inner, list) or not 0 <= sub < len(inner) or not isinstance(inner[sub], dict):
                raise ValueError('Unknown image')
            block = inner[sub]
        media, data = image_block(block)
        if not media:
            raise ValueError('Unknown image')
        raw = base64.b64decode(data, validate=True)
        if len(raw) > IMAGE_LIMIT:
            raise ValueError('Image too large')
        return media, raw


class Store:
    def __init__(self, root):
        self.root = root.resolve()
        self.cache = collections.OrderedDict()
        self.lock = threading.RLock()   # guards the cache bookkeeping only, never held while a file is read or parsed
        self.budget = TRANSCRIPT_CACHE_BUDGET
        self.sizes = {}          # transcript key -> source bytes parsed (its cost against the budget)
        self.pins = {}           # transcript key -> number of requests using it right now (never evicted)
        self.command_memo = {}   # session key -> (signatures, built at, tasks)
        self.command_locks = {}
        self.summary_cache = {}
        self.project_memo = {}   # transcript key -> project folder once found (it never changes for a transcript)
        self.hint_cache = {}
        self.project_resolver = None   # cwd -> {project, branch, base} for worktrees Studio made (set by studio.create_server)

    def resolve(self, key):
        if not isinstance(key, str) or security.is_network_path(key) or pathlib.PurePath(key).anchor:
            raise ValueError('Unknown transcript')   # a UNC or absolute key would replace the root and make Windows contact that server
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root) or path.suffix != '.jsonl' or not path.is_file():
            raise ValueError('Unknown transcript')
        return path

    def key(self, path):
        return path.resolve().relative_to(self.root).as_posix()

    def load(self, path):
        """The refreshed Transcript for `path`. The file is parsed outside self.lock (under the transcript's own lock, so two
        threads never parse one file at once); the transcript in use is pinned so the budget never evicts it."""
        key = self.key(path)
        with self.lock:
            transcript = self.cache.get(key)
            if transcript is None:
                transcript = self.cache[key] = Transcript(path)
            self.cache.move_to_end(key)
            self.pins[key] = self.pins.get(key, 0) + 1
        try:
            transcript.refresh()
        finally:
            with self.lock:
                self.sizes[key] = transcript.offset
                self._evict(keep=key)
                self._unpin(key)
        return transcript

    def _unpin(self, key):
        if self.pins.get(key, 0) <= 1:
            self.pins.pop(key, None)
        else:
            self.pins[key] -= 1

    def _evict(self, keep=None):
        """Drop least recently used, unpinned transcripts until the total is within the budget. Caller holds self.lock."""
        total = sum(self.sizes.get(k, 0) for k in self.cache)
        for key in list(self.cache):
            if total <= self.budget:
                break
            if key in self.pins or key == keep:
                continue
            total -= self.sizes.pop(key, 0)
            del self.cache[key]

    @contextlib.contextmanager
    def hold(self, keys):
        """Keep these transcripts cached while one request walks them (a chat's whole family)."""
        keys = list(keys)
        with self.lock:
            for key in keys:
                self.pins[key] = self.pins.get(key, 0) + 1
        try:
            yield
        finally:
            with self.lock:
                for key in keys:
                    self._unpin(key)
                self._evict()

    def summary(self, path):
        """The cached card data; a chat whose cwd is a Studio-made worktree is filed under its project (the lookup is not cached)."""
        item = self._summary(path)
        resolver = self.project_resolver
        found = None
        if resolver is not None and item.get('cwd'):
            try:
                found = resolver(item['cwd'])
            except Exception:
                found = None
        if found:
            item = dict(item, projectRoot=found['project'], worktree={'branch': found.get('branch', ''), 'base': found.get('base', '')})
        return item

    def _summary(self, path):
        stat = path.stat()
        key = self.key(path)
        sig = (stat.st_size, stat.st_mtime_ns)
        cached = self.summary_cache.get(key)
        if cached and cached[0] == sig:
            return cached[1]
        meta, last = {}, None
        # Session cards use bounded reads; only the selected chat is fully indexed.
        with path.open('rb') as f:
            head = f.read(1048576)
            f.seek(max(0, stat.st_size - 262144))
            tail = f.read()
        for number, line in enumerate(head.splitlines()):
            # The first 60 records always count; later ones only until a real user message gives a title,
            # and huge records (API snapshots) are skipped without parsing.
            titled = TITLE_ROW.search(line) is not None
            if number >= 60 and not titled and ('prompt' in meta or number >= 400 or len(line) > 65536):
                continue
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            update_metadata(meta, row)
        tail_lines = tail.splitlines()
        for line in tail_lines:
            if TITLE_ROW.search(line):
                try:
                    update_metadata(meta, json.loads(line))
                except (ValueError, UnicodeError):
                    pass
        for line in reversed(tail_lines):
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if row.get('type') not in ('title', 'ai-title', 'custom-title', 'summary'):
                update_metadata(meta, row)
            events = normalize(row, 0)
            if events:
                last = events[-1]
                break
        try:
            created = datetime.fromisoformat(str(meta.get('timestamp', '')).replace('Z', '+00:00')).timestamp()
        except (ValueError, TypeError):
            created = getattr(stat, 'st_birthtime', stat.st_ctime)
        title = derive_title(meta)
        # Cards read only the head and tail of a transcript. A chat that started in another folder (a Claude desktop scratch
        # folder, say) may record its project folder only in the middle, or the tail may be one huge record with no folder at
        # all. Remember the project folder once found, and search the whole file once when neither end names it.
        found = project_match(meta.get('_cwds') or [], path) or self.project_memo.get(key)
        # Only Claude Code files transcripts under the encoded project folder; once per transcript, '' remembers no match.
        if not found and key not in self.project_memo and re.match(r'[A-Za-z]--|-', path.parent.name):
            found = project_match(scan_cwds(path), path)
            self.project_memo[key] = found or ''
        if found:
            self.project_memo[key] = meta['cwd'] = found
        elif meta.get('_cwds'):
            meta['cwd'] = project_cwd(meta, path)
        meta.pop('_cwds', None)
        if meta.get('cwd'):
            meta['projectRoot'] = meta['cwd']   # saved transcripts are filed under their project folder
        item = dict(meta, created=created, key=key, name=title or path.stem, title=title, modified=stat.st_mtime,
                    size=stat.st_size, last=last, hasMessages=last is not None)
        self.summary_cache[key] = (sig, item)
        return item

    def sessions(self):
        result = []
        if self.root.is_dir():
            for folder in self.root.iterdir():
                if folder.is_dir() and folder.resolve().is_relative_to(self.root):
                    for path in folder.glob('*.jsonl'):
                        try:
                            item = dict(self.summary(path))
                            artifact_dir = path.with_suffix('')
                            item['subagentCount'] = sum(1 for child in artifact_dir.rglob('*.jsonl') if child.is_file()) if artifact_dir.is_dir() else 0
                            result.append(item)
                        except (OSError, ValueError):
                            continue
        return sorted(result, key=lambda s: (s['hasMessages'], s['modified']), reverse=True)

    @staticmethod
    def sidecar(agent_path):
        """Claude Code writes agent-<id>.meta.json next to a subagent transcript: description, agentType, finished."""
        try:
            side = agent_path.with_name(agent_path.stem + '.meta.json')
            if side.is_file() and side.stat().st_size <= 65536:
                data = json.loads(side.read_text(encoding='utf-8'))
                return data if isinstance(data, dict) else {}
        except (OSError, ValueError, UnicodeError):
            pass
        return {}

    def subagent_hints(self, path):
        """Bounded read of a subagent transcript: its first prompt (Claude marks every row isSidechain, so the main-chat rule
        cannot be reused), whether it ended with an error, and whether the last assistant turn reached a natural stop."""
        try:
            stat = path.stat()
            sig = (stat.st_size, stat.st_mtime_ns)
            cached = self.hint_cache.get(path)
            if cached and cached[0] == sig:
                return cached[1]
            with path.open('rb') as f:
                head = f.read(262144)
                f.seek(max(0, stat.st_size - 65536))
                tail = f.read()
        except OSError:
            return {'firstPrompt': '', 'failed': False, 'completed': False}
        prompt = ''
        for line in head.splitlines()[:80]:
            if len(line) > 65536:
                continue
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(row, dict):
                continue
            msg = row.get('message') if isinstance(row.get('message'), dict) else {}
            if row.get('type') in ('user', 'message') and msg.get('role') == 'user' and not row.get('isMeta'):
                prompt = clean_prompt(content_text(msg.get('content', '')))
                if prompt:
                    break
        failed = completed = False
        for line in reversed(tail.splitlines()):
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(row, dict) or row.get('type') not in ('user', 'assistant', 'message'):
                continue
            msg = row.get('message') if isinstance(row.get('message'), dict) else {}
            if msg.get('role') == 'user':
                break  # the subagent was still being fed work; no end marker yet
            failed = bool(row.get('isApiErrorMessage') or row.get('error'))
            completed = failed or msg.get('stop_reason') in ('end_turn', 'stop_sequence', 'max_tokens')
            break
        hints = {'firstPrompt': prompt[:300], 'failed': failed, 'completed': completed}
        if len(self.hint_cache) > 2000:
            self.hint_cache.clear()
        self.hint_cache[path] = (sig, hints)
        return hints

    def agents(self, session_key):
        path = self.resolve(session_key)
        folder = path.with_suffix('')
        paths = [path]
        if folder.is_dir() and folder.resolve().is_relative_to(self.root):
            paths += list(folder.rglob('*.jsonl'))
        result = []
        for agent in paths:
            try:
                item = dict(self.summary(agent))
                item['active'] = time.time() - item['modified'] < 90
                item['name'] = 'Main conversation' if agent == path else agent.stem.removeprefix('agent-')
                item['source'] = 'saved'
                if agent != path:
                    side = self.sidecar(agent)
                    described = side.get('description') if isinstance(side.get('description'), str) else ''
                    item['description'] = (described or item.get('task') or '').strip()[:300]
                    item['agentType'] = side.get('agentType') if isinstance(side.get('agentType'), str) else ''
                    item['finished'] = side['finished'] if isinstance(side.get('finished'), bool) else None
                    item['agentId'] = item['name']
                    for field in ('parentAgentId', 'toolUseId'):
                        value = side.get(field)
                        item[field] = value.strip()[:120] if isinstance(value, str) else ''
                    extra = self.subagent_hints(agent)
                    item['firstPrompt'] = extra['firstPrompt']
                    item['failed'] = extra['failed'] or str(side.get('status') or side.get('state') or '').lower() in ('failed', 'error', 'errored')
                    item['completedMarker'] = extra['completed']
                    item['result'] = ((item.get('last') or {}).get('text') or '').strip()[:200]
                    if described.strip():
                        item['name'] = described.strip().splitlines()[0][:120]
                    elif extra['firstPrompt']:
                        item['name'] = extra['firstPrompt'].splitlines()[0][:120]
                item['main'] = agent == path
                item['depth'] = 0 if agent == path else len(agent.relative_to(folder).parts)
                result.append(item)
            except (OSError, ValueError):
                continue
        return sorted(result, key=lambda a: (not a['active'], -a['created'], a['key']))


class Catalog:
    """Keep independent source roots and prefix keys to prevent collisions."""
    def __init__(self, omp_root, claude_root):
        self.stores = {}
        if omp_root is not None:
            self.stores['omp'] = Store(pathlib.Path(omp_root))
        if claude_root is not None:
            self.stores['claude'] = Store(pathlib.Path(claude_root))
        self.lock = threading.RLock()
        self.command_memo = {}
        self.command_locks = {}
        self.root = ' · '.join(f'{name}: {store.root}' for name, store in self.stores.items())

    def set_project_resolver(self, resolver):
        for store in self.stores.values():
            store.project_resolver = resolver

    def split(self, key):
        provider, separator, rest = key.partition('/')
        if not separator or provider not in self.stores:
            raise ValueError('Unknown transcript source')
        return provider, self.stores[provider], rest

    def decorate(self, provider, item):
        return dict(item, key=provider + '/' + item['key'], provider=provider,
                    providerName='Claude Code' if provider == 'claude' else 'OMP')

    def resolve(self, key):
        _, store, rest = self.split(key)
        return store, store.resolve(rest)

    def session_cwd(self, provider, session_id):
        """The project folder of a saved session ("" when unknown), as the chat list shows it."""
        store = self.stores.get(provider)
        path = find_session_file(provider, store.root, session_id) if store else None
        if path is None:
            return ''
        try:
            with self.lock:
                return store.summary(path).get('cwd') or ''
        except (OSError, ValueError):
            return ''

    def load(self, resolved):
        store, path = resolved
        return store.load(path)

    @contextlib.contextmanager
    def hold(self, keys):
        with contextlib.ExitStack() as stack:
            groups = {}
            for key in keys:
                provider, _, rest = self.split(key)
                groups.setdefault(provider, []).append(rest)
            for provider, rests in groups.items():
                stack.enter_context(self.stores[provider].hold(rests))
            yield

    def sessions(self):
        items = [self.decorate(provider, item) for provider, store in self.stores.items() for item in store.sessions()]
        return sorted(items, key=lambda s: (s['hasMessages'], s['modified']), reverse=True)

    def agents(self, key):
        provider, store, rest = self.split(key)
        return [self.decorate(provider, item) for item in store.agents(rest)]


# ---- the model a conversation is really running on ---------------------------------------------
# The ACP adapter's advertised "current model" can disagree with what answers (a stale alias, a gateway, a
# fallback). Every assistant record in the agent's own transcript names the model that produced it, so the
# newest one is the best evidence of what is in use. Read-only: a bounded tail read, cached by size and mtime.
MODEL_TAIL_WINDOWS = (262144, 1048576, 4194304)  # grow only when the newest records are huge (API snapshots)
SESSION_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$')
_model_cache = collections.OrderedDict()   # str(path) -> (size, mtime_ns, result)
_file_cache = {}                           # (provider, root, session id) -> (path or None, looked up at)
_model_lock = threading.Lock()


def _model_from_row(row):
    """The model named by one transcript record, or None. Claude Code: {"type":"assistant","message":{"model":...}};
    OMP: {"type":"message","message":{"role":"assistant","provider":...,"model":...}}. Synthetic ("<synthetic>")
    records and sub-agent (sidechain) records do not count."""
    message = row.get('message') if isinstance(row, dict) else None
    if not isinstance(message, dict) or row.get('isSidechain') is True:
        return None
    if (message.get('role') or row.get('type')) != 'assistant':
        return None
    model = message.get('model')
    if not isinstance(model, str):
        return None
    model = model.strip()
    if not model or len(model) > 200 or model.startswith('<') or not model.isprintable():
        return None
    found = {'model': model}
    provider = message.get('provider')
    if isinstance(provider, str) and 0 < len(provider.strip()) <= 100 and provider.isprintable():
        found['provider'] = provider.strip()
    return found


def latest_assistant_model(path):
    """{"model", "provider"?} from the newest real assistant record of a transcript file, or None. Never writes."""
    path = pathlib.Path(path)
    stat = path.stat()
    key, signature = str(path), (stat.st_size, stat.st_mtime_ns)
    with _model_lock:
        hit = _model_cache.get(key)
        if hit and hit[:2] == signature:
            _model_cache.move_to_end(key)
            return hit[2]
    found = None
    with path.open('rb') as stream:
        for window in MODEL_TAIL_WINDOWS:
            start = max(0, stat.st_size - window)
            stream.seek(start)
            lines = stream.read(stat.st_size - start).split(b'\n')
            if start > 0:
                lines = lines[1:]  # the first line is cut in the middle
            for line in reversed(lines):
                if b'"assistant"' not in line or b'"model"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeError):
                    continue  # a half-written last record, or a cut line
                found = _model_from_row(row)
                if found:
                    break
            if found or start == 0:
                break
    with _model_lock:
        _model_cache[key] = (signature[0], signature[1], found)
        while len(_model_cache) > 256:
            _model_cache.popitem(last=False)
    return found


def find_session_file(provider, root, session_id, now=None):
    """The transcript file of a session id under a provider root (Claude: <root>/<project>/<id>.jsonl; OMP:
    <root>/<project>/<timestamp>_<id>.jsonl), or None. Lookups are cached; a miss is retried after 10 seconds."""
    if not isinstance(session_id, str) or not SESSION_ID.match(session_id) or len(session_id) > 128 or root is None:
        return None
    root = pathlib.Path(root)
    now = time.time() if now is None else now
    key = (provider, str(root), session_id)
    with _model_lock:
        cached = _file_cache.get(key)
    if cached and ((cached[0] is not None and cached[0].is_file()) or (cached[0] is None and now - cached[1] < 10)):
        return cached[0]
    path = None
    try:
        base = root.resolve()
        pattern = f'{session_id}.jsonl' if provider == 'claude' else f'*_{session_id}.jsonl'
        for candidate in base.glob('*/' + pattern):
            if candidate.is_file() and candidate.resolve().is_relative_to(base):
                path = candidate
                break
    except OSError:
        path = None
    with _model_lock:
        _file_cache[key] = (path, now)
        while len(_file_cache) > 512:
            _file_cache.pop(next(iter(_file_cache)))
    return path


def model_in_use(provider, session_id, claude_root=None, omp_root=None):
    """{"model", "provider"?, "source": "transcript"} for a live conversation, or None when it cannot be known."""
    root = claude_root if provider == 'claude' else omp_root if provider == 'omp' else None
    path = find_session_file(provider, root, session_id)
    if path is None:
        return None
    try:
        found = latest_assistant_model(path)
    except OSError:
        return None
    return dict(found, source='transcript') if found else None


_memo_guard = threading.Lock()


def _family_signature(store, session):
    """(path, size, mtime) of the chat's transcript and every sub-agent transcript: what command_list's answer depends on."""
    resolved = store.resolve(session)
    base, path = resolved if isinstance(resolved, tuple) else (store, resolved)
    folder = path.with_suffix('')
    paths = [path]
    if folder.is_dir() and folder.resolve().is_relative_to(base.root):
        paths += sorted(folder.rglob('*.jsonl'))
    out = []
    for p in paths:
        try:
            st = p.stat()
        except OSError:
            continue
        out.append((str(p), st.st_size, st.st_mtime_ns))
    return tuple(out)


def command_list(store, session):
    """Background commands of a chat and its sub-agents. Built once and reused while no transcript file changed (and for at most
    COMMAND_LIST_TTL seconds, since idle times are clock based), so /api/agents and /api/commands in one poll share one pass."""
    with _memo_guard:
        lock = store.command_locks.setdefault(session, threading.Lock())
        if len(store.command_locks) > 64:
            store.command_locks.clear()
            store.command_memo.clear()
    with lock:
        signature = _family_signature(store, session)
        memo = store.command_memo.get(session)
        if memo and memo[0] == signature and time.time() - memo[1] < COMMAND_LIST_TTL:
            return list(memo[2])
        tasks = _build_command_list(store, session)
        store.command_memo[session] = (signature, time.time(), tasks)
        return list(tasks)


def _build_command_list(store, session):
    tasks = []
    now = time.time()
    agents = store.agents(session)
    with store.hold(a['key'] for a in agents):
        # Ids the main chat saw finish or stop (a background agent's task-notification, TaskStop): their own tasks ended with them.
        reported = set()
        for agent in agents:
            if agent.get('main'):
                main = store.load(store.resolve(agent['key']))
                with main.lock:
                    reported = set(main.ended_ids)
        for agent in agents:
            transcript = store.load(store.resolve(agent['key']))
            idle = max(0, now - agent.get('modified', now))
            owner_done = not agent.get('main') and bool(agent.get('finished') is True or agent.get('completedMarker') or agent.get('failed')
                                                        or agent.get('agentId') in reported or idle > QUIET_UNKNOWN_SECONDS)
            with transcript.lock:
                commands = list(transcript.commands.items())
            for call, original in commands:
                task = dict(original, id=agent['key'] + '#' + call, agent=agent['name'], agentKey=agent['key'], source='saved', inferred=True,
                            transcriptIdleSeconds=int(idle))
                if not task['background']:
                    continue
                if task['status'] in ('running', 'in-progress') and task.get('started'):
                    try:
                        age = now - datetime.fromisoformat(str(task['started']).replace('Z', '+00:00')).timestamp()
                        timeout = task.get('timeoutSeconds')
                        expiry = task.get('expirySeconds')
                        if tool_name_of(task) == 'monitor':
                            expiry = min(expiry, 86400) if isinstance(expiry, (int, float)) and expiry > 0 else 86400 if task.get('persistent') else None
                        if owner_done:
                            task['status'] = 'completed'
                            task['completionSummary'] = task.get('completionSummary') or 'Ended with the agent that started it.'
                        elif tool_name_of(task) == 'monitor' and expiry and age > expiry:
                            task['status'] = 'completed'
                            task['completionSummary'] = task.get('completionSummary') or 'Ended: its watch time ran out.'
                        elif age > 86400:
                            task['status'] = 'unknown'
                            task['completionSummary'] = task.get('completionSummary') or 'Status unknown: no completion was saved for over a day.'
                        elif age > QUIET_UNKNOWN_SECONDS and idle > QUIET_UNKNOWN_SECONDS:
                            # Nothing was saved by this agent for hours and no completion arrived: do not claim it still runs or that it ended.
                            task['status'] = 'unknown'
                            task['completionSummary'] = task.get('completionSummary') or 'Status unknown: the conversation has been quiet for hours and no completion was saved.'
                        elif isinstance(timeout, (int, float)) and timeout > 0 and age > timeout + 60:
                            # The agent said it would stop this job at its deadline; no completion record was saved.
                            task['status'] = 'unknown'
                            task['completionSummary'] = task.get('completionSummary') or 'Probably ended: its time limit passed and no completion was saved.'
                    except ValueError:
                        pass
                tasks.append(task)
    tasks.sort(key=lambda t: (t['status'] not in ('running', 'in-progress'), -(datetime.fromisoformat(str(t['started']).replace('Z', '+00:00')).timestamp() if t.get('started') else 0), t['id']))
    return tasks


def running_by_agent(store, session):
    """{agent key: number of background commands still reported running} for one conversation."""
    counts = {}
    for task in command_list(store, session):
        if task['status'] in ('running', 'in-progress'):
            counts[task['agentKey']] = counts.get(task['agentKey'], 0) + 1
    return counts


def command_output(store, session, task):
    """Read only a known Claude task output location, never a transcript-supplied path."""
    output = task.get('output', '')
    if session.startswith('claude/') and re.fullmatch(r'[A-Za-z0-9_-]+', str(task.get('jobId') or '')):
        relative = pathlib.PurePosixPath(session.split('/', 1)[1])
        if len(relative.parts) == 2:
            base = (pathlib.Path(tempfile.gettempdir()) / 'claude').resolve()
            candidate = base / relative.parts[0] / pathlib.Path(relative.parts[1]).stem / 'tasks' / (task['jobId'] + '.output')
            resolved = candidate.resolve()
            if resolved.is_relative_to(base) and resolved.is_file():
                with resolved.open('rb') as stream:
                    stream.seek(max(0, resolved.stat().st_size - 65536))
                    tail = stream.read(65536).decode('utf-8', errors='replace')
                    output = ('[Latest task output; earlier output omitted when large]\n' + tail[-(TEXT_LIMIT - 100):]) if tail else 'No task output has been written yet.'
    return clipped(output)


# Every route this server answers and the scope it needs (see security.authorize). Unknown /api/ routes are refused.
ROUTES = security.RouteTable()
ROUTES.add('GET', '/api/bootstrap', security.SCOPE_BOOTSTRAP)
ROUTES.add('GET', '/api/transcript/image', security.SCOPE_IMAGE)
for _path in ('/api/sessions', '/api/agents', '/api/commands', '/api/command', '/api/transcript', '/api/activity'):
    ROUTES.add('GET', _path, security.SCOPE_READ)
for _path in ('/', '/index.html', '/conversation.html', '/app.js', '/style.css', '/sidebar.js', '/sidebar.css'):
    ROUTES.add('GET', _path, security.SCOPE_STATIC)


def create_server(root, port, claude_root=None):
    store = Catalog(root, claude_root) if claude_root is not None else Store(pathlib.Path(root))

    class Handler(security.BodyDrainMixin, BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, body, mime='application/json; charset=utf-8'):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            allowed = security.authorize(self, ROUTES.scope_for('GET', parsed.path))
            if not allowed:
                self.respond(allowed.status, {'error': allowed.message(parsed.path)})
                return
            if parsed.path == '/api/bootstrap':   # hands the page its token (legacy pages); the gate already checked Host, Origin and Fetch Metadata
                self.respond(200, {'token': self.server.api_token_getter()})
                return
            args = urllib.parse.parse_qs(parsed.query)
            arg = lambda name, default='': args.get(name, [default])[0]
            try:
                if True:   # no store-wide lock: parsing runs outside it (Store.load), so one big chat cannot stall the others
                    if parsed.path == '/api/sessions':
                        with store.lock:
                            sessions = store.sessions()
                        self.respond(200, {'sessions': sessions, 'root': str(store.root), 'now': time.time()})
                    elif parsed.path == '/api/agents':
                        agents = store.agents(arg('session'))
                        try:
                            running = running_by_agent(store, arg('session'))
                        except (OSError, ValueError, TypeError, KeyError):
                            running = {}
                        for agent in agents:
                            agent['runningCommands'] = running.get(agent['key'], 0)
                        self.respond(200, {'agents': agents, 'now': time.time()})
                    elif parsed.path == '/api/commands':
                        commands = command_list(store, arg('session'))
                        running = sum(t['status'] in ('running', 'in-progress') for t in commands)
                        if arg('running') == '1':
                            commands = [t for t in commands if t['status'] in ('running', 'in-progress')]
                        self.respond(200, {'commands': [{k: v for k, v in task.items() if k not in ('output', 'command')} for task in commands[:200]], 'running': running, 'total': len(commands)})
                    elif parsed.path == '/api/command':
                        commands = command_list(store, arg('session'))
                        task = next((t for t in commands if t['id'] == arg('id')), None)
                        if task is None:
                            raise ValueError('Unknown background command')
                        self.respond(200, dict(task, output=command_output(store, arg('session'), task)))
                    elif parsed.path == '/api/transcript/image':
                        transcript = store.load(store.resolve(arg('key')))
                        with transcript.lock:
                            media, raw = transcript.image(int(arg('n')), int(arg('i')), int(arg('j')) if arg('j') != '' else None)
                        self.respond(200, raw, media)
                    elif parsed.path == '/api/transcript':
                        transcript = store.load(store.resolve(arg('key')))
                        with transcript.lock:
                            events = transcript.events
                            query = arg('q').casefold().strip()
                            if query:
                                events = [e for e in events if query in (e.get('text', '') + ' ' + e.get('label', '') + ' ' + e.get('intent', '')).casefold()]
                            if arg('thinking') != '1':
                                events = [e for e in events if e['kind'] != 'thinking']
                            kind = arg('kind')
                            if kind == 'tools':
                                events = [e for e in events if e['kind'] in ('tool', 'result', 'error')]
                            elif kind == 'messages':
                                events = [e for e in events if e['kind'] not in ('tool', 'result', 'error', 'thinking')]
                            elif kind == 'errors':
                                events = [e for e in events if e['kind'] == 'error']
                            limit = min(500, max(1, int(arg('limit', '120'))))
                            if arg('after') != '':
                                # Forward cursor: events after an index the client already holds.
                                start = min(len(events), max(0, int(arg('after'))))
                                end = min(len(events), start + limit)
                            else:
                                end = min(len(events), max(0, int(arg('before', str(len(events))))))
                                start = max(0, end - limit)
                            reply = {'events': events[start:end], 'total': len(events), 'before': start, 'end': end,
                                     'revision': list(transcript.signature), 'meta': dict(transcript.meta)}
                            if arg('after') == '' and not query and not kind and start > 0:
                                # What the plan card and "N running tasks" fold needs from before this page; not for display.
                                reply['context'] = transcript.plan_context(start, arg('thinking') != '1')
                        self.respond(200, reply)
                    elif parsed.path == '/api/activity':
                        events = []
                        for agent in store.agents(arg('session')):
                            if agent['main']:
                                continue
                            transcript = store.load(store.resolve(agent['key']))
                            for event in transcript.events[-20:]:
                                if event['kind'] != 'thinking':
                                    events.append(dict(event, agent=agent['name'], key=agent['key']))
                        events.sort(key=lambda e: str(e['time']))
                        self.respond(200, {'events': events[-120:]})
                    elif parsed.path in ('/', '/index.html', '/conversation.html', '/app.js', '/style.css', '/sidebar.js', '/sidebar.css'):
                        filename = 'index.html' if parsed.path == '/' else parsed.path[1:]
                        mime = mimetypes.guess_type(filename)[0] or 'text/plain'
                        self.respond(200, (HERE / filename).read_bytes(), mime + '; charset=utf-8')
                    else:
                        self.respond(404, {'error': 'Not found'})
            except (OSError, ValueError, TypeError, binascii.Error) as error:
                self.respond(400, {'error': str(error)})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.gate = security.Gate(server.server_port, lambda: server.api_token_getter())
    server.api_token = secrets.token_urlsafe(32)
    log_setup.register_secret(server.api_token)   # Studio replaces the getter with its own page token
    server.api_token_getter = lambda: server.api_token
    server.catalog = store   # Studio asks it for a saved chat's project folder
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions-dir', type=pathlib.Path, default=pathlib.Path.home() / '.omp' / 'agent' / 'sessions', help='OMP sessions folder (read-only)')
    parser.add_argument('--claude-projects-dir', type=pathlib.Path, default=pathlib.Path.home() / '.claude' / 'projects', help='Claude Code projects folder (read-only)')
    parser.add_argument('--no-claude', action='store_true', help='Show only OMP sessions')
    parser.add_argument('--port', type=int, default=8766, help='Local HTTP port (default: 8766)')
    parser.add_argument('--open', action='store_true', help='Open the viewer in the default browser')
    log_setup.add_arguments(parser)
    options = parser.parse_args()
    log_setup.setup('monitor', level=options.log_level)   # stderr only: the viewer has no state folder
    if not options.sessions_dir.is_dir() and (options.no_claude or not options.claude_projects_dir.is_dir()):
        parser.error('No OMP or Claude Code sessions folder exists at the configured paths')
    if not 0 <= options.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    try:
        server = create_server(options.sessions_dir, options.port, None if options.no_claude else options.claude_projects_dir)
    except OSError as error:
        parser.error(str(error))
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Agent Watch: {url}\nReading: {options.sessions_dir}\nPress Ctrl+C to stop.', flush=True)
    if options.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
