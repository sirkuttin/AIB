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
  //   - A .deb install on Linux (status.password): the click answers at once ({state: 'authorizing'}) and the system asks for the
  //     password; meanwhile the button reads "Waiting for password…" and the popover says "AIB is asking for your system password
  //     to install the update." The outcome comes through the status (installError, restarting, or AIB quits and restarts). It never
  //     waits for chats by itself: Install when chats finish and a phone's Update leave "Install now" waiting here (askOnPc).
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const POLL_MS = 5 * 60 * 1000,
    FAST_POLL_MS = 2000,
    FIRST_POLL_MS = 3000,
    FEED_FOCUS_MS = 15000, // a test build's feed read on window focus: at most this often
    FEED_POLL_MS = 60 * 1000; // a test build (reads its local feed every 2 minutes): the page asks for the status this often

  // What the window says while a .deb install's system password prompt is open (the same words in the button, popover and card).
  const ASKING = 'AIB is asking for your system password to install the update.';

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
    // A .deb install (status.password): a click asks for the system password. While the system's prompt is open the button says
    // so, so the owner knows the prompt is AIB's (AIB asks only right after this click).
    if (status.authorizing || (notice && notice.kind === 'authorizing'))
      return {
        show: true,
        label: 'Waiting for password…',
        title: ASKING + ' Type it in the system’s password window. AIB closes and opens again once ' + name + ' is installed.',
        action: 'none',
        disabled: true,
        waiting: true,
      };
    if (status.restarting)
      return {
        show: true,
        label: 'Restart when chats finish',
        title: name + ' is installed. AIB closes and opens again on it when your chats finish.',
        action: 'none',
        disabled: true,
        waiting: true,
      };
    if (status.password && status.inPlace)
      return {
        show: true,
        label: status.askOnPc ? 'Install now' : 'Update',
        title:
          (notice && notice.kind === 'error' ? notice.text + ' ' : '') +
          name +
          ' is ready. Click to install: AIB asks for your system password, then closes and opens again.' +
          (status.askOnPc ? ' It waits for your click here, since only a click here may ask for the password.' : ''),
        action: 'install',
        disabled: false,
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
        if (status.authorizing) return ASKING;
        if (status.restarting) return 'AIB ' + status.available.version + ' is installed; AIB restarts on it when your chats finish.';
        if (status.installError) return status.installError;
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
      if (c.remote) fillRemoteCard(c.box);
      else fillCard(c.box, c.opts);
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
  const asking = () => !!(S.notice && S.notice.kind === 'authorizing');
  function setStatus(st) {
    // a .deb install's password step ended: what came of it (the server says; this page asked, so it shows it)
    if (asking() && st && !st.authorizing) {
      if (st.installError) {
        S.notice = { kind: 'error', text: st.installError };
        S.status = st;
        paint();
        openPop(st.installError, /dpkg --configure/.test(st.installError) ? '' : 'Click Update to try again.');
      } else if (st.restarting) {
        S.notice = null;
        S.status = st;
        paint();
        openPop(
          'AIB ' + ((st.available && st.available.version) || '') + ' is installed. A chat started working while the password window was open, so AIB closes and opens again on it when your chats finish.',
        );
      } else {
        closePop();
        S.notice = { kind: 'installing', chats: 0 };
      }
    }
    S.status = st;
    if (st && st.state !== 'ready') S.notice = null;
    paint();
    schedule(
      st && (st.checking || st.authorizing || asking() || st.restarting)
        ? FAST_POLL_MS
        : st && st.feed
          ? FEED_POLL_MS
          : POLL_MS,
    );
    return st;
  }
  function refresh() {
    if (!S.host) return Promise.resolve();
    if (!S.notesAsked) showNotes();
    return Promise.resolve(S.host.get('/api/live/update')).then(setStatus, () =>
      schedule(asking() || (S.notice && S.notice.kind === 'installing') ? FAST_POLL_MS : POLL_MS),
    );
  }
  function check() {
    if (!S.host) return Promise.resolve();
    S.status = Object.assign({}, S.status || {}, { checking: true });
    paint();
    return Promise.resolve(S.host.post('update/check', {})).then(setStatus, () => refresh());
  }
  const errBody = (err) => (err && err.body) || err || {};
  // Install now. Chats working that the update cannot take over (409 chats_working): it switches to "install when chats finish"
  // by itself and says why in the popover. A .deb install: the answer comes at once ('authorizing') and the system asks for the
  // password; the page says so and follows the status. It never switches to "install when chats finish" (no prompt nobody asked for).
  function install() {
    closePop();
    return Promise.resolve(S.host.post('update/install', { whenIdle: false })).then(
      (res) => {
        if (res && res.state === 'authorizing') {
          S.notice = { kind: 'authorizing' };
          paint();
          openPop(ASKING, 'Type it in the system’s password window. AIB asks only right after you click Install now.');
          return refresh();
        }
        S.notice = res && res.state === 'installing' ? { kind: 'installing', chats: Number(res.chats) || 0 } : null;
        paint();
        return refresh();
      },
      (err) => {
        const body = errBody(err);
        const code = body.code || err.code;
        if (code === 'password_on_pc' || (code === 'chats_working' && (body.password || err.password))) {
          S.notice = null;
          openPop((err && err.message) || 'Click Install now when you are ready.');
          return refresh();
        }
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
    if (opts.saveTestBuilds) {
      const tl = el('label', null, 'st-toggle'),
        tcb = el('input');
      tcb.type = 'checkbox';
      tcb.checked = !!opts.testBuilds();
      tcb.disabled = off;
      tcb.dataset.testBuilds = '1';
      tcb.addEventListener('change', () => opts.saveTestBuilds(tcb.checked));
      tl.append(tcb, el('span', 'Get test builds'));
      box.append(
        tl,
        el('p', "Also reads test builds from this computer's test folder (AIB-test-feed). The newest of that and GitHub is offered. Off by default.", 'st-note'),
      );
    }
    const row = el('div', null, 'st-row');
    const b = el('button', 'Check for updates');
    b.type = 'button';
    b.disabled = off || !!(S.status && S.status.checking);
    if (off) b.title = 'Updates come through the AIB desktop app';
    b.addEventListener('click', check);
    row.append(b);
    const st = S.status;
    if (st && st.state === 'ready' && st.inPlace && !st.installWhenIdle && !st.authorizing && !st.restarting) {
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
  // A paired computer's Settings card: the PC's version and Check for updates (the toggle is the PC's own setting).
  function fillRemoteCard(box) {
    box.replaceChildren();
    const up = R.update;
    const pc = rPc();
    const line = !up
      ? 'Loading…'
      : up.checking
        ? 'Checking…'
        : up.state === 'ready'
          ? 'AIB ' + up.version + ' is downloaded and verified on ' + pc + '. Use Update ready at the top right.'
          : up.error || 'AIB on ' + pc + ' is ' + up.current + '.';
    const row = el('div', null, 'st-row');
    const b = el('button', 'Check for updates');
    b.type = 'button';
    b.id = 'updateRemoteCheck';
    b.disabled = !!(up && up.checking);
    b.addEventListener('click', () => void rCheck());
    row.append(b);
    box.append(row, el('p', line, 'st-note'), el('p', 'The check runs on ' + pc + '. Updates install only after a click.', 'st-note'));
  }
  function renderCard(box, opts) {
    if (R.on) {
      const c = { box, opts, remote: true };
      S.cards.add(c);
      fillRemoteCard(box);
      return;
    }
    const c = { box, opts };
    S.cards.add(c);
    fillCard(box, opts);
    if (!S.status) refresh();
  }

  // host: {get(path), post(name, body)}.
  function init(host) {
    // another computer (remote-auth.js): the PC's update, seen and started from here (remote/update.ts); never the PC's own
    // What's new or Settings card
    if (root.AIBRemote && root.AIBRemote.kind === 'pc') return initRemote();
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
    // A test build reads its local test feed (no network) when the window gets focus too: a new test build shows up at once.
    if (root.addEventListener) root.addEventListener('focus', feedOnFocus);
    schedule(FIRST_POLL_MS);
  }
  let feedAskedAt = 0;
  function feedOnFocus() {
    if (!S.host || !S.status || !S.status.feed || S.status.checking) return;
    const now = Date.now();
    if (now - feedAskedAt < FEED_FOCUS_MS) return;
    feedAskedAt = now;
    Promise.resolve(S.host.post('update/check', { feed: true })).then(
      () => schedule(FAST_POLL_MS),
      () => {},
    );
  }

  // ---- a paired computer's page (remote-auth.js): the PC's update from here ---------------------------------------------------
  // The strip shows a calm "Update ready · <version>"; a click opens a row under it with the notes and Update, which asks first
  // in the row ("Restart AIB on <PC> to update? Chats keep running." Update / Cancel). Across the restart the strip and the offline
  // bar say "Updating AIB on <PC>…"; the page retries by itself (remote-auth.js) and, once the new AIB answers, shows
  // "Updated to <version>" and loads the new version's page. Still away after 2 minutes: "AIB hasn't come back yet on <PC>".
  const REMOTE_LATE_MS = 120000,
    REMOTE_POLL_MS = 60000,
    REMOTE_FAST_MS = 3000,
    DONE_KEY = 'aib-remote-updated';
  // Pure: what the strip and the row say. r: {phase: ''|'confirm'|'updating'|'done'|'failed', from, to, at, msg, whenIdle};
  // update: GET /api/remote/update's update; canSend: the Send switch. null: nothing to show.
  function remoteView(r, update, pcName, canSend, now) {
    const pc = pcName || 'the PC';
    if (r.phase === 'updating') {
      return now - r.at >= REMOTE_LATE_MS
        ? { kind: 'late', label: 'AIB hasn’t come back yet on ' + pc, note: 'This page keeps trying. If it stays like this, open AIB on the PC.' }
        : { kind: 'updating', label: 'Updating AIB on ' + pc + '…', note: 'Chats keep running. This page comes back by itself.' };
    }
    if (r.phase === 'done') return { kind: 'done', label: 'Updated to ' + r.to, note: '' };
    if (r.phase === 'failed') return { kind: 'failed', label: 'AIB on ' + pc + ' is back, still on ' + r.to, note: 'The update did not install.' };
    if (!update || update.state !== 'ready' || !update.version) return null;
    if (r.phase === 'confirm') return { kind: 'confirm', label: 'Update ready · ' + update.version, text: 'Restart AIB on ' + pc + ' to update? Chats keep running.', note: r.msg || '' };
    const note = r.msg
      ? r.msg
      : update.installWhenIdle
        ? 'It installs when the chats finish.'
        : !update.canInstall
          ? 'Install it on ' + pc + '.'
          : !canSend
            ? 'Updating from here needs the Send switch (AIB on ' + pc + ' → Settings → Remote control).'
            : update.password
              ? 'Installing asks for the system password on ' + pc + ', so it finishes there with Install now.'
              : '';
    return { kind: 'ready', label: 'Update ready · ' + update.version, note, go: !!(update.canInstall && canSend && !update.installWhenIdle) };
  }
  const R = { on: false, update: null, phase: '', from: '', to: '', at: 0, msg: '', whenIdle: false, open: false, notes: null, sawDown: false, timer: null };
  const remote = () => root.AIBRemote || {};
  const rPc = () => (typeof remote().pcName === 'function' ? remote().pcName() : 'the PC');
  const rCan = () => (typeof remote().can === 'function' ? !!remote().can('phone.prompt') : false);
  async function rCall(method, path, body) {
    const init = { method, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await root.fetch(path, init); // remote-auth.js adds this computer's key; offline: 503 at once
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { status: res.status, data };
  }
  function rSchedule(ms) {
    root.clearTimeout(R.timer);
    R.timer = root.setTimeout(rRefresh, ms);
  }
  async function rRefresh() {
    let r = null;
    try {
      r = await rCall('GET', '/api/remote/update');
    } catch {
      r = null;
    }
    if (r && r.status === 200 && r.data.update) {
      const up = r.data.update;
      R.update = up;
      if (R.phase === 'updating' && up.current && up.current !== R.from) {
        R.phase = 'done';
        R.to = up.current;
        if (remote().setNote) remote().setNote('');
        try {
          root.sessionStorage.setItem(DONE_KEY, JSON.stringify({ to: up.current, at: Date.now() }));
        } catch {
          /* no session storage: the line just goes with the reload */
        }
        rPaint();
        // the new version's page (its scripts match the server that answers now)
        root.setTimeout(() => (R.reload || (() => root.location.reload()))(), 3000);
        return;
      }
      if (R.phase === 'updating' && R.sawDown && up.current === R.from) {
        R.phase = 'failed';
        R.to = up.current;
        if (remote().setNote) remote().setNote('');
      }
    } else if (R.phase === 'updating') R.sawDown = true; // AIB is away (restarting)
    if (R.phase === 'updating' && remote().setNote) remote().setNote(remoteView(R, R.update, rPc(), rCan(), Date.now()).label);
    rPaint();
    rSchedule(R.phase === 'updating' ? REMOTE_FAST_MS : R.update && R.update.checking ? REMOTE_FAST_MS : REMOTE_POLL_MS);
  }
  function rPaint() {
    const b = buttonNode();
    if (!b.parentNode) attach(doc().getElementById('chatTabs'));
    const v = remoteView(R, R.update, rPc(), rCan(), Date.now());
    b.hidden = !v;
    b.dataset.action = v ? 'remote' : 'none';
    b.dataset.update = v ? v.kind : '';
    b.textContent = v ? v.label : 'Update';
    b.title = v ? v.label + (v.note ? '. ' + v.note : '') : '';
    b.setAttribute('aria-label', b.title || 'Update AIB');
    b.disabled = !!v && (v.kind === 'updating' || v.kind === 'late');
    b.classList.toggle('waiting', !!v && v.kind !== 'ready' && v.kind !== 'confirm');
    if (!v || !R.open) closePop();
    else rRow(v);
    paintCards();
  }
  // The row under the strip's line: notes, Update; the confirm; never a dialog of the browser.
  function rRow(v) {
    closePop();
    const b = buttonNode();
    const p = el('div', null, 'upd-pop upd-row');
    p.id = 'updatePopover';
    p.setAttribute('role', 'region');
    p.setAttribute('aria-label', 'Update AIB on ' + rPc());
    const x = el('button', '×', 'upd-pop-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => {
      R.open = false;
      if (R.phase === 'confirm') R.phase = '';
      rPaint();
    });
    p.append(x, el('p', v.kind === 'confirm' ? v.text : v.label, 'upd-pop-text'));
    if (v.note) p.append(el('p', v.note, 'upd-pop-note'));
    const row = el('div', null, 'upd-row-btns');
    const btn = (text, id, fn, quiet) => {
      const n = el('button', text, quiet ? 'upd-row-btn quiet' : 'upd-row-btn');
      n.type = 'button';
      n.id = id;
      n.addEventListener('click', fn);
      row.append(n);
    };
    if (v.kind === 'ready' && v.go)
      btn('Update', 'updateRemoteGo', () => {
        R.phase = 'confirm';
        R.msg = '';
        rPaint();
      });
    if (v.kind === 'confirm') {
      btn('Update', 'updateRemoteYes', () => rInstall());
      btn(
        'Cancel',
        'updateRemoteNo',
        () => {
          R.phase = '';
          R.msg = '';
          R.whenIdle = false;
          rPaint();
        },
        true,
      );
    }
    if (row.childNodes.length) p.append(row);
    if (v.kind === 'ready' || v.kind === 'confirm') {
      const notes = el('div', null, 'upd-row-notes');
      notes.id = 'updateRemoteNotes';
      if (!R.notes) notes.append(el('p', 'Loading what’s new…', 'upd-pop-note'));
      else if (!R.notes.length) notes.append(el('p', 'No notes for this version.', 'upd-pop-note'));
      for (const n of R.notes || []) notes.append(el('h4', 'AIB ' + n.version, 'upd-row-ver'), el('p', n.body, 'upd-row-body'));
      p.append(notes);
    }
    (doc().body || doc().documentElement).append(p);
    if (typeof b.getBoundingClientRect === 'function') {
      const r = b.getBoundingClientRect(),
        w = root.innerWidth || 0;
      p.style.top = Math.round(r.bottom + 6) + 'px';
      p.style.right = Math.max(8, Math.round(w - r.right)) + 'px';
    }
    b.setAttribute('aria-expanded', 'true');
    S.pop = { node: p, text: v.label };
  }
  async function rOpen() {
    if (R.open) {
      R.open = false;
      if (R.phase === 'confirm') R.phase = '';
      return rPaint();
    }
    if (R.phase === 'done' || R.phase === 'failed') {
      R.phase = '';
      return rPaint();
    }
    R.open = true;
    rPaint();
    try {
      const r = await rCall('GET', '/api/remote/update');
      R.notes = r.status === 200 && r.data.update ? r.data.update.notes || [] : [];
    } catch {
      R.notes = [];
    }
    rPaint();
  }
  async function rInstall() {
    const from = (R.update && R.update.current) || '';
    let r;
    try {
      r = await rCall('POST', '/api/remote/update/install', { whenIdle: !!R.whenIdle });
    } catch {
      r = { status: 0, data: {} };
    }
    if (r.status === 200 && r.data.state === 'installing') {
      Object.assign(R, { phase: 'updating', from, at: Date.now(), msg: '', whenIdle: false, open: false, sawDown: false });
      if (remote().setNote) remote().setNote('Updating AIB on ' + rPc() + '…');
      rPaint();
      rSchedule(REMOTE_FAST_MS);
      return;
    }
    if (r.status === 200 && r.data.state === 'waiting') {
      Object.assign(R, { phase: '', msg: '', whenIdle: false });
      if (r.data.update) R.update = r.data.update;
    } else if (r.data && r.data.code === 'chats_working') {
      Object.assign(R, { phase: 'confirm', whenIdle: true, msg: (r.data.error || 'Chats are working.') + ' Click Update to install when they finish.' });
    } else {
      Object.assign(R, { phase: '', msg: (r.data && r.data.error) || 'Can’t reach ' + rPc() + '. Nothing was started.' });
    }
    rPaint();
  }
  // Check for updates from this computer (the PC checks now; a just-built test feed version shows at once).
  async function rCheck() {
    try {
      const r = await rCall('POST', '/api/remote/update/check', {});
      if (r.status === 200 && r.data.update) R.update = r.data.update;
    } catch {
      /* offline: the next poll */
    }
    rPaint();
    rSchedule(REMOTE_FAST_MS);
  }
  function initRemote() {
    R.on = true;
    try {
      const done = JSON.parse(root.sessionStorage.getItem(DONE_KEY) || 'null');
      root.sessionStorage.removeItem(DONE_KEY);
      if (done && Date.now() - done.at < 60000) {
        Object.assign(R, { phase: 'done', to: String(done.to) });
        root.setTimeout(() => {
          if (R.phase === 'done') {
            R.phase = '';
            rPaint();
          }
        }, 20000);
      }
    } catch {
      /* no session storage */
    }
    const b = buttonNode();
    b.removeEventListener('click', onButton);
    b.addEventListener('click', () => void rOpen());
    rPaint();
    if (root.addEventListener) root.addEventListener('aib-remote-back', () => rSchedule(0)); // the page reached the PC again
    rSchedule(FIRST_POLL_MS);
  }

  const api = {
    remoteView,
    remoteCheck: rCheck,
    _remote: R,
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
