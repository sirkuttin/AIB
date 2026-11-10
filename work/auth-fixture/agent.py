"""Deterministic ACP fixture: setup question, then auth required. No model calls."""
import pathlib
import runpy
import sys

here = pathlib.Path(__file__).resolve().parent
fixture = here.parent / 'fake_acp.py'
sys.argv = [str(fixture), '--setup-question', '--auth-required', '--auth-file', str(here / 'login-marker')]
runpy.run_path(str(fixture), run_name='__main__')
