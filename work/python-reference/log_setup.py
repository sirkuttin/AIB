"""Logging setup for the Agent Studio programs (studio.py, agent_host.py, monitor.py).

Library modules only do `log = logging.getLogger(__name__)`; nothing is configured at import, so tests and anyone
importing a module stay quiet. A program calls setup() once from main():

    log_setup.add_arguments(parser)                       # --log-level (default WARNING, env AGENT_STUDIO_LOG_LEVEL)
    log_setup.setup('studio', level=options.log_level, state_dir=options.state_dir, filename='studio.log')

Output goes to stderr and, when a file name is given, to a rotating file in the state folder. The agent host passes no
file name: its stderr already is <state>/agent-host.log, which host_client rotates (including while the host runs), so a
second handle on that file would fight the rotation. Format: time, level, module, message.

Secrets never reach a log line: every handler carries RedactFilter, which blanks values registered with
register_secret() (page token, host token, artifact keys, custom agent env values) and anything that looks like
`token=...`, `X-Studio-Token: ...`, `Authorization: Bearer ...` or a 64-hex key, in the message and in tracebacks.
"""
import logging
import logging.handlers
import os
import pathlib
import re
import sys
import threading

ENV_LEVEL = 'AGENT_STUDIO_LOG_LEVEL'
DEFAULT_LEVEL = 'WARNING'
FORMAT = '%(asctime)s %(levelname)s %(name)s: %(message)s'
FILE_MAX_BYTES = 5 * 1024 * 1024
FILE_KEEP = 2
REDACTED = '[redacted]'
_MARK = '_agent_studio_handler'

_secrets = set()
_secrets_lock = threading.Lock()
_PATTERNS = [
    # header or field named like a secret: keep the name, drop the value
    (re.compile(r'(?i)(\b[\w-]*(?:token|secret|password|passwd|api[-_]?key|artifact[-_]?key|authorization)[\w-]*["\']?\s*[:=]\s*["\']?)(?:bearer\s+)?[^\s"\',;}&]+'), r'\1' + REDACTED),
    (re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}'), 'Bearer ' + REDACTED),
    (re.compile(r'\b[0-9a-fA-F]{64}\b'), REDACTED),   # an artifact key (HMAC-SHA256 hex)
]


def register_secret(value):
    """Remember a secret value so it is blanked wherever it appears in a log line. Short values are ignored (they would mangle text)."""
    if isinstance(value, str) and len(value) >= 8:
        with _secrets_lock:
            _secrets.add(value)


def forget_secrets():
    with _secrets_lock:
        _secrets.clear()


def redact(text):
    if not isinstance(text, str) or not text:
        return text
    with _secrets_lock:
        known = sorted(_secrets, key=len, reverse=True)
    for value in known:
        if value in text:
            text = text.replace(value, REDACTED)
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactFilter(logging.Filter):
    """Rewrites the record so the formatted line, the traceback and the stack contain no known secret."""

    def filter(self, record):
        try:
            record.msg = redact(record.getMessage())
            record.args = None
            if record.exc_info and not record.exc_text:
                record.exc_text = logging.Formatter().formatException(record.exc_info)
            if record.exc_text:
                record.exc_text = redact(record.exc_text)
            if record.stack_info:
                record.stack_info = redact(record.stack_info)
        except Exception:   # logging must never raise into the caller; drop the unredacted detail instead
            record.msg, record.args, record.exc_info, record.exc_text = REDACTED, None, None, None
        return True


def parse_level(value, default=DEFAULT_LEVEL):
    """'debug', 'INFO', 10 ... -> a logging level number; anything unknown falls back to `default`."""
    if isinstance(value, int):
        return value
    name = str(value or '').strip().upper()
    if name.isdigit():
        return int(name)
    level = logging.getLevelName(name)
    return level if isinstance(level, int) else logging.getLevelName(default)


def add_arguments(parser):
    parser.add_argument('--log-level', default=os.environ.get(ENV_LEVEL) or DEFAULT_LEVEL, metavar='LEVEL',
                        help=f'Logging level: DEBUG, INFO, WARNING, ERROR (default WARNING; env {ENV_LEVEL})')


def setup(program, level=None, state_dir=None, filename=None, stream=True):
    """Configure the root logger for a program. Safe to call again: handlers from an earlier call are replaced.
    Returns the file path when a file handler was attached, else None."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, _MARK, False):
            root.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
    number = parse_level(level if level is not None else os.environ.get(ENV_LEVEL))
    root.setLevel(number)
    formatter = logging.Formatter(FORMAT)
    handlers, path = [], None
    if stream:
        handlers.append(logging.StreamHandler(sys.stderr))
    if filename and state_dir:
        try:
            folder = pathlib.Path(state_dir)
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / filename
            handlers.append(logging.handlers.RotatingFileHandler(path, maxBytes=FILE_MAX_BYTES, backupCount=FILE_KEEP, encoding='utf-8', delay=False))
        except OSError as error:   # an unwritable state folder must not stop the program; stderr still works
            path = None
            print(f'{program}: could not open the log file in {state_dir}: {error}', file=sys.stderr, flush=True)
    for handler in handlers:
        handler.setFormatter(formatter)
        handler.addFilter(RedactFilter())
        setattr(handler, _MARK, True)
        root.addHandler(handler)
    logging.getLogger(__name__).info('%s logging at %s%s', program, logging.getLevelName(number), f', file {path}' if path else '')
    return path
