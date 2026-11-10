"""Where the app lives, for the Python reference server (work/python-reference/).

The Python server is no longer the app: it is the reference the tests compare the Deno server with. Its .py files live here
(CODE_DIR), but it serves the app's page files and reads agent_versions.json / agent_locks/ from the app folder
(APP_ROOT = outputs/agent-studio), so it serves the same page as the Deno server and reports the same codeRoot.
Code that needs one of the .py files (a child process to start) uses CODE_DIR; everything else uses APP_ROOT."""
import pathlib

CODE_DIR = pathlib.Path(__file__).resolve().parent             # work/python-reference
APP_ROOT = CODE_DIR.parent.parent / 'outputs' / 'agent-studio'   # the app folder: page files, agent_versions.json, agent_locks/


def repo_root(code_root):
    """The repository root: two levels above outputs/agent-studio."""
    return pathlib.Path(code_root).resolve().parent.parent


def tests_dir(code_root):
    """The folder with the tests and their fixtures: work/."""
    return repo_root(code_root) / 'work'


REPO_ROOT = repo_root(APP_ROOT)
TESTS_DIR = tests_dir(APP_ROOT)
