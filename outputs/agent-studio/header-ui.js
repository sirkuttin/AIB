(function (root) {
  'use strict';
  // The one-line chat header (review-decisions.html "Chat header"): the chat name with an inline pencil, then the agent
  // chip (read-only) and the status chip (filled in by attention-ui.js from status-words.js). Clicking the pencil or the
  // name turns it into a text field in place: Enter saves, Esc cancels, leaving the field saves. No path, no Hold, no
  // menus: those live in the right-click menu. The session details (context, cost, id, notices) are built here and shown
  // as a tooltip on the composer's Ctx chip. Everything is set with textContent; chat.js calls render() from renderHeader().
  const doc = () => root.document;
  const $ = (id) => doc().getElementById(id);
  const BRANCH_TTL = 20000;

  const branches = new Map(); // cwd -> {branch, at, busy}

  // Cached branch name for a folder ("" while unknown). Refreshes in the background; again() runs when the answer changed.
  function branchOf(cwd, again) {
    if (!cwd || typeof root.fetch !== 'function') return '';
    const hit = branches.get(cwd) || { branch: '', at: 0, busy: false };
    branches.set(cwd, hit);
    if (!hit.busy && Date.now() - hit.at > BRANCH_TTL) {
      hit.busy = true;
      // The page's own GET helper sends the Studio token; plain fetch is the fallback for pages without it.
      Promise.resolve()
        .then(() =>
          typeof root.AgentStudioGet === 'function'
            ? root.AgentStudioGet('/api/live/branch', { cwd })
            : root
                .fetch('/api/live/branch?cwd=' + encodeURIComponent(cwd))
                .then((r) => (r.ok ? r.json() : { branch: '' })),
        )
        .then((data) => {
          const next = data && typeof data.branch === 'string' ? data.branch : '';
          hit.at = Date.now();
          hit.busy = false;
          if (next !== hit.branch) {
            hit.branch = next;
            if (again) again();
          }
        })
        .catch(() => {
          hit.at = Date.now();
          hit.busy = false;
        });
    }
    return hit.branch;
  }

  // ---- session details: the lines shown when you hover or focus the Ctx chip -----------------------------------------
  const num = (n) => Number(n).toLocaleString('en-US');
  const COMPACTION = {
    in_progress: 'Compacting context…',
    completed: 'Context compacted',
    failed: 'Compaction failed',
    cancelled: 'Compaction cancelled',
    other: 'Compaction update',
  };
  function localTime(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? String(iso) : new Date(t).toLocaleString();
  }
  // snapshot: the live state ({sessionId, breadth: {usage, sessionInfo, compaction, notices}}). Only what the agent reported.
  function sessionDetails(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return [];
    const b = snapshot.breadth || {},
      lines = [];
    const u = b.usage;
    if (u && u.used != null && u.size)
      lines.push(
        'Context ' + num(u.used) + ' / ' + num(u.size) + ' tokens (' + Math.round((u.used / u.size) * 100) + '%)',
      );
    else if (u && u.used != null) lines.push('Context ' + num(u.used) + ' tokens');
    else if (u && u.size != null) lines.push('Context window ' + num(u.size) + ' tokens');
    if (u && u.cost) lines.push('Cost ' + u.cost.amount + ' ' + u.cost.currency);
    const info = b.sessionInfo || {};
    if (info.title) lines.push('Session: ' + info.title);
    if (info.updatedAt) lines.push('Updated ' + localTime(info.updatedAt));
    for (const c of (b.compaction || []).slice(-3))
      lines.push((COMPACTION[c.status] || COMPACTION.other) + (c.error ? ': ' + c.error : ''));
    for (const n of (b.notices || []).slice(-3))
      lines.push((n.title || 'Notice') + (n.description ? ' — ' + n.description : ''));
    if (snapshot.sessionId) lines.push('Session ID ' + snapshot.sessionId);
    return lines.map((l) => String(l).slice(0, 300));
  }

  // ---- inline rename --------------------------------------------------------------------------------------------
  let ctx = null,
    wired = false,
    editing = null;

  const isEditing = () => !!editing;

  // Turns the name into a text field. Returns false when there is nothing to rename (no chat open) or it is already open.
  function beginRename() {
    const h1 = $('title'),
      c = ctx;
    const pencil = $('renameCurrent');
    if (!h1 || !c || !c.selected || !c.onRename || editing || (pencil && pencil.hidden)) return false; // the pencil is hidden on the New chat view
    const input = doc().createElement('input');
    input.type = 'text';
    input.className = 'hd-title-input';
    input.maxLength = 160;
    input.value = c.title || '';
    input.setAttribute('aria-label', 'Chat name');
    const target = c.selected,
      original = c.title || '';
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      editing = null;
      const value = input.value.trim();
      h1.textContent = original;
      if (save && value !== original) c.onRename(target, value);
      if (c.onChange) c.onChange();
      if (h1.focus) h1.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    editing = { input };
    h1.replaceChildren(input);
    if (input.focus) input.focus();
    if (input.select) input.select();
    return true;
  }

  function wire() {
    if (wired) return;
    wired = true;
    const h1 = $('title'),
      pencil = $('renameCurrent'),
      dismiss = $('ownershipDismiss');
    if (h1) {
      h1.addEventListener('click', (e) => {
        if (!editing && !(e.target && e.target.closest && e.target.closest('input'))) beginRename();
      });
      h1.addEventListener('keydown', (e) => {
        if (!editing && (e.key === 'Enter' || e.key === 'F2')) {
          e.preventDefault();
          beginRename();
        }
      });
    }
    if (pencil) pencil.addEventListener('click', beginRename);
    if (dismiss)
      dismiss.onclick = () => {
        if (root.AgentOwnershipUI && ctx) root.AgentOwnershipUI.dismissHint(ctx.selected, $('ownershipHint'));
      };
  }

  // c: {selected, connected, current, onChange, title, onRename(conversation, newName)}
  function render(c) {
    ctx = c;
    const s = c.selected;
    if (!s) return;
    wire();
    const h1 = $('title');
    if (h1) {
      h1.setAttribute('role', 'button');
      h1.tabIndex = 0;
      h1.title = 'Rename this chat';
    }
    // The branch of a worktree chat, next to the title; absent (hidden) for every other chat. Set with textContent.
    const line = h1 && h1.parentNode;
    if (line) {
      let chip = $('branchChip');
      if (!chip) {
        chip = doc().createElement('span');
        chip.id = 'branchChip';
        chip.className = 'vend hd-branch';
        chip.hidden = true;
        h1.after(chip);
      }
      const sidebar = root.AgentSidebarUI,
        branch = sidebar && sidebar.branchOf ? sidebar.branchOf(s) : '';
      chip.hidden = !branch;
      chip.textContent = branch ? '⎇ ' + branch : '';
      chip.title = branch ? 'This chat works on its own branch ' + branch : '';
    }
    // No agent chip in the header (owner's choice): the agent shows on the composer's agent chip and the sidebar card.
    const vendor = $('vendorChip');
    if (vendor) vendor.hidden = true;
    const disconnect = $('disconnect');
    if (disconnect) disconnect.hidden = !c.current;
  }

  const api = { branchOf, render, sessionDetails, beginRename, isEditing, _branches: branches };
  root.AgentHeaderUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
