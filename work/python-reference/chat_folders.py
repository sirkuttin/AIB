"""Folder and branch lookups for a chat: the Changes view's folder, the artifact folder, the repository branch."""
import pathlib
import re

import changes
import security
import worktrees



def repo_branch(cwd):
    """Name of the checked-out branch of the repository holding cwd, read from HEAD (no subprocess); '' when unknown.
    A detached HEAD gives the short commit id."""
    if not cwd or security.is_network_path(cwd):   # a UNC path would make Windows authenticate to that server
        return ''
    try:
        start = pathlib.Path(str(cwd)).resolve()
        for folder in [start, *list(start.parents)[:12]]:
            marker = folder / '.git'
            if marker.is_file():
                match = re.match(r'gitdir:\s*(.+)', marker.read_text(encoding='utf-8', errors='replace').strip())
                if not match:
                    return ''
                meta = pathlib.Path(match.group(1).strip())
                meta = meta if meta.is_absolute() else folder / meta
            elif marker.is_dir():
                meta = marker
            else:
                continue
            head = (meta / 'HEAD').read_text(encoding='utf-8', errors='replace').strip()
            ref = re.match(r'ref:\s*refs/heads/(.+)$', head)
            return ref.group(1)[:80] if ref else head[:7]
    except (OSError, ValueError):
        return ''
    return ''


SAVED_CWD = None   # set by create_server: (provider, session_id) -> project folder of a saved transcript, or ''


def changes_folder(studio, ident):
    """The folder behind a chat id for the Changes view: a live connection id, or a 'provider:sessionId' conversation key.
    Only folders Studio already knows from its own connections and saved conversations qualify; nothing from the request is used as a path."""
    if not isinstance(ident, str) or not ident or len(ident) > 600:
        raise ValueError('Choose a chat')
    state = studio.live_state(ident, 10 ** 9)
    cwd = state.get('cwd') if isinstance(state, dict) else ''
    if not cwd:
        entry = (getattr(studio.conversations, 'entries', {}) or {}).get(ident) or {}
        cwd = entry.get('cwd') or ((getattr(getattr(studio, 'store', None), 'conversations', {}) or {}).get(ident) or {}).get('cwd') or ''
    lookup = getattr(studio, 'saved_cwd', None) or SAVED_CWD   # a Studio's own lookup, else the module default
    if not cwd and lookup is not None and re.match(r'^[a-z0-9_-]+:', ident):
        # A saved chat Studio only reads (not one it runs): the folder its transcript is filed under, as the chat list shows.
        provider, _, session_id = ident.partition(':')
        cwd = lookup(provider, session_id) or ''
    if not cwd or not pathlib.Path(cwd).is_dir():
        return None
    return cwd


def artifact_folder(studio, ident):
    """Project folder of a chat for artifacts (same rule as the Changes view); None when unknown."""
    try:
        return changes_folder(studio, ident)
    except ValueError:
        return None


def changes_response(studio, path, args, headers):
    """GET /api/live/changes and /api/live/changes/file: (status, payload). Needs the Studio token like a POST."""
    if not security.token_matches(headers.get('X-Studio-Token', ''), studio.token):
        return 403, {'error': 'Invalid local session token'}
    cwd = changes_folder(studio, args.get('id', [''])[0])
    if cwd is None:
        return 404, {'error': 'This chat has no known project folder.', 'code': 'unknown_folder'}
    scope = args.get('scope', ['uncommitted'])[0]
    if scope not in ('uncommitted', 'branch'):
        return 400, {'error': 'Only the uncommitted and branch scopes exist.', 'code': 'bad_scope'}
    # A chat in its own Studio worktree always gets the branch view (its agent commits); every other chat keeps the uncommitted one.
    record = worktrees.record_for_path(getattr(studio, 'state_dir', None), cwd)
    base = worktrees.diff_base(record)
    if scope == 'branch' and not base:
        return 400, {'error': 'This chat has no branch of its own.', 'code': 'bad_scope'}
    try:
        if path == '/api/live/changes/file':
            return 200, changes.get_file_diff(cwd, args.get('path', [''])[0], base_commit=base or None)
        result = changes.get_changes(cwd, base_commit=base or None)
        if record and isinstance(result, dict) and result.get('git'):
            result['worktree'] = {'branch': record.get('branch', '')}   # the page offers Discard for a chat with its own branch
        return 200, result
    except changes.ChangesError as error:
        return 400, {'error': str(error), 'code': error.code}
