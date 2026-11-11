(function (root) {
  'use strict';
  // The "New project" dialog: pick or type a folder, optionally give a name, and the server checks both live. With a name the project
  // is <folder>\<name>, made inside the folder (or used when it is already there); without one it is the folder itself (made when only
  // its parent exists). Folders are only ever made by the server, one level, optional git init. A live line says what Create will do.
  // Decisions about what the hint and that line say live in workspace-state.js (hintState, smartStart); this file draws the dialog
  // and talks to /api/live/folders/*.
  const doc = () => root.document;
  const St = () => root.AgentWorkspaceState;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const DEBOUNCE = 200;

  let host = null,
    dlg = null,
    ui = null;

  // h: { getJson(path, params), postJson(name, body), projects(): [{key, path}], keyOf(path): string, done(result) }
  function init(h) {
    host = h;
  }

  function toStyle(path) {
    return /^[a-zA-Z]:/.test(path) ? String(path).replace(/\//g, '\\') : String(path);
  }

  function open(returnTo) {
    if (!host || dlg) return;
    const d = doc();
    // The starting folder comes from the server (last used parent, else home); this page adds "the parent with most projects".
    const projects = host.projects() || [];
    Promise.resolve(host.getJson('/api/live/folders/start'))
      .catch(() => ({}))
      .then((server) => {
        if (dlg) return;
        build(
          returnTo,
          St().smartStart(
            server,
            projects.map((p) => p.path),
          ),
        );
      });
  }

  function build(returnTo, startValue) {
    const d = doc();
    const dialog = d.createElement('dialog');
    dialog.className = 'np-dialog';
    dialog.setAttribute('aria-labelledby', 'npTitle');
    dialog.setAttribute('aria-describedby', 'npHint');
    const form = el('form', null, 'np-form');
    form.noValidate = true;
    const title = el('h2', 'New project');
    title.id = 'npTitle';

    const folderLabel = el('label', 'Folder');
    folderLabel.htmlFor = 'npFolder';
    const row = el('div', null, 'np-row');
    const folder = d.createElement('input');
    folder.type = 'text';
    folder.id = 'npFolder';
    folder.autocomplete = 'off';
    folder.spellcheck = false;
    folder.maxLength = 400;
    folder.setAttribute('aria-describedby', 'npHint');
    const browse = el('button', 'Browse…', 'np-browse');
    browse.type = 'button';
    browse.title = 'Choose a folder with the system folder picker';
    row.append(folder, browse);
    const hint = el('p', null, 'np-hint');
    hint.id = 'npHint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    const gitRow = el('label', null, 'np-git');
    const git = d.createElement('input');
    git.type = 'checkbox';
    git.checked = true;
    git.id = 'npGit';
    const gitText = el('span', 'Initialize a git repository');
    const gitNote = el('span', null, 'np-git-note');
    gitRow.append(git, gitText, gitNote);
    gitRow.hidden = true;

    const nameLabel = el('label', 'Project name (optional)');
    nameLabel.htmlFor = 'npName';
    const name = d.createElement('input');
    name.type = 'text';
    name.id = 'npName';
    name.autocomplete = 'off';
    name.maxLength = 60;
    name.setAttribute('aria-describedby', 'npNameNote npPreview');
    const nameNote = el(
      'p',
      'A folder with this name is made inside Folder, or used if it is already there. Leave empty to use Folder itself.',
      'np-note',
    );
    nameNote.id = 'npNameNote';
    const preview = el('p', null, 'np-preview');
    preview.id = 'npPreview';
    preview.setAttribute('role', 'status');
    preview.setAttribute('aria-live', 'polite');

    const errorLine = el('p', null, 'np-error');
    errorLine.setAttribute('role', 'alert');
    errorLine.hidden = true;
    const actions = el('div', null, 'np-actions');
    const cancel = el('button', 'Cancel', 'np-cancel');
    cancel.type = 'button';
    const primary = el('button', 'Create project', 'np-primary');
    primary.type = 'submit';
    primary.disabled = true;
    actions.append(cancel, primary);
    form.append(title, folderLabel, row, hint, nameLabel, name, nameNote, preview, gitRow, errorLine, actions);
    dialog.append(form);
    d.body.append(dialog);

    const s = {
      dialog,
      errorLine,
      folder,
      name,
      git,
      hint,
      preview,
      gitRow,
      gitNote,
      primary,
      browse,
      cancel,
      returnTo,
      check: null,
      state: St().hintState(null),
      seq: 0,
      timer: 0,
      busy: false,
      picking: false,
      restoreFocus: true,
    };
    ui = s;
    dlg = dialog;

    function paint() {
      const st = s.state;
      s.hint.textContent = st.text;
      s.hint.className = 'np-hint ' + st.tone;
      s.preview.textContent = s.waiting ? '' : st.preview || '';
      s.preview.className = 'np-preview ' + (st.previewTone || 'hint');
      s.name.setAttribute('aria-invalid', String(!s.waiting && st.previewTone === 'error'));
      s.primary.textContent = s.busy ? (st.primary === 'Open project' ? 'Opening…' : 'Creating…') : st.primary;
      s.primary.disabled = !st.canSubmit || s.busy || s.waiting;
      s.gitRow.hidden = !st.showGit;
      s.git.disabled = !st.gitEnabled || s.busy;
      s.gitNote.textContent = st.gitNote ? ' (' + st.gitNote + ')' : '';
      s.name.placeholder = (st.canSubmit && St().folderLeaf(s.folder.value)) || 'Folder name';
      s.folder.setAttribute('aria-invalid', String(!s.waiting && st.tone === 'error'));
    }
    s.paint = paint;

    function apply(check) {
      s.waiting = false;
      s.check = check;
      const known =
        check && check.path
          ? St().isKnownProject(
              host.keyOf(check.path),
              (host.projects() || []).map((p) => p.key),
            )
          : false;
      s.state = St().hintState(check, { isProject: known });
      paint();
    }
    function runCheck() {
      const value = s.folder.value,
        mine = ++s.seq;
      Promise.resolve(host.getJson('/api/live/folders/check', { path: value, name: s.name.value })).then(
        (check) => {
          if (mine === s.seq && dlg === s.dialog) apply(check);
        },
        (err) => {
          if (mine === s.seq && dlg === s.dialog) {
            s.waiting = false;
            s.state = Object.assign(St().hintState(null), {
              text: 'Could not check the folder: ' + ((err && err.message) || 'no answer'),
              tone: 'error',
            });
            paint();
          }
        },
      );
    }
    function schedule(now) {
      s.waiting = true;
      s.seq++;
      paint();
      if (s.timer) clearTimeout(s.timer);
      if (now) runCheck();
      else s.timer = setTimeout(runCheck, DEBOUNCE);
    }
    s.schedule = schedule;

    folder.addEventListener('input', () => {
      errorLine.hidden = true;
      schedule(false);
    });
    name.addEventListener('input', () => {
      errorLine.hidden = true;
      schedule(false);
    });
    browse.onclick = () => pick(s, schedule);
    cancel.onclick = () => close(s);
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(s);
    });
    dialog.addEventListener('close', () => finishClose(s));
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(s);
        return;
      }
      if (e.key !== 'Tab') return;
      const list = Array.from(dialog.querySelectorAll('input,button')).filter(
        (n) => !n.disabled && !n.hidden && !(n.closest && n.closest('[hidden]')),
      );
      if (!list.length) return;
      const first = list[0],
        last = list[list.length - 1],
        active = d.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!primary.disabled) submit(s);
    });

    folder.value = startValue || '';
    paint();
    try {
      dialog.showModal();
    } catch (e) {
      dialog.setAttribute('open', '');
    }
    folder.focus();
    try {
      folder.setSelectionRange(folder.value.length, folder.value.length);
    } catch (e) {
      /* not selectable */
    }
    schedule(true);
  }

  // Resolves {path: string|null} (null: cancelled). The desktop app has its own native dialog (its bundled Python has no tkinter); a
  // browser asks the server's tkinter picker. If the desktop dialog fails (not granted, no window), the server's picker is the fallback.
  function pickFolder(start) {
    const viaServer = () => Promise.resolve(host.postJson('folders/pick', { start }));
    const desktop = root.AibDesktop && root.AibDesktop.available() ? root.AibDesktop : null;
    if (!desktop) return viaServer();
    return desktop.pickFolder({ start, title: 'Choose a project folder' }).then(
      (path) => ({ path }),
      () => viaServer(),
    );
  }

  function pick(s, schedule) {
    if (s.picking || s.busy) return;
    s.picking = true;
    s.browse.disabled = true;
    s.browse.textContent = 'Waiting for the folder window…';
    pickFolder(s.folder.value)
      .then(
        (res) => {
          if (dlg !== s.dialog) return;
          if (res && typeof res.path === 'string' && res.path) {
            s.folder.value = toStyle(res.path).replace(/[\\/]+$/, '') || toStyle(res.path);
            schedule(true);
          }
        },
        (err) => {
          if (dlg !== s.dialog) return;
          s.state = Object.assign(St().hintState(null), {
            text: err && err.message ? err.message : 'Folder picker unavailable, type the path',
            tone: 'error',
          });
          s.waiting = false;
          s.paint();
        },
      )
      .then(() => {
        if (dlg !== s.dialog) return;
        s.picking = false;
        s.browse.disabled = false;
        s.browse.textContent = 'Browse…';
        if (doc().activeElement === doc().body || doc().activeElement === s.browse) s.folder.focus();
      });
  }

  function submit(s) {
    const check = s.check,
      st = s.state;
    if (!check || !st.canSubmit || s.busy) return;
    s.busy = true;
    s.paint();
    const typedName = St().cleanName(s.name.value);
    // check.folder: a name was given, so the project is <folder>\<name>. The server makes it (or uses it if it appeared meanwhile).
    const named = typeof check.folder === 'string' && !!check.folder && !!s.name.value.trim();
    const finish = (path, created, extra) => {
      const leaf = St().folderLeaf(path);
      s.restoreFocus = false;
      close(s);
      host.done(Object.assign({ path, name: typedName && typedName !== leaf ? typedName : '', created }, extra || {}));
    };
    const fail = (err) => {
      s.busy = false;
      s.errorLine.textContent = (err && err.message) || 'Could not finish';
      s.errorLine.hidden = false;
      s.schedule(true);
    };
    if (check.exists) {
      Promise.resolve(host.postJson('folders/remember', { path: check.path }))
        .catch(() => null)
        .then(() => finish(check.path, false));
    } else {
      const gitInit = !!(st.showGit && st.gitEnabled && s.git.checked);
      const body = named ? { path: check.folder, name: s.name.value.trim(), gitInit } : { path: check.path, gitInit };
      Promise.resolve(host.postJson('folders/create', body)).then(
        (res) => finish(res.path || check.path, !res.existed, { git: !!res.git, gitError: res.gitError || '' }),
        fail,
      );
    }
  }

  function close(s) {
    if (!s || dlg !== s.dialog) return;
    if (s.timer) clearTimeout(s.timer);
    s.seq++;
    try {
      if (s.dialog.open) s.dialog.close();
    } catch (e) {
      /* ignore */
    }
    finishClose(s);
  }
  function finishClose(s) {
    if (dlg !== s.dialog) return;
    dlg = null;
    ui = null;
    s.dialog.remove();
    if (s.restoreFocus && s.returnTo && s.returnTo.focus && s.returnTo.isConnected) s.returnTo.focus();
  }

  const api = { init, open, isOpen: () => !!dlg, _ui: () => ui, pickFolder };
  root.AgentNewProjectUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
