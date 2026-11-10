"""Fixture agent for the file-attachments browser check. Reads files-fixture/mode.txt at start (words: images embedded audio); no model calls."""
import pathlib
import runpy
import sys

here = pathlib.Path(__file__).resolve().parent
mode = (here / 'mode.txt').read_text().split() if (here / 'mode.txt').exists() else ['images', 'embedded', 'audio']
flags = (['--images'] if 'images' in mode else []) + (['--embedded-context'] if 'embedded' in mode else []) + (['--audio'] if 'audio' in mode else [])
sys.argv = [str(here.parent / 'fake_acp.py')] + flags
runpy.run_path(sys.argv[0], run_name='__main__')
