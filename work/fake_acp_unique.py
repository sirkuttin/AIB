"""fake_acp.py, but every process names its session differently (two chats open at once need different session ids)."""
import os
import pathlib
import sys

source_path = pathlib.Path(__file__).resolve().parent / 'fake_acp.py'
source = source_path.read_text(encoding='utf-8').replace("'fake-session'", repr('fake-%d' % os.getpid()))
sys.argv[0] = str(source_path)
exec(compile(source, str(source_path), 'exec'), {'__name__': '__main__', '__file__': str(source_path)})
