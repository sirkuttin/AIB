(function (root) {
  'use strict';
  // Settings > AIB Linking (WSL) (docs/wsl/linking-design.md; sections 11 and 12 override it). Windows only (settings-ui.js hides the
  // section elsewhere). At the top a drop-down of every distro (the unusable ones listed, off, with the reason) picks the distro the
  // page shows; under it "WSL on this PC" (every distro, the reasons, WSL's default marked; or how to get WSL), then the picked
  // distro's group: its status card, "What <distro> needs" (env.prereqs: Node.js, npm, git, curl, free space; the Node.js install
  // in a terminal panel on the card) and "Agents in <distro>", drawn with Settings' own agentRow and an env of the distro (job
  // store: wsl-ui.js, the only one; card keys "wsl:<distro>:<agent>"; the distro's own On/Off switch per agent, sign-in state with
  // Sign in in a terminal panel, Uninstall of AIB's own copy, Codex's usage limits).
  // Opening Settings never starts a distro: the status is the poll's (never starts one), the agent list and the prerequisites are
  // asked with peek=1, only for a distro that is ready. Only "Start <distro> and check" asks with start=1 (and a Sign in click
  // while the distro is not running).
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const W = () => root.AIBWsl || null;
  const SET = () => root.AgentSettingsUI || null;

  const LEAD =
    'Run Claude Code, Codex and the other ACP agents inside your WSL distros, next to your Windows agents, all on this PC. AIB ' +
    'installs them into its own folder in each distro (~/.aib-server), with the versions it reviewed.';
  const KEEP =
    'A distro keeps running while a WSL project is open or a WSL chat works, also after you quit AIB. When nothing works, AIB ' +
    'lets go and WSL stops it by its own rules.';
  const NO_WSL =
    'WSL is not installed on this PC. With it, AIB runs agents in Linux on this PC, in projects inside a distro, next to your ' +
    'Windows agents. Install it in an administrator PowerShell, then restart Windows:';
  const NO_DISTRO =
    'WSL is on this PC, but it has no Linux distro yet. Install Ubuntu in PowerShell, then open it once to make your Linux user:';
  const WSL_DOCS = 'https://learn.microsoft.com/windows/wsl/install';
  const NAMES = { claude: ['Claude Code', 'C'], codex: ['Codex', 'X'], omp: ['OMP', 'O'] };
  const ORDER = ['claude', 'codex', 'omp'];
  // The vendors' own terminal commands (owner decision 3a): shown to copy with their docs, never installed by AIB.
  const CLI = {
    claude: { cmd: 'claude', install: 'curl -fsSL https://claude.ai/install.sh | bash', docs: 'https://code.claude.com/docs/en/setup' },
    codex: { cmd: 'codex', install: 'npm install -g @openai/codex', docs: 'https://developers.openai.com/codex/cli' },
  };
  const STAGES = {
    preparing: 'Getting ready…',
    downloading: 'Downloading and unpacking…',
    verifying: 'Checking the install…',
  };
  const STALE_MS = 60000;
  // The distro the page shows: remembered in the data folder with the other view choices (view-prefs.js).
  const PICK_KEY = 'aib-wsl-distro';
  const MIN_NODE = '22.19';
  const MANAGERS = { asdf: 'asdf', mise: 'mise', nvm: 'nvm', system: 'the system', aib: 'AIB' };
  // A version manager's shim with no Node.js version set (owner rule: never offer nvm then): the manager's own commands, to copy.
  // asdf 0.16 (its Go rewrite) replaced `asdf global` with `asdf set -u` (asdf-vm.com/guide/upgrading-to-v0-16.html): the helper
  // reports asdf's version (node.managerVersion) and the page shows that generation's command; without it, both, each labelled.
  const ASDF_MODERN = 'asdf install nodejs latest && asdf set -u nodejs latest';
  const ASDF_LEGACY = 'asdf install nodejs latest && asdf global nodejs latest';
  const MISE_FIX = 'mise use -g node@lts';
  // [label, command] rows; label '' when only one generation's command applies.
  function shimFix(n) {
    if (n.manager === 'mise') return [['', MISE_FIX]];
    if (n.manager !== 'asdf') return [];
    const m = /^(\d+)\.(\d+)/.exec(String(n.managerVersion || ''));
    if (!m) return [
      ['asdf 0.16 or newer:', ASDF_MODERN],
      ['asdf 0.15 or older:', ASDF_LEGACY],
    ];
    const modern = Number(m[1]) > 0 || Number(m[2]) >= 16;
    return [['', modern ? ASDF_MODERN : ASDF_LEGACY]];
  }
  // git and curl are system packages: the copy-only install line for the distro's package manager family (env.prereqs pkgManager;
  // an older helper leaves it out: apt, as before). '' for 'unknown'.
  function pkgLine(pm, pkg) {
    const p = pm || 'apt';
    if (p === 'apt' || p === 'dnf' || p === 'yum' || p === 'zypper') return 'sudo ' + p + ' install ' + pkg;
    if (p === 'pacman') return 'sudo pacman -S ' + pkg;
    if (p === 'apk') return 'sudo apk add ' + pkg;
    return '';
  }
  // Where each agent keeps its sign-in in the distro: Uninstall never touches these.
  const SIGNIN_FILES = { claude: '~/.claude', codex: '~/.codex' };
  const ENV_MODES = {
    'login-interactive': 'login shell (interactive)',
    login: 'login shell (non-interactive)',
    plain: 'plain shell, without your login profile',
  };

  const lists = new Map(); // distro key -> {value, at, busy, error}: the last peek answer of its agents
  const needs = new Map(); // distro key -> {value, at, busy, error}: the last peek answer of its prerequisites
  const starting = new Map(); // distro key -> '' while "Start and check" runs, or the error it ended with
  const enabledWant = new Map(); // card key -> the switch's new value while its save is on its way (drawn at once)
  const rowNotes = new Map(); // card key -> {text, cls}: a switch that could not be saved, an uninstall refused
  const uninstalling = new Set(); // card keys whose uninstall runs
  const terms = new Map(); // panel key -> {node, status, run, running}: the terminal panels on the cards, kept across repaints
  const aibs = new Map(); // distro key -> {value, at, busy, error}: the last peek answer of "AIB in <distro>" (GET /api/live/wsl/aib)
  const removing = new Map(); // distro key -> 'checking' | 'applying' while a Remove question or the removal itself runs
  const removedNow = new Set(); // distro keys this page removed AIB from, until a status read after it says so itself
  const leftovers = new Map(); // distro key -> {message, left}: what a removal could not delete, shown until Set up again
  let removeBox = null; // the open Remove dialog: {key, box, close}
  let wired = false,
    lastSig = '',
    focusWant = '', // a card to bring into view once it is drawn ("Set up Ubuntu in Settings")
    pick = '', // the distro shown now
    projectSeen = null; // the open project's distro when the pick was last made from it

  // ---- small parts -----------------------------------------------------------------------------------------------------
  const note = (text, cls) => el('p', text, 'st-note' + (cls ? ' ' + cls : ''));
  function card(title) {
    const c = el('section', null, 'st-card');
    c.append(el('h3', title, 'st-card-title'));
    return c;
  }
  function button(text, onClick, cls, title) {
    const b = el('button', text, cls || '');
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
  function copyRow(text, label) {
    const line = el('div', null, 'st-beta-row st-beta-command');
    const copy = button('Copy', () => {
      try {
        const p = root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText(text);
        Promise.resolve(p).then(
          () => (copy.textContent = 'Copied'),
          () => {},
        );
      } catch {
        /* no clipboard: the command stays selectable */
      }
    }, 'st-link');
    if (label) copy.setAttribute('aria-label', label);
    line.append(el('code', text, 'st-command'), copy);
    return line;
  }
  function externalLink(text, href) {
    const a = el('a', text, 'st-link st-beta-docs');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  function facts(rows) {
    const dl = el('dl', null, 'st-facts wl-facts');
    for (const [k, v] of rows) if (v) dl.append(el('dt', k), el('dd', v));
    return dl;
  }
  const actions = (...items) => {
    const a = el('div', null, 'st-actions');
    for (const x of items) if (x) a.append(x);
    return a;
  };
  const letterOf = (name) => String(name || '?').charAt(0).toUpperCase();
  const cardKey = (d, a) => 'wsl:' + d.key + ':' + a.id;
  const needsKey = (d) => 'wsl:' + d.key + ':needs';

  // ---- state and repaint -----------------------------------------------------------------------------------------------
  function redraw() {
    const S = SET();
    if (S && S.showing && S.showing('wsl-linking')) S.redraw();
  }
  const statusOf = () => (W() ? W().status() : { distros: [] });
  // Only what this section draws: the 5 s poll repaints nothing when nothing here changed.
  function signature(st) {
    return JSON.stringify([
      (st.distros || []).map((d) => [d.key, d.name, d.state, d.line, d.helper, d.home, d.problem, d.isDefault, d.removed === true]),
      st.skipped || [],
      st.wsl || null,
    ]);
  }
  const notReadyAnswer = (rec) => !!(rec && rec.value && rec.value.state && rec.value.state !== 'ready');
  function wire() {
    if (wired || !W()) return;
    wired = true;
    W().onChange((st) => {
      const sig = signature(st || {});
      if (sig === lastSig) return;
      lastSig = sig;
      // a distro that became ready since its list was asked: ask again (still peek)
      for (const d of (st && st.distros) || []) {
        if (d.state !== 'ready') continue;
        if (notReadyAnswer(lists.get(d.key))) fetchList(d.key);
        if (notReadyAnswer(needs.get(d.key))) fetchNeeds(d.key);
        if (notReadyAnswer(aibs.get(d.key))) fetchAib(d.key);
      }
      redraw();
    });
    if (W().onJob)
      W().onJob((key, _id, job) => {
        // finished, cancelled or failed: the distro's list says what is there now
        if (!job || job.state === 'failed') fetchList(key, { force: false });
        redraw();
      });
  }
  /** The distro's agents, peek only (never starts it); opts.start only from the "Start and check" click. */
  function fetchList(key, opts) {
    const o = opts || {};
    const Wsl = W();
    if (!Wsl || !Wsl.peekAgents) return Promise.resolve(null);
    const rec = lists.get(key) || { value: null, at: 0, busy: false, error: '' };
    if (rec.busy && !o.start && !o.force) return Promise.resolve(rec.value);
    rec.busy = true;
    lists.set(key, rec);
    return Wsl.peekAgents(key, o)
      .then(
        (value) => {
          rec.value = value;
          rec.error = '';
          for (const a of value.agents || []) if (a && a.job && Wsl.trackJob) Wsl.trackJob(key, a.id, a.job);
          return value;
        },
        (error) => {
          rec.error = (error && error.message) || 'The agents in this distro could not be read.';
          return null;
        },
      )
      .finally(() => {
        rec.busy = false;
        rec.at = Date.now();
        redraw();
      });
  }
  /** The distro's prerequisites (GET /api/live/wsl/prereqs, peek only); force: the distro reads its login PATH again. */
  function fetchNeeds(key, opts) {
    const o = opts || {};
    const Wsl = W();
    if (!Wsl || !Wsl.peekPrereqs) return Promise.resolve(null);
    const rec = needs.get(key) || { value: null, at: 0, busy: false, error: '' };
    if (rec.busy && !o.force) return Promise.resolve(rec.value);
    rec.busy = true;
    needs.set(key, rec);
    return Wsl.peekPrereqs(key, { force: !!o.force })
      .then(
        (value) => {
          rec.value = value;
          rec.error = '';
          return value;
        },
        (error) => {
          rec.error = (error && error.message) || 'What this distro has could not be read.';
          return null;
        },
      )
      .finally(() => {
        rec.busy = false;
        rec.at = Date.now();
        redraw();
      });
  }
  /** What AIB keeps in the distro (GET /api/live/wsl/aib, peek only: never starts it); force: measure again (Refresh). */
  function fetchAib(key, opts) {
    const o = opts || {};
    const Wsl = W();
    if (!Wsl || !Wsl.peekAib) return Promise.resolve(null);
    const rec = aibs.get(key) || { value: null, at: 0, busy: false, error: '' };
    if (rec.busy && !o.force) return Promise.resolve(rec.value);
    rec.busy = true;
    aibs.set(key, rec);
    return Wsl.peekAib(key, { force: !!o.force })
      .then(
        (value) => {
          rec.value = value;
          rec.error = '';
          return value;
        },
        (error) => {
          rec.error = (error && error.message) || 'What AIB keeps in this distro could not be read.';
          return null;
        },
      )
      .finally(() => {
        rec.busy = false;
        rec.at = Date.now();
        redraw();
      });
  }
  /** AIB was removed from the distro: by this page just now, or the status says so (state 'off', removed: true). */
  const isRemoved = (d) => removedNow.has(d.key) || (d.removed === true && d.state !== 'ready');
  /** Node.js in the distro: true (ok), false (missing, too old, no version set, broken) or null (not known yet). */
  function nodeOk(key) {
    const rec = needs.get(key);
    const p = rec && rec.value && rec.value.prereqs;
    return p && p.node ? p.node.state === 'ok' : null;
  }
  function startDistro(d) {
    starting.set(d.key, '');
    redraw();
    return fetchList(d.key, { start: true }).then((value) => {
      const rec = lists.get(d.key);
      starting.set(d.key, value || !rec ? '' : rec.error);
      if (!starting.get(d.key)) starting.delete(d.key);
      const Wsl = W();
      return Promise.resolve(Wsl && Wsl.refresh ? Wsl.refresh() : null).then(redraw);
    });
  }

  // ---- which distro the page shows -------------------------------------------------------------------------------------
  function readPick() {
    try {
      return String((root.localStorage && root.localStorage.getItem(PICK_KEY)) || '');
    } catch {
      return '';
    }
  }
  function savePick(key) {
    try {
      if (root.localStorage) root.localStorage.setItem(PICK_KEY, key);
    } catch {
      /* not remembered: the page still shows it now */
    }
  }
  // The open project's distro when it changed since the last look (a Debian project open: Debian); else the distro shown already,
  // else the remembered choice, else WSL's default distro, else the first usable one.
  function chosen(st) {
    const usable = (st.distros || []).map((d) => d.key);
    const Wsl = W();
    const project = Wsl && Wsl.currentKey ? Wsl.currentKey() : '';
    if (project !== projectSeen) {
      projectSeen = project;
      if (project && usable.includes(project)) pick = project;
    }
    if (pick && usable.includes(pick)) return pick;
    const saved = readPick(),
      def = (st.distros || []).find((d) => d.isDefault);
    pick = usable.includes(saved) ? saved : def ? def.key : usable[0] || '';
    return pick;
  }
  function choose(key) {
    if (!key) return;
    pick = key;
    savePick(key);
    focusWant = '';
    redraw();
  }
  function picker(st, key) {
    const wrap = el('label', null, 'st-field wl-pick');
    const sel = el('select');
    sel.setAttribute('aria-label', 'The distro this page shows');
    for (const d of st.distros || []) {
      const o = el('option', d.name + (d.isDefault ? ' (WSL default)' : ''));
      o.value = d.key;
      sel.append(o);
    }
    // the ones AIB cannot use: listed, off, with the reason (the overview card says the same, with the WSL 1 command)
    for (const s of st.skipped || []) {
      const o = el('option', s.name + ' (not supported' + (s.why ? ': ' + String(s.why).replace(/\.$/, '') : '') + ')');
      o.value = '';
      o.disabled = true;
      sel.append(o);
    }
    sel.value = key;
    sel.addEventListener('change', () => choose(sel.value));
    wrap.append(el('span', 'Distro', 'st-label'), sel);
    return wrap;
  }

  // ---- "WSL on this PC" ------------------------------------------------------------------------------------------------
  const CHIPS = {
    ready: ['Ready', 'ok'],
    off: ['Not running', 'dim'],
    starting: ['Starting', 'warn'],
    installing: ['Starting', 'warn'],
    reconnecting: ['Starting', 'warn'],
    stopped: ['Stopped', 'bad'],
    unavailable: ['Problem', 'bad'],
  };
  const chipOf = (d) => CHIPS[d.state] || ['Not running', 'dim'];
  const isWsl1 = (s) => /\bWSL ?1\b|version 1\b/i.test(String((s && (s.why || s.version)) || '')) || (s && s.version === 1);
  function overview(st) {
    const c = card('WSL on this PC');
    c.dataset.wsl = 'overview';
    c.className += ' wl-overview';
    c.append(note(LEAD, 'wl-lead'));
    for (const d of st.distros || []) {
      const row = el('div', null, 'st-agent wl-distro');
      const head = el('div', null, 'st-agent-head');
      const [chip, cls] = isRemoved(d) ? ['Not set up', 'dim'] : chipOf(d);
      head.append(
        el('span', letterOf(d.name), 'st-letter'),
        el('strong', d.name),
        el('span', 'WSL 2' + (d.isDefault ? ' · WSL default' : ''), 'st-tag'),
        el('span', chip, 'st-status ' + cls),
      );
      row.append(head);
      c.append(row);
    }
    for (const s of st.skipped || []) {
      const row = el('div', null, 'st-agent wl-distro');
      const head = el('div', null, 'st-agent-head');
      head.append(el('span', letterOf(s.name), 'st-letter'), el('strong', s.name));
      if (isWsl1(s)) head.append(el('span', 'WSL 1', 'st-tag'));
      head.append(el('span', 'Not supported', 'st-status dim'));
      row.append(head);
      if (s.why) row.append(note(s.why, 'dim'));
      if (isWsl1(s)) {
        const how = el('div', null, 'st-beta-install');
        how.append(
          el('span', 'AIB needs WSL 2. Convert it in PowerShell (takes a few minutes; back it up first):', 'st-hint'),
          copyRow('wsl --set-version ' + s.name + ' 2', 'Copy the command that converts ' + s.name + ' to WSL 2'),
        );
        row.append(how);
      }
      c.append(row);
    }
    c.append(note(KEEP));
    return c;
  }
  function noWslCard(st) {
    const c = card('WSL on this PC');
    c.dataset.wsl = 'none';
    const wsl = st.wsl || null;
    const hasExe = !!(wsl && wsl.exe);
    c.append(note(hasExe ? NO_DISTRO : NO_WSL));
    c.append(copyRow(hasExe ? 'wsl --install -d Ubuntu' : 'wsl --install', 'Copy the command that installs WSL'));
    if (wsl && wsl.problem) c.append(note(wsl.problem, 'bad'));
    c.append(
      actions(
        externalLink('How to install WSL (Microsoft)', WSL_DOCS),
        button('Check again', () => Promise.resolve(W() && W().refresh()).then(redraw), 'st-link'),
      ),
    );
    return c;
  }

  // ---- one distro --------------------------------------------------------------------------------------------------------
  function distroCard(d) {
    if (isRemoved(d)) return removedCard(d);
    const c = card(d.name);
    c.dataset.distro = d.key;
    const Wsl = W();
    if (d.state === 'ready') {
      c.append(facts([['State', 'Ready'], ['AIB helper', d.helper || ''], ['Home', d.home || '']]));
      if (d.problem) c.append(note(d.problem, 'bad'));
    } else if (d.state === 'off') {
      c.append(facts([['State', 'Not running']]));
      c.append(note(d.name + ' is not running. AIB starts it when a WSL project needs it. Its agents show here once it runs.'));
      const busy = starting.has(d.key) && starting.get(d.key) === '';
      const what =
        'Starts ' + d.name + ', copies AIB\'s helper there the first time (about 100 MB, into ~/.aib-server) and starts it.';
      const go = button(
        busy ? 'Starting ' + d.name + '…' : 'Start ' + d.name + ' and check',
        () => startDistro(d),
        'primary',
        what,
      );
      go.disabled = busy;
      c.append(note(what + ' Then AIB looks at the agents in ' + d.name + '.', 'dim'));
      c.append(actions(go));
      const err = starting.get(d.key);
      if (err) c.append(note(err, 'bad'));
    } else if (d.state === 'stopped' || d.state === 'unavailable') {
      c.append(facts([['State', d.state === 'stopped' ? 'Stopped' : 'Problem'], ['AIB helper', d.helper ? d.helper + ' (not running)' : '']]));
      c.append(
        note(
          d.state === 'stopped'
            ? d.name + ' stopped (Windows restart or wsl --shutdown). Chats in ' + d.name + ' stopped with it; their history is kept.'
            : d.problem || d.line || d.name + ' cannot be reached.',
          'bad',
        ),
      );
      const re = button(
        'Reconnect',
        () => {
          re.disabled = true;
          Promise.resolve(Wsl && Wsl.reconnect(d.key)).then(redraw, redraw);
        },
        'primary',
        'Start ' + d.name + ' and connect AIB to it again',
      );
      c.append(actions(re));
    } else {
      c.append(facts([['State', 'Starting']]));
      if (d.line) c.append(note(d.line));
    }
    return c;
  }

  // ---- terminal panels on the cards (the Windows card's setup panel: settings-ui.js startSetup) ----------------------------
  function closePanel(key, paint) {
    const entry = terms.get(key);
    if (!entry) return;
    terms.delete(key);
    try {
      if (entry.run) entry.run.close();
    } catch {
      /* already closed */
    }
    if (entry.node && entry.node.remove) entry.node.remove();
    if (paint) redraw();
  }
  /** A panel (title, Close, the terminal, a status line) under `key`; replaces the one there. */
  function openPanel(key, title) {
    closePanel(key);
    const node = el('div', null, 'st-beta-term');
    const head = el('div', null, 'st-beta-term-head');
    head.append(el('span', title, 'st-beta-term-title'), button('Close', () => closePanel(key, true), 'st-link'));
    const view = el('div', null, 'st-beta-term-view');
    const status = el('p', 'Starting…', 'st-note');
    status.setAttribute('role', 'status');
    node.append(head, view, status);
    const entry = { node, view, status, run: null, running: true };
    terms.set(key, entry);
    redraw();
    return entry;
  }
  const say = (entry, text, cls) => {
    entry.status.textContent = text;
    entry.status.className = 'st-note' + (cls ? ' ' + cls : '');
  };
  const panelRunning = (key) => !!terms.get(key) && terms.get(key).running;
  /** "Open Ubuntu terminal": a shell in the distro's home, in the card's panel (the new-chat panel's wsl-shell terminal). */
  function canOpenShell(d) {
    const T = root.AibTerminal;
    return !!(T && T.runSignin && T.socketUrl && W() && W().refOf);
  }
  function openShell(d, key) {
    const T = root.AibTerminal;
    const entry = openPanel(key, 'A terminal in ' + d.name);
    const home = d.home || '/';
    entry.run = T.runSignin(entry.view, 'shell', {
      url: (loc, cols, rows) => T.socketUrl(loc, 'wsl-shell:' + d.key, W().refOf(d.key, home), cols, rows),
      onReady: () => say(entry, 'A terminal in ' + d.name + '. AIB does not see what you type here.'),
      onExit: () => {
        entry.running = false;
        say(entry, 'The terminal ended.');
        fetchNeeds(d.key, { force: true });
      },
      onError: (message) => {
        entry.running = false;
        say(entry, message, 'bad');
      },
    });
  }
  function shellButton(d) {
    return canOpenShell(d) ? button('Open ' + d.name + ' terminal', () => openShell(d, needsKey(d))) : null;
  }
  /** "Install Node.js in Ubuntu": nvm's official installer, pinned by the server, in the card's panel (setup=wsl-node&distro=). */
  function installNode(d) {
    const T = root.AibTerminal,
      key = needsKey(d);
    if (!T || !T.runSetup) {
      rowNotes.set(key, { text: 'The terminal is not available on this page.', cls: 'bad' });
      return redraw();
    }
    rowNotes.delete(key);
    const entry = openPanel(key, 'Installing Node.js in ' + d.name + ': nvm\'s official installer, then nvm install --lts');
    entry.run = T.runSetup(entry.view, 'wsl-node', 'node', {
      distro: d.key,
      onReady: () => say(entry, 'Installing. Answer here if the installer asks something.'),
      onExit: (code) => {
        entry.running = false;
        if (code !== 0) {
          say(entry, 'Install failed. See the output above.', 'bad');
          return redraw();
        }
        say(entry, 'Installed. Checking…');
        return fetchNeeds(d.key, { force: true }).then(() => {
          fetchList(d.key, { force: true }); // the agent rows: Install is offered now
          if (nodeOk(d.key)) {
            if (terms.get(key) === entry) closePanel(key, true);
          } else {
            say(
              entry,
              'The install finished, but AIB does not see Node.js in ' + d.name + ' yet. Choose Check again, or open a new ' +
                d.name + ' terminal and look.',
              'warn',
            );
            redraw();
          }
        });
      },
      onError: (message) => {
        entry.running = false;
        say(entry, message, 'bad');
        redraw();
      },
    });
  }

  // ---- "What Ubuntu needs" -----------------------------------------------------------------------------------------------
  function check(ok, title, state, extra) {
    const li = el('li', null, ok ? 'ok' : 'bad');
    const head = el('div', null, 'dv-check-head');
    head.append(el('span', ok ? '✓' : '!', 'dv-mark'), el('span', title), el('span', state, 'wl-state'));
    li.append(head);
    for (const n of extra || []) if (n) li.append(n);
    return li;
  }
  const againButton = (d) => button('Check again', () => fetchNeeds(d.key, { force: true }), 'st-link');
  const sizeText = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1).replace(/\.0$/, '') + ' GB' : Math.round(mb) + ' MB');
  function nodeCheck(d, p) {
    const n = p.node || { state: 'missing' },
      name = d.name;
    const mgr = MANAGERS[n.manager] || '';
    const via = mgr && n.manager !== 'system' ? ' (' + mgr + ')' : '';
    const title = 'Node.js ' + MIN_NODE + ' or newer';
    if (n.state === 'ok')
      return check(true, title, 'found ' + (n.version || '') + via, [n.path ? note(n.path, 'dim wl-path') : null]);
    const extra = [];
    let state = 'missing';
    if (n.state === 'shim_unset') {
      // a version manager's shim with no version set: its own command, never nvm
      const who = mgr || 'your version manager';
      state = mgr ? mgr + ' has no Node.js version set' : 'no Node.js version set';
      extra.push(
        note(
          'Node.js in ' + name + ' comes from ' + who + ', and ' + who + ' has no Node.js version set, so node does not run. ' +
            'Set one in ' + name + ' (no password needed), then choose Check again:',
        ),
      );
      for (const [label, cmd] of shimFix(n)) {
        if (label) extra.push(note(label, 'dim'));
        extra.push(copyRow(cmd, 'Copy the command that sets a Node.js version in ' + mgr));
      }
      if (n.note) extra.push(note(n.note, 'dim'));
      if (p.nodeInstallBlocked) extra.push(note(p.nodeInstallBlocked, 'dim'));
      extra.push(actions(shellButton(d), againButton(d)));
      return check(false, title, state, extra);
    }
    if (n.state === 'old') state = 'too old' + (n.version ? ' (' + n.version + ')' : '');
    else if (n.state === 'broken') state = 'found, but it does not run';
    extra.push(
      note(
        n.state === 'old'
          ? 'AIB needs Node.js ' + MIN_NODE + ' or newer in ' + name + ' to install Claude Code, Codex and the other npm agents.'
          : n.state === 'broken'
            ? 'The node program in ' + name + (n.path ? ' (' + n.path + ')' : '') + ' does not run.'
            : 'Needed to install Claude Code, Codex and the other npm agents in ' + name + '.',
      ),
    );
    if (n.note) extra.push(note(n.note, 'dim'));
    if (p.canInstallNode) {
      extra.push(
        note(
          'Install runs nvm\'s official installer in a terminal here, in ' + name + ', then installs the current LTS Node.js. ' +
            'It adds nvm to your home folder and shell start-up file; it needs no password.' +
            (p.nvm && p.nvm.present ? ' nvm is already in ' + name + '; it is used.' : ''),
        ),
      );
      const go = button('Install Node.js in ' + name, () => installNode(d), 'primary');
      go.disabled = panelRunning(needsKey(d));
      extra.push(actions(go, againButton(d)));
    } else {
      if (p.nodeInstallBlocked) extra.push(note(p.nodeInstallBlocked, 'bad'));
      extra.push(actions(shellButton(d), againButton(d)));
    }
    return check(false, title, state, extra);
  }
  // git and curl are system packages: the command to copy, never run by AIB (it would need the person's password).
  function pkgCheck(d, title, what, pkg, version, pm) {
    const ok = what.state === 'ok';
    if (ok) return check(true, title, 'found' + (what.version ? ' ' + what.version : ''));
    const line = pkgLine(pm, pkg);
    if (!line)
      return check(false, title, 'missing', [
        note(version + ' Install ' + pkg + ' with your distro\'s package manager in ' + d.name + ' (AIB does not run it).'),
        actions(shellButton(d), againButton(d)),
      ]);
    return check(false, title, 'missing', [
      note(version + ' It needs your password, so AIB does not run it. Run it yourself in ' + d.name + ':'),
      copyRow(line, 'Copy the command that installs ' + pkg),
      actions(shellButton(d), againButton(d)),
    ]);
  }
  function needsCard(d) {
    const c = card('What ' + d.name + ' needs');
    c.dataset.needs = d.key;
    let rec = needs.get(d.key);
    const stale = !rec || (!rec.busy && Date.now() - rec.at > (notReadyAnswer(rec) ? 5000 : STALE_MS));
    if (stale) {
      fetchNeeds(d.key);
      rec = needs.get(d.key);
    }
    const value = rec && rec.value;
    const p = value && value.prereqs;
    if (rec && rec.error && !value) {
      const line = note('What ' + d.name + ' has could not be read: ' + rec.error, 'bad');
      line.append(' ', againButton(d));
      c.append(line);
    } else if (!value) c.append(note('Looking at what ' + d.name + ' has…'));
    else if (!p) c.append(note(value.line || d.name + ' is not ready yet.'));
    else {
      c.append(note('AIB looks in ' + d.name + '\'s login shell, the way your terminal there sees it. It installs nothing by itself.'));
      const ul = el('ul', null, 'dv-checks wl-checks');
      ul.append(nodeCheck(d, p));
      const npm = p.npm || { state: 'missing' };
      ul.append(
        npm.state === 'ok'
          ? check(true, 'npm', 'found' + (npm.version ? ' ' + npm.version : ''))
          : check(false, 'npm', 'missing', [
              note(
                'npm was not found next to Node.js in ' + d.name + '. It comes with Node.js' +
                  (p.canInstallNode ? ': Install Node.js above brings it.' : '.'),
              ),
            ]),
      );
      ul.append(
        pkgCheck(d, 'git', p.git || { state: 'missing' }, 'git', 'Needed for a chat\'s own copy, Changes and Merge; until then chats work in the project folder.', p.pkgManager),
        pkgCheck(d, 'curl', p.curl || { state: 'missing' }, 'curl', 'Needed by nvm\'s installer and the vendors\' install scripts.', p.pkgManager),
      );
      const mb = p.diskFreeMB;
      if (typeof mb !== 'number') ul.append(check(true, 'Free space in your home folder', 'not known'));
      else if (mb >= 1024) ul.append(check(true, 'Free space in your home folder', sizeText(mb) + ' free'));
      else
        ul.append(
          check(false, 'Free space in your home folder', sizeText(mb) + ' free', [
            note('Installs need room in ' + d.name + ': Claude Code about 1 GB, Codex about 600 MB.'),
          ]),
        );
      c.append(ul);
      const mode = ENV_MODES[p.envMode] || ENV_MODES.plain;
      const shell = p.loginShell && p.envMode !== 'plain' ? String(p.loginShell).replace(/^.*\//, '') + ' ' : '';
      const how = note(
        'Checked with: ' + shell + mode + '.' +
          (p.envMode === 'plain' ? ' A version manager set up only in your shell profile is not seen this way.' : '') + ' ',
        'dim wl-checked',
      );
      how.append(againButton(d));
      c.append(how);
    }
    const msg = rowNotes.get(needsKey(d));
    if (msg) c.append(note(msg.text, msg.cls));
    const t = terms.get(needsKey(d));
    if (t) c.append(t.node);
    return c;
  }

  // ---- "Agents in Ubuntu" ----------------------------------------------------------------------------------------------
  // The distro's agent row in the shape agentRow reads (the Windows card's name and letter; the distro's own On/Off).
  function toAgent(d, row) {
    const S = SET();
    const win = ((S && S.agentList && S.agentList()) || []).find((x) => x && x.id === row.id) || null;
    const known = NAMES[row.id] || [row.id, letterOf(row.id)];
    const k = 'wsl:' + d.key + ':' + row.id;
    return {
      id: row.id,
      name: (win && win.name) || known[0],
      letter: (win && win.letter) || known[1],
      builtin: true,
      beta: false,
      enabled: enabledWant.has(k) ? enabledWant.get(k) : row.enabled !== false,
      found: !!row.found,
      version: row.version || '',
      installable: !!(row.installable || row.canInstall),
      update: !!row.update,
      pinned: row.pinned || '',
      managed: !!(row.managed || row.source === 'studio'),
      installBlock: (!row.found || row.update ? row.installBlock || row.blocked : '') || '',
      nodeInstall: row.nodeInstall || '',
      installCommand: row.install || '',
      wslNote: row.note || '',
      bundledCli: row.bundledCli === true,
      signin: row.signin && typeof row.signin === 'object' ? row.signin : null,
      canUninstall: row.canUninstall === true,
      limits: row.limits || null,
    };
  }
  /** The distro's own switch: drawn at once, saved (POST /api/live/wsl/agents/enabled), put back with a line when it fails. */
  function setEnabled(d, a, on) {
    const k = cardKey(d, a),
      Wsl = W();
    enabledWant.set(k, !!on);
    rowNotes.delete(k);
    redraw();
    return Promise.resolve()
      .then(() => Wsl.setAgentEnabled(d.key, a.id, !!on))
      .then((r) => {
        if (!r || r.ok === false) throw Error((r && (r.message || r.error)) || '');
        const rec = lists.get(d.key);
        const row = rec && rec.value && (rec.value.agents || []).find((x) => x && x.id === a.id);
        if (row) row.enabled = typeof r.enabled === 'boolean' ? r.enabled : !!on;
      })
      .catch((error) => {
        const why = (error && error.message) || '';
        rowNotes.set(k, {
          text:
            'The switch could not be saved' + (why ? ': ' + why.replace(/\.$/, '') : '') + '. ' + a.name + ' stays ' +
            (on ? 'off' : 'on') + ' in ' + d.name + '.',
          cls: 'bad',
        });
      })
      .finally(() => {
        enabledWant.delete(k);
        redraw();
      });
  }
  function uninstallQuestion(d, a) {
    const files = SIGNIN_FILES[a.id];
    return (
      'Uninstall ' + a.name + ' from ' + d.name + '? This deletes only the copy AIB installed there (~/.aib-server/agents/' +
      a.id + '). Your own installs of ' + a.name + ' and your sign-in' + (files ? ' in ' + files : ' files') + ' in ' + d.name +
      ' stay. To use ' + a.name + ' in ' + d.name + ' again, install it again here.'
    );
  }
  function uninstall(d, a) {
    const k = cardKey(d, a),
      Wsl = W();
    rowNotes.delete(k);
    const ok = typeof root.confirm === 'function' ? root.confirm(uninstallQuestion(d, a)) : false;
    if (!ok) return redraw();
    uninstalling.add(k);
    redraw();
    return Promise.resolve()
      .then(() => Wsl.uninstallAgent(d.key, a.id))
      .then(
        (r) => {
          if (!r || r.ok === false || r.blocked)
            rowNotes.set(k, { text: (r && (r.blocked || r.message)) || a.name + ' could not be uninstalled.', cls: 'bad' });
          return fetchList(d.key, { force: true });
        },
        (error) => rowNotes.set(k, { text: (error && error.message) || a.name + ' could not be uninstalled.', cls: 'bad' }),
      )
      .finally(() => {
        uninstalling.delete(k);
        redraw();
      });
  }
  /** Sign in: the agent's own login in a distro terminal on its card (signin=<agent>&distro=<d>; start=1 only when not running). */
  function signIn(d, a) {
    const T = root.AibTerminal,
      k = cardKey(d, a);
    if (!T || !T.runSignin) {
      rowNotes.set(k, { text: 'The terminal is not available on this page.', cls: 'bad' });
      return redraw();
    }
    rowNotes.delete(k);
    const now = W() && W().distro ? W().distro(d.key) : null;
    const start = !now || now.state !== 'ready';
    const entry = openPanel(k, 'Signing in to ' + a.name + ' in ' + d.name);
    entry.run = T.runSignin(entry.view, a.id, {
      distro: d.key,
      start,
      onReady: () =>
        say(entry, 'Finish the sign-in in this terminal; its page opens in your Windows browser. AIB does not see what you type here.'),
      onExit: (code) => {
        entry.running = false;
        if (code === 0) {
          say(entry, 'The sign-in finished. Checking…');
          fetchList(d.key, { force: true }).then(() => {
            if (terms.get(k) === entry) closePanel(k, true);
          });
        } else {
          say(entry, 'The sign-in did not finish (it ended with code ' + code + '). Try again.', 'bad');
          redraw();
        }
      },
      onError: (message) => {
        entry.running = false;
        say(entry, message, 'bad');
        redraw();
      },
    });
  }
  function statusText(d, a) {
    const job = W() ? W().installJob(d.key, a.id) : null;
    if (job && job.state === 'failed') return { text: 'Install failed', cls: 'bad' };
    if (!a.found) return { text: 'Not installed', cls: 'warn' };
    if (a.update) return { text: 'Update available', cls: 'warn' };
    const s = a.signin && a.signin.state;
    if (s === 'signed_in') return { text: 'Signed in', cls: 'ok' };
    if (s === 'signed_out') return { text: 'Not signed in', cls: 'warn' };
    return a.managed ? { text: 'Installed', cls: 'ok' } : { text: 'Found', cls: 'ok' };
  }
  function envFor(d) {
    const S = SET(),
      Wsl = W(),
      name = d.name;
    const jobOf = (a) => (Wsl ? Wsl.installJob(d.key, a.id) : null);
    const verb = (a) => (a.update ? 'Updating ' : 'Installing ');
    const needsNode = (a) => !!a.installBlock || nodeOk(d.key) === false;
    return S.makeEnv({
      key: (a) => cardKey(d, a),
      tag: (a) => (!a.found ? '' : a.managed ? 'Installed by AIB' : 'Your own install'),
      installOf: jobOf,
      installRunning: (a) => {
        const j = jobOf(a);
        return !!j && j.state === 'running';
      },
      statusText: (a) => statusText(d, a),
      // signed out; or not known for an agent whose sign-in AIB runs (Claude Code, Codex)
      canSignIn: (a) =>
        !!a.found &&
        !!a.signin &&
        (a.signin.state === 'signed_out' || (a.signin.state === 'unknown' && !!SIGNIN_FILES[a.id])) &&
        !panelRunning(cardKey(d, a)),
      startSignin: (a) => signIn(d, a),
      showCheck: (a) => a.found || !a.installable,
      checkAgain: () => fetchList(d.key, { force: true }),
      recheck: () => fetchList(d.key, { force: true }),
      canInstall: (a) => a.installable && (!a.found || a.update),
      installLabel: (a) => (a.update ? 'Update in ' : 'Install in ') + name,
      installOff: (a) => (needsNode(a) ? 'Needs Node.js first' : ''),
      installTitle: (a) =>
        'AIB installs ' + a.name + (a.pinned ? ' ' + a.pinned : '') + ' into its own folder in ' + name +
        ' (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in ' + name + ' changes.',
      startInstall: (a) => Wsl.startInstall(d.key, a.id),
      cancelInstall: (a) => Wsl.cancelInstall(d.key, a.id),
      installBlock: (a) => a.installBlock,
      progressLabel: (a) => verb(a) + a.name + ' in ' + name,
      progressText: (a, job) =>
        verb(a) + a.name + ' in ' + name + '… ' + (STAGES[job.stage] ? STAGES[job.stage] + ' ' : '') +
        'It goes on if you close Settings or restart AIB.',
      launcherLine: (a) => (a.found && a.version ? ['Version', a.version] : null),
      terminal: (a) => terms.get(cardKey(d, a)) || null,
      toggle: true,
      toggleLabel: () => 'Use in ' + name,
      onToggle: (a, on) => setEnabled(d, a, on),
      sharedKey: true,
      canUninstall: (a) => a.canUninstall && !uninstalling.has(cardKey(d, a)),
      uninstall: (a) => uninstall(d, a),
      extraLines: (a, row, at) => extraLines(d, a, row, at),
    });
  }
  // Codex's usage limits in this distro (its own ~/.codex, never Windows'), in the composer's Limits chip words.
  function limitsLine(d, a) {
    const C = root.AgentComposerChips;
    const lim = a.limits && C && C.describeLimits ? C.describeLimits(a.limits, Date.now()) : null;
    if (!lim) return null;
    const line = el('p', null, 'wl-limits');
    const ago = (lim.details || []).find((x) => /^Updated /.test(x));
    line.append(
      'Usage limits of ' + d.name + '\'s ' + a.name + ' sign-in: ',
      el('b', lim.value),
      (ago ? ' (' + ago.charAt(0).toLowerCase() + ago.slice(1) + ')' : '') +
        '. Same ChatGPT account as on Windows means the same limits.',
    );
    line.title = (lim.details || []).join('\n');
    if (lim.tone) line.className += ' ' + lim.tone;
    return line;
  }
  function signinLine(d, a) {
    const s = a.signin;
    if (!s) return null;
    if (s.state === 'signed_in')
      return note('Signed in to ' + a.name + ' in ' + d.name + (s.account ? ' as ' + s.account : '') + '.', 'wl-signin');
    if (s.state === 'signed_out')
      return note(
        'Not signed in to ' + a.name + ' in ' + d.name + ' yet. Sign in runs ' + a.name + '\'s own sign-in in a ' + d.name +
          ' terminal here; its page opens in your Windows browser. ' + d.name + ' signs in separately from Windows. AIB does not ' +
          'see your password or sign-in details.',
        'wl-signin',
      );
    return note('Sign-in in ' + d.name + ': unknown' + (s.note ? ' (' + String(s.note).replace(/\.$/, '') + ')' : '') + '.', 'dim wl-signin');
  }
  // The distro's own lines on an agent card, after its status lines.
  function extraLines(d, a, row, at) {
    const k = cardKey(d, a),
      msg = rowNotes.get(k);
    if (at.running) {
      if (msg) row.append(note(msg.text, msg.cls));
      return;
    }
    const name = d.name,
      job = at.job,
      failed = !!job && (job.state === 'failed' || job.state === 'refused'),
      node = nodeOk(d.key);
    if (a.found) {
      const s = signinLine(d, a);
      if (s) {
        row.append(s);
        if (a.signin.note && a.signin.state !== 'unknown') row.append(note(a.signin.note, 'dim'));
      }
      if (a.id === 'codex') {
        const lim = limitsLine(d, a);
        if (lim) row.append(lim);
      }
    }
    if (uninstalling.has(k)) row.append(note('Uninstalling ' + a.name + ' from ' + name + '…', 'wl-busy'));
    if (msg) row.append(note(msg.text, msg.cls));
    // Node.js missing per the prerequisites while the row itself does not say it: point at the card above
    if (node === false && !a.installBlock && a.installable && (!a.found || a.update) && !failed)
      row.append(note('Needs Node.js first: see What ' + name + ' needs above.', 'dim'));
    // the row's own nvm line only while the prerequisites are not known (the card above has the button, and never offers nvm to
    // a version manager's shim)
    if (a.installBlock && a.nodeInstall && node === null) {
      const how = el('div', null, 'st-beta-install');
      how.append(
        el('span', 'Install Node.js in ' + name + ' yourself (nvm, no sudo needed), then choose Check again:', 'st-hint'),
        copyRow(a.nodeInstall, 'Copy the command that installs Node.js in ' + name),
      );
      row.append(how);
    }
    if (a.found && a.update && !failed)
      row.append(
        note(
          'AIB now uses ' + a.name + ' ' + a.pinned + '; ' + name + ' has ' + (a.version || 'an older one') +
            '. The old copy keeps working until the new one is complete.',
        ),
      );
    if (!a.found) {
      if (a.installable && !a.installBlock && node !== false && !failed)
        row.append(
          note(
            'One click: AIB installs ' + a.name + (a.pinned ? ' ' + a.pinned : '') + ' into its own folder in ' + name +
              ' (~/.aib-server/agents), with the versions it reviewed. Nothing else in ' + name + ' changes.',
          ),
        );
      if (!a.installable) {
        row.append(
          note(
            a.wslNote ||
              'AIB does not install ' + a.name + '. Install it in ' + name + ' as its docs say, then choose Check again.',
            'dim',
          ),
        );
      }
      if (a.installCommand) {
        const how = el('div', null, 'st-beta-install');
        how.append(
          el('span', a.installable ? 'Or install it yourself in ' + name + ':' : 'Install it in ' + name + ':', 'st-hint'),
          copyRow(a.installCommand, 'Copy the install command of ' + a.name),
        );
        row.append(how);
      }
    }
    const cli = CLI[a.id];
    if (cli && a.found) {
      if (a.bundledCli)
        row.append(
          note(
            'The standalone ' + cli.cmd + ' command is not needed: AIB chats use the copy that comes with ' + a.name + ' in ' +
              name + '.',
            'dim',
          ),
        );
      else {
        const how = el('div', null, 'st-beta-install');
        how.append(
          el(
            'span',
            'Optional: to use ' + a.name + ' in your own ' + name + ' terminal, install the ' + cli.cmd + ' command yourself:',
            'st-hint',
          ),
          copyRow(cli.install, 'Copy the command that installs the ' + cli.cmd + ' command'),
          externalLink(a.name + ' docs', cli.docs),
        );
        row.append(how);
      }
    }
  }
  function agentsCard(d) {
    const c = card('Agents in ' + d.name);
    c.dataset.agents = d.key;
    const S = SET();
    let rec = lists.get(d.key);
    // asked again after a minute, or after 5 s when the answer said the distro was not ready yet (the status now says it is)
    const stale = !rec || (!rec.busy && Date.now() - rec.at > (notReadyAnswer(rec) ? 5000 : STALE_MS));
    if (stale) {
      fetchList(d.key);
      rec = lists.get(d.key);
    }
    const value = rec && rec.value;
    if (rec && rec.error && !value) {
      const line = note('The agents in ' + d.name + ' could not be read: ' + rec.error, 'bad');
      line.append(' ', button('Check again', () => fetchList(d.key, { force: true }), 'st-link'));
      c.append(line);
    } else if (!value) c.append(note('Looking at the agents in ' + d.name + '…'));
    else if (value.state && value.state !== 'ready') c.append(note(value.line || d.name + ' is not ready yet.'));
    else {
      const env = envFor(d);
      const rows = value.agents
        .filter((r) => r && r.id)
        .map((r, i) => ({ r, i, o: ORDER.includes(r.id) ? ORDER.indexOf(r.id) : ORDER.length }))
        .sort((x, y) => x.o - y.o || x.i - y.i)
        .map((x) => x.r);
      for (const r of rows) c.append(S.agentRow(toAgent(d, r), { uninstall: true }, env));
    }
    const foot = note(
      'Sign-in is checked in ' + d.name + ' each time this page reads its agents. "Use in ' + d.name + '" is ' + d.name +
        '\'s own switch; the Windows one stays as it is. Your Windows agents are in ',
      'wl-foot',
    );
    foot.append(button('AIB Linking', () => S.goSection('agents'), 'st-link'), '.');
    c.append(foot);
    return c;
  }
  // ---- "AIB in Ubuntu" and Remove (design section 13) ------------------------------------------------------------------------
  const GB = 1024 * 1024 * 1024,
    MB = 1024 * 1024;
  function bytesText(b) {
    const n = Math.max(0, Number(b) || 0);
    if (n >= GB) return (n / GB).toFixed(1).replace(/\.0$/, '') + ' GB';
    if (n >= MB) return Math.round(n / MB) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' bytes';
  }
  const agentName = (id) => (NAMES[id] ? NAMES[id][0] : String(id || ''));
  /** wouldRemove grouped by its `what`, in the order the server gave: [{what, bytes, paths}]. */
  function groupRemove(items) {
    const out = [],
      at = new Map();
    for (const x of items || []) {
      if (!x) continue;
      const what = String(x.what || x.path || '');
      let g = at.get(what);
      if (!g) {
        g = { what, bytes: 0, paths: [] };
        at.set(what, g);
        out.push(g);
      }
      g.bytes += Math.max(0, Number(x.bytes) || 0);
      if (x.path) g.paths.push(String(x.path));
    }
    return out;
  }
  /** After a removal (or the status says AIB was removed): "AIB is not set up in Ubuntu" with Set up again. */
  function removedCard(d) {
    const c = card(d.name);
    c.dataset.distro = d.key;
    c.dataset.removed = '1';
    c.append(facts([['State', 'AIB not set up']]));
    c.append(note('AIB is not set up in ' + d.name + '.', 'wl-removed'));
    c.append(
      note(
        'Your projects, sign-ins and your own installs in ' + d.name + ' are as they were. Set up again copies AIB\'s helper to ' +
          d.name + ' (about 100 MB, into ~/.aib-server) and starts it. Opening a WSL project in ' + d.name + ' does the same.',
        'dim',
      ),
    );
    const left = leftovers.get(d.key);
    if (left) {
      if (left.message) c.append(note(left.message, 'bad'));
      if (left.left.length) {
        c.append(note('Left in ' + d.name + ':', 'bad'));
        const ul = el('ul', null, 'wl-rm-list wl-left');
        for (const x of left.left) ul.append(el('li', x));
        c.append(ul);
      }
    }
    const busy = starting.has(d.key) && starting.get(d.key) === '';
    const go = button(busy ? 'Setting up AIB in ' + d.name + '…' : 'Set up again', () => setUpAgain(d), 'primary',
      'Copies AIB\'s helper to ' + d.name + ' (about 100 MB, into ~/.aib-server) and starts it');
    go.disabled = busy;
    c.append(actions(go));
    const err = starting.get(d.key);
    if (err) c.append(note(err, 'bad'));
    return c;
  }
  /** Set up again: the same start as "Start Ubuntu and check" (agents?peek=1&start=1); the server clears its removed flag. */
  function setUpAgain(d) {
    removedNow.delete(d.key);
    leftovers.delete(d.key);
    aibs.delete(d.key);
    lists.delete(d.key);
    needs.delete(d.key);
    return startDistro(d);
  }
  function aibCard(d) {
    const name = d.name;
    const c = card('AIB in ' + name);
    c.dataset.aib = d.key;
    let rec = aibs.get(d.key);
    const stale = !rec || (!rec.busy && Date.now() - rec.at > (notReadyAnswer(rec) ? 5000 : STALE_MS));
    if (stale) {
      fetchAib(d.key);
      rec = aibs.get(d.key);
    }
    const busy = removing.has(d.key);
    const value = rec && rec.value;
    const u = value && value.usage;
    const refresh = button('Refresh', () => fetchAib(d.key, { force: true }), 'st-link', 'Measure what AIB keeps in ' + name + ' again');
    refresh.disabled = busy || !!(rec && rec.busy);
    const remove = button('Remove AIB from ' + name, () => askRemove(d), 'st-danger',
      'Shows exactly what would be deleted from ' + name + ' and what is kept, before anything is deleted');
    remove.disabled = busy;
    if (rec && rec.error && !value) {
      c.append(note('What AIB keeps in ' + name + ' could not be read: ' + rec.error, 'bad'));
      c.append(actions(remove, refresh));
      return c;
    }
    if (!value) {
      c.append(note('Looking at what AIB keeps in ' + name + '…'));
      return c;
    }
    if (!u) {
      c.append(note(value.line || name + ' is not ready yet.'));
      return c;
    }
    c.append(
      note(
        'Everything AIB keeps in ' + name + ', in ' + (u.root || '~/.aib-server') + ' on this PC. Your projects, ~/.claude, ' +
          '~/.codex and anything you installed yourself are not in it.',
      ),
    );
    const dl = el('dl', null, 'st-facts wl-usage');
    for (const p of u.parts || []) {
      if (!p) continue;
      const dt = el('dt', p.label || p.key);
      if (p.path) dt.title = p.path;
      dl.append(dt, el('dd', bytesText(p.bytes)));
      if (p.key === 'agents')
        for (const a of u.agents || [])
          if (a && a.id)
            dl.append(
              el('dt', agentName(a.id) + ((a.versions || []).length ? ' ' + a.versions.join(', ') : ''), 'wl-sub'),
              el('dd', bytesText(a.bytes), 'wl-sub'),
            );
    }
    dl.append(el('dt', 'In all', 'wl-total'), el('dd', bytesText(u.totalBytes), 'wl-total'));
    c.append(dl);
    const versions = (u.versions || []).slice();
    if (u.current && !versions.includes(u.current)) versions.unshift(u.current);
    if (versions.length)
      c.append(note('AIB versions installed: ' + versions.map((v) => (v === u.current ? v + ' (current)' : v)).join(', '), 'wl-line'));
    const wt = u.worktrees || { count: 0, dirty: 0 };
    const count = Number(wt.count) || 0,
      dirty = Number(wt.dirty) || 0;
    c.append(
      note(
        'Chat copies: ' + (count ? count + ', ' + (dirty ? dirty + ' with unsaved changes' : 'none with unsaved changes') : 'none'),
        'wl-line' + (dirty ? ' warn' : ''),
      ),
    );
    c.append(note('Chats working now: ' + (Number(u.chatsWorking) || 0), 'wl-line'));
    const others = (u.dataFolders || []).filter((f) => f && !f.mine);
    if (others.length) {
      const box = el('div', null, 'wl-others');
      box.append(el('p', 'Other AIB data folders in ' + name, 'st-label wl-others-title'));
      const ul = el('ul', null, 'wl-rm-list');
      for (const f of others) {
        const li = el('li', null, 'wl-other');
        li.append(el('code', f.name), el('span', bytesText(f.bytes), 'wl-size'));
        if (f.keeperAlive) li.append(el('span', 'in use', 'st-status warn'));
        ul.append(li);
      }
      box.append(ul, note('These belong to another AIB build or data folder. Remove here never touches them.', 'dim'));
      c.append(box);
    }
    const state = removing.get(d.key);
    if (state === 'checking') c.append(note('Checking what Remove would delete…', 'wl-busy'));
    else if (state === 'applying') c.append(note('Removing AIB from ' + name + '…', 'wl-busy'));
    c.append(actions(remove, refresh));
    return c;
  }

  /**
   * Remove AIB from Ubuntu: the in-page question of delete-project-ui.js (role alertdialog, Cancel focused, Escape cancels, focus
   * kept inside). It opens at once, asks the server with mode 'check' (deletes nothing) and lists exactly what goes, grouped, with
   * sizes; what is kept and why; what is never touched. `blocked` reasons are shown verbatim and keep the button off. The button
   * needs a second click, or the tick when chats in the distro are working (usage.chatsWorking). Nothing is claimed before the
   * apply answer.
   */
  function askRemove(d) {
    if (removeBox) removeBox.close(false);
    const D = doc(),
      key = d.key,
      name = d.name;
    const scrim = el('div', null, 'dp-scrim');
    const box = el('div', null, 'dp-dialog wl-remove');
    box.dataset.wsl = 'remove';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'wlRemoveTitle');
    const title = el('h2', 'Remove AIB from ' + name + '?', 'dp-title');
    title.id = 'wlRemoveTitle';
    const main = el('p', 'This stops AIB\'s helper in ' + name + ' and deletes what is listed here. Nothing is deleted before you confirm.', 'dp-main');
    const status = el('p', 'Checking what would be deleted…', 'dp-note');
    status.setAttribute('role', 'status');
    const body = el('div', null, 'wl-rm-body');
    const never = el('div', null, 'wl-rm-never');
    never.append(
      el('p', 'Your projects, ~/.claude, ~/.codex, nvm and asdf are not touched.', 'dp-note'),
      el('p', 'Chat branches stay in your repos.', 'dp-note'),
    );
    const rec = aibs.get(key);
    const working = Number(rec && rec.value && rec.value.usage && rec.value.usage.chatsWorking) || 0;
    const tickRow = el('label', null, 'dp-disk');
    const tick = D.createElement('input');
    tick.type = 'checkbox';
    tick.checked = false;
    tickRow.append(tick, el('span', 'I understand chats running in ' + name + ' will stop'));
    tickRow.hidden = true;
    const again = el('p', null, 'dp-warn');
    again.hidden = true;
    const error = el('p', null, 'dp-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const row = el('div', null, 'cg-confirm-row dp-row');
    const no = el('button', 'Cancel', 'cg-confirm-no dp-cancel');
    const check = el('button', 'Check again', 'cg-confirm-no wl-rm-check');
    const yes = el('button', 'Remove AIB from ' + name, 'cg-confirm-yes cg-discard dp-ok');
    no.type = check.type = yes.type = 'button';
    check.hidden = true;
    row.append(no, check, yes);
    box.append(title, main, status, body, never, tickRow, again, error, row);

    let info = null, // the last check (or a refused apply) answer
      busy = true, // a request runs
      armed = false, // the first click of the second-click confirm
      over = false, // the apply answered: only Close is left
      done = false;
    const blocked = () => !!info && info.blocked.length > 0;
    const draw = () => {
      const gate = working > 0 && !!info && !blocked() && !over;
      tickRow.hidden = !gate;
      tick.disabled = busy;
      again.hidden = !armed || gate || busy;
      again.textContent = armed ? 'Choose Remove AIB from ' + name + ' again to delete these. This cannot be undone.' : '';
      yes.hidden = over;
      yes.disabled = busy || !info || blocked() || (gate && !tick.checked);
      yes.textContent = removing.get(key) === 'applying' ? 'Removing…' : 'Remove AIB from ' + name;
      check.hidden = !blocked() || over;
      check.disabled = busy;
      no.disabled = busy;
      no.textContent = blocked() || over ? 'Close' : 'Cancel';
    };
    const list = (heading, items, cls) => {
      const wrap = el('div', null, 'wl-rm-part' + (cls ? ' ' + cls : ''));
      wrap.append(el('p', heading, 'dp-main wl-rm-head'));
      const ul = el('ul', null, 'wl-rm-list');
      for (const n of items) ul.append(n);
      wrap.append(ul);
      return wrap;
    };
    // what the check (or a refused apply) says: blocked reasons, what goes (grouped), what is kept and why
    const showCheck = (r) => {
      body.replaceChildren();
      status.hidden = true;
      if (r.blocked.length) {
        const wrap = el('div', null, 'wl-rm-blocked');
        wrap.append(el('p', 'AIB cannot be removed from ' + name + ' now:', 'dp-warn'));
        for (const why of r.blocked) wrap.append(el('p', String(why), 'dp-warn wl-reason'));
        body.append(wrap);
      }
      const groups = groupRemove(r.wouldRemove);
      if (groups.length) {
        const total = groups.reduce((s, g) => s + g.bytes, 0);
        body.append(
          list(
            (r.blocked.length ? 'Remove would delete' : 'Deleted') + ' (' + bytesText(total) + ' in all):',
            groups.map((g) => {
              const li = el('li', null, 'wl-rm-item');
              const head = el('div', null, 'wl-rm-line');
              head.append(el('span', g.what + (g.paths.length > 1 ? ' (' + g.paths.length + ')' : '')), el('span', bytesText(g.bytes), 'wl-size'));
              li.append(head);
              for (const p of g.paths) li.append(el('code', p, 'wl-rm-path'));
              return li;
            }),
            'wl-rm-gone',
          ),
        );
      } else body.append(el('p', 'Nothing of this AIB is left to delete in ' + name + '.', 'dp-note'));
      if (r.kept.length)
        body.append(
          list(
            'Kept:',
            r.kept.map((k) => {
              const li = el('li', null, 'wl-rm-item');
              li.append(el('code', k.path, 'wl-rm-path'), el('span', String(k.why || ''), 'wl-rm-why'));
              return li;
            }),
            'wl-rm-kept',
          ),
        );
      if (r.message) body.append(el('p', r.message, 'dp-note'));
    };
    const showFailure = (r) => {
      body.replaceChildren();
      status.hidden = true;
      main.textContent = 'AIB could not remove everything from ' + name + '.';
      if (r.message) body.append(el('p', r.message, 'dp-error wl-rm-message'));
      if (r.left.length) body.append(list('Left in ' + name + ':', r.left.map((x) => el('li', String(x))), 'wl-rm-left'));
      if (r.removed.length) body.append(list('Removed:', r.removed.map((x) => el('li', String(x))), 'wl-rm-done'));
    };
    const fail = (e) => {
      removing.delete(key);
      busy = false;
      armed = false;
      error.textContent = (e && e.message) || String(e || 'Ubuntu did not answer.');
      error.hidden = false;
      status.hidden = true;
      draw();
    };
    function runCheck() {
      busy = true;
      armed = false;
      error.hidden = true;
      status.hidden = false;
      status.textContent = 'Checking what would be deleted…';
      removing.set(key, 'checking');
      draw();
      redraw();
      return Promise.resolve()
        .then(() => W().removeAib(key, 'check'))
        .then(
          (r) => {
            removing.delete(key);
            if (done) return;
            busy = false;
            info = r;
            showCheck(r);
            draw();
          },
          (e) => !done && fail(e),
        )
        .finally(() => {
          if (removing.get(key) === 'checking') removing.delete(key);
          redraw();
        });
    }
    function apply() {
      busy = true;
      error.hidden = true;
      removing.set(key, 'applying');
      draw();
      redraw();
      return Promise.resolve()
        .then(() => W().removeAib(key, 'apply', true))
        .then(
          (r) => {
            removing.delete(key);
            busy = false;
            armed = false;
            if (r.ok) {
              removedNow.add(key);
              leftovers.delete(key);
              forgetDistro(key);
              close(false);
              return afterRemove(key);
            }
            if (r.blocked.length) {
              // refused when it ran again: nothing was deleted
              info = r;
              showCheck(r);
              draw();
              return null;
            }
            // partial: say what went and what was left, verbatim; the host is off with the removed flag
            over = true;
            showFailure(r);
            removedNow.add(key);
            leftovers.set(key, { message: r.message || '', left: r.left.map(String) });
            forgetDistro(key);
            draw();
            return afterRemove(key);
          },
          (e) => fail(e),
        )
        .finally(() => {
          if (removing.get(key) === 'applying') removing.delete(key);
          redraw();
        });
    }
    function close(refocus) {
      if (done) return;
      done = true;
      box.remove();
      scrim.remove();
      if (removeBox && removeBox.box === box) removeBox = null;
      if (refocus !== false) {
        const back = Array.from(D.querySelectorAll('.st-card')).find((n) => n.dataset && n.dataset.aib === key);
        const b = back && Array.from(back.querySelectorAll('button')).find((x) => x.textContent === 'Remove AIB from ' + name);
        if (b && b.focus) b.focus();
      }
    }
    tick.addEventListener('change', draw);
    no.addEventListener('click', () => !busy && close());
    check.addEventListener('click', () => !busy && runCheck());
    scrim.addEventListener('click', () => !busy && close());
    yes.addEventListener('click', () => {
      if (busy || !info || blocked() || over) return;
      const gate = working > 0;
      if (gate ? !tick.checked : !armed) {
        if (!gate) armed = true;
        return draw();
      }
      apply();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) close();
      } else if (e.key === 'Tab') {
        const order = [tick, no, check, yes].filter((b) => !b.disabled && !b.hidden && !(b === tick && tickRow.hidden));
        const at = order.indexOf(D.activeElement);
        e.preventDefault();
        const to = order[(at + (e.shiftKey ? order.length - 1 : 1)) % order.length] || no;
        if (to.focus) to.focus();
      }
    });
    D.body.append(scrim, box);
    no.focus();
    removeBox = { key, box, close };
    draw();
    runCheck();
    return removeBox;
  }
  /** The distro's answers are out of date after a removal: asked again once it is set up. */
  function forgetDistro(key) {
    aibs.delete(key);
    lists.delete(key);
    needs.delete(key);
  }
  /** The status after a removal: the server's removed flag takes over from this page's own once it is read. */
  function afterRemove(key) {
    const Wsl = W();
    return Promise.resolve(Wsl && Wsl.refresh ? Wsl.refresh() : null).then(
      (st) => {
        const d = st && (st.distros || []).find((x) => x && x.key === key);
        if (d && d.removed === true) removedNow.delete(key);
        redraw();
      },
      () => redraw(),
    );
  }

  function group(d) {
    const out = [el('h4', d.name, 'st-group'), distroCard(d)];
    if (isRemoved(d)) return out;
    if (d.state === 'ready') out.push(needsCard(d), agentsCard(d), aibCard(d));
    return out;
  }

  // ---- the section ---------------------------------------------------------------------------------------------------------
  function render(box) {
    const Wsl = W();
    if (!Wsl || !SET()) {
      box.append(note('This part could not be drawn: wsl-ui.js is missing.', 'bad'));
      return;
    }
    wire();
    if (!Wsl.loaded()) {
      const c = card('WSL on this PC');
      c.append(note('Looking for WSL on this PC…'));
      box.append(c);
      Promise.resolve(Wsl.refresh()).then(redraw, () => {});
      return;
    }
    const st = statusOf();
    lastSig = signature(st);
    const distros = st.distros || [];
    if (!distros.length && !(st.skipped || []).length) {
      box.append(noWslCard(st));
      return;
    }
    const key = chosen(st);
    box.append(picker(st, key), overview(st));
    const d = distros.find((x) => x.key === key);
    if (d) box.append(...group(d));
    if (focusWant) bringIntoView();
  }
  function bringIntoView() {
    if (typeof root.setTimeout !== 'function') return;
    root.setTimeout(() => {
      if (!focusWant) return;
      const [, key] = focusWant.split(':');
      const all = Array.from(doc().querySelectorAll('.st-agent'));
      const row = all.find((r) => r.dataset && r.dataset.agent === focusWant);
      const d = (statusOf().distros || []).find((x) => x.key === key);
      // the agent's card, or the distro's own card while its agents are not drawn (not running, still looking)
      const target = row || Array.from(doc().querySelectorAll('.st-card')).find((n) => n.dataset && n.dataset.distro === key);
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      if (row || !d || d.state !== 'ready') focusWant = '';
    }, 0);
  }
  /** "Set up Ubuntu in Settings" (the new-chat panel): this section with that distro picked, its card of that agent in view. */
  function open(key, agentId) {
    const S = SET();
    if (!S) return;
    const k = String(key || '').toLowerCase();
    if (k) {
      pick = k;
      savePick(k);
      const Wsl = W();
      projectSeen = Wsl && Wsl.currentKey ? Wsl.currentKey() : '';
    }
    focusWant = 'wsl:' + k + ':' + String(agentId || '');
    if (S.isOpen && S.isOpen()) S.goSection('wsl');
    else S.open('wsl');
  }

  const api = {
    render,
    open,
    _lists: lists,
    _needs: needs,
    _aibs: aibs,
    bytesText,
    groupRemove,
    _reset: () => {
      lists.clear();
      needs.clear();
      starting.clear();
      enabledWant.clear();
      rowNotes.clear();
      uninstalling.clear();
      for (const k of Array.from(terms.keys())) closePanel(k);
      if (removeBox) removeBox.close(false);
      aibs.clear();
      removing.clear();
      removedNow.clear();
      leftovers.clear();
      lastSig = '';
      focusWant = '';
      pick = '';
      projectSeen = null;
    },
  };
  root.AIBWslSettings = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
