(function (root) {
  'use strict';
  // Settings > AIB Linking (WSL) (docs/wsl/linking-design.md, section 11 overrides it). Windows only (settings-ui.js hides the
  // section elsewhere). Cards: "WSL on this PC" (every distro, the ones AIB cannot use with the reason, WSL's default marked; or how
  // to get WSL), then per usable distro its status card and "Agents in <distro>", drawn with Settings' own agentRow and an env of
  // the distro (job store: wsl-ui.js, the only one; card keys "wsl:<distro>:<agent>").
  // Opening Settings never starts a distro: the status is the poll's (never starts one) and the agent list is asked with peek=1,
  // only for a distro that is ready. Only "Start <distro> and check" asks with start=1.
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

  const lists = new Map(); // distro key -> {value, at, busy, error}: the last peek answer
  const starting = new Map(); // distro key -> '' while "Start and check" runs, or the error it ended with
  let wired = false,
    lastSig = '',
    focusWant = ''; // a card to bring into view once it is drawn ("Set up Ubuntu in Settings")

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

  // ---- state and repaint -----------------------------------------------------------------------------------------------
  function redraw() {
    const S = SET();
    if (S && S.showing && S.showing('wsl-linking')) S.redraw();
  }
  const statusOf = () => (W() ? W().status() : { distros: [] });
  // Only what this section draws: the 5 s poll repaints nothing when nothing here changed.
  function signature(st) {
    return JSON.stringify([
      (st.distros || []).map((d) => [d.key, d.name, d.state, d.line, d.helper, d.home, d.problem, d.isDefault]),
      st.skipped || [],
      st.wsl || null,
    ]);
  }
  function wire() {
    if (wired || !W()) return;
    wired = true;
    W().onChange((st) => {
      const sig = signature(st || {});
      if (sig === lastSig) return;
      lastSig = sig;
      // a distro that became ready since its list was asked: ask again (still peek)
      for (const d of (st && st.distros) || []) {
        const rec = lists.get(d.key);
        if (d.state === 'ready' && rec && rec.value && rec.value.state && rec.value.state !== 'ready') fetchList(d.key);
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
    c.append(note(LEAD, 'wl-lead'));
    for (const d of st.distros || []) {
      const row = el('div', null, 'st-agent wl-distro');
      const head = el('div', null, 'st-agent-head');
      const [chip, cls] = chipOf(d);
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

  // The distro's agent row in the shape agentRow reads (the Windows card's name, letter and On/Off: one switch per agent).
  function toAgent(row) {
    const S = SET();
    const win = ((S && S.agentList && S.agentList()) || []).find((x) => x && x.id === row.id) || null;
    const known = NAMES[row.id] || [row.id, letterOf(row.id)];
    return {
      id: row.id,
      name: (win && win.name) || known[0],
      letter: (win && win.letter) || known[1],
      builtin: true,
      beta: false,
      enabled: win ? !!win.enabled : true,
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
    };
  }
  function envFor(d) {
    const S = SET(),
      Wsl = W(),
      name = d.name;
    const jobOf = (a) => (Wsl ? Wsl.installJob(d.key, a.id) : null);
    const verb = (a) => (a.update ? 'Updating ' : 'Installing ');
    return S.makeEnv({
      key: (a) => 'wsl:' + d.key + ':' + a.id,
      tag: (a) => (!a.found ? '' : a.managed ? 'Installed by AIB' : 'Your own install'),
      installOf: jobOf,
      installRunning: (a) => {
        const j = jobOf(a);
        return !!j && j.state === 'running';
      },
      statusText: (a) => {
        const j = jobOf(a);
        if (j && j.state === 'failed') return { text: 'Install failed', cls: 'bad' };
        return a.found ? { text: 'Found', cls: 'ok' } : { text: 'Not installed', cls: 'warn' };
      },
      showCheck: (a) => a.found || !a.installable,
      checkAgain: () => fetchList(d.key, { force: true }),
      recheck: () => fetchList(d.key, { force: true }),
      canInstall: (a) => a.installable && (!a.found || a.update),
      installLabel: (a) => (a.update ? 'Update in ' : 'Install in ') + name,
      installOff: (a) => (a.installBlock ? 'Needs Node.js in ' + name + ' first' : ''),
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
      toggle: false,
      toggleNote: (a) => (a.enabled ? 'On' : 'Off') + ': uses the Windows switch in AIB Linking',
      sharedKey: true,
      extraLines: (a, row, at) => extraLines(d, a, row, at),
    });
  }
  // The distro's own lines on an agent card, after its status lines.
  function extraLines(d, a, row, at) {
    if (at.running) return;
    const name = d.name,
      job = at.job,
      failed = !!job && (job.state === 'failed' || job.state === 'refused');
    if (a.installBlock && a.nodeInstall) {
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
      if (a.installable && !a.installBlock && !failed)
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
    const notReady = !!(rec && rec.value && rec.value.state && rec.value.state !== 'ready');
    const stale = !rec || (!rec.busy && Date.now() - rec.at > (notReady ? 5000 : STALE_MS));
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
      for (const r of rows) c.append(S.agentRow(toAgent(r), {}, env));
    }
    const foot = note(
      '"Found" means the program exists in ' + d.name + '; sign-in happens in a WSL chat. Your Windows agents are in ',
      'wl-foot',
    );
    foot.append(button('AIB Linking', () => S.goSection('agents'), 'st-link'), '.');
    c.append(foot);
    return c;
  }
  function group(d) {
    const out = [el('h4', d.name, 'st-group'), distroCard(d)];
    if (d.state === 'ready') out.push(agentsCard(d));
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
    box.append(overview(st));
    for (const d of distros) box.append(...group(d));
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
  /** "Set up Ubuntu in Settings" (the new-chat panel): this section, with the distro's card of that agent in view. */
  function open(key, agentId) {
    const S = SET();
    if (!S) return;
    focusWant = 'wsl:' + String(key || '').toLowerCase() + ':' + String(agentId || '');
    if (S.isOpen && S.isOpen()) S.goSection('wsl');
    else S.open('wsl');
  }

  const api = { render, open, _lists: lists, _reset: () => (lists.clear(), starting.clear(), (lastSig = ''), (focusWant = '')) };
  root.AIBWslSettings = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
