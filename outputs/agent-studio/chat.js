(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  /* The Thinking checkbox lives in the main view, which is detached while split panes change focus: remember the last value. */
  let thinkingCache = false;
  const thinkingOn = () => {
    const el = document.getElementById('thinking');
    if (el) thinkingCache = !!el.checked;
    return thinkingCache;
  };
  const text = (tag, value, cls) => {
    const el = document.createElement(tag);
    el.textContent = value;
    if (cls) el.className = cls;
    return el;
  };
  function stored(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  }
  const aliases = stored('studio-conversation-names', {});
  /* QA M4: chats whose worktree was discarded from the Changes tab (provider:sessionId -> {at, row}). Such a chat stays in the list,
     readable, but cannot be continued: the composer is off with a note, and it has no branch any more. The list row is kept here
     (this browser) so the chat does not vanish when the agent has no saved transcript Studio can list. */
  const DISCARDED_KEY = 'studio-discarded-chats-v1';
  const discardedChats = new Map(Object.entries(stored(DISCARDED_KEY, {}) || {}));
  const isDiscarded = (c) => !!c && (c.discarded || discardedChats.has(aliasKeyOf(c)));
  function aliasKeyOf(c) {
    return c.provider + ':' + (c.sessionId || c.id || c.key);
  }
  function rememberDiscarded(c) {
    const row = {
      ...c,
      discarded: true,
      worktree: null,
      live: c.live ? { ...c.live, closed: true, worktree: null } : c.live,
    };
    delete row.elsewhere;
    discardedChats.set(aliasKeyOf(c), { at: Date.now() / 1000, row });
    const keep = [...discardedChats.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 50);
    try {
      localStorage.setItem(DISCARDED_KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch {}
    return row;
  }
  const DISCARDED_NOTE = 'This chat\u2019s worktree was discarded: you can read it, but not continue it.';
  let token = '',
    current = '',
    selected = null,
    snapshot = null,
    cursor = 0,
    /* The server's id for the open chat's event numbering: another id means its events must be fetched again from the start. */
    eventsId = '',
    events = [],
    conversations = [],
    agents = [],
    subSelection = null,
    provider = 'all',
    polling = false,
    historyLimit = 120,
    mainSignature = '',
    subSignature = '',
    settingsSignature = '',
    approvalSignature = '',
    sidebarSignature = '',
    renameTarget = null,
    connectionIssue = false,
    imageFeatureEnabled = false;
  class DraftStore {
    constructor(storage, key = 'studio-drafts-v1') {
      this.storage = storage;
      this.key = key;
      this.data = {};
      try {
        const parsed = JSON.parse(storage.getItem(key) || '{}');
        if (
          parsed.version === 1 &&
          parsed.drafts &&
          typeof parsed.drafts === 'object' &&
          !Array.isArray(parsed.drafts)
        ) {
          for (const [id, value] of Object.entries(parsed.drafts)) if (typeof value === 'string') this.data[id] = value;
        }
      } catch {}
    }
    get(id) {
      return this.data[id] || '';
    }
    set(id, value) {
      if (typeof value !== 'string') throw Error('Draft must be text');
      if (value) this.data[id] = value;
      else delete this.data[id];
      this.persist();
      return this;
    }
    delete(id) {
      delete this.data[id];
      this.persist();
    }
    persist() {
      this.storage.setItem(this.key, JSON.stringify({ version: 1, drafts: this.data }));
    }
  }
  const children = new Map(),
    drafts = new DraftStore(localStorage);
  let commands = [],
    selectedCommand = null,
    showCommandHistory = false,
    commandSignature = '';
  let recoveredList = [],
    recoveryWarning = '',
    discoveryEnabled = false,
    instanceId = '',
    stoppingSubagent = false,
    stopArmed = false,
    stopArmTimer = null;
  const agentListed = {
      omp: { sessions: [], cursor: null, loaded: false, busy: false, note: '' },
      claude: { sessions: [], cursor: null, loaded: false, busy: false, note: '' },
    },
    historyWindows = new Map(),
    HISTORY_PAGE = 120,
    HISTORY_CAP = 3000,
    GROUP_WINDOW = 40;
  let continuingKey = '',
    sendingKey = '',
    listedAt = 0, // when the conversation list was last asked for (headerYourTurn)
    imagePickerKey = '',
    newDraft = null,
    startingNew = false,
    lastMainRows = [];
  const newOptions = new Map(), // agent|folder -> the lists a new chat can offer (wantNewOptions)
    attachmentStore = new Map(),
    MAX_IMAGES = 4,
    MAX_IMAGE_BYTES = 5 * 1024 * 1024,
    MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024,
    IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const attemptStoreKey = 'studio-prompt-attempts-v1';
  function attemptIdentity(key, value, fingerprint = '') {
    return JSON.stringify([key, value, fingerprint]);
  }
  function readAttempts() {
    const value = stored(attemptStoreKey, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function attemptId(key, value, fingerprint = '') {
    const identity = attemptIdentity(key, value, fingerprint);
    let attempts = readAttempts();
    if (typeof attempts[identity] === 'string') return attempts[identity];
    const id =
      globalThis.crypto?.randomUUID?.() ||
      'studio-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    attempts[identity] = id;
    localStorage.setItem(attemptStoreKey, JSON.stringify(attempts));
    return id;
  }
  function clearAttempt(key, value, fingerprint = '') {
    const identity = attemptIdentity(key, value, fingerprint),
      attempts = readAttempts();
    if (attempts[identity]) {
      delete attempts[identity];
      try {
        localStorage.setItem(attemptStoreKey, JSON.stringify(attempts));
      } catch {}
    }
  }
  function keepDraft() {
    if (!selected) return;
    try {
      drafts.set(aliasKey(selected), $('prompt').value);
    } catch {
      fail(
        Error(
          'Browser storage is full or unavailable. Your draft remains in this page, but could not be saved for refresh.',
        ),
      );
    }
  }

  const nameOf = (p) => AgentChoice.nameOf(p);
  const workspace = (c) => (c.cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'Conversation';
  const aliasKey = (c) => c.provider + ':' + (c.sessionId || c.id || c.key);
  const curKey = () => (selected ? aliasKey(selected) : newDraft ? 'new-chat' : null);
  /* Run in terminal pastes into the open chat's terminal; split side panes name their chat with the same key (data-mirror). */
  window.RunInTerminalUI?.init({ current: () => (selected ? aliasKey(selected) : '') });
  /* Condensed chat views (views.js / views-ui.js): the choice is kept per chat under its aliasKey (newest 500). Full until a view is chosen. */
  /* The fallback is the Settings default (Full or Chat) for a chat that has no saved choice of its own. */
  const viewStore = window.ChatViews
    ? window.ChatViews.viewStore(
        localStorage,
        () => window.AgentSettingsUI?.defaultView?.() || window.ChatViews.DEFAULT_VIEW,
      )
    : null;
  const viewOf = () => (viewStore ? viewStore.get(curKey()) : 'full');
  let pendingSwitch = null; // {anchor, bottom}: a view change waiting for its repaint
  let viewAnchor = null; // {key, anchor, top}: where the last view change put you (top: the scroll position it left)
  /* Rows drawn in #messages carry data-ri, their index in the chat's rows, the same in every view. */
  function rowAnchor(box) {
    const top = box.getBoundingClientRect().top;
    for (const el of box.querySelectorAll('[data-ri]')) {
      const r = el.getBoundingClientRect();
      if (r.height && r.bottom > top + 1) return { ri: +el.dataset.ri, off: r.top - top };
    }
    return null;
  }
  /* Put that row back where it was; a row this view does not show gives way to the nearest one it does (earlier first). */
  function restoreRowAnchor(box, a) {
    if (!a) return false;
    let best = null,
      bestD = Infinity;
    for (const el of box.querySelectorAll('[data-ri]')) {
      if (!el.getClientRects().length) continue;
      const ri = +el.dataset.ri,
        d = Math.abs(ri - a.ri) + (ri > a.ri ? 0.5 : 0);
      if (d < bestD) {
        best = el;
        bestD = d;
        if (!d) break;
      }
    }
    if (!best) return false;
    box.scrollTop += best.getBoundingClientRect().top - box.getBoundingClientRect().top - a.off;
    return true;
  }
  function setView(view) {
    const key = curKey(),
      box = $('messages');
    if (!viewStore || !key || viewOf() === view) return;
    /* the row you were reading; switching back before you scroll again goes back to that same row, not to the one the other
       view had to show in its place */
    const again = viewAnchor && viewAnchor.key === key && Math.abs(box.scrollTop - viewAnchor.top) <= 2;
    pendingSwitch = {
      anchor: again ? viewAnchor.anchor : { row: rowAnchor(box), pk: window.ChatViewsUI?.anchorOf(box) || null },
      bottom: followBox(box),
    };
    UNREAD.holdUntil = Date.now() + 600; // the repaint moves the scroll position by itself; the read state must not change with it
    viewStore.set(key, view);
    rowExtra.main = 0;
    mainSignature = '';
    window.ChatViewsUI?.sync();
    repaintMain();
  }
  /* ---- Scroll positions: scroll-controller.js owns them for the lists it manages (the subagent view and command output here; the
     main list and split panes come next). A list's controller is attached the first time something is drawn into it. */
  const SCROLL_ROLES = { submessages: 'sub', commandDetails: 'command' };
  function managed(box) {
    if (!box || !window.ScrollController || !SCROLL_ROLES[box.id]) return null;
    if (!box._scrollCtl)
      box._scrollCtl = window.ScrollController.attach(box, { role: SCROLL_ROLES[box.id], clamp: box.id === 'submessages' });
    return box._scrollCtl;
  }
  /* Draws the main list again from what is already loaded (no request). */
  function repaintMain() {
    if (current && snapshot)
      showRows(
        $('messages'),
        withUnknownSends(liveRows(snapshot.sessionId, events, snapshot, viewOf() !== 'full'), snapshot.unknownReceipts),
        'main',
        liveExtra(),
      );
    else if (selected) {
      const w = historyWindows.get(selected.key);
      if (w && w.loaded) renderMainHistory(w, selected.key);
    }
  }
  /* ---- the live line (Chat) ----
     working: the AI is on the newest prompt right now. live: what it is doing (liveStatus reads the RAW events: thinking rows
     exist only with Show thinking on) and since when (the prompt's own time, so a Studio restart does not reset the clock).
     Neither goes into the change signature except the working flag: the step and the clock are updated in place (views-ui.js). */
  const liveSince = new Map(); // chat key -> when this page first saw it working, for a prompt that carries no time
  function liveOf(status, key, extra) {
    if (!status) return null;
    let since = status.since;
    if (since == null) {
      if (!liveSince.has(key)) liveSince.set(key, Date.now());
      since = liveSince.get(key);
    }
    return { step: status.step, n: status.n, since, talking: !!status.talking, ...extra };
  }
  /* A chat attached here: working only while the connection is up and busy (a crashed or closed one is not working);
     "waiting for you" while an approval or question is open (the same attention facts the header uses). */
  function liveExtra() {
    const CV = window.ChatViews;
    if (!CV || !current || !snapshot) return { working: false };
    const ok = !snapshot.closed && !connectionIssue && snapshot.ready !== false,
      working = ok && !!snapshot.busy,
      find = findState(null);
    if (!working) {
      liveSince.delete(curKey());
      return { working: false, find };
    }
    const waiting = (snapshot.permissions || []).length + (snapshot.elicitations || []).length > 0;
    return { working, live: liveOf(CV.liveStatus(events, 'live', snapshot.sessionId), curKey(), { waiting }), find };
  }
  /* A saved chat another app is working on: the step is read from the saved transcript; no step number, "working elsewhere". */
  function savedExtra(key, w) {
    const CV = window.ChatViews;
    if (!savedWorking(key)) {
      liveSince.delete(key);
      return { working: false };
    }
    const c = conversations.find((x) => x.key === key);
    return {
      working: true,
      live: CV ? liveOf(CV.liveStatus(w.events, 'saved'), key, { elsewhere: !c?.live?.busy }) : null,
    };
  }

  /* ---- Prompts: the find box above the list ----
     It filters the loaded prompts at once, and asks the server (/api/live/prompts) for the whole saved transcript, so a prompt on an
     older, unloaded page still turns up: it shows as a closed header, and a click loads that page and opens the prompt. */
  const promptFind = {
    key: '',
    q: '',
    hits: [],
    hitsFor: '',
    total: 0,
    matched: 0,
    loading: false,
    error: '',
    seq: 0,
    timer: 0,
  };
  const findQuery = () => (promptFind.key === curKey() ? promptFind.q : '');
  function findState(w) {
    const q = promptFind.key === curKey() ? promptFind.q.trim() : '';
    if (!q) return null;
    const stubs = w && w.loaded && promptFind.hitsFor === q ? promptFind.hits.filter((h) => h.index < w.start) : [];
    return { q, stubs };
  }
  function findNote() {
    const q = findQuery().trim();
    if (!q) return '';
    if (promptFind.loading) return 'Searching the whole chat…';
    if (promptFind.error) return promptFind.error;
    return promptFind.hitsFor === q ? promptFind.matched + ' of ' + promptFind.total + ' prompts match' : '';
  }
  function setFindQuery(q) {
    promptFind.key = curKey() || '';
    promptFind.q = String(q || '');
    clearTimeout(promptFind.timer);
    promptFind.seq++;
    promptFind.loading = false;
    promptFind.error = '';
    const text = promptFind.q.trim();
    if (text && selected && !current && selected.key) promptFind.timer = setTimeout(() => runFind(text), 250);
    else promptFind.hitsFor = '';
    mainSignature = '';
    repaintMain();
    window.ChatViewsUI?.syncFind();
  }
  async function runFind(q) {
    const key = selected?.key,
      seq = ++promptFind.seq;
    if (!key) return;
    promptFind.loading = true;
    window.ChatViewsUI?.syncFind();
    try {
      const res = await get('/api/live/prompts', { key, q, thinking: thinkingOn() ? '1' : '0', limit: 200 });
      if (seq !== promptFind.seq) return;
      promptFind.hits = res.prompts || [];
      promptFind.hitsFor = q;
      promptFind.total = res.total || 0;
      promptFind.matched = res.matched || 0;
    } catch (error) {
      if (seq !== promptFind.seq) return;
      promptFind.hits = [];
      promptFind.hitsFor = '';
      promptFind.error = 'Search failed: ' + (error.message || 'try again');
    }
    promptFind.loading = false;
    mainSignature = '';
    repaintMain();
    window.ChatViewsUI?.syncFind();
  }
  /* The loaded prompt row is the one a search hit names (same time, same start of the text). */
  function sameHit(row, hit) {
    const start = (t) =>
      Array.from(String(t || ''))
        .slice(0, 100)
        .join('');
    return (
      String(row.time ?? '') === String(hit.time ?? '') &&
      start(window.ChatViews.promptText(row).trim()) === start(String(hit.text || '').trim())
    );
  }
  /* Click on a hit from an older page: load pages until it is loaded, open that prompt and scroll to it. */
  async function openHit(hit) {
    const key = selected?.key,
      w = key && !current ? historyWindows.get(key) : null;
    if (!w || !window.ChatViews) return;
    try {
      while (w.start > hit.index && w.start > 0) if (!(await fetchEarlier(w, key))) break;
    } catch (error) {
      fail(error);
      return;
    }
    if (selected?.key !== key) return;
    const rows = normalized({ events: w.events, context: w.context, start: w.start }, key, true),
      unit = window.ChatViews.project(rows, 'prompts', {}).units.find((u) => sameHit(u.prompt, hit));
    if (unit) window.ChatViewsUI.openPrompt(unit.key);
    rowExtra.main = 1e9; // show every loaded prompt, so the opened one is drawn
    mainSignature = '';
    renderMainHistory(w, key);
    const box = $('messages'),
      target = unit && [...box.children].find((el) => el.dataset && el.dataset.pk === unit.key);
    if (target) {
      /* the opened prompt is where you read now: the next update must not pull it away (follows again if it is at the end) */
      if (!box.dataset.paused) {
        UNREAD.mark = markNow();
        UNREAD.jumped = false;
      }
      box.dataset.paused = '1';
      box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
      resumeIfAtEnd(box);
    }
  }
  const refreshComposer = () => {
    if (selected) renderHeader();
    else renderNewChat();
  };
  function selectedAttachments(key = curKey()) {
    return key ? attachmentStore.get(key) || [] : [];
  }
  function attachAvailable() {
    return selected ? imageCapability() : !!newDraft && imageFeatureEnabled;
  }
  function imageCapability() {
    return imageFeatureEnabled && !!selected && !!snapshot;
  }
  function renderAttachments() {
    const box = $('attachmentList');
    if (!box) return;
    box.replaceChildren();
    const items = selectedAttachments();
    for (const item of items) {
      const card = text('div', '', 'attachment-card'),
        image = item.kind === 'file' ? window.AttachmentsUI.fileBadge(item) : document.createElement('img');
      if (item.kind !== 'file') {
        image.alt = item.file.name;
        image.src = item.preview;
        window.ImageViewer?.makeViewable(image, item.file.name);
      }
      const remove = text('button', '×', 'attachment-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + item.file.name);
      remove.disabled = !!sendingKey;
      remove.onclick = () => removeAttachment(curKey(), item.id);
      card.append(image, text('span', item.file.name), remove);
      box.append(card);
    }
    const hasItems = items.length > 0;
    box.hidden = !hasItems;
    $('attachmentNote').textContent =
      window.AttachmentsUI?.note({ imageFeature: imageFeatureEnabled, snapshot, hasItems }) || '';
    $('attachImages').disabled = !attachAvailable() || !!sendingKey || startingNew;
  }
  function releaseAttachment(item) {
    if (item.preview && item.ownedPreview) URL.revokeObjectURL(item.preview);
  }
  function removeAttachment(key, id) {
    const items = selectedAttachments(key),
      removed = items.find((item) => item.id === id);
    if (!removed) return;
    attachmentStore.set(
      key,
      items.filter((item) => item.id !== id),
    );
    releaseAttachment(removed);
    if (key && key === curKey()) {
      renderAttachments();
      refreshComposer();
    }
  }
  function clearSentAttachments(key, sent) {
    const ids = new Set(sent.map((item) => item.id));
    const remaining = selectedAttachments(key).filter((item) => !ids.has(item.id));
    for (const item of selectedAttachments(key)) if (ids.has(item.id)) releaseAttachment(item);
    if (remaining.length) attachmentStore.set(key, remaining);
    else attachmentStore.delete(key);
    if (key && key === curKey()) {
      renderAttachments();
      refreshComposer();
    }
  }
  function addImageFiles(files, key = curKey()) {
    if (!key || !(selected || newDraft)) return;
    const items = selectedAttachments(key).slice();
    let rejected = [];
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) {
        rejected.push(file.name + ': unsupported image type');
        continue;
      }
      if (!Number.isFinite(file.size) || file.size < 1) {
        rejected.push(file.name + ': image is empty');
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejected.push(file.name + ': larger than 5 MiB');
        continue;
      }
      if (items.filter((item) => item.kind !== 'file').length >= MAX_IMAGES) {
        rejected.push(file.name + ': maximum 4 images');
        continue;
      }
      if (
        items.filter((item) => item.kind !== 'file').reduce((sum, item) => sum + item.file.size, 0) + file.size >
        MAX_TOTAL_IMAGE_BYTES
      ) {
        rejected.push(file.name + ': total image size would exceed 15 MiB');
        continue;
      }
      const preview = URL.createObjectURL(file);
      items.push({
        id: 'image-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
        file,
        preview,
        ownedPreview: true,
      });
    }
    if (items.length) attachmentStore.set(key, items);
    if (key && key === curKey()) {
      renderAttachments();
      refreshComposer();
      if (rejected.length) fail(Error(rejected.join(' · ')));
    }
  }
  function imageFingerprint(items) {
    return items.length ? window.AttachmentsUI.fingerprint(items) : Promise.resolve('');
  }
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function imageBlocks(items) {
    return items.length ? window.AttachmentsUI.blocks(items) : Promise.resolve([]);
  }
  const attachHost = {
    store: attachmentStore,
    caps: () => (selected ? snapshot?.promptCapabilities : { image: true, embeddedContext: true, audio: true }),
    key: () => curKey(),
    available: () => attachAvailable(),
    addImage: addImageFiles,
    refresh: (key) => {
      if (key && key === curKey()) {
        renderAttachments();
        refreshComposer();
      }
    },
    note: (message) => fail(Error(message)),
  };
  const titleOf = (c) =>
    aliases[aliasKey(c)] ||
    String(c.live?.breadth?.sessionInfo?.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 170) ||
    (
      c.title ||
      c.prompt ||
      'Conversation started ' + new Date((c.created || c.modified || Date.now() / 1000) * 1000).toLocaleDateString()
    )
      .replace(/\s+/g, ' ')
      .slice(0, 170);
  function since(t) {
    const n = Math.max(0, Math.floor(Date.now() / 1000 - t));
    return n < 60
      ? 'just now'
      : n < 3600
        ? Math.floor(n / 60) + 'm ago'
        : n < 86400
          ? Math.floor(n / 3600) + 'h ago'
          : Math.floor(n / 86400) + 'd ago';
  }
  function date(t) {
    if (!t) return '';
    /* the same clock as the turn line and the terminal ("4:10 PM"), with seconds */
    return new Date(typeof t === 'number' ? t * 1000 : t).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  async function request(url, options = {}, timeout = 15000) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const body = await response.json();
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      if (error.name === 'AbortError')
        throw Error('Request timed out. Your draft is saved; check the conversation before retrying.');
      if (error instanceof SyntaxError) throw Error('AIB returned an unexpected response. Your draft is saved.');
      throw Error('Connection lost. Your draft is saved; check the conversation before retrying.');
    } finally {
      clearTimeout(timer);
    }
  }
  function responseError(response) {
    const error = Error(response.body.error || 'Request failed');
    error.status = response.status;
    error.code = response.body.code;
    error.ownership = response.body.ownership;
    error.chats = response.body.chats;
    return error;
  }
  // Every /api/ GET except bootstrap carries the page token. A 403 means the token is stale (Studio restarted): fetch a fresh one and retry once; a GET is safe to repeat.
  async function get(path, params = {}) {
    const open = path === '/api/live/bootstrap',
      url = path + '?' + new URLSearchParams(params),
      send = () => request(url, open ? {} : { headers: { 'X-Studio-Token': token } }, 15000);
    if (!open && !token) await refreshToken();
    let response = await send();
    if (response.status === 403 && !open) {
      let fresh = false;
      try {
        await refreshToken();
        fresh = true;
      } catch {}
      if (fresh) response = await send();
    }
    if (!response.ok) throw responseError(response);
    return response.body;
  }
  window.AgentStudioGet = get;
  async function refreshToken() {
    const response = await request('/api/live/bootstrap', {}, 15000);
    if (!response.ok) throw responseError(response);
    token = response.body.token;
    if (response.body.instanceId) instanceId = response.body.instanceId;
    showStudioNotice(response.body);
  }
  /* Server notices from bootstrap: a data move that is waiting, or an agent host still running older code. Dismissed per page load. */
  let noticeDismissed = '';
  function studioNoticeText(b) {
    const m = b && b.migration,
      parts = [];
    if (b && b.packageNotice) parts.push(b.packageNotice);
    if (b && b.sandboxNotice) parts.push(b.sandboxNotice);
    if (m && m.kind !== 'sandbox' && (m.state === 'waiting' || m.state === 'failed' || m.state === 'blocked'))
      parts.push(
        (m.state === 'waiting'
          ? 'Moving AIB’s data to its new folder is waiting'
          : 'Moving AIB’s data to its new folder did not happen') +
          (m.reason ? ': ' + m.reason : '') +
          '. AIB keeps using the old folder for now and tries again the next time it starts with no chats running.',
      );
    if (b && b.hostTakeoverWaiting > 0)
      parts.push(
        'Another AIB version is running ' + b.hostTakeoverWaiting + ' chat(s); it will switch over when they finish.',
      );
    if (b && b.hostCodeWarning) parts.push(b.hostCodeWarning);
    return parts.join(' ');
  }
  function showStudioNotice(b) {
    const box = $('studioNotice');
    if (!box) return;
    const t = studioNoticeText(b);
    box.hidden = !t || t === noticeDismissed;
    $('studioNoticeText').textContent = t;
    $('studioNoticeClose').onclick = () => {
      noticeDismissed = t;
      box.hidden = true;
    };
  }
  // What this browser sent, kept so a message that was mid-send at a Studio restart can be shown and sent again (the server keeps only a fingerprint).
  const pendingKey = 'studio-pending-sends-v1';
  function pendingRecords() {
    const v = stored(pendingKey, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }
  function rememberSend(data) {
    if (!data.clientMessageId) return;
    try {
      const all = pendingRecords(),
        ids = Object.keys(all);
      if (all[data.clientMessageId]) return;
      all[data.clientMessageId] = { text: data.text || '', at: Date.now() };
      if (data.attachments?.length && JSON.stringify(data.attachments).length < 1500000)
        all[data.clientMessageId].attachments = data.attachments;
      for (const id of ids.slice(0, Math.max(0, ids.length - 19))) delete all[id];
      localStorage.setItem(pendingKey, JSON.stringify(all));
    } catch {}
  }
  async function post(path, data) {
    if (path === 'prompt' || path === 'queue') rememberSend(data);
    const response = await request(
      '/api/live/' + path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
        body: JSON.stringify(data),
      },
      path === 'connect' || path === 'discover' || path === 'agent-options' || path === 'project-remove'
        ? 120000
        : 30000,
    );
    if (response.status === 403) {
      let refreshed = false;
      try {
        await refreshToken();
        refreshed = true;
      } catch {}
      throw Error(
        refreshed
          ? 'AIB session refreshed. Retry this action explicitly; it was not sent again automatically.'
          : 'AIB could not refresh its session. Check the local server; your draft is saved.',
      );
    }
    if (!response.ok) {
      if ((path === 'prompt' || path === 'queue') && response.body?.code === 'prompt_state_unknown')
        forgetAttemptById(data.clientMessageId);
      throw responseError(response);
    }
    return response.body;
  }
  /* "This connection is not ready" + " Your draft..." needs a full stop between them (QA M4). */
  const sentence = (m) => {
    const t = String(m || '').trim();
    return !t || /[.!?\u2026:]$/.test(t) ? t : t + '.';
  };
  function fail(error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
  }
  function clearError() {
    $('error').hidden = true;
  }
  let clashUi = null;
  let ownershipHints = {},
    ownershipCertainty = 'checked';
  async function listConversations() {
    listedAt = Date.now();
    const [live, saved, ownership] = await Promise.all([
      get('/api/live/list'),
      get('/api/sessions'),
      get('/api/live/ownership').catch(() => null),
    ]);
    if (ownership)
      ownershipHints = window.AgentOwnershipUI?.stabilizeHints
        ? window.AgentOwnershipUI.stabilizeHints(ownership.hints || {}, Date.now())
        : ownership.hints || {};
    if (ownership) ownershipCertainty = ownership.certainty === 'unknown' ? 'unknown' : 'checked';
    if (live.instanceId && instanceId && live.instanceId !== instanceId) {
      // A different Studio process is answering: the old token and every old connection ID are void.
      try {
        await refreshToken();
      } catch {
        instanceId = live.instanceId;
      }
      if (current) {
        current = '';
        snapshot = null;
        connectionIssue = false;
        closeInspector();
      }
      fail(
        Error(
          live.autoReconnect
            ? 'AIB was restarted. Conversations that were open are reconnecting by themselves. Nothing was sent again.'
            : 'AIB was restarted. Conversations that were open can be reconnected from the list. Nothing was sent again.',
        ),
      );
    } else if (live.instanceId && !instanceId) instanceId = live.instanceId;
    recoveredList = Array.isArray(live.recovered) ? live.recovered : [];
    recoveryWarning = live.recoveryWarning || '';
    const matched = new Set(),
      known = new Set(),
      recoveredBy = new Map(recoveredList.map((r) => [r.provider + ':' + r.sessionId, r]));
    conversations = [];
    window.AgentOrganizeUI?.sync(live.conversationRevision);
    await window.AgentReadState?.sync(live.readStateRevision);
    if (!readMigrated && window.AgentReadState) {
      readMigrated = true;
      /* Old browser-only read positions: keys that were a live connection id become provider:sessionId. */
      const stable = new Map(
        live.connections
          .filter((l) => l.sessionId && l.id)
          .map((l) => [l.provider + ':' + l.id, l.provider + ':' + l.sessionId]),
      );
      window.AgentReadState.migrate((k) => stable.get(k) || k);
    }
    window.AgentWorkspaceUI?.syncPrefs?.(live.projectsRevision);
    window.AgentSettingsUI?.sync(live.settingsRevision);
    for (const c of saved.sessions) {
      const owned = live.connections.find((l) => !l.closed && l.provider === c.provider && l.sessionId === c.id);
      if (owned) matched.add(owned.id);
      known.add(c.provider + ':' + c.id);
      const recovered = owned ? undefined : recoveredBy.get(c.provider + ':' + c.id);
      if (c.hasMessages || owned || recovered) conversations.push({ ...c, live: owned, recovered });
    }
    for (const c of live.connections) {
      if (!c.closed && !matched.has(c.id)) {
        if (c.sessionId) known.add(c.provider + ':' + c.sessionId);
        conversations.push({
          ...c,
          id: c.sessionId,
          key: 'live:' + c.id,
          live: c,
          title: 'New conversation',
          created: Date.now() / 1000,
          modified: Date.now() / 1000,
        });
      }
    }
    for (const r of recoveredList) {
      const id = r.provider + ':' + r.sessionId;
      if (known.has(id)) continue;
      known.add(id);
      conversations.push({
        provider: r.provider,
        id: r.sessionId,
        cwd: r.cwd,
        title: r.title || 'Conversation open before restart',
        created: r.openedAt || r.lastSeen || 0,
        modified: r.lastSeen || 0,
        key: 'recovered:' + id,
        recovered: r,
        hasMessages: true,
        subagentCount: 0,
      });
    }
    for (const p of ['omp', 'claude'])
      for (const item of agentListed[p].sessions) {
        const id = p + ':' + item.sessionId;
        if (known.has(id)) continue;
        known.add(id);
        const when = Date.parse(item.updatedAt) / 1000 || 0;
        conversations.push({
          provider: p,
          id: item.sessionId,
          cwd: item.cwd,
          title: item.title || '',
          created: when,
          modified: when,
          key: 'agent:' + id,
          source: 'agent',
          hasMessages: true,
          subagentCount: 0,
        });
      }
    /* A discarded chat keeps its place: its saved transcript row if the agent wrote one, else the row remembered at Discard. */
    for (const [key, d] of discardedChats) {
      const have = conversations.find((c) => aliasKey(c) === key);
      if (have) {
        have.discarded = true;
        have.worktree = null;
      } else if (d && d.row && d.row.provider) {
        // Studio still holds the closed connection for a while: its messages are readable. After that, only a note.
        const held = d.row.live && live.connections.find((l) => l.id === d.row.live.id);
        conversations.push(
          held
            ? { ...d.row, discarded: true, live: { ...held, closed: true, worktree: null } }
            : { ...d.row, discarded: true, live: undefined, key: 'discarded:' + key },
        );
      }
    }
    annotateElsewhere();
    if (selected) {
      const updated = conversations.find((c) => aliasKey(c) === aliasKey(selected));
      if (updated) selected = updated;
    }
    renderConversations();
    if (
      selected &&
      !current &&
      selected.live &&
      !selected.live.closed &&
      selected.live.ready !== false &&
      !continuingKey &&
      !newDraft
    ) {
      openConversation(selected).catch(fail);
    }
  }
  // Tool rows name a chat's folder in the project's words: its own copy (worktree) and its project folder map to the project.
  function notePlaces(list) {
    const TV = window.ToolViews,
      S = window.AgentSidebarUI;
    if (!TV?.notePlace) return;
    for (const c of list || []) {
      if (!c) continue;
      let name = '';
      try {
        name = S?.projectOf ? S.projectOf(c).name : '';
      } catch {
        name = '';
      }
      const lv = c.live || {},
        root = lv.projectRoot || c.projectRoot || '';
      name =
        name ||
        String(root || '')
          .split(/[\\/]/)
          .filter(Boolean)
          .pop() ||
        '';
      TV.notePlace(lv.cwd || c.cwd, name);
      TV.notePlace(root, name);
    }
  }
  function renderConversations() {
    notePlaces(conversations);
    window.AgentOrganizeUI?.flag?.(conversations);
    renderDiscover();
    if (newDraft && !selected) renderNewChat();
    window.AgentSidebarUI?.sync(conversations, selected);
    window.AgentWorkspaceUI?.sync(conversations, selected);
    const org = window.AgentOrganizeUI;
    org?.syncHeader(selected);
    const q = '';
    const rows = conversations
      .filter(
        (c) =>
          (provider === 'all' || c.provider === provider) &&
          window.AgentWorkspaceUI?.inProject(c) !== false &&
          `${titleOf(c)} ${c.cwd} ${c.id}`.toLowerCase().includes(q),
      )
      .sort(
        (a, b) =>
          Number(!!b.live) - Number(!!a.live) || (b.created || 0) - (a.created || 0) || a.key.localeCompare(b.key),
      );
    const signature = JSON.stringify([
      provider,
      q,
      window.AgentWorkspaceUI?.listSignature(),
      selected && aliasKey(selected),
      rows.map((c) => [
        c.key,
        titleOf(c),
        c.live?.busy,
        c.modified,
        c.subagentCount,
        !!c.recovered,
        !!(c.recovered?.reconnecting || c.live?.reconnecting),
        c.source,
        recoveredList.length,
        ownershipHints[c.provider + ':' + c.id]?.verdict,
        c.elsewhere && c.elsewhere.working,
        window.AgentSidebarUI?.rowSig(c),
        c.last?.text?.length || 0,
        !!window.AibTerminal?.hasSession(aliasKey(c)),
      ]),
      org ? org.signature() : '',
    ]);
    if (signature === sidebarSignature) return;
    sidebarSignature = signature;
    const box = $('connections'),
      top = box.scrollTop,
      emptyText = q ? 'No matching conversations.' : 'No saved conversations yet.';
    if (org)
      org.render(box, org.partition(rows), { buildRow: makeRow, all: conversations, provider, query: q, emptyText });
    else {
      box.replaceChildren(...rows.map(makeRow));
      if (!rows.length) box.append(text('p', emptyText, 'note'));
    }
    box.scrollTop = top;
    window.AgentSidebarUI?.watchTitles?.(box); // each title gets the room its card has (age moves down when it would cut it)
  }
  function makeRow(c) {
    const wrapper = text('div', '', 'conversation-row');
    const button = text(
      'button',
      '',
      'connection' + (selected && aliasKey(selected) === aliasKey(c) ? ' selected' : ''),
    );
    button.dataset.key = aliasKey(c);
    button.append(
      text('small', workspace(c), 'connection-workspace'),
      text('span', titleOf(c), 'connection-title'),
      rowStatus(c),
    );
    const termIcon = window.AibTerminal?.rowIcon(aliasKey(c));
    if (termIcon) button.querySelector('.connection-title')?.append(termIcon);
    button.title = c.cwd + '\n' + c.id;
    button.onclick = () => openConversation(c);
    button.addEventListener('pointerdown', (e) => window.AgentSplitUI?.startCardDrag(e, aliasKey(c)));
    let more = window.AgentOrganizeUI?.menuButton(c);
    if (!more) {
      more = text('button', '⋯', 'rename-chat');
      more.title = 'Rename conversation';
      more.setAttribute('aria-label', 'Rename ' + titleOf(c));
      more.onclick = () => startRename(c);
    }
    wrapper.append(button, more);
    return wrapper;
  }
  function beginConversation(c) {
    window.AgentWorkspaceUI?.noteOpened(c);
    connectionIssue = false;
    window.AgentOwnershipUI?.clear($('ownershipPrompt'));
    if (selected) keepDraft();
    $('prompt').value = drafts.get(aliasKey(c)) || '';
    document.body.classList.remove('subchat-open');
    $('subagentCount').textContent = '0';
    newDraft = null;
    window.ToolViews?.setScope?.(aliasKey(c)); // open tool rows and step groups belong to this chat
    notePlaces([c]);
    lastMainRows = [];
    document.body.classList.remove('new-chat');
    $('newChatBar').hidden = true;
    delete $('messages').dataset.paused;
    delete $('messages').dataset.unseen;
    $('messages')._userUp = false;
    syncJump();
    selected = c;
    renderAttachments();
    subSelection = null;
    selectedCommand = null;
    commands = [];
    showCommandHistory = false;
    commandSignature = '';
    children.clear();
    agents = [];
    snapshot = null;
    cursor = 0;
    eventsId = '';
    events = [];
    historyLimit = 120;
    rowExtra.main = 0;
    rowExtra.sub = 0;
    historyNoticeOn = false;
    actCounts = { subagents: 0, working: 0, failed: 0 };
    renderActivityStrip();
    mainSignature = '';
    subSignature = '';
    settingsSignature = '';
    approvalSignature = '';
    $('setup').hidden = true;
    $('chat').hidden = false;
    $('subchatPane').hidden = true;
    $('messages').hidden = false;
    $('renameCurrent').hidden = false;
    $('messages').replaceChildren(text('p', 'Loading conversation…', 'empty-state'));
    $('subagentList').replaceChildren();
    $('runningCommandList').replaceChildren();
    $('commandCount').textContent = '0';
    sessionStorage.setItem('studio-selected', c.key);
    clearError();
    renderHeader();
    $('historyNote').hidden = true;
  }
  async function openConversation(c) {
    current = c.live?.id || '';
    beginConversation(c);
    renderConversations();
    await refresh();
  }
  /* Why the Changes tab's Merge button may not ask this chat to merge (it never resumes a chat on its own), or ''. */
  function mergeBlockedReason(c) {
    if (!c) return '';
    if (c.elsewhere && !current) return 'This chat is open in another app. Merge it there';
    if (window.AgentOrganizeUI?.bucket?.(c) === 'archived')
      return 'This chat is archived. Unarchive it to merge its work';
    if (current && snapshot && snapshot.readOnly) return "This chat is read only, so it can't merge";
    if (!current || (snapshot && snapshot.closed)) return 'This chat is closed. Continue it to merge its work';
    return '';
  }
  function renderHeader() {
    syncChatPanels();
    if (!selected) return;
    window.AgentBreadth?.sync(current ? snapshot : null, breadthContext());
    renderHeaderBody();
  }
  // The panels that belong to the open chat (views, terminal, Files, Changes with its header chip and Merge / Discard,
  // Artifacts): fed on every header render, and when a New chat page replaces a chat, so none keeps the chat we left.
  function syncChatPanels() {
    window.ChatViewsUI?.sync();
    window.AibTerminal?.sync();
    window.AgentFilesUI?.sync(selected && (current || selected.id) ? selected : null);
    window.AgentChangesUI?.sync(
      selected && (current || selected.id)
        ? {
            id: current || selected.provider + ':' + selected.id,
            busy: !!(current && snapshot && !snapshot.closed && snapshot.busy),
            cwd: selected.cwd || '',
            discarded: isDiscarded(selected),
            mergeBlocked: mergeBlockedReason(selected),
          }
        : null,
    );
  }
  function renderHeaderBody() {
    if (!window.AgentHeaderUI?.isEditing?.()) $('title').textContent = titleOf(selected);
    const connected = !!current && snapshot && !snapshot.closed,
      images = selectedAttachments().length,
      hasContent = !!$('prompt').value.trim() || images > 0;
    const opening = continuingKey === aliasKey(selected),
      sending = sendingKey === aliasKey(selected),
      gone = isDiscarded(selected);
    $('prompt').disabled = opening || sending || gone;
    $('prompt').placeholder = gone ? DISCARDED_NOTE : 'Message ' + nameOf(selected.provider) + '… Enter to send';
    $('prompt').title = gone ? DISCARDED_NOTE : '';
    const busy = !!(connected && snapshot.busy);
    const queueMode = busy || (connected && snapshot?.queue?.items?.length > 0);
    $('send').textContent = opening ? 'Opening…' : queueMode ? 'Queue' : 'Send';
    $('send').hidden = false;
    $('send').disabled =
      gone ||
      (connected
        ? connectionIssue || sending || !hasContent || (images > 0 && !imageCapability())
        : opening || !selected.id || !selected.cwd || !hasContent);
    $('cancel').hidden = !busy;
    $('cancel').disabled = !busy;
    const turn = window.AgentAttentionUI?.render(
      { status: $('status'), line: $('turnStatus') },
      {
        key: current || selected.key,
        connectionIssue,
        opening,
        current,
        connected,
        snapshot,
        events,
        names: Object.fromEntries([...children].map(([id, agent]) => [id, agent.name])),
        yourTurn: headerYourTurn(),
        handledAt: handledAt.get(aliasKey(selected)),
        queueNote: queueLineNote(connected ? snapshot.queue : null, busy),
        hint: ownershipHints[selected.provider + ':' + selected.id],
        recovered: !!selected.recovered,
        reconnecting: !!(selected.recovered?.reconnecting || selected.live?.reconnecting),
        // The steady verdict (conversation.elsewhere, set by annotateElsewhere) is what the sidebar card reads too, so the
        // header and the card say the same words; the raw facts below only count while there is no steady verdict.
        elsewhere: selected.elsewhere,
        elsewhereWorking:
          !!window.AgentStatusWords?.elsewhereWorking(ownershipHints[selected.provider + ':' + selected.id]) ||
          actCounts.working > 0 ||
          commands.some(isRunningCommand),
      },
    );
    window.AgentQueueUI?.render(
      { box: $('queueBox'), connection: current, busy, post, refresh, fail },
      connected ? snapshot.queue : null,
    );
    if (queueMode) $('prompt').placeholder = 'Message ' + nameOf(selected.provider) + '… Enter to queue';
    $('markHandled').hidden = !(
      turn?.status?.kind === 'your-turn' && typeof window.AgentWorkspaceUI?.markHandled === 'function'
    );
    window.AgentComposerChips?.render(
      $('composerChips'),
      {
        id: current,
        settings: connected ? snapshot.settings : null,
        inUse: connected ? snapshot.inUse : null,
        pending: connected ? snapshot.pendingChanges : null,
        failures: connected ? snapshot.changeFailures : null,
        commands: snapshot?.breadth?.commands,
        usage: connected ? snapshot.breadth?.usage : null,
        limits: connected ? snapshot.limits : null,
        branch: gone ? '' : window.AgentHeaderUI?.branchOf(selected.cwd, renderHeader) || '',
        cwd: selected.cwd,
        agent: nameOf(selected.provider),
        agentId: selected.provider,
        account: selected.account || '',
        details: connected
          ? [...(window.AgentHeaderUI?.sessionDetails(snapshot) || []), ...(window.AgentChatView?.notices?.() || [])]
          : null,
      },
      {
        settingsPanel: $('settings'),
        disabled: !connected || snapshot?.closed,
        busy: !!snapshot?.busy,
        onMode: (modeId) => post('mode', { id: current, modeId }),
        onConfig: (configId, value, type) => post('config', { id: current, configId, value, type }),
        onCancelPending: (key) => post('cancel-pending', { id: current, key }),
        onInsertText: (text) => {
          const box = $('prompt');
          box.value = text;
          box.dispatchEvent(new Event('input'));
          box.focus();
        },
        onError: fail,
        afterChange: refresh,
      },
    );
    $('composerNote').textContent = connected
      ? queueMode
        ? 'Enter to queue it for when this turn ends · Shift+Enter for a new line · Interrupt stops the current turn; background work may continue.'
        : 'Enter to send · Shift+Enter for a new line · Interrupt stops the current turn; background work may continue.'
      : 'Enter to continue & send · Shift+Enter for a new line. Drafts are saved in this browser. Continue only after this conversation has stopped in other apps.';
    window.AgentOwnershipUI?.renderHint(
      $('ownershipHint'),
      selected,
      connected,
      ownershipHints[selected.provider + ':' + selected.id],
      ownershipCertainty,
    );
    if (window.AgentClashUI) {
      clashUi ||= window.AgentClashUI.init({ win: window });
      clashUi.sync(selected.worktree ? selected.projectRoot : '');
    }
    window.AgentOrganizeUI?.syncHeader(selected);
    window.AgentHeaderUI?.render({
      selected,
      connected,
      current,
      onChange: renderHeader,
      title: titleOf(selected),
      onRename: renameChat,
    });
    renderAttachments();
    applyElsewhereGuard();
    {
      const pageTitle = titleOf(selected) + ' · AIB';
      if (window.AgentSidebarUI) window.AgentSidebarUI.setBase(pageTitle);
      else document.title = pageTitle;
    }
  }
  function bubble(row) {
    if (row.role === 'user' && typeof row.value === 'string') {
      const shown = window.StreamUI?.stripViewContext?.(row.value);
      if (shown !== undefined && shown !== row.value) {
        if (!shown && !row.attachments?.length) {
          const none = document.createElement('div');
          none.hidden = true;
          return none;
        }
        row = { ...row, value: shown };
      }
      // The person's words plus injected reminders: the words are the message, the reminders a collapsed note inside it.
      // (A turn of reminders alone stays whole: classifyUser makes it a System note card below.)
      const split = window.StreamUI?.splitInjected?.(row.value);
      if (split && (split.text || row.attachments?.length))
        row = { ...row, value: split.text, injectedNote: split.note };
    }
    if (row.role === 'unknown-send')
      return window.UnknownSend.build(row.unknownSend, { again: resendUnknown, dismiss: dismissUnknown });
    const special = streamSpecial(row);
    if (special) return special;
    if (row.role === 'thinking' && row.value) {
      const d = document.createElement('details');
      d.className = 'thoughts';
      d.append(text('summary', 'Thoughts'), text('pre', row.value));
      return d;
    }
    if (window.ToolViews?.line && row.role === 'tool' && (row.raw || row.call)) {
      const line = window.ToolViews.line(row, () => bubbleFull(row));
      // a doc tool row: DOC label, "open ↗", the doc-created card (doc-links.js)
      const docRow = window.AgentDocLinks?.decorateToolRow ? window.AgentDocLinks.decorateToolRow(line, row) : line;
      if (docRow !== line || line.classList?.contains('doc-tool')) return docRow;
      return window.AgentArtifactsUI?.decorateToolRow ? window.AgentArtifactsUI.decorateToolRow(line, row) : line;
    }
    return bubbleFull(row);
  }
  // Studio's note after a merge whose re-applied user edits clash: "Keep my version" / "I'll sort it myself" (worktree_merge.resolve_clash).
  function clashButtons(actions) {
    const box = text('div', '', 'note-actions');
    const result = text('span', '', 'note-actions-result');
    for (const a of actions) {
      if (!a || !['keep-mine', 'leave'].includes(a.id)) continue;
      const button = text('button', a.label || a.id, 'note-action');
      button.type = 'button';
      button.addEventListener('click', async () => {
        for (const b of box.querySelectorAll('button')) b.disabled = true;
        try {
          const done = await post('worktree/clash', { id: current, action: a.id });
          result.textContent = done?.message || '';
        } catch (error) {
          result.textContent = error.message || 'Failed';
          for (const b of box.querySelectorAll('button')) b.disabled = false;
        }
        clashUi?.refresh();
      });
      box.append(button);
    }
    box.append(result);
    return box;
  }
  function bubbleFull(row) {
    const article = text('article', '', 'bubble ' + row.role);
    /* links or files with no words: a compact row whose time lines up with the box (and repeats only when it changes) */
    if (
      row.role === 'assistant' &&
      !row.value &&
      row.attachments?.length &&
      row.attachments.every((a) => a && a.type !== 'image' && a.type !== 'transcript-image')
    ) {
      article.classList.add('resource-only');
      article.dataset.when = date(row.time);
    }
    const head = text('div', '', 'bubble-head');
    /* the screen-reader name of a message: "You" for yours, live or saved (saved transcripts say "User") */
    head.append(text('strong', row.role === 'user' ? 'You' : row.label || row.role), text('time', date(row.time)));
    article.append(head);
    if (row.injectedNote && window.StreamUI?.noteCard)
      article.append(window.StreamUI.noteCard(row.injectedNote, row, resolveAgentName));
    if (row.role === 'tool' && (row.raw || row.call) && window.ToolViews)
      article.append(row.raw ? window.ToolViews.render(row.raw) : window.ToolViews.renderCall(row.call));
    else if (row.role === 'assistant' && row.value && window.AgentMarkdown) {
      const md = document.createElement('div');
      md.className = 'markdown';
      window.AgentMarkdown.render(md, row.value);
      article.append(md);
    } else if (['tool', 'result', 'error', 'assignment'].includes(row.role)) {
      const details = document.createElement('details');
      details.append(
        text('summary', (row.value || 'Details').replace(/\s+/g, ' ').slice(0, 160)),
        text('pre', row.value),
      );
      article.append(details);
    } else if (row.value && row.role === 'notice' && (row.label === 'error' || row.label === 'disconnected'))
      article.append(linkedPre(row.value)); // an agent's error often names a page to open (a plan to upgrade, a sign-in)
    else if (row.value) article.append(text('pre', row.value));
    if (row.actions?.length) article.append(clashButtons(row.actions));
    for (const [index, image] of (row.attachments || []).entries()) {
      if (image && image.type === 'studio_file') {
        article.append(window.AttachmentsUI.messageCard(image));
        continue;
      }
      if (image && image.type === 'transcript-image') {
        if (!/^\/api\/transcript\/image\?/.test(image.url)) continue;
        const picture = document.createElement('img');
        picture.className = 'message-image';
        picture.alt = 'Attached image ' + (index + 1);
        picture.loading = 'lazy';
        picture.src = image.url;
        window.ImageViewer?.makeViewable(picture, 'Attached image ' + (index + 1));
        article.append(picture);
        continue;
      }
      if (image && image.type !== 'image') {
        if (window.ToolViews) article.append(window.ToolViews.contentBlock(image));
        continue;
      }
      if (!safeImageBlock(image)) continue;
      const picture = document.createElement('img');
      picture.className = 'message-image';
      picture.alt = 'Attached image ' + (index + 1);
      picture.loading = 'lazy';
      picture.src = 'data:' + image.mimeType + ';base64,' + image.data;
      window.ImageViewer?.makeViewable(picture, 'Attached image ' + (index + 1));
      article.append(picture);
    }
    return window.CopyUI ? window.CopyUI.decorate(article, row) : article;
  }
  function safeImageBlock(image) {
    return (
      image?.type === 'image' &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType) &&
      typeof image.data === 'string' &&
      image.data.length <= 7 * 1024 * 1024 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    );
  }
  window.safeImageBlock =
    safeImageBlock; /* tool-views.js looks for window.safeImageBlock when it draws image blocks (it has a copy of the same rule as a fallback) */
  /* While you read older messages (follow paused), a re-render keeps the message at the top of your view in the same spot,
   instead of the same scroll distance: rows dropping off the top, clamping and images loading would otherwise push it away. */
  function rowPrint(el) {
    return (el.className || '') + '|' + String(el.textContent || '').slice(0, 200);
  }
  function scrollAnchor(box) {
    const top = box.getBoundingClientRect().top;
    for (const el of box.children) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 1) return { print: rowPrint(el), off: r.top - top };
    }
    return null;
  }
  /* Several rows can print the same ("Show steps (1 tool call)"): the one nearest its old place is the one you were reading. */
  function restoreAnchor(box, anchor) {
    if (!anchor) return false;
    const top = box.getBoundingClientRect().top;
    let move = null;
    for (const el of box.children)
      if (rowPrint(el) === anchor.print) {
        const d = el.getBoundingClientRect().top - top - anchor.off;
        if (move === null || Math.abs(d) < Math.abs(move)) move = d;
      }
    if (move === null) return false;
    box.scrollTop += move;
    return true;
  }
  function holdAnchor(box, anchor, held, after) {
    if (!anchor) return;
    let expect = box.scrollTop;
    const again = () => {
      if (!(held ? held() : box.dataset.paused) || Math.abs(box.scrollTop - expect) > 2) return;
      restoreAnchor(box, anchor);
      expect = box.scrollTop;
      if (after) after();
    };
    for (const ms of [60, 250, 800]) setTimeout(again, ms);
    for (const img of box.querySelectorAll('img'))
      if (!img.complete) img.addEventListener('load', again, { once: true });
  }
  /* extra (main only): {earlier: older history is not loaded, working: the agent is on a turn, live: what it is doing (the live line),
     find: {q, stubs} the Prompts find box}, used by the condensed views. Only working, earlier and find change the signature:
     the live line's step and clock are updated in place, so the pane is not drawn again every second. */
  function showRows(box, rows, signatureKey, extra) {
    const view = signatureKey === 'main' && window.ChatViews ? viewOf() : 'full',
      condensed = view !== 'full',
      find = view === 'prompts' ? extra?.find || null : null;
    if (signatureKey === 'main') lastMainRows = condensed ? rows.slice(-500) : rows;
    const signature =
      (window.StreamUI ? window.StreamUI.rowsSignature(rows) : JSON.stringify(rows)) +
      '|' +
      rowExtra[signatureKey] +
      '|' +
      thinkingOn() +
      '|' +
      view +
      (condensed ? '|' + (extra?.working ? 1 : 0) + (extra?.earlier ? 1 : 0) + (extra?.live?.talking ? 1 : 0) : '') +
      (find ? '|' + find.q + '|' + find.stubs.map((h) => h.index).join(',') : '');
    if (signatureKey === 'main' && condensed && extra?.live) window.ChatViewsUI.refreshLive(box, extra.live);
    if (
      window.CopyUI?.holdRender(box) &&
      !(signatureKey === 'main' && pendingSwitch) /* a view switch repaints even while text is selected */ &&
      ((signatureKey === 'main' && mainSignature !== signature) ||
        (signatureKey === 'sub' && subSignature !== signature))
    )
      return;
    if (signatureKey === 'main' && mainSignature === signature) return;
    if (signatureKey === 'sub' && subSignature === signature) return;
    if (signatureKey === 'main') mainSignature = signature;
    else subSignature = signature;
    const ctl = managed(box);
    if (ctl) ctl.beforeRedraw(); // a scroll you made that the browser has not reported yet counts before anything is redrawn
    const top = box.scrollTop,
      anchor = !ctl && box.dataset.paused ? scrollAnchor(box) : null;
    /* (kept rows keep their own open state: only the old path opens <details> again by index) */
    const opens =
      condensed || ctl
        ? []
        : [...box.querySelectorAll('details')].map((d, i) => (d.open ? i : -1)).filter((i) => i >= 0);
    const fragment = document.createDocumentFragment();
    if (!rows.length && view !== 'prompts') fragment.append(text('p', 'No messages saved yet.', 'empty-state'));
    const proj = condensed
      ? window.ChatViews.project(rows, view, {
          earlier: !!extra?.earlier,
          working: !!extra?.working,
          live: extra?.live || null,
        })
      : null;
    if (proj && find) proj.units = proj.units.filter((u) => window.ChatViews.promptMatches(u.prompt, find.q));
    /* "Show earlier" counts rows in Full and prompt groups in a condensed view */
    const total = proj ? proj.units.length : rows.length,
      windowOf = (n, more) =>
        proj ? window.StreamUI.windowRows(n, more, GROUP_WINDOW, GROUP_WINDOW) : window.StreamUI.windowRows(n, more);
    let win = window.StreamUI ? windowOf(total, rowExtra[signatureKey] || 0) : { start: 0, hidden: 0 };
    const reading = ctl ? !ctl.following : !!box.dataset.paused;
    /* while you read older messages, the visible window does not slide forward under you */ if (
      reading &&
      Number.isInteger(box._winStart) &&
      win.start > box._winStart
    ) {
      rowExtra[signatureKey] = (rowExtra[signatureKey] || 0) + win.start - box._winStart;
      win = windowOf(total, rowExtra[signatureKey]);
    }
    /* and the row you read is always drawn (a chat or subagent opened again where you left it) */
    if (ctl && reading && win.start > 0) {
      const at = ctl.anchorIndex(proj ? proj.units.map((u) => unitRid(u)) : rows.map((r) => r.rid || ''));
      if (at >= 0 && at < win.start) {
        rowExtra[signatureKey] = (rowExtra[signatureKey] || 0) + win.start - at;
        win = windowOf(total, rowExtra[signatureKey]);
      }
    }
    box._winStart = win.start;
    const shown = !proj && win.start ? rows.slice(win.start) : rows;
    if (win.hidden) {
      const more = () => {
        const h = box.scrollHeight,
          y = box.scrollTop;
        if (ctl) ctl.anchorTop('earlier'); // the row under the button stays put while older rows are drawn above it
        rowExtra[signatureKey] = win.nextExtra;
        if (signatureKey === 'main') mainSignature = '';
        else subSignature = '';
        showRows(box, rows, signatureKey, extra);
        if (!ctl) box.scrollTop = box.scrollHeight - h + y;
      };
      fragment.append(
        proj
          ? window.ChatViewsUI.earlierButton(win.hidden, win.reveal, more)
          : window.StreamUI.earlierButton(win.hidden, win.reveal, more),
      );
    }
    let flat = shown;
    /* every drawn row carries its stable id (data-rid, tagRow); main list rows also their index in rows (data-ri) */
    const index = signatureKey === 'main' ? new Map(rows.map((r, i) => [r, i])) : null,
      tag = (render) => (row) => {
        const el = tagRow(row, render(row));
        if (index && el && el.dataset && index.has(row)) el.dataset.ri = index.get(row);
        return el;
      };
    if (proj) {
      const ctx = {
        bubble: tag(viewBubble),
        groupRows: (list, render) => window.ToolViews?.groupRows?.(list, render) || list.map(render),
      };
      if (view === 'prompts')
        fragment.append(
          ...window.ChatViewsUI.promptNodes(proj, win.start, {
            ...ctx,
            stubs: find ? find.stubs : [],
            query: find ? find.q : '',
            openHit,
            onOpen: promptOpened,
          }),
        );
      else fragment.append(...window.ChatViewsUI.listNodes(proj, win.start, ctx));
      flat = window.ChatViewsUI.flatFrom(proj, win.start);
    } else {
      const docked = box.id === 'messages' ? dockedPlan(rows) : null,
        drawn = docked ? planLast(shown, rows, docked) : box.id === 'messages' ? latestPlanOnly(shown, rows) : shown;
      const draw = tag(box.id === 'messages' && window.ChatViews ? viewBubble : bubble);
      if (window.ToolViews?.groupRows) fragment.append(...window.ToolViews.groupRows(drawn, draw));
      else for (const row of drawn) fragment.append(draw(row));
    }
    if (window.StreamUI?.patchChildren) window.StreamUI.patchChildren(box, fragment);
    else box.replaceChildren(fragment);
    for (const i of opens) if (box.querySelectorAll('details')[i]) box.querySelectorAll('details')[i].open = true;
    placeNewLine(box, flat, rows);
    if (ctl) ctl.afterRedraw();
    else if (followBox(box)) box.scrollTop = box.scrollHeight;
    else if (UNREAD.scrollLine && box.id === 'messages') {
      UNREAD.scrollLine = false;
      const l = box.querySelector(':scope > .new-line');
      box.scrollTop = l
        ? box.scrollTop + l.getBoundingClientRect().top - box.getBoundingClientRect().top - 12
        : box.scrollHeight;
    } else {
      box.scrollTop = top;
      if (restoreAnchor(box, anchor)) holdAnchor(box, anchor);
    }
    if (signatureKey === 'main' && pendingSwitch) {
      /* a view change: stay at the bottom if you were there, else keep the topmost visible prompt where it was */
      const s = pendingSwitch;
      pendingSwitch = null;
      if (s.bottom) {
        delete box.dataset.paused;
        box.scrollTop = box.scrollHeight;
        viewAnchor = null;
      } else {
        const key = curKey(),
          put = () => {
            if (!restoreRowAnchor(box, s.anchor?.row)) window.ChatViewsUI.restoreAnchor(box, s.anchor?.pk);
            viewAnchor = { key, anchor: s.anchor, top: box.scrollTop };
          };
        put();
        /* clamping and pictures settle after the repaint: put the row back while nothing else moved the list */
        for (const ms of [60, 250])
          setTimeout(() => {
            if (
              viewAnchor?.anchor === s.anchor &&
              viewAnchor.key === curKey() &&
              Math.abs(box.scrollTop - viewAnchor.top) <= 2
            )
              put();
          }, ms);
      }
    }
    markRepeatedTimes(box);
    if (!ctl) resumeIfAtEnd(box);
    if (box.id === 'messages') {
      syncJump();
      updatePlanDock(rows);
      announceTurns(box, selected ? aliasKey(selected) : '', rows, '');
    }
  }
  /* A drawn row carries its row's stable id (data-rid: 'L:' + event number, 'T:' + transcript index), the same in the main list,
     a split pane and every view, so the scroll controller (scroll-controller.js) can find the row you read again. */
  function tagRow(row, el) {
    if (row && row.rid && el && el.dataset && !el.dataset.rid) el.dataset.rid = row.rid;
    return el;
  }
  const tagged = (render) => (row) => tagRow(row, render(row));
  /* The id a condensed view's unit (a prompt and what follows) answers to: its prompt's, else its first row's. */
  const unitRid = (u) => (u.prompt && u.prompt.rid) || ((u.rows || [])[0] || {}).rid || '';
  /* Several link/file rows in a row with the same time: the time shows on the first one only. */
  function markRepeatedTimes(box) {
    let prev = null;
    for (const el of box.children) {
      const resource = !!el.classList?.contains?.('resource-only');
      if (resource && prev && prev.dataset.when === el.dataset.when)
        el.querySelector(':scope > .bubble-head > time')?.remove();
      prev = resource ? el : null;
    }
  }
  /* The main list's bubbles: a prompt carries its key (time + text hash) so a view change can anchor to it. */
  function viewBubble(row) {
    const el = bubble(row);
    if (row.role === 'user' && el.dataset && window.ChatViews.isPrompt(row))
      el.dataset.pk = 'p:' + window.ChatViews.promptKey(row);
    return el;
  }
  /* Screen readers: #messages is not a live region (it would read every streamed word again and again). Instead each finished agent
   message is read out once, through one visually hidden live region that lives outside <main>, so it serves the main view and every split pane.
   `holder` remembers the newest message already announced; the first call for a chat only sets that baseline. */
  function announceTurns(holder, chatKey, rows, prefix) {
    const SU = window.StreamUI,
      region = document.getElementById('liveAnnounce');
    if (!SU?.newTurns || !region) return;
    if (holder._announceChat !== chatKey) {
      holder._announceChat = chatKey;
      holder._announced = null;
    }
    const found = SU.newTurns(rows, holder._announced);
    holder._announced = found.key;
    if (!found.announce.length) return;
    region.textContent =
      (prefix ? prefix + ': ' : '') +
      found.announce
        .slice(-3)
        .map((r) => String(r.value).replace(/\s+/g, ' ').trim().slice(0, 400))
        .join(' ');
  }
  function transcriptImage(e, key) {
    if (!key || !Array.isArray(e.images)) return undefined;
    const out = e.images
      .filter((im) => im && Number.isInteger(im.n) && Number.isInteger(im.i))
      .map((im) => ({
        type: 'transcript-image',
        mimeType: im.mediaType,
        url:
          '/api/transcript/image?' +
          new URLSearchParams(Number.isInteger(im.j) ? { key, n: im.n, i: im.i, j: im.j } : { key, n: im.n, i: im.i }),
      }));
    return out.length ? out : undefined;
  }
  function normalized(data, key, dock) {
    const toRow = (e) => ({
      role: e.kind,
      label: e.label,
      value: e.text,
      time: e.replay ? 0 : e.time,
      callId: e.callId,
      intent: e.intent,
      attachments: transcriptImage(e, key),
    });
    /* data.context: older events the plan fold needs (the update_plan that set the plan, background launches...) from before this page. They are folded, never drawn. */
    /* row ids: 'T:' + the event's index in the whole transcript (data.start: the window's first), stable when older pages load */
    const base = Number.isFinite(data.start) ? data.start : 0,
      ctx = (data.context || []).map((e, i) => ({ ...toRow(e), ctx: true, rid: 'C:' + i })),
      rows = data.events
        .map((e, i) => (thinkingOn() || e.kind !== 'thinking' ? { ...toRow(e), rid: 'T:' + (base + i) } : null))
        .filter(Boolean);
    const paired = window.ToolViews?.pairSaved ? window.ToolViews.pairSaved([...ctx, ...rows]) : [...ctx, ...rows];
    markRunningCall(paired, key);
    const out = window.PlanUI ? window.PlanUI.fold(paired, { working: savedWorking(key) }) : paired;
    /* Only the main view's pinned plan keeps a plan card from the context, and only while it has work left; everything else from the context is dropped. */
    return ctx.length
      ? out.filter((r) => !r.ctx || (dock && r.role === 'plan' && r.entries.some((x) => x.status !== 'completed')))
      : out;
  }
  /* A saved transcript has no live tool status: a call without a result is shown as pending (•). While the chat is shown
     "Elsewhere · Working" (the same steady conversation.elsewhere the header and card read), its last call is the one the
     other app is running: call.running makes ToolViews draw it as running. */
  function markRunningCall(rows, key) {
    const c = conversations.find((x) => x.key === key);
    if (!elsewhereLocked(c)) return;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.ctx || r.role !== 'tool' || !r.call) continue;
      if (!r.call.result) r.call.running = true;
      return;
    }
  }
  function savedWorking(key) {
    const c = conversations.find((x) => x.key === key);
    if (!c) return false;
    return !!(
      c.live?.busy ||
      window.AgentStatusWords?.elsewhereWorking?.(ownershipHints[c.provider + ':' + c.id]) ||
      (c.elsewhere && c.elsewhere.working)
    );
  }
  function liveRows(session, evs = events, snap = snapshot, uncapped = false) {
    const rows = [],
      tools = new Map(), // toolCallId -> {row, turn}
      uses = new Map(), // toolCallId -> how many calls used it
      asks = new Map(); // approval / question key -> its record row
    let turn = 0,
      at = -1;
    for (const event of evs) {
      at++;
      /* every row carries a stable id: 'L:' + the event number of its first event (a merged message keeps its first chunk's,
         a step its tool_call's), so the same chat has the same ids in the main list, a split pane and every view */
      const rid = 'L:' + (Number.isFinite(event.seq) ? event.seq : at);
      let role,
        label,
        value,
        actions,
        attachments = [];
      const sid = event.data?.sessionId || snap?.sessionId;
      if (sid !== session) continue;
      if (event.kind === 'user') {
        turn++;
        role = 'user';
        label = 'You';
        value = event.data.text;
        attachments = [...(event.data.attachments || []), ...(window.AttachmentsUI?.eventFiles(event.data) || [])];
      } else if (event.kind === 'update') {
        const u = event.data.update || {},
          kind = u.sessionUpdate;
        if (['agent_message_chunk', 'user_message_chunk', 'agent_thought_chunk'].includes(kind)) {
          role = kind === 'agent_thought_chunk' ? 'thinking' : kind === 'user_message_chunk' ? 'user' : 'assistant';
          label = role === 'user' ? 'You' : role === 'thinking' ? 'Thinking' : 'Assistant';
          value = u.content?.text || '';
          if (safeImageBlock(u.content) || ['resource_link', 'resource', 'audio'].includes(u.content?.type))
            attachments = [u.content];
        } else if (['tool_call', 'tool_call_update'].includes(kind)) {
          const key = u.toolCallId;
          let old = tools.get(key);
          /* Some agents number their calls per turn: a new call that reuses an id from an earlier turn is its own row. */
          if (old && kind === 'tool_call' && old.turn !== turn) old = null;
          else if (old) old = old.row;
          if (old) {
            old.raw = { ...old.raw, ...u };
            old.label = (old.raw.title || key) + ' · ' + (old.raw.status || 'started');
            old.value = JSON.stringify(old.raw, null, 2).slice(0, 40000);
            old.rev = (old.rev || 0) + 1;
            continue;
          }
          role = 'tool';
          label = (u.title || key) + ' · ' + (u.status || 'started');
          value = JSON.stringify(u, null, 2).slice(0, 40000);
          const row = { role, label, value, time: event.replay ? 0 : event.time, raw: u, rid },
            n = (uses.get(key) || 0) + 1;
          uses.set(key, n);
          if (n > 1) row.uid = key + '#' + n;
          tools.set(key, { row, turn });
          rows.push(row);
          continue;
        } else if (kind === 'plan') {
          rows.push({
            role: 'plan',
            label: 'Plan',
            rid,
            time: event.replay ? 0 : event.time,
            entries: Array.isArray(u.entries) ? u.entries : [],
            value: (u.entries || []).map((e) => e.status + ': ' + e.content).join('\n'),
          });
          continue;
        } else if (kind === 'session_message') {
          role = 'notice';
          label = 'Delegation';
          value = JSON.stringify(u.content || u, null, 2);
        } else continue;
      } else if (event.kind === 'permission' || event.kind === 'elicitation') {
        /* An approval or a question: once it is answered its card goes, and this compact line stays in the chat. */
        const key = event.data?.key;
        if (typeof key === 'string' && key) {
          const row = {
            role: 'answered',
            ask: event.kind,
            key,
            rid,
            params: event.data.params || {},
            time: event.replay ? 0 : event.time,
          };
          asks.set(key, row);
          rows.push(row);
        }
        continue;
      } else if (event.kind === 'request_withdrawn') {
        const row = asks.get(event.data?.key);
        if (row) row.withdrawn = true;
        continue;
      } else if (event.kind === 'error' || event.kind === 'disconnected') {
        role = 'notice';
        label = event.kind;
        value = event.data.message;
      } else if (event.kind === 'studio_note') {
        role = 'notice';
        label = 'AIB';
        value = event.data.message;
        if (Array.isArray(event.data.actions) && event.data.actions.length) actions = event.data.actions;
      } else if (event.kind === 'turn_end') {
        turn++;
        role = 'turn-end';
        label = 'Turn finished';
        value = event.data.stopReason || 'end_turn';
      } else continue;
      if ((!value && !attachments.length) || (role === 'thinking' && !thinkingOn())) continue;
      const last = rows.at(-1);
      if (role === 'user' && last?.role === 'user' && last.value === value && !attachments.length) continue;
      if (
        last?.role === role &&
        ['assistant', 'thinking'].includes(role) &&
        !attachments.length &&
        !last.attachments?.length
      ) {
        last.value += value;
        last.rev = (last.rev || 0) + 1;
      } else
        rows.push({
          role,
          label,
          value,
          time: event.replay ? 0 : event.time,
          attachments,
          rid,
          ...(actions ? { actions } : {}),
        });
    }
    if (asks.size) {
      /* still waiting (its card is up) or withdrawn by the agent: no record line */
      const open = new Set([...(snap?.permissions || []), ...(snap?.elicitations || [])].map((p) => p && p.key));
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.role !== 'answered') continue;
        if (open.has(r.key) || r.withdrawn) rows.splice(i, 1);
        else r.value = answeredText(r);
      }
    }
    /* In-progress steps spin while work is going on for this chat: its own reply, or helpers still running after the reply ended. */
    const helpersWorking = Object.values(snapshot?.subagents || {}).some((a) => a && agentIsActive({ ...a, live: true }));
    const folded = window.PlanUI ? window.PlanUI.fold(rows, { live: true, working: !!snapshot?.busy || helpersWorking }) : rows;
    return uncapped ? folded : folded.slice(-500); // a condensed view caps after it has projected (views.js), so the latest prompt is never cut off
  }
  /* What you chose on an approval or a question card, by request key (this page only; another window's answer reads "Answered"). */
  const answerChoice = new Map();
  function answeredText(r) {
    const p = r.params || {},
      chose = answerChoice.get(r.key);
    if (r.ask === 'permission') {
      const call = p.toolCall || {},
        what = String(call.title || call.kind || 'a tool')
          .replace(/\s+/g, ' ')
          .slice(0, 120);
      return 'Approval · ' + what + ' · ' + (chose || 'Answered');
    }
    const what = String(p.message || (p.mode === 'url' ? 'A link' : 'A question'))
      .replace(/\s+/g, ' ')
      .slice(0, 120);
    return 'Question · ' + what + ' · ' + (chose || 'Answered');
  }
  function answeredLine(row) {
    const line = text('div', '', 'answered-line');
    line.setAttribute('role', 'note');
    line.append(text('span', '✓', 'answered-mark'), text('span', row.value, 'answered-text'));
    const when = window.StreamUI?.shortTime?.(row.time);
    if (when) line.append(text('time', when));
    return line;
  }
  // Messages whose delivery is unknown after a restart: shown as a bubble with one amber line (unknown-send.js), cleared once the agent shows them.
  function withUnknownSends(rows, unknown) {
    const U = window.UnknownSend;
    if (!U || !unknown?.length) return rows;
    const seen = new Set(
      events.filter((e) => e.kind === 'user' && e.data?.clientMessageId).map((e) => e.data.clientMessageId),
    );
    const items = U.plan(
      unknown,
      pendingRecords(),
      rows.filter((r) => r.role === 'user'),
      seen,
    );
    return items.length
      ? [...rows, ...items.map((item, n) => ({ role: 'unknown-send', unknownSend: item, rid: 'P:' + n }))]
      : rows;
  }
  async function dismissUnknown(item) {
    try {
      await post('dismiss-unknown', { id: current, clientMessageId: item.id });
      await refresh();
    } catch (error) {
      fail(error);
    }
  }
  async function resendUnknown(item) {
    if (!current || sendingKey) return;
    try {
      const queued = snapshot && (snapshot.busy || snapshot.queue?.items?.length);
      await post(queued ? 'queue' : 'prompt', {
        id: current,
        text: item.text,
        clientMessageId: window.UnknownSend.newId(),
        attachments: item.attachments || [],
      });
      await post('dismiss-unknown', { id: current, clientMessageId: item.id });
      await refresh();
    } catch (error) {
      fail(Error(error.message + ' The warning stays until the message is sent or dismissed.'));
    }
  }
  function collectChildren() {
    events.forEach((e) => {
      if (e.kind !== 'update') return;
      const u = e.data.update || {};
      if (u.sessionUpdate === 'subagent_update') {
        const child = u.subagent || u;
        const id = child.sessionId || child.subagentSessionId;
        if (id && id !== snapshot.sessionId) {
          const old = children.get(id);
          const next = {
            ...old,
            key: id,
            name: subagentTitle(child, old, id),
            description: child.description || old?.description || '',
            capabilities: child.capabilities || old?.capabilities || {},
            live: true,
            created: old?.created || e.time,
            state: child.state || child.status || old?.state || 'Available',
          };
          window.SubagentsUI?.enrich(next, old, child, e.time);
          children.set(id, next);
        }
      }
      const sid = e.data.sessionId;
      if (sid && sid !== snapshot.sessionId && !children.has(sid))
        children.set(sid, {
          key: sid,
          name: 'Subagent ' + sid.slice(0, 8),
          live: true,
          created: e.time,
          state: 'Live stream',
        });
      if (sid && sid !== snapshot.sessionId) {
        window.SubagentsUI?.noteEvent(children.get(sid), e);
      }
    });
    // Model, tokens and what each helper is doing now (subagents-ui.js details); a part not known now keeps what was known before.
    const facts = window.SubagentsUI?.details?.(events, snapshot.sessionId);
    if (facts)
      for (const [id, d] of facts) {
        const c = children.get(id);
        if (!c) continue;
        children.set(id, {
          ...c,
          model: d.model || c.model || '',
          tokens: d.tokens || c.tokens || 0,
          activity: d.activity || c.activity || '',
          agentType: c.agentType || d.agentType || '',
        });
      }
    /* Interrupt stops the main reply, not the helpers: a subagent keeps the state the agent last reported. claude-agent-acp
       (subagents form, which AIB declares) lets background helpers run on after session/cancel and reports every child it does
       stop as {state: 'idle', stopReason: 'cancelled'} (shown as Stopped). A helper silent since the interrupt is usually busy in a
       long command, so it is never guessed Interrupted. */
  }
  function agentIsActive(a) {
    if (!a.live) return !!a.active;
    const raw = a.state;
    const value =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? (raw.state ?? raw.status ?? raw.phase ?? raw.name ?? '')
          : '';
    return /^(running|working|in[-_ ]progress|active|starting|queued|busy|streaming)$/i.test(String(value).trim());
  }
  function agentCreated(a) {
    const raw = a.created ?? a.createdAt ?? a.created_at ?? a.timestamp;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function sortAgents(rows) {
    return rows
      .map((agent, index) => ({
        agent,
        index,
        active: agentIsActive(agent),
        created: agentCreated(agent),
        key: String(agent.key ?? agent.id ?? ''),
      }))
      .sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          b.created - a.created ||
          a.key.localeCompare(b.key) ||
          a.index - b.index,
      )
      .map((row) => row.agent);
  }
  function agentStateLabel(a) {
    if (!a.live)
      return a.finished === true
        ? 'Finished'
        : a.active
          ? 'Written recently · not confirmed running'
          : a.finished === false
            ? 'Not marked finished'
            : 'No recent writes';
    const raw = a.state;
    if (typeof raw === 'string') return raw;
    const value = raw && typeof raw === 'object' ? (raw.state ?? raw.status ?? raw.phase ?? raw.name) : '';
    const state = String(value || '').trim();
    if (!state) return 'Available';
    return (
      {
        running: 'Working',
        working: 'Working',
        active: 'Active',
        busy: 'Working',
        idle: 'Idle',
        completed: 'Completed',
        complete: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled',
        canceled: 'Cancelled',
        queued: 'Queued',
        starting: 'Starting',
        'in-progress': 'In progress',
      }[state.toLowerCase()] || state
    );
  }
  /* The chat's own model id: what its replies come from (inUse), else the model setting it advertises; for a saved chat, the main
     transcript's model. A helper that names no model shows this one. */
  function chatModel() {
    if (current && snapshot) {
      if (typeof snapshot.inUse?.model === 'string' && snapshot.inUse.model.trim()) return snapshot.inUse.model;
      try {
        const chip = window.AgentComposerChips?.describe({ settings: snapshot.settings || null })?.chips?.find(
          (c) => c.id === 'model',
        );
        return typeof chip?.value === 'string' ? chip.value : '';
      } catch {
        return '';
      }
    }
    const main = agents.find((a) => a.main);
    return typeof main?.model === 'string' ? main.model : '';
  }
  function renderAgents() {
    const rows = sortAgents(current ? [...children.values()] : agents.filter((a) => !a.main));
    if (window.SubagentsUI) {
      window.SubagentsUI.render({
        box: $('subagentList'),
        countEl: $('subagentCount'),
        rows,
        now: Date.now() / 1000,
        convKey: selected?.key || '',
        selectedKey: subSelection?.key,
        chatModel: chatModel(),
        empty: 'No subagents yet',
        onModel: (m) => {
          actCounts = { subagents: m.top.length + m.done.length, working: m.working.length, failed: m.failed };
          renderActivityStrip();
        },
        onOpen: toggleSubagent,
        rerender: renderAgents,
      });
      return;
    }
    $('subagentCount').textContent = rows.length;
    const box = $('subagentList'),
      existing = new Map([...box.children].map((n) => [n.dataset.key, n]));
    for (const [index, a] of rows.entries()) {
      let button = existing.get(a.key);
      if (!button) {
        button = text('button', '', 'subagent-card');
        button.dataset.key = a.key;
        button.onclick = () => toggleSubagent(a);
      }
      existing.delete(a.key);
      button.className = 'subagent-card' + (subSelection?.key === a.key ? ' selected' : '');
      button.replaceChildren(
        text('strong', a.name),
        agentBadge(a),
        text(
          'p',
          (
            (a.description && a.description !== a.name ? a.description : '') ||
            a.last?.text ||
            a.last?.intent ||
            a.model ||
            ''
          )
            .replace(/\s+/g, ' ')
            .slice(0, 140),
        ),
      );
      if (box.children[index] !== button) box.insertBefore(button, box.children[index] || null);
    }
    for (const node of existing.values()) node.remove();
    if (!rows.length)
      box.replaceChildren(
        text(
          'p',
          current
            ? 'Subagents will appear here when the agent delegates work.'
            : 'No saved subagents in this conversation.',
          'empty-state',
        ),
      );
  }
  let rowExtra = { main: 0, sub: 0 };
  let subTrail = [],
    subFetch = { key: '', at: 0 },
    subLinksSignature = '',
    actCounts = { subagents: 0, working: 0, failed: 0 };
  /* The Activity tab's count: subagents working right now, like Changes and Artifacts show theirs. */
  function paintActivityTabBadge() {
    const tab = $('paneTab-activity');
    if (!tab) return;
    let b = tab.querySelector('.pane-badge');
    if (!b) {
      b = document.createElement('span');
      b.className = 'pane-badge';
      tab.append(b);
    }
    const n = actCounts.working;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = !n;
    tab.setAttribute('aria-label', 'Activity' + (n ? ', ' + n + (n === 1 ? ' subagent' : ' subagents') + ' working' : ''));
  }
  function renderActivityStrip() {
    window.ActivityUI?.renderStrip($('activityChips'), {
      ...actCounts,
      processes: commands.filter(isRunningCommand).length,
    });
    paintActivityTabBadge();
  }
  function allAgentRows() {
    return current ? [...children.values()] : agents.filter((a) => !a.main);
  }
  function pushTrail() {
    if (subSelection) subTrail.push({ agent: subSelection });
    else if (selectedCommand) subTrail.push({ command: selectedCommand.id });
  }
  async function openSubagent(agent, keepTrail) {
    if (!current && !selected) {
      closeInspector();
      return;
    }
    if (keepTrail === true) pushTrail();
    else subTrail = [];
    selectedCommand = null;
    $('commandDetails').hidden = true;
    $('submessages').hidden = false;
    $('inspectorEyebrow').textContent = 'SUBAGENT HISTORY';
    $('inspectorNote').textContent = 'Read-only history. Messages are sent through the main agent.';
    subSelection = agent;
    managed($('submessages'))?.switchTo(agent.key, () => window.ScrollController.FOLLOW); // each subagent keeps its own place
    rowExtra.sub = 0;
    subSignature = '';
    subLinksSignature = '';
    subFetch = { key: '', at: 0 };
    $('subchatPane').hidden = false;
    document.body.classList.add('subchat-open');
    window.AgentChangesUI?.show('activity'); // the history lives in the Activity tab
    window.ActivityUI?.drill(true);
    renderSubHead();
    renderAgents();
    renderCommands();
    await refreshSubagent();
  }
  async function subBack() {
    const prev = subTrail.pop();
    if (!prev) {
      closeAndRefocus();
      return;
    }
    const keep = subTrail;
    if (prev.agent) await openSubagent(allAgentRows().find((r) => r.key === prev.agent.key) || prev.agent);
    else await openCommand(prev.command);
    subTrail = keep;
    renderSubHead();
  }
  function renderSubHead() {
    const box = $('subchatLinks');
    if (!subSelection) {
      box.hidden = true;
      return;
    }
    const rows = allAgentRows(),
      row = rows.find((r) => r.key === subSelection.key) || subSelection;
    subSelection = row;
    const h = window.SubagentsUI?.header(row, Date.now() / 1000, chatModel());
    if (h) {
      $('subchatTitle').textContent = h.title;
      $('subchatStatus').textContent = window.SubagentsUI.subtitle(h, row.live);
    }
    const kids = window.SubagentsUI?.childrenOf(rows, row) || [],
      mine = commands.filter((t) => t.agentKey === row.key).slice(0, 6);
    const signature = JSON.stringify([
      kids.map((k) => [k.key, k.name, k.runningCommands]),
      mine.map((t) => [t.id, t.title, t.status]),
    ]);
    if (signature === subLinksSignature) return;
    subLinksSignature = signature;
    box.hidden = !(kids.length || mine.length);
    if (box.hidden) {
      box.replaceChildren();
      return;
    }
    const frag = document.createDocumentFragment();
    if (kids.length) {
      frag.append(text('h3', 'Subagents started by this one'));
      for (const k of kids) {
        const b = text('button', window.SubagentsUI?.names(k).title || k.name, 'sub-link');
        b.type = 'button';
        b.onclick = () => openSubagent(k, true);
        frag.append(b);
      }
    }
    if (mine.length) {
      frag.append(text('h3', 'Commands'));
      for (const t of mine) {
        const b = text('button', '', 'sub-link');
        b.type = 'button';
        b.append(
          text('span', t.title, 'sub-link-title'),
          text(
            'span',
            isRunningCommand(t) ? 'running' : t.status,
            'sub-link-state' + (isRunningCommand(t) ? ' running' : ''),
          ),
        );
        b.onclick = () => openCommand(t.id, true);
        frag.append(b);
      }
    }
    box.replaceChildren(frag);
  }
  /* QA m11: a saved chat whose transcript launched a subagent (an Agent / Task call) lists it even when Studio found no transcript
     file of its own for it (the roster only knows subagents with a file). Such a row opens to a note, not a history. */
  function withLaunched(list, evs, key) {
    const have = (list || []).filter((a) => !a.main),
      ids = new Set(have.map((a) => a.toolUseId).filter(Boolean)),
      names = new Set(have.map((a) => String(a.description || a.name || '').trim()).filter(Boolean)),
      extra = [];
    for (const e of evs || []) {
      if (e.kind !== 'tool' || !/^(agent|task)$/i.test(String(e.label || ''))) continue;
      if (e.callId && ids.has(e.callId)) continue;
      let input = {};
      try {
        input = JSON.parse(e.text || '{}') || {};
      } catch {}
      const name = String(input.description || input.prompt || 'Subagent')
        .trim()
        .split('\n')[0]
        .slice(0, 120);
      if (names.has(name)) continue;
      names.add(name);
      extra.push({
        key: key + '#launched:' + (e.callId || extra.length),
        name,
        description: name,
        agentType: typeof input.subagent_type === 'string' ? input.subagent_type : '',
        main: false,
        active: false,
        source: 'saved',
        launchedOnly: true,
        finished: false, // no transcript says how it ended: "Not marked finished"
        created: e.time || 0,
        modified: e.time || 0,
        depth: 1,
      });
    }
    return extra.length ? [...(list || []), ...extra] : list;
  }
  async function refreshSubagent() {
    if (!subSelection) return;
    const target = subSelection.key;
    if (subSelection.launchedOnly) {
      renderSubHead();
      if (subSignature !== target) {
        subSignature = target;
        $('submessages').replaceChildren(
          text('p', 'Launched by this chat. AIB has no saved transcript of this subagent to show.', 'empty-state'),
        );
      }
      return;
    }
    if (subSelection.live && !snapshot) {
      closeInspector();
      return;
    }
    renderSubagentControls();
    renderSubHead();
    if (subSelection.live) {
      showRows($('submessages'), liveRows(target), 'sub');
      return;
    }
    const working = window.SubagentsUI?.classify(subSelection).group === 'working';
    // Polite polling: a working subagent is re-read every 3 s, a finished one every 10 s.
    if (subSignature && subFetch.key === target && Date.now() - subFetch.at < (working ? 3000 : 10000)) return;
    const w = await pollHistory(target);
    subFetch = { key: target, at: Date.now() };
    if (subSelection?.key === target) {
      showRows($('submessages'), normalized({ events: w.events, context: w.context, start: w.start }, target), 'sub');
      syncLoadEarlier($('submessages'), target, w, 'sub');
      managed($('submessages'))?.afterRedraw(); // the "Load earlier" button came in after the draw
    }
  }
  let readMigrated = false;
  async function refresh() {
    if (!selected || polling) return;
    polling = true;
    const key = selected.key;
    try {
      if (current) {
        const requested = current;
        let next = await get('/api/live/state', { id: current, after: cursor });
        if (current !== requested) return;
        if (next.eventsId && eventsId && next.eventsId !== eventsId && cursor) {
          /* The chat was rebuilt with another event numbering (AIB restarted on an older record): fetch it all again. */
          next = await get('/api/live/state', { id: current, after: 0 });
          if (current !== requested) return;
          events = [];
        }
        if (next.eventsId) eventsId = next.eventsId;
        snapshot = next;
        if (next.reset) events = [];
        events.push(...next.events);
        events = events.slice(-6000);
        cursor = next.cursor;
        window.AgentArtifactsUI?.onEvents(next.events, current);
        collectChildren();
        renderSettings();
        renderApprovals();
        renderQuestions();
        window.AgentClientCapsUI?.render($('clientCaps'), next.clientCaps);
        liveHistoryNote(next);
        showRows(
          $('messages'),
          withUnknownSends(liveRows(next.sessionId, events, snapshot, viewOf() !== 'full'), next.unknownReceipts),
          'main',
          liveExtra(),
        );
      } else if (isPseudoKey(key)) {
        agents = [];
        if (mainSignature !== key) {
          mainSignature = key;
          $('messages').replaceChildren(text('p', pseudoNote(selected), 'empty-state'));
        }
        $('settings').replaceChildren();
        $('approvals').replaceChildren();
      } else {
        const [w, roster] = await Promise.all([pollHistory(key), get('/api/agents', { session: key })]);
        if (selected?.key !== key) return;
        agents = withLaunched(roster.agents, w.events, key);
        renderMainHistory(w, key);
        $('settings').replaceChildren();
        $('approvals').replaceChildren();
        approvalSignature = '';
        window.AgentElicitationUI?.render($('questions'), [], {});
        window.AgentElicitationUI?.renderAuth($('authPrompts'), null, {});
      }
      if (selected?.key !== key) return;
      const recovered = connectionIssue;
      connectionIssue = false;
      if (recovered) clearError();
      renderHeader();
      renderAgents();
      await refreshCommands();
      await refreshSubagent().catch((error) => fail(Error('Subagent transcript unavailable: ' + error.message)));
    } catch (error) {
      if (error.code === 'connection_not_found') {
        current = '';
        snapshot = null;
        connectionIssue = false;
        closeInspector();
        await listConversations().catch(() => {});
        renderHeader();
        fail(
          Error(
            'The AIB server no longer has this connection. Your draft is saved. Continue only after checking that the chat is not still running elsewhere.',
          ),
        );
      } else {
        connectionIssue = true;
        renderHeader();
        fail(error);
      }
    } finally {
      polling = false;
    }
  }
  function renderSettings() {
    const options = snapshot.settings || {},
      signature = JSON.stringify([options, snapshot.busy, snapshot.closed, snapshot.pendingChanges]);
    if (signature === settingsSignature) return;
    settingsSignature = signature;
    AgentChoice.saveOptions(localStorage, snapshot.provider || selected?.provider, options);
    window.AgentConfigUI?.render($('settings'), options, {
      disabled: snapshot.closed,
      queueing: !!snapshot.busy,
      pending: Object.fromEntries((snapshot.pendingChanges || []).map((change) => [change.key, change.value])),
      onCancelPending: (key) => post('cancel-pending', { id: current, key }),
      onMode: (modeId) => post('mode', { id: current, modeId }),
      onConfig: (configId, value, type) => post('config', { id: current, configId, value, type }),
      onError: fail,
      afterChange: refresh,
    });
  }
  function breadthContext() {
    return {
      post,
      fail,
      afterEnd: async () => {
        await refresh();
        await listConversations();
      },
    };
  }
  function loadQuestionUI() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/elicitation-ui.js';
      script.onload = resolve;
      script.onerror = () => reject(Error('Question controls could not be loaded. Refresh AIB to retry.'));
      document.head.append(script);
    });
  }
  function questionContext(connection, snap) {
    return {
      providerName: nameOf(snap.provider),
      mainSessionId: snap.sessionId,
      sessionNames: Object.fromEntries([...children].map(([id, agent]) => [id, agent.name])),
      onShowAgent: (id) => {
        const agent = children.get(id);
        if (agent) openSubagent(agent).catch(fail);
      },
      onRespond: async (key, action, content) => {
        await post('elicitation', { id: connection, key, action, content });
        answerChoice.set(key, { accept: 'Submitted', decline: 'Declined', cancel: 'Cancelled' }[action] || 'Answered');
        if (current === connection) await refresh();
      },
    };
  }
  function authContext(connection, snap) {
    const S = window.AgentSettingsUI;
    const terminal = !!(S && S.betaSigninKind && S.betaSigninKind(snap.provider) === 'terminal');
    return {
      providerName: nameOf(snap.provider),
      onAuth: async (action, methodId) => {
        await post('authenticate', { id: connection, action, methodId });
        if (current === connection) await refresh();
      },
      // A Beta agent whose sign-in runs in a terminal: AIB runs it in its own terminal (Settings > AIB Linking, on the agent's card),
      // then reconnects this chat: a fresh agent process that reads the new sign-in (ACP terminal auth re-initializes).
      onTerminalSignin: terminal
        ? async () => {
            const ok = await S.signInBeta(snap.provider);
            if (!ok) throw Error('The sign-in did not finish. Try again.');
            const restart = setupRestarts.get(connection);
            if (restart) restart();
            else await post('authenticate', { id: connection, action: 'retry' });
            if (current === connection) await refresh();
          }
        : null,
    };
  }
  let setupWatch = '';
  function showSetupPrompts(id, snap) {
    const ui = window.AgentElicitationUI;
    if (!ui) return;
    ui.render($('setupQuestions'), snap ? snap.elicitations || [] : [], snap ? questionContext(id, snap) : {});
    ui.renderAuth($('authPrompts'), snap ? snap.auth : null, snap ? authContext(id, snap) : {});
  }
  async function connectAndWait(payload) {
    return window.AgentOwnershipUI
      ? window.AgentOwnershipUI.guardedConnect(connectAndWaitOnce, payload, $('ownershipPrompt'))
      : connectAndWaitOnce(payload);
  }
  // A chat still opening whose Beta agent was just signed in through AIB's terminal: connectAndWaitOnce drops that agent process
  // (its sign-in wait is cancelled) and opens the chat again with a fresh one. connection id -> restart().
  const setupRestarts = new Map();
  async function connectAndWaitOnce(payload) {
    for (let attempt = 0; ; attempt++) {
      const outcome = await connectAttempt(payload, attempt < 2);
      if (outcome !== 'restart') return outcome;
    }
  }
  async function connectAttempt(payload, mayRestart) {
    const started = await post('connect', { ...payload, background: true }),
      id = started.id;
    let closedPolls = 0,
      restart = false;
    setupWatch = id;
    if (mayRestart) setupRestarts.set(id, () => (restart = true));
    try {
      for (;;) {
        if (restart) {
          await post('authenticate', { id, action: 'cancel' }).catch(() => {});
          return 'restart';
        }
        const snap = await get('/api/live/state', { id });
        showSetupPrompts(id, snap);
        if (snap.closed) {
          if (snap.setupDone || ++closedPolls > 5)
            throw Error(snap.error || 'The agent closed the connection while the conversation was opening.');
        } else if (snap.ready) return snap;
        await new Promise((resolve) => setTimeout(resolve, snap.elicitations?.length || snap.auth ? 250 : 500));
      }
    } finally {
      setupRestarts.delete(id);
      setupWatch = '';
      showSetupPrompts(id, null);
    }
  }
  function renderQuestions() {
    const connection = current;
    if (setupWatch === connection) return;
    window.AgentElicitationUI?.render(
      $('questions'),
      snapshot.elicitations || [],
      questionContext(connection, snapshot),
    );
    window.AgentElicitationUI?.renderAuth($('authPrompts'), snapshot.auth, authContext(connection, snapshot));
  }
  /* What the approval is for, plainly: the verb and the command, path or URL itself (in a code box), the agent's own
     description under it as a quieter line, and the raw request folded under Details (ToolViews.actionOf). */
  function approvalDetail(params) {
    const call = params.toolCall || null,
      out = [];
    let act = null;
    try {
      act = call && window.ToolViews?.actionOf ? window.ToolViews.actionOf(call) : null;
    } catch {
      act = null;
    }
    if (act) {
      const what = text('div', '', 'approval-what' + (act.code ? ' has-code' : ''));
      what.dataset.kind = act.kind;
      if (act.verb) what.append(text('span', act.verb, 'approval-verb'));
      what.append(text(act.code ? 'code' : 'span', act.target, 'approval-target'));
      out.push(what);
      if (act.note) out.push(text('p', act.note, 'approval-note'));
    } else if (call && call.title) out.push(text('p', String(call.title), 'approval-what'));
    const raw = document.createElement('details');
    raw.className = 'approval-raw';
    raw.append(text('summary', 'Details'), text('pre', JSON.stringify(call || params, null, 2)));
    out.push(raw);
    return out;
  }
  function renderApprovals() {
    const list = snapshot.permissions || [],
      names = Object.fromEntries([...children].map(([id, agent]) => [id, agent.name])),
      signature = JSON.stringify([list, names]);
    if (signature === approvalSignature) return;
    approvalSignature = signature;
    const box = $('approvals'),
      ui = window.AgentElicitationUI,
      context = questionContext(current, snapshot);
    box.replaceChildren();
    for (const p of list) {
      const info = ui?.routeInfo(p.params.sessionId, p.route, context),
        card = text('section', '', 'approval');
      card.dataset.route = info ? info.kind : 'main';
      card.append(text('h3', info ? info.name + ' requests approval' : 'Approval requested'));
      const note = info ? ui.routeNote(info) : '';
      if (note) card.append(text('p', note, 'elicitation-subagent'));
      if (info?.kind === 'subagent') {
        const agent = children.get(info.sessionId);
        if (agent) {
          const show = text('button', 'Show this subagent');
          show.onclick = () => openSubagent(agent).catch(fail);
          card.append(show);
        }
      }
      card.append(...approvalDetail(p.params));
      for (const option of [...(p.params.options || []), { name: 'Cancel request', optionId: null }]) {
        const button = text('button', option.name || option.optionId);
        button.onclick = async () => {
          button.disabled = true;
          try {
            await post('permission', { id: current, key: p.key, option: option.optionId });
            answerChoice.set(p.key, option.optionId === null ? 'Cancelled' : String(option.name || option.optionId));
            await refresh();
          } catch (e) {
            fail(e);
            button.disabled = false;
            refresh();
          }
        };
        card.append(button);
      }
      box.append(card);
    }
  }
  function startRename(c) {
    if (selected && c && aliasKey(c) === aliasKey(selected) && window.AgentHeaderUI?.beginRename?.()) return;
    renameTarget = c;
    $('renameInput').value = aliases[aliasKey(c)] || titleOf(c);
    $('renameDialog').showModal();
    $('renameInput').select();
  }
  function renameChat(c, value) {
    const v = String(value || '').trim();
    if (v) aliases[aliasKey(c)] = v;
    else delete aliases[aliasKey(c)];
    try {
      localStorage.setItem('studio-conversation-names', JSON.stringify(aliases));
    } catch (e) {
      fail(Error('Could not save the display name in this browser.'));
      return false;
    }
    sidebarSignature = '';
    renderConversations();
    if (selected) renderHeader();
    return true;
  }
  async function handoffFor(c) {
    if (!(selected && aliasKey(selected) === aliasKey(c))) await openConversation(c);
    startHandoff({ provider: AgentChoice.other(c.provider), summary: true });
  }
  function saveRename(reset = false) {
    if (!renameTarget) return;
    const value = reset ? '' : $('renameInput').value.trim();
    if (renameChat(renameTarget, value)) $('renameDialog').close();
  }
  $('renameForm').onsubmit = (e) => {
    e.preventDefault();
    saveRename();
  };
  $('resetName').onclick = () => saveRename(true);
  $('cancelRename').onclick = () => $('renameDialog').close();
  $('renameCurrent').onclick = () => selected && startRename(selected);
  $('new').onclick = () => showNewChat();
  // ---- New chat: the Agent chip is a picker, the first send connects and then sends ----
  // A new chat is not a conversation yet: no connection exists until the first message is sent. newDraft holds the pick
  // ({provider, cwd}); cwd is set only by a hand-off, which keeps the old chat's folder.
  function newChatFolder() {
    return AgentChoice.resolveFolder({
      explicit: newDraft?.cwd,
      activeProject: window.AgentWorkspaceUI?.activeProject?.(),
      inputValue: $('cwd').value,
      preferInput: !$('setup').hidden,
    });
  }
  function showNewChat(opts) {
    const o = opts || {};
    window.AgentWorkspaceUI?.noteNewChat?.(selected);
    selectedCommand = null;
    commands = [];
    if (selected) keepDraft();
    current = '';
    selected = null;
    snapshot = null;
    subSelection = null;
    sessionStorage.removeItem('studio-selected');
    // Nothing from the chat we just left may show in Activity: a draft has no subagents or processes.
    children.clear();
    agents = [];
    events = [];
    actCounts = { subagents: 0, working: 0, failed: 0 };
    paintActivityTabBadge();
    const folder = AgentChoice.resolveFolder({
      explicit: o.cwd,
      activeProject: window.AgentWorkspaceUI?.activeProject?.(),
      inputValue: $('cwd').value,
    }).cwd;
    newDraft = {
      provider: o.provider || AgentChoice.loadChoice(localStorage, folder),
      cwd: o.cwd || '',
      picked: !!o.provider,
      model: '',
      mode: '',
      effort: '',
    };
    newOptions.clear(); // asked again each time: an open chat may have reported newer lists since
    applyDefaultPicks(folder);
    $('prompt').value = o.prefill || '';
    mainSignature = 'new';
    window.ChatViewsUI?.sync();
    settingsSignature = '';
    approvalSignature = '';
    $('setup').hidden = true;
    $('newChatMore').setAttribute('aria-expanded', 'false');
    $('chat').hidden = false;
    document.body.classList.add('new-chat');
    window.StartPageUI?.update(); // the first-run start page, while no agent is ready
    $('newChatBar').hidden = true;
    $('subchatPane').hidden = true;
    document.body.classList.remove('subchat-open');
    $('renameCurrent').hidden = true;
    $('messages').replaceChildren();
    $('sessionStrip').hidden = true;
    $('ownershipHint').hidden = true;
    $('settings').replaceChildren();
    $('approvals').replaceChildren();
    clearError();
    syncChatPanels(); // the chat we left: its Changes chip, Merge / Discard, Files and Artifacts go with it
    renderConversations();
    renderNewChat();
    renderAgents();
    renderCommands();
    $('prompt').focus();
  }
  let newBranch = { cwd: '', branch: '' };
  // ---- what a new chat can offer before its session exists ----
  // The host remembers the model / mode / effort lists each agent reported (in the data folder, per agent and per folder) and,
  // when it has none, asks the agent once with a quiet probe. agent|cwd -> {loading, options, problem}.
  function wantNewOptions(agent, cwd) {
    const key = agent + '|' + (cwd || '');
    if (newOptions.has(key)) return newOptions.get(key);
    const entry = { loading: true, options: null, problem: '' };
    newOptions.set(key, entry);
    post('agent-options', { agent, cwd: cwd || '', probe: true })
      .then((r) => {
        entry.options = r && r.options && typeof r.options === 'object' ? r.options : null;
        entry.problem = (r && r.probeError) || '';
      })
      .catch((error) => {
        entry.problem = error.message; // an older agent host: the lists this browser remembered still work
      })
      .finally(() => {
        entry.loading = false;
        if (newDraft && !selected) renderNewChat();
      });
    return entry;
  }
  // {model, mode, effort} lists ({kind, configId?, current?, choices:[{value, name, description?, group?}]}) for the draft, and
  // whether they are still being asked for. The browser's own memory is the fallback.
  function newChatLists(cwd) {
    const entry = wantNewOptions(newDraft.provider, cwd),
      got = entry.options || {},
      local = AgentChoice.loadOptions(localStorage, newDraft.provider);
    const ok = (x) => (x && Array.isArray(x.choices) && x.choices.length ? x : null);
    return {
      model: ok(got.model) || ok(local.model),
      mode: ok(got.mode) || ok(local.mode),
      effort: ok(got.effort),
      loading: entry.loading,
    };
  }
  // "Default" leaves the agent's own setting alone; it names that setting when the agent reported it.
  function defaultName(list) {
    return AgentChoice.defaultLabel(list);
  }
  // The chips' view of the draft: the remembered lists as advertised settings, with a "Default" row first and the picks as
  // the current values, so the New chat page uses the same chips and menus as a chat.
  function draftSettings(lists) {
    const settings = { configOptions: [] };
    const option = (id, category, name, list, value) => {
      const options = [{ value: '', name: defaultName(list), description: 'The agent\u2019s own setting' }];
      const groups = new Map();
      for (const c of list.choices) {
        const row = { value: c.value, name: c.name, description: c.description || '' };
        if (!c.group) options.push(row);
        else {
          if (!groups.has(c.group)) {
            groups.set(c.group, { name: c.group, options: [] });
            options.push(groups.get(c.group));
          }
          groups.get(c.group).options.push(row);
        }
      }
      return { id, name, category, type: 'select', currentValue: value, options };
    };
    if (lists.model) settings.configOptions.push(option('model', 'model', 'Model', lists.model, newDraft.model));
    if (lists.mode && lists.mode.kind === 'mode')
      settings.modes = {
        currentModeId: newDraft.mode,
        availableModes: [{ id: '', name: defaultName(lists.mode), description: 'The agent\u2019s own setting' }].concat(
          lists.mode.choices.map((c) => ({ id: c.value, name: c.name, description: c.description || '' })),
        ),
      };
    else if (lists.mode) settings.configOptions.push(option('mode', 'mode', 'Mode', lists.mode, newDraft.mode));
    if (lists.effort)
      settings.configOptions.push(option('effort', 'thought_level', 'Effort', lists.effort, newDraft.effort));
    return settings;
  }
  function pickNewAgent(id) {
    if (!newDraft || !AgentChoice.isAgent(id)) return;
    newDraft.provider = id;
    newDraft.picked = true;
    applyDefaultPicks(newChatFolder().cwd);
    AgentChoice.saveChoice(localStorage, id, newChatFolder().cwd);
    renderNewChat();
  }
  // The model and mode a new chat starts with come from Settings > Defaults (per project, else per agent); '' = the agent's own setting.
  function applyDefaultPicks(cwd) {
    if (!newDraft) return;
    const d = AgentChoice.defaultPicks(cwd, newDraft.provider);
    newDraft.model = d.model;
    newDraft.mode = d.mode;
    newDraft.effort = '';
  }
  function ensureNewBranch(cwd) {
    if (!cwd || newBranch.cwd === cwd) return;
    newBranch = { cwd, branch: '' };
    get('/api/live/branch', { cwd })
      .then((r) => {
        if (newBranch.cwd === cwd && (r.branch || '')) {
          newBranch.branch = r.branch;
          if (newDraft && !selected) renderNewChat();
        }
      })
      .catch(() => {});
  }
  // The New chat form: Agent (every agent in the registry), then Model and Mode from the lists that agent reported last time.
  function fillSelect(select, items, value) {
    const sig = JSON.stringify(items);
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      // Items with a group (the Beta agents) go in an <optgroup> with that label, after the ones without.
      const groups = new Map();
      select.replaceChildren(
        ...items.flatMap((item) => {
          const option = document.createElement('option');
          option.value = item.value;
          option.textContent = item.reason ? item.name + ' — ' + item.reason : item.name;
          if (item.disabled) option.disabled = true;
          if (!item.group) return [option];
          if (groups.has(item.group)) {
            groups.get(item.group).append(option);
            return [];
          }
          const g = document.createElement('optgroup');
          g.label = item.group;
          g.append(option);
          groups.set(item.group, g);
          return [g];
        }),
      );
    }
    select.value = value;
  }
  function renderNewChatForm(f, lists) {
    const named = (list) => {
      const rows = AgentChoice.pickList(list);
      rows[0] = { value: '', name: defaultName(list) };
      return rows;
    };
    const models = named(lists.model),
      modes = named(lists.mode),
      efforts = named(lists.effort);
    // A pick the agent no longer lists (or one for another agent) goes back to Default; nothing is dropped while still loading.
    if (!lists.loading || lists.model) if (!models.some((m) => m.value === newDraft.model)) newDraft.model = '';
    if (!lists.loading || lists.mode) if (!modes.some((m) => m.value === newDraft.mode)) newDraft.mode = '';
    if (!lists.loading || lists.effort) if (!efforts.some((m) => m.value === newDraft.effort)) newDraft.effort = '';
    fillSelect($('ncAgent'), AgentChoice.menuRows(), newDraft.provider);
    $('ncSetup').hidden = !AgentChoice.UNAVAILABLE.length;
    fillSelect($('ncModel'), models, newDraft.model);
    fillSelect($('ncMode'), modes, newDraft.mode);
    for (const id of ['ncAgent', 'ncModel', 'ncMode']) $(id).disabled = startingNew;
    $('ncFolder').textContent = f.cwd
      ? f.cwd + (newBranch.cwd === f.cwd && newBranch.branch ? ' · ' + newBranch.branch : '')
      : 'No project folder yet. Type one below, or add a project with + above the chat list.';
    const typing = f.source === 'none' || f.source === 'input';
    $('ncFolderInput').hidden = !typing;
    $('ncFolderInput').disabled = startingNew;
    if (typing && $('ncFolderInput').value !== $('cwd').value) $('ncFolderInput').value = $('cwd').value;
  }
  function renderNewChat() {
    window.AibTerminal?.sync();
    if (!newDraft || selected) return;
    const f = newChatFolder();
    ensureNewBranch(f.cwd);
    // The agent follows the project (the one used last there) until the user picks one by hand.
    if (!newDraft.picked) {
      const want = AgentChoice.loadChoice(localStorage, f.cwd);
      if (want !== newDraft.provider) {
        newDraft.provider = want;
        applyDefaultPicks(f.cwd);
      }
    }
    const name = nameOf(newDraft.provider),
      has = !!$('prompt').value.trim() || selectedAttachments('new-chat').length > 0;
    $('title').textContent = 'New chat';
    $('status').textContent = '';
    const lists = newChatLists(f.cwd);
    renderNewChatForm(f, lists);
    $('prompt').disabled = startingNew;
    $('prompt').placeholder = 'Message ' + name + ' to start the chat… Enter to send';
    $('send').hidden = false;
    $('send').disabled = startingNew || !has || !f.cwd;
    $('send').textContent = startingNew ? 'Starting…' : 'Send';
    $('cancel').hidden = true;
    if ($('provider').value !== newDraft.provider) $('provider').value = newDraft.provider;
    $('composerNote').textContent =
      'Enter to start the chat and send · Shift+Enter for a new line. The agent connects only when you send.';
    // The same chips as a chat, from the remembered lists: Agent (a menu here), Model, Mode, Effort. Picks go into the draft and
    // are applied by the host as soon as the session exists, before the first message is sent.
    const settings = draftSettings(lists),
      extraChips = [];
    if (!lists.model)
      extraChips.push(
        lists.loading
          ? {
              id: 'model',
              label: 'Model',
              value: 'Checking\u2026',
              title: 'Asking ' + name + ' which models it offers\u2026',
            }
          : {
              id: 'model',
              label: 'Model',
              value: 'Default',
              title: name + ' has not reported its models yet. They appear here once a chat with it has opened.',
            },
      );
    window.AgentComposerChips?.render(
      $('composerChips'),
      {
        id: 'new-chat',
        settings,
        agent: name,
        agentId: newDraft.provider,
        agents: AgentChoice.menuRows().map((a) => ({
          id: a.value,
          name: a.name,
          group: a.group,
          disabled: !!a.disabled,
          reason: a.reason || '',
        })),
        extraChips,
      },
      {
        disabled: startingNew,
        onAgent: pickNewAgent,
        onSetup: openAgentSetup,
        onMode: (value) => {
          if (newDraft) newDraft.mode = value;
        },
        onConfig: (id, value) => {
          if (newDraft && (id === 'model' || id === 'mode' || id === 'effort')) newDraft[id] = value;
        },
        onError: fail,
        afterChange: () => {
          if (newDraft && !selected) renderNewChat();
        },
      },
    );
    renderAttachments();
  }
  // "Set up in Settings ›": Settings > AIB Linking, at the card of the agent that is not ready yet.
  function openAgentSetup() {
    window.AgentSettingsUI?.openAgent?.(AgentChoice.setupTarget());
  }
  $('ncSetup').onclick = openAgentSetup;
  $('ncAgent').onchange = () => pickNewAgent($('ncAgent').value);
  $('ncModel').onchange = () => {
    if (newDraft) newDraft.model = $('ncModel').value;
    if (newDraft && !selected) renderNewChat();
  };
  $('ncMode').onchange = () => {
    if (newDraft) newDraft.mode = $('ncMode').value;
    if (newDraft && !selected) renderNewChat();
  };
  $('ncFolderInput').addEventListener('input', () => {
    $('cwd').value = $('ncFolderInput').value;
    if (newDraft && !selected) renderNewChat();
  });
  $('newChatMore').onclick = () => {
    const open = $('setup').hidden;
    $('setup').hidden = !open;
    $('newChatMore').setAttribute('aria-expanded', String(open));
    if (open) {
      $('provider').value = newDraft?.provider || $('provider').value;
      const f = AgentChoice.resolveFolder({
        explicit: newDraft?.cwd,
        activeProject: window.AgentWorkspaceUI?.activeProject?.(),
        inputValue: $('cwd').value,
      });
      if (f.cwd) $('cwd').value = f.cwd;
    }
    renderNewChat();
  };
  $('provider').addEventListener('change', () => {
    if (newDraft && !selected && AgentChoice.isAgent($('provider').value)) {
      newDraft.provider = $('provider').value;
      newDraft.picked = true;
      applyDefaultPicks(newChatFolder().cwd);
      AgentChoice.saveChoice(localStorage, newDraft.provider, newChatFolder().cwd);
      renderNewChat();
    }
  });
  $('cwd').addEventListener('input', () => {
    if (newDraft && !selected) renderNewChat();
  });
  async function startNewChat() {
    if (!newDraft || selected || startingNew) return;
    const f = newChatFolder(),
      draft = $('prompt').value,
      provider0 = newDraft.provider,
      picks = { model: newDraft.model, mode: newDraft.mode, effort: newDraft.effort },
      pickLists = newChatLists(f.cwd);
    if (!f.cwd || (!draft.trim() && !selectedAttachments('new-chat').length)) return;
    startingNew = true;
    clearError();
    renderNewChat();
    try {
      // The host applies the picks right after the session starts and before it is ready, so the first prompt runs with them.
      const result = await connectAndWait({ provider: provider0, cwd: f.cwd, resume: '', picks });
      if (f.source === 'input')
        try {
          localStorage.setItem('studio-cwd', f.cwd);
        } catch {}
      AgentChoice.saveChoice(localStorage, provider0, f.cwd);
      // A pick the agent refused, or no longer offers, is named; the chat runs with the agent's own setting for it.
      const label = { model: 'Model', mode: 'Mode', effort: 'Effort' };
      const problems = (Array.isArray(result.pickResults) ? result.pickResults : [])
        .filter((r) => r && !r.ok)
        .map((r) => {
          const list = pickLists[r.kind],
            hit = list && list.choices.find((c) => c.value === r.value);
          return (label[r.kind] || 'Setting') + ' ' + (hit ? hit.name : r.value) + ': ' + (r.message || 'refused');
        });
      await listConversations();
      const c = conversations.find((x) => x.live?.id === result.id);
      if (!c)
        throw Error('The agent opened, but its conversation is not listed yet. Your message is still in the box.');
      if (selected && aliasKey(selected) !== aliasKey(c)) {
        // The user opened another chat while this one was starting. The message was typed for the new chat, so it still goes
        // there (this used to return here and the message vanished); the page stays where the user went.
        await sendFirstInBackground(c, result.id, draft, problems);
        return;
      }
      if (provider !== 'all') provider = c.provider;
      viewStore?.adopt('new-chat', aliasKey(c)); // the view picked on the New chat page carries over to the real chat
      await openConversation(c);
      const key = aliasKey(c);
      const pending = attachmentStore.get('new-chat') || [];
      attachmentStore.delete('new-chat');
      if (pending.length) {
        attachmentStore.set(key, pending);
        renderAttachments();
      }
      try {
        drafts.set(key, draft);
      } catch {}
      $('prompt').value = draft;
      renderHeader();
      try {
        const images = selectedAttachments(key).slice();
        for (const item of images) {
          const problem = window.AttachmentsUI.capabilityProblem(
            item.kind === 'file' ? item.fileKind : 'image',
            item.mime || item.file.type,
            item.file.name,
            snapshot?.promptCapabilities,
          );
          if (problem) throw Error(problem);
        }
        const fingerprint = await imageFingerprint(images),
          clientMessageId = attemptId(key, draft, fingerprint),
          attachments = await imageBlocks(images);
        await post('prompt', { id: result.id, text: draft, clientMessageId, attachments });
        followSent();
        clearAttempt(key, draft, fingerprint);
        clearSentAttachments(key, images);
        if (drafts.get(key) === draft) {
          try {
            drafts.delete(key);
          } catch {}
          if (selected && aliasKey(selected) === key) $('prompt').value = '';
        }
        await refresh();
        if (problems.length)
          fail(
            Error(
              'Could not apply the chosen settings: ' +
                problems.join(' · ') +
                ' The chat started with the agent defaults.',
            ),
          );
      } catch (error) {
        fail(Error(error.message + ' The chat is open; your message has been kept as a draft.'));
      }
    } catch (error) {
      fail(Error(error.message + ' Your message has been kept.'));
    } finally {
      startingNew = false;
      if (newDraft && !selected) renderNewChat();
      else if (selected) renderHeader();
    }
  }
  // Plain text with its http(s) links clickable (only those two schemes; the text itself is never read as markup).
  function linkedPre(value) {
    const pre = document.createElement('pre');
    let last = 0;
    for (const m of String(value).matchAll(/https?:\/\/[^\s<>"']+/g)) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      if (m.index > last) pre.append(String(value).slice(last, m.index));
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url;
      pre.append(link);
      last = m.index + url.length;
    }
    if (last < String(value).length) pre.append(String(value).slice(last));
    return pre;
  }
  // The first message of a chat that opened while the user was looking at another chat: sent without leaving that chat.
  // A failure is shown and the text is kept as the draft of the new chat, so it never disappears.
  async function sendFirstInBackground(c, id, draft, problems) {
    const key = aliasKey(c),
      pending = (attachmentStore.get('new-chat') || []).slice();
    attachmentStore.delete('new-chat');
    try {
      const fingerprint = await imageFingerprint(pending),
        clientMessageId = attemptId(key, draft, fingerprint),
        attachments = await imageBlocks(pending);
      await post('prompt', { id, text: draft, clientMessageId, attachments });
      clearAttempt(key, draft, fingerprint);
      if (problems.length)
        fail(
          Error(
            'Could not apply the chosen settings: ' +
              problems.join(' · ') +
              ' The chat started with the agent defaults.',
          ),
        );
    } catch (error) {
      try {
        drafts.set(key, draft);
      } catch {}
      if (pending.length) attachmentStore.set(key, pending);
      fail(
        Error(
          sentence(error.message) +
            ' The new ' +
            nameOf(c.provider) +
            ' chat is open; your first message is kept as its draft.',
        ),
      );
    }
  }
  // Continue this folder in a new chat with the other agent. Nothing is sent: a new chat opens with the agent chosen and,
  // when asked, an editable summary in the message box.
  function startHandoff(opt) {
    if (!selected || !opt) return;
    const from = selected,
      prefill = opt.summary
        ? AgentChoice.handoffText({ title: titleOf(from), rows: lastMainRows, from: from.provider })
        : '';
    window.AgentWorkspaceUI?.focusProjectOf?.(from);
    showNewChat({ provider: opt.provider, cwd: from.cwd || '', prefill });
  }

  $('connectForm').onsubmit = async (e) => {
    e.preventDefault();
    clearError();
    $('connect').disabled = true;
    $('connect').textContent = 'Starting…';
    try {
      const result = await connectAndWait({
        provider: $('provider').value,
        cwd: $('cwd').value,
        resume: $('resume').value.trim(),
      });
      localStorage.setItem('studio-cwd', $('cwd').value);
      await listConversations();
      const c = conversations.find((c) => c.live?.id === result.id);
      if (c) {
        if (provider !== 'all') provider = c.provider;
        await openConversation(c);
      }
    } catch (error) {
      fail(error);
    } finally {
      $('connect').disabled = false;
      $('connect').textContent = 'Start conversation';
    }
  };
  /* The header's "Your turn": the conversation list's flag, except right after a turn ends. The list is a few seconds behind
     (it is fetched on a timer, and the server marks the turn a moment later), so the header said "Idle" first. A turn that
     ended after the list was fetched, or within 15 s before, is read from the chat's own events (which still respect your
     reply and Mark handled); an older false flag means it was handled elsewhere. */
  /* The turn line's queue words. A paused queue ("Paused - you interrupted the agent") is said by the queue box right below,
     with its Resume: the line does not say it a second time. */
  function queueLineNote(queue, busy) {
    const s = window.AgentQueueUI?.summary(queue, busy);
    return !s || s.tone === 'paused' ? '' : s.note || '';
  }
  function headerYourTurn() {
    const listed = typeof selected.yourTurn === 'boolean' ? selected.yourTurn : selected.live?.yourTurn;
    if (listed !== false || !Array.isArray(events)) return listed;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e || e.kind === 'user') return listed;
      if (e.kind === 'turn_end')
        return typeof e.time === 'number' && e.time * 1000 > listedAt - 15000 ? undefined : listed;
    }
    return listed;
  }
  async function continueConversation() {
    if (!selected || continuingKey || elsewhereLocked(selected)) return;
    const target = { ...selected },
      key = aliasKey(target),
      draft = $('prompt').value;
    keepDraft();
    continuingKey = key;
    clearError();
    renderHeader();
    try {
      const result = await connectAndWait({ provider: target.provider, cwd: target.cwd, resume: target.id });
      await listConversations();
      // Connecting a chat must not redirect a user who has switched to another one.
      if (!selected || aliasKey(selected) !== key) return;
      const conversation = conversations.find((c) => c.live?.id === result.id);
      if (!conversation)
        throw Error(
          'The agent opened, but its conversation is not listed yet. Your draft is saved; select the conversation again.',
        );
      await openConversation(conversation);
      const images = selectedAttachments(key).slice();
      if (draft.trim() || images.length) {
        const fingerprint = await imageFingerprint(images),
          clientMessageId = attemptId(key, draft, fingerprint),
          attachments = await imageBlocks(images);
        await post('prompt', { id: result.id, text: draft, clientMessageId, attachments });
        followSent();
        clearAttempt(key, draft, fingerprint);
        clearSentAttachments(key, images);
        if (drafts.get(key) === draft) {
          try {
            drafts.delete(key);
          } catch {
            fail(
              Error(
                'Message accepted, but browser draft storage could not be cleared. Check the conversation before sending again.',
              ),
            );
          }
          if (selected && aliasKey(selected) === key) $('prompt').value = '';
        }
        await refresh();
      }
    } catch (error) {
      fail(Error(sentence(error.message) + ' Your draft has been kept.'));
    } finally {
      continuingKey = '';
      renderHeader();
    }
  }
  // Quick reply from the inbox: the same prompt route and receipts as the composer, for a chat that is not open. A chat that
  // is not running is reconnected first (the continue flow). Text only: attachments and slash commands stay in the chat.
  async function quickPrompt(c, value) {
    value = String(value || '');
    if (!c || !value.trim()) throw Error('Type a message first.');
    if (elsewhereLocked(c)) throw Error('This chat is running in another app. Use Open chat to read along.');
    const key = aliasKey(c);
    let id = c.live && !c.live.closed ? c.live.id : '';
    if (!id) {
      const result = await connectAndWait({ provider: c.provider, cwd: c.cwd, resume: c.id });
      id = result.id;
    }
    const clientMessageId = attemptId(key, value, '');
    let snap = c.live;
    try {
      snap = await get('/api/live/state', { id, after: Number.MAX_SAFE_INTEGER });
    } catch {}
    const route = window.AgentInboxReply ? window.AgentInboxReply.sendRoute(snap) : 'prompt';
    await post(route, { id, text: value, clientMessageId, attachments: [] });
    clearAttempt(key, value, '');
    try {
      await listConversations();
    } catch {}
    if (selected && aliasKey(selected) === key) {
      const hit = conversations.find((x) => x.live?.id === id);
      if (hit && !current) await openConversation(hit);
      else if (current) await refresh();
    }
    return { queued: route === 'queue' };
  }
  async function reloadAfterAnswer() {
    try {
      await listConversations();
    } catch {}
    if (current) await refresh();
  }
  $('promptForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!current && newDraft && !selected) {
      startNewChat();
      return;
    }
    if (!current && selected) {
      if (!$('send').disabled) continueConversation();
      return;
    }
    const value = $('prompt').value,
      images = selectedAttachments().slice();
    if ((!value.trim() && !images.length) || !current || sendingKey || (!imageCapability() && images.length)) return;
    // /doc <name>[ > page][: brief]: AIB opens (or makes) the doc in the Artifacts tab; only the brief goes to the agent.
    if (window.AgentDocLinks?.isDocCommand(value)) {
      const docKey = aliasKey(selected);
      sendingKey = docKey;
      renderHeader();
      let message = '';
      try {
        const r = await window.AgentDocLinks.runCommand(value, { id: current, key: docKey, title: titleOf(selected) });
        if (r.error) throw Error(r.error);
        message = r.message || '';
        window.AgentDocLinks.closePopup();
        $('prompt').value = message;
        if (!message) {
          try {
            drafts.delete(docKey);
          } catch {}
        }
      } catch (error) {
        fail(Error(sentence(error.message) + ' Your draft has been kept.'));
        return;
      } finally {
        sendingKey = '';
        renderHeader();
      }
      if (message) $('promptForm').requestSubmit();
      return;
    }
    const key = aliasKey(selected),
      connection = current;
    keepDraft();
    sendingKey = key;
    clearError();
    renderHeader();
    try {
      const fingerprint = await imageFingerprint(images),
        clientMessageId = attemptId(key, value, fingerprint),
        attachments = await imageBlocks(images);
      await post(snapshot && (snapshot.busy || snapshot.queue?.items?.length) ? 'queue' : 'prompt', {
        id: connection,
        text: value,
        clientMessageId,
        attachments,
      });
      followSent(); // you sent it: the view goes to your message and follows the reply, wherever you had scrolled
      clearAttempt(key, value, fingerprint);
      clearSentAttachments(key, images);
      if (drafts.get(key) === value) {
        try {
          drafts.delete(key);
        } catch {
          fail(
            Error(
              'Message accepted, but browser draft storage could not be cleared. Check the conversation before sending again.',
            ),
          );
        }
        if (selected && aliasKey(selected) === key) $('prompt').value = '';
      }
      await refresh();
    } catch (error) {
      fail(Error(sentence(error.message) + ' Your draft has been kept.'));
    } finally {
      sendingKey = '';
      renderHeader();
    }
  };
  $('prompt').onkeydown = (e) => {
    if (window.AgentDocLinks?.handleKey(e)) return;
    if (window.AgentBreadth?.handleKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      if (!$('prompt').value.trim() && !selectedAttachments().length) return;
      if (!$('send').disabled) $('promptForm').requestSubmit();
    }
  };
  $('cancel').onclick = async () => {
    try {
      await post('cancel', { id: current });
      await refresh();
    } catch (e) {
      fail(e);
    }
  };
  $('disconnect').onclick = async () => {
    try {
      await post('disconnect', { id: current });
      await refresh();
      await listConversations();
      $('connectionMenu').open = false;
    } catch (e) {
      fail(e);
    }
  };
  $('closeSubchat').onclick = () => closeAndRefocus();
  $('subchatBack').onclick = () =>
    subBack()
      .then(() => {
        // QA m10: the keyboard stays in the history (on Back), or goes back to the row it was opened from
        const ae = document.activeElement;
        if (!ae || ae === document.body || !ae.isConnected) {
          if (inspectorOpen()) $('subchatBack').focus({ preventScroll: true });
          else refocusRow();
        }
      })
      .catch(fail);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stopArmed) {
      e.preventDefault();
      disarmStop(true);
      return;
    }
    if (
      e.key === 'Escape' &&
      !e.defaultPrevented &&
      inspectorShown() &&
      !document.querySelector('dialog[open]') &&
      !/^(INPUT|SELECT)$/.test(e.target?.tagName || '') &&
      !e.target?.isContentEditable
    ) {
      e.preventDefault();
      const ae = document.activeElement,
        inside = !!ae && typeof $('subchatPane').contains === 'function' && $('subchatPane').contains(ae);
      if (inside) closeAndRefocus();
      else closeInspector();
    }
  });
  $('thinking').onchange = () => window.AgentChatView.setThinking($('thinking').checked);
  $('attachImages').onclick = () => {
    if (attachAvailable()) {
      imagePickerKey = curKey() || '';
      $('imageFiles').click();
    }
  };
  $('imageFiles').onchange = () => {
    if (attachAvailable() && imagePickerKey)
      window.AttachmentsUI.addFiles([...$('imageFiles').files], imagePickerKey, attachHost);
    imagePickerKey = '';
    $('imageFiles').value = '';
  };
  $('prompt').addEventListener('paste', (event) => {
    if (!attachAvailable()) return;
    const key = curKey(),
      files = [...event.clipboardData.items]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter(Boolean);
    if (files.length) {
      event.preventDefault();
      window.AttachmentsUI.addFiles(files, key, attachHost);
    }
  });
  window.AttachmentsUI?.wireDrop($('promptForm'), attachHost);
  $('cwd').value = localStorage.getItem('studio-cwd') || '';
  (async () => {
    try {
      const bootstrap = await get('/api/live/bootstrap');
      token = bootstrap.token;
      imageFeatureEnabled = !!bootstrap.features?.imageAttachments;
      window.AttachmentsUI?.setFeatures(bootstrap.features);
      instanceId = bootstrap.instanceId || '';
      discoveryEnabled = !!bootstrap.features?.sessionDiscovery;
      if (bootstrap.features?.formElicitation) await loadQuestionUI();
      if (window.AgentSettingsUI) await window.AgentSettingsUI.load();
      await listConversations();
      // Chats are filed under their final project once the folder kinds answer (a worktree of a Claude worktree): wait for that,
      // so last session's chat reopens in its own project and the saved project stays (workspace-ui.js settled).
      await window.AgentWorkspaceUI?.settled?.(1500);
      const key = sessionStorage.getItem('studio-selected') || sessionStorage.getItem('studio-saved');
      const prior = conversations.find((c) => c.key === key) || window.AgentWorkspaceUI?.restoreTarget?.();
      if (prior) {
        window.AgentWorkspaceUI?.keepProjectFor?.(prior); // reopening it keeps the project you had in the sidebar
        await openConversation(prior);
      } else showNewChat();
    } catch (error) {
      fail(error);
    }
  })();
  /* A hidden tab pauses only the 1.5 s chat poll and catches up the moment it is shown again. The conversation list keeps its own
   poll (notify-ui.js raises desktop notifications from it while the tab is in the background). */
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 1500);
  setInterval(() => listConversations().catch(fail), 5000);
  document.addEventListener?.('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  $('prompt').addEventListener('input', () => {
    keepDraft();
    renderHeader();
    if (newDraft && !selected) renderNewChat();
  });
  window.addEventListener('pagehide', keepDraft);

  function isRunningCommand(task) {
    return task.status === 'running' || task.status === 'in-progress';
  }
  function commandDuration(task) {
    if (Number.isFinite(task.durationMs)) return formatDuration(task.durationMs / 1000);
    const start = Date.parse(task.started),
      end = Date.parse(task.ended);
    if (!Number.isFinite(start)) return 'Timing unavailable';
    if (Number.isFinite(end)) return formatDuration(Math.max(0, (end - start) / 1000));
    return isRunningCommand(task)
      ? formatDuration(Math.max(0, (Date.now() - start) / 1000)) + ' elapsed'
      : 'Duration not recorded';
  }
  function formatDuration(seconds) {
    const n = Math.floor(seconds);
    return n < 60
      ? n + 's'
      : n < 3600
        ? Math.floor(n / 60) + 'm ' + (n % 60) + 's'
        : Math.floor(n / 3600) + 'h ' + Math.floor((n % 3600) / 60) + 'm';
  }
  function commandState(task) {
    const idle =
      task.transcriptIdleSeconds > 600 ? ' · transcript idle ' + formatDuration(task.transcriptIdleSeconds) : '';
    return (
      {
        running: 'Last reported running (saved)' + idle,
        'in-progress': 'Started · no saved result yet' + idle,
        completed: 'Completed',
        failed: 'Failed',
        killed: 'Stopped',
        cancelled: 'Cancelled',
        unknown: 'Status unknown · no completion saved' + idle,
      }[task.status] || task.status
    );
  }
  function noteCommands(note, isError) {
    $('commandStatusNote').textContent = note;
    $('commandStatusNote').hidden = !isError;
    const heading = $('commandListHeading').parentNode;
    if (heading) heading.title = note;
  }
  function procSeconds(task) {
    if (Number.isFinite(task.durationMs)) return task.durationMs / 1000;
    const start = Date.parse(task.started),
      end = Date.parse(task.ended);
    if (!Number.isFinite(start)) return NaN;
    if (Number.isFinite(end)) return Math.max(0, (end - start) / 1000);
    return isRunningCommand(task) ? Math.max(0, (Date.now() - start) / 1000) : NaN;
  }
  function renderCommands() {
    const running = commands.filter(isRunningCommand),
      rows = commands.filter((task) => showCommandHistory || isRunningCommand(task));
    $('commandCount').textContent = window.ActivityUI
      ? window.ActivityUI.processHeading(running.length)
      : running.length + ' running';
    $('commandListHeading').textContent = 'Processes';
    const toggle = $('commandHistoryToggle');
    toggle.title = showCommandHistory ? 'Hide history' : 'Show history';
    toggle.setAttribute('aria-label', showCommandHistory ? 'Hide command history' : 'Show command history');
    toggle.setAttribute('aria-pressed', String(showCommandHistory));
    const box = $('runningCommandList'),
      existing = new Map([...box.children].map((node) => [node.dataset.key, node]));
    for (const [index, task] of rows.entries()) {
      let button = existing.get(task.id);
      if (!button) {
        button = text('button', '', 'command-card');
        button.dataset.key = task.id;
        button.onclick = () => toggleCommand(task.id);
      }
      existing.delete(task.id);
      const kind = isRunningCommand(task) ? 'running' : task.status === 'failed' ? 'failed' : 'ended';
      button.className =
        'command-card sa-card proc-row proc-' + kind + (selectedCommand?.id === task.id ? ' selected' : '');
      button.title = [
        window.ActivityUI ? window.ActivityUI.processHover(task) : task.title,
        commandState(task),
        'Tool: ' + task.tool,
        'Agent: ' + (task.agent === 'Main conversation' ? 'Main agent' : task.agent),
        commandDuration(task),
      ]
        .filter(Boolean)
        .join('\n');
      const dur = window.ActivityUI ? window.ActivityUI.shortDuration(procSeconds(task)) : '';
      button.replaceChildren(
        text('span', '', 'sa-dot'),
        text('span', window.ActivityUI ? window.ActivityUI.processTitle(task) : task.title, 'proc-title'),
        ...(dur ? [text('span', dur, 'sa-when proc-dur')] : []),
      );
      if (box.children[index] !== button) box.insertBefore(button, box.children[index] || null);
    }
    for (const node of existing.values()) node.remove();
    if (!rows.length)
      box.replaceChildren(
        text('p', showCommandHistory ? 'No recorded commands' : 'No commands running', 'empty-state'),
      );
    renderActivityStrip();
  }
  async function refreshCommands() {
    if (!selected) return;
    const key = selected.key;
    if (/^(live|agent|recovered):/.test(key)) {
      noteCommands('Commands appear when this agent saves its conversation.');
      renderCommands();
      return;
    }
    try {
      const data = await get('/api/commands', { session: key });
      if (selected?.key !== key) return;
      commands = data.commands;
      noteCommands(
        'Saved and inferred: status comes from saved agent events, not from a live AIB connection or an operating-system process check.',
      );
      renderCommands();
      if (selectedCommand) {
        const currentTask = commands.find((t) => t.id === selectedCommand.id);
        if (currentTask) selectedCommand = { ...selectedCommand, ...currentTask };
        await refreshCommandDetails();
      }
    } catch (error) {
      if (selected?.key === key) noteCommands('Command updates unavailable: ' + error.message, true);
    }
  }
  async function openCommand(id, keepTrail) {
    if (!current && !selected) {
      closeInspector();
      return;
    }
    const task = commands.find((t) => t.id === id);
    if (!task) return;
    if (keepTrail === true) pushTrail();
    else subTrail = [];
    selectedCommand = task;
    subSelection = null;
    managed($('commandDetails'))?.switchTo(task.id, () => window.ScrollController.FOLLOW);
    commandSignature = '';
    $('subchatPane').hidden = false;
    document.body.classList.add('subchat-open');
    window.AgentChangesUI?.show('activity'); // the history lives in the Activity tab
    window.ActivityUI?.drill(true);
    $('inspectorEyebrow').textContent = 'COMMAND DETAILS';
    $('subchatTitle').textContent = $('subchatTitle').title = task.title;
    $('subchatStatus').textContent = commandState(task);
    $('inspectorNote').textContent = 'Read-only monitoring. Viewing this command does not stop or restart it.';
    $('submessages').hidden = true;
    $('commandDetails').hidden = false;
    renderSubHead();
    renderAgents();
    renderCommands();
    await refreshCommandDetails();
  }
  async function refreshCommandDetails() {
    if (!selectedCommand || !selected) return;
    const id = selectedCommand.id,
      key = selected.key;
    try {
      const task = await get('/api/command', { session: key, id });
      if (selected?.key !== key || selectedCommand?.id !== id) return;
      selectedCommand = task;
      $('subchatTitle').textContent = $('subchatTitle').title = task.title;
      $('subchatStatus').textContent = commandState(task) + ' · ' + commandDuration(task);
      const signature = JSON.stringify(task);
      if (signature === commandSignature) return;
      commandSignature = signature;
      const box = $('commandDetails'),
        ctl = managed(box),
        fragment = document.createDocumentFragment();
      if (ctl) ctl.beforeRedraw();
      const metadata = text('div', '', 'command-summary');
      metadata.append(
        text('p', (task.agent === 'Main conversation' ? 'Main agent' : task.agent) + ' · ' + task.tool),
        text('p', 'Started: ' + (task.started ? new Date(task.started).toLocaleString() : 'Not recorded')),
        text('p', 'Finished: ' + (task.ended ? new Date(task.ended).toLocaleString() : 'Not recorded')),
      );
      fragment.append(metadata);
      fragment.append(text('h3', 'Command'), text('pre', task.command || 'Command unavailable', 'command-code'));
      if (task.completionSummary) fragment.append(text('p', task.completionSummary, 'command-completion'));
      fragment.append(
        text('h3', 'Latest saved output'),
        text('pre', task.output || 'No output saved yet.', 'command-code'),
      );
      box.replaceChildren(fragment);
      ctl?.afterRedraw(); // follows while the output grows, or keeps the place you scrolled to
    } catch (error) {
      if (selectedCommand?.id === id) $('subchatStatus').textContent = 'Could not update command: ' + error.message;
    }
  }
  $('commandHistoryToggle').onclick = () => {
    showCommandHistory = !showCommandHistory;
    renderCommands();
  };

  // ---- Package D: recovery, live-vs-saved state, discovery and windowed history ----
  // Clicking the open item again closes the drawer, and so does any click in the main chat (it is the most important view).
  function inspectorOpen() {
    return !$('subchatPane').hidden;
  }
  // Open and on screen: on the Changes or Artifacts tab the history stays open (CSS hides it) for when you come back to Activity.
  function inspectorShown() {
    const pane = $('subagentsPane');
    return inspectorOpen() && !pane.classList.contains('tab-changes') && !pane.classList.contains('tab-artifacts');
  }
  function toggleSubagent(agent) {
    if (inspectorOpen() && subSelection?.key === agent?.key) {
      closeInspector();
      return Promise.resolve();
    }
    return openSubagent(agent).catch(fail);
  }
  function toggleCommand(id) {
    if (inspectorOpen() && selectedCommand?.id === id) {
      closeInspector();
      return Promise.resolve();
    }
    return openCommand(id).catch(fail);
  }
  window.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target;
      if (!inspectorShown() || !t?.closest) return;
      if (t.closest('#subchatPane,#subagentsPane,dialog,[role="menu"]')) return;
      if (t.closest('main')) closeInspector();
    },
    true,
  );
  /* QA m10: after Close (or Back from the first item, or Escape inside it) the focus goes to the row the history was opened from,
     else to the Activity tab: never to <body>. */
  let lastOpened = { agent: '', command: '' };
  function refocusRow() {
    const pick = (box, key) =>
      key && box ? [...box.querySelectorAll('[data-key]')].find((n) => n.dataset.key === key && n.offsetParent) : null;
    const target =
      pick($('subagentList'), lastOpened.agent) ||
      pick($('runningCommandList'), lastOpened.command) ||
      $('paneTab-activity') ||
      $('prompt');
    target?.focus?.({ preventScroll: true });
  }
  function closeAndRefocus() {
    lastOpened = { agent: subSelection?.key || '', command: selectedCommand?.id || '' };
    closeInspector();
    refocusRow();
  }
  function closeInspector() {
    subTrail = [];
    subSelection = null;
    selectedCommand = null;
    $('subchatPane').hidden = true;
    document.body.classList.remove('subchat-open');
    renderAgents();
    renderCommands();
  }
  function isPseudoKey(key) {
    return /^(agent|recovered|discarded):/.test(key || '');
  }
  function pseudoNote(c) {
    if (isDiscarded(c) && !c.recovered)
      return 'This chat\u2019s worktree was discarded. AIB has no saved transcript of it to show, and it cannot be continued.';
    return c.recovered
      ? c.recovered.reconnecting
        ? 'AIB is reconnecting this conversation after the restart. Its history loads from the agent; nothing is sent.'
        : 'This conversation was open in AIB before the server restarted. AIB has no local transcript for it. Send a message to ask the agent to load it again.'
      : 'The agent listed this conversation, but AIB has no local transcript for it. Continue it to ask the agent to load its history; nothing is sent until you send a message.';
  }
  function rowStatus(c) {
    const box = text('small', '', 'connection-state');
    if (c.live) {
      box.className += ' owned-status';
      box.append(
        text('span', '● ' + (c.live.busy ? 'Working' : 'Ready'), 'badge badge-live'),
        text('span', ' Live in AIB', 'status-detail'),
      );
      return box;
    }
    if (c.recovered) {
      box.append(
        text('span', c.recovered.reconnecting ? 'Reconnecting…' : 'Not running', 'badge badge-recovered'),
        text(
          'span',
          c.recovered.reconnecting ? ' AIB is reconnecting it' : ' Was open in AIB before restart',
          'status-detail',
        ),
      );
      return box;
    }
    if (c.source === 'agent') {
      box.append(text('span', 'Agent list', 'badge badge-agent'), text('span', ' Not read locally', 'status-detail'));
      return box;
    }
    const recent = Date.now() / 1000 - c.modified < 90;
    box.append(
      text('span', 'Saved', 'badge badge-saved'),
      text('span', ' ' + (recent ? 'written just now · not confirmed running' : since(c.modified)), 'status-detail'),
    );
    window.AgentOwnershipUI?.decorateRow(box, ownershipHints[c.provider + ':' + c.id]);
    return box;
  }
  function agentBadge(a) {
    const small = text('small', '', 'agent-state');
    small.append(
      text('span', a.live ? 'Live' : 'Saved', 'badge ' + (a.live ? 'badge-live' : 'badge-saved')),
      text('span', ' ' + agentStateLabel(a), 'status-detail'),
    );
    return small;
  }
  function subagentTitle(child, old, id) {
    const generic = /^Subagent [0-9a-f]{8}$/;
    const previous = old?.name && !generic.test(old.name) ? old.name : '';
    const line = (v) => (typeof v === 'string' && v.trim() ? v.trim().split(/\r?\n/)[0].slice(0, 120) : '');
    return (
      line(child.title) ||
      line(child.name) ||
      line(child.description) ||
      previous ||
      'Subagent ' + String(id).slice(0, 8)
    );
  }
  function forgetAttemptById(id) {
    if (!id) return;
    const attempts = readAttempts();
    let changed = false;
    for (const [identity, value] of Object.entries(attempts))
      if (value === id) {
        delete attempts[identity];
        changed = true;
      }
    if (changed) {
      try {
        localStorage.setItem(attemptStoreKey, JSON.stringify(attempts));
      } catch {}
    }
  }
  function historyWindow(key, thinking) {
    let w = historyWindows.get(key);
    if (!w || w.thinking !== thinking) {
      w = { thinking, start: 0, end: 0, total: 0, events: [], loaded: false, expanded: false, busy: false };
      historyWindows.delete(key);
      historyWindows.set(key, w);
      /* chats shown in split side panes are not evicted */ const pinned = new Set(
        (window.AgentSplitUI?.active?.() ? window.AgentSplitUI.mirrorTargets() : []).map(
          (t) => mirrorState.get(t.key)?.histKey,
        ),
      );
      while (historyWindows.size > 8) {
        const old = [...historyWindows.keys()].find((k) => k !== key && !pinned.has(k));
        if (old === undefined) break;
        historyWindows.delete(old);
      }
    }
    return w;
  }
  async function pollHistory(key) {
    const thinking = thinkingOn() ? '1' : '0',
      w = historyWindow(key, thinking);
    if (!w.loaded) {
      const data = await get('/api/transcript', { key, limit: HISTORY_PAGE, thinking });
      if (w.loaded) return w;
      w.events = data.events;
      w.context = data.context || [];
      w.start = data.before;
      w.end = data.end ?? data.total;
      w.total = data.total;
      w.loaded = true;
      return w;
    }
    for (let pass = 0; pass < 20; pass++) {
      const from = w.end;
      const data = await get('/api/transcript', { key, after: from, limit: 500, thinking });
      /* another poll of this chat (main view and a side pane share a window) already took these events: appending them again would repeat messages */
      if (w.end !== from || historyWindows.get(key) !== w) break;
      if (data.total < w.end) {
        historyWindows.delete(key);
        return pollHistory(key);
      }
      w.total = data.total;
      if (!data.events.length) break;
      w.events.push(...data.events);
      w.end = data.end;
      if (data.end >= data.total) break;
    }
    /* never trim while an older page is arriving: the page would then be joined to a window that no longer starts where it ended */
    if (!w.expanded && !w.busy && w.events.length > HISTORY_CAP) {
      const drop = w.events.length - HISTORY_CAP;
      w.events = w.events.slice(drop);
      w.start += drop;
      /* the dropped events now sit before the window: fetch the plan context for the new start (one event, so cheap) */
      try {
        const c = await get('/api/transcript', { key, before: w.start, limit: 1, thinking });
        w.context = c.context || [];
      } catch {}
    }
    return w;
  }
  function renderMainHistory(w, key) {
    const box = $('messages');
    showRows(box, normalized({ events: w.events, context: w.context, start: w.start }, key, true), 'main', {
      earlier: w.start > 0,
      ...savedExtra(key, w),
      find: findState(w),
    });
    syncLoadEarlier(box, key, w, 'main');
  }
  function syncLoadEarlier(box, key, w, which) {
    const existing = box.querySelector('.load-history');
    if (w.start <= 0 || box.querySelector('.show-earlier')) {
      existing?.remove();
      return;
    }
    const label = 'Load earlier messages (' + w.start + ' earlier)';
    if (existing) {
      existing.textContent = label;
      return;
    }
    const button = text('button', label, 'load-history');
    button.onclick = () => loadEarlier(key, which);
    box.prepend(button);
  }
  /* Fetch part: one older page into the history window w (shared by the main view and split side panes). */
  async function fetchEarlier(w, key) {
    if (!w || w.busy || w.start <= 0) return false;
    w.busy = true;
    try {
      const data = await get('/api/transcript', { key, before: w.start, limit: HISTORY_PAGE, thinking: w.thinking });
      w.events = [...data.events, ...w.events];
      w.context = data.context || [];
      w.start = data.before;
      w.expanded = true;
      return true;
    } finally {
      w.busy = false;
    }
  }
  async function loadEarlier(key, which) {
    const w = historyWindows.get(key);
    if (!w || w.busy || w.start <= 0) return;
    const box = $(which === 'main' ? 'messages' : 'submessages'),
      ctl = managed(box),
      oldHeight = box.scrollHeight,
      oldTop = box.scrollTop;
    if (ctl) ctl.anchorTop('earlier'); // the rows you see stay put while the older page is drawn above them
    try {
      if (!(await fetchEarlier(w, key))) return;
      if (which === 'main') {
        mainSignature = '';
        renderMainHistory(w, key);
      } else {
        subSignature = '';
        showRows(box, normalized({ events: w.events, context: w.context, start: w.start }, key), 'sub');
        syncLoadEarlier(box, key, w, 'sub');
      }
      if (ctl) ctl.afterRedraw();
      else box.scrollTop = box.scrollHeight - oldHeight + oldTop;
    } catch (error) {
      fail(error);
    }
  }
  function liveHistoryNote(next) {
    historyNoticeOn = events.length >= 6000 || !!next?.reset;
    const note = $('historyNote');
    if (note) note.hidden = true;
    syncChatView();
  }
  function renderDiscover() {
    const box = $('discoverBox');
    if (!box) return;
    const state = agentListed[provider];
    box.hidden = !discoveryEnabled || !state;
    if (!state) return;
    const button = $('discoverSessions');
    button.textContent = state.busy
      ? 'Asking the agent…'
      : state.loaded
        ? state.cursor
          ? 'Load more from agent'
          : 'Agent list complete'
        : 'Find more chats via agent';
    button.disabled = state.busy || (state.loaded && !state.cursor);
    $('discoverNote').textContent =
      state.note || 'Starts the agent briefly to ask which sessions it knows. Nothing is loaded or sent.';
  }
  async function discoverSessions() {
    const p = provider,
      state = agentListed[p];
    if (!state || state.busy || (state.loaded && !state.cursor)) return;
    state.busy = true;
    state.note = '';
    renderDiscover();
    try {
      const result = await post('discover', { provider: p, cursor: state.cursor || undefined });
      state.loaded = true;
      if (!result.supported) {
        state.note = 'This agent does not advertise session listing.';
        state.cursor = null;
      } else {
        const have = new Set(state.sessions.map((x) => x.sessionId));
        for (const item of result.sessions) if (!have.has(item.sessionId)) state.sessions.push(item);
        state.cursor = result.nextCursor || null;
        state.note =
          state.sessions.length + ' listed by the agent' + (state.cursor ? ' · more available' : ' · end of list');
      }
      await listConversations();
    } catch (error) {
      state.note = 'Could not list sessions: ' + error.message;
    } finally {
      state.busy = false;
      renderDiscover();
    }
  }
  function disarmStop(refocus) {
    const wasArmed = stopArmed;
    stopArmed = false;
    clearTimeout(stopArmTimer);
    stopArmTimer = null;
    const hadFocus = refocus && wasArmed && !$('stopSubagentConfirm').hidden;
    renderSubagentControls();
    if (hadFocus && !$('stopSubagent').hidden) $('stopSubagent').focus({ preventScroll: true });
  }
  function renderSubagentControls() {
    const button = $('stopSubagent');
    if (!button) return;
    const info = subSelection?.live && current && snapshot?.subagents ? snapshot.subagents[subSelection.key] : null;
    const ended = !/^(running|working|in[-_ ]progress|active|starting|queued|busy|streaming)$/i.test(
      String(info?.state || ''),
    );
    const can =
      !!info && !!info.capabilities && Object.prototype.hasOwnProperty.call(info.capabilities, 'cancel') && !ended;
    if (!can && stopArmed) {
      stopArmed = false;
      clearTimeout(stopArmTimer);
    }
    const armed = stopArmed && !stoppingSubagent;
    $('stopSubagentBox').hidden = !can;
    button.hidden = !can || armed;
    button.disabled = !can || stoppingSubagent;
    button.textContent = stoppingSubagent ? 'Stopping…' : 'Stop';
    $('stopSubagentConfirm').hidden = !can || !armed;
    $('stopSubagentCancel').hidden = !can || !armed;
  }
  // Two-step stop in place: the first click arms (Stop + Cancel appear where the button was), the second Stop cancels.
  $('stopSubagent').onclick = () => {
    if (!subSelection || !current || stoppingSubagent) return;
    stopArmed = true;
    clearTimeout(stopArmTimer);
    stopArmTimer = setTimeout(() => disarmStop(true), 5000);
    renderSubagentControls();
    $('stopSubagentConfirm').focus({ preventScroll: true });
  };
  $('stopSubagentCancel').onclick = () => disarmStop(true);
  $('stopSubagentBox').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stopArmed) {
      e.preventDefault();
      e.stopPropagation();
      disarmStop(true);
    }
  });
  $('stopSubagentConfirm').onclick = async () => {
    if (!stopArmed || !subSelection || !current || stoppingSubagent) return;
    stopArmed = false;
    clearTimeout(stopArmTimer);
    stoppingSubagent = true;
    renderSubagentControls();
    try {
      await post('cancel', { id: current, subagentSessionId: subSelection.key });
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      stoppingSubagent = false;
      renderSubagentControls();
    }
  };
  $('discoverSessions').onclick = discoverSessions;
  // A chat's worktree was discarded from the Changes tab: its connection is closed now, so show the list and the chat as they are.
  window.addEventListener('agent-studio:worktree-discarded', (e) => {
    const id = e?.detail?.id || '';
    if (selected && (id === current || id === aliasKey(selected) || !id)) {
      selected = rememberDiscarded(selected);
      renderHeader();
    }
    sidebarSignature = '';
    Promise.resolve()
      .then(() => refresh())
      .then(() => listConversations())
      .catch(fail);
  });
  window.AgentEditors?.init({ get, post, fail, cwd: () => selected?.cwd || '' });
  window.AgentOrganizeUI?.init({
    get: (path) => get(path),
    post,
    aliasKey,
    titleOf,
    rename: (c) => startRename(c),
    conversations: () => conversations,
    setName: (c, v) => renameChat(c, v),
    handoff: (c) => handoffFor(c),
    getSelected: () => selected,
    fail,
    rerender: () => {
      sidebarSignature = '';
      renderConversations();
    },
    refreshList: () => listConversations().catch(fail),
    endSession: async (c) => {
      await post('disconnect', { id: c.live.id });
      if (current === c.live.id) {
        await refresh();
      }
    },
    closeSelected: () => {
      $('new').onclick();
      window.AgentBreadth?.sync(null, breadthContext());
    },
  });

  window.AgentReadState?.init({ get, post });
  window.AgentSidebarUI?.init({
    aliasKey,
    /* scrolled up in the open chat, or the chat is still opening (its "New" line is not placed yet): not "viewed" up to now */
    holdSeen: (c) => !!$('messages')?.dataset.paused || UNREAD.opening || (!!c && aliasKey(c) !== UNREAD.chat),
    getSelected: () => selected,
    ownershipOf: (c) => ownershipHints[c.provider + ':' + c.id],
    issueFor: (c) => !!(connectionIssue && selected && aliasKey(selected) === aliasKey(c)),
    rerender: () => {
      sidebarSignature = '';
      renderConversations();
    },
  });
  window.AgentWorkspaceUI?.init({
    aliasKey,
    titleOf,
    getJson: get,
    postJson: post,
    quickPrompt,
    reload: reloadAfterAnswer,
    conversations: () => conversations,
    getSelected: () => selected,
    open: async (c) => {
      await openConversation(c);
    },
    showStart: () => $('new').onclick(),
    notice: (m) => fail(Error(m)),
    rerender: () => {
      sidebarSignature = '';
      renderConversations();
    },
  });
  window.AgentDocLinks?.init({
    getJson: get,
    post: (path, body) => post(path, body),
    notice: (m) => fail(Error(m)),
  });
  window.AgentFilesUI?.init({
    aliasKey,
    titleOf,
    getJson: get,
    post: (path, body) => post(path, body),
    notice: (m) => fail(Error(m)),
    conversations: () => conversations,
    open: async (c) => {
      await openConversation(c);
    },
  });
  window.AgentSwitcherUI?.init({
    conversations: () => conversations,
    aliasKey,
    titleOf,
    getSelected: () => selected,
    open: async (c) => {
      window.AgentSidebarUI?.reveal(c);
      sidebarSignature = '';
      await openConversation(c);
    },
    newInProject: (c) => {
      $('new').onclick();
      if (c?.cwd) {
        $('cwd').value = c.cwd;
        $('provider').value = c.provider;
      }
      $('connect').focus();
    },
  });
  // ---- Split view: a pane that is not focused shows a live read-only copy of its chat (split-ui.js). The focused pane is the real view above.
  const mirrorState = new Map();
  function mirrorEntry(key) {
    let m = mirrorState.get(key);
    if (!m) {
      m = { id: '', cursor: 0, events: [], rows: null };
      mirrorState.set(key, m);
      while (mirrorState.size > 12) mirrorState.delete(mirrorState.keys().next().value);
    }
    return m;
  }
  async function mirrorRows(c) {
    const key = aliasKey(c),
      m = mirrorEntry(key);
    if (c.live && !c.live.closed) {
      if (m.id !== c.live.id) {
        m.id = c.live.id;
        m.cursor = 0;
        m.events = [];
        m.eventsId = '';
      }
      let next = await get('/api/live/state', { id: m.id, after: m.cursor });
      if (next.eventsId && m.eventsId && next.eventsId !== m.eventsId && m.cursor) {
        next = await get('/api/live/state', { id: m.id, after: 0 });
        m.events = [];
      }
      if (next.eventsId) m.eventsId = next.eventsId;
      m.histKey = '';
      if (next.reset) m.events = [];
      m.events.push(...next.events);
      m.events = m.events.slice(-6000);
      m.cursor = next.cursor;
      m.sid = next.sessionId;
      m.rows = liveRows(next.sessionId, m.events, next);
    } else if (isPseudoKey(c.key)) {
      m.histKey = '';
      m.rows = [{ role: 'notice', label: 'Not running', value: pseudoNote(c) }];
    } else {
      const w = await pollHistory(c.key);
      m.histKey = c.key;
      m.rows = normalized({ events: w.events, context: w.context, start: w.start }, c.key);
    }
    return m.rows;
  }
  /* Side panes draw a window of the rows (80, growing by 80) and grow it as you scroll back. State lives on the box (_mirrorWin).
   Live chats go back as far as liveRows keeps rows; saved chats also fetch older transcript pages (fetchEarlier). */
  const MIRROR_NEAR = 200;
  function mirrorBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  }
  /* Is a split pane's chat working, and what is it doing: an attached chat reads its live events, a saved one (running in another app) the saved transcript. */
  function mirrorWorking(key, m) {
    const CV = window.ChatViews,
      c = conversations.find((x) => aliasKey(x) === key);
    if (!CV || !c) return { working: false, live: null };
    if (c.live && !c.live.closed) {
      const working = !!c.live.busy;
      return { working, live: working ? liveOf(CV.liveStatus(m?.events, 'live', m?.sid), key, {}) : null };
    }
    if (!savedWorking(c.key)) return { working: false, live: null };
    const w = m?.histKey ? historyWindows.get(m.histKey) : null;
    return { working: true, live: w ? liveOf(CV.liveStatus(w.events, 'saved'), key, { elsewhere: true }) : null };
  }
  function paintMirror(box, rows) {
    const SU = window.StreamUI,
      key = box.dataset.mirror || '',
      m = mirrorState.get(key),
      hist = m?.histKey ? historyWindows.get(m.histKey) || null : null,
      thinking = thinkingOn(),
      view = window.ChatViews && viewStore ? viewStore.get(key) : 'full'; // a side pane shows its own chat's view
    const cur = { total: rows.length, thinking, hist, histStart: hist ? hist.start : 0, key, view };
    let st = box._mirrorWin;
    if (SU.mirrorShouldReset(st, cur)) {
      st = box._mirrorWin = {
        extra: 0,
        winStart: null,
        total: 0,
        thinking,
        view,
        hist,
        histStart: cur.histStart,
        key,
        loading: false,
        grow: false,
        lastSet: -1,
      };
      box._painted = false;
      box._sig = '';
    }
    if (!box._mirrorBound) {
      box._mirrorBound = true;
      box.addEventListener('scroll', () => {
        const s = box._mirrorWin;
        if (!s || Math.abs(box.scrollTop - s.lastSet) <= 2) return;
        if (box.scrollTop < MIRROR_NEAR) growMirror(box);
      });
      box.addEventListener(
        'wheel',
        (e) => {
          if (e.deltaY < 0 && box.scrollTop <= 0) growMirror(box);
        },
        { passive: true },
      );
    }
    /* older saved rows were prepended (by a load here or in the main view): the remembered window start moves with them */
    if (hist && st.hist === hist && hist.start < st.histStart) {
      if (Number.isInteger(st.winStart)) st.winStart += rows.length - st.total;
      st.histStart = hist.start;
    }
    const atEnd = !box._painted || mirrorBottom(box);
    let f = SU.freezeWindow(rows.length, st.extra, st.winStart, atEnd);
    st.extra = f.extra;
    if (st.grow) {
      st.grow = false;
      st.extra = f.win.nextExtra;
      f = SU.freezeWindow(rows.length, st.extra, st.winStart, atEnd);
    }
    const win = f.win,
      drawn = win.start ? rows.slice(win.start) : rows;
    const condensed = view !== 'full',
      working = condensed ? mirrorWorking(key, m) : null;
    /* the view is in the signature (and in mirrorShouldReset); the live line's step and clock are not: tickLive updates those in place */
    const signature =
      SU.MIRROR_BASE +
      st.extra +
      '@' +
      win.start +
      '|' +
      thinking +
      '|' +
      view +
      (condensed ? '|' + (working.working ? 1 : 0) + (working.live && working.live.talking ? 't' : '') : '') +
      '|' +
      SU.rowsSignature(drawn);
    if (condensed && working.live && window.ChatViewsUI) window.ChatViewsUI.refreshLive(box, working.live);
    st.total = rows.length;
    st.winStart = win.start;
    st.hist = hist;
    st.histStart = cur.histStart;
    st.thinking = thinking;
    if (box._sig === signature) return;
    box._sig = signature;
    {
      const chat = conversations.find((x) => aliasKey(x) === key);
      announceTurns(box, key, rows, chat ? titleOf(chat) : '');
    }
    const top = box.scrollTop,
      anchor = atEnd ? null : scrollAnchor(box),
      opens = [...box.querySelectorAll('details')].map((d, i) => (d.open ? i : -1)).filter((i) => i >= 0),
      fragment = document.createDocumentFragment();
    if (condensed) {
      const proj = window.ChatViews.project(drawn, view, {
          earlier: win.start > 0 || !!(hist && hist.start > 0),
          working: working.working,
          live: working.live,
        }),
        ctx = {
          bubble: tagged(viewBubble),
          groupRows: (list, render) => window.ToolViews?.groupRows?.(list, render) || list.map(render),
        };
      if (view === 'prompts') fragment.append(...window.ChatViewsUI.promptNodes(proj, 0, ctx));
      else fragment.append(...window.ChatViewsUI.listNodes(proj, 0, ctx));
    } else if (!drawn.length) fragment.append(text('p', 'No messages yet.', 'empty-state'));
    else if (window.ToolViews?.groupRows) fragment.append(...window.ToolViews.groupRows(drawn, tagged(bubble)));
    else for (const row of drawn) fragment.append(tagged(bubble)(row));
    box.replaceChildren(fragment);
    markRepeatedTimes(box);
    if (!condensed)
      for (const i of opens) if (box.querySelectorAll('details')[i]) box.querySelectorAll('details')[i].open = true;
    box._painted = true;
    if (atEnd) box.scrollTop = box.scrollHeight;
    else {
      box.scrollTop = top;
      if (restoreAnchor(box, anchor))
        holdAnchor(
          box,
          anchor,
          () => !mirrorBottom(box),
          () => {
            st.lastSet = box.scrollTop;
          },
        );
    }
    st.lastSet = box.scrollTop;
    fillMirror(box);
  }
  /* One step back: widen the window; at the start of the loaded rows fetch an older saved page (one at a time). */
  function growMirror(box) {
    const st = box._mirrorWin,
      m = mirrorState.get(box.dataset.mirror);
    if (!st || !m?.rows) return;
    if (st.winStart > 0) {
      st.grow = true;
      paintMirror(box, m.rows);
      return;
    }
    const hist = m.histKey ? historyWindows.get(m.histKey) : null;
    if (hist && window.StreamUI.needOlderPage(st.winStart, hist.start, st.loading || hist.busy))
      loadOlderForPane(box, m, hist);
  }
  async function loadOlderForPane(box, m, hist) {
    const st = box._mirrorWin;
    st.loading = true;
    let ok = false;
    try {
      if (!(await fetchEarlier(hist, m.histKey))) return;
      if (
        !box.isConnected ||
        box._mirrorWin !== st ||
        mirrorState.get(box.dataset.mirror) !== m ||
        historyWindows.get(m.histKey) !== hist
      )
        return;
      m.rows = normalized({ events: hist.events, context: hist.context, start: hist.start }, m.histKey);
      st.grow = true;
      paintMirror(box, m.rows);
      ok = true;
    } catch {
    } finally {
      st.loading = false;
      if (box.isConnected && box._mirrorWin === st) {
        fillMirror(box);
        if (ok && box.scrollTop < MIRROR_NEAR) growMirror(box);
      }
    }
  }
  /* Content does not overflow the box and older rows exist: keep growing until it does or nothing older remains. */
  function fillMirror(box) {
    const st = box._mirrorWin,
      m = mirrorState.get(box.dataset.mirror);
    if (!st || !m?.rows || !box.isConnected || !box.clientHeight) return;
    const hist = m.histKey ? historyWindows.get(m.histKey) : null;
    if (
      window.StreamUI.needFill(
        box.scrollHeight > box.clientHeight + 1,
        st.winStart,
        hist ? hist.start : 0,
        st.loading || !!hist?.busy,
      )
    )
      growMirror(box);
  }
  let mirrorBusy = false;
  async function tickMirrors() {
    const S = window.AgentSplitUI;
    if (!S || !S.active() || mirrorBusy) return;
    mirrorBusy = true;
    try {
      for (const t of S.mirrorTargets()) {
        const c = conversations.find((x) => aliasKey(x) === t.key);
        if (!c || !t.box.isConnected) continue;
        try {
          const rows = await mirrorRows(c);
          if (!t.box.isConnected || t.box.dataset.mirror !== t.key) continue;
          paintMirror(t.box, rows);
          fillMirror(t.box);
        } catch {}
      }
    } finally {
      mirrorBusy = false;
    }
  }
  setInterval(tickMirrors, 1500);
  window.AgentSplitUI?.init({
    convOf: (key) => conversations.find((c) => aliasKey(c) === key),
    selectedKey: () => (selected ? aliasKey(selected) : ''),
    open: (c) => {
      openConversation(c).catch(fail);
    },
    showStart: () => $('new').onclick(),
    notice: (m) => fail(Error(m)),
    titleOf,
    redraw: () => window.AgentWorkspaceUI?.refresh(),
    singleTabs: () => window.AgentWorkspaceUI?.singleTabs() || [],
    orderTabs: (list) => window.AgentWorkspaceUI?.orderTabs(list),
    dotFor: (key) => window.AgentWorkspaceUI?.dotForKey(key) || null,
    statusText: (c) => window.AgentWorkspaceUI?.statusTextOf(c) || '',
    draftOf: (key) => drafts.get(key),
    agentName: (c) => nameOf(c.provider),
    mirror: {
      rows: (key) => mirrorState.get(key)?.rows || null,
      paint: paintMirror,
      stash: (key) => {
        if (key && lastMainRows.length) mirrorEntry(key).rows = lastMainRows;
      },
      wake: () => setTimeout(tickMirrors, 60),
    },
  });
  /* The chat's own terminal (terminal-ui.js), keyed by aliasKey like split panes' data-mirror. Its cwd is the chat's working folder
     (a live chat's cwd is its worktree when it has one). Nothing typed in it goes to the agent. */
  window.AibTerminal?.init({
    current: () =>
      selected
        ? {
            key: aliasKey(selected),
            cwd: selected.live?.cwd || selected.cwd || '',
            project: selected.live?.projectRoot || selected.projectRoot || '',
            title: titleOf(selected),
          }
        : null,
    titleOf: (key) => {
      const c = conversations.find((x) => aliasKey(x) === key);
      return c ? titleOf(c) : '';
    },
    token: async () => {
      if (!token) await refreshToken();
      return token;
    },
    refreshToken,
    get: (path) => get('/api/live/' + path),
    post,
    changed: () => {
      sidebarSignature = '';
      renderConversations();
    },
    focusComposer: () => $('prompt').focus(),
    select: async (key) => {
      if (selected && aliasKey(selected) === key) return true;
      // A split side pane showing that chat: focus it (its chat becomes the open one); else open the chat here.
      const pane = [...document.querySelectorAll('.mirror-msgs')].find((m) => m.dataset.mirror === key);
      let group = '';
      for (let n = pane; n && !group; n = n.parentNode) group = n.dataset?.g || '';
      if (group && window.AgentSplitUI?.focusPane) window.AgentSplitUI.focusPane(group);
      else {
        const c = conversations.find((x) => aliasKey(x) === key);
        if (!c) return false;
        await openConversation(c);
      }
      for (let i = 0; i < 50 && !(selected && aliasKey(selected) === key); i++)
        await new Promise((r) => setTimeout(r, 100));
      return !!selected && aliasKey(selected) === key;
    },
  });
  // Settings page: the agent list and the defaults for new chats come from the server (Settings is the source of truth).
  function registryChanged() {
    const agents = AgentChoice.menuItems(AgentChoice.AGENTS);
    fillSelect($('provider'), agents, AgentChoice.isAgent($('provider').value) ? $('provider').value : agents[0].value);
    if (newDraft && !selected) {
      if (!AgentChoice.isAgent(newDraft.provider)) {
        newDraft.provider = AgentChoice.loadChoice(localStorage, newChatFolder().cwd);
        newDraft.picked = false;
        applyDefaultPicks(newChatFolder().cwd);
      }
      renderNewChat();
    }
    sidebarSignature = '';
    renderConversations();
  }
  /* Settings > Default chat view changed: a chat with no choice of its own follows it at once. */
  let lastDefaultView = null;
  function settingsChanged() {
    const d = window.AgentSettingsUI?.defaultView?.();
    if (d === lastDefaultView) return;
    lastDefaultView = d;
    if (!viewStore || !curKey() || viewStore.has(curKey())) return;
    mainSignature = '';
    window.ChatViewsUI?.sync();
    repaintMain();
  }
  window.AgentSettingsUI?.init({
    get: (path, params) => get(path, params),
    post,
    registryChanged,
    settingsChanged,
  });
  window.StartPageUI?.init();
  window.AibUpdates?.init({ get: (path, params) => get(path, params), post }, $('updateBanner'));

  try {
    renderAgents();
    renderCommands();
  } catch (e) {} /* empty Activity column on first paint */
  // ---- Message stream, history notice and chats running in another app ----
  let historyNoticeOn = false;
  const HISTORY_NOTICE =
    'AIB keeps only the most recent 6,000 live events in memory. Earlier history stays in the agent\u2019s saved transcript.';
  // Read by the header (Ctx chip tooltip): the notice is no longer drawn in the message stream.
  window.AgentChatView = Object.assign(window.AgentChatView || {}, {
    notices: () => (historyNoticeOn ? [HISTORY_NOTICE] : []),
  });
  function syncChatView() {
    if (document.body?.dataset) document.body.dataset.historyNotice = historyNoticeOn ? HISTORY_NOTICE : '';
  }
  function resolveAgentName(from) {
    const hit = allAgentRows().find((r) => r.agentId === from || r.key === from || String(r.key).endsWith(from));
    if (!hit) return '';
    const n = window.SubagentsUI?.names?.(hit);
    return (n && n.title) || hit.name || '';
  }
  /* The chat's current plan, pinned above the message box while it still has unfinished steps (like Claude's app). */
  /* The latest plan row while it still has unfinished steps (it is shown pinned, not in the history), else null. */
  var PLAN_AT_END = true;
  function dockedPlan(rows) {
    for (let i = rows.length - 1; i >= 0; i--)
      if (rows[i].role === 'plan') {
        const e = rows[i].entries;
        return Array.isArray(e) && e.length && e.some((x) => x.status !== 'completed') ? rows[i] : null;
      }
    return null;
  }
  /* A chat has one plan card: every plan update is the whole list, so only the newest is drawn. Earlier copies would read as
     snapshots left behind in the history. */
  function latestPlanOnly(shown, rows) {
    let last = null;
    for (let i = rows.length - 1; i >= 0 && !last; i--) if (rows[i].role === 'plan') last = rows[i];
    return last ? shown.filter((r) => r.role !== 'plan' || r === last) : shown;
  }
  /* An unfinished plan is the chat's last item (it scrolls with the history), placed before the closing "turn finished" line,
     also after you send another message: it moves down with the chat until every step is done, then stays where it ended. */
  function planLast(shown, rows, plan) {
    const rest = latestPlanOnly(shown, rows).filter((r) => r !== plan);
    let end = rest.length;
    while (end > 0 && rest[end - 1].role === 'turn-end') end--;
    return [...rest.slice(0, end), plan, ...rest.slice(end)];
  }
  function updatePlanDock(rows) {
    const dock = $('planDock');
    if (!dock) return;
    /* The owner prefers the unfinished plan as the chat's last item (showRows draws it there) over a box pinned above the composer. */
    if (PLAN_AT_END) {
      if (!dock.hidden || dock.childNodes.length) {
        dock.hidden = true;
        dock.replaceChildren();
        delete dock.dataset.sig;
      }
      return;
    }
    const plan = dockedPlan(rows),
      at = plan ? rows.indexOf(plan) : -1,
      entries = plan ? plan.entries : [];
    if (!plan) {
      dock.hidden = true;
      dock.replaceChildren();
      return;
    }
    const sinceUser = rows.slice(at + 1).filter((r) => r.role === 'user' && isMsgRow(r)).length,
      later = sinceUser > 0,
      busy = !!(snapshot && snapshot.busy) || !!plan.active,
      running = plan.running || 0;
    const sig = JSON.stringify([entries, later, busy, running]);
    if (dock.dataset.sig === sig && !dock.hidden) return;
    dock.dataset.sig = sig;
    const head = document.createElement('div');
    head.className = 'plan-dock-head';
    head.textContent = later ? 'Plan from before your last message' : 'Plan';
    const done = entries.filter((e) => e.status === 'completed').length,
      count = document.createElement('span');
    count.className = 'plan-count';
    count.textContent = ' ' + done + '/' + entries.length + ' done';
    head.append(count);
    const list = document.createElement('ul');
    list.className = 'plan-list';
    for (const e of entries.slice(0, 6)) {
      const li = document.createElement('li');
      li.className = 'plan-item plan-' + e.status;
      const mark = document.createElement('span');
      if (e.status === 'completed') ((mark.className = 'plan-mark'), (mark.textContent = '✓'));
      else if (e.status === 'in_progress') mark.className = 'plan-mark plan-' + (busy ? 'spin' : 'dot');
      else mark.className = 'plan-mark plan-pend';
      const text = document.createElement('span');
      text.className = 'plan-text';
      text.textContent = e.content;
      li.append(mark, text);
      if (running && e.status === 'in_progress') {
        const note = document.createElement('span');
        note.className = 'plan-note';
        note.textContent = running + (running === 1 ? ' running task' : ' running tasks');
        li.append(note);
      }
      list.append(li);
    }
    if (entries.length > 6) {
      const more = document.createElement('li');
      more.className = 'plan-more';
      more.textContent = '+' + (entries.length - 6) + ' more';
      list.append(more);
    }
    dock.replaceChildren(head, list);
    dock.hidden = false;
  }
  function streamSpecial(row) {
    if (row.role === 'plan' && window.PlanUI) {
      const card = window.PlanUI.card(row);
      return window.CopyUI ? window.CopyUI.decorate(card, row) : card;
    }
    if (row.role === 'nextstep' && window.PlanUI?.nextStepCard) {
      const card = window.PlanUI.nextStepCard(row);
      return window.CopyUI ? window.CopyUI.decorate(card, row) : card;
    }
    const S = window.StreamUI;
    if (!S) return null;
    if (row.role === 'turn-end') return S.divider(row);
    if (row.role === 'answered') return answeredLine(row);
    if (row.role === 'user' && !(row.attachments && row.attachments.length)) {
      const note = S.classifyUser(row.value);
      if (note) return S.noteCard(note, row, resolveAgentName);
    }
    return null;
  }
  // Contract: conversation.elsewhere = {working, confirmed, verdict} exists only for a chat another app owns or may own (stable
  // ownership verdict, two agreeing checks) that this Studio is not running. working = its transcript is changing or Activity
  // shows subagents/processes working (also two agreeing checks); confirmed = strong evidence (the only case that may be red).
  function annotateElsewhere() {
    window.AgentOwnershipUI?.annotate?.(conversations, ownershipHints, {
      now: Date.now() / 1000,
      key: selected && aliasKey(selected),
      activeWork: actCounts.working > 0 || commands.some(isRunningCommand),
      aliasKey,
    });
  }
  const elsewhereLocked = (c) => !!(c && !c.live && c.elsewhere && c.elsewhere.working);
  function applyElsewhereGuard() {
    if (!selected || current || !elsewhereLocked(selected)) return;
    $('prompt').disabled = true;
    $('prompt').placeholder = 'Running in another app. You can read along here.';
    $('send').disabled = true;
  }

  // ---- Follow is automatic: new messages scroll into view while you are at the bottom; scrolling up pauses it and a
  // "New messages" button brings you back. (There is no Follow checkbox any more.)
  function followBox(box) {
    if (!box.dataset.paused) return true;
    box.dataset.unseen = '1';
    if (box.id === 'messages') syncJump();
    return false;
  }
  /* Unread messages. When you scroll up in the main chat, Studio remembers how many
   messages (your and the agent's bubbles; not tool steps or notes) were there. Messages that arrive after that are unread: a
   "New" line goes above the first one, the button counts them and takes you to the line, then reads "↓ Latest". */
  /* Read state is kept against the chat's underlying message rows (all: their keys and times, in order), never against the
     bubbles a view draws: `mark` is the last message you had read when you scrolled up. So every view agrees on what is
     read and unread, and switching views changes neither. holdUntil: a view switch moves the scroll position by itself;
     scroll events until then do not touch the read state. The position you had seen when you left lives on the server
     (AgentReadState, keyed provider:sessionId): it survives restarts and is the same in every browser. */
  const UNREAD = {
    count: 0,
    mark: null,
    all: [],
    rows: [],
    jumped: false,
    lineUntil: 0,
    lineAt: null,
    chat: null,
    newest: 0,
    scrollLine: false,
    holdUntil: 0,
  };
  const seenAtOf = (chat) => window.AgentReadState?.seenAt(chat) || 0;
  const rowTime = (r) => {
    const t = r && r.time;
    if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : 0;
  };
  const isMsgRow = (r) =>
    !!r &&
    (r.role === 'assistant' ||
      (r.role === 'user' && !(!(r.attachments && r.attachments.length) && window.StreamUI?.classifyUser?.(r.value)))) &&
    !!(r.value || (r.attachments && r.attachments.length));
  /* Only the agent's messages can be unread: your own never get a "New" line or count in the button. */
  const isUnreadRow = (r) => isMsgRow(r) && r.role === 'assistant';
  function markSeen(chat, time) {
    if (!chat || !time) return;
    window.AgentReadState?.mark(chat, time, UNREAD.count);
  }
  const msgBubbles = (box) => [...box.children].filter((e) => e.matches('.bubble.assistant'));
  function unreadReset() {
    UNREAD.mark = null;
    UNREAD.jumped = false;
    UNREAD.lineUntil = 0;
    UNREAD.lineAt = null;
  }
  const msgKey = (r) =>
    rowTime(r) + ':' + r.role + ':' + String(r.value || '').length + ':' + String(r.value || '').slice(-12);
  const markNow = () => {
    const last = UNREAD.all[UNREAD.all.length - 1];
    return last ? { key: last.key, time: last.time } : { key: '', time: 0 };
  };
  /* How many of the underlying message rows are read (null: not tracking, you are at the bottom). */
  function readIndex() {
    const m = UNREAD.mark;
    if (!m) return null;
    if (m.key === '') return 0;
    for (let i = UNREAD.all.length - 1; i >= 0; i--) if (UNREAD.all[i].key === m.key) return i + 1;
    return UNREAD.all.filter((a) => a.time <= m.time).length; // the row left the loaded rows: go by its time
  }
  function unreadCount() {
    const read = readIndex();
    return read == null ? 0 : Math.max(0, UNREAD.all.length - read);
  }
  /* Prompts: the newest time up to which every message is either one of your prompts or a reply inside an opened prompt.
     A hidden reply is not seen, and nothing after it counts either. */
  function promptsSeenUpTo(rows, chat) {
    const base = (chat && seenAtOf(chat)) || 0,
      open = window.ChatViewsUI.POPEN,
      visible = new Set();
    for (const u of window.ChatViews.project(rows, 'prompts', {}).units) {
      visible.add(u.prompt);
      if (open.has(u.key)) for (const r of u.rows) visible.add(r);
    }
    let upTo = 0;
    for (const r of rows) {
      if (!isMsgRow(r) || rowTime(r) <= base) continue;
      if (!visible.has(r)) break;
      upTo = rowTime(r);
    }
    return upTo;
  }
  /* A prompt was opened in Prompts: its replies are seen now. */
  function promptOpened() {
    markSeen(UNREAD.chat, promptsSeenUpTo(UNREAD.rows, UNREAD.chat));
  }
  /* After every render of #messages: put the line back where it belongs (renders rebuild the list).
     shown: the rows this view drew as top-level bubbles; rows: all the rows of the chat, whatever the view. */
  function placeNewLine(box, shown, rows) {
    if (box.id !== 'messages') return;
    const all = (rows || shown || []).filter(isUnreadRow),
      chat = selected ? aliasKey(selected) : null;
    UNREAD.rows = rows || shown || [];
    UNREAD.all = all.map((r) => ({ key: msgKey(r), time: rowTime(r) }));
    if (window.ChatViews && viewOf() === 'prompts') UNREAD.newest = promptsSeenUpTo(UNREAD.rows, chat);
    else UNREAD.newest = UNREAD.all.length ? Math.max(...UNREAD.all.map((a) => a.time)) : 0;
    /* How many underlying messages that is (the server keeps it to place the line again after a restart). */
    UNREAD.count = UNREAD.all.filter((a) => a.time <= UNREAD.newest).length;
    if (chat !== UNREAD.chat) {
      UNREAD.chat = chat;
      unreadReset();
      UNREAD.opening = !!chat;
    }
    if (UNREAD.opening && (rows || shown || []).some(isMsgRow)) {
      UNREAD.opening = false;
      /* Opening a chat: if it has messages newer than the last one you saw here, start at the first of them. */
      /* Messages replayed after a restart carry no time (0): those are placed by how many you had seen. */
      const seenAt = chat ? seenAtOf(chat) : 0,
        seenCount = chat ? window.AgentReadState?.seenIndex(chat) : null,
        first = seenAt
          ? UNREAD.all.findIndex((a, i) => (a.time > 0 ? a.time > seenAt : seenCount != null && i >= seenCount))
          : -1;
      if (first >= 0) {
        UNREAD.mark =
          first > 0 ? { key: UNREAD.all[first - 1].key, time: UNREAD.all[first - 1].time } : { key: '', time: 0 };
        UNREAD.jumped = true;
        UNREAD.scrollLine = true;
        box.dataset.paused = '1';
      }
    }
    if (!box.dataset.paused && !UNREAD.opening) markSeen(chat, UNREAD.newest);
    box.querySelector(':scope > .new-line')?.remove();
    const fading = UNREAD.lineAt != null && Date.now() < UNREAD.lineUntil;
    let at = null;
    if (box.dataset.paused && unreadCount() > 0) {
      /* the first unread row's place in this view: if the view hides it, the next visible message */
      const drawn = (shown || []).filter(isUnreadRow),
        bubbles = msgBubbles(box);
      if (drawn.length === bubbles.length) {
        const place = new Map(rows ? rows.filter(isUnreadRow).map((r, i) => [r, i]) : []),
          from = readIndex(),
          p = drawn.findIndex((r) => (place.has(r) ? place.get(r) : -1) >= from);
        at = p >= 0 ? p : null;
      }
    } else if (fading) at = UNREAD.lineAt;
    if (at == null) return;
    const target = msgBubbles(box)[at];
    if (!target) return;
    const line = document.createElement('div');
    line.className = 'new-line' + (box.dataset.paused ? '' : ' fading');
    line.setAttribute('role', 'separator');
    line.setAttribute('aria-label', 'Unread messages start here');
    const label = document.createElement('span');
    label.textContent = 'New';
    line.append(label);
    box.insertBefore(line, target);
    UNREAD.lineAt = at;
  }
  function syncJump() {
    const button = $('jumpNew'),
      box = $('messages');
    if (!button) return;
    const n = unreadCount(),
      show = !!box.dataset.paused && (!!box.dataset.unseen || UNREAD.jumped || n > 0);
    button.hidden = !show;
    button.textContent = !UNREAD.jumped && n > 0 ? (n === 1 ? '1 new message ↓' : n + ' new messages ↓') : '↓ Latest';
  }
  for (const id of ['messages']) {
    const box = $(id);
    const pause = () => {
      if (!box.dataset.paused && id === 'messages') {
        UNREAD.mark = markNow();
        UNREAD.jumped = false;
      }
      box.dataset.paused = '1';
    };
    /* Any upward scroll you make stops following at once, even one wheel notch that ends nearer the bottom than the 48 px below
       (the next update would otherwise pull you back down). Following comes back only when you reach the very bottom again. */
    const scrolledUp = () => {
      if (box.scrollHeight - box.clientHeight <= 1) return;
      box._userUp = true;
      box._upAt = Date.now();
      pause();
      if (id === 'messages') syncJump();
    };
    box.addEventListener('wheel', (e) => e.deltaY < 0 && scrolledUp(), { passive: true });
    box.addEventListener('keydown', (e) => {
      if (
        ['ArrowUp', 'PageUp', 'Home'].includes(e.key) &&
        !e.target.closest?.('input, textarea, [contenteditable="true"]')
      )
        scrolledUp();
    });
    /* Opening something you clicked near the bottom (a step, "Show all", a fold): it stays where it is (the growth watcher
       below leaves it), and while what you opened reaches below the view following pauses, so the next update does not pull
       it off the top. Following comes back when you reach the very bottom yourself. */
    box.addEventListener(
      'click',
      (e) => {
        if (box.dataset.paused || !e.target?.closest?.('button, summary, [aria-expanded]')) return;
        const gapOf = () => box.scrollHeight - box.scrollTop - box.clientHeight,
          before = Math.max(1, gapOf()),
          width = box.clientWidth;
        /* What you clicked may resize the list instead (Open doc widens the right column, so every row wraps taller): that
           growth is not something you opened, the width watcher below keeps the list at the bottom. */
        const check = () => !box.dataset.paused && box.clientWidth === width && gapOf() > before && scrolledUp();
        requestAnimationFrame(check);
        for (const ms of [250, 600]) setTimeout(check, ms);
      },
      true,
    );
    box.addEventListener('scroll', () => {
      if (id === 'messages' && Date.now() < UNREAD.holdUntil) {
        syncJump(); // a view switch moved the scroll position: that is not you reading
        return;
      }
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      /* the list just changed width (the width watcher below): rows are still re-wrapping while the right column slides open
         (0.18 s) and the browser clamps scrollTop as the history shrinks, so this scroll is the resize, not you. Following stays
         at the bottom, reading stays paused (the watcher puts your row back). */
      if (Date.now() - (box._widthAt || 0) < 400) {
        if (!box.dataset.paused && gap > 1) box.scrollTop = box.scrollHeight;
        if (id === 'messages') syncJump();
        return;
      }
      if (gap > 48 || (box._userUp && gap > 1)) pause();
      else {
        box._userUp = false;
        if (id === 'messages') {
          if (box.dataset.paused) fadeNewLine(box);
          markSeen(UNREAD.chat, UNREAD.newest);
        }
        delete box.dataset.paused;
        delete box.dataset.unseen;
        if (id === 'messages') {
          UNREAD.mark = null;
          UNREAD.jumped = false;
        }
      }
      if (id === 'messages') syncJump();
    });
  }
  /* The message list gets shorter when something is pinned under it (a question or approval card, the terminal dock, the queue).
     Shrinking never scrolls, so a list that was following the newest message was left showing older rows while its last card
     (a plan) sat hidden under the pinned card. A list that follows keeps following: it stays at its newest row. */
  if (typeof ResizeObserver === 'function') {
    const box = $('messages');
    let lastHeight = box.clientHeight;
    new ResizeObserver(() => {
      const h = box.clientHeight;
      if (h < lastHeight && !box.dataset.paused && box.scrollHeight - box.scrollTop - box.clientHeight > 1)
        box.scrollTop = box.scrollHeight;
      lastHeight = h;
    }).observe(box);
  }
  /* The list gets narrower or wider (a doc or artifact opening in the right column widens it to 920 px, the chat list or the
     right column dragged, a pane beside the chat, the window): every row wraps again and the history grows or shrinks by
     thousands of px, and that never scrolls by itself (overflow-anchor: none). A list that follows goes back to its newest
     row; a list you are reading puts the row that was at the top of the view back at the same place, at the same point of
     that row (a long message that wraps taller keeps the line you were on, not the pixel offset). */
  for (const id of ['messages']) {
    const box = $(id);
    if (!box || typeof ResizeObserver !== 'function') continue;
    let width = box.clientWidth,
      reading = null,
      queued = false;
    const readAnchor = () => {
      const top = box.getBoundingClientRect().top;
      for (const el of box.children) {
        const r = el.getBoundingClientRect();
        if (r.height && r.bottom > top + 1) return { el, print: rowPrint(el), off: r.top - top, h: r.height };
      }
      return null;
    };
    /* the row at the top while you read, refreshed after each scroll at the current width (a scroll the resize itself causes
       arrives after the resize and must not replace the anchor taken before it) */
    box.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (box.clientWidth === width && Date.now() - (box._widthAt || 0) >= 400) reading = box.dataset.paused ? readAnchor() : null;
      });
    });
    new ResizeObserver(() => {
      const w = box.clientWidth;
      if (w === width || !w) return;
      const was = width;
      width = w;
      if (!was || box.offsetParent === null) return;
      box._widthAt = Date.now();
      if (!box.dataset.paused) {
        if (box.scrollHeight - box.scrollTop - box.clientHeight > 1) box.scrollTop = box.scrollHeight;
        return;
      }
      const a = reading || null;
      if (!a) return;
      let el = a.el && a.el.isConnected ? a.el : null;
      if (!el) for (const c of box.children) if (rowPrint(c) === a.print) el = c;
      if (!el) return;
      const top = box.getBoundingClientRect().top,
        r = el.getBoundingClientRect(),
        off = a.off < 0 && a.h > 0 ? (a.off * r.height) / a.h : a.off;
      box.scrollTop += r.top - top - off;
    }).observe(box);
  }
  /* Content that grows after a redraw (a "Show all" toggle added a moment later, a picture loading, a running step's output
     filling in) never scrolls either, so a list that follows was left a few rows short of its newest one. While a list follows,
     any growth keeps it at the bottom; growth right after your own click or key in it (opening a step) is left where it is. */
  for (const id of ['messages']) {
    const box = $(id);
    if (!box || typeof MutationObserver !== 'function') continue;
    let touchedAt = 0;
    const touched = () => (touchedAt = Date.now());
    box.addEventListener('pointerdown', touched, true);
    box.addEventListener('keydown', touched, true);
    const stick = () => {
      if (box.dataset.paused || Date.now() - touchedAt < 600) return;
      if (box.scrollHeight - box.scrollTop - box.clientHeight > 1) box.scrollTop = box.scrollHeight;
    };
    new MutationObserver(stick).observe(box, { childList: true, subtree: true, characterData: true });
    box.addEventListener('load', stick, true); // pictures: load does not bubble, so listen while it travels down
  }
  /* Reaching the latest message: the line stays a few seconds, dimmed, then goes. */
  function fadeNewLine(box) {
    const l = box.querySelector(':scope > .new-line');
    if (!l) return;
    UNREAD.lineUntil = Date.now() + 4000;
    l.classList.add('fading');
    setTimeout(() => {
      if (Date.now() >= UNREAD.lineUntil) {
        box.querySelector(':scope > .new-line.fading')?.remove();
        UNREAD.lineAt = null;
      }
    }, 4200);
  }
  /* Everything fits on screen, or the list is already at its end: nothing is waiting below, so follow is back on (a
     scroll event would say so, but none fires when the content does not scroll). */
  function resumeIfAtEnd(box) {
    /* After your own scroll up only the very bottom counts (a redraw that leaves you a few px short does not resume), and not
       in the first half second: a smooth scroll has not moved yet when the wheel event pauses, so the list still reads 0 px. */
    if (!box.dataset.paused || box.scrollHeight - box.scrollTop - box.clientHeight > (box._userUp ? 1 : 48)) return;
    if (box._userUp && Date.now() - (box._upAt || 0) < 500) return;
    if (box.id === 'messages') {
      if (Date.now() < UNREAD.holdUntil) return; // a view switch is still settling
      fadeNewLine(box);
      markSeen(UNREAD.chat, UNREAD.newest);
      UNREAD.mark = null;
      UNREAD.jumped = false;
    }
    box._userUp = false;
    delete box.dataset.paused;
    delete box.dataset.unseen;
  }
  /* You sent a message: show it and follow the reply. */
  function followSent() {
    if ($('messages').dataset.paused) jumpLatest();
  }
  function jumpLatest() {
    const box = $('messages');
    fadeNewLine(box);
    markSeen(UNREAD.chat, UNREAD.newest);
    delete box.dataset.paused;
    delete box.dataset.unseen;
    UNREAD.mark = null;
    UNREAD.jumped = false;
    box._userUp = false;
    box.scrollTop = box.scrollHeight;
    syncJump();
  }
  $('jumpNew').onclick = () => {
    const box = $('messages'),
      line = box.querySelector(':scope > .new-line');
    if (!UNREAD.jumped && line && unreadCount() > 0) {
      UNREAD.jumped = true;
      box.scrollTop += line.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
      syncJump();
      return;
    }
    jumpLatest();
  };
  /* End jumps to the latest message unless you're typing or working in a list. */
  document.addEventListener?.('keydown', (e) => {
    if (e.key !== 'End' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (
      t &&
      t.closest &&
      t.closest('input,textarea,select,[contenteditable="true"],#sidebar,[role="listbox"],[role="menu"],.image-viewer')
    )
      return;
    if ($('chat')?.hidden) return;
    e.preventDefault();
    jumpLatest();
  });
  // ---- Mark handled (the "your turn" mark itself is owned by the workspace code; this remembers it locally too, so the
  // header stops saying Your turn when no yourTurn flag is available)
  const handledAt = new Map();
  $('markHandled').onclick = () => {
    if (!selected) return;
    const last = [...events].reverse().find((e) => e.kind === 'turn_end');
    handledAt.set(aliasKey(selected), last && typeof last.time === 'number' ? last.time : Date.now() / 1000);
    try {
      window.AgentWorkspaceUI?.markHandled?.(selected);
    } catch (error) {
      fail(error);
    }
    renderHeader();
  };
  window.ChatViewsUI?.mount($('viewSwitch'), { get: viewOf, set: setView, visible: () => !!curKey() });
  window.ChatViewsUI?.mountFind($('promptFind'), {
    query: findQuery,
    set: setFindQuery,
    note: findNote,
    visible: () => !!curKey() && viewOf() === 'prompts',
  });
  setInterval(() => window.ChatViewsUI?.tickLive(), 1000); // the live line's clock: text only, never a repaint
  // ---- Show thinking is a right-click menu item (built elsewhere); this is its switch. Remembered in this browser.
  try {
    if (localStorage.getItem('studio-show-thinking') === '1') $('thinking').checked = true;
  } catch {}
  window.AgentChatView = Object.assign(window.AgentChatView || {}, {
    setThinking(on) {
      on = !!on;
      $('thinking').checked = on;
      try {
        localStorage.setItem('studio-show-thinking', on ? '1' : '0');
      } catch {}
      mainSignature = '';
      subSignature = '';
      refresh();
    },
    getThinking: () => !!$('thinking').checked,
    startHandoff,
    renameChat,
  });
  /* Test hook. The page itself never reads this. Tests load chat.js into a fake DOM and use these functions, and the accessors in
   `state` for the few variables they set up or check. Nothing else from this file is reachable from outside. */
  window.StudioChat = {
    DraftStore,
    paintActivityTabBadge,
    setActCounts: (c) => (actCounts = c),
    headerYourTurn,
    collectChildren,
    children,
    agentIsActive,
    agentStateLabel,
    attemptId,
    commandDuration,
    commandState,
    continueConversation,
    startNewChat,
    bubbleFull,
    discoverSessions,
    fetchEarlier,
    isRunningCommand,
    listConversations,
    liveRows,
    loadEarlier,
    normalized,
    openConversation,
    paintMirror,
    pollHistory,
    post,
    pseudoNote,
    refresh,
    refreshToken,
    renderSubagentControls,
    renderSubHead,
    chatModel,
    disarmStop,
    repaintMain,
    liveExtra,
    savedExtra,
    UNREAD,
    unreadCount,
    readIndex,
    promptsSeenUpTo,
    seenAtOf,
    mirrorWorking,
    mirrorState,
    openHit,
    setFindQuery,
    runFind,
    promptFind,
    setView,
    viewOf,
    viewStore,
    rowStatus,
    renderHeader,
    safeImageBlock,
    showRows,
    sortAgents,
    subagentTitle,
    state: {
      get mainSignature() {
        return mainSignature;
      },
      get subSignature() {
        return subSignature;
      },
      get newDraft() {
        return newDraft;
      },
      set newDraft(v) {
        newDraft = v;
      },
      get agents() {
        return agents;
      },
      set agents(v) {
        agents = v;
      },
      get connectionIssue() {
        return connectionIssue;
      },
      set connectionIssue(v) {
        connectionIssue = v;
      },
      get conversations() {
        return conversations;
      },
      set conversations(v) {
        conversations = v;
      },
      get continuingKey() {
        return continuingKey;
      },
      get current() {
        return current;
      },
      set current(v) {
        current = v;
      },
      get discoveryEnabled() {
        return discoveryEnabled;
      },
      set discoveryEnabled(v) {
        discoveryEnabled = v;
      },
      get drafts() {
        return drafts;
      },
      get events() {
        return events;
      },
      set events(v) {
        events = v;
      },
      get listedAt() {
        return listedAt;
      },
      set listedAt(v) {
        listedAt = v;
      },
      get historyWindows() {
        return historyWindows;
      },
      get instanceId() {
        return instanceId;
      },
      get provider() {
        return provider;
      },
      set provider(v) {
        provider = v;
      },
      get ownershipHints() {
        return ownershipHints;
      },
      set ownershipHints(v) {
        ownershipHints = v;
      },
      get selected() {
        return selected;
      },
      set selected(v) {
        selected = v;
      },
      get snapshot() {
        return snapshot;
      },
      set snapshot(v) {
        snapshot = v;
      },
      get subSelection() {
        return subSelection;
      },
      set subSelection(v) {
        subSelection = v;
      },
      get token() {
        return token;
      },
    },
  };
})();
