(function (root) {
  'use strict';
  // Pin / archive / delete for the conversation sidebar. State lives on the server (--state-dir);
  // this module only renders it and asks the server to change it. Conversation titles and paths are
  // untrusted: everything is set with textContent, never as HTML.
  const doc = () => root.document;
  const $ = (id) => doc().getElementById(id);
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const OPEN_KEYS = { archived: 'studio-archived-open', deleted: 'studio-deleted-open' };
  const HOLD_KEY = 'studio-hold-open-by-project'; // {projectKey: 1} for projects whose "On hold" sub-line is expanded

  let host = null,
    state = { revision: '', entries: {}, warning: '' };
  let menu = null,
    menuTrigger = null,
    dialog = null,
    rendered = [],
    pendingFocus = null,
    fetching = null;

  function readOpen(name) {
    try {
      return root.localStorage.getItem(OPEN_KEYS[name]) === '1';
    } catch (e) {
      return false;
    }
  }
  function writeOpen(name, open) {
    try {
      root.localStorage.setItem(OPEN_KEYS[name], open ? '1' : '0');
    } catch (e) {
      /* storage may be unavailable */
    }
  }

  function holdOpenMap() {
    try {
      const v = JSON.parse(root.localStorage.getItem(HOLD_KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      return {};
    }
  }
  const isHoldOpen = (pkey) => !!holdOpenMap()[pkey];
  function setHoldOpen(pkey, open) {
    const m = holdOpenMap();
    if (open) m[pkey] = 1;
    else delete m[pkey];
    try {
      root.localStorage.setItem(HOLD_KEY, JSON.stringify(m));
    } catch (e) {
      /* storage may be unavailable */
    }
  }
  const projectKeyOf = (c) => {
    const sb = sidebar();
    return sb && sb.projectOf ? sb.projectOf(c).key : '';
  };

  const keyOf = (c) => host.aliasKey(c);
  const entryOf = (c) => state.entries[keyOf(c)] || {};
  const isLive = (c) => !!(c && c.live && !c.live.closed);
  // Only conversations that have a session ID can be marked; a connection that is still starting cannot.
  const markable = (c) => !!(c && c.provider && c.id);
  const sessionIdOf = (c) => keyOf(c).slice(String(c.provider).length + 1);
  const titleOf = (c) => host.titleOf(c);

  // A live conversation is never hidden by a stale tombstone.
  function bucket(c) {
    const e = entryOf(c);
    if (e.deletedAt && !isLive(c)) return 'deleted';
    if (e.archivedAt) return 'archived';
    if (e.holdAt) return 'hold'; // on hold wins: holding unpins (older entries may still carry both)
    if (e.pinnedAt) return 'pinned';
    return 'main';
  }
  const byKey = (a, b) => keyOf(a).localeCompare(keyOf(b));

  // rows arrive filtered for provider and search and already in the main-list order.
  function partition(rows) {
    const out = { pinned: [], hold: [], main: [], archived: [] };
    // Every conversation appears once: pinned ones only in Pinned, held ones only in On hold. The project rail
    // already scopes the list to a project, so pinned chats no longer need a second row in their project group.
    for (const c of rows) {
      const b = bucket(c);
      if (out[b]) out[b].push(c);
    }
    out.pinned.sort((a, b) => entryOf(b).pinnedAt - entryOf(a).pinnedAt || byKey(a, b));
    out.hold.sort((a, b) => entryOf(b).holdAt - entryOf(a).holdAt || byKey(a, b));
    out.archived.sort((a, b) => entryOf(b).archivedAt - entryOf(a).archivedAt || byKey(a, b));
    return out;
  }
  const count = (all, provider) =>
    all.filter(
      (c) => (provider === 'all' || c.provider === provider) && bucket(c) !== 'archived' && bucket(c) !== 'deleted',
    ).length;
  // Elapsed on-hold times are shown, so the sidebar redraws once a minute while anything is on hold.
  const sidebar = () => root.AgentSidebarUI || null;
  const signature = () =>
    state.revision +
    '|' +
    state.warning +
    '|' +
    (sidebar() ? sidebar().signature() : '') +
    '|' +
    (Object.values(state.entries).some((e) => e.holdAt) ? Math.floor(Date.now() / 60000) : 0);
  // "held 3h": minutes, hours, days or weeks since it was put on hold.
  function ago(since) {
    const s = Math.max(0, Date.now() / 1000 - since);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    const d = Math.floor(h / 24);
    return d < 7 ? d + 'd' : Math.floor(d / 7) + 'w';
  }

  // ---- server state -------------------------------------------------------------------------
  async function fetchState() {
    const next = await host.get('/api/live/conversation-state');
    if (next && typeof next === 'object' && next.entries && typeof next.entries === 'object') {
      state = { revision: String(next.revision || ''), entries: next.entries, warning: next.warning || '' };
      flag(host.conversations ? host.conversations() : null);
    }
  }
  // ---- "your turn" ----------------------------------------------------------------------------
  // The server keeps a yourTurnAt time on a conversation whose agent finished a turn. It stays until you act (reply, hold,
  // archive, delete, Mark handled). Looking at the chat never clears it. The page reads it as conversation.yourTurn.
  const yourTurnAtOf = (c) => {
    const e = entryOf(c);
    return !e.holdAt && !e.archivedAt && !e.deletedAt ? Number(e.yourTurnAt) || 0 : 0;
  };
  const yourTurnOf = (c) => yourTurnAtOf(c) > 0;
  function flag(list) {
    if (!host) return list;
    for (const c of list || []) {
      if (!c) continue;
      const at = yourTurnAtOf(c);
      c.yourTurn = at > 0;
      c.yourTurnAt = at;
    }
    return list;
  }
  // Called from every list poll. A request is made only when the server's revision differs.
  async function sync(revision) {
    if (!host || (revision && revision === state.revision)) return false;
    if (fetching) return fetching;
    fetching = fetchState()
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        fetching = null;
      });
    return fetching;
  }

  // ---- dialogs ------------------------------------------------------------------------------
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = el('dialog', null, 'session-op-dialog organize-dialog');
    dialog.id = 'organizeDialog';
    doc().body.appendChild(dialog);
    return dialog;
  }
  // spec: {title, paragraphs[], checkbox:{label,note,disabled}, actions:[{label,value,danger}], focus:value}
  // Resolves {value, checked}; dismissing (Escape) resolves {value:"cancel"}.
  function ask(spec) {
    return new Promise((resolve) => {
      const d = ensureDialog();
      d.replaceChildren();
      let done = false,
        box = null,
        field = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        const result = { value, checked: !!(box && box.checked), text: field ? String(field.value || '') : '' };
        if (d.open) d.close();
        resolve(result);
      };
      d.oncancel = () => finish('cancel');
      // A close event from an earlier dialog can arrive after this one opened; only a really closed dialog counts.
      d.onclose = () => {
        if (!d.open) finish('cancel');
      };
      d.appendChild(el('h2', spec.title));
      for (const p of spec.paragraphs || []) if (p) d.appendChild(el('p', p, 'note'));
      if (spec.checkbox) {
        const label = el('label', null, 'organize-check');
        box = el('input');
        box.type = 'checkbox';
        box.disabled = !!spec.checkbox.disabled;
        label.append(box, el('span', ' ' + spec.checkbox.label));
        d.appendChild(label);
        d.appendChild(el('p', spec.checkbox.note, 'note'));
      }
      if (spec.input) {
        const label = el('label', null, 'organize-field');
        label.append(el('span', spec.input.label));
        field = el('input');
        field.type = 'text';
        field.maxLength = spec.input.maxLength || 120;
        field.placeholder = spec.input.placeholder || '';
        field.value = spec.input.value || '';
        field.onkeydown = (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(spec.input.submit);
          }
        };
        label.append(field);
        d.appendChild(label);
      }
      const row = el('div', null, 'rename-actions');
      let focusTarget = null;
      for (const action of spec.actions) {
        const b = el('button', action.label, action.danger ? 'primary danger' : '');
        b.type = 'button';
        b.onclick = () => finish(action.value);
        if (action.value === spec.focus) focusTarget = b;
        row.appendChild(b);
      }
      d.appendChild(row);
      d.showModal();
      if (spec.focus === 'input' && field) field.focus();
      else if (focusTarget && focusTarget.focus) focusTarget.focus();
    });
  }

  // ---- focus after an action ----------------------------------------------------------------
  function focusNow() {
    const spec = pendingFocus;
    pendingFocus = null;
    if (!spec) return;
    for (const key of spec.keys || []) {
      const hit = rendered.find((r) => r.key === key && r.main && r.visible());
      if (hit) {
        hit.main.focus({ preventScroll: false });
        return;
      }
    }
    const fallback = typeof spec.fallback === 'function' ? spec.fallback() : $(spec.fallback);
    if (fallback && !fallback.hidden && fallback.focus) fallback.focus();
  }
  function refocusRow(c, origin) {
    const target =
      origin === 'header' ? $('organizeCurrent') : (rendered.find((r) => r.key === keyOf(c) && r.more) || {}).more;
    if (target && target.focus) target.focus();
  }
  function neighbours(c) {
    const index = rendered.findIndex((r) => r.key === keyOf(c) && r.visible());
    if (index < 0) return [];
    const after = rendered.slice(index + 1).filter((r) => r.visible()),
      before = rendered
        .slice(0, index)
        .reverse()
        .filter((r) => r.visible());
    return [...after, ...before].map((r) => r.key);
  }

  // ---- actions ------------------------------------------------------------------------------
  /* One line in the archive flow for a chat whose worktree keeps unmerged changes. Archiving is never blocked and has no dialog. */
  const keptLine = (branch) =>
    'This chat has unmerged changes on ' + branch + '; they\u2019re kept until you discard or merge them.';
  function showArchiveNote(text) {
    const box = $('archivedBox');
    if (!box || !box.parentNode) return;
    let n = $('archiveNote');
    if (!text) {
      if (n) n.hidden = true;
      return;
    }
    if (!n) {
      n = doc().createElement('p');
      n.id = 'archiveNote';
      n.className = 'note';
      n.setAttribute('role', 'status');
      box.parentNode.insertBefore(n, box);
    }
    n.textContent = text;
    n.hidden = false;
  }
  async function call(action, c, extra) {
    const result = await host.post(
      'conversation-state',
      Object.assign({ action, provider: c.provider, sessionId: sessionIdOf(c) }, extra || {}),
    );
    if (action === 'archive' || action === 'delete' || action === 'unarchive')
      showArchiveNote(
        action === 'archive' && result && result.worktree && result.worktree.keptChanges
          ? keptLine(result.worktree.branch)
          : '',
      );
    await fetchState();
    host.rerender();
    focusNow();
  }
  async function guarded(fn) {
    try {
      await fn();
    } catch (error) {
      try {
        await fetchState();
        host.rerender();
      } catch (e) {
        /* the list keeps its last state */
      }
      pendingFocus = null;
      host.fail(error);
    }
  }
  function pinToggle(c, origin) {
    const unpin = !!entryOf(c).pinnedAt;
    pendingFocus =
      origin === 'header' ? { keys: [], fallback: 'organizeCurrent' } : { keys: [keyOf(c)], fallback: 'findChat' };
    return guarded(() => call(unpin ? 'unpin' : 'pin', c));
  }
  // After Hold / Resume from a card: the row itself when it can be seen, else its project's "On hold" line, else Find chat.
  function holdLineOf(c) {
    const pk = projectKeyOf(c),
      tog = holdToggles.get(pk) || (holdToggles.size === 1 ? holdToggles.values().next().value : null);
    return tog || $('findChat');
  }
  async function holdToggle(c, origin, editNote) {
    const held = !!entryOf(c).holdAt,
      pinned = !!entryOf(c).pinnedAt;
    const follow =
      origin === 'header'
        ? { keys: [], fallback: 'organizeCurrent' }
        : { keys: [keyOf(c)], fallback: () => holdLineOf(c) };
    if (held && !editNote) {
      pendingFocus = follow;
      return guarded(() => call('resume', c));
    }
    const answer = await ask({
      title: held ? 'Edit the on-hold note' : 'Put on hold',
      paragraphs: [
        '\u201C' +
          titleOf(c) +
          '\u201D ' +
          (held
            ? 'stays on hold in its project.'
            : 'moves to the \u201COn hold\u201D line under its project so you can come back to it later.'),
        // Holding unpins (a chat sits in one place only); say so instead of doing it silently (QA m5).
        !held && pinned ? 'It is pinned now: putting it on hold unpins it, and Resume does not pin it again.' : '',
      ],
      input: {
        label: 'Note (optional)',
        placeholder: 'e.g. waiting on CI',
        maxLength: 120,
        submit: 'ok',
        value: held ? entryOf(c).holdNote || '' : '',
      },
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: held ? 'Save note' : 'Put on hold', value: 'ok' },
      ],
      focus: 'input',
    });
    if (answer.value !== 'ok') return refocusRow(c, origin);
    pendingFocus = follow;
    return guarded(() => call('hold', c, { note: answer.text }));
  }
  async function archiveToggle(c, origin) {
    if (entryOf(c).archivedAt) {
      pendingFocus =
        origin === 'header'
          ? { keys: [], fallback: 'organizeCurrent' }
          : { keys: [keyOf(c)], fallback: 'archivedSummary' };
      return guarded(() => call('unarchive', c));
    }
    const follow =
      origin === 'header'
        ? { keys: [], fallback: 'organizeCurrent' }
        : { keys: neighbours(c), fallback: 'archivedSummary' };
    if (isLive(c)) {
      const choice = await ask({
        title: 'This conversation is live in AIB',
        paragraphs: [
          '“' + titleOf(c) + '” is connected to its agent right now.',
          "You can end this chat's session as you archive it, or keep it running and archive it anyway. Archiving never disconnects it on its own.",
        ],
        actions: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Keep running and archive', value: 'keep' },
          { label: "End this chat's session and archive", value: 'end', danger: true },
        ],
        focus: 'cancel',
      });
      if (choice.value !== 'keep' && choice.value !== 'end') return refocusRow(c, origin);
      pendingFocus = follow;
      return guarded(async () => {
        if (choice.value === 'end') await host.endSession(c);
        await call('archive', c);
      });
    }
    pendingFocus = follow;
    return guarded(() => call('archive', c));
  }
  // Delete = remove from Studio. Like Archive it is one click with no dialog, and it can be undone from Recently deleted.
  // The agent's own saved transcript is never touched. A live chat has its Studio session ended first.
  async function deleteNow(c, origin) {
    const title = titleOf(c),
      wasSelected = !!(host.getSelected() && keyOf(host.getSelected()) === keyOf(c));
    pendingFocus = { keys: origin === 'header' ? [] : neighbours(c), fallback: 'findChat' };
    return guarded(async () => {
      if (isLive(c)) await host.endSession(c);
      await host.post('conversation-state', {
        action: 'delete',
        provider: c.provider,
        sessionId: sessionIdOf(c),
        title,
        cwd: c.cwd || '',
      });
      await fetchState();
      if (wasSelected) host.closeSelected();
      host.rerender();
      await host.refreshList();
      focusNow();
    });
  }
  function markHandled(c) {
    if (!c || !markable(c)) return Promise.resolve();
    return guarded(() => call('handled', c));
  }
  function endSessionOf(c) {
    return guarded(async () => {
      if (isLive(c)) await host.endSession(c);
      await host.refreshList();
      host.rerender();
    });
  }
  // Rename: the open chat uses the header's inline rename; any other chat is renamed in place on its card.
  function renameFlow(c) {
    const sel = host.getSelected && host.getSelected(),
      header = root.AgentHeaderUI;
    if (sel && keyOf(sel) === keyOf(c) && header) {
      // the open chat: the header's inline rename
      if (typeof header.beginRename === 'function' && header.beginRename()) return;
      if (typeof header.startRename === 'function') {
        header.startRename();
        return;
      }
    }
    const hit = rendered.find((r) => r.key === keyOf(c) && r.main && r.visible());
    if (hit && host.setName && inlineRename(c, hit.main)) return;
    host.rename(c);
  }
  // The card being renamed survives list redraws (a poll can rebuild the list while you type).
  let renaming = null,
    redrawing = false;
  function inlineRename(c, main, typed) {
    const wrapper = main && main.parentNode;
    if (!wrapper || !wrapper.append || !doc().createElement) return false;
    const input = doc().createElement('input');
    input.type = 'text';
    input.className = 'rename-inline';
    input.maxLength = 120;
    input.value = typed != null ? typed : titleOf(c);
    input.autocomplete = 'off';
    renaming = { c, key: keyOf(c), value: input.value };
    input.setAttribute('aria-label', 'Rename ' + titleOf(c));
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      renaming = null;
      const key = keyOf(c);
      main.hidden = false;
      // Focus the card before the input goes (removing a focused input drops focus on the page body) and before the
      // rename redraws the list, so the redraw finds it and focuses the new card.
      if (main.focus) main.focus();
      input.remove();
      if (save && value !== titleOf(c) && host.setName) host.setName(c, value);
      const d = doc(),
        a = d.activeElement;
      if (!a || a === d.body || (a.isConnected === false && a !== main) || a.tagName === 'H1') {
        const back = rendered.find((r) => r.key === key && r.main && r.visible());
        if (back && back.main.focus) back.main.focus();
      }
    };
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        finish(false);
      }
    };
    input.oninput = () => {
      if (renaming && renaming.key === keyOf(c)) renaming.value = input.value;
    };
    input.onblur = () => {
      if (!redrawing) finish(true);
    };
    input.onclick = (event) => {
      if (event && event.stopPropagation) event.stopPropagation();
    };
    main.hidden = true;
    if (main.nextSibling && wrapper.insertBefore) wrapper.insertBefore(input, main.nextSibling);
    else wrapper.append(input);
    if (input.focus) input.focus();
    // Select everything but keep the start of the title in view (a plain select() scrolls to the end and cuts the first letters).
    if (input.setSelectionRange) {
      try {
        input.setSelectionRange(0, input.value.length, 'backward');
      } catch (e) {
        if (input.select) input.select();
      }
    } else if (input.select) input.select();
    input.scrollLeft = 0;
    return true;
  }

  async function restore(key) {
    const sep = key.indexOf(':'),
      provider = key.slice(0, sep),
      sessionId = key.slice(sep + 1);
    const items = rendered.filter((r) => r.deletedItem && r.visible()),
      index = items.findIndex((r) => r.key === key);
    const next = items[index + 1] || items[index - 1];
    pendingFocus = { keys: [key], fallback: () => (next && next.restoreButton) || $('deletedSummary') };
    try {
      await host.post('conversation-state', { action: 'restore', provider, sessionId });
      await fetchState();
      host.rerender();
      await host.refreshList();
      // The restored row now exists; if it is hidden (e.g. archived) fall back to the next restore button.
      focusNow();
    } catch (error) {
      pendingFocus = null;
      host.fail(error);
    }
  }

  // ---- menus --------------------------------------------------------------------------------
  function closeMenu(refocus) {
    if (!menu) return;
    const trigger = menuTrigger;
    if (menu.remove) menu.remove();
    menu = null;
    menuTrigger = null;
    if (trigger) {
      if (trigger.setAttribute) trigger.setAttribute('aria-expanded', 'false');
      if (refocus && trigger.focus && trigger.isConnected !== false) trigger.focus();
    }
  }
  // The one conversation menu, opened by right-click on a sidebar card or a tab, by the card's \u22EF button, and by the
  // ContextMenu key / Shift+F10. Pure: the items for a conversation in its current state.
  //   opts.thinking: true / false when the chat view can show or hide thinking (null hides the item)
  //   opts.handoff: the page can continue a chat with another agent
  //   opts.editor: name of the default editor ("VS Code") when the chat's folder can be opened in it, else empty
  function menuModel(c, opts) {
    const e = entryOf(c),
      o = opts || {},
      out = [],
      can = markable(c);
    const sep = () => {
      if (out.length && !out[out.length - 1].sep) out.push({ sep: true });
    };
    // Extra items from the caller (a tab's Split right / Split down): each carries its own run().
    if (Array.isArray(o.extra) && o.extra.length) {
      for (const x of o.extra) out.push({ id: x.id, label: x.label, run: x.run });
      sep();
    }
    out.push({ id: 'rename', label: 'Rename' });
    if (can && !e.archivedAt) {
      out.push({ id: e.pinnedAt ? 'unpin' : 'pin', label: e.pinnedAt ? 'Unpin' : 'Pin' });
      if (e.holdAt) {
        out.push({ id: 'holdnote', label: 'Edit hold note\u2026' });
        out.push({ id: 'resume', label: 'Resume' });
      } else out.push({ id: 'hold', label: 'Hold\u2026' });
    }
    if (can && yourTurnOf(c)) out.push({ id: 'handled', label: 'Mark handled' });
    sep();
    if (o.thinking === true || o.thinking === false)
      out.push({ id: 'thinking', label: 'Show thinking', checked: o.thinking });
    if (o.handoff) out.push({ id: 'handoff', label: 'Continue with another agent\u2026' });
    if (o.editor && c && typeof c.cwd === 'string' && c.cwd)
      out.push({ id: 'editor', label: 'Open folder in ' + o.editor });
    if (isLive(c)) out.push({ id: 'end', label: "End this chat's session" });
    if (can) {
      sep();
      out.push(e.archivedAt ? { id: 'unarchive', label: 'Unarchive' } : { id: 'archive', label: 'Archive' });
      out.push({ id: 'delete', label: 'Delete', danger: true });
    }
    while (out.length && out[out.length - 1].sep) out.pop();
    return out;
  }
  const editorName = () => {
    const E = root.AgentEditors;
    return E && E.loaded() ? E.editorLabel() : '';
  };
  const thinkingState = () => {
    const v = root.AgentChatView;
    return v && typeof v.setThinking === 'function' && typeof v.getThinking === 'function' ? !!v.getThinking() : null;
  };
  function runItem(id, c, origin) {
    switch (id) {
      case 'rename':
        return renameFlow(c);
      case 'pin':
      case 'unpin':
        return pinToggle(c, origin);
      case 'hold':
        return holdToggle(c, origin, false);
      case 'holdnote':
        return holdToggle(c, origin, true);
      case 'resume':
        return holdToggle(c, origin, false);
      case 'handled':
        return markHandled(c);
      case 'thinking': {
        const v = root.AgentChatView;
        if (v && v.setThinking) v.setThinking(!v.getThinking());
        return undefined;
      }
      case 'handoff':
        return host.handoff(c);
      case 'editor': {
        const E = root.AgentEditors;
        return E && c && c.cwd ? E.openFolder(c.cwd) : undefined;
      }
      case 'end':
        return endSessionOf(c);
      case 'archive':
      case 'unarchive':
        return archiveToggle(c, origin);
      case 'delete':
        return deleteNow(c, origin);
      default:
        return undefined;
    }
  }
  // trigger: the element to hand focus back to. point {x, y}: open at the pointer (right-click); otherwise under the trigger.
  function openMenu(trigger, c, origin, point, extra) {
    if (!point && menu && menuTrigger === trigger) return closeMenu(true);
    closeMenu(false);
    const items = menuModel(c, {
      thinking: thinkingState(),
      handoff: typeof host.handoff === 'function',
      editor: editorName(),
      extra,
    });
    menu = el('div', null, 'organize-menu');
    menu.id = 'organizeMenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Actions for ' + titleOf(c));
    const buttons = [];
    for (const item of items) {
      if (item.sep) {
        const d = el('div', null, 'organize-sep');
        d.setAttribute('role', 'separator');
        menu.appendChild(d);
        continue;
      }
      const b = el('button', item.label, item.danger ? 'danger' : '');
      b.type = 'button';
      b.tabIndex = -1;
      b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
      b.dataset.item = item.id;
      b.onclick = () => {
        closeMenu(false);
        if (typeof item.run === 'function') item.run();
        else runItem(item.id, c, origin);
      };
      menu.appendChild(b);
      buttons.push(b);
    }
    menu.onkeydown = (event) => {
      const at = buttons.indexOf(doc().activeElement);
      const go = (i) => {
        event.preventDefault();
        buttons[(i + buttons.length) % buttons.length].focus();
      };
      if (event.key === 'ArrowDown') go(at + 1);
      else if (event.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
      else if (event.key === 'Home') go(0);
      else if (event.key === 'End') go(-1);
      else if (event.key === 'Escape') {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        closeMenu(true);
      } else if (event.key === 'Tab') closeMenu(false);
    };
    doc().body.appendChild(menu);
    menuTrigger = trigger;
    if (trigger && trigger.setAttribute) trigger.setAttribute('aria-expanded', 'true');
    const vw = root.innerWidth || 1200,
      vh = root.innerHeight || 800,
      w = menu.offsetWidth || 220,
      h = menu.offsetHeight || 280;
    if (point) {
      menu.style.left = Math.max(8, Math.min(vw - w - 8, Math.round(point.x))) + 'px';
      menu.style.top = Math.max(8, Math.min(vh - h - 8, Math.round(point.y))) + 'px';
    } else {
      const rect = trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : { left: 0, bottom: 0, right: 0 };
      menu.style.top = Math.max(8, Math.min(vh - h - 8, Math.round(rect.bottom + 2))) + 'px';
      menu.style.left = Math.max(8, Math.min(vw - w - 8, Math.round(rect.right - 190))) + 'px';
    }
    if (root.AgentTextSize) root.AgentTextSize.fitPopup(menu);
    if (buttons[0]) buttons[0].focus();
  }
  // Right-click / ContextMenu key on a card or a tab. c is a page conversation; (x, y) the pointer or the element's corner.
  function openContextMenu(c, x, y, returnTo, extra) {
    if (c && host) openMenu(returnTo || null, c, 'row', { x, y }, extra);
  }
  // Wire right-click and the ContextMenu key / Shift+F10 on a node that stands for conversation c.
  function bindContext(node, c, focusTarget) {
    if (!node || !node.addEventListener) return;
    node.addEventListener('contextmenu', (event) => {
      if (event.preventDefault) event.preventDefault();
      openContextMenu(c, event.clientX || 0, event.clientY || 0, focusTarget || event.target);
    });
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      if (event.preventDefault) event.preventDefault();
      const t = focusTarget || event.target,
        r = t && t.getBoundingClientRect ? t.getBoundingClientRect() : { left: 0, bottom: 0 };
      openContextMenu(c, r.left + 24, r.bottom, t);
    });
  }
  // The row's "..." button.
  function menuButton(c) {
    const b = el('button', '\u22EF', 'rename-chat');
    b.type = 'button';
    b.title = 'Conversation actions';
    b.setAttribute('aria-label', 'Actions for ' + titleOf(c));
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    if (!b.dataset) b.dataset = {};
    b.dataset.menuKey = keyOf(c);
    b.onclick = () => openMenu(b, c, 'row');
    return b;
  }
  function syncHeader(selected) {
    const b = $('organizeCurrent');
    if (!b || !host) return;
    const show = !!(selected && markable(selected));
    b.hidden = !show;
    if (!show) return;
    const e = entryOf(selected);
    b.textContent =
      (e.deletedAt && !isLive(selected)
        ? 'Deleted'
        : e.archivedAt
          ? 'Archived'
          : e.pinnedAt && e.holdAt
            ? 'Pinned · On hold'
            : e.pinnedAt
              ? 'Pinned'
              : e.holdAt
                ? 'On hold'
                : 'Organize') + ' ▾';
    b.setAttribute('aria-label', 'Organize this conversation: pin, archive or delete');
  }

  // ---- rendering ----------------------------------------------------------------------------
  // Section header like the mockup: label on the left, count on the right.
  function heading(id, label, n) {
    const h = el('h3', null, 'list-heading');
    h.id = id;
    h.append(el('span', label), el('span', n, 'n'));
    return h;
  }
  // The "Chats n" row: a "+" after the count starts a new chat in the project the list shows ("All chats": the plain
  // New chat, in the project of the chat you were on or the last one).
  function chatsHeading(n) {
    const h = heading('mainHeading', 'Chats', n);
    const W = root.AgentWorkspaceUI;
    if (!W || !W.newChatIn) return h;
    const p = W.activeProject && !(sidebar() && sidebar().isGrouping()) ? W.activeProject() : null;
    const label = 'New chat' + (p ? ' in ' + p.name : '');
    const add = el('button', '+', 'list-add');
    add.type = 'button';
    add.title = label;
    add.setAttribute('aria-label', label);
    add.onclick = () => W.newChatIn(p ? p.key : '');
    h.append(add);
    return h;
  }
  function group(id, label, rows, ctx, visible) {
    const wrap = el('div', null, 'list-group');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-labelledby', id);
    wrap.append(heading(id, label, rows.length));
    for (const c of rows) wrap.append(row(c, ctx, visible));
    return wrap;
  }
  function row(c, ctx, visible, inProject, held) {
    const node = ctx.buildRow(c);
    const e = entryOf(c);
    const holdNote = e.holdNote || 'no note',
      holdAge = held && e.holdAt ? 'held ' + ago(e.holdAt) : '',
      holdText = holdAge ? holdNote + ' \u00B7 ' + holdAge : '';
    // The sidebar card builds its own third line (hold note first, else the last message); without it the note is appended here.
    const built = sidebar()
      ? sidebar().decorateRow(node, c, !!inProject, { hold: holdText, holdNote, holdAge })
      : false;
    const main = node.children && node.children[0],
      more = node.children && node.children[1];
    if (e.pinnedAt && main) {
      main.className = (main.className || '') + ' is-pinned';
      // The star is its own item after the title, outside the title's ellipsis box, so a long title never clips it.
      if (main.append) {
        const star = el('span', null, 'row-pin'); // the star glyph is CSS, so the card's text stays the title
        star.title = 'Pinned';
        star.setAttribute('role', 'img');
        star.setAttribute('aria-label', 'Pinned');
        main.append(star);
      }
    }
    if (holdText && !built && main && main.append) {
      const note = el('small', holdText, 'hold-note');
      note.title = holdText;
      main.append(note);
    }
    rendered.push({ key: keyOf(c), main, more, visible });
    bindContext(node, c, main);
    if (main && main.addEventListener) main.addEventListener('keydown', (event) => stepCard(event, keyOf(c)));
    return node;
  }
  // Up / Down move between the cards you can see (QA m7): one arrow key instead of two Tab stops per chat.
  function stepCard(event, key) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const list = rendered.filter((r) => r.main && !r.deletedItem && r.visible() && !r.main.hidden),
      at = list.findIndex((r) => r.key === key && r.main === event.currentTarget),
      i = at >= 0 ? at : list.findIndex((r) => r.key === key);
    const next = list[i + (event.key === 'ArrowDown' ? 1 : -1)];
    if (i < 0 || !next) return;
    if (event.preventDefault) event.preventDefault();
    next.main.focus();
  }
  function deletedItems(ctx) {
    const known = new Map(ctx.all.map((c) => [keyOf(c), c]));
    const q = (ctx.query || '').toLowerCase(),
      out = [];
    for (const [key, e] of Object.entries(state.entries)) {
      if (!e.deletedAt || (ctx.provider !== 'all' && key.indexOf(ctx.provider + ':') !== 0)) continue;
      const c = known.get(key);
      if (c && isLive(c)) continue;
      const title = c ? titleOf(c) : e.title || 'Untitled conversation';
      if (q && !(title + ' ' + (c ? c.cwd : e.cwd) + ' ' + key).toLowerCase().includes(q)) continue;
      out.push({ key, title, e, cwd: (c ? c.cwd : e.cwd) || '' });
    }
    return out.sort((a, b) => b.e.deletedAt - a.e.deletedAt || a.key.localeCompare(b.key));
  }
  function deletedRow(item) {
    const wrap = el('div', null, 'deleted-row');
    wrap.append(el('span', item.title, 'deleted-title'));
    const when = new Date(item.e.deletedAt * 1000);
    const note = item.e.agentDeleted
      ? 'Also deleted from the agent — cannot be restored.'
      : 'Hidden from AIB. The agent’s transcript is untouched.';
    wrap.append(el('small', (isNaN(+when) ? '' : 'Deleted ' + when.toLocaleString() + '. ') + note, 'deleted-note'));
    const b = el('button', item.e.agentDeleted ? 'Remove from list' : 'Restore', 'restore-chat');
    b.type = 'button';
    b.setAttribute('aria-label', (item.e.agentDeleted ? 'Remove from list: ' : 'Restore: ') + item.title);
    b.onclick = () => restore(item.key);
    wrap.append(b);
    return { node: wrap, button: b };
  }
  let holdSeq = 0;
  const holdToggles = new Map(); // project key -> its "On hold" line in the list drawn last
  // "\u23F8 On hold \u00B7 n" under a project's active chats; its held rows (dimmed, with their hold note) show when it is
  // expanded. Returns {node, toggleId}; the expanded state is remembered per project key.
  function holdBlock(pkey, rows, ctx, parentVisible) {
    const open = () => isHoldOpen(pkey);
    const wrap = el('div', null, 'hold-sub');
    wrap.dataset.project = pkey;
    const tog = el('button', null, 'hold-toggle');
    tog.type = 'button';
    tog.id = 'holdToggle-' + ++holdSeq;
    holdToggles.set(pkey, tog);
    const caret = el('span', open() ? '\u25BE' : '\u25B8', 'hold-caret');
    caret.setAttribute('aria-hidden', 'true');
    tog.setAttribute('aria-expanded', String(open()));
    tog.append(caret, el('span', '\u23F8 On hold \u00B7 ' + rows.length, 'hold-label'));
    const body = el('div', null, 'hold-rows');
    body.hidden = !open();
    for (const c of rows) body.append(row(c, ctx, () => open() && parentVisible(), true, true));
    tog.onclick = () => {
      const now = !open();
      setHoldOpen(pkey, now);
      body.hidden = !now;
      tog.setAttribute('aria-expanded', String(now));
      caret.textContent = now ? '\u25BE' : '\u25B8';
    };
    wrap.append(tog, body);
    return { node: wrap, toggleId: tog.id };
  }
  // box = #connections. view = partition(rows). ctx = {buildRow, all, provider, query, emptyText}
  function render(box, view, ctx) {
    const active = doc().activeElement,
      activeData = active && active.dataset ? active.dataset : {};
    const hadFocus = activeData.key || activeData.menuKey || activeData.restoreKey || '';
    const restoreFocusKind = activeData.key
      ? 'main'
      : activeData.menuKey
        ? 'more'
        : activeData.restoreKey
          ? 'restore'
          : '';
    rendered = [];
    holdToggles.clear();
    redrawing = true;
    const archivedOpen = () => {
      const d = $('archivedBox');
      return !d || d.open;
    };
    const always = () => true;
    const frag = doc().createDocumentFragment();
    const projects = sidebar() && sidebar().isGrouping();
    // Pinned shortcuts first, then every active chat (grouped by project in the all-chats view). Held chats sit inside
    // their own project, under a small collapsible "On hold" line.
    // In All chats (grouped by project) pinned chats sit at the top of their own project instead of a separate section.
    if (view.pinned.length && !projects) frag.append(group('pinnedHeading', 'Pinned', view.pinned, ctx, always));
    if (view.main.length || view.hold.length || (projects && view.pinned.length)) {
      if (projects) {
        const listed = view.pinned.concat(view.main);
        if (listed.length) frag.append(chatsHeading(listed.length));
        const held = (r) => holdBlock(r.key, r.rows, ctx, r.visible).node;
        for (const g of sidebar().projectGroups(listed, (c, visible) => row(c, ctx, visible, true), {
          forceOpen: !!ctx.query,
          held: view.hold,
          holdBlock: held,
        }))
          frag.append(g);
      } else {
        const wrap = el('div', null, 'list-group');
        wrap.setAttribute('role', 'group');
        if (view.main.length) {
          wrap.setAttribute('aria-labelledby', 'mainHeading');
          wrap.append(chatsHeading(view.main.length));
        }
        for (const c of view.main) wrap.append(row(c, ctx, always));
        if (view.hold.length) {
          const block = holdBlock(projectKeyOf(view.hold[0]), view.hold, ctx, always);
          if (!view.main.length) wrap.setAttribute('aria-labelledby', block.toggleId);
          wrap.append(block.node);
        }
        frag.append(wrap);
      }
    }
    if (!view.pinned.length && !view.hold.length && !view.main.length)
      frag.append(
        el('p', view.archived.length && !ctx.query ? 'Everything in this list is archived.' : ctx.emptyText, 'note'),
      );
    box.replaceChildren(frag);

    // Archived accordion (static markup, outside the scrolling list so it stays at the bottom).
    const list = $('archivedList'),
      summary = $('archivedSummary');
    if (list && summary) {
      const lf = doc().createDocumentFragment();
      if (state.warning) lf.append(el('p', state.warning, 'note'));
      for (const c of view.archived) lf.append(row(c, ctx, archivedOpen));
      if (!view.archived.length)
        lf.append(el('p', ctx.query ? 'No archived conversations match.' : 'Nothing archived.', 'note'));
      list.replaceChildren(lf);
      summary.replaceChildren(el('span', 'Archived'), el('span', view.archived.length, 'n'));
      const del = deletedItems(ctx),
        dlist = $('deletedList'),
        dsummary = $('deletedSummary');
      if (dlist && dsummary) {
        const df = doc().createDocumentFragment();
        for (const item of del) {
          const r = deletedRow(item);
          rendered.push({
            key: item.key,
            deletedItem: true,
            restoreButton: r.button,
            visible: () => archivedOpen() && !!($('deletedBox') || {}).open,
          });
          if (!r.button.dataset) r.button.dataset = {};
          r.button.dataset.restoreKey = item.key;
          df.append(r.node);
        }
        if (!del.length) df.append(el('p', 'Nothing deleted recently.', 'note'));
        dlist.replaceChildren(df);
        // Written like "Archived 2": the label, then the count at the right.
        dsummary.replaceChildren(el('span', 'Recently deleted'), el('span', del.length, 'n'));
      }
    }
    redrawing = false;
    if (renaming) {
      const back = rendered.find((r) => r.key === renaming.key && r.main && r.visible());
      if (back) inlineRename(renaming.c, back.main, renaming.value);
      else renaming = null;
    } else if (hadFocus) {
      const hit = rendered.find(
        (r) => r.key === hadFocus || (r.more && r.more.dataset && r.more.dataset.menuKey === hadFocus),
      );
      const target =
        hit && (restoreFocusKind === 'more' ? hit.more : restoreFocusKind === 'restore' ? hit.restoreButton : hit.main);
      if (target && target.focus) target.focus({ preventScroll: true });
    }
  }

  // Keys of the conversations you can currently see, top to bottom (collapsed groups and closed accordions excluded).
  function visibleKeys() {
    const seen = new Set(),
      out = [];
    for (const r of rendered)
      if (r.main && !r.deletedItem && r.visible() && !seen.has(r.key)) {
        seen.add(r.key);
        out.push(r.key);
      }
    return out;
  }
  function bindAccordion(name, id) {
    const d = $(id);
    if (!d) return;
    d.open = readOpen(name);
    const sync = () => {
      const s = d.children && d.children[0];
      if (s && s.setAttribute) s.setAttribute('aria-expanded', String(!!d.open));
    };
    sync();
    d.addEventListener('toggle', () => {
      writeOpen(name, d.open);
      sync();
    });
  }

  function init(h) {
    host = h;
    bindAccordion('archived', 'archivedBox');
    bindAccordion('deleted', 'deletedBox');
    const header = $('organizeCurrent');
    if (header)
      header.onclick = () => {
        const s = host.getSelected();
        if (s) openMenu(header, s, 'header');
      };
    // A press or a click anywhere else closes the menu (a click with no pointer press first, e.g. from the keyboard or a script,
    // counts too), and Escape closes it wherever the focus went, before Settings or a dialog behind it can take the key.
    const outside = (event) => {
      if (!menu) return;
      const t = event.target;
      if (t === menuTrigger || (menu.contains && menu.contains(t))) return;
      closeMenu(false);
    };
    doc().addEventListener('pointerdown', outside);
    doc().addEventListener('click', outside, true);
    doc().addEventListener(
      'keydown',
      (event) => {
        if (!menu || event.key !== 'Escape') return;
        if (menu.contains && menu.contains(event.target)) return; // the menu's own handler closes it and refocuses
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        closeMenu(true);
      },
      true,
    );
  }

  const api = {
    init,
    sync,
    partition,
    count,
    signature,
    render,
    menuButton,
    syncHeader,
    bucket,
    visibleKeys,
    entryOf: (c) => entryOf(c),
    hold: (c) => holdToggle(c, 'header', false),
    run: (id, c, origin) => runItem(id, c, origin || 'header'),
    thinkingState,
    markHandled,
    flag,
    yourTurn: yourTurnOf,
    menuModel,
    openContextMenu,
    bindContext,
    _state: () => state,
    _openMenu: openMenu,
    _closeMenu: closeMenu,
  };
  root.AgentOrganizeUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
