"""Puts work/ (for _isolation) and the Python reference server (work/python-reference) on sys.path, then applies the normal test isolation."""
import pathlib
import sys

_WORK = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_WORK))
sys.path.insert(0, str(_WORK / 'python-reference'))

import _isolation  # noqa: E402,F401
