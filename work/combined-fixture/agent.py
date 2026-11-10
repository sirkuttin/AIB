"""Fake ACP agent with every fixture feature enabled, for checking the merged UI. No model calls."""
import argparse, pathlib, runpy, sys
argparse.ArgumentParser(description=__doc__).parse_args()
fixture = pathlib.Path(__file__).resolve().parents[1] / 'fake_acp.py'
sys.argv = [str(fixture), '--images', '--rich', '--breadth', '--subagent', '--list-sessions']
runpy.run_path(str(fixture), run_name='__main__')
