(function (root) {
  'use strict';
  // Settings > Remote control (was "Devices"; the section id stays 'devices' so old links still open it): Phone access (off by
  // default) and the four setup steps (Tailscale on this PC, HTTPS for your tailnet, Share AIB on your tailnet, Add a phone), each
  // with one button that runs the step for you (server/remote/setup.ts) and turns green by itself; "What AIB changed on this PC";
  // how the phone connects (Tailscale; a no-account relay comes later); Add a phone (QR, six words, countdown), approving a phone
  // that claimed the code (two check words, per-phone switches), the paired phones with Silent reminders, Remove and Remove all
  // phones, and Phone activity. The server side is /api/live/devices* (server/web/devices_routes.ts).
  // settings-ui.js draws the two cards and calls render(kind, box, host). This file keeps its own state: it reads the view every
  // 2 s while a card is on screen (a phone's claim shows up without a click; no Tailscale command runs for that), and asks the
  // server to re-read Tailscale every 3 s while a step waits and every 30 s otherwise (30 s after 10 minutes), only while the page
  // is visible. watch(host) (chat.js) shows an in-app notice when AIB started with the switch on and its Tailscale share missing.
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const POLL_MS = 2000;
  const FAST_MS = 3000,
    SLOW_MS = 30000,
    FAST_FOR_MS = 10 * 60 * 1000;

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
    ui: { replaceConfirm: false, funnelConfirm: false, details: false, term: null },
    shownAt: 0, // when the cards were first drawn this time (the 3 s re-check drops to 30 s after 10 minutes)
    lastRefresh: 0,
    refreshing: false,
    notice: { host: null, node: null, dismissed: false, timer: 0 },
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

  const NOT_INSTALLED = 'Tailscale isn’t installed. It is the free app that links this PC and your phone. Its login is with Tailscale, not AIB.';
  const INSTALL_WHAT = {
    winget: 'AIB installs it with winget. Windows asks once for permission (a UAC prompt). Click Yes.',
    msi: 'AIB downloads Tailscale’s installer from pkgs.tailscale.com, checks it, and runs it. Windows will ask for Tailscale Inc. (a UAC prompt). Click Yes.',
    pkg: 'AIB downloads Tailscale’s installer from tailscale.com, checks it, and opens it. macOS asks for your password, then asks you to allow Tailscale’s network extension.',
    terminal: 'Installing needs your password. AIB opens its setup terminal here and runs Tailscale’s install script. Type your password when sudo asks.',
  };
  const TERM_NOTE = 'Type your password in the terminal below. It goes to sudo, and AIB doesn’t keep it.';
  const active = (j) => !!j && (j.state === 'running' || j.state === 'waiting');

  /* The access card's status line and the four steps, from the view and this page's own state (ui: replaceConfirm, funnelConfirm,
     details, term {step}). Each step: {n, title, state: ok|now|wait|err|later, notes, alert, confirm, progress, actions:
     [{label, act, kind}], links: [{text, href}], command, details, terminal}. Drawn by drawSteps; tested in work/test_remote_setup_ui.js. */
  function setupSteps(v, ui) {
    ui = ui || {};
    const ts = v.tailscale || { installed: false, problem: 'not_installed' };
    const s = v.setup || {};
    const job = s.job || null;
    const jobOf = (names) => (job && names.includes(job.action) ? job : null);
    const name = ts.name || '';
    const links = s.links || {};
    const cmds = s.commands || {};
    const os = s.os || 'windows';
    const mode = s.installMode || 'winget';
    const step = (n, title, state, more) =>
      Object.assign({ n, title, state, notes: [], alert: '', confirm: '', progress: [], actions: [], links: [], command: '', details: [], terminal: false }, more || {});
    const download = { text: 'Download Tailscale', href: links.download || 'https://tailscale.com/download' };
    const openApp = os === 'linux' ? null : { label: 'Open Tailscale', act: 'start', kind: 'link' };

    // ---- 1. Tailscale on this PC ----
    let one;
    const inst = jobOf(['install']);
    const login = jobOf(['login', 'up']);
    if (ui.term && /^tailscale-(install|start|operator)$/.test(ui.term.step)) {
      one = step(1, 'Tailscale on this PC', 'wait', {
        notes: [TERM_NOTE, 'When the command finishes, AIB checks again by itself.'],
        terminal: true,
      });
    } else if (ts.signedIn) {
      one = step(1, 'Tailscale on this PC', 'ok', {
        notes: [
          (ts.login ? 'Signed in as ' + ts.login + '. ' : '') + 'This PC is ' + String(ts.machine || '').toUpperCase() + ' on ' + ts.tailnet + '.',
        ],
      });
    } else if (active(inst)) {
      one = step(1, 'Tailscale on this PC', 'wait', {
        progress: inst.progress || [],
        notes: inst.message ? [inst.message] : [],
        actions: inst.cancellable ? [{ label: 'Cancel', act: 'cancel' }] : [],
      });
    } else if (inst && inst.state === 'failed' && !ts.installed) {
      const declined = inst.code === 'declined';
      one = step(1, 'Tailscale on this PC', 'err', {
        alert: declined ? inst.message + ' Click Install Tailscale to try again.' : 'Tailscale didn’t install. ' + inst.message,
        actions: [{ label: 'Install Tailscale', act: 'install', kind: 'primary' }].concat(
          !declined && (inst.details || []).length ? [{ label: ui.details ? 'Hide details' : 'Show details', act: 'details', kind: 'link' }] : [],
        ),
        links: [download],
        details: ui.details ? inst.details || [] : [],
      });
    } else if (!ts.installed) {
      one = step(1, 'Tailscale on this PC', 'now', {
        notes: [NOT_INSTALLED, INSTALL_WHAT[mode] || INSTALL_WHAT.winget],
        actions: [{ label: 'Install Tailscale', act: mode === 'terminal' ? 'term-install' : 'install', kind: 'primary' }],
        links: os === 'darwin' ? [download, { text: 'Get it from the Mac App Store instead', href: links.appStore }] : [download],
      });
    } else if (ts.problem === 'stopped') {
      one = active(login)
        ? step(1, 'Tailscale on this PC', 'wait', { notes: ['Turning Tailscale on. This turns green by itself.'] })
        : step(1, 'Tailscale on this PC', 'err', {
          alert:
            'Tailscale is switched off on this PC. Phones can’t reach AIB until it’s on again.' +
            (ts.serving ? ' AIB’s share is still set up and works as soon as Tailscale is back.' : ''),
          notes: login && login.state === 'failed' ? [login.message] : [],
          actions: [{ label: 'Turn Tailscale on', act: 'up', kind: 'primary' }].concat(openApp ? [openApp] : []),
          command: login && login.state === 'failed' ? login.fallback || '' : '',
        });
    } else if (ts.problem === 'needs_machine_auth') {
      one = step(1, 'Tailscale on this PC', 'wait', {
        notes: ['Your tailnet admin needs to approve this PC in Tailscale’s admin page. This turns green by itself once they do.'],
        links: [{ text: 'Open the Machines page', href: links.adminMachines }],
      });
    } else if (ts.problem === 'starting') {
      one = step(1, 'Tailscale on this PC', 'wait', { notes: ['Tailscale is starting. This turns green by itself.'] });
    } else if (ts.problem === 'not_running') {
      one = step(1, 'Tailscale on this PC', 'now', {
        notes: ['Tailscale is installed but not running.'].concat(os === 'linux' ? ['AIB opens its setup terminal here to start it. Type your password when sudo asks.'] : []),
        actions: [{ label: 'Start Tailscale', act: os === 'linux' ? 'term-start' : 'start', kind: 'primary' }],
      });
    } else if (active(login)) {
      const notes = [login.phase === 'no_link' ? login.message : 'Finish signing in in your browser. This turns green by itself.'];
      if (login.notice) notes.push(login.notice);
      one = step(1, 'Tailscale on this PC', 'wait', {
        notes,
        links: login.link ? [{ text: 'Open the sign-in page again', href: login.link }] : [],
        actions: (login.phase === 'no_link' && openApp ? [openApp] : []).concat([{ label: 'Cancel', act: 'cancel' }]),
      });
    } else if (login && login.state === 'failed') {
      const acts =
        login.code === 'flags' && openApp
          ? [openApp]
          : login.code === 'operator'
            ? [{ label: 'Allow AIB to manage Tailscale', act: 'term-operator', kind: 'primary' }]
            : [{ label: 'Sign in to Tailscale', act: 'login', kind: 'primary' }];
      one = step(1, 'Tailscale on this PC', 'err', { alert: login.message, actions: acts, command: login.fallback || '' });
    } else {
      one = step(1, 'Tailscale on this PC', 'now', {
        notes: [
          '✓ Tailscale is installed. Now sign in. Your browser opens Tailscale’s login page. Use Google, Microsoft or GitHub, the same login you’ll use on your phone.',
        ],
        actions: [{ label: 'Sign in to Tailscale', act: 'login', kind: 'primary' }],
      });
    }

    // ---- 2. HTTPS for your tailnet ----
    let two;
    const share = jobOf(['share']);
    if (!ts.signedIn) two = step(2, 'HTTPS for your tailnet', 'later');
    else if (ts.https) two = step(2, 'HTTPS for your tailnet', 'ok', { notes: ['This PC has a certificate for ' + name + '.'] });
    else if (s.httpsWaiting || active(jobOf(['https'])) || (active(share) && share.phase === 'https')) {
      two = step(2, 'HTTPS for your tailnet', 'wait', {
        notes: ['Tailscale’s page is open in your browser. Click Enable there. This turns green by itself, usually within a minute.'],
        actions: [{ label: 'Open the page again', act: 'open-https', kind: 'link' }],
      });
    } else {
      two = step(2, 'HTTPS for your tailnet', 'now', {
        notes: [
          'Phones need HTTPS to install AIB and get notifications. Tailscale turns it on for your whole tailnet with one click on its page. It can’t be done from this PC.',
          'Heads-up: your PC’s name (' + (ts.machine || name) + ') will appear in public certificate logs. If the name says too much, rename the PC in Tailscale first.',
        ],
        actions: [{ label: 'Turn on HTTPS', act: 'https', kind: 'primary' }],
        links: [{ text: 'Rename this PC in Tailscale', href: links.adminMachines }],
      });
    }

    // ---- 3. Share AIB on your tailnet ----
    let three;
    const unshare = jobOf(['unshare']);
    const funnelJob = jobOf(['funnel-off']);
    const problem = v.problem || null;
    const T = 'Share AIB on your tailnet';
    if (!ts.signedIn || !ts.https) three = step(3, T, 'later');
    else if (problem && problem.code === 'funnel') {
      const ports = (ts.funnelPorts || []).map((f) => f.port);
      const targets = (ts.funnelPorts || []).map((f) => f.to).join(', ');
      three = step(3, T, active(funnelJob) ? 'wait' : 'err', { alert: problem.message });
      if (active(funnelJob)) three.notes.push('Turning off Funnel…');
      else if (ui.funnelConfirm) {
        three.confirm =
          'Turn off Funnel for port ' + ports.join(' and ') + '? ' + targets + ' stops being public. AIB runs ' +
          ports.map((p) => 'tailscale funnel --https=' + p + ' off').join(' and ') + '.';
        three.actions = [
          { label: 'Turn off Funnel', act: 'funnel-off', kind: 'danger' },
          { label: 'Cancel', act: 'funnel-cancel' },
        ];
      } else three.actions = [{ label: 'Turn off Funnel', act: 'funnel-ask' }];
      if (funnelJob && funnelJob.state === 'failed') {
        three.notes.push(funnelJob.message);
        three.command = funnelJob.fallback || '';
      }
    } else if (problem && problem.code === 'port_busy') {
      three = step(3, T, 'err', { alert: problem.message, actions: [{ label: 'Check again', act: 'check', kind: 'link' }] });
    } else if (active(share)) {
      three = step(3, T, 'wait', {
        progress: share.progress || [],
        notes: share.phase === 'https' ? ['HTTPS isn’t on for your tailnet yet. AIB shares by itself once it is (step 2).'] : [],
        actions: [{ label: 'Cancel', act: 'cancel' }],
      });
    } else if (active(unshare)) {
      three = step(3, T, 'wait', { notes: ['Stopping sharing…'] });
    } else if (ts.serving) {
      three = step(3, T, 'ok', {
        notes: [
          'Tailscale sends https://' + name + ' to AIB' + (ts.artifactServing ? ', and https://' + name + ':8443 to AIB’s artifacts.' : '.'),
        ],
        actions: [{ label: 'Stop sharing', act: 'unshare', kind: 'danger' }],
      });
      if (!ts.artifactServing) {
        const why = s.artifactNote || (v.artifactProblem && v.artifactProblem.message) || '';
        three.notes.push('Artifacts open on your PC only.' + (why ? ' ' + why : ''));
      }
      if (unshare && unshare.state === 'failed') {
        three.alert = unshare.message;
        three.command = unshare.fallback || '';
      }
    } else {
      const others = [];
      if (ts.servingOther) others.push({ port: 443, to: ts.servingOther });
      if (v.artifactListening && ts.artifactServingOther) others.push({ port: 8443, to: ts.artifactServingOther });
      three = step(3, T, 'now');
      if (s.missingAtStart) three.alert = 'AIB started, but its share on Tailscale was missing, so phones can’t reach AIB.';
      if (share && share.state === 'failed') {
        three.state = 'err';
        three.alert = share.message;
        three.command = share.fallback || '';
      }
      if (others.length) {
        const one1 = others.length === 1;
        three.confirm =
          others.map((o) => 'https://' + name + (o.port === 443 ? '' : ':8443') + ' is shared to ' + o.to + ' now').join('. ') +
          '. Sharing AIB replaces ' + (one1 ? 'that, and that program stops' : 'both, and those programs stop') +
          ' being reachable over Tailscale.';
        if (!ui.replaceConfirm) three.actions = [{ label: 'Replace and share', act: 'share-replace', kind: 'primary' }];
        else {
          three.notes.push('Click again to confirm.');
          three.actions = [
            { label: 'Yes, replace it', act: 'share-confirm', kind: 'primary' },
            { label: 'Cancel', act: 'cancel-replace' },
          ];
        }
      } else {
        three.notes.push(
          s.shareAgain || s.missingAtStart
            ? 'AIB was shared on your tailnet before, but Tailscale doesn’t send https://' + name + ' to AIB now.'
            : 'AIB runs two tailscale serve commands so your phone can reach it at https://' + name + ', and artifacts at port 8443. Only devices on your tailnet can reach it, not the internet.',
        );
        three.actions = [{ label: s.shareAgain || s.missingAtStart ? 'Share again' : 'Share AIB', act: 'share', kind: 'primary' }];
      }
    }
    if ((ts.otherNames || []).length && three.state !== 'later') {
      three.notes.push('Tailscale also shares under another name (' + ts.otherNames.join(', ') + '). AIB leaves that alone.');
    }

    // ---- 4. Add a phone ----
    const ready = !!ts.signedIn && !!ts.serving && !!v.listening && !problem;
    const four = step(4, 'Add a phone', ready ? 'now' : 'later', ready ? { notes: ['Use Add a phone under Phones below.'] } : {});

    // ---- the status line ----
    let status;
    const changes = s.changes || [];
    if (!v.on) {
      let text = 'Off. Nothing on your PC is reachable from other devices.';
      if (s.pendingUnshare) text += ' AIB stops sharing on Tailscale as soon as Tailscale runs again.';
      else if (changes.length && changes[0].label === 'Stopped sharing AIB' && changes[0].ok) {
        text += ' AIB stopped sharing on Tailscale. Tailscale stays installed and signed in.';
      }
      status = { text, tone: '' };
    } else if (ready) status = { text: '✓ Reachable at https://' + name + ' through Tailscale. All set: four score and no commands.', tone: 'ok' };
    else if (ts.problem === 'stopped') status = { text: 'Tailscale is switched off, so phones can’t reach AIB right now.', tone: 'bad' };
    else if (problem && (problem.code === 'funnel' || problem.code === 'port_busy')) status = { text: 'Phone access is waiting on step 3.', tone: 'bad' };
    else status = { text: 'Set up in four steps. Each one turns green by itself.', tone: '' };

    const steps = [one, two, three, four];
    return { status, steps, waiting: steps.some((x) => x.state === 'wait') || active(job) };
  }

  /* How long until the next Tailscale re-check (ms): 3 s while a step waits, 30 s otherwise and after 10 minutes on screen. */
  function refreshEvery(waiting, onScreenMs) {
    return waiting && onScreenMs < FAST_FOR_MS ? FAST_MS : SLOW_MS;
  }

  /* The in-app notice at start: AIB started with the switch on, it had shared itself, and the share was gone. */
  function missingNotice(v) {
    return !!(v && v.on && v.setup && v.setup.missingAtStart);
  }

  // ---- data ----
  function refresh() {
    if (!D.host) return Promise.resolve();
    return Promise.resolve(D.host.get('/api/live/devices')).then(
      (v) => {
        take(v);
      },
      (e) => {
        D.error = 'Remote control could not be loaded: ' + (e && e.message ? e.message : e);
        draw();
      },
    );
  }
  function take(v) {
    if (!v || typeof v !== 'object' || !('on' in v)) return;
    D.view = v;
    if (!(v.pairing && v.pairing.open)) D.pair = null;
    const ts = v.tailscale || {};
    if (!ts.servingOther && !ts.artifactServingOther) D.ui.replaceConfirm = false;
    if (!(v.problem && v.problem.code === 'funnel')) D.ui.funnelConfirm = false;
    const sig = JSON.stringify(v) + '|' + JSON.stringify(D.pair) + '|' + JSON.stringify(Object.assign({}, D.ui, { term: D.ui.term && D.ui.term.step }));
    // a box that was attached after its last draw (Settings: another section, then back) is redrawn even if nothing changed
    const undrawn = Object.values(D.boxes).some((b) => b && b.isConnected && !b._dvDrawn);
    if (sig !== D.sig || undrawn) {
      D.sig = sig;
      draw();
    }
    showNotice(v);
  }
  /* The server re-reads Tailscale (single read shared with a waiting job; never more often than every 2.5 s). */
  function recheck(fresh) {
    if (!D.host || (D.refreshing && !fresh)) return Promise.resolve();
    D.refreshing = true;
    D.lastRefresh = Date.now();
    return Promise.resolve(D.host.post('devices/tailscale/refresh', fresh ? { fresh: true } : {}))
      .then(take, () => {})
      .finally(() => {
        D.refreshing = false;
      });
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
  /* A setup button: one fixed action name and its flags. */
  function run(action, flags) {
    return act('devices/tailscale/run', Object.assign({ action }, flags || {}), 'setup');
  }
  function onScreen() {
    return Object.values(D.boxes).some((b) => b && b.isConnected);
  }
  function visible() {
    const d = doc();
    return !d || d.visibilityState !== 'hidden';
  }
  function poll() {
    clearInterval(D.timer);
    D.timer = setInterval(() => {
      if (!onScreen()) {
        clearInterval(D.timer);
        D.timer = 0;
        D.shownAt = 0;
        return;
      }
      D.tick++;
      // the countdown moves every second; the view is read every 2 s
      const c = doc().getElementById('dvCountdown');
      if (c && D.pair) c.textContent = countdown(D.pair.expiresAt);
      if (D.tick % (POLL_MS / 1000) === 0) refresh();
      if (!visible() || !D.boxes.access || !D.boxes.access.isConnected || !D.view) return;
      const waiting = setupSteps(D.view, D.ui).waiting;
      if (Date.now() - D.lastRefresh >= refreshEvery(waiting, Date.now() - D.shownAt)) recheck();
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
  function copyRow(command, id) {
    const row = el('div', null, 'st-actions');
    const code = el('code', command, 'st-command dv-command');
    if (id) code.id = id;
    row.append(
      code,
      btn(D.copied === command ? 'Copied' : 'Copy', () => {
        const done = () => {
          D.copied = command;
          draw();
          setTimeout(() => {
            D.copied = false;
            draw();
          }, 2000);
        };
        const nav = root.navigator;
        if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(command).then(done, () => {});
      }),
    );
    return row;
  }

  const TRAY_NOTE = 'While this is on, closing the AIB window keeps AIB running in the tray. Use Quit to stop it.';

  /* The Linux setup terminal on the card (the same panel Beta agents install Node.js and uv in): setup=remote, a fixed step. */
  function openTerm(step) {
    const T = root.AibTerminal;
    if (!T || !T.runSetup) {
      D.error = 'The setup terminal could not start. Download Tailscale instead.';
      return draw();
    }
    closeTerm();
    const cmds = (D.view && D.view.setup && D.view.setup.commands) || {};
    const command = step === 'tailscale-install' ? cmds.linuxInstall : step === 'tailscale-operator' ? cmds.linuxOperator : cmds.linuxStart;
    const node = el('div', null, 'st-beta-term dv-term');
    const head = el('div', null, 'st-beta-term-head');
    head.append(el('span', (step === 'tailscale-install' ? 'Installing Tailscale: ' : 'Running: ') + (command || ''), 'st-beta-term-title'), btn('Close', () => closeTerm(true), 'st-link'));
    const view = el('div', null, 'st-beta-term-view');
    const status = el('p', 'Starting…', 'st-note');
    status.setAttribute('role', 'status');
    node.append(head, view, status);
    const term = { step, node, status, run: null };
    D.ui.term = term;
    draw();
    term.run = T.runSetup(view, 'remote', step, {
      onReady: () => (status.textContent = 'Type your password here when sudo asks.'),
      onExit: (code) => {
        if (D.ui.term !== term) return;
        if (code !== 0) {
          status.textContent = 'The command stopped (exit code ' + code + '). The terminal above shows why. Try again, or download Tailscale yourself.';
          status.className = 'st-note bad';
          return;
        }
        status.textContent = 'Done. Checking…';
        recheck(true).then(() => {
          if (D.ui.term === term) closeTerm(true);
        });
      },
      onError: (message) => {
        status.textContent = message;
        status.className = 'st-note bad';
      },
    });
  }
  function closeTerm(paint) {
    const term = D.ui.term;
    if (!term) return;
    D.ui.term = null;
    try {
      if (term.run) term.run.close();
    } catch (e) {
      /* closed */
    }
    if (term.node && term.node.remove) term.node.remove();
    Promise.resolve()
      .then(() => D.host && D.host.post('terminal/end', { key: 'setup:remote' }))
      .catch(() => {});
    if (paint) draw();
  }

  /* A step's button or link click. */
  function onAct(name) {
    const ui = D.ui;
    switch (name) {
      case 'cancel':
        return act('devices/tailscale/cancel', {}, 'setup');
      case 'details':
        ui.details = !ui.details;
        return draw();
      case 'check':
        return act('devices/check', {}, 'check');
      case 'share-replace':
        ui.replaceConfirm = true;
        return draw();
      case 'cancel-replace':
        ui.replaceConfirm = false;
        return draw();
      case 'share-confirm':
        ui.replaceConfirm = false;
        return run('share', { replace: true });
      case 'funnel-ask':
        ui.funnelConfirm = true;
        return draw();
      case 'funnel-cancel':
        ui.funnelConfirm = false;
        return draw();
      case 'funnel-off':
        ui.funnelConfirm = false;
        return run('funnel-off', { confirm: true });
      case 'term-install':
        return openTerm('tailscale-install');
      case 'term-operator':
        return openTerm('tailscale-operator');
      case 'term-start':
        return openTerm('tailscale-start');
      default:
        return run(name);
    }
  }

  function drawStep(step) {
    const li = el('li', null, 'dv-step ' + step.state);
    li.dataset.step = String(step.n);
    const head = el('div', null, 'dv-check-head');
    const mark = step.state === 'ok' ? '✓' : step.state === 'err' ? '!' : String(step.n);
    head.append(el('span', mark, 'dv-mark'), el('b', step.title));
    li.append(head);
    if (step.state === 'later') return li;
    if (step.alert) {
      const a = el('p', step.alert, 'st-note bad dv-alert');
      a.setAttribute('role', 'alert');
      li.append(a);
    }
    for (const n of step.notes) li.append(el('p', n, 'st-note'));
    if (step.progress.length) {
      const ul = el('ul', null, 'dv-progress');
      for (const p of step.progress) ul.append(el('li', (p.state === 'done' ? '✓ ' : p.state === 'now' ? '→ ' : '· ') + p.text, p.state));
      li.append(ul);
    }
    if (step.confirm) li.append(el('p', step.confirm, 'st-note dv-confirm'));
    if (step.terminal && D.ui.term) li.append(D.ui.term.node);
    if (step.actions.length || step.links.length) {
      const row = el('div', null, 'st-actions');
      for (const a of step.actions) {
        const cls = a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'st-danger' : a.kind === 'link' ? 'st-link' : '';
        const b = btn(a.label, () => onAct(a.act), cls, !!D.busy && a.act !== 'details');
        b.dataset.act = a.act;
        row.append(b);
      }
      for (const l of step.links) {
        // target=_blank: the desktop app hands it to the system browser (desktop-bridge.js)
        const a = el('a', l.text, 'dv-open');
        a.href = l.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        row.append(a);
      }
      li.append(row);
    }
    if (step.command) li.append(copyRow(step.command));
    if (step.details.length) li.append(el('pre', step.details.join('\n'), 'st-command dv-details'));
    return li;
  }

  function drawChanges(frag, v) {
    const s = v.setup || {};
    const changes = s.changes || [];
    const d = el('details', null, 'dv-changes');
    d.open = !!D.ui.changesOpen;
    d.addEventListener('toggle', () => (D.ui.changesOpen = d.open));
    d.append(el('summary', 'What AIB changed on this PC (' + changes.length + ')'));
    d.append(
      el(
        'p',
        'Reads: tailscale status --json and tailscale serve status --json. These change nothing. Every change is listed here and in Phone activity. AIB never turns on Funnel, and never uninstalls Tailscale or signs you out.',
        'st-note',
      ),
    );
    if (!changes.length) d.append(el('p', 'Nothing yet.', 'st-note'));
    for (const c of changes.slice(0, 20)) {
      const when = new Date(Number(c.time || 0) * 1000).toLocaleString();
      d.append(el('p', c.label + (c.ok ? '' : ' (failed)') + ' · ' + when, 'st-note dv-change'), el('code', c.command, 'st-command'));
      if (c.note) d.append(el('p', c.note, 'st-note'));
    }
    const ts = v.tailscale || {};
    if (v.on && (ts.serving || (v.problem && (v.problem.code === 'funnel' || v.problem.code === 'port_busy')))) {
      const row = el('div', null, 'st-actions');
      row.append(btn('Turn off remote control', () => act('devices/access', { on: false }, 'access'), 'st-danger', !!D.busy));
      d.append(row);
    }
    frag.append(d);
  }

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
    const model = setupSteps(v, D.ui);
    const status =
      D.busy === 'access' || D.busy === 'check'
        ? el('p', 'Checking Tailscale…', 'st-note')
        : el('p', model.status.text, 'st-note' + (model.status.tone === 'bad' ? ' bad' : model.status.tone === 'ok' ? ' dv-good' : ''));
    status.id = 'dvStatus';
    status.setAttribute('role', 'status');
    frag.append(status);

    if (v.on) {
      const list = el('ol', null, 'dv-checks dv-steps');
      for (const step of model.steps) list.append(drawStep(step));
      frag.append(list);
      const again = el('p', 'Steps update by themselves. ', 'st-note');
      const check = btn(D.busy === 'check' ? 'Checking…' : 'Check again', () => act('devices/check', {}, 'check'), 'st-link', !!D.busy);
      check.id = 'dvCheck';
      again.append(check);
      frag.append(again);
    }
    drawChanges(frag, v);

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
      option('tailscale', 'Tailscale', 'needs a free Tailscale login and works anywhere. Use the same Google, Microsoft or GitHub login on this PC and on your phone.', true),
      option('relay', 'No-account relay', 'coming later.', false),
    );
    frag.append(group);
    if (v.on && v.port) {
      frag.append(el('p', 'Phone port on this PC: 127.0.0.1:' + v.port + (v.artifactPort ? '. Artifact port: 127.0.0.1:' + v.artifactPort + '.' : '.'), 'st-note dim'));
    }
    if (D.error) {
      const e = el('p', D.error, 'st-error');
      e.setAttribute('role', 'alert');
      frag.append(e);
    }
    out.replaceChildren(frag);
  }

  // ---- the in-app notice (owner answer 1) ----
  /* Shown in the page's notice stack (the same look as the chat toasts), never as an OS notification. Share again runs the same
     Share AIB click; when something else holds the address, or anything fails, Settings > Remote control opens instead. */
  function showNotice(v) {
    const N = D.notice;
    const want = missingNotice(v) && !N.dismissed && !!doc() && !!doc().body;
    if (!want) {
      if (N.node) N.node.remove();
      N.node = null;
      return;
    }
    if (N.node) return;
    let stack = doc().querySelector('.toast-stack');
    if (!stack) {
      stack = el('div', null, 'toast-stack');
      stack.setAttribute('aria-live', 'polite');
      stack.setAttribute('role', 'region');
      stack.setAttribute('aria-label', 'Notifications');
      doc().body.append(stack);
    }
    const node = el('div', null, 'toast toast-needs dv-notice');
    node.id = 'dvMissingNotice';
    node.setAttribute('role', 'status');
    const text = el('div', null, 'toast-text');
    text.append(el('strong', 'Phones can’t reach AIB'), el('span', 'AIB’s share on Tailscale is missing.'));
    const host = N.host || D.host;
    const openSettings = () => {
      if (root.AgentSettingsUI && root.AgentSettingsUI.open) root.AgentSettingsUI.open('devices');
    };
    const again = btn('Share again', () => {
      const ts = v.tailscale || {};
      N.node = null;
      node.remove();
      if (ts.servingOther || ts.artifactServingOther) return openSettings(); // replacing something asks first, on the Share step
      Promise.resolve(host.post('devices/tailscale/run', { action: 'share' })).then(
        (r) => {
          if (r && typeof r === 'object' && 'on' in r) take(r);
        },
        () => openSettings(),
      );
    }, 'toast-open');
    again.id = 'dvShareAgain';
    const close = btn('×', () => {
      N.dismissed = true;
      N.node = null;
      node.remove();
      Promise.resolve(host.post('devices/tailscale/run', { action: 'dismiss-missing' })).catch(() => {});
    }, 'toast-close');
    close.setAttribute('aria-label', 'Dismiss');
    node.append(text, again, close);
    N.node = node;
    stack.append(node);
  }
  /* chat.js: read the view once a few seconds after the page opens and then every minute (no Tailscale command runs for it). */
  function watch(host) {
    const N = D.notice;
    N.host = host;
    if (!D.host) D.host = host;
    const look = () =>
      Promise.resolve(host.get('/api/live/devices')).then(
        (v) => {
          if (!onScreen()) {
            D.view = v;
            showNotice(v);
          } else take(v);
        },
        () => {},
      );
    clearInterval(N.timer);
    root.setTimeout(look, 3000);
    N.timer = root.setInterval(look, 60000);
  }

  const REMIND_NOTE =
    'When you close or hide AIB on this phone while chats still need you, the phone gets one silent summary ("2 chats need you"). ' +
    'It is replaced, not stacked, and stays until you open AIB on the phone. Needs Push notifications on.';
  /* A paired phone's Silent reminders switch (owner decision: per phone, on by default); saved at once. */
  function drawRemind(d) {
    const box = el('div', null, 'dv-remind');
    const l = el('label', null, 'st-toggle'),
      cb = el('input');
    cb.type = 'checkbox';
    cb.checked = d.remind !== false;
    cb.disabled = !!D.busy;
    cb.dataset.remind = d.id;
    cb.addEventListener('change', () => act('devices/prefs', { id: d.id, remind: cb.checked }, 'prefs'));
    l.append(cb, el('span', 'Silent reminders'));
    box.append(l, el('p', REMIND_NOTE, 'st-note'));
    return box;
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
    if (!devices.length) frag.append(el('p', 'No phones are paired. A house with no phones cannot stand… on the couch and answer chats.', 'st-note'));
    const list = el('div', null, 'dv-list');
    for (const d of devices) {
      const row = el('div', null, 'st-agent dv-device');
      row.dataset.device = d.id;
      const head = el('div', null, 'st-agent-head');
      head.append(el('b', d.name), el('span', 'Last seen ' + ago(d.lastSeen), 'st-tag'));
      row.append(head);
      row.append(drawSwitches(d));
      row.append(drawRemind(d));
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
    if (!ready) add.title = 'Finish the setup steps above first.';
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
    if (!D.shownAt) D.shownAt = Date.now();
    draw();
    if (!D.timer) poll();
    refresh();
    if (kind === 'access' && Date.now() - D.lastRefresh > FAST_MS) recheck(); // opening the section reads Tailscale once
  }

  const api = {
    render,
    refresh,
    recheck,
    watch,
    ago,
    countdown,
    setupSteps,
    refreshEvery,
    missingNotice,
    scopesAfter,
    activityLine,
    SCOPES,
    TRAY_NOTE,
    REMIND_NOTE,
    _state: D,
  };
  root.AIBDevicesUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
