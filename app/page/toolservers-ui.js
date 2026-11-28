(function (root) {
  'use strict';
  // Settings > Tool servers, and the "Tools N of M" chip under the message box (design: aib-shared/designs/tool-servers/prototype.html).
  // Which MCP servers, and which single tools of them, a project's chats load. AIB reads the agents' own settings and never changes
  // them; the choice is AIB's own, per project (server: toolservers/*, one call: POST /api/live/tool-servers {op: view|set, path, ...}).
  // A change reaches new chats at once; open chats of the project restart themselves when idle (the apply line names them).
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const NEW = '_new';
  const S = { project: '', data: null, loading: false, error: '', expanded: '', filter: '', host: null, box: null, seq: 0 };
  // The chip's numbers per project folder: { on, total, at }.
  const chipCache = new Map();
  const inflight = new Set();

  const projects = () => {
    try {
      return (root.AgentWorkspaceUI && root.AgentWorkspaceUI.paletteProjects ? root.AgentWorkspaceUI.paletteProjects() : []).filter((p) => p.path);
    } catch (e) {
      return [];
    }
  };
  const activePath = () => {
    try {
      const p = root.AgentWorkspaceUI && root.AgentWorkspaceUI.activeProject ? root.AgentWorkspaceUI.activeProject() : null;
      return p && p.path ? p.path : '';
    } catch (e) {
      return '';
    }
  };
  const openChats = (path) => {
    try {
      return root.AIBToolServersHost && root.AIBToolServersHost.openChats && path !== NEW ? root.AIBToolServersHost.openChats(path) : [];
    } catch (e) {
      return [];
    }
  };
  const call = (host, body) => host.post('tool-servers', body);

  // ---- the numbers ------------------------------------------------------------------------------------------------------------
  function memoryText(s) {
    if (s.locked) return 'Runs inside AIB';
    if (s.kind === 'remote') return 'Remote · no process here';
    const m = s.memory || {};
    const procs = m.procs + ' process' + (m.procs === 1 ? '' : 'es');
    return procs + ' · ~' + m.mb + ' MB a chat' + (m.measured ? '' : ' (estimate)');
  }
  function summaryText(d) {
    const x = d.summary;
    const procs = x.procs + ' local server process' + (x.procs === 1 ? '' : 'es');
    let t = 'Each new chat here starts ' + procs + ' (~' + x.mb + ' MB' + (x.estimate ? ', estimate' : '') + ')';
    if (x.mb !== x.allMb || x.procs !== x.allProcs) t += '; with everything on: ' + x.allProcs + ' (~' + x.allMb + ' MB)';
    return t + '.';
  }
  function applyText(d, chats) {
    if (!chats.length) return '';
    const stale = chats.filter((c) => d.stale.indexOf(c.id) >= 0);
    if (!stale.length) return 'All ' + chats.length + ' open chat' + (chats.length === 1 ? '' : 's') + ' run this list.';
    const names = stale.map((c) => c.title || 'Chat').join(', ');
    return (
      'New chats get this at once. ' + stale.length + ' open chat' + (stale.length === 1 ? '' : 's') + ' (' + names + ') restart' + (stale.length === 1 ? 's' : '') +
      ' to pick it up the next time ' + (stale.length === 1 ? 'it is' : 'they are') + ' idle.'
    );
  }
  function whenText(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const two = (n) => (n < 10 ? '0' : '') + n;
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  // ---- drawing ----------------------------------------------------------------------------------------------------------------
  function checkbox(on, disabled, label, onChange) {
    const i = el('input');
    i.type = 'checkbox';
    i.checked = !!on;
    i.disabled = !!disabled;
    i.setAttribute('aria-label', label);
    if (onChange) i.addEventListener('change', () => onChange(i.checked));
    return i;
  }

  function serverRow(d, s, chats) {
    const frag = doc().createDocumentFragment();
    const open = S.expanded === s.id;
    const row = el('div', null, 'ts-line' + (s.on ? '' : ' ts-off'));
    row.dataset.server = s.id;
    const tick = checkbox(s.on, s.locked, s.name + ' on in ' + (S.project === NEW ? 'new projects' : projectName(S.project)), (v) => set({ server: s.id, on: v }));
    if (s.locked) tick.title = "Always on: AIB's docs, artifacts and helpers need it";
    tick.dataset.serverToggle = s.id;
    const name = el('span', null, 'ts-name');
    name.append(el('b', s.name + (s.locked ? ' · always on' : '')), el('span', s.fromText));
    row.append(tick, name, el('span', s.agents.join(', '), 'ts-col ts-agents'), el('span', memoryText(s), 'ts-col ts-memory'));
    const off = s.tools.filter((t) => !t.on).length;
    const known = s.tools.length;
    const button = el('button', known ? (off ? known - off + ' of ' + known + ' tools' : known + ' tools') + (open ? ' ▾' : ' ▸') : 'Tools' + (open ? ' ▾' : ' ▸'));
    button.type = 'button';
    button.dataset.expand = s.id;
    button.setAttribute('aria-expanded', String(open));
    button.title = 'Turn single tools of ' + s.name + ' on or off';
    button.addEventListener('click', () => {
      S.expanded = open ? '' : s.id;
      S.filter = '';
      draw();
    });
    row.append(button);
    frag.append(row);
    if (open) frag.append(toolList(d, s));
    return frag;
  }

  function toolList(d, s) {
    const line = el('div', null, 'ts-line ts-line-tools');
    const box = el('div', null, 'ts-tools');
    const bar = el('div', null, 'ts-tbar');
    const find = el('input');
    find.type = 'search';
    find.id = 'toolFilter';
    find.placeholder = 'Find a tool';
    find.value = S.filter;
    find.setAttribute('aria-label', 'Find a tool of ' + s.name);
    find.addEventListener('input', () => {
      S.filter = find.value;
      grid.replaceChildren(...tools());
    });
    const allOn = el('button', 'All on');
    allOn.type = 'button';
    allOn.dataset.all = s.id;
    allOn.addEventListener('click', () => set({ server: s.id, allTools: { on: true } }));
    const allOff = el('button', 'All off');
    allOff.type = 'button';
    allOff.dataset.none = s.id;
    allOff.disabled = s.locked || !s.tools.length;
    allOff.addEventListener('click', () => set({ server: s.id, allTools: { on: false } }));
    bar.append(find, allOn, allOff);
    if (s.locked) bar.append(el('span', "AIB's own tools stay on.", 'st-hint'));
    else if (s.tools.length && s.toolsAt) bar.append(el('span', "Tool list from this server's last start, " + whenText(s.toolsAt) + '.', 'st-hint'));
    else if (!s.tools.length) bar.append(el('span', "AIB has not seen this server's tools yet. They are listed after a chat has used it.", 'st-hint'));
    const grid = el('div', null, 'ts-tgrid');
    const tools = () => {
      const f = S.filter.toLowerCase();
      return s.tools
        .filter((t) => !f || t.name.toLowerCase().indexOf(f) >= 0)
        .map((t) => {
          const label = el('label', null, 'st-toggle');
          const i = checkbox(t.on, s.locked || !s.on, t.name, (v) => set({ server: s.id, tool: t.name, toolOn: v }));
          i.dataset.tool = s.id + '|' + t.name;
          const text = el('span', t.name);
          text.title = t.name;
          label.append(i, text);
          return label;
        });
    };
    grid.append(...tools());
    box.append(bar, grid);
    line.append(el('span'), box);
    return line;
  }

  function projectName(path) {
    const p = projects().find((x) => x.path === path);
    return p ? p.name : path;
  }

  function picker() {
    const label = el('label', null, 'st-field ts-picker');
    label.append(el('span', 'Project', 'st-label'));
    const sel = el('select');
    sel.id = 'tsProject';
    sel.setAttribute('aria-label', 'Project');
    const list = projects();
    if (S.project && S.project !== NEW && !list.some((p) => p.path === S.project)) list.unshift({ name: S.project, path: S.project });
    for (const p of list) {
      const o = el('option', p.name);
      o.value = p.path;
      sel.append(o);
    }
    const n = el('option', 'New projects');
    n.value = NEW;
    sel.append(n);
    sel.value = S.project;
    sel.addEventListener('change', () => {
      S.project = sel.value;
      S.expanded = '';
      S.filter = '';
      load();
    });
    label.append(sel);
    if (S.project === NEW) label.append(el('span', 'What a project you add from now on starts with.', 'st-hint'));
    else if (S.data && S.data.wsl) label.append(el('span', 'Read from your settings in the Linux distro.', 'st-hint'));
    else label.append(el('span', S.project, 'st-hint'));
    return label;
  }

  function reachCard(d) {
    const card = el('section', null, 'st-card');
    card.dataset.setting = 'tool-servers-agents';
    card.append(el('h3', 'Which agents follow this list', 'st-card-title'));
    const ul = el('ul', null, 'ts-reach');
    for (const a of d.reach) {
      const li = el('li');
      li.dataset.agent = a.agent;
      li.dataset.reach = a.reach;
      li.append(el('b', a.name + ': '), doc().createTextNode(a.text + '.'));
      ul.append(li);
    }
    card.append(ul);
    return card;
  }

  function draw() {
    const box = S.box;
    if (!box) return;
    const keep = doc().activeElement && doc().activeElement.id === 'toolFilter' ? doc().activeElement.selectionStart : -1;
    const frag = doc().createDocumentFragment();
    const card = el('section', null, 'st-card');
    card.dataset.setting = 'tool-servers';
    card.append(el('h3', 'Tool servers', 'st-card-title'));
    card.append(el('p', "Chats in a project start only the tool servers ticked here. AIB reads your agents' settings and never changes them.", 'st-note'));
    card.append(picker());
    const d = S.data;
    if (S.error) {
      const n = el('p', S.error, 'st-note bad');
      n.setAttribute('role', 'alert');
      card.append(n);
    }
    if (!d) {
      card.append(el('p', S.loading ? 'Reading your agents’ settings…' : '', 'st-note'));
      frag.append(card);
      box.replaceChildren(frag);
      return;
    }
    if (S.project === NEW) {
      const rule = el('p', null, 'ts-rule');
      rule.append('A new project starts with ', el('b', 'servers that run on this PC off'), ' and ', el('b', 'remote ones on'), ' (claude.ai connectors, http servers).');
      card.append(rule);
    }
    const sum = el('p', summaryText(d), 'ts-sum');
    sum.id = 'tsSummary';
    card.append(sum);
    const hasOthers = d.servers.some((s) => !s.locked);
    for (const s of d.servers) card.append(serverRow(d, s, openChats(S.project)));
    if (!hasOthers) card.append(el('p', "No tool servers found in your agents' settings for this project. AIB's own tools are always on.", 'st-note'));
    const chats = openChats(S.project);
    const apply = applyText(d, chats);
    if (apply) {
      const p = el('p', apply, 'st-note ts-apply');
      p.id = 'tsApply';
      p.setAttribute('role', 'status');
      card.append(p);
    }
    frag.append(card, reachCard(d));
    box.replaceChildren(frag);
    if (keep >= 0) {
      const f = doc().getElementById('toolFilter');
      if (f && f.focus) {
        f.focus();
        try {
          f.setSelectionRange(keep, keep);
        } catch (e) {
          /* not a text input */
        }
      }
    }
  }

  // ---- talking to the server --------------------------------------------------------------------------------------------------
  function remember(path, d) {
    const list = d.servers;
    chipCache.set(path, { on: list.filter((s) => s.on).length, total: list.length, others: list.some((s) => !s.locked), at: Date.now() });
  }
  function load() {
    if (!S.host || !S.project) return Promise.resolve();
    const seq = ++S.seq;
    S.loading = true;
    S.data = null;
    S.error = '';
    draw();
    const path = S.project;
    return call(S.host, { op: 'view', path, chats: openChats(path).map((c) => c.id) }).then(
      (d) => {
        if (seq !== S.seq) return;
        S.loading = false;
        S.data = d;
        if (path !== NEW) remember(path, d);
        draw();
      },
      (e) => {
        if (seq !== S.seq) return;
        S.loading = false;
        S.error = 'Tool servers could not be read: ' + (e && e.message ? e.message : e);
        draw();
      },
    );
  }
  function set(change) {
    const path = S.project;
    const seq = ++S.seq;
    return call(S.host, Object.assign({ op: 'set', path, chats: openChats(path).map((c) => c.id) }, change)).then(
      (d) => {
        if (seq !== S.seq) return;
        S.error = '';
        S.data = d;
        if (path !== NEW) remember(path, d);
        draw();
        if (root.AIBToolServersHost && root.AIBToolServersHost.redraw) root.AIBToolServersHost.redraw();
      },
      (e) => {
        if (seq !== S.seq) return;
        S.error = 'That change was not saved: ' + (e && e.message ? e.message : e);
        draw();
      },
    );
  }

  /** Settings > Tool servers into `box`, with the settings page's host ({post}). */
  function render(box, host) {
    S.host = host;
    S.box = box;
    if (!S.project) S.project = activePath() || (projects()[0] && projects()[0].path) || NEW;
    load();
  }

  // ---- the chip under the message box -----------------------------------------------------------------------------------------
  /** {on, total} for the chip of a chat in this project folder, or null (nothing to choose, or not read yet: it is read, then `redraw` runs). */
  function chipFor(path, host, redraw) {
    if (!path || !host) return null;
    const known = chipCache.get(path);
    if ((!known || Date.now() - known.at > 30000) && !inflight.has(path)) {
      inflight.add(path);
      call(host, { op: 'view', path }).then(
        (d) => {
          inflight.delete(path);
          const before = chipCache.get(path);
          remember(path, d);
          const now = chipCache.get(path);
          if (redraw && (!before || before.on !== now.on || before.total !== now.total)) redraw();
        },
        () => {
          inflight.delete(path);
          chipCache.set(path, { on: 0, total: 0, others: false, at: Date.now() });
        },
      );
    }
    return known && known.others ? { on: known.on, total: known.total } : null;
  }
  /** The chip was clicked: Settings > Tool servers on this chat's project. */
  function openFor(path) {
    S.project = path || S.project;
    S.expanded = '';
    S.filter = '';
    if (root.AgentSettingsUI && root.AgentSettingsUI.open) root.AgentSettingsUI.open('tools');
  }

  const api = { render, chipFor, openFor, memoryText, summaryText, applyText, _state: S, _forget: () => chipCache.clear() };
  root.AIBToolServersUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
