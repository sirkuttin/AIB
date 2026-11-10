(function (root) {
  'use strict';
  // Updates: the amber line ("AIB 0.1.x is ready to install. Install now / Later") and the Settings card (Check for updates, the
  // automatic-check toggle). The server (updater.py) does the checking, downloading and SHA-256 verification; nothing is installed
  // unless the person clicks "Install now". This file draws what GET /api/live/update says and sends the clicks.
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
  // The amber line for a status. later: the set of versions the person dismissed with "Later" (until the page is reopened).
  // Buttons: {id: 'install'|'when-idle'|'how'|'later'|'cancel-wait', label}.
  function banner(status, later, notice) {
    if (!status || status.state !== 'ready' || !status.available) return { show: false, text: '', buttons: [] };
    const v = status.available.version;
    if (later && later.has(v) && !status.installWhenIdle && !notice) return { show: false, text: '', buttons: [] };
    const name = 'AIB ' + v;
    if (notice && notice.kind === 'installing')
      return { show: true, text: 'Installing ' + name + '. AIB will close and open again by itself.', buttons: [] };
    if (status.installWhenIdle)
      return {
        show: true,
        text: name + ' will install when your chats finish. AIB then closes and opens again.',
        buttons: [{ id: 'cancel-wait', label: 'Cancel' }],
      };
    if (notice && notice.kind === 'busy')
      return {
        show: true,
        text:
          notice.chats +
          (notice.chats === 1 ? ' chat is' : ' chats are') +
          ' working. ' +
          name +
          ' can install when they finish.',
        buttons: [
          { id: 'when-idle', label: 'Install when chats finish' },
          { id: 'later', label: 'Later' },
        ],
      };
    if (notice && notice.kind === 'error')
      return {
        show: true,
        text: notice.text,
        buttons: [{ id: 'later', label: 'Later' }],
      };
    if (!status.inPlace)
      return {
        show: true,
        text: name + ' is downloaded and verified. ' + (status.instructions || ''),
        buttons: [{ id: 'later', label: 'Later' }],
      };
    return {
      show: true,
      text: name + ' is ready to install.',
      buttons: [
        { id: 'install', label: 'Install now' },
        { id: 'later', label: 'Later' },
      ],
    };
  }

  // The status line in the Settings card.
  function cardLine(status) {
    if (!status) return 'Loading…';
    const cur = 'You have AIB ' + status.current + '.';
    if (status.checking) return 'Checking…';
    switch (status.state) {
      case 'ready':
        return 'AIB ' + status.available.version + ' is downloaded and verified. ' + cur;
      case 'found':
        return 'AIB ' + status.available.version + ' is available; downloading it. ' + cur;
      case 'refused':
        return status.error || 'The update was refused because its checksum did not match. Nothing was installed.';
      case 'error':
        return status.error || 'Could not check for updates.';
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
    later: new Set(),
    notice: null,
    timer: null,
    bannerNode: null,
    cards: new Set(),
    saveAuto: null,
  };

  function paintBanner() {
    const n = S.bannerNode;
    if (!n) return;
    const b = banner(S.status, S.later, S.notice);
    n.hidden = !b.show;
    n.replaceChildren();
    if (!b.show) return;
    n.append(el('span', b.text));
    for (const btn of b.buttons) {
      const x = el('button', btn.label, 'update-btn');
      x.type = 'button';
      x.addEventListener('click', () => act(btn.id));
      n.append(x);
    }
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
    paintBanner();
    paintCards();
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
    return Promise.resolve(S.host.get('/api/live/update')).then(setStatus, () => schedule(POLL_MS));
  }
  function check() {
    if (!S.host) return Promise.resolve();
    S.status = Object.assign({}, S.status || {}, { checking: true });
    paint();
    return Promise.resolve(S.host.post('update/check', {})).then(setStatus, () => refresh());
  }
  function install(whenIdle) {
    return Promise.resolve(S.host.post('update/install', { whenIdle: !!whenIdle })).then(
      (res) => {
        S.notice = res && res.state === 'installing' ? { kind: 'installing' } : null;
        return refresh();
      },
      (err) => {
        const body = (err && err.body) || err || {};
        if (body.code === 'chats_working' || err.code === 'chats_working')
          S.notice = { kind: 'busy', chats: Number(body.chats || err.chats) || 1 };
        else S.notice = { kind: 'error', text: (err && err.message) || 'Could not start the install.' };
        paint();
      },
    );
  }
  function act(id) {
    if (id === 'later') {
      if (S.status && S.status.available) S.later.add(S.status.available.version);
      S.notice = null;
      paint();
    } else if (id === 'install') install(false);
    else if (id === 'when-idle') install(true);
    else if (id === 'cancel-wait')
      Promise.resolve(S.host.post('update/install', { cancelWait: true })).then(setStatus, () => refresh());
  }

  // ---- the Settings card -----------------------------------------------------------------------------------------
  // opts: {autoCheck: boolean (current setting), saveAuto(boolean)}
  function fillCard(box, opts) {
    box.replaceChildren();
    const auto = opts.autoCheck();
    const label = el('label', null, 'st-toggle'),
      cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!auto;
    cb.addEventListener('change', () => opts.saveAuto(cb.checked));
    label.append(cb, el('span', 'Automatically check for updates'));
    box.append(label, el('p', 'Checks GitHub once a day for a newer version.', 'st-note'));
    const row = el('div', null, 'st-row');
    const b = el('button', 'Check for updates');
    b.type = 'button';
    b.disabled = !!(S.status && S.status.checking);
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
        'A check asks GitHub for the newest release. A new version is downloaded and its SHA-256 is checked against the release before AIB offers it. Nothing is installed until you click Install now.',
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

  // host: {get(path), post(name, body)}; bannerNode: the amber line's element (may be null).
  function init(host, bannerNode) {
    S.host = host;
    S.bannerNode = bannerNode || doc().getElementById('updateBanner');
    schedule(FIRST_POLL_MS);
  }

  const api = { init, renderCard, refresh, check, banner, cardLine, act, _state: S };
  root.AibUpdates = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
