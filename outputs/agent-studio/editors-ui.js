(function (root) {
  'use strict';
  // "Open in editor": which editors the PC has, the default one, and the menu items that open a project folder, a workspace
  // file or one file at a line. Studio only ever sends the server a path and which program to use; the server checks that the
  // path is inside a known project and starts the program itself. Names and paths here are set with textContent by the callers.
  let host = null,
    info = { editors: [], default: '', loaded: false },
    loading = null;
  const wsCache = new Map(),
    wsLoading = new Map();

  const editorsOnly = () => info.editors.filter((e) => e.kind === 'editor');
  const byId = (id) => info.editors.find((e) => e.id === id) || null;
  // The default editor comes from the server (Settings > Editors, else the first of VS Code, Cursor, Windsurf, Devin found).
  function defaultEditor() {
    return byId(info.default) || editorsOnly()[0] || null;
  }
  // Change the default: shown at once, saved in Studio's settings file for every browser.
  function setDefault(id) {
    const e = byId(id);
    if (!e || e.kind !== 'editor') return Promise.resolve(false);
    info.default = id;
    refreshButtons();
    if (!host || !host.post) return Promise.resolve(true);
    return host.post('settings', { editors: { default: id } }).then(
      () => true,
      (err) => {
        fail(err);
        return false;
      },
    );
  }
  // The editor used for a file: the default when it can open files, else the first editor that can.
  function fileEditor() {
    const d = defaultEditor();
    if (d && d.capabilities.file) return d;
    return editorsOnly().find((e) => e.capabilities.file) || null;
  }
  const workspaceEditor = () => {
    const d = defaultEditor();
    return d && d.capabilities.workspace ? d : editorsOnly().find((e) => e.capabilities.workspace) || null;
  };
  const canOpenFile = () => !!fileEditor();

  // ---- pure menu models -----------------------------------------------------------------------
  // model: {editors: [{id, name, kind, capabilities}], defaultId, workspaces: [{path, name, others}], useWorkspace}
  // Returns [{id, label, ...}] and {sep: true}; ids are open:<editor>, workspace:<n>, folder, usews, explorer, terminal.
  function projectItems(model) {
    const m = model || {},
      all = Array.isArray(m.editors) ? m.editors : [],
      out = [];
    const eds = all.filter((e) => e.kind === 'editor');
    const ordered = eds.slice().sort((a, b) => Number(b.id === m.defaultId) - Number(a.id === m.defaultId));
    const ws = Array.isArray(m.workspaces) ? m.workspaces.slice(0, 3) : [];
    const wsEd =
      eds.find((e) => e.id === m.defaultId && e.capabilities.workspace) ||
      eds.find((e) => e.capabilities.workspace) ||
      null;
    const useWs = !!(m.useWorkspace && ws.length === 1 && wsEd);
    ordered.forEach((e, i) =>
      out.push({
        id: 'open:' + e.id,
        label: 'Open in ' + e.name + (i === 0 && useWs ? ' (workspace)' : ''),
        editor: e.id,
        workspace: i === 0 && useWs,
      }),
    );
    if (ws.length && wsEd) {
      const group = [];
      ws.forEach((w, i) =>
        group.push({ id: 'workspace:' + i, label: 'Open workspace ' + w.name, editor: wsEd.id, path: w.path }),
      );
      group.push({ id: 'folder', label: 'Open this folder only', editor: (ordered[0] || {}).id });
      group.push({ id: 'usews', label: 'Always use workspace for this project', checked: !!m.useWorkspace });
      if (out.length) out.push({ sep: true });
      out.push(...group);
    }
    const tail = [];
    if (all.some((e) => e.kind === 'explorer')) tail.push({ id: 'explorer', label: 'Show in Explorer' });
    if (all.some((e) => e.kind === 'terminal')) tail.push({ id: 'terminal', label: 'Open terminal here' });
    if (tail.length) {
      if (out.length) out.push({ sep: true });
      out.push(...tail);
    }
    return out;
  }
  const editorLabel = () => {
    const d = defaultEditor();
    return d ? d.name : '';
  };
  const fileTip = (line) => {
    const e = fileEditor();
    return 'Open in ' + (e ? e.name : 'editor') + (line ? ' at line ' + line : '');
  };

  // ---- server calls ---------------------------------------------------------------------------
  const fail = (err) => {
    if (host && host.fail) host.fail(err && err.message ? err : new Error(String(err)));
  };
  function refresh() {
    if (!host || !host.get) return Promise.resolve(info);
    if (loading) return loading;
    loading = host
      .get('/api/live/editors')
      .then((r) => {
        info = {
          editors: Array.isArray(r && r.editors) ? r.editors : [],
          default: (r && r.default) || '',
          loaded: true,
        };
        refreshButtons();
        return info;
      })
      .catch(() => info)
      .then((v) => {
        loading = null;
        return v;
      });
    return loading;
  }
  // Workspace files that list the project: cached per path (null until the first answer).
  const workspacesCached = (path) => (wsCache.has(path) ? wsCache.get(path) : null);
  function loadWorkspaces(path) {
    if (!host || !host.get || !path) return Promise.resolve([]);
    if (wsLoading.has(path)) return wsLoading.get(path);
    const p = host
      .get('/api/live/editors', { project: path })
      .then((r) => {
        const list = Array.isArray(r && r.workspaces) ? r.workspaces : [];
        wsCache.set(path, list);
        return list;
      })
      .catch(() => {
        wsCache.set(path, []);
        return [];
      })
      .then((v) => {
        wsLoading.delete(path);
        return v;
      });
    wsLoading.set(path, p);
    return p;
  }
  function open(spec) {
    if (!host || !host.post) return Promise.resolve(null);
    const body = { editor: spec.editor, kind: spec.kind || 'folder', path: spec.path };
    if (spec.line) body.line = spec.line;
    if (spec.cwd) body.cwd = spec.cwd;
    return host.post('open', body).catch((err) => {
      fail(err);
      return null;
    });
  }
  const openFolder = (path, editorId) => {
    const e = editorId ? byId(editorId) : defaultEditor();
    return e && path ? open({ editor: e.id, kind: 'folder', path }) : Promise.resolve(null);
  };
  function openFile(path, line, cwd) {
    const e = fileEditor();
    if (!e || !path) return Promise.resolve(null);
    return open({
      editor: e.id,
      kind: 'file',
      path,
      line: Number.isInteger(line) && line > 0 ? line : 0,
      cwd: cwd || (host && host.cwd ? host.cwd() : ''),
    });
  }
  const explorerEntry = () => info.editors.find((e) => e.kind === 'explorer') || null;
  const terminalEntry = () => info.editors.find((e) => e.kind === 'terminal') || null;
  const showInExplorer = (path) => {
    const e = explorerEntry();
    return e && path ? open({ editor: e.id, kind: 'folder', path }) : Promise.resolve(null);
  };
  const openTerminal = (path) => {
    const e = terminalEntry();
    return e && path ? open({ editor: e.id, kind: 'folder', path }) : Promise.resolve(null);
  };

  // Open a project folder the way the saved preference says: its workspace file when "always use workspace" is on and exactly
  // one workspace lists it, else the folder.
  function openProject(path, opts) {
    const o = opts || {},
      d = defaultEditor();
    if (!d || !path) return Promise.resolve(null);
    if (!o.useWorkspace) return openFolder(path, d.id);
    const ready = workspacesCached(path) === null ? loadWorkspaces(path) : Promise.resolve(workspacesCached(path));
    return ready.then((ws) =>
      ws.length === 1 && workspaceEditor()
        ? open({ editor: workspaceEditor().id, kind: 'workspace', path: ws[0].path, cwd: path })
        : openFolder(path, d.id),
    );
  }
  // Run one item from projectItems() for a project. setPref(patch) saves {useWorkspace} for the project.
  function runProjectItem(item, path, ctx) {
    const c = ctx || {};
    if (!item || !path) return Promise.resolve(null);
    if (item.id === 'folder') return openFolder(path, item.editor);
    if (item.id === 'usews') return Promise.resolve(c.setPref ? c.setPref({ useWorkspace: !item.checked }) : null);
    if (item.id === 'explorer') return showInExplorer(path);
    if (item.id === 'terminal') return openTerminal(path);
    if (item.id.startsWith('workspace:'))
      return open({ editor: item.editor, kind: 'workspace', path: item.path, cwd: path });
    if (item.id.startsWith('open:'))
      return item.workspace && (workspacesCached(path) || []).length === 1
        ? open({ editor: item.editor, kind: 'workspace', path: workspacesCached(path)[0].path, cwd: path })
        : openFolder(path, item.editor);
    return Promise.resolve(null);
  }
  function menuModelFor(path, useWorkspace) {
    return {
      editors: info.editors,
      defaultId: (defaultEditor() || {}).id || '',
      workspaces: workspacesCached(path) || [],
      useWorkspace: !!useWorkspace,
    };
  }

  // The small "open" buttons on tool rows exist before the editor list arrives; show and re-label them once it does.
  function refreshButtons() {
    const d = root.document;
    if (!d || !d.querySelectorAll) return;
    const ok = canOpenFile();
    for (const b of d.querySelectorAll('.tool-open')) {
      b.hidden = !ok;
      const tip = fileTip(Number(b.dataset && b.dataset.line) || 0);
      b.title = tip;
      b.setAttribute('aria-label', tip);
    }
  }

  function init(h) {
    host = h || null;
    return refresh();
  }
  const api = {
    init,
    refresh,
    list: () => info.editors.slice(),
    editors: editorsOnly,
    get default() {
      const d = defaultEditor();
      return d ? d.id : '';
    },
    defaultEditor,
    setDefault,
    loaded: () => info.loaded,
    fileEditor,
    canOpenFile,
    editorLabel,
    fileTip,
    projectItems,
    menuModelFor,
    runProjectItem,
    workspacesCached,
    loadWorkspaces,
    open,
    openFolder,
    openFile,
    openProject,
    showInExplorer,
    openTerminal,
    hasExplorer: () => !!explorerEntry(),
    hasTerminal: () => !!terminalEntry(),
    refreshButtons,
    _reset: () => {
      info = { editors: [], default: '', loaded: false };
      loading = null;
      wsCache.clear();
      wsLoading.clear();
      host = null;
    },
  };
  root.AgentEditors = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
