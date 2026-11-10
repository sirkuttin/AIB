"""The plain fake ACP agent (work/fake_acp.py, no feature flags) as a `claude` launcher, for work/test_worktree_e2e.py.
Every process names its session differently, so several chats can be open in one host (see fake_acp_unique.py)."""
import os
import pathlib
import sys

source_path = pathlib.Path(__file__).resolve().parent / 'fake_acp.py'
source = source_path.read_text(encoding='utf-8').replace("'fake-session'", repr('fake-%d' % os.getpid()))
sys.argv = [str(source_path)]
exec(compile(source, str(source_path), 'exec'), {'__name__': '__main__', '__file__': str(source_path)})
