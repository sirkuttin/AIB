"""Worktree per chat, stage E: Merge. Lands a worktree chat's own commits on its base branch (usually main).

Runs in the web process, over whatever Studio object it has (Studio or RemoteStudio): the chat's state and the conflict prompt go
through live_state / live_call, every git step is run here. The registry record (worktrees.py) says which worktree, branch, base
branch, snapshot S and diffBase belong to the chat.

  1. refuse while the chat is busy, has queued messages, running terminals or running subagents
  2. commit what is uncommitted in the worktree ("AIB: work from chat <title>")
  3. base moved past the branch: `git merge <base>` in the worktree; conflicts go to the chat as a prompt, and Studio checks the
     answer itself (no unmerged entries, no conflict markers in the files that conflicted, base is an ancestor of HEAD)
  4. under one lock per repository: re-read base's tip (moved: back to 3), refuse on index.lock or a merge/rebase in the folder
     that has base checked out; the user's uncommitted edits there are stashed (by SHA, never popped) and re-applied after
  5. land only the chat's changes, never the user's: while the user base U is still S, the chat's commits are replayed one by one;
     once live sync moved U past S, `git merge-tree --merge-base=U <base tip> <chat HEAD>` lands exactly what the chat changed since
     U. Then fast-forward base
  6. the worktree is reset to a new U: the new tip plus whatever the user has unsaved in the project folder; the chat goes on
  The project's "sync paused" flag is held from stash to unstash (and the reset), the chat's worktree lock for the whole merge
  (both are cross-process file locks, see worktrees.py).
"""
import json
import logging
import os
import pathlib
import re
import subprocess
import tempfile
import threading
import time
import uuid

import worktrees
from worktrees import GitError, git

log = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())

MAX_ROUNDS = 6
LOCK_WAIT = 30   # seconds to wait for another process's lock on the chat's worktree or the project's sync flag
WAITING = 'Waiting for the chat to resolve conflicts'
NOTE_OP = 'worktree-note'   # internal Studio call (not a page route): posts the "Merged into ..." line in the chat
MARKER = re.compile(r'^(?:<{7}|>{7})(?: |\r?$)', re.M)
GIT_STATES = (('MERGE_HEAD', 'a merge'), ('rebase-merge', 'a rebase'), ('rebase-apply', 'a rebase'), ('CHERRY_PICK_HEAD', 'a cherry-pick'), ('REVERT_HEAD', 'a revert'))
HOOKS = {}   # tests only: name -> callable, run at fixed points ('before_lock', 'before_ff')

_LOCKS = {}
_LOCKS_GUARD = threading.Lock()
_RUNNING = set()   # chat keys with a merge running in this process


class Refused(Exception):
    """The merge did not happen; str(error) is the one line to show. `code` is a short machine word."""

    def __init__(self, message, code='refused', status=409):
        super().__init__(message)
        self.code, self.status = code, status


def _hook(name):
    function = HOOKS.get(name)
    if function:
        function()


def repo_lock(project):
    key = os.path.normcase(os.path.realpath(str(project)))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


# ---- git helpers -------------------------------------------------------------------------------------------------
def _configured(cwd):
    return all(git(['config', '--get', name], cwd, check=False).stdout.strip() for name in ('user.name', 'user.email'))


def gitc(args, cwd, **kw):
    """git that may commit: Studio's own identity only when the user has none configured."""
    return git(args, cwd, identity=not _configured(cwd), **kw)


def rev(cwd, name):
    done = git(['rev-parse', '--verify', '-q', name + '^{commit}'], cwd, check=False)
    return done.stdout.strip() if done.returncode == 0 else ''


def is_ancestor(cwd, older, newer):
    return git(['merge-base', '--is-ancestor', older, newer], cwd, check=False).returncode == 0


def git_dir(cwd):
    return pathlib.Path(git(['rev-parse', '--absolute-git-dir'], cwd).stdout.strip())


def merge_in_progress(cwd):
    return (git_dir(cwd) / 'MERGE_HEAD').exists()


def folder_state(cwd):
    """'' or why git work in this folder must wait (a lock file, a merge or rebase in progress)."""
    gd = git_dir(cwd)
    if (gd / 'index.lock').exists():
        return 'git is busy in the folder that has the base branch (index.lock exists)'
    for name, label in GIT_STATES:
        if (gd / name).exists():
            return f'{label} is in progress in the folder that has the base branch'
    return ''


def porcelain_paths(cwd):
    """Paths git status lists in `cwd` (changed, staged and untracked; both names of a rename)."""
    parts = git(['status', '--porcelain=v1', '-z', '-uall'], cwd).stdout.split('\0')
    names, index = set(), 0
    while index < len(parts):
        entry = parts[index]
        index += 1
        if len(entry) < 4:
            continue
        names.add(entry[3:])
        if entry[0] in 'RC' or entry[1] in 'RC':
            if index < len(parts) and parts[index]:
                names.add(parts[index])
            index += 1
    return names


def raw_diff(cwd, a, b):
    """{path: (new mode, new sha, status)} between two commits, no rename detection."""
    parts = git(['diff-tree', '-r', '--raw', '--no-abbrev', '-z', '--no-renames', a, b], cwd).stdout.split('\0')
    out, index = {}, 0
    while index + 1 < len(parts):
        meta = parts[index]
        if not meta.startswith(':'):
            index += 1
            continue
        fields = meta[1:].split(' ')
        out[parts[index + 1]] = (fields[1], fields[3], fields[4][:1])
        index += 2
    return out


def landing_files(wt, snapshot, head, tip):
    """What the chat adds on top of `tip`: files whose content at `head` differs from both the snapshot S and `tip`.
    A file the user's uncommitted edits put into S, and the chat never changed, equals S at head and is left out."""
    from_snapshot = raw_diff(wt, snapshot, head)
    from_tip = raw_diff(wt, tip, head)
    return {path: from_tip[path] for path in from_snapshot if path in from_tip}


def base_checkout(project, base):
    """The folder that has branch `base` checked out (the main folder, or another worktree), or None."""
    text = git(['worktree', 'list', '--porcelain'], project).stdout
    current = {}
    for line in text.splitlines() + ['']:
        if line.startswith('worktree '):
            current = {'path': line[len('worktree '):]}
        elif line.startswith('branch '):
            current['branch'] = line[len('branch '):]
        elif not line:
            if current.get('branch') == f'refs/heads/{base}':
                return current['path']
            current = {}
    return None


def _norm(path):
    return os.path.normcase(path.replace('\\', '/'))


def _plural(count, word):
    return f'{count} {word}' + ('' if count == 1 else 's')


def commit_message(title):
    title = re.sub(r'\s+', ' ', str(title or '')).strip()[:80]
    return f'AIB: work from chat {title}' if title else 'AIB: work from chat'


def state_idle_reason(state, check_busy=True, check_queue=True):
    """'' when a chat's public state says it is idle, else one line saying what it is still doing. check_busy=False is for the moment a turn
    has just ended (or is about to start) on the caller's own thread; check_queue=False ignores messages that wait for that moment too."""
    if state.get('closed'):
        return 'The chat is closed; reopen it to merge'
    if check_busy and (state.get('state') != 'ready' or state.get('busy')):
        return 'Wait for the chat to finish its turn'
    if check_queue and (state.get('queue') or {}).get('items'):
        return 'Messages are queued in this chat'
    if any(t.get('status') == 'running' for t in (state.get('clientCaps') or {}).get('terminals') or []):
        return 'A terminal of this chat is still running'
    running = re.compile(r'^(running|working|in[-_ ]progress|active|starting|queued|busy|streaming)$', re.I)
    if any(running.match(str(v.get('state') or '')) for v in (state.get('subagents') or {}).values() if isinstance(v, dict)):
        return 'A subagent of this chat is still running'
    return ''


# ---- the chat ----------------------------------------------------------------------------------------------------
class Chat:
    """What Merge needs to know about one worktree chat."""
    from_tool = False

    def __init__(self, studio, chat_id, from_tool=False):
        self.from_tool = from_tool   # the chat's own agent asked (its tool call is the turn that is running)
        if not isinstance(chat_id, str) or not chat_id:
            raise Refused('Choose a chat', 'bad_request', 400)
        try:
            state = studio.live_state(chat_id)
        except (ValueError, KeyError, RuntimeError, OSError):
            state = None
        if not isinstance(state, dict):
            raise Refused('Open the chat to merge its work', 'unknown_chat', 404)
        self.studio, self.id, self.state = studio, chat_id, state
        record = worktrees.record_for_path(getattr(studio, 'state_dir', None), state.get('cwd'))
        if not record:
            raise Refused('This chat does not work in its own worktree', 'no_worktree', 404)
        self.registry = worktrees.Registry(studio.state_dir)
        self.key = record['key']
        self.reload()

    def reload(self):
        record = self.registry.get(self.key) or {}
        if not record.get('path') or not os.path.isdir(worktrees._fs(record['path'])):
            raise Refused("This chat's workspace was removed", 'gone', 404)
        self.record = record
        self.wt, self.project, self.branch, self.base = record['path'], record['project'], record['branch'], record.get('base') or ''
        self.snapshot = record.get('snapshot') or ''
        self.user = record.get('user') or self.snapshot   # the user base U (stage G1); S while live sync has not moved it
        if not (self.base and self.snapshot):
            raise Refused('This chat has no base branch to merge into', 'no_base', 400)

    def refresh_state(self):
        try:
            state = self.studio.live_state(self.id)
        except (ValueError, KeyError, RuntimeError, OSError):
            state = None
        if isinstance(state, dict):
            self.state = state
        return self.state

    def idle_reason(self):
        """'' when the chat is idle, else one line saying what it is still doing."""
        return state_idle_reason(self.refresh_state(), check_busy=not self.from_tool)


# ---- the pieces --------------------------------------------------------------------------------------------------
def unmerged_names(folder):
    return [n for n in git(['diff', '--name-only', '--diff-filter=U', '-z'], folder).stdout.split('\0') if n]


def unmerged(wt):
    return [n for n in git(['ls-files', '-u', '-z'], wt).stdout.split('\0') if n]


def check_resolution(chat, files):
    """'' when the conflicts are resolved for real, else the line to show. Studio looks itself; the agent's word is not taken."""
    if unmerged(chat.wt):
        return WAITING
    for name in files:
        path = pathlib.Path(chat.wt) / name
        try:
            text = path.read_bytes().decode('utf-8', 'replace') if path.is_file() else ''
        except OSError:
            text = ''
        if MARKER.search(text):
            return WAITING
    if not is_ancestor(chat.wt, chat.base, 'HEAD'):
        return WAITING
    return ''


def commit_pending(chat, title):
    """Commit what is uncommitted in the worktree. Returns True when a commit was made."""
    if not git(['status', '--porcelain=v1', '-uall'], chat.wt).stdout.strip():
        return False
    if not worktrees.touched_paths(chat.wt, 'HEAD'):   # only line-ending noise (core.autocrlf): the chat touched nothing
        return False
    git(['add', '-A'], chat.wt)
    if not git(['diff', '--cached', '--name-only'], chat.wt).stdout.strip():
        return False
    gitc(['commit', '-m', commit_message(title)], chat.wt)
    return True


def update_from_base(chat, tip):
    """`git merge <base>` in the worktree. Returns [] when it went through, else the files that conflict."""
    done = gitc(['merge', '--no-ff', '--no-edit', chat.base], chat.wt, check=False)
    if done.returncode == 0:
        return []
    if merge_in_progress(chat.wt):
        files = [n for n in git(['diff', '--name-only', '--diff-filter=U', '-z'], chat.wt).stdout.split('\0') if n]
        return files or ['(see git status)']
    detail = (done.stderr or done.stdout).strip().splitlines()
    raise Refused('Could not bring ' + chat.base + ' into the chat: ' + (detail[0][:160] if detail else 'git failed'), 'update_failed')


def conflict_line(chat, files):
    shown = ', '.join(files[:12]) + (' and more' if len(files) > 12 else '')
    return (f'Bringing {chat.base} into this branch left merge conflicts in: {shown}. Resolve them: keep what both sides intended and remove every '
            f'conflict marker (<<<<<<<, =======, >>>>>>>). Then stage the files and commit to finish the merge (git commit --no-edit). '
            f'Do not abort the merge and do not change anything else.')


def ask_chat_to_resolve(chat, files):
    text = conflict_line(chat, files)
    status, payload = chat.studio.live_call('prompt', {'id': chat.id, 'text': text, 'clientMessageId': 'merge-' + uuid.uuid4().hex})
    if status != 200:
        raise Refused('Could not ask the chat to resolve the conflicts: ' + str((payload or {}).get('error', 'it did not accept the message'))[:160], 'prompt_failed')


def _squash(chat, tip, files, title):
    """One commit on `tip` with the chat's version of each landing file; no checkout, no touch to the worktree."""
    scratch = tempfile.mkdtemp(prefix='.studio-merge-', dir=str(git_dir(chat.wt)))
    env = {'GIT_INDEX_FILE': os.path.join(scratch, 'index')}
    try:
        git(['read-tree', tip], chat.wt, env=env)
        lines = []
        for path, (mode, sha, status) in files.items():
            lines.append(('0 ' + '0' * 40 if status == 'D' else f'{mode} {sha}') + '\t' + path + '\n')
        if lines:
            done = subprocess.run(['git', 'update-index', '--index-info'], cwd=chat.wt, input=''.join(lines).encode('utf-8'),
                                  capture_output=True, env=dict(os.environ, **env), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if done.returncode != 0:
                raise GitError('git update-index failed: ' + (done.stderr + done.stdout).decode('utf-8', 'replace').strip()[-600:])
        tree = git(['write-tree'], chat.wt, env=env).stdout.strip()
    finally:
        worktrees.shutil.rmtree(scratch, ignore_errors=True)
    return gitc(['commit-tree', tree, '-p', tip, '-m', commit_message(title)], chat.wt).stdout.strip()


def prepare_landing(chat, tip, head, files, title):
    """The commit to fast-forward base to, built on `tip` from the chat's own commits only. Returns (sha, number of commits).
    The chat's branch is left exactly as it was."""
    own = git(['rev-list', '--no-merges', '--reverse', '--topo-order', f'{chat.snapshot}..{head}', f'^{tip}'], chat.wt).stdout.split()
    has_merge = bool(git(['rev-list', '--merges', '--max-count=1', f'{chat.snapshot}..{head}'], chat.wt).stdout.strip())
    landed = ''
    try:
        if own and not has_merge:
            done = git(['rebase', '--onto', tip, chat.snapshot, head], chat.wt, check=False, identity=not _configured(chat.wt))
            if done.returncode == 0:
                landed = rev(chat.wt, 'HEAD')
            else:
                log.warning('Replaying the chat\'s commits failed, landing them as one commit: %s', ((done.stderr or '') + (done.stdout or '')).strip()[-600:])
                git(['rebase', '--abort'], chat.wt, check=False)
        elif own:   # base was brought into the branch: replay only the chat's commits, they are not in base
            git(['switch', '--detach', tip], chat.wt)
            if gitc(['cherry-pick', *own], chat.wt, check=False).returncode == 0:
                landed = rev(chat.wt, 'HEAD')
            else:
                git(['cherry-pick', '--abort'], chat.wt, check=False)
    finally:
        if git(['symbolic-ref', '-q', 'HEAD'], chat.wt, check=False).stdout.strip() != f'refs/heads/{chat.branch}':
            git(['switch', chat.branch], chat.wt)
    if landed and not raw_diff(chat.wt, tip, landed):
        landed = ''
    if not landed:   # a replay that conflicts (or a resolved merge): the same result as one commit
        landed = _squash(chat, tip, files, title)
        return landed, max(1, len(own))
    return landed, len(own)


def fast_forward(chat, folder, tip, landed):
    if folder:
        done = git(['merge', '--ff-only', landed], folder, check=False)
        if done.returncode != 0:
            raise Refused(f'Could not fast-forward {chat.base}: it changed or a local edit is in the way. Nothing was merged', 'ff_failed')
    else:
        done = git(['update-ref', f'refs/heads/{chat.base}', landed, tip], chat.project, check=False)
        if done.returncode != 0:
            raise Refused(f'{chat.base} changed while merging. Nothing was merged', 'ff_failed')


def rebuild_user_base(chat, tip, folder, clash):
    """The new user base after a merge: a snapshot of the project folder on the new tip (so it carries what the user has unsaved),
    or the tip itself when the folder is clean, does not hold the base branch, or the user's edits clashed (they are in the stash)."""
    if clash or not folder or not worktrees._same(folder, chat.project):
        return tip
    scratch = tempfile.mkdtemp(prefix='.studio-user-', dir=str(git_dir(chat.project)))
    try:
        snap = worktrees.snapshot_commit(chat.project, scratch)
    finally:
        worktrees.shutil.rmtree(scratch, ignore_errors=True)
    same = git(['rev-parse', snap + '^{tree}'], chat.project).stdout.strip() == git(['rev-parse', tip + '^{tree}'], chat.project).stdout.strip()
    return tip if same else snap


def reset_to(chat, tip, folder=None, clash=False):
    """After a merge: the worktree branch (only this chat's own) is checked out at a new user base U, built from the new tip plus the
    project folder's current unsaved edits, so the chat keeps seeing the user's work. S becomes the tip; diffBase is U."""
    root = os.path.normcase(os.path.realpath(str(chat.registry.root)))
    here = os.path.normcase(os.path.realpath(chat.wt))
    if not here.startswith(root + os.sep) or git(['symbolic-ref', '-q', 'HEAD'], chat.wt, check=False).stdout.strip() != f'refs/heads/{chat.branch}':
        raise Refused('The chat\'s worktree is not where AIB left it; it was not reset', 'reset_refused')
    user = rebuild_user_base(chat, tip, folder, clash)
    git(['reset', '--hard', user], chat.wt)
    worktrees.pin_user_base(chat.project, chat.record, user)
    chat.registry.update(chat.key, snapshot=tip, user=user, diffBase=user, userHead=rev(chat.project, 'HEAD'), mergeConflicts=[],
                         pendingSync=[], syncConflicts=[], syncMerged={}, syncKept={}, syncNotes=[],
                         turnUser=user if (chat.registry.get(chat.key) or {}).get('turnUser') else '', turnSynced=[])   # the worktree is U again: nothing left to merge


# ---- the whole thing ---------------------------------------------------------------------------------------------
def merge(studio, chat_id, title='', from_tool=False):
    """Merge a worktree chat into its base branch. Returns a dict {'ok': True, 'state': 'merged'|'conflicts', 'message', ...};
    raises Refused with the one line to show."""
    chat = Chat(studio, chat_id, from_tool)
    with _LOCKS_GUARD:
        if chat.key in _RUNNING:
            raise Refused('A merge of this chat is already running', 'running')
        _RUNNING.add(chat.key)
    lock = worktrees.worktree_lock(chat.studio.state_dir, chat.record, LOCK_WAIT)
    try:
        try:
            lock.acquire()
        except OSError:
            raise Refused("AIB is busy with this chat's workspace; try Merge again", 'busy')
        try:
            return _merge(chat, title)
        finally:
            lock.release()
    except GitError as error:
        log.exception('Merge failed')
        raise Refused(str(error)[:200], 'git_failed')
    finally:
        with _LOCKS_GUARD:
            _RUNNING.discard(chat.key)


def _merge(chat, title):
    import worktree_sync   # imported here: worktree_sync imports this module
    for _ in range(MAX_ROUNDS):
        reason = chat.idle_reason()
        if reason:
            raise Refused(reason, 'busy')
        chat.reload()
        clashes = worktree_sync.settle_conflicts(chat.registry, dict(chat.record, key=chat.key))   # the chat resolved a clash with the user's edit: clear it, advance U
        if clashes:
            raise Refused(worktree_sync.clash_line(clashes), 'conflicts')
        chat.reload()
        recorded = chat.record.get('mergeConflicts') or []
        if recorded or merge_in_progress(chat.wt):
            if merge_in_progress(chat.wt) or check_resolution(chat, recorded):
                raise Refused(conflict_line(chat, recorded) if chat.from_tool else WAITING, 'conflicts')
            chat.registry.update(chat.key, mergeConflicts=[])
        commit_pending(chat, title)   # a reworked change after a tree-landing conflict may still be uncommitted
        tip = rev(chat.project, f'refs/heads/{chat.base}')
        if not tip:
            raise Refused(f'The branch {chat.base} no longer exists', 'no_base')
        if not is_ancestor(chat.wt, tip, 'HEAD'):   # base moved past the branch: bring it in while the chat is idle
            files = update_from_base(chat, tip)
            if files:
                chat.registry.update(chat.key, mergeConflicts=files)
                if chat.from_tool:   # the agent is mid-turn: the tool's answer is the instruction
                    return {'ok': True, 'state': 'conflicts', 'message': conflict_line(chat, files), 'files': files}
                ask_chat_to_resolve(chat, files)
                return {'ok': True, 'state': 'conflicts', 'message': WAITING, 'files': files}
            continue
        _hook('before_lock')
        with repo_lock(chat.project):
            if rev(chat.project, f'refs/heads/{chat.base}') != tip:
                continue   # base moved since the check above: look again
            if chat.idle_reason():
                raise Refused(chat.idle_reason(), 'busy')
            return _land(chat, tip, title)
    raise Refused(f'{chat.base} keeps changing; try Merge again', 'moving')


def stash_user_work(chat, folder):
    """Stash the uncommitted work (tracked and untracked) of the folder that has base. Returns {'sha','name'} or None when clean.
    The stash stack is shared: the entry is found again by SHA and message only, never popped."""
    if not porcelain_paths(folder):
        return None
    name = f'studio-merge-{chat.branch.split("/")[-1]}-{int(time.time())}'
    git(['stash', 'push', '-u', '-m', name], folder)
    sha = git(['rev-parse', '--verify', '-q', 'stash@{0}'], folder, check=False).stdout.strip()
    subject = git(['log', '-1', '--format=%s', 'stash@{0}'], folder, check=False).stdout.strip()
    if not sha or name not in subject:
        raise Refused('Could not set aside the uncommitted edits in ' + chat.base + '; nothing was merged', 'stash_failed')
    return {'sha': sha, 'name': name}


def drop_stash(folder, stash):
    for line in git(['stash', 'list', '--format=%H %gd'], folder, check=False).stdout.splitlines():
        found, _, ref = line.partition(' ')
        if found == stash['sha']:
            git(['stash', 'drop', ref], folder, check=False)
            return


def unstash(folder, stash):
    """Re-apply by SHA. Returns [] when it applied and that entry was dropped, else the clashing files (the entry is kept)."""
    done = git(['stash', 'apply', '--index', stash['sha']], folder, check=False)
    if done.returncode == 0:
        drop_stash(folder, stash)
        return []
    files = [n for n in git(['diff', '--name-only', '--diff-filter=U', '-z'], folder, check=False).stdout.split('\0') if n]
    return files or ['(see git status)']


def tree_conflict_line(chat, files):
    shown = ', '.join(files[:12]) + (' and more' if len(files) > 12 else '')
    return (f'Merging stopped: your changes touch the same lines the user edited in the project folder, in: {shown}. AIB will not decide '
            f'between the two. Rework your change in those files so it keeps what both sides intended, commit it, then merge again. '
            f"Do not discard the user's lines.")


def tree_landing(chat, tip, head, title):
    """User base U is past S: land exactly what the chat changed since U, by a three-way merge of the trees (U is the base, so the
    user's synced lines are common to both sides and never move). Returns ('landed', sha, count), ('empty',) or ('conflicts', files).
    Nothing is checked out; git only writes objects."""
    done = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', f'--merge-base={chat.user}', tip, head], chat.wt, check=False)
    lines = done.stdout.splitlines()
    if done.returncode == 1:
        names = []
        for name in lines[1:]:
            if not name:
                break
            names.append(name)
        return ('conflicts', names or ['(see git status)'])
    if done.returncode != 0 or not lines:
        raise GitError('git merge-tree failed: ' + (done.stderr or done.stdout).strip()[-400:])
    tree = lines[0].strip()
    if tree == git(['rev-parse', tip + '^{tree}'], chat.wt).stdout.strip():
        return ('empty',)
    own = git(['log', '--no-merges', '--reverse', '--format=%s', f'{chat.user}..{head}', f'^{tip}'], chat.wt).stdout.splitlines()
    body = 'Chat commits:\n' + '\n'.join('- ' + subject[:120] for subject in own[:30]) if own else ''
    message = [commit_message(title)] + ([body] if body else [])
    sha = gitc(['commit-tree', tree, '-p', tip, *[a for m in message for a in ('-m', m)]], chat.wt).stdout.strip()
    return ('landed', sha, max(1, len(own)))


def _land(chat, tip, title):
    folder = base_checkout(chat.project, chat.base)
    if folder:
        why = folder_state(folder)
        if why:
            raise Refused(why[0].upper() + why[1:], 'locked')
    head = rev(chat.wt, 'HEAD')
    by_tree = chat.user != chat.snapshot
    files, landed, count = None, '', 0
    if by_tree:
        built = tree_landing(chat, tip, head, title)
        if built[0] == 'conflicts':
            line = tree_conflict_line(chat, built[1])
            chat.registry.update(chat.key, mergeConflicts=built[1])   # as the base-merge path: live sync waits for the fix
            if chat.from_tool:   # the agent is mid-turn: the tool's answer is the instruction
                return {'ok': True, 'state': 'conflicts', 'message': line, 'files': built[1]}
            code, payload = chat.studio.live_call('prompt', {'id': chat.id, 'text': line, 'clientMessageId': 'merge-' + uuid.uuid4().hex})
            if code != 200:
                raise Refused('Could not ask the chat to rework its change: ' + str((payload or {}).get('error', 'it did not accept the message'))[:160], 'prompt_failed')
            return {'ok': True, 'state': 'conflicts', 'message': WAITING, 'files': built[1]}
        if built[0] == 'empty':
            raise Refused(f'Nothing to merge into {chat.base}', 'empty')
        _, landed, count = built
    else:
        files = landing_files(chat.wt, chat.snapshot, head, tip)
        if not files:
            raise Refused(f'Nothing to merge into {chat.base}', 'empty')
    pause = worktrees.pause_lock(chat.studio.state_dir, chat.project, LOCK_WAIT)
    try:
        pause.acquire()   # "sync paused": nothing copies the user's edits into a worktree while the project folder is being changed
    except OSError:
        raise Refused('AIB is still copying edits for this project; try Merge again', 'busy')
    try:
        stash = stash_user_work(chat, folder) if folder else None
        try:
            if not by_tree:
                landed, count = prepare_landing(chat, tip, head, files, title)
            _hook('before_ff')
            fast_forward(chat, folder, tip, landed)
        except BaseException:
            if stash and unstash(folder, stash):   # nothing landed: the folder ends as it started
                log.error('Could not re-apply the stash %s after a failed merge; it is kept', stash['name'])
            raise
        clash = unstash(folder, stash) if stash else []
        reset_to(chat, landed, folder, bool(clash))
    finally:
        pause.release()
    message = f'Merged into {chat.base} ({_plural(count, "commit")})'
    out = {'ok': True, 'state': 'merged', 'message': message, 'commits': count, 'base': chat.base, 'tip': landed,
           'clash': clash, 'stash': stash['name'] if clash else ''}
    notes = [{'message': message}]
    if clash:
        can_edit = can_edit_project(chat.state)
        record_clash(chat, folder, clash, stash)
        notes.append({'message': clash_note(clash, stash['name']), 'actions': clash_actions()})
        out['guidance'] = clash_guidance(chat, clash, stash['name'], can_edit)
    for item in notes:
        try:
            chat.studio.live_call(NOTE_OP, dict(item, id=chat.id))
        except Exception:
            log.exception('Could not post the merge note')
    if clash and not chat.from_tool:   # the chat is idle: tell it, so it explains and offers to combine
        try:
            chat.studio.live_call('prompt', {'id': chat.id, 'text': out['guidance'], 'clientMessageId': 'merge-clash-' + uuid.uuid4().hex})
        except Exception:
            log.exception('Could not tell the chat about the clash')
    return out


# ---- when re-applying the user's edits clashes (stage E2) ---------------------------------------------------------
CLASH_FILE = 'worktree-clashes.json'
KEEP_MINE, LEAVE, CHECK = 'keep-mine', 'leave', 'check'
_CLASH_LOCK = threading.RLock()


def can_edit_project(state):
    """Whether this chat's agent may write in the project folder (outside its own worktree). Codex chats may not."""
    provider = str((state or {}).get('provider') or '').lower()
    return 'codex' not in provider


def clash_actions():
    return [{'id': KEEP_MINE, 'label': 'Keep my version'}, {'id': LEAVE, 'label': "I'll sort it myself"}]


def clash_note(files, stash_name):
    shown = ', '.join(files[:6]) + (' and more' if len(files) > 6 else '')
    return f'Your edits clash with the merge in: {shown}. They are saved in the stash named {stash_name}'


def clash_guidance(chat, files, stash_name, can_edit):
    shown = ', '.join(files[:12]) + (' and more' if len(files) > 12 else '')
    text = (f'AIB merged this chat into {chat.base}, but the user also had unsaved edits in the project folder, and they clash with the merge in: {shown}. '
            f"The user's edits are safe: they are saved in the git stash named {stash_name}. Explain this to the user in plain words, naming the files. ")
    if can_edit:
        text += (f'Offer to combine the two versions. If the user agrees, edit those files in the project folder ({chat.project}) so they keep what both sides '
                 'intended and contain no conflict markers (<<<<<<<, =======, >>>>>>>), show the user the result, then call the resolve_edit_clash tool with action "check". ')
    text += ('Otherwise the user can choose "Keep my version" (their edits win in those files; call resolve_edit_clash with action "keep_mine" only when they say so) '
             'or "I\'ll sort it myself" (change nothing; call resolve_edit_clash with action "leave" and tell them the stash name). Do not choose for them.')
    return text


def _clash_path(state_dir):
    return pathlib.Path(state_dir) / CLASH_FILE


def _clash_read(state_dir):
    status, raw = worktrees.read_json_file(_clash_path(state_dir))
    return {k: v for k, v in raw.items() if isinstance(v, dict)} if status == 'ok' and isinstance(raw, dict) else {}


def _clash_write(state_dir, items):
    path = _clash_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='.studio-clashes-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as stream:
            json.dump(items, stream, ensure_ascii=False, separators=(',', ':'))
        worktrees.replace_with_retry(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _project_key(project):
    return os.path.normcase(os.path.realpath(str(project)))


def record_clash(chat, folder, files, stash):
    with _CLASH_LOCK:
        items = _clash_read(chat.studio.state_dir)
        items[_project_key(chat.project)] = {'project': chat.project, 'folder': folder, 'base': chat.base, 'files': list(files),
                                             'stash': dict(stash), 'chat': chat.id, 'time': time.time()}
        _clash_write(chat.studio.state_dir, items)


def _clash_drop(state_dir, project):
    with _CLASH_LOCK:
        items = _clash_read(state_dir)
        if items.pop(_project_key(project), None) is not None:
            _clash_write(state_dir, items)


def _has_markers(folder, name):
    try:
        path = pathlib.Path(folder) / name
        return bool(path.is_file() and MARKER.search(path.read_bytes().decode('utf-8', 'replace')))
    except OSError:
        return False


def unresolved(state_dir, project):
    """None when the project has no clash left (the record is dropped once no conflict marker remains in the files and git has no unmerged
    entries in the folder), else {'files', 'stash', 'line', 'folder', 'record'}."""
    with _CLASH_LOCK:
        rec = _clash_read(state_dir).get(_project_key(project))
    if not rec:
        return None
    folder = rec.get('folder') or rec.get('project') or ''
    if not folder or not os.path.isdir(worktrees._fs(folder)):
        _clash_drop(state_dir, project)
        return None
    try:
        open_files = unmerged_names(folder)
    except GitError:
        open_files = []
    names = []
    for name in dict.fromkeys(open_files + [f for f in rec.get('files') or [] if f != '(see git status)']):
        if name in open_files or _has_markers(folder, name):
            names.append(name)
    if not names:
        _clash_drop(state_dir, project)
        return None
    first = names[0]
    line = f'{first} has unresolved edits. Ask the chat to fix it.' if len(names) == 1 else f'{first} and {len(names) - 1} more have unresolved edits. Ask the chat to fix it.'
    return {'files': names, 'stash': (rec.get('stash') or {}).get('name', ''), 'line': line, 'folder': folder, 'record': rec}


def clash_status(studio, project):
    """What the amber line shows for a project folder: {'unresolved': bool, 'line', 'files', 'stash'}, plus syncPaused/syncLine while live sync
    is paused for it (a storm of changes, worktree_sync.py). Read only (a finished clash is forgotten)."""
    import worktree_sync
    if not isinstance(project, str) or not project:
        return {'unresolved': False}
    found = unresolved(studio.state_dir, project)
    paused = worktree_sync.paused_status(studio.state_dir, project)
    if not found:
        return dict({'unresolved': False}, **paused)
    return dict({'unresolved': True, 'line': found['line'], 'files': found['files'], 'stash': found['stash']}, **paused)


def _stash_ref(folder, stash):
    for line in git(['stash', 'list', '--format=%H %gd'], folder, check=False).stdout.splitlines():
        found, _, ref = line.partition(' ')
        if found == stash.get('sha'):
            return ref
    return ''


def resolve_clash(studio, chat_id, action, from_tool=False):
    """What the user (a button) or the chat (a tool) can do about a clash in this chat's project:
    'keep-mine' (the user's side wins in the clashing files; the stash is dropped only when it is fully applied), 'leave' (nothing changes),
    'check' (the chat combined the files itself: Studio looks for leftover markers). Returns {'ok': True, 'message', ...}; raises Refused."""
    action = {'keep_mine': KEEP_MINE, 'keep-mine': KEEP_MINE, 'leave': LEAVE, 'check': CHECK}.get(action)
    if not action:
        raise Refused('The action must be keep_mine, leave or check', 'bad_request', 400)
    chat = Chat(studio, chat_id, from_tool)
    found = unresolved(studio.state_dir, chat.project)
    if not found:
        raise Refused('There are no unresolved edits in this project', 'no_clash', 404)
    name = found['stash']
    if action == LEAVE:
        return {'ok': True, 'message': f'Left as it is. Your edits are saved in the stash named {name}; the conflicting files are {", ".join(found["files"])}', 'stash': name}
    why = folder_state(found['folder'])
    if why:
        raise Refused(why[0].upper() + why[1:], 'locked')
    return _check_combined(chat, found) if action == CHECK else _keep_mine(chat, found)


def _keep_mine(chat, found):
    folder, stash = found['folder'], found['record'].get('stash') or {}
    name = found['stash']
    if not _stash_ref(folder, stash):
        raise Refused(f'The stash {name} is gone, so AIB cannot restore your version. Nothing was changed', 'stash_gone')
    files = list(found['files'])
    done = []
    with repo_lock(chat.project):
        for path in files:
            if git(['cat-file', '-e', f'{stash["sha"]}:{path}'], folder, check=False).returncode == 0:
                step = git(['checkout', stash['sha'], '--', path], folder, check=False)
                if step.returncode == 0:
                    git(['reset', '-q', '--', path], folder, check=False)   # leave it as an edit, not staged
            else:   # the user deleted the file
                step = git(['rm', '-q', '-f', '--', path], folder, check=False)
            if step.returncode == 0:
                done.append(path)
        fully = len(done) == len(files) and not unresolved(chat.studio.state_dir, chat.project)
        if fully:
            ref = _stash_ref(folder, stash)
            if ref:
                git(['stash', 'drop', ref], folder, check=False)
    shown = ', '.join(done) or 'none'
    message = (f'Kept your version of {shown}. The stash {name} was dropped.' if fully else
               f'Kept your version of {shown}, but not everything could be restored. The stash {name} is kept.')
    note(chat, message)
    return {'ok': True, 'message': message, 'files': done, 'stash': name, 'dropped': fully}


def _check_combined(chat, found):
    """The chat says it combined the files in the project folder. Studio looks for itself: no markers, no unmerged entries."""
    folder = found['folder']
    left = [n for n in found['files'] if _has_markers(folder, n)]
    if left:
        raise Refused('These files still have conflict markers: ' + ', '.join(left) + '. Remove them and call again', 'markers')
    open_files = set(unmerged_names(folder))
    stuck = [n for n in found['files'] if n in open_files]
    if stuck:
        git(['reset', '-q', '--', *stuck], folder, check=False)   # marks them resolved; the content stays as the chat wrote it
    still = unresolved(chat.studio.state_dir, chat.project)
    if still:
        raise Refused('Still unresolved: ' + ', '.join(still['files']), 'unresolved')
    message = f'Your edits are combined in {", ".join(found["files"])}. The stash {found["stash"]} is kept as a backup'
    note(chat, message)
    return {'ok': True, 'message': message, 'files': found['files'], 'stash': found['stash']}


def note(chat, message):
    try:
        chat.studio.live_call(NOTE_OP, {'id': chat.id, 'message': message})
    except Exception:
        log.exception('Could not post the note')


# ---- what the button shows ---------------------------------------------------------------------------------------
def status(studio, chat_id):
    """{'worktree': bool, 'enabled': bool, 'state', 'message', 'base'}: the Merge button's state for a chat. Read only."""
    try:
        chat = Chat(studio, chat_id)
    except Refused as error:
        if error.code in ('no_worktree', 'unknown_chat'):
            return {'worktree': False}
        return {'worktree': True, 'enabled': False, 'state': 'unavailable', 'message': str(error), 'base': ''}
    import worktree_sync
    out = {'worktree': True, 'base': chat.base, 'label': f'Merge into {chat.base}'}
    try:
        if chat.key in _RUNNING:
            return dict(out, enabled=False, state='merging', message='Merging…')
        recorded = chat.record.get('mergeConflicts') or []
        if merge_in_progress(chat.wt) or (recorded and check_resolution(chat, recorded)):
            return dict(out, enabled=False, state='conflicts', message=WAITING, files=list(recorded))
        clashes = worktree_sync.open_clashes(chat.record)   # read only: Merge itself clears the resolved ones
        if clashes:
            return dict(out, enabled=False, state='conflicts', message=worktree_sync.clash_line(clashes), files=clashes)
        if not worktrees.touched_paths(chat.wt, chat.user):   # the chat's own work: the worktree against U, line-ending noise ignored
            return dict(out, enabled=False, state='nochanges', message='Nothing to merge yet')
        reason = chat.idle_reason()
        if reason:
            return dict(out, enabled=False, state='busy', message=reason)
        return dict(out, enabled=True, state='ready', message='')
    except GitError as error:
        return dict(out, enabled=False, state='unavailable', message=str(error)[:160])
