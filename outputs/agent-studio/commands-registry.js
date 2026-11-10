(function (root) {
  'use strict';
  // Command bar brain: fuzzy matching, the action registry, filter modes, the danger-confirm step and the shortcut sheet
  // model. Pure (no DOM, no page globals), so it is node-testable; switcher-ui.js draws it and supplies the context.
  //
  // An action: {id, title, keywords, shortcut, group, when(ctx), run(ctx), danger?, confirm?, common?, scope?}
  // The context (ctx) is built by the page for the moment the bar opens:
  //   chat      the open conversation, or null
  //   menu      Set of item ids organize-ui offers for that chat (its menuModel), so chat actions follow the same rules
  //   thinking  true / false when the chat view can show or hide thinking, else null
  //   projects  [{key, name, path, active}] already filtered by the project dropdown rules
  //   keys      {inbox: "Alt+I"} shortcuts that other modules may or may not have
  //   editor    {name, explorer, terminal}: the default editor's name and whether Explorer / a terminal were found, or null
  //   do        the functions that exist on this page; an action whose function is missing is simply not offered
  //               chat(id), newChat(project), openProjectEditor(), showProjectExplorer(), openProjectTerminal(), newProject(), switchProject(), openInbox(), toggleSide(), toggleActivity(), showSheet(), openSettings()

  // ---- fuzzy matching -----------------------------------------------------------------------
  // Score of one search term against one text, or -1. Substrings beat scattered letters; word starts beat the middle.
  function score(term, text) {
    term = String(term || '').toLowerCase();
    text = String(text || '').toLowerCase();
    if (!term) return 0;
    if (!text) return -1;
    const at = text.indexOf(term);
    if (at >= 0) {
      const wordStart = at === 0 || /[\s\-_\/\\.:()]/.test(text[at - 1]);
      return 1000 - Math.min(at, 200) * 2 - Math.min(text.length - term.length, 300) * 0.2 + (wordStart ? 150 : 0);
    }
    let pos = 0,
      run = 0,
      total = 0,
      last = -2;
    for (const ch of term) {
      const found = text.indexOf(ch, pos);
      if (found < 0) return -1;
      run = found === last + 1 ? run + 1 : 0;
      total +=
        10 + run * 8 - Math.min(found - pos, 20) * 0.5 + (found === 0 || /[\s\-_\/\\.]/.test(text[found - 1]) ? 12 : 0);
      last = found;
      pos = found + 1;
    }
    return Math.max(1, total);
  }
  // fields: [{text, weight, exact}]. Every whitespace-separated term must match some field. An `exact` field (a folder
  // path) only counts a substring: paths share long prefixes, so scattered letters in them would match almost any word.
  // rankInfo also says whether every term matched as a substring somewhere (`strong`); strong results always rank above
  // ones that only matched scattered letters.
  function rankInfo(query, fields) {
    const terms = String(query || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) return { s: 0, strong: true };
    let sum = 0,
      strong = true;
    for (const term of terms) {
      let best = -1,
        sub = false;
      for (const f of fields) {
        const text = String(f.text || '').toLowerCase(),
          isSub = !!text && text.indexOf(term) >= 0;
        if (f.exact && !isSub) continue;
        const s = score(term, text);
        if (s < 0) continue;
        if (isSub) sub = true;
        best = Math.max(best, s * (f.weight || 1));
      }
      if (best < 0) return { s: -1, strong: false };
      if (!sub) strong = false;
      sum += best;
    }
    return { s: sum, strong };
  }
  const rank = (query, fields) => rankInfo(query, fields).s;
  // Archived chats rank a little below an equal live match, never below scattered-letter matches.
  const ARCHIVED_PENALTY = 150;
  const byMatch = (a, b) => Number(b.strong) - Number(a.strong) || b.s - a.s;
  const chatFields = (item) => [
    { text: item.title, weight: 1 },
    { text: item.original, weight: 0.8 },
    { text: item.project, weight: 0.7 },
    { text: item.provider, weight: 0.4 },
    { text: item.path, weight: 0.25, exact: true },
  ];
  const projectFields = (p) => [
    { text: p.name, weight: 1 },
    { text: p.path, weight: 0.3, exact: true },
  ];
  const actionFields = (a) =>
    [{ text: a.title, weight: 1 }].concat((a.keywords || []).map((k) => ({ text: k, weight: 0.7 })));

  // Chats only (the original switcher search): best first. Empty query: recent first, archived last.
  function search(items, query) {
    const q = String(query || '').trim();
    const byRecent = (a, b) =>
      Number(a.archived) - Number(b.archived) || b.activity - a.activity || a.title.localeCompare(b.title);
    if (!q) return items.slice().sort(byRecent);
    const scored = [];
    for (const item of items) {
      const m = rankInfo(q, chatFields(item));
      if (m.s >= 0) scored.push({ item, strong: m.strong, s: m.s - (item.archived ? ARCHIVED_PENALTY : 0) });
    }
    scored.sort(
      (a, b) =>
        byMatch(a, b) ||
        Number(a.item.archived) - Number(b.item.archived) ||
        b.item.activity - a.item.activity ||
        a.item.title.localeCompare(b.item.title),
    );
    return scored.map((x) => x.item);
  }

  // ---- filter modes -------------------------------------------------------------------------
  const MODES = ['all', 'actions', 'chats', 'projects'];
  const MODE_LABEL = { all: 'All', actions: 'Actions', chats: 'Chats', projects: 'Projects' };
  const nextMode = (mode, step) =>
    MODES[(Math.max(0, MODES.indexOf(mode)) + (step < 0 ? -1 : 1) + MODES.length) % MODES.length];
  // A leading ">" means actions only, whatever tab is chosen. Returns the effective mode and the text to match.
  function parseQuery(raw, mode) {
    const text = String(raw == null ? '' : raw);
    const m = /^\s*>\s?/.exec(text);
    if (m) return { mode: 'actions', query: text.slice(m[0].length).trim(), prefixed: true };
    return { mode: MODES.includes(mode) ? mode : 'all', query: text.trim(), prefixed: false };
  }

  // ---- results ------------------------------------------------------------------------------
  const KIND_ORDER = { action: 0, project: 1, chat: 2 };
  const RECENT_CHATS = 8;
  // Mix the three sources into one ranked list. chats: switcher items ({title, original, project, path, provider, archived,
  // activity, ...}); projects: [{key, name, path, ...}] in dropdown order; actions: resolved actions from buildActions().
  function compose(sources, rawQuery, mode, limit) {
    const p = parseQuery(rawQuery, mode),
      q = p.query,
      max = limit || 40;
    const chats = sources.chats || [],
      projects = sources.projects || [],
      actions = sources.actions || [];
    const tag = (kind, o) => Object.assign({ kind }, o);
    let out = [];
    if (!q) {
      const recent = search(chats, '');
      if (p.mode === 'chats') out = recent.map((c) => tag('chat', c));
      else if (p.mode === 'projects') out = projects.map((x) => tag('project', x));
      else if (p.mode === 'actions')
        out = actions
          .slice()
          .sort((a, b) => Number(!!b.common) - Number(!!a.common))
          .map((a) => tag('action', a));
      else
        out = recent
          .slice(0, RECENT_CHATS)
          .map((c) => tag('chat', c))
          .concat(actions.filter((a) => a.common).map((a) => tag('action', a)));
      return out.slice(0, max);
    }
    const scored = [];
    const want = (k) => p.mode === 'all' || p.mode === k + 's';
    if (want('chat'))
      for (const c of chats) {
        const m = rankInfo(q, chatFields(c));
        if (m.s >= 0)
          scored.push({ r: tag('chat', c), strong: m.strong, s: m.s - (c.archived ? ARCHIVED_PENALTY : 0) });
      }
    if (want('project'))
      for (const x of projects) {
        const m = rankInfo(q, projectFields(x));
        if (m.s >= 0) scored.push({ r: tag('project', x), strong: m.strong, s: m.s });
      }
    if (want('action'))
      for (const a of actions) {
        const m = rankInfo(q, actionFields(a));
        if (m.s >= 0) scored.push({ r: tag('action', a), strong: m.strong, s: m.s });
      }
    scored.sort(
      (a, b) =>
        byMatch(a, b) ||
        Number(!!a.r.archived) - Number(!!b.r.archived) ||
        KIND_ORDER[a.r.kind] - KIND_ORDER[b.r.kind] ||
        (b.r.activity || 0) - (a.r.activity || 0) ||
        String(a.r.title || a.r.name || '').localeCompare(String(b.r.title || b.r.name || '')),
    );
    return scored.slice(0, max).map((x) => x.r);
  }

  // ---- the action registry ------------------------------------------------------------------
  const can = (ctx, fn) => !!(ctx && ctx.do && typeof ctx.do[fn] === 'function');
  const offers = (ctx, id) => !!(ctx && ctx.chat && ctx.menu && ctx.menu.has(id) && can(ctx, 'chat'));
  const resolve = (v, ctx) => (typeof v === 'function' ? v(ctx) : v);
  // An action on the open chat. id is the organize-ui menu item id, so availability follows the same rules as the right-click menu.
  function chatAction(id, title, extra) {
    return Object.assign(
      {
        id: 'chat:' + id,
        group: 'This chat',
        scope: 'chat',
        title,
        keywords: [],
        shortcut: '',
        when: (ctx) => offers(ctx, id),
        run: (ctx) => ctx.do.chat(id),
      },
      extra || {},
    );
  }
  const ACTIONS = [
    chatAction('rename', 'Rename this chat', { keywords: ['title', 'name'], shortcut: 'F2', common: true }),
    chatAction('pin', 'Pin this chat', { keywords: ['favorite', 'top'], common: true }),
    chatAction('unpin', 'Unpin this chat', { keywords: ['favorite', 'top'], common: true }),
    chatAction('hold', 'Hold this chat…', { keywords: ['wait', 'later', 'snooze', 'park'], common: true }),
    chatAction('holdnote', 'Edit hold note…', { keywords: ['hold', 'wait'] }),
    chatAction('resume', 'Resume this chat', { keywords: ['hold', 'unhold'] }),
    chatAction('handled', 'Mark handled', { keywords: ['done', 'your turn', 'dismiss', 'read'], common: true }),
    chatAction('thinking', (ctx) => (ctx.thinking ? 'Hide thinking' : 'Show thinking'), {
      keywords: ['reasoning', 'thoughts'],
    }),
    chatAction('handoff', 'Continue with another agent…', { keywords: ['handoff', 'switch agent', 'claude', 'omp'] }),
    chatAction('end', "End this chat's session", {
      keywords: ['stop', 'disconnect', 'close', 'end session', 'studio session'],
      danger: true,
      confirm: "end this chat's session",
    }),
    chatAction('archive', 'Archive this chat', { keywords: ['hide', 'put away'] }),
    chatAction('unarchive', 'Unarchive this chat', { keywords: ['restore'] }),
    chatAction('delete', 'Delete this chat', { keywords: ['remove', 'trash'], danger: true, confirm: 'delete' }),
    {
      id: 'new-project',
      group: 'Moving around',
      title: 'New project…',
      keywords: ['folder', 'add project', 'create'],
      shortcut: '',
      common: true,
      when: (ctx) => can(ctx, 'newProject'),
      run: (ctx) => ctx.do.newProject(),
    },
    {
      id: 'switch-project',
      group: 'Moving around',
      title: 'Switch project…',
      keywords: ['project', 'folder', 'dropdown'],
      shortcut: 'Ctrl+P',
      common: true,
      when: (ctx) => can(ctx, 'switchProject'),
      run: (ctx) => ctx.do.switchProject(),
    },
    {
      id: 'open-inbox',
      group: 'Moving around',
      title: 'Open inbox',
      keywords: ['needs you', 'waiting', 'attention', 'replies'],
      shortcut: (ctx) => (ctx.keys && ctx.keys.inbox) || '',
      common: true,
      when: (ctx) => can(ctx, 'openInbox'),
      run: (ctx) => ctx.do.openInbox(),
    },
    {
      id: 'project-editor',
      group: 'Project',
      title: (ctx) => 'Open project in ' + ((ctx.editor && ctx.editor.name) || 'editor'),
      keywords: ['editor', 'vs code', 'code', 'cursor', 'windsurf', 'devin', 'ide', 'folder'],
      when: (ctx) => can(ctx, 'openProjectEditor') && !!(ctx.editor && ctx.editor.name),
      run: (ctx) => ctx.do.openProjectEditor(),
    },
    {
      id: 'project-explorer',
      group: 'Project',
      title: 'Show project in Explorer',
      keywords: ['folder', 'files', 'file explorer', 'reveal'],
      when: (ctx) => can(ctx, 'showProjectExplorer') && !!(ctx.editor && ctx.editor.explorer),
      run: (ctx) => ctx.do.showProjectExplorer(),
    },
    {
      id: 'project-terminal',
      group: 'Project',
      title: 'Open terminal in project',
      keywords: ['shell', 'powershell', 'command line', 'console', 'folder'],
      when: (ctx) => can(ctx, 'openProjectTerminal') && !!(ctx.editor && ctx.editor.terminal),
      run: (ctx) => ctx.do.openProjectTerminal(),
    },
    {
      id: 'toggle-side',
      group: 'Panels',
      title: 'Toggle chat list',
      keywords: ['sidebar', 'side panel', 'hide', 'show', 'panel'],
      shortcut: 'Ctrl+B',
      when: (ctx) => can(ctx, 'toggleSide'),
      run: (ctx) => ctx.do.toggleSide(),
    },
    {
      id: 'toggle-activity',
      group: 'Panels',
      title: 'Toggle Activity',
      keywords: ['activity panel', 'agents', 'tools', 'panel'],
      shortcut: 'Ctrl+Alt+B',
      when: (ctx) => can(ctx, 'toggleActivity'),
      run: (ctx) => ctx.do.toggleActivity(),
    },
    // Text size (textsize-ui.js). Chat text keys only act while focus or the pointer is in the chat; the interface keys work anywhere.
    {
      id: 'chat-text-bigger',
      group: 'Text size',
      title: 'Bigger chat text',
      keywords: ['zoom in', 'font size', 'larger', 'increase', 'text size'],
      shortcut: 'Ctrl+=',
      when: (ctx) => can(ctx, 'chatBigger'),
      run: (ctx) => ctx.do.chatBigger(),
    },
    {
      id: 'chat-text-smaller',
      group: 'Text size',
      title: 'Smaller chat text',
      keywords: ['zoom out', 'font size', 'decrease', 'text size'],
      shortcut: 'Ctrl+-',
      when: (ctx) => can(ctx, 'chatSmaller'),
      run: (ctx) => ctx.do.chatSmaller(),
    },
    {
      id: 'chat-text-reset',
      group: 'Text size',
      title: 'Reset chat text',
      keywords: ['default', '100%', 'font size', 'text size'],
      shortcut: 'Ctrl+0',
      when: (ctx) => can(ctx, 'chatReset'),
      run: (ctx) => ctx.do.chatReset(),
    },
    {
      id: 'ui-bigger',
      group: 'Text size',
      title: 'Bigger interface',
      keywords: ['zoom in', 'larger', 'panels', 'increase', 'interface size'],
      shortcut: 'Ctrl+Shift+=',
      when: (ctx) => can(ctx, 'uiBigger'),
      run: (ctx) => ctx.do.uiBigger(),
    },
    {
      id: 'ui-smaller',
      group: 'Text size',
      title: 'Smaller interface',
      keywords: ['zoom out', 'panels', 'decrease', 'interface size'],
      shortcut: 'Ctrl+Shift+-',
      when: (ctx) => can(ctx, 'uiSmaller'),
      run: (ctx) => ctx.do.uiSmaller(),
    },
    {
      id: 'ui-reset',
      group: 'Text size',
      title: 'Reset interface size',
      keywords: ['default', '100%', 'interface size'],
      shortcut: 'Ctrl+Shift+0',
      when: (ctx) => can(ctx, 'uiReset'),
      run: (ctx) => ctx.do.uiReset(),
    },
    {
      id: 'settings',
      group: 'Panels',
      title: 'Settings',
      keywords: ['preferences', 'options', 'configure', 'agents', 'defaults', 'notifications', 'server'],
      shortcut: 'Ctrl+,',
      common: true,
      when: (ctx) => can(ctx, 'openSettings'),
      run: (ctx) => ctx.do.openSettings(),
    },
    {
      id: 'shortcuts',
      group: 'Panels',
      title: 'Keyboard shortcuts',
      keywords: ['help', 'keys', 'cheat sheet', 'hotkeys'],
      shortcut: '?',
      common: true,
      when: (ctx) => can(ctx, 'showSheet'),
      run: (ctx) => ctx.do.showSheet(),
    },
  ];
  // "New chat in <project>" exists once per project the dropdown lists.
  function projectActions(ctx) {
    if (!can(ctx, 'newChat')) return [];
    return (ctx.projects || []).map((p) => ({
      id: 'new-in:' + p.key,
      group: 'Moving around',
      dynamic: true,
      title: 'New chat in ' + p.name,
      keywords: ['new chat', 'start', 'conversation', 'create'],
      shortcut: p.active ? 'Ctrl+Shift+N' : '',
      common: !!p.active,
      when: () => true,
      run: (c) => c.do.newChat(p),
    }));
  }
  // The actions available right now, titles and shortcuts resolved to text.
  function buildActions(ctx) {
    const out = [];
    for (const a of ACTIONS.concat(projectActions(ctx))) {
      let ok = false;
      try {
        ok = !!a.when(ctx);
      } catch (e) {
        ok = false;
      } // a broken module hides its action rather than breaking the bar
      if (!ok) continue;
      out.push({
        id: a.id,
        group: a.group,
        title: String(resolve(a.title, ctx)),
        keywords: a.keywords || [],
        shortcut: String(resolve(a.shortcut, ctx) || ''),
        danger: !!a.danger,
        confirm: a.confirm || '',
        common: !!a.common,
        dynamic: !!a.dynamic,
        scope: a.scope || '',
        run: () => a.run(ctx),
      });
    }
    return out;
  }

  // ---- danger actions need a second Enter ---------------------------------------------------
  // armed: the id waiting for its second Enter, or null. Returns {run, armed, prompt}.
  function confirmStep(armed, action) {
    if (!action || !action.danger) return { run: true, armed: null, prompt: '' };
    if (armed === action.id) return { run: true, armed: null, prompt: '' };
    return {
      run: false,
      armed: action.id,
      prompt: 'Press Enter again to ' + (action.confirm || action.title.toLowerCase()),
    };
  }

  // ---- shortcut sheet -----------------------------------------------------------------------
  // Keys that no registry action owns. Shown whenever they exist in the page's own modules.
  const STATIC_SHORTCUTS = [
    { group: 'Moving around', keys: 'Ctrl+K', label: 'Find chats, projects and actions' },
    { group: 'Moving around', keys: 'Ctrl+Shift+N', label: 'New chat in the current project' },
    { group: 'Moving around', keys: 'Ctrl+Tab / Ctrl+Shift+Tab', label: 'Next / previous tab' },
    {
      group: 'Moving around',
      keys: 'Alt+PgDn / Alt+PgUp',
      label: 'Next / previous tab (when the browser keeps Ctrl+Tab)',
    },
    { group: 'Moving around', keys: 'Alt+↓ / Alt+↑', label: 'Next / previous chat in the list' },
    { group: 'Moving around', keys: 'Ctrl+W / Alt+W', label: 'Close the current tab' },
    { group: 'Moving around', keys: 'Ctrl+1…9 / Alt+1…9', label: 'Jump to tab 1…9' },
    { group: 'This chat', keys: 'Shift+F10 / Menu key', label: 'Open the chat menu on a chat card or tab' },
    { group: 'This chat', keys: 'Enter / Shift+Enter', label: 'Send / new line in the message box' },
    { group: 'Panels', keys: 'Esc', label: 'Close the open panel, menu or dialog' },
    { group: 'Text size', keys: 'Ctrl+Wheel', label: 'Bigger / smaller chat text (pointer over the chat)' },
  ];
  const GROUPS = ['Moving around', 'This chat', 'Panels', 'Text size'];
  // Rows grouped for display. Registry actions that carry a shortcut come first in their group, then the static list.
  // Chat-scoped actions are listed even with no chat open (the sheet documents keys, not the current state).
  function sheetModel(ctx, statics) {
    const seen = new Set(),
      groups = GROUPS.map((name) => ({ name, rows: [] }));
    const add = (group, keys, label) => {
      const g = groups.find((x) => x.name === group),
        id = group + '|' + keys;
      if (!g || !keys || seen.has(id)) return;
      seen.add(id);
      g.rows.push({ keys, label });
    };
    for (const a of ACTIONS) {
      const keys = String(resolve(a.shortcut, ctx) || '');
      if (!keys) continue;
      let ok = false;
      try {
        ok = a.scope === 'chat' || !!a.when(ctx);
      } catch (e) {
        ok = false;
      }
      if (ok) add(a.group, keys, String(resolve(a.title, ctx)));
    }
    for (const s of statics || STATIC_SHORTCUTS) add(s.group, s.keys, s.label);
    return groups.filter((g) => g.rows.length);
  }

  const api = {
    score,
    rank,
    rankInfo,
    search,
    MODES,
    MODE_LABEL,
    nextMode,
    parseQuery,
    compose,
    ACTIONS,
    buildActions,
    confirmStep,
    sheetModel,
    STATIC_SHORTCUTS,
    RECENT_CHATS,
  };
  root.AgentCommands = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
