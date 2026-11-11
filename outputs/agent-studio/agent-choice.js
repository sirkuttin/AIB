(function (root) {
  'use strict';
  // Pure logic for the Agent chip: which agents exist, which one a new chat starts with, which folder it starts in,
  // and the editable hand-off text used when a conversation is continued in the other agent. No DOM, no network.
  // The built-ins are always known (the page works before the server list arrives, and when it cannot be read).
  const BUILTINS = [
    { id: 'omp', name: 'OMP', letter: 'O', builtin: true, enabled: true },
    { id: 'claude', name: 'Claude Code', letter: 'C', builtin: true, enabled: true },
    { id: 'codex', name: 'Codex', letter: 'X', builtin: true, enabled: true },
  ];
  const ID_RE = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/;
  // The Beta agents (server/agents/beta_catalog.ts): known to AIB, untested by us, off until turned on in Settings. They are listed after
  // the tested agents (and the ones you added), under a "Beta" group label in the agent menus.
  const BETA_IDS = ['copilot', 'opencode', 'gemini', 'qwen', 'cursor', 'goose', 'vibe', 'cline', 'kimi', 'kilo'];
  const BETA_GROUP = 'Beta';
  const isBeta = (id) => BETA_IDS.includes(id);
  // AGENTS: the agents a new chat can use (enabled ones). ALL: every agent Studio knows, including ones turned off in Settings,
  // so existing chats still show the right name. Both are updated IN PLACE by setRegistry, so other modules can hold them.
  const AGENTS = BUILTINS.map((a) => Object.assign({}, a));
  const ALL = BUILTINS.map((a) => Object.assign({}, a));

  // The Status column says "Needs sign-in": not offered for new chats. "Not checked" (and no status at all) stays offered.
  const needsSignIn = (row) => !!row.signin && row.signin.state === 'signin';

  // Merge the server's agent list ([{id, name, builtin, enabled, ...}]) over the built-ins. Pure.
  // Built-ins are never dropped (a list that omits them still shows them, on); unknown or malformed rows are skipped.
  function mergeRegistry(serverAgents) {
    const all = BUILTINS.map((a) => Object.assign({}, a));
    const beta = [];
    for (const row of Array.isArray(serverAgents) ? serverAgents : []) {
      if (!row || typeof row.id !== 'string') continue;
      const at = all.findIndex((a) => a.id === row.id);
      if (row.beta === true && isBeta(row.id)) {
        if (beta.some((a) => a.id === row.id)) continue;
        const name =
          String(row.name == null ? '' : row.name)
            .trim()
            .slice(0, 40) || row.id;
        beta.push({
          id: row.id,
          name,
          letter: String(row.letter || name.charAt(0) || '?')
            .charAt(0)
            .toUpperCase(),
          builtin: false,
          beta: true,
          group: BETA_GROUP,
          enabled: row.enabled === true && row.found !== false && !needsSignIn(row), // off unless turned on
        });
        continue;
      }
      if (at >= 0) {
        if (all[at].builtin) all[at].enabled = row.enabled !== false && row.found !== false && !needsSignIn(row); // not installed or needs sign-in: listed in Settings, not offered for new chats
        continue;
      }
      if (!ID_RE.test(row.id) || row.id.length > 48) continue;
      const name =
        String(row.name == null ? '' : row.name)
          .trim()
          .slice(0, 40) || row.id;
      all.push({
        id: row.id,
        name,
        letter: String(row.letter || name.charAt(0) || '?')
          .charAt(0)
          .toUpperCase(),
        builtin: false,
        enabled: row.enabled !== false && row.found !== false && !needsSignIn(row),
      });
    }
    all.push(...beta); // after the tested agents and the ones you added
    return { all, enabled: all.filter((a) => a.enabled) };
  }
  // The rows an agent menu lists, with the Beta group label on the Beta agents ({value, name, group}).
  function menuItems(list) {
    return (Array.isArray(list) ? list : []).map((a) => ({
      value: a.id,
      name: a.name,
      group: a.beta ? BETA_GROUP : '',
    }));
  }
  // True when at least one enabled agent in the server's list can start a chat: found, and not "Needs sign-in". "Not checked" is ready.
  // An unreadable or empty list says true, so the first-run start page never shows for a list nobody could read.
  function anyReady(serverAgents) {
    if (!Array.isArray(serverAgents) || !serverAgents.length) return true;
    return serverAgents.some((r) => r && r.enabled !== false && r.found !== false && !needsSignIn(r));
  }
  // Replace the registry contents (in place). If every agent were off, the first built-in stays usable so the New chat form is never empty.
  function setRegistry(serverAgents) {
    const m = mergeRegistry(serverAgents);
    const usable = m.enabled.length ? m.enabled : [m.all[0]];
    ALL.splice(0, ALL.length, ...m.all);
    AGENTS.splice(0, AGENTS.length, ...usable);
    return AGENTS;
  }
  const KEY = 'studio-new-chat-agent';
  const PROJECT_KEY = 'studio-new-chat-agent-by-project';
  const OPTIONS_KEY = 'studio-agent-options-v1';
  const MAX_PROJECTS = 200;
  const MAX_HANDOFF = 4000,
    MAX_MESSAGE = 700,
    MAX_MESSAGES = 6;

  // ONE registry (built-ins + the agents added in Settings, read from the server). The New chat dropdown, the Agent chip, the
  // remembered choice and the cached model / mode lists all read it.
  const isAgent = (id) => AGENTS.some((a) => a.id === id);
  const info = (id) =>
    ALL.find((a) => a.id === id) || {
      id: String(id || ''),
      name: String(id || 'Agent'),
      letter: String(id || '?')
        .charAt(0)
        .toUpperCase(),
    };
  const nameOf = (id) => info(id).name;
  const other = (id) => (AGENTS.find((a) => a.id !== id) || AGENTS[0]).id; // used by the hand-off: the next enabled agent

  // The agent a new chat starts with: the remembered pick when valid, else the first agent (OMP, as in the setup form).
  function resolveAgent(stored) {
    return isAgent(stored) ? stored : AGENTS[0].id;
  }

  // ---- defaults for new chats (Settings is the source of truth) ----------------------------------------------------
  // {agent, byAgent: {id: {model, mode}}, projects: {projectKey: {agent, model, mode}}}, loaded from /api/live/settings.
  // `sink` is called when the user starts a chat in a project, so the agent they used there becomes that project's default.
  let defaults = { agent: '', byAgent: {}, projects: {} };
  let sink = null;
  function setDefaults(d) {
    const o = d && typeof d === 'object' ? d : {};
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    defaults = {
      agent: typeof o.agent === 'string' ? o.agent : '',
      byAgent: obj(o.byAgent),
      projects: obj(o.projects),
    };
  }
  const getDefaults = () => defaults;
  const setSink = (fn) => {
    sink = typeof fn === 'function' ? fn : null;
  };
  // The model and mode a new chat starts with for this agent in this project: the project's own default when it names this agent
  // (or no agent), else the agent's global default. "" = leave the agent's own setting alone.
  function defaultPicks(project, agentId) {
    const key = project ? projectKey(project) : '';
    const mine = key ? defaults.projects[key] : null;
    const pick = mine && (!mine.agent || mine.agent === agentId) ? mine : null;
    const glob = defaults.byAgent[agentId] || {};
    const str = (v) => (typeof v === 'string' ? v : '');
    return { model: str(pick && pick.model) || str(glob.model), mode: str(pick && pick.mode) || str(glob.mode) };
  }
  // One-time carry-over of the old browser-only memory (last agent per project) into Settings. Pure: returns the patch or null.
  function legacyPatch(storage) {
    try {
      const map = readJson(storage, PROJECT_KEY); // the global "last used" stays a browser fallback in loadChoice
      const projects = {}; // the server takes at most 50 project changes per request
      for (const k of Object.keys(map).slice(-50))
        if (typeof map[k] === 'string' && /^(omp|claude|codex|custom-[a-z0-9-]+)$/.test(map[k]))
          projects[k] = { agent: map[k] };
      const patch = { migrated: true };
      if (Object.keys(projects).length) patch.projects = projects;
      return patch;
    } catch (e) {
      return { migrated: true };
    }
  }

  // "C:\\Repos\\App\\", "c:/repos/app" -> one key; POSIX paths keep their case. Empty for no folder.
  function projectKey(cwd) {
    const raw = String(cwd == null ? '' : cwd).trim();
    if (!raw) return '';
    const p = raw
      .replace(/^\\\\\?\\/, '')
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '');
    return /^[a-zA-Z]:/.test(p) || raw.indexOf('\\') >= 0 ? 'w:' + p.toLowerCase() : 'p:' + p;
  }
  function readJson(storage, key) {
    try {
      const v = JSON.parse(storage.getItem(key));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      return {};
    }
  }
  // The default agent for this project (Settings), else the global default, else the agent last chosen in this browser
  // (project first), else the first agent.
  function loadChoice(storage, project) {
    try {
      const key = project ? projectKey(project) : '';
      const set = key ? defaults.projects[key] : null;
      if (set && isAgent(set.agent)) return set.agent;
      if (isAgent(defaults.agent)) return defaults.agent;
      const mine = key ? readJson(storage, PROJECT_KEY)[key] : null;
      if (isAgent(mine)) return mine;
      return resolveAgent(storage && storage.getItem(KEY));
    } catch (e) {
      return AGENTS[0].id;
    }
  }
  // Remembers the pick globally and, when a folder is given, for that project.
  function saveChoice(storage, id, project) {
    try {
      if (!storage || !isAgent(id)) return false;
      storage.setItem(KEY, id);
      const key = project ? projectKey(project) : '';
      if (key && sink) {
        try {
          sink(id, key);
        } catch (e) {
          /* Settings could not be updated; the browser memory below still works */
        }
      }
      if (key) {
        const map = readJson(storage, PROJECT_KEY);
        delete map[key];
        map[key] = id;
        const keys = Object.keys(map);
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PROJECTS))) delete map[k];
        storage.setItem(PROJECT_KEY, JSON.stringify(map));
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- model / mode lists an agent reported, cached per agent for the New chat form ------------------------------
  // The form cannot ask an agent for its lists before a session exists, so it shows the lists the agent reported the last
  // time any session of that agent opened. {model: {configId, choices:[{value,name}]}, mode: {kind:"mode"|"config", configId, choices}}.
  const choicesOf = (option) => {
    const out = [];
    for (const item of Array.isArray(option && option.options) ? option.options : []) {
      for (const o of item && Array.isArray(item.options) ? item.options : [item])
        if (o && typeof o.value === 'string' && o.value)
          out.push({ value: o.value, name: String(o.name || o.value).slice(0, 80) });
    }
    return out;
  };
  const selectOf = (settings, test) =>
    (Array.isArray(settings && settings.configOptions) ? settings.configOptions : []).find(
      (o) =>
        o &&
        typeof o.id === 'string' &&
        test(o) &&
        (o.type === 'select' || (o.type === undefined && Array.isArray(o.options))) &&
        choicesOf(o).length,
    );
  function extractOptions(settings) {
    const out = { model: null, mode: null };
    if (!settings || typeof settings !== 'object') return out;
    const model = selectOf(settings, (o) => o.category === 'model' || o.id === 'model');
    if (model) out.model = { configId: model.id, choices: choicesOf(model) };
    const modes =
      settings.modes && Array.isArray(settings.modes.availableModes)
        ? settings.modes.availableModes.filter((m) => m && typeof m.id === 'string')
        : [];
    if (modes.length)
      out.mode = {
        kind: 'mode',
        choices: modes.map((m) => ({ value: m.id, name: String(m.name || m.id).slice(0, 80) })),
      };
    else {
      const mode = selectOf(settings, (o) => o.category === 'mode' || o.id === 'mode');
      if (mode) out.mode = { kind: 'config', configId: mode.id, choices: choicesOf(mode) };
    }
    return out;
  }
  function loadOptions(storage, agentId) {
    try {
      const entry = readJson(storage, OPTIONS_KEY)[agentId];
      const ok = (x) => (x && Array.isArray(x.choices) && x.choices.length ? x : null);
      return entry && typeof entry === 'object'
        ? { model: ok(entry.model), mode: ok(entry.mode) }
        : { model: null, mode: null };
    } catch (e) {
      return { model: null, mode: null };
    }
  }
  // Called whenever a session of this agent reports its settings. Writes only when something changed. true = written.
  function saveOptions(storage, agentId, settings) {
    try {
      if (!storage || !isAgent(agentId)) return false;
      const found = extractOptions(settings);
      if (!found.model && !found.mode) return false;
      const all = readJson(storage, OPTIONS_KEY),
        before = JSON.stringify(all[agentId] || null);
      const merged = Object.assign({}, all[agentId] || {});
      if (found.model) merged.model = found.model;
      if (found.mode) merged.mode = found.mode;
      if (JSON.stringify(merged) === before) return false;
      all[agentId] = merged;
      storage.setItem(OPTIONS_KEY, JSON.stringify(all));
      return true;
    } catch (e) {
      return false;
    }
  }
  // What the dropdown lists: "Default" (leave the agent's own setting alone) first, then the cached choices.
  function pickList(option) {
    return [{ value: '', name: 'Default' }].concat(option && Array.isArray(option.choices) ? option.choices : []);
  }
  // The calls to make right after the session starts and before the first prompt: [{op:"mode", modeId} | {op:"config", configId, value}].
  // A pick that is empty or no longer in the cached list is skipped.
  function applyPlan(options, picks) {
    const o = options || {},
      p = picks || {},
      plan = [];
    const has = (opt, v) => !!(opt && v && opt.choices.some((c) => c.value === v));
    if (has(o.model, p.model)) plan.push({ op: 'config', configId: o.model.configId, value: p.model });
    if (has(o.mode, p.mode))
      plan.push(
        o.mode.kind === 'mode'
          ? { op: 'mode', modeId: p.mode }
          : { op: 'config', configId: o.mode.configId, value: p.mode },
      );
    return plan;
  }

  // The folder a new chat starts in: an explicit one (a hand-off keeps the old chat's folder), a folder typed under
  // "More options" (preferInput), the active project's path, else what is in the folder input, else nothing.
  // source tells the UI whether the user still has to type one.
  function resolveFolder(opts) {
    const o = opts || {},
      explicit = typeof o.explicit === 'string' ? o.explicit.trim() : '';
    if (explicit) return { cwd: explicit, source: 'explicit' };
    const typed0 = typeof o.inputValue === 'string' ? o.inputValue.trim() : '';
    if (o.preferInput && typed0) return { cwd: typed0, source: 'input' };
    const project = o.activeProject && typeof o.activeProject.path === 'string' ? o.activeProject.path.trim() : '';
    if (project) return { cwd: project, source: 'project' };
    const typed = typeof o.inputValue === 'string' ? o.inputValue.trim() : '';
    if (typed) return { cwd: typed, source: 'input' };
    return { cwd: '', source: 'none' };
  }

  function squash(s) {
    return String(s == null ? '' : s)
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function clip(s, n) {
    return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
  }

  // Hand-off text: the title plus the last few user / assistant messages, trimmed, capped at MAX_HANDOFF characters.
  // opts: {title, rows:[{role,value}], from, limit}
  function handoffText(opts) {
    const o = opts || {},
      limit = Math.max(200, o.limit || MAX_HANDOFF);
    const rows = (Array.isArray(o.rows) ? o.rows : []).filter(
      (r) => r && (r.role === 'user' || r.role === 'assistant') && squash(r.value),
    );
    const picked = rows
      .slice(-MAX_MESSAGES)
      .map((r) => ({ who: r.role === 'user' ? 'You' : nameOf(o.from), text: clip(squash(r.value), MAX_MESSAGE) }));
    const title = squash(o.title).replace(/\n/g, ' ');
    const head =
      'Continuing from a ' + nameOf(o.from) + ' conversation' + (title ? ': ' + clip(title, 160) : '') + '.\n';
    const tail = '\n\n---\nPlease pick up from here. ';
    if (!picked.length) return head + tail.trimStart();
    const render = (list) => head + 'Recent messages:\n\n' + list.map((m) => m.who + ': ' + m.text).join('\n\n') + tail;
    let list = picked;
    while (list.length > 1 && render(list).length > limit) list = list.slice(1);
    let out = render(list);
    if (out.length > limit) {
      const over = out.length - limit;
      list = [{ who: list[0].who, text: clip(list[0].text, Math.max(20, list[0].text.length - over)) }];
      out = render(list);
    }
    return out.length > limit ? out.slice(0, limit - 1) + '…' : out;
  }

  const api = {
    AGENTS,
    ALL,
    BUILTINS,
    mergeRegistry,
    menuItems,
    BETA_IDS,
    BETA_GROUP,
    isBeta,
    anyReady,
    setRegistry,
    setDefaults,
    getDefaults,
    setSink,
    defaultPicks,
    legacyPatch,
    STORAGE_KEY: KEY,
    MAX_HANDOFF,
    info,
    nameOf,
    other,
    isAgent,
    resolveAgent,
    projectKey,
    loadChoice,
    saveChoice,
    extractOptions,
    loadOptions,
    saveOptions,
    pickList,
    applyPlan,
    resolveFolder,
    handoffText,
  };
  // The "Default" row of a model / mode / effort menu: it leaves the agent's own setting alone and names that setting when the
  // agent reported it. A name that already says Default ("Default (recommended)", Claude Code's) is shown as it is, never
  // wrapped again into "Default (Default (recommended))".
  function defaultLabel(list) {
    const hit = list && list.current && Array.isArray(list.choices) && list.choices.find((c) => c.value === list.current);
    const name = hit ? String(hit.name || hit.value || '').trim() : '';
    if (!name) return 'Default';
    return /^default(?![a-z0-9])/i.test(name) ? name : 'Default (' + name + ')';
  }
  api.defaultLabel = defaultLabel;
  root.AgentChoice = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
