"""Fake ACP agent in Claude Code's held-turn shape (fake_acp.py --held-turn), for the attention watcher tests. No model calls."""
import argparse, pathlib, runpy, sys
argparse.ArgumentParser(description=__doc__).parse_args()
fixture = pathlib.Path(__file__).resolve().parents[1] / 'fake_acp.py'
sys.argv = [str(fixture), '--held-turn']
runpy.run_path(str(fixture), run_name='__main__')
