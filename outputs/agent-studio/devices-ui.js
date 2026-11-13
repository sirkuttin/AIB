(function (root) {
  'use strict';
  // Settings > Devices: Phone access (off by default), how the phone connects (Tailscale; a no-account relay comes later), the
  // Tailscale checklist (AIB only reads `tailscale status` and `tailscale serve status`, never changes Tailscale), Add a phone (QR,
  // six words, countdown), approving a phone that claimed the code (two check words, per-phone switches), the paired phones with
  // Remove and Remove all phones, and Phone activity. The server side is /api/live/devices* (server/web/devices_routes.ts).
  // settings-ui.js draws the two cards and calls render(kind, box, host); this file keeps its own state and polls every 2 s while a
  // card is on screen (a phone's claim shows up without a click).
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const POLL_MS = 2000;

  // The switches on the approve dialog and each phone's row: [scope, label]. See chats is always on.
  const SCOPES = [
    ['phone.read', 'See chats'],
    ['phone.answer', 'Answer questions'],
    ['phone.prompt', 'Send messages, stop turns and continue chats'],
    ['phone.approve', 'Approve requests once'],
    ['phone.push', 'Push notifications'],
  ];

  const D = {
    host: null,
    boxes: { access: null, phones: null },
    view: null,
    sig: '',
    pair: null, // {words, url, qr, expiresAt} from Add a phone
    scopes: {}, // claim id -> Set of scopes picked on the approve dialog
    confirm: '', // 'all' or a device id waiting for its second click
    activity: null,
    showActivity: false,
    busy: '',
    error: '',
    copied: false,
    timer: 0,
    tick: 0,
  };

  // ---- pure helpers (node tests) ----
  /* A phone's scopes after one switch changes (See chats always stays on). */
  function scopesAfter(have, scope, on) {
    const set = new Set(have || []);
    if (on) set.add(scope);
    else set.delete(scope);
    set.add('phone.read');
    return SCOPES.map(([s]) => s).filter((s) => set.has(s));
  }
  /* One Phone activity line: time · phone · action · chat: result. */
  function activityLine(e, when) {
    const who = e.name || (e.device ? 'a phone' : 'AIB');
    const chat = e.chat ? ' · ' + (e.chatTitle ? '"' + e.chatTitle + '"' : 'chat ' + String(e.chat).slice(0, 8)) : '';
    return when + ' · ' + who + ' · ' + e.action + chat + ': ' + e.result;
  }
  function ago(seconds, now) {
    const s = Math.max(0, Math.floor((now || Date.now()) / 1000 - Number(seconds || 0)));
    if (!seconds) return 'never';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + (Math.floor(s / 86400) === 1 ? ' day ago' : ' days ago');
  }
  function countdown(expiresAt, now) {
    const left = Math.max(0, Math.round(Number(expiresAt || 0) - (now || Date.now()) / 1000));
    return Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  }
  /* The checklist from the view: [{done, title, detail, command?}] (the Tailscale steps, in order). */
  function checklist(v) {
    const ts = v.tailscale || {};
    const name = ts.name || '';
    const steps = [];
    steps.push({
      done: !!ts.signedIn,
      title: 'Tailscale is installed and signed in',
      detail: ts.signedIn
        ? 'Found as ' + (ts.machine || '').toUpperCase() + ' on ' + ts.tailnet + (ts.login ? ', signed in as ' + ts.login : '') + '.'
        : ts.problem === 'not_installed' || !v.tailscale
          ? 'Not found on this PC. Install Tailscale from tailscale.com/download, sign in, then click Check again.'
          : ts.problem === 'signed_out'
            ? 'Tailscale is installed but not signed in. Sign in, then click Check again.'
            : 'Tailscale is not running. Start it, then click Check again.',
    });
    steps.push({
      done: !!ts.https,
      title: 'HTTPS is on for your tailnet',
      detail: ts.https
        ? 'Your PC has a certificate for ' + name + '.'
        : "Turn it on once in Tailscale's admin page: DNS, then HTTPS Certificates. Your PC's name will appear in public " +
          'certificate logs, so rename the PC first if its name says too much.',
      link: ts.https ? null : { text: 'Open', href: 'https://login.tailscale.com/admin/dns' },
    });
    steps.push({
      done: !!ts.serving,
      title: 'AIB is shared on your tailnet',
      detail: ts.serving
        ? 'Tailscale Serve sends https://' + name + ' to AIB.'
        : (ts.servingOther ? 'https://' + name + ' is shared to ' + ts.servingOther + ' now; this command replaces that. ' : '') +
          'Run this once in a terminal on this PC, then click Check again:',
      command: ts.serving ? '' : v.serveCommand,
      id: 'dvServeCommand',
    });
    // Phase D: the second command sends https://<name>:8443 to AIB's artifact port, so artifacts open on the phone.
    const port = v.artifactProblem;
    steps.push({
      done: !!ts.artifactServing && !port,
      title: 'Artifacts open on your phone',
      detail: port
        ? port.message
        : ts.artifactServing
          ? 'Tailscale Serve sends https://' + name + ':8443 to AIB, so artifacts open on your phone.'
          : (ts.artifactServingOther
              ? 'https://' + name + ':8443 is shared to ' + ts.artifactServingOther + ' now; this command replaces that. '
              : '') + 'Run this once too, then click Check again. Until then artifacts open on your PC only:',
      command: ts.artifactServing || port ? '' : v.artifactCommand || '',
      id: 'dvArtifactCommand',
    });
    return steps;
  }

  // ---- data ----
  function refresh() {
    if (!D.host) return Promise.resolve();
    return Promise.resolve(D.host.get('/api/live/devices')).then(
      (v) => {
        D.view = v;
        if (!(v.pairing && v.pairing.open)) D.pair = null;
        const sig = JSON.stringify(v) + '|' + JSON.stringify(D.pair);
        // a box that was attached after its last draw (Settings: another section, then back) is redrawn even if nothing changed
        const undrawn = Object.values(D.boxes).some((b) => b && b.isConnected && !b._dvDrawn);
        if (sig !== D.sig || undrawn) {
          D.sig = sig;
          draw();
        }
      },
      (e) => {
        D.error = 'Devices could not be loaded: ' + (e && e.message ? e.message : e);
        draw();
      },
    );
  }
  function act(name, body, label) {
    D.busy = label || name;
    D.error = '';
    draw();
    return Promise.resolve(D.host.post(name, body || {}))
      .then((r) => {
        D.busy = '';
        if (r && typeof r === 'object' && 'on' in r) D.view = r;
        return r;
      })
      .catch((e) => {
        D.busy = '';
        D.error = e && e.message ? e.message : String(e);
        return null;
      })
      .finally(() => {
        D.sig = '';
        return refresh();
      });
  }
  function onScreen() {
    return Object.values(D.boxes).some((b) => b && b.isConnected);
  }
  function poll() {
    clearInterval(D.timer);
    D.timer = setInterval(() => {
      if (!onScreen()) {
        clearInterval(D.timer);
        D.timer = 0;
        return;
      }
      D.tick++;
      // the countdown moves every second; the server is asked every 2 s
      const c = doc().getElementById('dvCountdown');
      if (c && D.pair) c.textContent = countdown(D.pair.expiresAt);
      if (D.tick % (POLL_MS / 1000) === 0) refresh();
    }, 1000);
  }

  // ---- drawing ----
  function btn(text, onClick, cls, disabled) {
    const b = el('button', text, cls || '');
    b.type = 'button';
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }
  function slot(box) {
    let s = box.querySelector(':scope > .dv-slot');
    if (!s) {
      s = el('div', null, 'dv-slot');
      box.append(s);
    }
    return s;
  }

  const TRAY_NOTE = 'While this is on, closing the AIB window keeps AIB running in the tray. Use Quit to stop it.';

  function drawAccess(box) {
    const v = D.view;
    const out = slot(box);
    const frag = doc().createDocumentFragment();
    if (!v) {
      frag.append(el('p', 'Loading…', 'st-note'));
      out.replaceChildren(frag);
      return;
    }
    const line = el('div', null, 'st-actions dv-switch');
    const l = el('label', null, 'st-toggle'),
      cb = el('input');
    cb.type = 'checkbox';
    cb.id = 'dvAccess';
    cb.checked = !!v.on;
    cb.disabled = D.busy === 'access';
    cb.addEventListener('change', () => act('devices/access', { on: cb.checked }, 'access'));
    l.append(cb, el('span', 'Let paired phones reach AIB'));
    line.append(l);
    frag.append(line);
    // Owner's decision 2026-11-12: with phone access on, closing the window keeps AIB in the tray (window.ts onWindowClosed).
    const trayNote = el('p', TRAY_NOTE, 'st-note');
    trayNote.id = 'dvTrayNote';
    frag.append(trayNote);
    let status;
    if (!v.on) status = el('p', 'Off. Nothing on your PC is reachable from other devices.', 'st-note');
    else if (D.busy === 'access' || D.busy === 'check') status = el('p', 'Checking Tailscale…', 'st-note');
    else if (v.problem) status = el('p', v.problem.message, 'st-note bad');
    else if (v.listening) status = el('p', 'Reachable at https://' + v.tailscale.name + ' through Tailscale.', 'st-note');
    else status = el('p', 'Starting…', 'st-note');
    status.id = 'dvStatus';
    status.setAttribute('role', 'status');
    frag.append(status);

    frag.append(el('h4', 'How should your phone connect?', 'dv-sub'));
    const group = el('div', null, 'st-radios');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'How should your phone connect?');
    const option = (value, name, what, enabled) => {
      const o = el('label', null, 'st-toggle st-radio' + (enabled ? '' : ' dv-off')),
        r = el('input');
      r.type = 'radio';
      r.name = 'dv-connection';
      r.value = value;
      r.checked = enabled;
      r.disabled = !enabled;
      const t = el('span');
      t.append(el('b', name), doc().createTextNode(' · ' + what));
      o.append(r, t);
      return o;
    };
    group.append(
      option(
        'tailscale',
        'Tailscale',
        'needs a free Tailscale login. Works anywhere. Install the free Tailscale app on this PC and on your phone, and ' +
          'sign in to both with the same Google, Microsoft or GitHub login. That login is with Tailscale, not AIB.',
        true,
      ),
      option('relay', 'No-account relay', 'coming later.', false),
    );
    frag.append(group);

    if (v.on) {
      const list = el('ol', null, 'dv-checks');
      for (const step of checklist(v)) {
        const li = el('li', null, step.done ? 'ok' : 'todo');
        const head = el('div', null, 'dv-check-head');
        head.append(el('span', step.done ? '✓' : '•', 'dv-mark'), el('b', step.title));
        li.append(head, el('p', step.detail, 'st-note'));
        if (step.link) {
          // target=_blank: the desktop app hands it to the system browser (desktop-bridge.js)
          const open = el('a', step.link.text, 'dv-open');
          open.href = step.link.href;
          open.target = '_blank';
          open.rel = 'noopener noreferrer';
          const lrow = el('div', null, 'st-actions');
          lrow.append(open);
          li.append(lrow);
        }
        if (step.command) {
          const row = el('div', null, 'st-actions');
          const code = el('code', step.command, 'st-command dv-command');
          code.id = step.id;
          row.append(
            code,
            btn(D.copied === step.id ? 'Copied' : 'Copy', () => {
              const done = () => {
                D.copied = step.id;
                draw();
                setTimeout(() => {
                  D.copied = false;
                  draw();
                }, 2000);
              };
              const nav = root.navigator;
              if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(step.command).then(done, () => {});
            }),
          );
          li.append(row);
        }
        list.append(li);
      }
      frag.append(list);
      const row = el('div', null, 'st-actions');
      row.append(btn(D.busy === 'check' ? 'Checking…' : 'Check again', () => act('devices/check', {}, 'check'), '', !!D.busy));
      frag.append(row);
      frag.append(
        el('p', 'AIB only reads tailscale status and tailscale serve status. It never changes your Tailscale setup.', 'st-note'),
      );
      if (v.port) frag.append(el('p', 'Phone port on this PC: 127.0.0.1:' + v.port + '.', 'st-note dim'));
    }
    if (D.error) {
      const e = el('p', D.error, 'st-error');
      e.setAttribute('role', 'alert');
      frag.append(e);
    }
    out.replaceChildren(frag);
  }

  function scopeSet(id) {
    if (!D.scopes[id]) D.scopes[id] = new Set(SCOPES.map(([s]) => s));
    return D.scopes[id];
  }

  /* A paired phone's switches; each change is saved at once and the phone's next request is checked against it. */
  function drawSwitches(d) {
    const list = el('div', null, 'dv-scopes');
    list.setAttribute('aria-label', 'What ' + d.name + ' may do');
    const have = d.scopes || [];
    for (const [scope, label] of SCOPES) {
      const l = el('label', null, 'st-toggle'),
        cb = el('input');
      cb.type = 'checkbox';
      cb.checked = have.includes(scope);
      cb.disabled = scope === 'phone.read' || !!D.busy;
      cb.dataset.scope = scope;
      cb.addEventListener('change', () => act('devices/scopes', { id: d.id, scopes: scopesAfter(have, scope, cb.checked) }, 'scopes'));
      l.append(cb, el('span', label));
      list.append(l);
    }
    return list;
  }

  function drawApprove(frag, claim) {
    const box = el('section', null, 'dv-approve');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Approve ' + claim.name);
    box.dataset.claim = claim.id;
    box.append(el('h4', 'Approve "' + claim.name + '"?', 'dv-sub'));
    const p = el('p', 'A phone wants to connect. Approve only if it shows ', 'st-note');
    const w = el('b', claim.checkWords.join(' '), 'dv-check-words');
    p.append(w, doc().createTextNode('.'));
    box.append(p);
    const picked = scopeSet(claim.id);
    const list = el('div', null, 'dv-scopes');
    for (const [scope, label] of SCOPES) {
      const l = el('label', null, 'st-toggle'),
        cb = el('input');
      cb.type = 'checkbox';
      cb.checked = picked.has(scope);
      cb.disabled = scope === 'phone.read';
      cb.dataset.scope = scope;
      cb.addEventListener('change', () => (cb.checked ? picked.add(scope) : picked.delete(scope)));
      l.append(cb, el('span', label));
      list.append(l);
    }
    box.append(list);
    box.append(el('p', "You can change these later on the phone's row under Phones.", 'st-note'));
    const row = el('div', null, 'st-actions');
    row.append(
      btn('Reject', () => act('devices/reject', { claim: claim.id }, 'reject'), '', !!D.busy),
      btn(
        'Approve',
        () => act('devices/approve', { claim: claim.id, scopes: [...picked] }, 'approve'),
        'primary',
        !!D.busy,
      ),
    );
    box.append(row);
    frag.append(box);
  }

  function drawPairing(frag, v) {
    const open = v.pairing && v.pairing.open;
    if (!open || !D.pair) return;
    const box = el('section', null, 'dv-pair');
    box.setAttribute('aria-label', 'Add a phone');
    box.append(el('h4', 'Add a phone', 'dv-sub'));
    box.append(el('p', "Scan with your phone's camera. Or open the address on the phone and type the six words.", 'st-note'));
    const grid = el('div', null, 'dv-pair-grid');
    const img = el('img', null, 'dv-qr');
    img.alt = 'Pairing QR code';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(D.pair.qr);
    const side = el('div', null, 'dv-pair-side');
    const words = el('p', D.pair.words.join(' '), 'dv-words');
    words.id = 'dvWords';
    side.append(words, el('p', D.pair.url.split('#')[0], 'st-command'));
    const timer = el('p', null, 'st-note');
    const cd = el('b', countdown(D.pair.expiresAt));
    cd.id = 'dvCountdown';
    timer.append(doc().createTextNode('Code expires in '), cd, doc().createTextNode('. Works once.'));
    side.append(timer);
    side.append(el('p', 'On your phone, before scanning:', 'st-note'));
    const steps = el('ol', null, 'dv-phone-steps');
    steps.append(
      el('li', 'Install Tailscale (App Store or Google Play).'),
      el('li', 'Sign in with the same login as on this PC.'),
      el('li', 'Turn Tailscale on, then scan the code.'),
    );
    side.append(steps);
    grid.append(img, side);
    box.append(grid);
    if (open.anotherTried) {
      const warn = el('p', 'Another device tried this code. If that was not your phone, click Cancel.', 'st-note bad');
      warn.setAttribute('role', 'alert');
      box.append(warn);
    } else if (open.wrong) {
      box.append(el('p', open.wrong + ' wrong ' + (open.wrong === 1 ? 'try' : 'tries') + '. Three wrong tries end the code.', 'st-note bad'));
    }
    const row = el('div', null, 'st-actions');
    row.append(btn('Cancel', () => {
      D.pair = null;
      act('devices/pair/cancel', {}, 'cancel');
    }));
    box.append(row);
    frag.append(box);
  }

  function drawPhones(box) {
    const v = D.view;
    const out = slot(box);
    const frag = doc().createDocumentFragment();
    if (!v) {
      out.replaceChildren(frag);
      return;
    }
    if (v.devicesWarning) frag.append(el('p', v.devicesWarning, 'st-note bad'));
    for (const claim of (v.pairing && v.pairing.pending) || []) drawApprove(frag, claim);
    if (v.pairing && v.pairing.anotherTried && !(v.pairing.open && v.pairing.open.anotherTried)) {
      frag.append(el('p', 'Another device tried the last code after your phone used it.', 'st-note bad'));
    }
    drawPairing(frag, v);
    const devices = v.devices || [];
    if (!devices.length) frag.append(el('p', 'No phones are paired.', 'st-note'));
    const list = el('div', null, 'dv-list');
    for (const d of devices) {
      const row = el('div', null, 'st-agent dv-device');
      row.dataset.device = d.id;
      const head = el('div', null, 'st-agent-head');
      head.append(el('b', d.name), el('span', 'Last seen ' + ago(d.lastSeen), 'st-tag'));
      row.append(head);
      row.append(drawSwitches(d));
      const actions = el('div', null, 'st-actions');
      if (D.confirm === d.id) {
        actions.append(
          el('span', 'Remove "' + d.name + '"? Its next request fails.', 'st-note'),
          btn('Remove', () => {
            D.confirm = '';
            act('devices/remove', { id: d.id }, 'remove');
          }, 'st-danger'),
          btn('Cancel', () => {
            D.confirm = '';
            draw();
          }),
        );
      } else {
        actions.append(btn('Remove', () => {
          D.confirm = d.id;
          draw();
        }, 'st-danger', !!D.busy));
      }
      row.append(actions);
      list.append(row);
    }
    frag.append(list);
    const ready = v.on && v.listening;
    const row = el('div', null, 'st-actions');
    const add = btn(D.busy === 'pair' ? 'Opening…' : 'Add a phone', () => {
      D.busy = 'pair';
      draw();
      Promise.resolve(D.host.post('devices/pair', {}))
        .then((r) => {
          D.pair = { words: r.words, url: r.url, qr: r.qr, expiresAt: r.expiresAt };
          D.busy = '';
          D.sig = '';
          return refresh();
        })
        .catch((e) => {
          D.busy = '';
          D.error = e && e.message ? e.message : String(e);
          draw();
        });
    }, 'primary', !ready || !!D.busy || !!D.pair);
    add.id = 'dvAdd';
    if (!ready) add.title = 'Turn on "Let paired phones reach AIB" and finish the Tailscale steps first.';
    row.append(add);
    row.append(btn(D.showActivity ? 'Hide phone activity' : 'Phone activity', () => {
      D.showActivity = !D.showActivity;
      if (!D.showActivity) return draw();
      Promise.resolve(D.host.get('/api/live/devices/activity')).then((r) => {
        D.activity = r.entries || [];
        draw();
      }, () => {});
    }));
    if (devices.length) {
      if (D.confirm === 'all') {
        row.append(
          el('span', 'Remove all ' + devices.length + ' phones?', 'st-note'),
          btn('Remove all', () => {
            D.confirm = '';
            act('devices/remove-all', {}, 'remove-all');
          }, 'st-danger'),
          btn('Cancel', () => {
            D.confirm = '';
            draw();
          }),
        );
      } else {
        row.append(btn('Remove all phones', () => {
          D.confirm = 'all';
          draw();
        }, 'st-danger', !!D.busy));
      }
    }
    frag.append(row);
    if (D.showActivity) {
      const log = el('div', null, 'dv-activity');
      const entries = D.activity || [];
      log.append(el('p', 'What each phone did: time, phone, action, chat and result. Message text and commands are never kept.', 'st-note'));
      if (!entries.length) log.append(el('p', 'No phone activity yet.', 'st-note'));
      for (const e of entries.slice(0, 100)) {
        const t = new Date(e.time * 1000);
        log.append(el('p', activityLine(e, t.toLocaleString()), 'st-note'));
      }
      frag.append(log);
    }
    frag.append(
      el(
        'p',
        'Never on a phone: terminal, Settings, custom agents, deleting projects, updates, shutting down AIB, "Allow always".',
        'st-note',
      ),
    );
    frag.append(
      el('p', "Lost a phone? Click Remove here, and also remove the phone in Tailscale's admin page.", 'st-note'),
    );
    out.replaceChildren(frag);
  }

  function draw() {
    if (D.boxes.access && D.boxes.access.isConnected) {
      drawAccess(D.boxes.access);
      D.boxes.access._dvDrawn = true;
    }
    if (D.boxes.phones && D.boxes.phones.isConnected) {
      drawPhones(D.boxes.phones);
      D.boxes.phones._dvDrawn = true;
    }
  }

  // kind: 'access' | 'phones'; host: {get(path), post(name, body)} (settings-ui.js's host).
  function render(kind, box, host) {
    D.host = host;
    D.boxes[kind] = box;
    draw();
    if (!D.timer) poll();
    refresh();
  }

  const api = { render, refresh, ago, countdown, checklist, scopesAfter, activityLine, SCOPES, TRAY_NOTE, _state: D };
  root.AIBDevicesUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
