"""Plain-data wrappers around editors.py, folders.py and changes.py for the Deno parity tests (work/deno/editors_test.ts,
folders_test.ts, changes_test.ts). Callables (which, isfile, isdir) are described as data; errors come back with their code."""
import os

import changes
import editors
import folders


def _editor_error(error):
    return {'error': str(error), 'code': error.code, 'status': error.status}


def editors_detect(env, files, path_map, windows, platform=None, dirs=()):
    """editors.detect with a fake environment, PATH (name -> path) and file system (sets of files and folders)."""
    files = {os.path.normcase(f) for f in files}
    return editors.detect(env=env, which=lambda name: path_map.get(name), isfile=lambda p: os.path.normcase(p) in files,
                          windows=windows, platform=platform or ('win32' if windows else 'linux'), isdir=lambda p: p in set(dirs))


def editors_find(index, env, path_map, files):
    files = {os.path.normcase(f) for f in files}
    return editors._find_editor(editors.EDITOR_SPECS[index], env, lambda name: path_map.get(name), lambda p: os.path.normcase(p) in files)


def editors_build(entry, kind, path, line=None):
    try:
        return editors.build_command(entry, kind, path, line)
    except editors.EditorError as error:
        return _editor_error(error)


def editors_resolve(raw, roots, base=None, what='path'):
    try:
        return editors.resolve_inside(raw, roots, base, what)
    except editors.EditorError as error:
        return _editor_error(error)


def editors_clean(raw, what='path'):
    try:
        return editors.clean_path_text(raw, what)
    except editors.EditorError as error:
        return _editor_error(error)


def folders_validate(raw, windows=None):
    try:
        return list(folders.validate_path(raw, windows))
    except folders.FolderError as error:
        return {'error': str(error), 'code': error.code}


def changes_parse(name, text):
    """A changes.parse_* function on git output given as text (encoded as UTF-8 bytes first)."""
    return getattr(changes, name)(text.encode('utf-8'))


def changes_numstat(text):
    return {k: list(v) for k, v in changes.parse_numstat(text.encode('utf-8')).items()}


def changes_file_diff(cwd, path, base_commit=None):
    try:
        return changes.get_file_diff(cwd, path, base_commit=base_commit)
    except changes.ChangesError as error:
        return {'error': str(error), 'code': error.code}
