'use strict';
/* global CSS */
/* The doc page's side panels and menus (doc.html, on top of doc-ui.js):
   - Comments: a 300 px rail at 1100 px or wider (an overlay panel from the header button below that, with counts in the margin);
     This page / All pages; add on selected words, reply, resolve, reopen; "Send to <agent> ▾" (the doc's linked chat, or a chat
     picked in chat.html, which links the doc to it).
   - History: the versions for the whole doc (author, pages changed), one version read-only, a rendered Compare with now (words
     added and removed, block bars, unchanged blocks folded, a heading per changed page) and Restore of the whole doc or one page,
     with the stale check and the server's refusals (keystrokes in flight, an agent still writing).
   - The ⋯ menu: Markdown export of this page or all pages to Downloads, Duplicate doc, Show in the Docs tab, Move doc to trash.
   - A drawing's picture full screen (drawings are view-only on the doc page in v1). */
(function () {
  const D = window.AIBDoc;
  const { el, btn, icon, $, agentName } = D;
  const E = () => window.AIBDocEditor;
  let panel = null; // 'comments' | 'history' | null
  let scope = 'page';
  let showResolved = false;
  let composing = null; // {block, from, to, text}
  const drafts = new Map();

  /** A time from the server: an ISO string, or seconds (history versions) or milliseconds since the epoch. */
  const dateOf = (at) => (typeof at === 'number' ? new Date(at < 1e12 ? at * 1000 : at) : new Date(at));
  const time = (at) => (at ? dateOf(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
  function day(at) {
    const d = dateOf(at),
      now = new Date();
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], {
      day: 'numeric',
      month: 'short',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  }
  const linkedName = () => (D.linked ? agentName(D.linked) : null);

  // ---------------------------------------------------------------------------------------------------------------------------
  // The rail: comments or history, docked (≥ 1100 px) or an overlay panel

  function setPanel(which) {
    panel = which;
    const app = $('docApp');
    $('btnComments').setAttribute('aria-pressed', String(which === 'comments'));
    $('btnHistory').setAttribute('aria-pressed', String(which === 'history'));
    app.classList.toggle('rail-open', !!which);
    const rail = $('rail');
    rail.hidden = !which;
    rail.classList.toggle('rail-overlay', !!which && !app.classList.contains('wide-rail'));
    if (which !== 'history') leaveVersion();
    render();
  }
  D.setPanel = setPanel;
  $('btnComments').addEventListener('click', () => setPanel(panel === 'comments' ? null : 'comments'));
  $('btnHistory').addEventListener('click', () => setPanel(panel === 'history' ? null : 'history'));
  D.on('layout', () => {
    const rail = $('rail');
    rail.classList.toggle('rail-overlay', !!panel && !$('docApp').classList.contains('wide-rail'));
    renderMarginCounts();
  });

  function render() {
    if (panel === 'comments') renderComments();
    else if (panel === 'history') renderHistory();
    renderMarginCounts();
  }
  D.on('state', () => panel === 'comments' && renderComments());
  D.on('state', renderMarginCounts);
  D.on('page', () => {
    leaveVersion();
    render();
  });
  D.on('opened', () => {
    // at 1100 px or wider the rail opens by itself when the page has open threads
    if (
      panel === null &&
      $('docApp').classList.contains('wide-rail') &&
      D.threads.some((t) => !t.resolved && t.page === D.page)
    )
      setPanel('comments');
  });

  function railHead(title, extra) {
    const h = el('div', 'rail-h');
    h.append(el('span', '', title));
    for (const x of extra || []) h.append(x);
    h.append(el('span', 'sp'));
    return h;
  }
  /** The "This page ▾" / "All pages ▾" button: AIB's own menu in place of the browser's select. */
  function scopePicker(label, options, current, onPick) {
    const b = btn('scope', null, null, label);
    const name = (options.find(([v]) => v === current) || options[0])[1];
    b.append(el('span', 'scope-t', name), el('span', 'caret-s', '▾'));
    b.setAttribute('aria-label', label + ': ' + name);
    b.setAttribute('aria-haspopup', 'menu');
    b.addEventListener('click', () =>
      D.menu(
        b,
        options.map(([v, text]) => ({ label: text, on: v === current, run: () => onPick(v) })),
        { cls: 'scope-menu' },
      ),
    );
    return b;
  }
  function closeBtn() {
    const x = btn('rail-x', '✕', () => setPanel(null), 'Close');
    x.setAttribute('aria-label', 'Close');
    return x;
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Comments

  function byName(who) {
    return who === 'user' ? 'You' : agentName(who);
  }

  function renderComments() {
    const rail = $('rail');
    rail.replaceChildren();
    const open = D.threads.filter((t) => !t.resolved);
    // this page's threads and the whole-doc notes (they belong to every page): the header count, the list and the empty line agree
    const here = open.filter((t) => t.page === D.page || !t.anchor);
    const sel = scopePicker(
      'Which comments',
      [
        ['page', 'This page'],
        ['all', 'All pages'],
      ],
      scope,
      (v) => {
        scope = v;
        renderComments();
      },
    );
    const head = railHead('Comments', [
      el('span', 'f', scope === 'page' ? `· ${here.length} open here` : `· ${open.length} open`),
    ]);
    head.append(sel, closeBtn());
    rail.append(head);
    if (composing) rail.append(composer());
    const list = scope === 'page' ? here : open;
    if (scope === 'all') {
      const docNotes = list.filter((t) => !t.anchor);
      if (docNotes.length) rail.append(el('div', 'grp', 'On the whole doc'), ...docNotes.map(card));
      for (const p of D.pages) {
        const on = list.filter((t) => t.page === p.id);
        if (on.length) rail.append(el('div', 'grp', p.title), ...on.map(card));
      }
      const gone = list.filter((t) => t.anchor && !t.page);
      if (gone.length) rail.append(el('div', 'grp', 'Text removed'), ...gone.map(card));
    } else {
      for (const t of list) rail.append(card(t));
    }
    if (!list.length && !composing)
      rail.append(
        el(
          'div',
          'rail-empty',
          scope === 'page'
            ? 'No open comments on this page. Select words and press Ctrl+Alt+M to add one.'
            : 'No open comments.',
        ),
      );
    const elsewhere = open.length - here.length;
    if (scope === 'page' && elsewhere > 0) {
      const line = el('div', 'resolved');
      line.append(
        el('span', '', `${elsewhere} open on other pages`),
        btn('linkish', 'Show all pages', () => {
          scope = 'all';
          renderComments();
        }),
      );
      rail.append(line);
    }
    const resolved = D.threads.filter((t) => t.resolved && (scope === 'all' || t.page === D.page || !t.anchor));
    if (resolved.length) {
      const line = el('div', 'resolved');
      line.append(
        el('span', '', `${resolved.length} resolved`),
        btn('linkish', showResolved ? 'Hide' : 'Show', () => {
          showResolved = !showResolved;
          renderComments();
        }),
      );
      rail.append(line);
      if (showResolved) for (const t of resolved) rail.append(card(t));
    }
    if (D.activeThread) {
      const c = rail.querySelector(`.thr[data-thread="${CSS.escape(D.activeThread)}"]`);
      if (c) c.scrollIntoView({ block: 'nearest' });
    }
  }

  function card(t) {
    const c = el('div', 'thr' + (t.thread === D.activeThread ? ' act' : ''));
    c.dataset.thread = t.thread;
    if (scope === 'all' && t.page && t.page !== D.page) {
      const p = D.pages.find((x) => x.id === t.page);
      if (p) c.append(el('div', 'pgname', p.title));
    }
    if (t.anchor) {
      const q = el('div', 'q', `"${t.quote || ''}"`);
      q.title = 'Show the words';
      q.addEventListener('click', () => focusThread(t, true));
      c.append(q);
      if (t.detached) c.append(el('div', 'gone', 'Text removed'));
    } else c.append(el('div', 'q', 'On the whole doc'));
    for (const r of t.replies) {
      const m = el('div', 'cm1');
      const by = el('div', 'by');
      if (r.by !== 'user') by.append(el('span', 'letter', byName(r.by).slice(0, 1)));
      by.append(el('b', r.by === 'user' ? '' : 'ag', byName(r.by)), document.createTextNode(' · ' + time(r.at)));
      m.append(by, el('div', 'tx', r.text));
      c.append(m);
    }
    if (t.sent && t.sent.chat) c.append(el('div', 'donel', `Sent to ${agentName(t.sent.chat)} at ${time(t.sent.at)}`));
    if (t.resolved) {
      c.append(el('div', 'donel', `Resolved by ${byName(t.resolvedBy || 'user')}`));
      const acts = el('div', 'acts');
      acts.append(btn('btn sm thr-reopen', 'Reopen', () => commentAction('reopen', { thread: t.thread })));
      c.append(acts);
      return c;
    }
    const box = el('textarea', 'replybox');
    box.rows = 1;
    box.placeholder = 'Reply… (Ctrl+Enter)';
    box.value = drafts.get(t.thread) || '';
    box.setAttribute('aria-label', 'Reply');
    box.addEventListener('input', () => drafts.set(t.thread, box.value));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        reply(t, box.value);
      }
    });
    c.append(box);
    const acts = el('div', 'acts');
    acts.append(
      sendButton(async (chat) => {
        if (box.value.trim()) await reply(t, box.value);
        await send(t.thread, chat);
      }),
    );
    acts.append(btn('btn sm thr-reply', 'Reply', () => reply(t, box.value)));
    acts.append(btn('btn sm thr-resolve', 'Resolve', () => commentAction('resolve', { thread: t.thread })));
    c.append(acts);
    c.addEventListener('click', (e) => {
      if (e.target.closest('button, textarea')) return;
      focusThread(t, false);
    });
    return c;
  }

  /** "Send to <agent> ▾": the main part sends to the linked chat; ▾ (or no linked chat) picks one in chat.html. */
  function sendButton(go) {
    const wrap = el('span', 'sendbtn');
    const name = linkedName();
    const main = btn('send-main', name ? `Send to ${name}` : 'Send to a chat…', async () => {
      if (!D.linked) {
        const chat = await D.pickChat('send');
        if (chat) await go(chat);
        return;
      }
      await go(null);
    });
    const more = btn(
      'send-more',
      '▾',
      async () => {
        const chat = await D.pickChat('send');
        if (chat) await go(chat);
      },
      'Send to another chat',
    );
    more.setAttribute('aria-label', 'Send to another chat');
    wrap.append(main, more);
    return wrap;
  }

  async function reply(t, text) {
    const body = String(text || '').trim();
    if (!body) return;
    try {
      await D.post('/api/live/docs/comment', { action: 'reply', thread: t.thread, text: body });
      drafts.delete(t.thread);
    } catch (error) {
      D.fail(error);
    }
  }
  async function commentAction(action, args) {
    try {
      return await D.post('/api/live/docs/comment', { action, ...args });
    } catch (error) {
      D.fail(error);
      return null;
    }
  }
  /** Send a thread to the linked chat (chat null) or to a picked chat, which the doc links to from now on. */
  async function send(thread, chat) {
    try {
      if (chat) {
        await D.post('/api/live/docs/link', { id: chat });
        D.linked = chat;
      }
      const r = await D.post('/api/live/docs/comment/send', chat ? { thread, chat } : { thread });
      D.toast(`Sent to ${agentName(r.chat || chat || D.linked)}.`);
      renderComments();
    } catch (error) {
      if (error.code === 'no_chat') {
        const picked = await D.pickChat('send');
        if (picked) return send(thread, picked);
        return D.toast('This doc is not linked to a chat yet: choose the chat to send it to.');
      }
      D.fail(error);
    }
  }
  D.sendThread = send;

  function focusThread(t, jump) {
    D.activeThread = t.thread;
    if (t.page && t.page !== D.page) D.showPage(t.page);
    D.refreshMarks();
    if (panel !== 'comments') setPanel('comments');
    else renderComments();
    if (jump && D.editor && t.anchor) {
      const pos = D.editor.anchorPos(t.anchor);
      if (pos !== null) {
        const dom = D.editor.view.domAtPos(pos);
        const node = dom && dom.node && (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement);
        if (node) node.scrollIntoView({ block: 'center' });
      }
    }
  }
  D.on('open-thread', (id) => {
    const t = D.threads.find((x) => x.thread === id);
    if (t) focusThread(t, true);
  });

  // a click on commented words opens their thread
  $('docEditor').addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('.anch[data-thread]');
    if (!a) return;
    const t = D.threads.find((x) => x.thread === a.dataset.thread);
    if (t) focusThread(t, false);
  });

  // new comment on the selected words (Ctrl+Alt+M, the selection toolbar, the block menu)
  D.on('comment-key', () => {
    const range = D.editor && D.editor.selectionRange();
    if (!range) return D.toast('Select some words first, then add the comment.');
    composing = range;
    if (panel !== 'comments') setPanel('comments');
    else renderComments();
    const box = $('rail').querySelector('.composer textarea');
    if (box) box.focus();
  });

  function composer() {
    const c = el('div', 'thr act composer');
    c.append(el('div', 'q', `"${composing.text}"`));
    const by = el('div', 'cm1');
    const line = el('div', 'by');
    line.append(el('b', '', 'You'), document.createTextNode(' · new'));
    by.append(line);
    c.append(by);
    const box = el('textarea', 'replybox');
    box.rows = 2;
    box.placeholder = 'Comment… (Ctrl+Enter)';
    box.setAttribute('aria-label', 'Comment');
    const add = async () => {
      const text = box.value.trim();
      if (!text) return null;
      const r = await commentAction('add', { text, block: composing.block, from: composing.from, to: composing.to });
      if (r && r.thread) {
        composing = null;
        D.activeThread = r.thread;
        D.schedule('threads');
      }
      return r;
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        add();
      } else if (e.key === 'Escape') {
        composing = null;
        renderComments();
      }
    });
    c.append(box);
    const acts = el('div', 'acts');
    acts.append(
      sendButton(async (chat) => {
        const r = await add();
        if (r && r.thread) await send(r.thread, chat);
      }),
    );
    acts.append(btn('btn sm thr-add', 'Comment', () => add()));
    acts.append(
      btn('btn sm ghost', 'Cancel', () => {
        composing = null;
        renderComments();
      }),
    );
    c.append(acts);
    requestAnimationFrame(() => box.focus());
    return c;
  }

  // margin counts below 1100 px: one small count per block with open threads; a click opens the panel on them
  let marginFrame = 0;
  function renderMarginCounts() {
    if (marginFrame) return;
    marginFrame = requestAnimationFrame(() => {
      marginFrame = 0;
      const col = $('pageCol');
      col.querySelectorAll('.cmark').forEach((x) => x.remove());
      if ($('docApp').classList.contains('wide-rail') || !D.editor || D.editor.destroyed || !$('docReadOnly').hidden)
        return;
      const by = new Map();
      for (const t of D.threads) {
        if (t.resolved || t.page !== D.page || !t.anchor) continue;
        const pos = D.editor.anchorPos(t.anchor);
        if (pos === null) continue;
        const top = D.editor.topBlockAt(pos);
        if (!by.has(top.pos)) by.set(top.pos, []);
        by.get(top.pos).push(t);
      }
      const c = col.getBoundingClientRect();
      for (const [pos, list] of by) {
        const dom = D.editor.view.nodeDOM(pos);
        if (!dom || !dom.getBoundingClientRect) continue;
        const r = dom.getBoundingClientRect();
        const mark = btn(
          'cmark',
          null,
          () => focusThread(list[0], false),
          `${list.length} comment${list.length === 1 ? '' : 's'}`,
        );
        mark.append(icon('comment'), document.createTextNode(String(list.length)));
        mark.style.top = Math.round(r.top - c.top + col.scrollTop) + 'px';
        mark.style.left = Math.round(Math.min(r.right - c.left + 8, col.clientWidth - 40)) + 'px';
        col.append(mark);
      }
    });
  }
  D.on('tx', (tr) => tr.docChanged && renderMarginCounts());

  // ---------------------------------------------------------------------------------------------------------------------------
  // History

  let versions = [];
  let historyPage = 'all';
  let viewing = null; // {n, version, data, compare}

  async function loadHistory() {
    try {
      const r = await D.get('/api/live/docs/history');
      versions = Array.isArray(r.versions) ? r.versions : [];
    } catch (error) {
      versions = [];
      D.fail(error);
    }
  }
  D.on('history', async () => {
    if (panel !== 'history') return;
    await loadHistory();
    renderHistoryList();
  });

  async function renderHistory() {
    const rail = $('rail');
    rail.replaceChildren();
    if (historyPage !== 'all' && !D.pages.some((p) => p.id === historyPage)) historyPage = 'all';
    const sel = scopePicker(
      'Which pages',
      [['all', 'All pages'], ...D.pages.map((p) => [p.id, p.title])],
      historyPage,
      (v) => {
        historyPage = v;
        renderHistory();
      },
    );
    const head = railHead('History');
    head.append(sel, closeBtn());
    const list = el('div', 'hlist');
    list.id = 'historyList';
    list.append(el('div', 'rail-empty', 'Loading…'));
    rail.append(head, list);
    await loadHistory();
    renderHistoryList();
  }

  /** "Created by Claude Code" / "Created by you" for the first version, "Edited by …" for the others (the server records who made the doc; with no record: just "Created"). */
  function versionWords(v) {
    const extra = String(v.note || '').replace(/^rev \d+;?\s*/, '').trim();
    const real = (v.authors || []).filter((n) => n && n !== 'AIB');
    const created = extra === 'created';
    // a doc with no recorded creator says just "Created": never a guess
    if (created && !real.length) return [document.createTextNode('Created')];
    const names = real.length ? real : ['AIB'];
    const out = [document.createTextNode(created ? 'Created by ' : 'Edited by ')];
    names.forEach((n, i) => {
      if (i) out.push(document.createTextNode(', '));
      out.push(n === 'You' ? document.createTextNode('you') : el('b', '', n));
    });
    if (extra && !created) out.push(document.createTextNode(' · ' + extra));
    return out;
  }
  D.versionWords = versionWords;

  function renderHistoryList() {
    const list = $('historyList');
    if (!list) return;
    list.replaceChildren();
    const shown = versions.filter((v) => historyPage === 'all' || (v.pages || []).some((p) => p.id === historyPage));
    if (!shown.length)
      list.append(
        el('div', 'rail-empty', 'No versions yet. AIB saves one at the end of every agent turn and as you write.'),
      );
    let lastDay = '';
    for (const v of shown) {
      const d = day(v.at);
      if (d !== lastDay) {
        list.append(el('div', 'hday', d));
        lastDay = d;
      }
      const row = el('button', 'hv' + (viewing && viewing.n === v.n ? ' on' : ''));
      row.type = 'button';
      row.dataset.version = String(v.n);
      row.append(el('span', 'v', `v${v.n}`));
      const w = el('span', 'w');
      w.append(...versionWords(v));
      row.append(w);
      const pages = (v.pages || []).map(
        (p) => p.title + (p.change === 'deleted' ? ' (deleted)' : p.change === 'added' ? ' (added)' : ''),
      );
      row.append(el('span', 'd', [time(v.at), pages.length ? pages.join(', ') : null].filter(Boolean).join(' · ')));
      row.addEventListener('click', () => openVersion(v));
      list.append(row);
    }
  }

  async function openVersion(v) {
    let data;
    try {
      data = await D.get('/api/live/docs/history/version', { n: String(v.n) });
    } catch (error) {
      return D.fail(error);
    }
    viewing = { n: v.n, version: v, data, compare: false };
    showVersion();
    renderHistoryList();
  }
  D.openVersion = openVersion;

  function showVersion() {
    const v = viewing;
    const banner = $('docBanner');
    banner.className = 'doc-banner old';
    banner.hidden = false;
    banner.replaceChildren();
    const who = (v.version.authors || []).join(', ') || 'AIB';
    const label = el('span');
    label.append(el('b', '', `v${v.n}`), document.createTextNode(`, ${who} at ${time(v.version.at)} · read only`));
    banner.append(label, el('span', 'sp'));
    if (!v.compare)
      banner.append(btn('btn sm acc ver-compare', 'Compare with now', () => ((viewing.compare = true), showVersion())));
    else banner.append(btn('btn sm acc ver-plain', 'Show v' + v.n, () => ((viewing.compare = false), showVersion())));
    banner.append(btn('btn sm pri ver-restore', `Restore v${v.n}`, () => confirmRestore()));
    banner.append(btn('btn sm ghost ver-back', 'Back to now', () => leaveVersion()));
    const ro = $('docReadOnly');
    ro.replaceChildren();
    ro.hidden = false;
    $('docEditor').hidden = true;
    $('blockHandles').hidden = true;
    $('docApp').classList.add('viewing-version');
    if (v.compare) renderCompare(ro, v);
    else {
      const page = v.data.pages.find((p) => p.id === D.page) || v.data.pages[0];
      if (page && page.id !== D.page) ro.append(el('div', 'rd-pg', page.title));
      if (page) E().renderNodes(page.nodes, ro);
      if (!page || !page.nodes.length) ro.append(el('p', 'rd-same', 'This page was empty in this version.'));
    }
    D.renderPages && D.renderPages();
  }

  function leaveVersion() {
    if (!viewing && $('docReadOnly').hidden) return;
    viewing = null;
    $('docReadOnly').hidden = true;
    $('docReadOnly').replaceChildren();
    $('docEditor').hidden = false;
    $('docApp').classList.remove('viewing-version');
    const banner = $('docBanner');
    if (banner.classList.contains('old')) {
      banner.hidden = true;
      banner.className = 'doc-banner';
      banner.replaceChildren();
    }
    renderHistoryList();
  }
  D.leaveVersion = leaveVersion;

  // ---- Compare: the doc as it reads, with the changes marked ----

  const words = (s) =>
    String(s || '')
      .split(/(\s+)/)
      .filter((x) => x !== '');
  function lcs(a, b, eq) {
    const n = a.length,
      m = b.length;
    if (n * m > 4_000_000) return null;
    const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i][j] = eq(a[i], b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const out = [];
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) out.push(['=', a[i++], b[j++]]);
      else if (t[i + 1][j] >= t[i][j + 1]) out.push(['-', a[i++], null]);
      else out.push(['+', null, b[j++]]);
    }
    while (i < n) out.push(['-', a[i++], null]);
    while (j < m) out.push(['+', null, b[j++]]);
    return out;
  }
  function textOf(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak') return '\n';
    return (node.content || []).map(textOf).join(node.type === 'paragraph' || node.type === 'heading' ? '' : ' ');
  }
  /** Word diff of two texts: spans (same / ins / delt) and the counts. */
  function wordDiff(a, b, into, counts) {
    const ops = lcs(words(a), words(b), (x, y) => x === y) || [
      ['-', a, null],
      ['+', null, b],
    ];
    for (const [op, x, y] of ops) {
      if (op === '=') into.append(document.createTextNode(x));
      else if (op === '-') {
        into.append(el('span', 'delt', x));
        if (/\S/.test(x)) counts.del++;
      } else {
        into.append(el('span', 'ins', y));
        if (/\S/.test(y)) counts.add++;
      }
    }
  }
  const countWords = (s) => words(s).filter((w) => /\S/.test(w)).length;
  const TEXTUAL = new Set(['paragraph', 'heading', 'codeBlock']);

  function diffPage(before, after, counts) {
    const key = (n) => JSON.stringify(n);
    const ops = lcs(before, after, (x, y) => key(x) === key(y)) || [
      ...before.map((x) => ['-', x, null]),
      ...after.map((y) => ['+', null, y]),
    ];
    // pair a removed block with the added block right after it when both are text blocks of one type: a word diff
    const out = [];
    for (let k = 0; k < ops.length; k++) {
      const [op, x] = ops[k];
      if (op === '-' && ops[k + 1] && ops[k + 1][0] === '+' && x.type === ops[k + 1][2].type && TEXTUAL.has(x.type)) {
        out.push(['~', x, ops[k + 1][2]]);
        k++;
      } else out.push(ops[k]);
    }
    return out;
  }

  function renderCompare(host, v) {
    const now = D.session.pagesJSON();
    const then = v.data.pages;
    const counts = { add: 0, del: 0 };
    const body = el('div', 'rdiff');
    const unchanged = [];
    let changed = 0;
    const ids = [...new Set([...then.map((p) => p.id), ...now.map((p) => p.id)])];
    const order = now.map((p) => p.id).concat(then.map((p) => p.id).filter((id) => !now.some((p) => p.id === id)));
    for (const id of order.filter((x) => ids.includes(x))) {
      const a = then.find((p) => p.id === id),
        b = now.find((p) => p.id === id);
      const before = a ? a.nodes : [],
        after = b ? b.nodes : [];
      const title = (b || a).title;
      if (JSON.stringify(before) === JSON.stringify(after) && a && b && a.title === b.title) {
        unchanged.push(title);
        continue;
      }
      changed++;
      const head = el(
        'div',
        'rd-pg',
        title + (!a ? ' (added)' : !b ? ' (deleted)' : a.title !== b.title ? ` (was ${a.title})` : ''),
      );
      head.dataset.page = id;
      body.append(head);
      const ops = diffPage(before, after, counts);
      let run = [];
      const flushSame = () => {
        if (!run.length) return;
        const nodes = run;
        run = [];
        if (nodes.length <= 1) return void E().renderNodes(nodes, body);
        const fold = el('p', 'rd-same');
        fold.append(document.createTextNode(`${nodes.length} unchanged blocks folded · `));
        const show = btn('linkish', 'show', () => {
          const box = el('div');
          E().renderNodes(nodes, box);
          fold.replaceWith(...box.childNodes);
        });
        fold.append(show);
        body.append(fold);
      };
      for (const [op, x, y] of ops) {
        if (op === '=') {
          run.push(x);
          continue;
        }
        flushSame();
        if (op === '~') {
          const shell = el('div');
          E().renderNodes([{ type: y.type, attrs: y.attrs }], shell);
          const block = shell.firstElementChild || el('p');
          block.replaceChildren();
          wordDiff(textOf(x), textOf(y), block, counts);
          body.append(block);
        } else if (op === '-') {
          const bar = el('div', 'rd-del');
          E().renderNodes([x], bar);
          counts.del += countWords(textOf(x));
          body.append(bar);
        } else {
          const bar = el('div', 'rd-add');
          E().renderNodes([y], bar);
          counts.add += countWords(textOf(y));
          body.append(bar);
        }
      }
      flushSame();
    }
    const head = el('div', 'diffhead');
    head.append(
      el('span', '', `v${v.n} → now · ${changed} page${changed === 1 ? '' : 's'} changed`),
      el('span', 'add', `+${counts.add} words`),
      el('span', 'del', `−${counts.del} words`),
    );
    head.append(el('span', 'sp'));
    if (unchanged.length) head.append(el('span', 'rd-same', `${unchanged.join(', ')}: no changes`));
    host.append(head);
    if (!changed) host.append(el('p', 'rd-same', 'No differences: the doc reads the same as this version.'));
    host.append(body);
  }
  D.renderCompare = renderCompare;

  // ---- Restore ----

  function confirmRestore() {
    const v = viewing;
    if (!v) return;
    const host = $('docReadOnly');
    host.querySelectorAll('.confirm').forEach((x) => x.remove());
    const box = el('div', 'confirm');
    const startedAt = D.changeCount;
    const pages = D.pages.length;
    const p = el('p');
    p.append(
      el('b', '', `Restore v${v.n}?`),
      document.createTextNode(
        ` The whole doc, all ${pages} page${pages === 1 ? '' : 's'}, goes back to how it was at ${time(v.version.at)}, saved as a new version. Later versions stay in History.`,
      ),
    );
    const row = el('div', 'row');
    const page = D.pages.find((x) => x.id === D.page);
    const inVersion = v.data.pages.some((x) => x.id === D.page);
    const go = (pageId) => async () => {
      if (D.changeCount !== startedAt) {
        p.replaceChildren(document.createTextNode('The doc changed since you opened this. Compare again?'));
        row.replaceChildren(
          btn('btn sm acc', 'Compare again', () => ((viewing.compare = true), showVersion())),
          btn('btn sm ghost', 'Cancel', () => box.remove()),
        );
        return;
      }
      await restore(v.n, pageId, p);
    };
    row.append(btn('btn sm pri restore-all', 'Restore whole doc', go(null)));
    if (page && inVersion) row.append(btn('btn sm restore-page', `Restore only ${page.title}`, go(page.id)));
    row.append(btn('btn sm ghost', 'Cancel', () => box.remove()));
    box.append(p, row);
    host.prepend(box);
    box.scrollIntoView({ block: 'nearest' });
  }
  D.confirmRestore = confirmRestore;

  async function restore(n, page, say) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { client, clock } = D.session.clock();
      try {
        const body = { version: n, client, clock };
        if (page) body.page = page;
        await D.post('/api/live/docs/history/restore', body);
        leaveVersion();
        D.toast(
          page
            ? `Restored ${(D.pages.find((p) => p.id === page) || {}).title || 'the page'} from v${n}.`
            : `Restored v${n}, saved as a new version.`,
        );
        await loadHistory();
        renderHistoryList();
        return true;
      } catch (error) {
        if (error.code === 'in_flight' && attempt < 5) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        say.replaceChildren(document.createTextNode(error.message));
        say.classList.add('bad');
        return false;
      }
    }
    return false;
  }
  D.restore = restore;

  // ---------------------------------------------------------------------------------------------------------------------------
  // The ⋯ menu: export, duplicate, show in Files, trash

  $('btnMore').addEventListener('click', () => {
    const more = $('btnMore');
    const page = D.pages.find((p) => p.id === D.page);
    D.menu(
      more,
      [
        { head: 'Export Markdown' },
        {
          label: 'This page',
          small: page ? `${page.title}: plain text. Colours drop out, columns stack, charts become a table.` : '',
          data: { export: 'page' },
          run: () => exportMd('page'),
        },
        {
          label: 'All pages',
          small: 'Each page under its name as a heading',
          data: { export: 'all' },
          run: () => exportMd('all'),
        },
        { sep: true },
        { label: 'Duplicate doc', data: { act: 'duplicate' }, run: () => duplicateDoc() },
        {
          label: 'Show in the Docs tab',
          data: { act: 'files' },
          run: () => D.tell({ type: 'aib-doc:show-in-files', dir: D.info && D.info.dir }),
        },
        { sep: true },
        { label: 'Move doc to trash…', danger: true, data: { act: 'trash' }, run: () => askTrash(more) },
      ],
      { cls: 'more-menu' },
    );
  });

  async function exportMd(scopeName) {
    try {
      const body = { scope: scopeName };
      if (scopeName === 'page') body.page = D.page;
      const r = await D.post('/api/live/docs/export', body);
      D.lastExport = r;
      D.toast(`Saved ${r.name} in Downloads`, [{ label: 'Show in folder', run: () => reveal(r.path) }], { ms: 10000 });
      return r;
    } catch (error) {
      D.fail(error);
      return null;
    }
  }
  D.exportMd = exportMd;

  async function reveal(path) {
    try {
      await D.post('/api/live/docs/reveal', { path });
    } catch (error) {
      D.fail(error.status === 404 ? 'Showing the file in its folder is not available here.' : error);
    }
  }

  async function duplicateDoc() {
    try {
      const r = await D.post('/api/live/docs/duplicate', { id: D.params.get('chat') || '' });
      D.tell({ type: 'aib-doc:docs-changed' });
      D.toast(
        `Made ${r.title}.`,
        [{ label: 'Open it', run: () => D.tell({ type: 'aib-doc:open', name: r.name, where: 'tab' }) }],
        { ms: 10000 },
      );
    } catch (error) {
      D.fail(error.status === 404 ? 'Duplicate doc is not available in this build.' : error);
    }
  }
  function askTrash(anchor) {
    const title = (D.info && (D.info.title || D.info.name)) || 'this doc';
    D.confirm(
      anchor,
      [
        el('b', '', `Move "${title}" to the trash?`),
        ` All ${D.pages.length} page${D.pages.length === 1 ? '' : 's'} go with it. History is kept for 30 days.`,
      ],
      [
        {
          label: 'Move to trash',
          cls: 'dng',
          run: async () => {
            try {
              await D.post('/api/live/docs/trash', {});
              D.tell({ type: 'aib-doc:closed' });
            } catch (error) {
              D.fail(error.status === 404 ? 'Moving a doc to the trash is not available in this build.' : error);
            }
          },
        },
        { label: 'Cancel' },
      ],
    );
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // A drawing full screen (its server-made picture; editing is not on the doc page in v1)

  D.on('drawing', async (attrs) => {
    const src = await D.fileUrl(attrs.src || (attrs.drawing ? 'assets/' + attrs.drawing + '.excalidraw.svg' : ''));
    const box = el('div', 'drw-full');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', attrs.caption || 'Drawing');
    const head = el('div', 'fs-head');
    head.append(icon('drawing'), el('b', '', attrs.caption || 'Drawing'));
    const page = D.pages.find((p) => p.id === D.page);
    head.append(
      el('span', 'rd-same', `in ${(D.info && D.info.title) || ''}${page ? ' › ' + page.title : ''}`),
      el('span', 'sp'),
    );
    const close = btn('btn sm', 'Exit full screen', () => box.remove());
    head.append(close);
    const body = el('div', 'fs-body');
    if (src) {
      const img = el('img');
      img.src = src;
      img.alt = attrs.caption || 'Drawing';
      body.append(img);
    } else body.append(el('p', 'rd-same', 'No picture of this drawing yet.'));
    box.append(head, body);
    box.addEventListener('keydown', (e) => e.key === 'Escape' && box.remove());
    $('docLayer').append(box);
    close.focus();
  });
})();
