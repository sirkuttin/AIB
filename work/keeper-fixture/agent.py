"""Fake ACP agent for the keeper tests: the plain fixture, cancel-aware (a 'stream:<n>:<ms>' turn streams and asks halfway). No model calls."""
import argparse, pathlib, runpy, sys
argparse.ArgumentParser(description=__doc__).parse_args()
fixture = pathlib.Path(__file__).resolve().parents[1] / 'fake_acp.py'
sys.argv = [str(fixture), '--cancel-aware']
runpy.run_path(str(fixture), run_name='__main__')
