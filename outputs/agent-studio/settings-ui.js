(function (root) {
  'use strict';
  // Settings page: opens over the chat area (the chat list stays). Search on the left filters settings across sections by label
  // and keywords; every change is saved at once through POST /api/live/settings (no Save button). The server owns the data
  // (agents, defaults for new chats, server options); this file draws it and keeps AgentChoice (the page's agent registry) in step.
  // Notification preferences stay per browser (desktop permission is per browser) and are drawn by notify-ui.js.
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };

  const SECTIONS = [
    { id: 'agents', label: 'Agents' },
    { id: 'defaults', label: 'Defaults' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'editors', label: 'Editors' },
    { id: 'keyboard', label: 'Keyboard' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'server', label: 'AIB server' },
  ];
  // Every searchable setting. label + keywords are what the search box matches; `title` is the heading drawn on its card.
  const INDEX = [
    {
      id: 'agents-list',
      section: 'agents',
      label: 'Agents AIB knows',
      keywords: [
        'found',
        'not found',
        'signed in',
        'sign in',
        'command',
        'path',
        'enable',
        'disable',
        'turn off',
        'claude code',
        'omp',
        'codex',
        'launcher',
        'not installed',
        'adapter',
        'edit',
        'remove',
      ],
    },
    {
      id: 'agents-add',
      section: 'agents',
      label: 'Add an ACP agent',
      keywords: [
        'custom',
        'new agent',
        'adapter',
        'command',
        'arguments',
        'environment variables',
        'env',
        'codex',
        'gemini',
        'acp',
      ],
    },
    {
      id: 'default-agent',
      section: 'defaults',
      label: 'Default agent for new chats',
      keywords: ['agent', 'start with', 'new chat', 'claude', 'omp'],
    },
    {
      id: 'default-picks',
      section: 'defaults',
      label: 'Default model and mode',
      keywords: ['model', 'mode', 'permission', 'plan', 'new chat', 'per agent'],
    },
    {
      id: 'default-projects',
      section: 'defaults',
      label: 'Defaults per project',
      keywords: ['project', 'folder', 'agent', 'model', 'mode', 'remember', 'last used'],
    },
    {
      id: 'notifications',
      section: 'notifications',
      label: 'Windows notifications, sound and muted projects',
      keywords: ['notify', 'desktop', 'sound', 'chime', 'mute', 'needs you', 'your turn', 'alert', 'inbox'],
    },
    {
      id: 'editors',
      section: 'editors',
      label: 'Open a project in VS Code, Explorer or a terminal',
      keywords: ['editor', 'vs code', 'explorer', 'terminal', 'open folder', 'ide'],
    },
    {
      id: 'keyboard',
      section: 'keyboard',
      label: 'Keyboard shortcuts',
      keywords: ['keys', 'hotkeys', 'cheat sheet', 'ctrl', 'shortcut', 'bindings'],
    },
    {
      id: 'text-size',
      section: 'appearance',
      label: 'Text size',
      keywords: ['font', 'zoom', 'bigger', 'smaller', 'appearance', 'theme', 'dark'],
    },
    {
      id: 'default-view',
      section: 'appearance',
      label: 'Default chat view',
      keywords: ['view', 'full', 'chat', 'condensed', 'prompts', 'new chat', 'compact', 'summary'],
    },
    {
      id: 'auto-reconnect',
      section: 'server',
      label: 'Reconnect chats after a restart',
      keywords: ['auto reconnect', 'restart', 'recover', 'open before', 'no-auto-reconnect'],
    },
    {
      id: 'server-info',
      section: 'server',
      label: 'State folder, versions and process IDs',
      keywords: [
        'pid',
        'state folder',
        'state dir',
        'version',
        'protocol',
        'host',
        'port',
        'python',
        'about',
        'diagnostics',
      ],
    },
    {
      id: 'updates',
      section: 'server',
      label: 'Updates: check for a newer version',
      keywords: [
        'update',
        'upgrade',
        'new version',
        'check for updates',
        'automatic',
        'github',
        'install',
        'download',
        'about',
        'version',
      ],
    },
    {
      id: 'server-restart',
      section: 'server',
      label: 'Restart the web server',
      keywords: ['deploy', 'restart', 'update', 'reload', 'stop host'],
    },
  ];
  const sectionLabel = (id) => (SECTIONS.find((s) => s.id === id) || { label: id }).label;
  // Page headings that differ from the short name in the section list.
  const PAGE_HEADINGS = {};
  const pageHeading = (id) => PAGE_HEADINGS[id] || sectionLabel(id);

  // ---- search ----------------------------------------------------------------------------------------------------
  // entries matching `query` (every word must match the label, a keyword or the section name), best first. No query: all, in order.
  function filterIndex(index, query, rank) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return index.slice();
    const ranker =
      typeof rank === 'function'
        ? rank
        : (root.AgentCommands && root.AgentCommands.rank) ||
          ((term, fields) => {
            const words = term.toLowerCase().split(/\s+/).filter(Boolean);
            return words.every((w) => fields.some((f) => String(f.text).toLowerCase().includes(w))) ? 1 : -1;
          });
    const scored = [];
    index.forEach((entry, order) => {
      const fields = [
        { text: entry.label, weight: 1 },
        { text: sectionLabel(entry.section), weight: 0.5 },
      ].concat((entry.keywords || []).map((k) => ({ text: k, weight: 0.7 })));
      const s = ranker(q, fields);
      if (s >= 0) scored.push({ entry, s, order });
    });
    scored.sort((a, b) => b.s - a.s || a.order - b.order);
    return scored.map((x) => x.entry);
  }
  // {sectionId: number of matching entries}, for the counts beside the section names while searching.
  function sectionCounts(index, query) {
    const out = {};
    for (const s of SECTIONS) out[s.id] = 0;
    for (const e of filterIndex(index, query)) out[e.section] += 1;
    return out;
  }

  // ---- state -----------------------------------------------------------------------------------------------------
  const S = {
    host: null,
    data: null,
    boot: null,
    rev: '',
    open: false,
    section: 'agents',
    query: '',
    form: null,
    busy: false,
    error: '',
    loadError: '',
    page: null,
    nav: null,
    content: null,
    search: null,
    title: null,
    last: null,
    loading: null,
    flash: '',
  };

  function applyData(data) {
    S.data = data;
    S.rev = data.revision || '';
    syncInstalls(data.agents);
    syncSignins(data.agents);
    recheckUninstallRefusals();
    const AC = root.AgentChoice;
    if (AC) {
      if (AC.setRegistry) AC.setRegistry(data.agents);
      if (AC.setDefaults) AC.setDefaults(data.settings && data.settings.defaults);
    }
    if (S.host && S.host.registryChanged) S.host.registryChanged();
    notify();
    if (S.host && S.host.settingsChanged) S.host.settingsChanged();
  }
  // Other pages (the first-run start page) draw the same agent rows; they redraw when the list or a job changes.
  const listeners = [];
  let hold = 0; // while an install or sign-in finishes and its follow-up status check runs, nothing is painted from the middle state
  function notify() {
    if (hold > 0) return;
    for (const fn of listeners.slice()) {
      try {
        fn();
      } catch (e) {
        /* one listener's failure must not stop the others */
      }
    }
  }
  const releaseHold = () => {
    hold = Math.max(0, hold - 1);
    if (!hold) {
      if (S.open) renderAll();
      notify();
    }
  };
  const onChange = (fn) => {
    if (typeof fn === 'function') listeners.push(fn);
  };
  // Load (or reload) the settings from the server. Resolves with the data, or null when the server could not be read
  // (the built-in agents then stay in use).
  function load(recheck) {
    if (S.loading) return S.loading;
    S.loading = Promise.resolve()
      .then(() => (recheck ? S.host.get('/api/live/settings', { recheck: '1' }) : S.host.get('/api/live/settings')))
      .then(
        (data) => {
          applyData(data);
          S.loadError = '';
          return migrate(data).then(() => {
            if (S.open) renderAll();
            return S.data;
          });
        },
        (error) => {
          S.loadError = error && error.message ? error.message : 'Settings could not be loaded.';
          if (S.open) renderAll();
          return null;
        },
      )
      .finally(() => {
        S.loading = null;
      });
    return S.loading;
  }
  // The first time: carry the old browser-only "agent last used per project" memory into Settings.
  let migrateTried = false;
  function migrate(data) {
    const AC = root.AgentChoice;
    if (
      migrateTried ||
      !AC ||
      !AC.legacyPatch ||
      (data.settings && data.settings.defaults && data.settings.defaults.migrated)
    )
      return Promise.resolve();
    migrateTried = true;
    let patch;
    try {
      patch = AC.legacyPatch(root.localStorage);
    } catch (e) {
      patch = { migrated: true };
    }
    return save({ defaults: patch }, true).then(
      () => {},
      () => {},
    );
  }
  function sync(revision) {
    if (revision && S.data && revision !== S.rev && !S.busy) return load();
    return Promise.resolve();
  }

  // POST a settings patch. Resolves with the new data; rejects with the server's message (and shows it).
  function save(patch, quiet) {
    S.busy = true;
    return Promise.resolve()
      .then(() => S.host.post('settings', patch))
      .then(
        (data) => {
          S.busy = false;
          S.error = '';
          applyData(data);
          if (!quiet && S.open) renderAll();
          return data;
        },
        (error) => {
          S.busy = false;
          S.error = error && error.message ? error.message : 'Could not save.';
          if (S.open) renderAll();
          throw error;
        },
      );
  }
  const saveQuiet = (patch) => save(patch).catch(() => {});

  // The agent you start a chat with in a project becomes that project's default (shown and editable under Defaults).
  function remember(agentId, projectKey) {
    if (!S.data || !projectKey) return;
    const current = (S.data.settings.defaults.projects || {})[projectKey] || {};
    if (current.agent === agentId) return;
    save({ defaults: { projects: { [projectKey]: { agent: agentId } } } }, true).catch(() => {});
  }

  // ---- drawing helpers ------------------------------------------------------------------------------------------
  function card(title, note) {
    const c = el('section', null, 'st-card');
    c.append(el('h3', title, 'st-card-title'));
    if (note) c.append(el('p', note, 'st-note'));
    return c;
  }
  function field(label, control, hint) {
    const l = el('label', null, 'st-field');
    l.append(el('span', label, 'st-label'), control);
    if (hint) l.append(el('span', hint, 'st-hint'));
    return l;
  }
  function button(text, onClick, cls) {
    const b = el('button', text, cls || '');
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function toggle(label, checked, onChange) {
    const l = el('label', null, 'st-toggle'),
      cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    l.append(cb, el('span', label));
    return l;
  }
  function select(options, value, onChange, label) {
    const sel = el('select');
    if (label) sel.setAttribute('aria-label', label);
    for (const [v, t] of options) {
      const o = el('option', t);
      o.value = v;
      sel.append(o);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }
  // One order everywhere: Claude Code, Codex, OMP, then the agents you added (in the order the server lists them).
  const AGENT_ORDER = ['claude', 'codex', 'omp'];
  const orderAgents = (list) =>
    (Array.isArray(list) ? list : [])
      .map((a, i) => ({ a, i, r: AGENT_ORDER.includes(a.id) ? AGENT_ORDER.indexOf(a.id) : AGENT_ORDER.length }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map((x) => x.a);
  const agents = () => (S.data && Array.isArray(S.data.agents) ? S.data.agents : []);
  const enabledAgents = () => agents().filter((a) => a.enabled);
  const defaults = () =>
    (S.data && S.data.settings && S.data.settings.defaults) || { agent: '', byAgent: {}, projects: {} };
  function note(text, cls) {
    return el('p', text, 'st-note' + (cls ? ' ' + cls : ''));
  }

  // ---- Agents ---------------------------------------------------------------------------------------------------
  function statusText(a) {
    const job = installOf(a);
    if (job && job.state === 'failed') return { text: 'Install failed', cls: 'bad' };
    if (!a.found)
      return a.launcherSource === 'missing'
        ? { text: 'Not installed', cls: 'warn' }
        : { text: 'Not found', cls: 'bad' };
    if (a.signin) {
      // The Status column: Ready / Needs sign-in / Not checked (not checked counts as ready for new chats)
      if (a.signin.state === 'signin') return { text: 'Needs sign-in', cls: 'warn' };
      if (a.signin.state === 'ready') return { text: 'Ready', cls: 'ok' };
      return { text: 'Not checked', cls: 'dim' };
    }
    if (a.status === 'signin') return { text: 'Found · sign-in needed', cls: 'warn' };
    if (a.status === 'running') return { text: 'Found · running', cls: 'ok' };
    if (a.launcherSource === 'studio') return { text: 'Ready', cls: 'ok' }; // Studio's own install
    return { text: 'Found', cls: 'ok' };
  }

  // ---- Installing Studio's own copy of an agent's adapter (Claude Code, Codex) -------------------------------------------
  // The job runs in the agent host; the server reports it as agent.install ({state: running|failed, stage, percent, message}) and
  // through GET /api/live/agents/install. Here: Install / Cancel / Retry, a progress bar, and polling while a job runs.
  const installs = {}; // agent id -> latest job state; {state: 'idle'} = no job; {state: 'refused', message} = refused before starting
  const pollTimers = {};
  const STAGE_TEXT = {
    preparing: 'Getting ready…',
    verifying: 'Checking the install…',
  };
  const BYTES_PER_SECOND = 5000000; // a rough pace for download plus unpack, only used for the "about N seconds" estimate
  function progressText(a, job) {
    if (STAGE_TEXT[job.stage]) return STAGE_TEXT[job.stage];
    const bytes = Number(a.packageBytes) || 0;
    if (!bytes) return 'Installing the ACP adapter…';
    const left = (bytes / BYTES_PER_SECOND) * (1 - Math.max(0, Math.min(95, Number(job.percent) || 0)) / 100);
    return 'Installing the ACP adapter… about ' + Math.max(5, Math.round(left / 5) * 5) + ' seconds';
  }
  const installOf = (a) => installs[a.id] || a.install || null;
  const installRunning = (a) => {
    const job = installOf(a);
    return !!job && job.state === 'running';
  };
  const installBlock = (a) => (a.installable && !a.found && a.launcherSource === 'missing' && a.installBlock) || '';
  const canInstall = (a) => !!a.installable && !a.found && a.launcherSource === 'missing' && !installBlock(a);
  // Uninstall only for the copy AIB installed itself (Studio's own install is what this row runs), never for one the person made.
  const canUninstall = (a) => !!a.builtin && !!a.installable && a.launcherSource === 'studio';
  const repaint = () => {
    if (S.open) renderAll();
    notify();
  };
  function syncInstalls(list) {
    for (const a of list || []) {
      if (a.install) {
        installs[a.id] = a.install;
        if (a.install.state === 'running') pollInstall(a.id);
      } else if (installs[a.id] && installs[a.id].state === 'idle') delete installs[a.id];
    }
  }
  function pollInstall(id) {
    if (pollTimers[id]) return;
    pollTimers[id] = root.setTimeout(() => {
      delete pollTimers[id];
      Promise.resolve()
        .then(() => S.host.get('/api/live/agents/install', { agent: id }))
        .then(
          (state) => applyInstall(id, state),
          () => pollInstall(id), // the web server is restarting: the job goes on in the agent host, so keep asking
        );
    }, 1000);
  }
  function applyInstall(id, state) {
    if (state && state.state === 'running') {
      installs[id] = state;
      repaint();
      pollInstall(id);
      return Promise.resolve();
    }
    const failed = state && state.state === 'failed';
    installs[id] = failed ? state : { state: 'idle' };
    if (failed) {
      repaint();
      return load();
    }
    // Finished (or cancelled): read the list, then run the sign-in check at once so the row says Needs sign-in or Ready, not Not checked.
    hold++;
    return load()
      .then(() => checkSignins(true))
      .finally(releaseHold);
  }
  function startInstall(a) {
    installs[a.id] = { state: 'running', stage: 'preparing', percent: 2 };
    repaint();
    return Promise.resolve()
      .then(() => S.host.post('agents/install', { agent: a.id }))
      .then(
        (state) => applyInstall(a.id, state),
        (error) => {
          installs[a.id] = {
            state: 'refused',
            message: (error && error.message) || 'The install could not be started.',
          };
          repaint();
          // A refusal for Node.js is shown as the grey line instead, with no Retry: ask the server again for it
          return load(true).then(() => {
            const fresh = ((S.data && S.data.agents) || []).find((x) => x.id === a.id);
            if (fresh && installBlock(fresh) && installs[a.id] && installs[a.id].state === 'refused') {
              delete installs[a.id];
              repaint();
            }
          });
        },
      );
  }
  // What the confirm question promises about saved chats: AIB lists saved Claude Code and OMP chats from their transcripts; other
  // agents' chats show only once opened here, so their promise is narrower.
  const LISTS_SAVED_CHATS = ['claude', 'omp'];
  function uninstallQuestion(a) {
    const chats = LISTS_SAVED_CHATS.includes(a.id)
      ? ' Saved chats stay in the list.'
      : ' ' + a.name + ' keeps its own saved chats, but AIB shows them only while they are open here.';
    return (
      'Uninstall ' +
      a.name +
      '? This deletes the copy AIB installed on this PC.' +
      chats +
      ' To use ' +
      a.name +
      ' again, install it again here.'
    );
  }
  const uninstallRefused = (a, error) => {
    installs[a.id] = {
      state: 'refused',
      uninstall: true,
      message: (error && error.message) || 'The agent could not be uninstalled.',
    };
    repaint();
  };
  // Every refusal the server can know (a chat open, a sign-in or install running, nothing installed) comes before the question.
  // A host that does not know the check (404) just goes on to the question; the real uninstall still refuses then.
  function uninstallCheck(a) {
    return Promise.resolve()
      .then(() => S.host.post('agents/install/uninstall', { agent: a.id, check: true }))
      .then(
        () => null,
        (error) => (error && error.status === 404 ? null : error || Error('The agent could not be uninstalled.')),
      );
  }
  function uninstallAgent(a) {
    return uninstallCheck(a).then((refusal) => {
      if (refusal) return uninstallRefused(a, refusal);
      if (installs[a.id] && installs[a.id].uninstall) {
        delete installs[a.id]; // the earlier refusal's cause is gone
        repaint();
      }
      const ok = typeof root.confirm === 'function' ? root.confirm(uninstallQuestion(a)) : false;
      if (!ok) return;
      delete installs[a.id];
      return Promise.resolve()
        .then(() => S.host.post('agents/install/uninstall', { agent: a.id }))
        .then(
          () => {
            delete installs[a.id];
            delete signins[a.id];
            return load(true);
          },
          (error) => uninstallRefused(a, error),
        );
    });
  }
  // An uninstall refusal stays only while its cause does: after each reload of the list it is asked again, and cleared (or updated)
  // by the answer.
  function recheckUninstallRefusals() {
    for (const a of agents()) {
      const job = installs[a.id];
      if (!job || !job.uninstall) continue;
      uninstallCheck(a).then((refusal) => {
        if (installs[a.id] !== job) return;
        if (!refusal) delete installs[a.id];
        else if (refusal.message && refusal.message !== job.message) job.message = refusal.message;
        else return;
        repaint();
      });
    }
  }
  function cancelInstall(a) {
    return Promise.resolve()
      .then(() => S.host.post('agents/install/cancel', { agent: a.id }))
      .then(
        (state) => applyInstall(a.id, state),
        (error) => {
          S.error = (error && error.message) || 'The install could not be cancelled.';
          repaint();
        },
      );
  }
  // ---- Sign-in: the Status column, the Sign in button, and "Waiting for sign-in…" ---------------------------------------------
  // The agent's own login runs in a visible console window (Windows), started by the agent host; Studio never sees what it produces.
  // The server reports the job as agent.signin.job ({state: waiting|failed|done|manual, message, command}) and through GET /api/live/agents/signin.
  const signins = {}; // agent id -> latest job; {state: 'idle'} = none
  const signinTimers = {};
  const signinOf = (a) => signins[a.id] || (a.signin && a.signin.job) || null;
  const signinWaiting = (a) => {
    const job = signinOf(a);
    return !!job && job.state === 'waiting';
  };
  const canSignIn = (a) => !!a.found && !!a.signin && a.signin.state === 'signin' && !signinWaiting(a);
  function syncSignins(list) {
    for (const a of list || []) {
      const job = a.signin && a.signin.job;
      if (job) {
        signins[a.id] = job;
        if (job.state === 'waiting') pollSignin(a.id);
      } else if (signins[a.id] && signins[a.id].state !== 'waiting') delete signins[a.id];
    }
  }
  function pollSignin(id) {
    if (signinTimers[id]) return;
    signinTimers[id] = root.setTimeout(() => {
      delete signinTimers[id];
      Promise.resolve()
        .then(() => S.host.get('/api/live/agents/signin', { agent: id }))
        .then(
          (state) => applySignin(id, state && state.job),
          () => pollSignin(id), // the web server is restarting: the sign-in goes on in the agent host
        );
    }, 1500);
  }
  function applySignin(id, job) {
    if (job && job.state === 'waiting') {
      signins[id] = job;
      repaint();
      pollSignin(id);
      return Promise.resolve();
    }
    signins[id] = job && job.state !== 'idle' ? job : { state: 'idle' };
    hold++; // the process ended and the server re-checked the status: read the list again before painting anything
    return load().finally(releaseHold);
  }
  function startSignin(a) {
    signins[a.id] = { state: 'waiting' };
    repaint();
    return Promise.resolve()
      .then(() => S.host.post('agents/signin', { agent: a.id }))
      .then(
        (state) => applySignin(a.id, state && state.job ? state.job : state),
        (error) => {
          signins[a.id] = { state: 'failed', message: (error && error.message) || 'The sign-in could not be started.' };
          repaint();
        },
      );
  }
  function cancelSignin(a) {
    return Promise.resolve()
      .then(() => S.host.post('agents/signin/cancel', { agent: a.id }))
      .then(
        (job) => applySignin(a.id, job),
        (error) => {
          S.error = (error && error.message) || 'The sign-in could not be cancelled.';
          repaint();
        },
      );
  }
  // Refresh the cached status of the installed agents: once when Settings opens, and on "Check again" (force). Never on a settings poll.
  function checkSignins(force) {
    if (!agents().some((a) => a.found && a.signin)) return Promise.resolve();
    return Promise.resolve()
      .then(() => S.host.post('agents/signin/check', { force: !!force }))
      .then(
        () => load(),
        () => {},
      );
  }

  function progressBar(a, job) {
    const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
    const bar = el('div', null, 'st-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Installing ' + a.name);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(percent));
    const fill = el('div', null, 'st-progress-bar');
    fill.style.width = percent + '%';
    bar.append(fill);
    return bar;
  }

  // opts.sharedBlock: the page draws the "Node.js is needed" line once for all rows, so the row does not repeat it.
  function agentRow(a, opts) {
    const shared = !!(opts && opts.sharedBlock);
    const row = el('div', null, 'st-agent' + (a.enabled ? '' : ' off'));
    const head = el('div', null, 'st-agent-head');
    head.append(
      el('span', a.letter || '?', 'st-letter'),
      el('strong', a.name),
      el('span', a.builtin ? 'Built in' : 'Added by you', 'st-tag'),
    );
    const job = installOf(a),
      running = installRunning(a),
      refused = !!job && job.state === 'refused';
    const waiting = !running && signinWaiting(a);
    // The start page has no On/Off switch (.st-actions is hidden there): a turned-off agent says so and offers Turn on, instead of
    // looking ready (Found, Not checked) while the page says no agent is set up.
    if (shared && !a.enabled && !running && !waiting) {
      head.append(
        el('span', 'Turned off', 'st-status dim'),
        button('Turn on', () => saveQuiet(togglePatch(a.id, true)), 'st-primary'),
      );
      row.append(head, note('Turned off in Settings, so new chats cannot use it. Turn it on to set it up here.', 'dim'));
      return row;
    }
    if (running) head.append(button('Cancel', () => cancelInstall(a), 'st-cancel'));
    else if (waiting)
      head.append(
        el('span', 'Waiting for sign-in…', 'st-status warn'),
        button('Cancel', () => cancelSignin(a), 'st-cancel'),
      );
    else {
      const st = statusText(a);
      head.append(el('span', st.text, 'st-status ' + st.cls));
      if (canSignIn(a)) head.append(button('Sign in', () => startSignin(a), 'st-primary'));
      if (a.found && a.signin) head.append(button('Check again', () => checkSignins(true), 'st-link'));
      if (canInstall(a))
        head.append(
          button(job && (job.state === 'failed' || refused) ? 'Retry' : 'Install', () => startInstall(a), 'st-primary'),
        );
    }
    row.append(head);
    if (running) {
      row.append(progressBar(a, job), note(progressText(a, job)));
    } else if (waiting) {
      row.append(
        note(
          'Finish signing in to ' +
            a.name +
            ' in the window that opened. AIB does not see your password or sign-in details.',
        ),
      );
    } else {
      const st = statusText(a);
      if (st.text !== 'Not installed') {
        row.append(
          el('span', 'Launcher', 'st-hint'),
          el('code', a.launcher || a.command || '(no command)', 'st-command'),
        );
      }
      const sign = signinOf(a);
      if (sign && sign.state === 'failed') row.append(note(sign.message || 'The sign-in failed.', 'bad'));
      else if (sign && sign.state === 'manual') {
        const line = note(
          (sign.message || 'Run this in a terminal, finish the sign-in there, then choose Check again.') + ' ',
          'dim',
        );
        line.append(el('code', sign.command || '', 'st-command'));
        row.append(line);
      }
      // One line under the row: a failure wins, then why installs cannot run, then what the agent is missing.
      const block = installBlock(a);
      if (job && job.state === 'failed') row.append(note(job.message || 'The install failed.', 'bad'));
      else if (refused) row.append(note(job.message, 'bad'));
      else if (block && shared) {
        /* drawn once by the page */
      } else if (block) {
        const line = note(block + (a.installHint ? ' ' + a.installHint : ''), 'dim');
        line.append(
          ' ',
          button('Check again', () => load(true), 'st-link'),
        );
        row.append(line);
      } else if (!a.found && a.problem && !(a.installable && /^Not installed/.test(a.problem)))
        row.append(note(a.problem, canInstall(a) || (a.installable && a.launcherSource === 'missing') ? 'dim' : 'bad'));
    }
    if (!a.builtin) {
      const bits = [];
      if (a.args && a.args.length) bits.push(a.args.length + (a.args.length === 1 ? ' argument' : ' arguments'));
      if (a.env && a.env.length)
        bits.push(
          a.env.length + (a.env.length === 1 ? ' environment variable' : ' environment variables') + ' (hidden)',
        );
      if (bits.length) row.append(note(bits.join(' · ')));
    }
    const actions = el('div', null, 'st-actions');
    actions.append(
      toggle(a.enabled ? 'On' : 'Off', a.enabled, (on) => {
        saveQuiet(togglePatch(a.id, on)); // on/off only: the agent's command, arguments and environment are never sent back
      }),
    );
    if (opts && opts.uninstall && canUninstall(a) && !running && !waiting) {
      actions.append(button('Uninstall', () => uninstallAgent(a), 'st-danger'));
    }
    if (!a.builtin) {
      actions.append(
        button('Edit', () => {
          S.form = formFrom(a);
          renderContent();
          focusForm();
        }),
        button('Remove', () => removeAgent(a), 'st-danger'),
      );
    }
    row.append(actions);
    if (!a.builtin && S.form && S.form.id === a.id) row.append(agentForm());
    return row;
  }
  function removeAgent(a) {
    const ok =
      typeof root.confirm === 'function'
        ? root.confirm(
            'Remove ' +
              a.name +
              '? Chats already saved with it stay in the list but cannot be reopened until you add it again with the same name.',
          )
        : true;
    if (ok) saveQuiet({ agents: { remove: a.id } });
  }
  // Environment values never reach this page: the server sends {name, set: true}. A row keeps `set` (a value is stored) and `value`
  // (only what the user typed this time). Sending a row without a value tells the server to keep the stored one.
  const togglePatch = (id, on) => ({ agents: { enabled: { [id]: !!on } } });
  const envRowsFrom = (env) =>
    (Array.isArray(env) ? env : [])
      .filter((e) => e && typeof e.name === 'string')
      .map((e) => ({ name: e.name, set: e.set !== false, value: '' }));
  const envForSave = (rows) =>
    rows
      .filter((r) => r.name.trim())
      .map((r) => (r.value !== '' || !r.set ? { name: r.name.trim(), value: r.value } : { name: r.name.trim() }));
  const formFrom = (a) => ({
    id: a ? a.id : null,
    name: a ? a.name : '',
    command: a ? a.command : '',
    args: a ? (a.args || []).join('\n') : '',
    env: envRowsFrom(a && a.env),
    enabled: a ? a.enabled : true,
    show: false,
  });
  function focusForm() {
    const n = S.content && S.content.querySelector('.st-form input');
    if (n && n.focus) n.focus();
  }
  function agentForm() {
    const f = S.form,
      form = el('form', null, 'st-form');
    form.setAttribute('aria-label', f.id ? 'Edit agent' : 'Add an ACP agent');
    const name = el('input');
    name.type = 'text';
    name.value = f.name;
    name.maxLength = 40;
    name.autocomplete = 'off';
    name.addEventListener('input', () => {
      f.name = name.value;
    });
    const command = el('input');
    command.type = 'text';
    command.value = f.command;
    command.autocomplete = 'off';
    command.spellcheck = false;
    command.placeholder = 'C:\\path\\to\\adapter.exe  or  a name on PATH';
    command.addEventListener('input', () => {
      f.command = command.value;
    });
    const args = el('textarea');
    args.rows = 3;
    args.value = f.args;
    args.spellcheck = false;
    args.placeholder = 'one argument per line';
    args.addEventListener('input', () => {
      f.args = args.value;
    });
    form.append(
      field('Name', name, 'Shown in the New chat list.'),
      field(
        'Command',
        command,
        'An existing program file, or a name found on PATH. Run directly, never through a shell.',
      ),
      field('Arguments', args, 'One per line.'),
    );
    // One line per variable: its name, and a value box that stays blank unless you type a new value (blank keeps the stored one).
    const envField = el('div', null, 'st-field'),
      envRows = el('div', null, 'st-env-rows');
    const drawEnv = () => {
      envRows.textContent = '';
      f.env.forEach((r, i) => {
        const line = el('div', null, 'st-line st-env-row');
        const n = el('input');
        n.type = 'text';
        n.value = r.name;
        n.placeholder = 'NAME';
        n.spellcheck = false;
        n.autocomplete = 'off';
        n.readOnly = !!r.set;
        n.setAttribute('aria-label', 'Variable name');
        n.addEventListener('input', () => {
          r.name = n.value;
        });
        const v = el('input');
        v.type = f.show ? 'text' : 'password';
        v.value = r.value;
        v.autocomplete = 'new-password';
        v.spellcheck = false;
        v.placeholder = r.set ? '•••• (set)' : 'value';
        v.setAttribute(
          'aria-label',
          r.set ? 'New value for ' + r.name + ' (leave blank to keep the stored value)' : 'Value',
        );
        v.addEventListener('input', () => {
          r.value = v.value;
        });
        line.append(
          n,
          v,
          button(
            'Remove',
            () => {
              f.env.splice(i, 1);
              drawEnv();
            },
            'st-danger',
          ),
        );
        envRows.append(line);
      });
    };
    drawEnv();
    envField.append(
      el('span', 'Environment variables', 'st-label'),
      envRows,
      button('Add a variable', () => {
        f.env.push({ name: '', set: false, value: '' });
        drawEnv();
      }),
    );
    envField.append(
      toggle('Show values I type', f.show, (on) => {
        f.show = on;
        drawEnv();
      }),
    );
    envField.append(
      el(
        'span',
        'Values are stored as plain text in the state folder' +
          (S.boot && S.boot.stateDir ? ' (' + S.boot.stateDir + ')' : '') +
          ' and passed to the agent as they are. Do not paste anything you would not keep in a file there. Saved values are never shown on this page; type a new value to replace one.',
        'st-hint warn',
      ),
    );
    form.append(envField);
    form.append(
      toggle('Enabled (offered in the New chat list)', f.enabled, (on) => {
        f.enabled = on;
      }),
    );
    const bar = el('div', null, 'st-actions');
    const submit = el('button', f.id ? 'Save changes' : 'Add agent', 'primary');
    submit.type = 'submit';
    submit.disabled = S.busy;
    bar.append(
      submit,
      button('Cancel', () => {
        S.form = null;
        S.error = '';
        renderAll();
      }),
    );
    form.append(bar);
    if (S.error) {
      const e = el('p', S.error, 'st-error');
      e.setAttribute('role', 'alert');
      form.append(e);
    }
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const upsert = { name: f.name, command: f.command, args: f.args, env: envForSave(f.env), enabled: f.enabled };
      if (f.id) upsert.id = f.id;
      save({ agents: { upsert } }).then(
        () => {
          S.form = null;
          renderAll();
        },
        () => {},
      );
    });
    return form;
  }
  function renderAgentsList(box) {
    const list = agents();
    if (!list.length)
      box.append(note(S.loadError ? 'The agent list could not be read from the server: ' + S.loadError : 'Loading…'));
    const blocked = list.find((a) => installBlock(a));
    if (blocked) {
      const line = note(blocked.installBlock + (blocked.installHint ? ' ' + blocked.installHint : ''), 'dim');
      line.append(
        ' ',
        button('Check again', () => load(true), 'st-link'),
      );
      box.append(line);
    }
    for (const a of orderAgents(list)) box.append(agentRow(a, { sharedBlock: true, uninstall: true })); // Settings only, not the start page
    box.append(
      note(
        '"Found" means the program exists. Sign-in state comes from a quick status check AIB runs when Settings opens and after an install or sign-in; agents with no status check show Not checked. Saved chats and transcripts are found for Claude Code and OMP only; chats with agents you add appear in the list once opened here.',
      ),
    );
  }
  function renderAgentsAdd(box) {
    if (S.form && !S.form.id) {
      box.append(agentForm());
      return;
    }
    box.append(
      note('Any agent that speaks the Agent Client Protocol over standard input and output can be added here.'),
    );
    box.append(
      button(
        'Add an ACP agent…',
        () => {
          S.form = formFrom(null);
          S.error = '';
          renderContent();
          focusForm();
        },
        'primary st-add',
      ),
    );
  }

  // ---- Defaults --------------------------------------------------------------------------------------------------
  function agentOptions(extra) {
    return (extra ? [['', extra]] : []).concat(enabledAgents().map((a) => [a.id, a.name]));
  }
  function renderDefaultAgent(box) {
    const d = defaults();
    box.append(
      field(
        'Agent',
        select(
          agentOptions('Last used in the project, else ' + ((enabledAgents()[0] || {}).name || 'the first agent')),
          d.agent || '',
          (v) => saveQuiet({ defaults: { agent: v } }),
          'Default agent',
        ),
        'Used when a project has no default of its own.',
      ),
    );
  }
  // A model or mode picker: a list when the agent has reported its choices before, else a text box.
  function pickControl(agentId, kind, value, onChange) {
    const AC = root.AgentChoice,
      opts = AC && AC.loadOptions ? AC.loadOptions(root.localStorage, agentId) : {};
    const option = opts[kind];
    if (option && option.choices && option.choices.length) {
      const list = [['', 'Agent default']].concat(option.choices.map((c) => [c.value, c.name]));
      if (value && !list.some((x) => x[0] === value)) list.push([value, value]);
      return select(list, value || '', onChange, kind === 'model' ? 'Model' : 'Mode');
    }
    const input = el('input');
    input.type = 'text';
    input.value = value || '';
    input.placeholder = 'Agent default';
    input.maxLength = 200;
    input.spellcheck = false;
    input.title = 'The list appears after a chat with this agent has opened once.';
    input.addEventListener('change', () => onChange(input.value.trim()));
    return input;
  }
  function renderDefaultPicks(box) {
    const d = defaults(),
      list = enabledAgents();
    if (!list.length) box.append(note('No agent is turned on.'));
    for (const a of list) {
      const mine = (d.byAgent || {})[a.id] || {},
        row = el('div', null, 'st-line');
      row.append(
        el('strong', a.name, 'st-line-name'),
        field(
          'Model',
          pickControl(a.id, 'model', mine.model, (v) => saveQuiet({ defaults: { byAgent: { [a.id]: { model: v } } } })),
        ),
        field(
          'Mode',
          pickControl(a.id, 'mode', mine.mode, (v) => saveQuiet({ defaults: { byAgent: { [a.id]: { mode: v } } } })),
        ),
      );
      box.append(row);
    }
    box.append(
      note(
        'A text box means this agent has not reported its models or modes yet: they are listed after a chat with it has opened once. A pick that the agent no longer offers is skipped.',
      ),
    );
  }
  function knownProjects() {
    const W = root.AgentWorkspaceUI,
      AC = root.AgentChoice,
      out = new Map();
    try {
      for (const p of W && W.paletteProjects ? W.paletteProjects() : [])
        if (p.path)
          out.set(AC.projectKey(p.path), { key: AC.projectKey(p.path), name: p.name || p.path, path: p.path });
    } catch (e) {
      /* the workspace module is not ready */
    }
    for (const key of Object.keys(defaults().projects || {}))
      if (!out.has(key)) out.set(key, { key, name: key.replace(/^[wp]:/, ''), path: key.replace(/^[wp]:/, '') });
    return [...out.values()];
  }
  function renderDefaultProjects(box) {
    const d = defaults(),
      set = d.projects || {},
      projects = knownProjects();
    box.append(
      note(
        'The agent you start a chat with in a project is remembered here automatically. Change or clear it any time.',
      ),
    );
    const withDefaults = projects.filter((p) => set[p.key]);
    for (const p of withDefaults) {
      const mine = set[p.key],
        agentId = mine.agent || d.agent || (enabledAgents()[0] || {}).id,
        row = el('div', null, 'st-line');
      const name = el('strong', p.name, 'st-line-name');
      name.title = p.path;
      row.append(
        name,
        field(
          'Agent',
          select(
            agentOptions('Same as global default'),
            mine.agent || '',
            (v) => saveQuiet({ defaults: { projects: { [p.key]: { agent: v } } } }),
            'Agent for ' + p.name,
          ),
        ),
        field(
          'Model',
          pickControl(agentId, 'model', mine.model, (v) =>
            saveQuiet({ defaults: { projects: { [p.key]: { model: v } } } }),
          ),
        ),
        field(
          'Mode',
          pickControl(agentId, 'mode', mine.mode, (v) =>
            saveQuiet({ defaults: { projects: { [p.key]: { mode: v } } } }),
          ),
        ),
        button('Clear', () => saveQuiet({ defaults: { projects: { [p.key]: null } } }), 'st-danger'),
      );
      box.append(row);
    }
    const rest = projects.filter((p) => !set[p.key]);
    if (rest.length) {
      const sel = select(
        [['', 'Set defaults for a project…']].concat(rest.map((p) => [p.key, p.name])),
        '',
        (v) => {
          if (v) saveQuiet({ defaults: { projects: { [v]: { agent: (enabledAgents()[0] || {}).id || '' } } } });
        },
        'Add project defaults',
      );
      sel.className = 'st-add-project';
      box.append(sel);
    } else if (!withDefaults.length) box.append(note('No projects yet. Add one with + above the chat list.'));
  }

  // ---- Notifications / Editors / Keyboard / Appearance ----------------------------------------------------------
  function renderNotifications(box) {
    box.append(note("These apply to this browser only: desktop notifications need this browser's permission."));
    const slot = el('div', null, 'st-notify');
    box.append(slot);
    if (root.AgentNotifyUI && root.AgentNotifyUI.mountSettings) root.AgentNotifyUI.mountSettings(slot);
  }
  function renderEditors(box) {
    const E = root.AgentEditors;
    if (!E || !E.loaded()) {
      box.append(note('Looking for editors on this PC…'));
      if (E && E.refresh)
        E.refresh().then(() => {
          if (S.open) renderContent();
        });
      return;
    }
    const eds = E.editors();
    if (!eds.length) {
      box.append(
        note(
          'No editor found. AIB looks for VS Code, Cursor, Windsurf and Devin on PATH and in their usual install folders.',
        ),
      );
    } else {
      const sel = select(
        eds.map((e) => [e.id, e.name + (e.capabilities.fileAtLine ? '' : ' (folders only)')]),
        E.default,
        (v) => {
          E.setDefault(v)
            .then(() => E.refresh())
            .then(() => {
              if (S.open) renderContent();
            });
        },
        'Default editor',
      );
      box.append(
        field(
          'Default editor',
          sel,
          'Used by Open in editor on projects, chats and file rows. Files and workspaces open in the first editor that supports them when this one cannot.',
        ),
      );
    }
    const others = E.list()
      .filter((e) => e.kind !== 'editor')
      .map((e) => e.name);
    box.append(note('Also available: ' + (others.length ? others.join(', ') : 'nothing else') + '.'));
  }
  function renderKeyboard(box) {
    const C = root.AgentCommands,
      W = root.AgentSwitcherUI;
    let groups = [];
    try {
      groups = C && C.sheetModel ? C.sheetModel(W && W.makeCtx ? W.makeCtx() : { do: {} }) : [];
    } catch (e) {
      groups = C && C.sheetModel ? C.sheetModel({ do: {} }) : [];
    }
    for (const g of groups) {
      box.append(el('h4', g.name, 'st-group'));
      const ul = el('ul', null, 'st-keys');
      for (const r of g.rows) {
        const li = el('li');
        li.append(el('span', r.label));
        const keys = el('span', null, 'st-kbd');
        r.keys.split(' / ').forEach((k, i) => {
          if (i) keys.append(doc().createTextNode(' / '));
          keys.append(el('kbd', k));
        });
        li.append(keys);
        ul.append(li);
      }
      box.append(ul);
    }
    box.append(note('Read-only for now. Press ? anywhere to see this list in a sheet.'));
  }

  // Text size: owned by textsize-ui.js (per window-width bucket, localStorage), kept in the data folder by view-prefs.js, not by the server settings.
  function renderTextSize(box) {
    const T = root.AgentTextSize;
    if (!T || typeof T.getChat !== 'function') {
      box.append(note('Text size is not available on this page.'));
      return;
    }
    const lim = T.limits(),
      steps = (r) => {
        const a = [];
        for (let v = r.min; v <= r.max; v += r.step) a.push([String(v), v + '%']);
        return a;
      };
    const paint = () => {
      box.textContent = '';
      renderTextSize(box);
    };
    box.append(
      note(
        'Saved with your AIB data for the current window width: a laptop screen and a big monitor each remember their own.',
      ),
    );
    box.append(
      field(
        'Chat text',
        select(
          steps(lim.chat),
          String(T.getChat()),
          (v) => {
            T.setChat(Number(v));
          },
          'Chat text size',
        ),
        'Messages, tables, tool rows, code, subagent history and the message box. Ctrl+= / Ctrl+- / Ctrl+0 in the chat.',
      ),
    );
    box.append(
      field(
        'Interface',
        select(
          steps(lim.ui),
          String(T.getUi()),
          (v) => {
            T.setUi(Number(v));
          },
          'Interface size',
        ),
        'Chat list, tabs, header, Activity and menus. Ctrl+Shift+= / Ctrl+Shift+- anywhere.',
      ),
    );
    box.append(
      field(
        'Code font',
        select(
          T.fontOptions().map((o) => [o.name, o.label]),
          T.getCodeFont(),
          (v) => T.setCodeFont(v),
          'Code font',
        ),
        'Only fonts this computer can draw are listed.',
      ),
    );
    box.append(
      field(
        'Line spacing',
        select(
          T.spacingOptions().map((o) => [o.name, o.label]),
          T.getLineSpacing(),
          (v) => T.setLineSpacing(v),
          'Line spacing',
        ),
        'Comfortable is the normal spacing.',
      ),
    );
    box.append(
      button('Reset to normal', () => {
        T.setChat(100);
        T.setUi(100);
        T.setCodeFont('');
        T.setLineSpacing('comfortable');
        paint();
      }),
    );
  }

  // ---- Studio server ---------------------------------------------------------------------------------------------
  const when = (seconds) => {
    if (!seconds) return 'unknown';
    try {
      return new Date(seconds * 1000).toLocaleString();
    } catch (e) {
      return 'unknown';
    }
  };
  // The chat view a new chat (or one with no saved choice) starts in. "Prompts" is a switch-to view, so it is not offered here.
  const DEFAULT_VIEWS = [
    ['full', 'Full', 'everything, as today'],
    ['chat', 'Chat', "your prompts and the AI's messages, with the steps between folded"],
  ];
  function defaultView() {
    const v = S.data && S.data.settings && S.data.settings.appearance && S.data.settings.appearance.defaultView;
    return DEFAULT_VIEWS.some((x) => x[0] === v) ? v : 'full';
  }
  function renderDefaultView(box) {
    const now = defaultView(),
      group = el('div', null, 'st-radios');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Default chat view');
    for (const [value, name, what] of DEFAULT_VIEWS) {
      const l = el('label', null, 'st-toggle st-radio'),
        r = el('input');
      r.type = 'radio';
      r.name = 'default-chat-view';
      r.value = value;
      r.checked = value === now;
      r.addEventListener('change', () => {
        if (r.checked) saveQuiet({ appearance: { defaultView: value } });
      });
      const t = el('span');
      t.append(el('b', name), doc().createTextNode(' · ' + what));
      l.append(r, t);
      group.append(l);
    }
    box.append(
      note(
        'New chats, and chats you have not switched yourself, start in this view. Every chat has its own switch in its header.',
      ),
      group,
      note('"Prompts" isn\'t offered here: it\'s for finding something, so it is a switch-to view only.'),
    );
  }
  function renderAutoReconnect(box) {
    const on = !(S.data && S.data.settings.server && S.data.settings.server.autoReconnect === false);
    box.append(
      toggle('Reconnect the chats that were open before a restart', on, (v) =>
        saveQuiet({ server: { autoReconnect: v } }),
      ),
    );
    box.append(
      note(
        'Applies after restart (the next time the agent host starts). Nothing is ever sent when chats reconnect. The command-line flag --no-auto-reconnect still wins.',
      ),
    );
    const running = S.boot && S.boot.server ? S.boot.server.hostAutoReconnect : null;
    if (typeof running === 'boolean')
      box.append(note('The agent host that is running now started with this ' + (running ? 'on' : 'off') + '.'));
  }
  function renderUpdates(box) {
    const server = () => (S.data && S.data.settings.server) || {};
    if (!root.AibUpdates) return;
    const slot = el('div', null, 'st-updates'); // the card redraws only this, so its heading stays
    box.append(slot);
    root.AibUpdates.renderCard(slot, {
      autoCheck: () => server().autoUpdateCheck !== false,
      saveAuto: (v) => saveQuiet({ server: { autoUpdateCheck: v } }),
    });
  }
  function renderServerInfo(box) {
    const b = S.boot || {},
      sv = b.server || {};
    const rows = [
      ['Version', sv.version ? 'AIB ' + sv.version : sv.versionLabel], // the full version, beta number included, as Updates shows it
      ['About', sv.aboutLine],
      ['State folder', b.stateDir || 'unknown'],
      ['Web server PID', b.pid],
      ['Agent host PID', b.hostPid],
      ['Mode', b.hostMode === 'split' ? 'Web server and separate agent host' : b.hostMode === 'keeper' ? 'One process; running agents are held by the keeper' : b.hostMode],
      ['Web server port', sv.webPort],
      ['Web server started', sv.webStartedAt ? when(sv.webStartedAt) : ''],
      ['Agent host started', sv.hostStartedAt ? when(sv.hostStartedAt) : ''],
      ['Host protocol', sv.protocol],
      ['Host file format', sv.hostFormat],
      ['Python', sv.python],
      ['Host instance', b.instanceId],
    ];
    const dl = el('dl', null, 'st-facts');
    for (const [k, v] of rows) if (v !== undefined && v !== null && v !== '') dl.append(el('dt', k), el('dd', v));
    box.append(dl);
    if (b.stateDir && root.navigator && root.navigator.clipboard)
      box.append(
        button('Copy state folder path', () => {
          root.navigator.clipboard
            .writeText(b.stateDir)
            .then(() => flash('Copied'))
            .catch(() => {});
        }),
      );
    if (b.hostProblem) box.append(note(b.hostProblem, 'bad'));
    // The keeper could not run (AIB fell back to running chats without it): one quiet line, no switch to change.
    if (sv.keeperProblem)
      box.append(note('Chats run without the keeper, so a restart or update stops them: ' + sv.keeperProblem));
  }
  function renderServerRestart(box) {
    box.append(note(serverRestartText(!!(root.AibDesktop && root.AibDesktop.available()))));
  }
  // In the desktop app: quit and start again (it asks before stopping chats that are working). From source: deploy in a terminal.
  function serverRestartText(desktopApp) {
    return desktopApp
      ? 'Restarting is not done from this page, so that a running turn is never cut off by accident: quit AIB (tray icon > Quit AIB) and start it again. AIB asks before it stops chats that are working.'
      : 'Restarting is done from a terminal, not from this page, so that a running turn is never cut off by accident: run "deno run -A outputs/agent-studio/server/main.ts deploy" (web server only; agents keep working), or add --host to also restart the agent host once nothing is working. See docs/agent-host.md.';
  }
  function flash(text) {
    S.flash = text;
    renderContent();
    root.setTimeout(() => {
      S.flash = '';
      renderContent();
    }, 1500);
  }

  const RENDER = {
    'agents-list': renderAgentsList,
    'agents-add': renderAgentsAdd,
    'default-agent': renderDefaultAgent,
    'default-picks': renderDefaultPicks,
    'default-projects': renderDefaultProjects,
    notifications: renderNotifications,
    editors: renderEditors,
    keyboard: renderKeyboard,
    'text-size': renderTextSize,
    'default-view': renderDefaultView,
    'auto-reconnect': renderAutoReconnect,
    'server-info': renderServerInfo,
    updates: renderUpdates,
    'server-restart': renderServerRestart,
  };
  const TITLES = {
    'agents-list': 'Agents',
    'agents-add': 'Add an ACP agent',
    'default-agent': 'Default agent',
    'default-picks': 'Default model and mode',
    'default-projects': 'Per project',
    notifications: 'Notifications',
    editors: 'Editors',
    keyboard: 'Keyboard shortcuts',
    'text-size': 'Text size',
    'default-view': 'Default chat view',
    'auto-reconnect': 'Reconnect after a restart',
    'server-info': 'About AIB',
    updates: 'Updates',
    'server-restart': 'Restart the web server',
  };

  // ---- the page --------------------------------------------------------------------------------------------------
  function build() {
    const page = el('section', null, 'st-page');
    page.id = 'settingsPage';
    page.hidden = true;
    page.setAttribute('role', 'dialog');
    page.setAttribute('aria-label', 'Settings');
    page.setAttribute('aria-modal', 'false');
    const nav = el('nav', null, 'st-nav');
    nav.setAttribute('aria-label', 'Settings sections');
    const search = el('input', null, 'st-search');
    search.type = 'search';
    search.placeholder = 'Search settings';
    search.setAttribute('aria-label', 'Search settings');
    search.autocomplete = 'off';
    search.addEventListener('input', () => {
      S.query = search.value;
      renderAll(false);
    });
    const list = el('div', null, 'st-sections');
    nav.append(search, list);
    const body = el('div', null, 'st-main');
    const head = el('header', null, 'st-head');
    const title = el('h2', 'Settings');
    const close = el('button', '×', 'st-close');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close settings');
    close.addEventListener('click', closePage);
    head.append(title, close);
    const content = el('div', null, 'st-content');
    body.append(head, content);
    // The page is a size container (settings.css): when it is too narrow for the section list beside the settings (a big
    // Interface size in a small window), the list moves above them instead of squeezing them.
    const frame = el('div', null, 'st-frame');
    frame.append(nav, body);
    page.append(frame);
    S.page = page;
    S.nav = list;
    S.content = content;
    S.search = search;
    S.title = title;
    return page;
  }
  function renderNav() {
    const counts = sectionCounts(INDEX, S.query),
      searching = !!S.query.trim();
    S.nav.replaceChildren(
      ...SECTIONS.map((s) => {
        const b = el(
          'button',
          null,
          'st-section' +
            (!searching && S.section === s.id ? ' active' : '') +
            (searching && !counts[s.id] ? ' empty' : ''),
        );
        b.type = 'button';
        b.append(el('span', s.label));
        if (searching) b.append(el('span', String(counts[s.id]), 'st-count'));
        if (!searching && S.section === s.id) b.setAttribute('aria-current', 'page');
        b.addEventListener('click', () => {
          S.query = '';
          S.search.value = '';
          S.section = s.id;
          renderAll();
        });
        return b;
      }),
    );
  }
  function renderContent() {
    if (!S.content) return;
    const searching = !!S.query.trim();
    const entries = searching ? filterIndex(INDEX, S.query) : INDEX.filter((e) => e.section === S.section);
    S.title.textContent = searching ? 'Search results' : pageHeading(S.section);
    const frag = doc().createDocumentFragment();
    if (S.loadError && !S.data) {
      const n = note(
        'Settings could not be loaded: ' + S.loadError + ' The built-in agents are still available.',
        'bad',
      );
      n.setAttribute('role', 'alert');
      frag.append(n);
    }
    if (S.error && !S.form) {
      const n = el('p', S.error, 'st-error');
      n.setAttribute('role', 'alert');
      frag.append(n);
    }
    if (S.data && S.data.warning) frag.append(note(S.data.warning, 'bad'));
    if (!entries.length) frag.append(note('No settings match "' + S.query.trim() + '".'));
    let lastSection = '';
    for (const e of entries) {
      if (searching && e.section !== lastSection) {
        lastSection = e.section;
        frag.append(el('h4', sectionLabel(e.section), 'st-group'));
      }
      const c = card(TITLES[e.id] || e.label);
      c.dataset.setting = e.id;
      try {
        RENDER[e.id](c);
      } catch (err) {
        c.append(note('This part could not be drawn: ' + err.message, 'bad'));
      }
      frag.append(c);
    }
    if (S.flash) {
      const f = el('div', S.flash, 'st-flash');
      f.setAttribute('role', 'status');
      frag.append(f);
    }
    // Keep typing places: the agent form's focus survives because it is only redrawn by explicit actions.
    S.content.replaceChildren(frag);
  }
  function renderAll() {
    if (!S.page) return;
    renderNav();
    renderContent();
  }

  function bootstrap() {
    return Promise.resolve()
      .then(() => S.host.get('/api/live/bootstrap'))
      .then(
        (b) => {
          S.boot = b;
        },
        () => {},
      );
  }
  // Settings -> Agents with the "Add an ACP agent" form open (the start page links here).
  function openAddAgent() {
    openPage('agents');
    S.form = formFrom(null);
    S.error = '';
    renderContent();
    focusForm();
  }
  // Why an agent row is stuck, for the start page: 'node' (installs cannot run), 'failed' (the install or sign-in failed), 'missing'
  // (not installed and Studio cannot install it), or '' (still usable: an Install or Sign in button works, or a job is running).
  function trouble(a) {
    if (installBlock(a)) return 'node';
    const job = installOf(a),
      sign = signinOf(a);
    if (job && (job.state === 'failed' || job.state === 'refused')) return 'failed';
    if (sign && sign.state === 'failed') return 'failed';
    if (!a.found && !a.installable) return 'missing';
    return '';
  }
  function openPage(section) {
    if (!S.page) return;
    if (section && SECTIONS.some((s) => s.id === section)) {
      S.section = section;
      S.query = '';
      S.search.value = '';
    }
    S.last = doc().activeElement;
    S.open = true;
    S.page.hidden = false;
    doc().body.classList.add('settings-open');
    S.error = '';
    renderAll();
    Promise.all([load(), bootstrap()]).then(() => {
      if (S.open) renderAll();
      return checkSignins(false); // refreshes the Status column once per open
    });
    S.search.focus();
  }
  function closePage() {
    if (!S.page || !S.open) return;
    S.open = false;
    S.page.hidden = true;
    doc().body.classList.remove('settings-open');
    S.form = null;
    S.error = '';
    const back = S.last;
    S.last = null;
    if (back && back.focus && doc().contains(back)) {
      try {
        back.focus();
      } catch (e) {
        /* element is gone */
      }
    }
  }
  const toggleOpen = (section) => (S.open && !section ? closePage() : openPage(section));

  function onKey(event) {
    const key = String(event.key || ''),
      mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && !event.altKey && key === ',') {
      event.preventDefault();
      toggleOpen();
      return true;
    }
    if (key === 'Escape' && S.open && !event.defaultPrevented) {
      if (doc().querySelector('dialog[open]')) return false; // the command bar or the sheet is on top: it closes first
      if (S.form) {
        S.form = null;
        S.error = '';
        renderAll();
        event.preventDefault();
        return true;
      }
      event.preventDefault();
      closePage();
      return true;
    }
    return false;
  }

  // host: {get(path), post(name, body), registryChanged()}
  function init(host) {
    S.host = host;
    const mount = doc().querySelector('main') || doc().body;
    mount.append(build());
    doc().addEventListener('keydown', onKey);
    const gear = doc().getElementById('openSettings');
    if (gear) gear.addEventListener('click', () => toggleOpen());
    if (root.AgentChoice && root.AgentChoice.setSink) root.AgentChoice.setSink(remember);
  }

  const api = {
    init,
    load,
    sync,
    open: openPage,
    close: closePage,
    isOpen: () => S.open,
    onKey,
    remember,
    defaultView,
    DEFAULT_VIEWS,
    renderDefaultView,
    filterIndex,
    sectionCounts,
    checkSignins, // refresh the cached sign-in status (once per Settings open; force for "Check again")
    openAddAgent,
    trouble,
    onChange,
    agentList: agents,
    loaded: () => !!S.data,
    recheck: () => load(true), // "Check again": ask the server for a fresh Node.js and agent status, once
    orderAgents,
    installBlockOf: installBlock,
    agentRow, // one agent's row (status, Install / Cancel / Retry); a start page can draw the same row
    togglePatch,
    envRowsFrom,
    envForSave,
    SECTIONS,
    INDEX,
    serverRestartText,
    _state: S,
  };
  root.AgentSettingsUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
