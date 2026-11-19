(function (root) {
  'use strict';
  // Local docs, the ways in from outside the doc page (the doc page itself is doc.html): the project's doc list (GET
  // /api/live/docs/list), opening a doc (files-ui.js owns the tabs and frames), the chat's DOC tool rows, the doc-created card, page
  // link chips (aib-doc://<doc>/<page id>, resolved by page id at click), `/doc <name>[ > page][: brief]` with its completion list,
  // Ctrl+K hits, and the Artifacts picker's doc rows. The pure part at the top has Node tests (work/test_doc_links.js).
  // Doc titles and page titles come from disk and agents: text only, never HTML. The user never sees docs/ paths or file names.

  // ---- pure ----------------------------------------------------------------------------------------------------------------
  const norm = (s) =>
    String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  // How well `text` matches what was typed (0 = not at all): whole, start, a word's start, inside, then letters in order.
  function looseScore(text, q) {
    const t = norm(text),
      n = norm(q);
    if (!n) return 1;
    if (!t) return 0;
    if (t === n) return 100;
    if (t.startsWith(n)) return 80;
    if (t.split(/[\s\-_.]+/).some((w) => w.startsWith(n))) return 60;
    if (t.includes(n)) return 40;
    let i = 0;
    for (const ch of t) if (ch === n[i]) i++;
    return i === n.length && n.length >= 2 ? 10 : 0;
  }
  const best = (items, score) => {
    let hit = null,
      top = 0;
    for (const it of items || []) {
      const s = score(it);
      if (s > top) {
        top = s;
        hit = it;
      }
    }
    return hit;
  };
  // The doc a name points at: its folder name or its title, loosely ("release" finds "Release plan").
  const matchDoc = (docs, q) => (norm(q) ? best(docs, (d) => Math.max(looseScore(d.title, q), looseScore(d.name, q))) : null);
  // A page by its title, loosely ("risk" finds "Risks").
  const matchPage = (pages, q) => (norm(q) ? best(pages, (p) => looseScore(p.title, q)) : null);
  const exactPage = (pages, q) => (pages || []).find((p) => norm(p.title) === norm(q)) || null;

  // "/doc release plan > risks: add the iOS 17 fix date" -> {name, page, brief}; page null without ">", brief '' without ":".
  // Doc names never hold ">" or ":" (store.ts NAME), so the first of each splits.
  function parseDocCommand(text) {
    const m = /^\/doc(?:\s+([\s\S]*))?$/.exec(String(text == null ? '' : text).trim());
    if (!m) return null;
    let rest = m[1] || '',
      brief = '';
    const colon = rest.indexOf(':');
    if (colon >= 0) {
      brief = rest.slice(colon + 1).trim();
      rest = rest.slice(0, colon);
    }
    const gt = rest.indexOf('>');
    let name = rest,
      page = null;
    if (gt >= 0) {
      name = rest.slice(0, gt);
      page = rest.slice(gt + 1).trim() || null;
    }
    return { name: name.trim().replace(/\s+/g, ' '), page, brief };
  }
  const isDocCommand = (text) => /^\/doc(?:\s|$)/.test(String(text == null ? '' : text).trim());
  // A new doc's title from what was typed: "release notes" -> "Release notes".
  const titleFromTyped = (s) => {
    const t = String(s || '')
      .trim()
      .replace(/\s+/g, ' ');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  };
  // What /doc's completion list shows for the text so far: the docs while the name is typed, that doc's pages after ">".
  // Returns null (no list) or {kind: 'doc'|'page', typed, start, items: [{id?, title, sub}], create?}.
  function completions(text, docs) {
    const s = String(text == null ? '' : text);
    let m = /^\/doc\s+([^>:]*?)\s*>\s*([^:>]*)$/.exec(s);
    if (m) {
      const doc = matchDoc(docs, m[1]);
      if (!doc) return null;
      const typed = m[2],
        pages = doc.pageList || [];
      const items = pages
        .map((p) => ({ p, s: looseScore(p.title, typed) }))
        .filter((x) => x.s >= (norm(typed) ? 40 : 1))
        .sort((a, b) => b.s - a.s)
        .map((x) => ({ id: x.p.id, title: x.p.title, sub: '' }));
      const create = typed.trim() && !exactPage(pages, typed) ? titleFromTyped(typed) : '';
      return { kind: 'page', doc, typed, start: s.length - typed.length, items, create };
    }
    m = /^\/doc\s+([^>:]*)$/.exec(s);
    if (m) {
      const typed = m[1];
      const items = (docs || [])
        .map((d) => ({ d, s: Math.max(looseScore(d.title, typed), looseScore(d.name, typed)) }))
        .filter((x) => x.s >= (norm(typed) ? 40 : 1))
        .sort((a, b) => b.s - a.s)
        .slice(0, 8)
        .map((x) => ({ name: x.d.name, title: x.d.title, sub: pagesText(x.d.pages) }));
      const create = typed.trim() && !(docs || []).some((d) => norm(d.title) === norm(typed) || norm(d.name) === norm(typed));
      return { kind: 'doc', typed, start: s.length - typed.length, items, create: create ? titleFromTyped(typed) : '' };
    }
    return null;
  }
  // Tab on a completion row: the text with that doc or page filled in.
  function complete(text, c, item) {
    const s = String(text || '');
    if (!c || !item) return s;
    if (c.kind === 'doc') return s.slice(0, c.start) + item.title + ' ';
    return s.slice(0, c.start).replace(/>\s*$/, '> ') + item.title;
  }
  const pagesText = (n) => {
    const k = Math.max(1, Number(n) || 1);
    return k + (k === 1 ? ' page' : ' pages');
  };

  // aib-doc://<doc name>[/<page id>] (markdown.js turns such a link into a chip).
  function parseDocHref(href) {
    const m = /^aib-doc:\/\/([^/?#\s]+)(?:\/([^/?#\s]+))?\/?$/i.exec(String(href || '').trim());
    if (!m) return null;
    try {
      return { name: decodeURIComponent(m[1]), page: m[2] ? decodeURIComponent(m[2]) : '' };
    } catch (e) {
      return null;
    }
  }
  // The doc tab's address (the doc-tab contract, section 1).
  function docUrl(o) {
    const p = new URLSearchParams();
    p.set('chat', o.chat || '');
    if (o.project) p.set('project', o.project);
    p.set('name', o.name || '');
    if (o.page) p.set('page', o.page);
    if (o.block) p.set('block', o.block);
    if (o.thread) p.set('thread', o.thread);
    if (o.isNew) p.set('new', '1');
    if (o.preview) p.set('preview', '1');
    if (o.where) p.set('where', o.where);
    return '/doc.html?' + p.toString();
  }
  const docOf = (docs, name) =>
    (docs || []).find((d) => d.name === name) || (docs || []).find((d) => norm(d.title) === norm(name)) || null;
  // A chip at click time: {state: 'ok'|'deleted'|'nodoc', doc, page}. The page is found by its id, so a renamed page still opens;
  // a page that is gone is "deleted page".
  function resolveChip(docs, name, pageId) {
    const doc = docOf(docs, name);
    if (!doc) return { state: 'nodoc', doc: null, page: null };
    if (!pageId) return { state: 'ok', doc, page: null };
    const page = (doc.pageList || []).find((p) => p.id === pageId) || null;
    return page ? { state: 'ok', doc, page } : { state: 'deleted', doc, page: null };
  }
  const chipLabel = (doc, page) => (doc ? doc.title + (page ? ' › ' + page.title : '') : '');
  // Ctrl+K: docs and pages that match. [{kind:'doc', doc, score} | {kind:'page', doc, page, score}], best first.
  function searchDocs(docs, q, max) {
    const out = [];
    if (norm(q).length < 2) return out;
    for (const d of docs || []) {
      const s = Math.max(looseScore(d.title, q), looseScore(d.name, q));
      if (s >= 40) out.push({ kind: 'doc', doc: d, score: s + 1 });
      for (const p of d.pageList || []) {
        const ps = looseScore(p.title, q);
        if (ps >= 40) out.push({ kind: 'page', doc: d, page: p, score: ps });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, max || 8);
  }
  // Every path a doc owns (doc.aibdoc, its copies, its assets), for hiding them in search and Changes lists.
  function ownedSet(docs) {
    const out = new Set();
    for (const d of docs || []) for (const p of d.owned || []) out.add(String(p).replace(/\\/g, '/'));
    return out;
  }

  // ---- doc tool rows ---------------------------------------------------------------------------------------------------------
  const DOC_TOOL = /(?:^|__|[^a-z_])((?:doc|drawing)_[a-z_]+)$/i;
  const asObj = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try {
        const o = JSON.parse(v);
        return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  };
  function toolNameOf(row) {
    const names = [];
    if (row && row.raw) {
      const r = row.raw,
        m = r._meta && r._meta.claudeCode;
      names.push(m && m.toolName, r.toolName, r.name, r.title);
    } else if (row && row.call) names.push(row.call.name, row.call.title);
    for (const n of names) {
      const m = typeof n === 'string' ? DOC_TOOL.exec(n.trim()) : null;
      if (m) return m[1].toLowerCase();
    }
    return '';
  }
  // The JSON a finished call answered with (plain, or as MCP text content), or null.
  function resultOf(row) {
    const texts = [];
    const take = (v) => {
      if (v == null) return;
      if (typeof v === 'string') texts.push(v);
      else if (Array.isArray(v)) v.forEach(take);
      else if (typeof v === 'object') {
        if (typeof v.text === 'string') texts.push(v.text);
        if (v.content !== undefined) take(v.content);
        if (v.structuredContent && typeof v.structuredContent === 'object') texts.unshift(JSON.stringify(v.structuredContent));
        if (v.doc || v.ok !== undefined) texts.unshift(JSON.stringify(v));
      }
    };
    if (row && row.raw) {
      take(row.raw.rawOutput);
      take(row.raw.content);
    } else if (row && row.call && row.call.result) take(row.call.result.text !== undefined ? row.call.result.text : row.call.result);
    for (const t of texts) {
      const s = String(t),
        a = s.indexOf('{'),
        b = s.lastIndexOf('}');
      for (const c of [s, a >= 0 && b > a ? s.slice(a, b + 1) : '']) {
        if (!c) continue;
        try {
          const o = JSON.parse(c);
          if (o && typeof o === 'object' && !Array.isArray(o)) return o.result && typeof o.result === 'object' ? o.result : o;
        } catch (e) {
          /* not JSON */
        }
      }
    }
    return null;
  }
  // A doc tool row -> {tool, input, result, status, doc (name), page (id or title)}; null for any other row.
  function toolCall(row) {
    const tool = toolNameOf(row);
    if (!tool) return null;
    const input = (row.raw ? asObj(row.raw.rawInput) : asObj(row.call && row.call.input)) || {};
    const result = resultOf(row);
    const raw = row.raw,
      status = raw
        ? { pending: 'pending', in_progress: 'running', completed: 'ok', failed: 'failed' }[raw.status] || ''
        : row.call && row.call.result
          ? row.call.result.isError
            ? 'failed'
            : 'ok'
          : '';
    const failed = status === 'failed' || (result && result.ok === false && !!result.code);
    const doc = String((result && typeof result.doc === 'string' && result.doc) || (typeof input.doc === 'string' ? input.doc : '') || '');
    const page = String((result && typeof result.page === 'string' && result.page) || (typeof input.page === 'string' ? input.page : '') || '');
    return { tool, input, result, status: failed ? 'failed' : status, doc, page };
  }
  const pageTitle = (doc, ref, result) => {
    if (!ref) return '';
    const pages = (result && Array.isArray(result.pages) ? result.pages : null) || (doc && doc.pageList) || [];
    const hit = pages.find((p) => p && p.id === ref) || pages.find((p) => p && norm(p.title) === norm(ref));
    return hit ? hit.title : /^[a-z0-9]{6,}$/i.test(ref) && pages.length ? '' : ref;
  };
  // The doc's title from a tool call that is not in the doc list (yet): the title the tool result names, else the typed name.
  const resultTitle = (call) => (call && call.result && typeof call.result.docTitle === 'string' ? call.result.docTitle : '');
  // The row's words: "Created Release plan · 4 pages", "Wrote Risks in Release plan", "Added page Metrics to Release plan"…
  function toolText(call, docs) {
    if (!call) return '';
    const doc = docOf(docs, call.doc),
      res = call.result || {},
      title = (doc && doc.title) || resultTitle(call) || (typeof res.title === 'string' && call.tool === 'doc_create' ? res.title : '') || call.doc || 'a doc',
      page = pageTitle(doc, call.page, res),
      inp = call.input || {};
    const inDoc = (verb) => verb + (page ? ' ' + page + ' in ' : ' ') + title;
    switch (call.tool) {
      case 'doc_list':
        return 'Listed the docs';
      case 'doc_create': {
        const n = Array.isArray(res.pages) ? res.pages.length : doc ? doc.pages : 1;
        return 'Created ' + (doc ? doc.title : resultTitle(call) || titleFromTyped(call.doc) || 'a doc') + ' · ' + pagesText(n);
      }
      case 'doc_read':
      case 'doc_changes':
        return 'Read ' + (page ? page + ' in ' : '') + title;
      case 'doc_edit':
        return inDoc('Wrote');
      case 'doc_claim':
        return inDoc('Rewriting');
      case 'doc_undo':
        return 'Undid its last edit in ' + title;
      case 'doc_page': {
        const a = String(inp.action || ''),
          t = String(inp.title || res.title || page || '');
        if (a === 'add') return 'Added page ' + t + ' to ' + title;
        if (a === 'rename') return 'Renamed a page to ' + t + ' in ' + title;
        if (a === 'move') return 'Moved page ' + (page || t) + ' in ' + title;
        if (a === 'delete') return 'Asked to delete page ' + (page || t) + ' in ' + title;
        return 'Changed the pages of ' + title;
      }
      case 'doc_comments':
        return 'Read the comments in ' + title;
      case 'doc_comment':
        return 'Commented in ' + title;
      case 'doc_reply':
        return 'Replied to a comment in ' + title;
      case 'doc_resolve':
        return 'Resolved a comment in ' + title;
      case 'doc_history':
        return 'Looked at the history of ' + title;
      case 'doc_restore':
        return 'Restored a version of ' + title;
      default:
        return call.tool.indexOf('drawing_') === 0 ? 'Drew in ' + title : 'Worked in ' + title;
    }
  }
  // The page the row's "open ↗" lands on (an id when known).
  const toolPage = (call, docs) => {
    if (!call || !call.page) return '';
    const doc = docOf(docs, call.doc),
      pages = (call.result && Array.isArray(call.result.pages) ? call.result.pages : null) || (doc && doc.pageList) || [];
    const hit = pages.find((p) => p && p.id === call.page) || pages.find((p) => p && norm(p.title) === norm(call.page));
    return hit ? hit.id : '';
  };

  const pure = {
    norm,
    looseScore,
    matchDoc,
    matchPage,
    parseDocCommand,
    isDocCommand,
    titleFromTyped,
    completions,
    complete,
    pagesText,
    parseDocHref,
    docUrl,
    docOf,
    resolveChip,
    chipLabel,
    searchDocs,
    ownedSet,
    toolCall,
    toolText,
    toolPage,
  };

  // ---- page part -----------------------------------------------------------------------------------------------------------
  let host = null;
  const doc = () => root.document;
  const FU = () => root.AgentFilesUI;
  const el = (tag, text, cls) => {
    const n = doc().createElement(tag);
    if (text != null && text !== '') n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  };
  const btn = (text, cls, title) => {
    const b = el('button', text, cls);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  };

  // The doc lists, per chat id + folder ('main': the project's main checkout, where docs live; 'chat': a worktree chat's copy).
  const lists = new Map(); // key -> {at, docs, promise}
  const TTL = 15000;
  function listFor(id, rootName, force) {
    if (!host || !id) return Promise.resolve([]);
    const k = id + '|' + (rootName || 'main'),
      hit = lists.get(k);
    if (hit && !force && (hit.promise || Date.now() - hit.at < TTL)) return hit.promise || Promise.resolve(hit.docs);
    const rec = { at: Date.now(), docs: hit ? hit.docs : null, promise: null };
    rec.promise = Promise.resolve(host.getJson('/api/live/docs/list', { id, root: rootName || 'main' })).then(
      (r) => {
        rec.docs = (r && Array.isArray(r.docs) ? r.docs : []).filter((d) => d && d.name && !d.legacy);
        rec.at = Date.now();
        rec.promise = null;
        for (const fn of listeners) fn(k);
        return rec.docs;
      },
      () => {
        rec.promise = null;
        rec.at = Date.now();
        rec.docs = rec.docs || [];
        return rec.docs;
      },
    );
    lists.set(k, rec);
    while (lists.size > 40) lists.delete(lists.keys().next().value);
    return rec.promise;
  }
  // What is known now, without waiting (null when never asked).
  const cached = (id, rootName) => {
    const hit = lists.get(id + '|' + (rootName || 'main'));
    return hit ? hit.docs : null;
  };
  const listeners = new Set();
  const forget = () => lists.clear();

  // The chat a node in the stream belongs to (a split pane's own chat, else the open one): {id, key, ...} from files-ui.
  const chatOf = (node) => (FU() && FU().chatOfNode ? FU().chatOfNode(node) : null);
  const openChat = () => (FU() && FU().currentChat ? FU().currentChat() : null);

  // Open a doc. A doc ALWAYS opens in the right column's Docs tab (owner decision 2a, 2026-11-18), whether it comes from Files,
  // Ctrl+K, "+ New doc" or a card, link or row in a chat reply. where: 'tab' is the one way to a middle tab (the Docs tab's ⤢, a
  // restored tab). background: an agent made the doc: the Docs list marks it new, nothing opens.
  const DU = () => root.AgentDocsTabUI;
  function openDoc(o) {
    const U = FU();
    if (!o || !o.name) return false;
    const c = o.chat || openChat();
    if (!c || !c.id) return false;
    const d = { name: o.name, title: o.title || o.name, page: o.page || '', block: o.block || '', thread: o.thread || '' };
    // popped out into its own window: bring that window forward (a chip, a card, Ctrl+K), never a second copy here
    const WS = root.AgentWorkspaceUI;
    const pk = WS && WS.currentProject ? WS.currentProject() : '';
    if (!o.background && pk && focusPopout(pk, o.name)) return true;
    const T = DU();
    if (o.where !== 'tab' && T && T.open && T.open(d, { background: !!o.background })) return true;
    if (o.background) return false;
    if (!U || !U.openDoc) return false;
    U.openDoc(o.scope || { id: c.id, root: 'main', label: 'Folder', branch: '', chatKey: c.key || '', title: c.title || '' }, {
      name: o.name,
      title: o.title || o.name,
      page: o.page || '',
      block: o.block || '',
      thread: o.thread || '',
      dir: o.dir || '',
      where: 'tab',
      preview: !!o.preview,
    });
    return true;
  }
  // "+ New doc": make an empty doc linked to the chat (POST /api/live/docs/open with create). Resolves {name, title, ...}.
  function createDoc(chatId, name) {
    if (!host || !host.post) return Promise.reject(new Error('not ready'));
    return Promise.resolve(host.post('docs/open', { id: chatId, name, create: '' }));
  }

  // ---- chips -------------------------------------------------------------------------------------------------------------------
  // markdown.js makes <a class="doc-chip" data-doc-name data-doc-page> from aib-doc:// links. decorate() puts the doc's current
  // titles on them ("Release plan › Risks"), or "deleted page" when the page is gone.
  function paintChip(a, docs) {
    if (!docs) return;
    const r = resolveChip(docs, a.dataset.docName, a.dataset.docPage || '');
    const label = a.querySelector('.doc-chip-t') || a;
    a.classList.toggle('gone', r.state !== 'ok');
    if (r.state === 'ok') {
      label.textContent = chipLabel(r.doc, r.page);
      a.title = 'Open ' + chipLabel(r.doc, r.page);
    } else if (r.state === 'deleted') {
      label.textContent = r.doc.title + ' › deleted page';
      a.title = 'This page was deleted';
    } else {
      a.title = 'This doc is not in this project any more';
    }
  }
  function decorate(container) {
    if (!container || !container.querySelectorAll) return;
    const chips = container.querySelectorAll('a.doc-chip');
    if (!chips.length) return;
    const c = chatOf(container) || openChat();
    if (!c || !c.id) return;
    const now = cached(c.id, 'main');
    for (const a of chips) paintChip(a, now);
    listFor(c.id, 'main').then((docs) => {
      for (const a of chips) paintChip(a, docs);
    });
  }
  function clickChip(a) {
    const c = chatOf(a) || openChat();
    if (!c || !c.id) return;
    listFor(c.id, 'main', true).then((docs) => {
      paintChip(a, docs);
      const r = resolveChip(docs, a.dataset.docName, a.dataset.docPage || '');
      if (r.state === 'ok') openDoc({ name: r.doc.name, title: r.doc.title, page: r.page ? r.page.id : '', chat: c, from: 'chat' });
      else if (host && host.notice) host.notice(r.state === 'deleted' ? 'That page was deleted from ' + r.doc.title + '.' : 'That doc is not in this project any more.');
    });
  }

  // ---- tool rows and the doc-created card -------------------------------------------------------------------------------------
  function paintRow(box, call, docs) {
    const t = box.querySelector ? box.querySelector('.tool-line-text') : null,
      k = box.querySelector ? box.querySelector('.tool-line-kind') : null;
    if (k) k.textContent = 'doc';
    if (t) t.textContent = toolText(call, docs || []);
    const tog = box.querySelector ? box.querySelector('.tool-toggle') : null;
    if (tog && t) tog.title = t.textContent;
  }
  // The card icons (doc-icons.js; a plain label when the page lacks it)
  const cardIcon = (name) => {
    const I = root.AIBDocIcons;
    try {
      if (I && I.icon) return I.icon(name, 'art-card-svg');
    } catch (e) {
      /* fall back */
    }
    return doc().createTextNode(name === 'doc' ? 'doc' : '');
  };
  function paintCard(card, call, docs) {
    const d = docOf(docs, call.doc);
    const res = call.result || {};
    const title = (d && d.title) || resultTitle(call) || titleFromTyped(call.doc) || 'Doc';
    const n = d ? d.pages : Array.isArray(res.pages) ? res.pages.length : 1;
    card.replaceChildren();
    const body = el('div', null, 'art-card-body');
    body.append(el('div', title, 'art-card-title'), el('div', 'Doc · ' + pagesText(n) + ' · in Files under aib-docs, you and agents edit it', 'art-card-sub'));
    const acts = el('div', null, 'art-card-actions');
    const open = btn('Open doc', 'art-btn art-btn-acc');
    open.setAttribute('aria-label', 'Open ' + title);
    open.disabled = !call.doc;
    open.addEventListener('click', () => {
      const c = chatOf(card) || openChat();
      openDoc({ name: call.doc, title, chat: c, from: 'chat' });
    });
    acts.append(open);
    const ic = el('span', null, 'art-card-ic doc-card-ic');
    ic.setAttribute('aria-hidden', 'true');
    ic.append(cardIcon('doc'));
    card.append(ic, body, acts);
  }
  // An agent making a doc while you watch: a doc_create row first seen running, later done. It shows in the Artifacts tab in
  // the background (the tab's count goes up and the row is marked new); nothing takes the focus. A row that arrives done
  // (opening a chat's history) is not new.
  const running = new Set(),
    announced = new Set();
  const rowId = (row) => String((row && row.raw && row.raw.toolCallId) || (row && row.call && row.call.id) || '');
  function noticeCreate(call, row, c) {
    const id = rowId(row);
    if (!id || call.tool !== 'doc_create') return;
    if (call.status === 'running' || call.status === '' || call.status === 'pending') {
      running.add(id);
      return;
    }
    if (call.status !== 'ok' || !call.doc || !running.has(id) || announced.has(id) || !c || !c.id) return;
    running.delete(id);
    announced.add(id);
    const title = resultTitle(call) || (call.result && typeof call.result.title === 'string' ? call.result.title : '') || titleFromTyped(call.doc);
    listFor(c.id, 'main', true).then(() => openDoc({ name: call.doc, title, chat: c, from: 'chat', background: true }));
  }
  // chat.js passes every tool row here first: a doc tool row gets the DOC label, its words and "open ↗"; doc_create adds a card.
  function decorateToolRow(box, row) {
    if (!box || !host) return box;
    let call = null;
    try {
      call = toolCall(row);
    } catch (e) {
      call = null;
    }
    if (!call) return box;
    box.classList.add('doc-tool');
    const c = chatOf(box) || openChat(),
      docs = c && c.id ? cached(c.id, 'main') : null;
    noticeCreate(call, row, c);
    paintRow(box, call, docs);
    if (call.doc && call.tool !== 'doc_list' && call.status !== 'failed') {
      let acts = Array.from(box.children || []).find((k) => k.classList && k.classList.contains('tool-acts'));
      if (!acts) {
        acts = el('span', null, 'tool-acts');
        const panel = Array.from(box.children || []).find((k) => k.classList && k.classList.contains('tool-detail'));
        if (panel) box.insertBefore(acts, panel);
        else box.append(acts);
      }
      const open = btn('open ↗', 'tool-open doc-open');
      open.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const cc = chatOf(box) || openChat();
        const ds = cc && cc.id ? cached(cc.id, 'main') : null;
        const dd = docOf(ds, call.doc);
        openDoc({ name: call.doc, title: (dd && dd.title) || resultTitle(call), page: toolPage(call, ds), chat: cc, from: 'chat' });
      });
      acts.append(open);
      const setTip = (ds) => {
        const d = docOf(ds, call.doc),
          p = pageTitle(d, call.page, call.result);
        open.title = 'Open ' + ((d && d.title) || resultTitle(call) || call.doc) + (p ? ' › ' + p : '');
        open.setAttribute('aria-label', open.title);
      };
      setTip(docs);
      if (c && c.id)
        listFor(c.id, 'main').then((ds) => {
          paintRow(box, call, ds);
          setTip(ds);
        });
    }
    if (call.tool === 'doc_create' && call.doc && call.status !== 'failed' && call.result) {
      const wrap = el('div', null, 'art-tool doc-tool-wrap');
      const card = el('div', null, 'art-card doc-card');
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', 'Doc');
      paintCard(card, call, docs);
      wrap.append(box, card);
      if (c && c.id) listFor(c.id, 'main').then((ds) => paintCard(card, call, ds));
      return wrap;
    }
    return box;
  }

  // ---- /doc ------------------------------------------------------------------------------------------------------------------
  // Runs /doc for the chat `chat` ({id, key}): finds or makes the doc (a new one is linked to this chat), finds or adds the page,
  // shows it in the right column's Artifacts viewer. Resolves {message} (the brief for the agent, aimed at the doc and page) or {error}.
  async function runCommand(text, chat) {
    const cmd = parseDocCommand(text);
    if (!cmd) return { error: 'Not a /doc command' };
    if (!cmd.name) return { error: 'Name the doc: /doc release plan' };
    if (!chat || !chat.id) return { error: 'Open a chat first' };
    const docs = await listFor(chat.id, 'main', true);
    let d = matchDoc(docs, cmd.name),
      opened = null;
    if (!d) {
      opened = await host.post('docs/open', { id: chat.id, name: titleFromTyped(cmd.name), create: '' });
      d = { name: opened.name, title: opened.title || opened.name, pageList: opened.pages || [], pages: (opened.pages || []).length };
      listFor(chat.id, 'main', true);
    }
    let page = null;
    if (cmd.page) {
      page = matchPage(d.pageList || [], cmd.page);
      if (!page) {
        if (!opened) opened = await host.post('docs/open', { id: chat.id, name: d.name });
        const r = await host.post('docs/page', { doc: opened.doc, action: 'add', title: titleFromTyped(cmd.page) });
        const pages = (r && r.pages) || [];
        page = pages.find((p) => p.id === r.page) || pages.find((p) => norm(p.title) === norm(cmd.page)) || pages[pages.length - 1] || null;
        listFor(chat.id, 'main', true);
      }
    }
    openDoc({ name: d.name, title: d.title, page: page ? page.id : '', chat, from: 'chat' });
    if (!cmd.brief) return { message: '' };
    const where = 'the doc "' + d.title + '"' + (page ? ', page "' + page.title + '"' : '') + ' (doc name "' + d.name + '")';
    return { message: 'In ' + where + ': ' + cmd.brief, doc: d, page };
  }

  // The completion list under the composer while /doc is typed: docs, then after ">" the doc's pages (Tab completes).
  let pop = null,
    popState = null,
    popIndex = 0,
    popSeq = 0;
  function popup() {
    const D = doc(),
      form = D.getElementById('promptForm');
    if (pop && pop.isConnected !== false) return pop;
    if (!form || !form.parentNode) return null;
    pop = el('div', null, 'slash-popup doc-popup');
    pop.id = 'docPopup';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    form.parentNode.insertBefore(pop, form);
    return pop;
  }
  function closePopup() {
    popState = null;
    popIndex = 0;
    if (pop) {
      pop.hidden = true;
      pop.replaceChildren();
    }
  }
  function drawPopup() {
    const p = popup();
    if (!p) return;
    const c = popState;
    if (!c || (!c.items.length && !c.create)) {
      closePopup();
      return;
    }
    p.replaceChildren();
    p.append(el('div', c.kind === 'page' ? 'Pages in ' + c.doc.title : 'Docs in this project', 'doc-pop-head'));
    const rows = c.items.slice();
    if (c.create) rows.push({ create: true, title: c.create });
    if (popIndex >= rows.length) popIndex = 0;
    rows.forEach((it, i) => {
      const row = el('div', null, 'slash-option doc-option' + (i === popIndex ? ' selected' : '') + (it.create ? ' doc-new' : ''));
      row.id = 'doc-option-' + i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === popIndex));
      if (it.create) {
        row.append(el('strong', (c.kind === 'page' ? '+ New page ' : '+ New doc ') + it.title));
        row.append(el('span', c.kind === 'page' ? "Type a name that doesn't exist yet" : 'Makes it and links it to this chat'));
      } else {
        row.append(el('strong', it.title));
        if (it.sub) row.append(el('span', it.sub));
      }
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        popIndex = i;
        acceptPopup();
      });
      p.append(row);
    });
    p.hidden = false;
  }
  function refreshPopup() {
    const D = doc(),
      box = D.getElementById('prompt');
    if (!box || !isDocCommand(box.value) || /:/.test(box.value)) return closePopup();
    const c = openChat();
    if (!c || !c.id) return closePopup();
    const value = box.value,
      mine = ++popSeq;
    const show = (docs) => {
      if (mine !== popSeq || box.value !== value) return;
      const next = completions(value, docs || []);
      if (!next || (popState && popState.kind !== next.kind)) popIndex = 0;
      popState = next;
      drawPopup();
    };
    const now = cached(c.id, 'main');
    if (now) show(now);
    listFor(c.id, 'main').then(show);
  }
  function acceptPopup() {
    const box = doc().getElementById('prompt');
    if (!box || !popState) return false;
    const rows = popState.items.concat(popState.create ? [{ title: popState.create }] : []);
    const it = rows[popIndex];
    if (!it) return false;
    box.value = complete(box.value, popState, it);
    if (box.focus) box.focus();
    closePopup();
    refreshPopup();
    if (root.Event) box.dispatchEvent(new root.Event('input', { bubbles: true }));
    return true;
  }
  // chat.js calls this first on the composer's keys: true when the /doc list used the key.
  function handleKey(e) {
    if (!popState || !pop || pop.hidden || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
    const n = popState.items.length + (popState.create ? 1 : 0);
    if (!n) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      popIndex = (popIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      drawPopup();
      return true;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      return acceptPopup();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
      return true;
    }
    return false;
  }

  // ---- the doc tab's messages (contract section 2) ------------------------------------------------------------------------------
  // files-ui.js knows which frame sent it; this answers pick-chat with a small chat menu.
  function pickChat(anchor, purpose) {
    return new Promise((resolve) => {
      const chats = FU() && FU().projectChats ? FU().projectChats() : [];
      const D = doc();
      const m = el('div', null, 'ws-menu fx-menu doc-pick');
      m.setAttribute('role', 'menu');
      m.setAttribute('aria-label', purpose === 'link' ? 'Link this doc to a chat' : 'Send to a chat');
      m.append(el('div', purpose === 'link' ? 'Link this doc to' : 'Send to', 'fx-menu-head'));
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        m.remove();
        D.removeEventListener('pointerdown', away, true);
        resolve(v);
      };
      const away = (e) => {
        if (!(e.target && e.target.closest && e.target.closest('.doc-pick'))) finish(null);
      };
      for (const c of chats) {
        const b = btn(null, 'ws-menu-item fx-menu-it');
        b.setAttribute('role', 'menuitem');
        b.append(el('span', c.title || 'Chat'));
        if (c.branch) b.append(el('span', c.branch, 'sub'));
        b.onclick = () => finish(c.id);
        m.append(b);
      }
      if (!chats.length) m.append(el('p', 'No chat in this project yet.', 'fx-empty'));
      m.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      });
      D.body.append(m);
      const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 80, top: 80, width: 0 };
      m.style.left = Math.max(8, Math.round(r.left + (r.width || 0) / 2 - 120)) + 'px';
      m.style.top = Math.max(8, Math.round(r.top + 60)) + 'px';
      D.addEventListener('pointerdown', away, true);
      const first = m.querySelector('button');
      if (first && first.focus) first.focus();
    });
  }

  // ---- doc pop-outs (multi-window Phase 2.5B; owner decision 4: popping out MOVES the doc) ------------------------------------
  // "Pop out" on a doc (its ⋯ menu, in a tab or the Artifacts viewer) asks the app for a doc window (K3 op 'popout', by project
  // key and doc name), and the doc's tab closes here (files-ui.js). This window remembers what it moved (sessionStorage: per
  // window, so a reload keeps it): the doc's row in Files shows ↗, and opening the doc from anywhere brings the pop-out forward
  // instead of opening a second copy. When the pop-out goes (its pagehide 'bye', or it is gone from the presence answer), the
  // doc comes back here as a background tab, if it still exists. In a browser (serve: no desktop app, the route answers 501) the
  // pop-out is a window.open popup; this page watches it close.
  const POP_KEY = 'aib-doc-popouts',
    POP_MAX = 8;
  const popKey = (project, name) => String(project || '') + '\n' + String(name || '');
  const AW = () => root.AibWindow || null;
  const session = () => {
    try {
      return root.sessionStorage || null;
    } catch (e) {
      return null;
    }
  };
  let pops = null; // [{project, name, title, scope, w, seen, at}]
  const popups = new Map(); // popKey -> a window.open handle (serve mode)
  function popList() {
    if (pops) return pops;
    try {
      const v = JSON.parse((session() && session().getItem(POP_KEY)) || '[]');
      pops = Array.isArray(v) ? v.filter((p) => p && typeof p.project === 'string' && typeof p.name === 'string') : [];
    } catch (e) {
      pops = [];
    }
    return pops;
  }
  function savePops() {
    try {
      if (session()) session().setItem(POP_KEY, JSON.stringify(popList().slice(-POP_MAX)));
    } catch (e) {
      /* private window */
    }
    for (const fn of popListeners) fn();
  }
  const popListeners = new Set();
  // The window (not this one) that shows this doc now, from the presence answer: its id, or ''.
  function windowOfDoc(project, name) {
    const W = AW();
    const list = W && W.others ? W.others() : [];
    const hit = list.find((x) => x && x.kind === 'doc' && x.doc && x.doc.project === project && x.doc.name === name);
    return hit ? hit.w : '';
  }
  // Is this doc popped out (from this window, or shown by another window)? {w, mine} or null.
  function poppedOut(project, name) {
    if (!project || !name) return null;
    const mine = popList().find((p) => p.project === project && p.name === name);
    const w = windowOfDoc(project, name);
    if (mine) return { w: w || mine.w || '', mine: true };
    return w ? { w, mine: false } : null;
  }
  // Bring the pop-out forward. A window that is gone (404) puts the doc back here instead.
  function focusPopout(project, name) {
    const hit = poppedOut(project, name);
    if (!hit) return false;
    const k = popKey(project, name);
    const popup = popups.get(k);
    if (popup && !popup.closed) {
      try {
        popup.focus();
      } catch (e) {
        /* gone */
      }
      return true;
    }
    if (!hit.w || !host || !host.post) {
      if (hit.mine) restorePop(k);
      return !hit.mine;
    }
    Promise.resolve(host.post('desktop/windows', { op: 'focus', w: hit.w })).catch((e) => {
      if (e && e.status === 404 && hit.mine) restorePop(k);
    });
    return true;
  }
  /**
   * Pop a doc out. o: {project (key), name, title, scope (the tab's), closeHere()}. Resolves true when it opened (or focused) the
   * doc's window; closeHere then runs (the tab leaves this window).
   */
  async function popOut(o) {
    if (!o || !o.project || !o.name || !host || !host.post) return false;
    const W = AW();
    const k = popKey(o.project, o.name);
    const entry = { project: o.project, name: o.name, title: o.title || o.name, scope: o.scope || null, w: '', seen: false, at: Date.now() };
    try {
      const r = await host.post('desktop/windows', { op: 'popout', from: W && W.id ? W.id() : 'm', doc: { project: o.project, name: o.name } });
      entry.w = (r && typeof r.w === 'string' && r.w) || '';
    } catch (e) {
      if (!(e && e.status === 501)) {
        if (host.notice) host.notice(e && e.status === 409 ? 'At most 8 AIB windows can be open. Close one first.' : 'The doc could not be popped out. Try again in a moment.');
        return false;
      }
      // a browser (serve): a popup window of its own
      const q = new URLSearchParams({ kind: 'doc', project: o.project, name: o.name });
      const win = root.open ? root.open('/doc.html?' + q.toString(), 'aib-doc-' + o.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40), 'popup,width=720,height=900') : null;
      if (!win) {
        if (host.notice) host.notice('The browser blocked the pop-out window. Allow pop-ups for AIB and try again.');
        return false;
      }
      popups.set(k, win);
      watchPopup(k);
    }
    pops = popList().filter((p) => popKey(p.project, p.name) !== k);
    pops.push(entry);
    savePops();
    if (typeof o.closeHere === 'function') o.closeHere();
    return true;
  }
  function watchPopup(k) {
    const timer = (root.setInterval || setInterval)(() => {
      const win = popups.get(k);
      if (win && !win.closed) return;
      (root.clearInterval || clearInterval)(timer);
      popups.delete(k);
      restorePop(k);
    }, 1000);
  }
  // The pop-out closed: the doc's tab comes back here in the background, if the doc still exists (not moved to the trash). The
  // tab is keyed by what lasts, the project and the doc's name: its scope is worked out now (files-ui docScopeFor), so a chat id
  // that changed at an AIB restart (or a pop-out this window took back after one, with no scope at all) still finds its way home.
  const restoring = new Set();
  function restorePop(k) {
    const p = popList().find((x) => popKey(x.project, x.name) === k);
    if (!p || restoring.has(k)) return;
    restoring.add(k);
    pops = popList().filter((x) => x !== p);
    savePops();
    const scope = (FU() && FU().docScopeFor ? FU().docScopeFor(p.project, p.scope) : null) || p.scope;
    const put = (d) => {
      restoring.delete(k);
      if (!d || !scope || !FU() || !FU().restoreDocTab) return;
      FU().restoreDocTab(scope, { name: p.name, title: p.title || d.title || p.name, project: p.project });
    };
    if (!scope || !scope.id) return put(null);
    listFor(scope.id, 'main', true).then(
      (docs) => put((docs || []).find((d) => d.name === p.name) || null),
      () => put(null),
    );
  }
  // Look at the windows the presence answer lists: a moved doc whose window was there and is gone now comes back.
  function checkPops() {
    const W = AW();
    if (!W || !W.known || !W.known()) return;
    let changed = false;
    /* After a restart this window's own record of the move is gone (sessionStorage is per window and per run), but the app
       restores the doc pop-out with the window it was moved out of (desktop-windows.json `from`, in the presence answer): this
       window takes it back as its own, so closing the pop-out still puts the tab back here (as workspace-ui.js does for chats). */
    const self = W.id ? W.id() : '';
    for (const o of self && W.others ? W.others() : []) {
      const d = o && o.kind === 'doc' && o.from === self ? o.doc : null;
      if (!d || typeof d.project !== 'string' || !d.project || typeof d.name !== 'string' || !d.name) continue;
      if (popList().some((p) => p.project === d.project && p.name === d.name)) continue;
      popList().push({ project: d.project, name: d.name, title: '', scope: null, w: o.w, seen: true, at: Date.now(), adopted: true });
      changed = true;
    }
    for (const p of popList().slice()) {
      const k = popKey(p.project, p.name);
      if (popups.has(k)) continue; // a browser popup: watched by its handle
      const w = windowOfDoc(p.project, p.name);
      if (w) {
        if (!p.seen || p.w !== w) {
          p.seen = true;
          p.w = w;
          changed = true;
        }
      } else if (p.seen) restorePop(k);
    }
    if (changed) savePops();
  }
  // window-context.js calls onChange for a new answer and at once for another window's pagehide ('bye').
  function watchWindows() {
    const W = AW();
    if (W && W.onChange) W.onChange(() => checkPops());
  }

  function init(h) {
    host = h;
    watchWindows();
    const D = doc();
    D.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a.doc-chip') : null;
      if (!a) return;
      e.preventDefault();
      clickChip(a);
    });
    const box = D.getElementById('prompt');
    if (box) {
      box.addEventListener('input', refreshPopup);
      box.addEventListener('blur', () => (root.setTimeout || setTimeout)(closePopup, 150));
    }
  }

  const api = Object.assign({}, pure, {
    init,
    listFor,
    cached,
    forget,
    onList: (fn) => listeners.add(fn),
    openDoc,
    createDoc,
    decorate,
    decorateToolRow,
    runCommand,
    handleKey,
    refreshPopup,
    closePopup,
    pickChat,
    popOut,
    poppedOut,
    focusPopout,
    checkPops,
    onPops: (fn) => popListeners.add(fn),
    _pops: () => popList().slice(),
    _popup: () => ({ state: popState, index: popIndex }),
    _reset: () => {
      lists.clear();
      listeners.clear();
      running.clear();
      announced.clear();
      host = null;
      pops = null;
      popups.clear();
      popListeners.clear();
      pop = null;
      popState = null;
      popIndex = 0;
    },
  });
  root.AgentDocLinks = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
