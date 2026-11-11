(function (root) {
  'use strict';
  // "Delete project…" from a project's ⋯ menu: one in-page question (never window.confirm), built like the Discard question in
  // changes-ui.js (role alertdialog, Cancel focused, Escape cancels), shown over the page. By default the project only leaves AIB:
  // its running chats stop, its chats move to Recently deleted and its folder stays on disk. "Delete from disk as well" (unticked)
  // also removes the folder; the server does that, and says beforehand whether it goes to the Recycle Bin / Trash or is permanent,
  // or why it will not delete it at all. This file only draws and asks; workspace-ui.js does the work in o.confirm().
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  // What the dialog says; pure, so the tests read the same words.
  function mainText(name, chats, path, disk) {
    const moved =
      chats > 0
        ? ' Its ' + plural(chats, 'chat moves', 'chats move') + ' to Recently deleted.'
        : ' It has no chats to move.';
    return (
      'Removes ' +
      name +
      ' from AIB.' +
      moved +
      (disk ? '' : ' The folder ' + (path || '(none)') + ' stays on your disk.')
    );
  }
  function runningText(running) {
    if (!running) return '';
    return running === 1
      ? '1 chat is running and will be stopped.'
      : running + ' chats are running and will be stopped.';
  }
  const TRASH_WORDS = {
    recycle: 'It goes to the Recycle Bin, so you can still get it back from there.',
    trash: 'It goes to the Trash, so you can still get it back from there.',
    gio: 'It goes to the trash, so you can still get it back from there.',
    permanent: 'There is no trash for this folder here, so it is deleted permanently. This cannot be undone.',
  };
  function warningText(path, info) {
    const i = info || {};
    let t =
      'This deletes the folder ' + path + ' and everything in it. ' + (TRASH_WORDS[i.trash] || TRASH_WORDS.permanent);
    if (i.worktreeOf)
      t += ' This folder is a git worktree of ' + i.worktreeOf + ': its branch and commits stay in that repository.';
    return t;
  }

  let open = null;
  // o: {name, path, chats, running, check(): Promise<{exists, refusal, trash, worktreeOf}>, confirm({disk, expect}): Promise,
  //     returnTo}. Returns {box, close}.
  function show(o) {
    if (open) open.close(false);
    const d = doc();
    const scrim = el('div', null, 'dp-scrim');
    const box = el('div', null, 'dp-dialog');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'dpTitle');
    box.setAttribute('aria-describedby', 'dpMain');
    const title = el('h2', 'Delete project ' + o.name + '?', 'dp-title');
    title.id = 'dpTitle';
    const main = el('p', mainText(o.name, o.chats, o.path, false), 'dp-main');
    main.id = 'dpMain';
    const running = el('p', runningText(o.running), 'dp-running');
    running.hidden = !o.running;
    const diskRow = el('label', null, 'dp-disk');
    const disk = d.createElement('input');
    disk.type = 'checkbox';
    disk.checked = false;
    disk.disabled = true; // until the server said what a disk delete would do
    disk.id = 'dpDisk';
    diskRow.append(disk, el('span', 'Delete from disk as well'));
    const note = el('p', 'Checking the folder…', 'dp-note');
    note.setAttribute('role', 'status');
    const warn = el('p', null, 'dp-warn');
    warn.hidden = true;
    const error = el('p', null, 'dp-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const row = el('div', null, 'cg-confirm-row dp-row');
    const no = el('button', 'Cancel', 'cg-confirm-no dp-cancel');
    const yes = el('button', 'Delete project', 'cg-confirm-yes cg-discard dp-ok');
    no.type = yes.type = 'button';
    row.append(no, yes);
    box.append(title, main, running, diskRow, note, warn, error, row);

    let info = null,
      busy = false,
      done = false;
    const draw = () => {
      const on = !!disk.checked && !disk.disabled;
      main.textContent = mainText(o.name, o.chats, o.path, on);
      warn.hidden = !on;
      warn.textContent = on ? warningText(o.path, info) : '';
      yes.textContent = on ? 'Delete project and folder' : 'Delete project';
      no.disabled = yes.disabled = busy;
    };
    function close(refocus) {
      if (done) return;
      done = true;
      box.remove();
      scrim.remove();
      if (open && open.box === box) open = null;
      if (refocus !== false && o.returnTo && o.returnTo.focus && o.returnTo.isConnected !== false) o.returnTo.focus();
    }
    disk.addEventListener('change', draw);
    no.addEventListener('click', () => close());
    scrim.addEventListener('click', () => !busy && close());
    yes.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      error.hidden = true;
      draw();
      const wantDisk = !!disk.checked && !disk.disabled;
      Promise.resolve(o.confirm({ disk: wantDisk, expect: wantDisk && info ? info.trash : '' })).then(
        () => close(false),
        (e) => {
          busy = false;
          error.textContent = (e && e.message) || String(e);
          error.hidden = false;
          draw();
        },
      );
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) close();
      } else if (e.key === 'Tab') {
        // Focus stays inside the question.
        const list = [disk, no, yes].filter((b) => !b.disabled);
        const at = list.indexOf(d.activeElement);
        e.preventDefault();
        const to = list[(at + (e.shiftKey ? list.length - 1 : 1)) % list.length] || no;
        if (to.focus) to.focus();
      }
    });
    d.body.append(scrim, box);
    no.focus();
    open = { box, close };
    Promise.resolve()
      .then(() => o.check())
      .then(
        (r) => {
          if (done) return;
          info = r || {};
          if (info.exists === false) {
            note.textContent = 'The folder is not on disk any more, so only the project is removed.';
          } else if (info.refusal) {
            note.textContent = 'Deleting the folder is not possible: ' + info.refusal;
          } else {
            disk.disabled = false;
            note.textContent = '';
          }
          note.hidden = !note.textContent;
          draw();
        },
        () => {
          if (done) return;
          note.textContent = 'AIB could not check the folder, so it can only remove the project.';
          draw();
        },
      );
    return open;
  }

  const api = { show, mainText, runningText, warningText, isOpen: () => !!open };
  root.AgentDeleteProjectUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
