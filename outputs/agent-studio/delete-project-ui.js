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

  const wslOf = (path) => (root.AIBWsl && root.AIBWsl.isWsl(path) ? root.AIBWsl : null);
  // What the dialog says; pure, so the tests read the same words. A WSL project's folder is named as "Ubuntu: /home/u/app".
  function mainText(name, chats, path, disk) {
    const W = wslOf(path);
    const moved =
      chats > 0
        ? ' Its ' + plural(chats, 'chat moves', 'chats move') + ' to Recently deleted.'
        : ' It has no chats to move.';
    return (
      'Removes ' +
      name +
      ' from AIB.' +
      moved +
      (disk
        ? ''
        : W
          ? ' The folder ' + W.tooltip(path) + ' stays in ' + W.distroName(W.parse(path).key) + '.'
          : ' The folder ' + (path || '(none)') + ' stays on your disk.')
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
    xdg: 'It goes to the trash, so you can still get it back from there.',
    permanent: 'There is no trash for this folder here, so it is deleted permanently. This cannot be undone.',
  };
  function warningText(path, info) {
    const i = info || {};
    const W = wslOf(path);
    if (W) {
      // inside a distro: never a permanent delete; the folder goes to that distro's own trash (the server refuses when it has none)
      let w =
        'This moves the folder ' +
        W.tooltip(path) +
        ' and everything in it to the trash in ' +
        W.distroName(W.parse(path).key) +
        ', so you can still get it back from there.';
      if (i.worktreeOf)
        w += ' This folder is a git worktree of ' + i.worktreeOf + ': its branch and commits stay in that repository.';
      return w;
    }
    let t =
      'This deletes the folder ' + path + ' and everything in it. ' + (TRASH_WORDS[i.trash] || TRASH_WORDS.permanent);
    if (i.worktreeOf)
      t += ' This folder is a git worktree of ' + i.worktreeOf + ': its branch and commits stay in that repository.';
    return t;
  }

  // Decision 6 (build plan 1b, 5.4): what AIB made in the repo goes with the project, silently, except chat copies with work that was
  // never merged (listed, ticked) and what another AIB install made there (listed, unticked). The check's `cleanup.items` carry
  // {id, kind, own, unmerged, files, title, helper, clash}; without any, the dialog is unchanged.
  const quoted = (i) => (i.helper ? 'helper ' : '') + '"' + i.title + '"';
  function itemLabel(i) {
    const what =
      i.kind === 'stash'
        ? (i.clash ? 'Your edits kept in the stash ' : 'The stash ') + i.title
        : i.kind === 'ref'
          ? i.title
          : quoted(i) + (i.files ? ' (' + plural(i.files, 'file', 'files') + ')' : '');
    return i.own ? what : what + ' (made by another AIB install)';
  }
  function cleanupText(items) {
    const list = Array.isArray(items) ? items : [];
    const copies = list.filter((i) => i.own && i.unmerged && i.kind !== 'stash');
    const stashes = list.filter((i) => i.own && i.unmerged && i.kind === 'stash');
    const others = list.filter((i) => !i.own);
    const out = [];
    if (copies.length) {
      out.push(
        (copies.length === 1 ? '1 chat copy has' : copies.length + ' chat copies have') +
          ' work that was never merged: ' +
          copies.map((i) => quoted(i) + (i.files ? ' (' + plural(i.files, 'file', 'files') + ')' : '')).join(', ') +
          ". Removing the project deletes this work; restoring a chat from Recently deleted won't bring it back.",
      );
    }
    if (stashes.length)
      out.push(
        (stashes.length === 1 ? '1 git stash entry holds' : stashes.length + ' git stash entries hold') +
          ' your edits that AIB set aside when a merge clashed. They stay unless you tick them.',
      );
    if (others.length)
      out.push(
        'Another AIB install on this repository made ' +
          plural(others.length, 'item', 'items') +
          ' here. They stay unless you tick them.',
      );
    return out.join(' ');
  }
  // Ticked by default: this install's unmerged copies. Unticked: its kept clash stashes and anything of another install.
  const tickedByDefault = (i) => !!i.own && i.kind !== 'stash';

  let open = null;
  // o: {name, path, chats, running, check(): Promise<{exists, refusal, trash, worktreeOf, cleanup?}>,
  //     confirm({disk, expect, cleanup: {remove: [ids]}}): Promise, returnTo}. Returns {box, close}.
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
    const W0 = wslOf(o.path);
    diskRow.append(
      disk,
      el('span', W0 ? 'Move folder to trash in ' + W0.distroName(W0.parse(o.path).key) : 'Delete from disk as well'),
    );
    const note = el('p', 'Checking the folder…', 'dp-note');
    note.setAttribute('role', 'status');
    const warn = el('p', null, 'dp-warn');
    warn.hidden = true;
    const work = el('div', null, 'dp-cleanup');
    work.setAttribute('role', 'group');
    work.setAttribute('aria-label', 'Work AIB would delete');
    work.hidden = true;
    let ticks = [];
    const error = el('p', null, 'dp-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const row = el('div', null, 'cg-confirm-row dp-row');
    const no = el('button', 'Cancel', 'cg-confirm-no dp-cancel');
    // A WSL project's folder can only go to the distro's trash (never a permanent delete): the tick box says so, the button says what it does.
    const wsl = !!wslOf(o.path);
    const yes = el('button', wsl ? 'Remove from AIB' : 'Delete project', 'cg-confirm-yes cg-discard dp-ok');
    no.type = yes.type = 'button';
    row.append(no, yes);
    box.append(title, main, running, work, diskRow, note, warn, error, row);

    let info = null,
      busy = false,
      done = false;
    const draw = () => {
      const on = !!disk.checked && !disk.disabled;
      main.textContent = mainText(o.name, o.chats, o.path, on);
      warn.hidden = !on;
      warn.textContent = on ? warningText(o.path, info) : '';
      yes.textContent = on ? (wsl ? 'Remove and move folder to trash' : 'Delete project and folder') : wsl ? 'Remove from AIB' : 'Delete project';
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
    function drawCleanup(items) {
      work.textContent = '';
      ticks = [];
      work.hidden = !items.length;
      if (!items.length) return;
      work.append(el('p', cleanupText(items), 'dp-warn dp-cleanup-text'));
      const list = el('div', null, 'dp-cleanup-list');
      for (const i of items) {
        const label = el('label', null, 'dp-disk dp-cleanup-item');
        const b = d.createElement('input');
        b.type = 'checkbox';
        b.checked = tickedByDefault(i);
        label.append(b, el('span', itemLabel(i)));
        list.append(label);
        ticks.push({ id: i.id, box: b });
      }
      work.append(list);
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
      const remove = ticks.filter((t) => t.box.checked).map((t) => t.id);
      Promise.resolve(o.confirm({ disk: wantDisk, expect: wantDisk && info ? info.trash : '', cleanup: { remove } })).then(
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
        const list = [...ticks.map((t) => t.box), disk, no, yes].filter((b) => !b.disabled && !(b === disk && diskRow.hidden));
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
          drawCleanup(info.cleanup && Array.isArray(info.cleanup.items) ? info.cleanup.items : []);
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

  // The one-time cleanup's card (decision 6, build plan 1b 5.6), drawn at the top of the Inbox like its rows (workspace-ui.js
  // drawInbox): old chat copies with work that was never merged, found at the first start after the update. "Keep them" is the
  // default and never brings the card back; "Remove them" deletes exactly those copies. card: {items, text} from
  // GET /api/live/cleanup/card; answer(action) posts it and resolves when done.
  function cleanupCard(card, answer) {
    const box = el('div', null, 'ws-inbox-item ws-cleanup-card');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Old chat copies');
    const what = el('div', card.text, 'ws-inbox-what ws-cleanup-text');
    const acts = el('div', null, 'ws-inbox-acts');
    const remove = el('button', 'Remove them', 'ws-qa ws-qa-choice ws-cleanup-remove');
    const keep = el('button', 'Keep them', 'ws-qa ws-qa-choice def ws-cleanup-keep');
    remove.type = keep.type = 'button';
    remove.title = 'Delete these copies and their branches. Their chats stay readable.';
    keep.title = 'Leave them. AIB asks again only if you delete their project.';
    const error = el('div', null, 'ws-qa-note ws-cleanup-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const go = (action, b) => (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      remove.disabled = keep.disabled = true;
      if (action === 'remove') b.textContent = 'Removing…';
      error.hidden = true;
      Promise.resolve(answer(action)).catch((err) => {
        remove.disabled = keep.disabled = false;
        remove.textContent = 'Remove them';
        error.textContent = (err && err.message) || String(err);
        error.hidden = false;
      });
    };
    remove.addEventListener('click', go('remove', remove));
    keep.addEventListener('click', go('keep', keep));
    acts.append(remove, keep);
    box.append(what, acts, error);
    return box;
  }

  const api = { show, mainText, runningText, warningText, cleanupText, itemLabel, tickedByDefault, cleanupCard, isOpen: () => !!open };
  root.AgentDeleteProjectUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
