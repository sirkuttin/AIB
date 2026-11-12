(function (root) {
  'use strict';
  // Updates: the teal "Update" button at the top right of the window (the right end of the tab strip, right under the window's
  // own minimise / maximise / close buttons), the Settings card (Check for updates, the automatic-check toggle), and the "What's
  // new in AIB <version>" tab after an update. The server (updater.ts) does the checking, downloading and SHA-256 verification;
  // nothing is installed unless the person clicks. This file draws what GET /api/live/update says and sends the clicks.
  //   - The button shows while a verified update is ready and stays until it is installed (no "Later").
  //   - Click: install at once. Chats working that the update cannot take over: it waits for them by itself and reads "Update when
  //     chats finish"; a click then cancels the wait. A copy that cannot update itself (a .deb, a source run): the click opens a
  //     small popover in the page with the instructions. Never a pop-up dialog.
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const POLL_MS = 5 * 60 * 1000,
    FAST_POLL_MS = 2000,
    FIRST_POLL_MS = 3000;

  // ---- pure: what to show ---------------------------------------------------------------------------------------------
  // The button for a status. notice: what the last click led to ({kind: 'installing', chats} | {kind: 'error', text}), or null.
  // Returns {show, label, title, action: 'install'|'cancel-wait'|'how'|'none', disabled, waiting}.
  function button(status, notice) {
    const hide = { show: false, label: '', title: '', action: 'none', disabled: false, waiting: false };
    if (!status || status.state !== 'ready' || !status.available) return hide;
    const name = 'AIB ' + status.available.version;
    if (notice && notice.kind === 'installing')
      return {
        show: true,
        label: 'Updating…',
        title:
          'Installing ' + name + '. AIB will close and open again by itself.' + (notice.chats > 0 ? ' Your working chats keep running.' : ''),
        action: 'none',
        disabled: true,
        waiting: false,
      };
    if (status.installWhenIdle)
      return {
        show: true,
        label: 'Update when chats finish',
        title: name + ' will install when your chats finish. AIB then closes and opens again. Click to cancel the wait.',
        action: 'cancel-wait',
        disabled: false,
        waiting: true,
      };
    if (!status.inPlace)
      return {
        show: true,
        label: 'Update',
        title: name + ' is downloaded and verified. This copy of AIB cannot install it by itself: click for how.',
        action: 'how',
        disabled: false,
        waiting: false,
      };
    return {
      show: true,
      label: 'Update',
      title:
        (notice && notice.kind === 'error' ? notice.text + ' ' : '') +
        name +
        ' is ready. Click to install. AIB closes and opens again; working chats keep running.',
      action: 'install',
      disabled: false,
      waiting: false,
    };
  }

  // When something happened, for the card: "today at 14:05" or the date and time. seconds: since the epoch.
  function atTime(seconds, now) {
    if (!seconds) return '';
    const d = new Date(seconds * 1000),
      n = new Date(now || Date.now());
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === n.toDateString() ? 'today at ' + time : d.toLocaleDateString() + ' at ' + time;
  }
  // A source run (deno run, no desktop app) with no update source: updates come through the desktop app, so the card's controls
  // are off. (A source run pointed at a release page with AIB_UPDATE_REPO still checks, for testing.)
  const sourceRun = (status) => !!status && status.desktop === false && !status.configured;
  // The status line in the Settings card.
  function cardLine(status, now) {
    if (!status) return 'Loading…';
    const cur = 'You have AIB ' + status.current + '.';
    if (status.checking) return 'Checking…';
    if (sourceRun(status))
      return cur + ' This copy runs from source, so it does not update itself: updates come through the AIB desktop app.';
    switch (status.state) {
      case 'ready':
        return (
          'AIB ' +
          status.available.version +
          ' is downloaded and verified' +
          (status.installWhenIdle ? '; it installs when your chats finish. ' : '. ') +
          cur
        );
      case 'found':
        return 'AIB ' + status.available.version + ' is available; downloading it. ' + cur;
      case 'refused':
        return status.error || 'The update was refused because its checksum did not match. Nothing was installed.';
      case 'error': {
        const at = atTime(status.lastCheck, now);
        return (
          (status.error || 'Could not check for updates.') +
          (at ? ' (Tried ' + at + '.)' : '') +
          (status.retryAt && status.autoCheck ? ' AIB tries again ' + atTime(status.retryAt, now) + '.' : '')
        );
      }
      case 'unconfigured':
        return cur + ' Updates start once AIB has a public release page.';
      default:
        return status.lastCheck ? cur + ' That is the newest version.' : cur;
    }
  }

  // ---- runtime ---------------------------------------------------------------------------------------------------
  const S = {
    host: null,
    status: null,
    notice: null,
    timer: null,
    btn: null,
    pop: null, // {node, text} while the popover is open
    cards: new Set(),
    notesAsked: false,
  };

  // The button: one node, kept across redraws of the tab strip (workspace-ui.js puts it back at the strip's right end).
  function buttonNode() {
    if (S.btn) return S.btn;
    const b = el('button', 'Update', 'upd-btn');
    b.type = 'button';
    b.id = 'updateButton';
    b.hidden = true;
    b.addEventListener('click', onButton);
    S.btn = b;
    return b;
  }
  // Put the button at the end of `strip` (the tab strip at the window's top right). Called after every strip redraw.
  function attach(strip) {
    if (!strip) return;
    const b = buttonNode();
    if (b.parentNode !== strip || strip.lastChild !== b) strip.append(b);
  }
  // The strips of the page: the one whose top-right corner is nearest the window's top-right corner gets the button.
  function place(strips) {
    const list = (strips || []).filter(Boolean);
    if (!list.length) return;
    let best = list[list.length - 1];
    if (list.length > 1 && typeof best.getBoundingClientRect === 'function') {
      let score = -Infinity;
      for (const s of list) {
        const r = s.getBoundingClientRect();
        const v = r.right - r.top * 4;
        if (v > score) (score = v), (best = s);
      }
    }
    attach(best);
  }

  function paintButton() {
    const b = buttonNode();
    if (!b.parentNode) attach(doc().getElementById('chatTabs'));
    const v = button(S.status, S.notice);
    b.hidden = !v.show;
    b.textContent = v.label || 'Update';
    b.title = v.title;
    b.setAttribute('aria-label', v.title || 'Update AIB');
    b.disabled = !!v.disabled;
    b.classList.toggle('waiting', !!v.waiting);
    b.dataset.action = v.action;
    if (!v.show) closePop();
  }
  function paintCards() {
    for (const c of Array.from(S.cards)) {
      if (!c.box.isConnected) {
        S.cards.delete(c);
        continue;
      }
      fillCard(c.box, c.opts);
    }
  }
  function paint() {
    paintButton();
    paintCards();
  }

  // ---- the popover: instructions, why it waits, what went wrong (in the page, under the button) -----------------------------
  function closePop() {
    if (!S.pop) return;
    S.pop.node.remove();
    S.pop = null;
    if (S.btn) S.btn.setAttribute('aria-expanded', 'false');
  }
  function openPop(text, extra) {
    closePop();
    const b = buttonNode();
    const p = el('div', null, 'upd-pop');
    p.id = 'updatePopover';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Update');
    const x = el('button', '×', 'upd-pop-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => closePop());
    p.append(x, el('p', text, 'upd-pop-text'));
    if (extra) p.append(el('p', extra, 'upd-pop-note'));
    (doc().body || doc().documentElement).append(p);
    if (typeof b.getBoundingClientRect === 'function') {
      const r = b.getBoundingClientRect(),
        w = root.innerWidth || 0;
      p.style.top = Math.round(r.bottom + 6) + 'px';
      p.style.right = Math.max(8, Math.round(w - r.right)) + 'px';
    }
    b.setAttribute('aria-expanded', 'true');
    S.pop = { node: p, text };
  }

  function schedule(ms) {
    if (S.timer) root.clearTimeout(S.timer);
    S.timer = root.setTimeout(refresh, ms);
  }
  function setStatus(st) {
    S.status = st;
    if (st && st.state !== 'ready') S.notice = null;
    paint();
    schedule(st && st.checking ? FAST_POLL_MS : POLL_MS);
    return st;
  }
  function refresh() {
    if (!S.host) return Promise.resolve();
    if (!S.notesAsked) showNotes();
    return Promise.resolve(S.host.get('/api/live/update')).then(setStatus, () => schedule(POLL_MS));
  }
  function check() {
    if (!S.host) return Promise.resolve();
    S.status = Object.assign({}, S.status || {}, { checking: true });
    paint();
    return Promise.resolve(S.host.post('update/check', {})).then(setStatus, () => refresh());
  }
  const errBody = (err) => (err && err.body) || err || {};
  // Install now. Chats working that the update cannot take over (409 chats_working): it switches to "install when chats finish"
  // by itself and says why in the popover.
  function install() {
    closePop();
    return Promise.resolve(S.host.post('update/install', { whenIdle: false })).then(
      (res) => {
        S.notice = res && res.state === 'installing' ? { kind: 'installing', chats: Number(res.chats) || 0 } : null;
        paint();
        return refresh();
      },
      (err) => {
        const body = errBody(err);
        if (body.code === 'chats_working' || err.code === 'chats_working') {
          S.notice = null;
          const why = (err && err.message) || '';
          return Promise.resolve(S.host.post('update/install', { whenIdle: true })).then(
            () =>
              refresh().then(() =>
                openPop(
                  (why ? why + ' ' : '') + 'AIB installs the update when they finish, then closes and opens again.',
                  'Click "Update when chats finish" to cancel the wait.',
                ),
              ),
            (e2) => fail((e2 && e2.message) || 'Could not start the install.'),
          );
        }
        if (body.code === 'manual' || err.code === 'manual') {
          openPop((err && err.message) || (S.status && S.status.instructions) || 'Install it from the downloaded file.');
          return refresh();
        }
        return fail((err && err.message) || 'Could not start the install.');
      },
    );
  }
  function fail(text) {
    S.notice = { kind: 'error', text };
    paint();
    openPop(text, 'Click Update to try again.');
  }
  function cancelWait() {
    closePop();
    return Promise.resolve(S.host.post('update/install', { cancelWait: true })).then(setStatus, () => refresh());
  }
  function onButton() {
    const action = S.btn ? S.btn.dataset.action : 'none';
    if (action === 'install') return install();
    if (action === 'cancel-wait') return cancelWait();
    if (action === 'how') {
      if (S.pop) return closePop();
      const st = S.status || {};
      openPop(
        'AIB ' + ((st.available && st.available.version) || '') + ' is downloaded and verified. ' + (st.instructions || ''),
        st.available && st.available.path ? 'The file: ' + st.available.path : '',
      );
    }
    return undefined;
  }
  // Old name, kept for callers: the Settings card's Install now and the tests.
  function act(id) {
    if (id === 'install') return install();
    if (id === 'cancel-wait') return cancelWait();
    if (id === 'how') return onButton();
    return undefined;
  }

  // ---- the "What's new in AIB <version>" tab, once after an update -----------------------------------------------------------
  function showNotes() {
    S.notesAsked = true;
    if (!S.host) return Promise.resolve(false);
    return Promise.resolve(S.host.get('/api/live/update/notes'))
      .then((res) => {
        const notes = res && res.notes;
        if (!notes || !Array.isArray(notes.releases) || !notes.releases.length) return false;
        const FU = root.AgentFilesUI;
        if (!FU || !FU.openNotes || !FU.openNotes(notes)) return false;
        return Promise.resolve(S.host.post('update/notes', { shown: true })).then(
          () => true,
          () => true,
        );
      })
      .catch(() => false);
  }

  // ---- the Settings card -----------------------------------------------------------------------------------------
  // opts: {autoCheck: boolean (current setting), saveAuto(boolean)}
  function fillCard(box, opts) {
    box.replaceChildren();
    const auto = opts.autoCheck();
    const off = sourceRun(S.status);
    const label = el('label', null, 'st-toggle'),
      cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!auto;
    cb.disabled = off;
    cb.addEventListener('change', () => opts.saveAuto(cb.checked));
    label.append(cb, el('span', 'Automatically check for updates'));
    box.append(label, el('p', 'Checks GitHub once a day for a newer version.', 'st-note'));
    const row = el('div', null, 'st-row');
    const b = el('button', 'Check for updates');
    b.type = 'button';
    b.disabled = off || !!(S.status && S.status.checking);
    if (off) b.title = 'Updates come through the AIB desktop app';
    b.addEventListener('click', check);
    row.append(b);
    const st = S.status;
    if (st && st.state === 'ready' && st.inPlace && !st.installWhenIdle) {
      const i = el('button', 'Install now');
      i.type = 'button';
      i.addEventListener('click', () => act('install'));
      row.append(i);
    }
    box.append(row, el('p', cardLine(st), 'st-note'));
    if (st && st.state === 'ready' && !st.inPlace && st.instructions) box.append(el('p', st.instructions, 'st-note'));
    box.append(
      el(
        'p',
        'A check asks GitHub for the newest release. A new version is downloaded and its SHA-256 is checked against the release before AIB offers it. Nothing is installed until you click Update (top right) or Install now.',
        'st-note',
      ),
    );
  }
  function renderCard(box, opts) {
    const c = { box, opts };
    S.cards.add(c);
    fillCard(box, opts);
    if (!S.status) refresh();
  }

  // host: {get(path), post(name, body)}.
  function init(host) {
    S.host = host;
    const d = doc();
    paintButton();
    if (d && d.addEventListener) {
      d.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && S.pop) {
          closePop();
          if (S.btn && S.btn.focus) S.btn.focus();
        }
      });
      d.addEventListener('pointerdown', (e) => {
        const t = e.target;
        if (!S.pop || !t) return;
        if (S.pop.node.contains(t) || (S.btn && S.btn.contains(t))) return;
        closePop();
      });
    }
    schedule(FIRST_POLL_MS);
  }

  const api = {
    init,
    renderCard,
    refresh,
    check,
    button,
    cardLine,
    atTime,
    sourceRun,
    act,
    attach,
    place,
    showNotes,
    closePop,
    _paint: paint,
    _state: S,
  };
  root.AibUpdates = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
