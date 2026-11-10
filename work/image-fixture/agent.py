"""Run the deterministic ACP fixture with image capability enabled; no model calls."""
import argparse
import pathlib
import runpy
import sys

argparse.ArgumentParser(description=__doc__).parse_args()
fixture = pathlib.Path(__file__).resolve().parents[1] / 'fake_acp.py'
sys.argv = [str(fixture), '--images']
runpy.run_path(str(fixture), run_name='__main__')
