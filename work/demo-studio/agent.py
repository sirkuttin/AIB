"""Fake ACP agent for the demo Studio: the combined fixture plus the demo trigger words (stream, html, plan, help). No model calls.

Studio starts OMP as `<omp-command> acp`, so a leading "acp" argument is accepted and ignored.
"""
import pathlib
import runpy
import sys

if len(sys.argv) > 1 and sys.argv[1] == 'acp':
    del sys.argv[1]
if any(arg in ('-h', '--help') for arg in sys.argv[1:]):
    print(__doc__)
    sys.exit(0)
fixture = pathlib.Path(__file__).resolve().parents[1] / 'fake_acp.py'
sys.argv = [str(fixture), '--images', '--rich', '--breadth', '--subagent', '--list-sessions', '--demo']
runpy.run_path(str(fixture), run_name='__main__')
