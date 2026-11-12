'use strict';
/* The phone page (phone.html), served only on the phone port (server/remote/server.ts) through Tailscale Serve.
   Screens: pairing, home (needs you first, the main chat with its helpers folded, other chats), one chat in a condensed read-only
   view, "can't reach the PC", and "this phone is no longer paired". The layout is chosen by the server (remote bootstrap says
   layout 'phone'), never by the window width. Read only in this version: answering, approving and sending stay on the PC.
   The device token lives in IndexedDB on this origin and goes in the X-AIB-Device header; images load by the HttpOnly cookie.
   Polls every 4 s (home) or 3 s (a chat) while the page is visible, and stops while it is hidden.
   Pure helpers (rowsFrom, stateWords, elapsed, checkWords' input) are exported for node tests. */
(function (root) {
  const HOME_MS = 4000;
  const CHAT_MS = 3000;
  const PAIR_POLL_MS = 2000;
  const TIMEOUT_MS = 10000;
  const TAIL = 300;
  const DB = 'aib-phone';

  // ---- pure helpers ---------------------------------------------------------------------------------------------------------
  const str = (v) => (typeof v === 'string' ? v : '');
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  /* "4 min", "2 h", "3 d" since an ISO time (or ''), for the status words. */
  function elapsed(iso, now) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const s = Math.max(0, Math.floor(((now || Date.now()) - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' d';
  }

  /* The status words for a chat card: {text, tone} (tone: need | work | turn | idle). Same words as the PC: Needs you, Working,
     Your turn, Idle. */
  function stateWords(c, now) {
    if (c.needs > 0 || c.state === 'needs_you') return { text: 'Needs you', tone: 'need' };
    if (c.state === 'working') {
      const e = elapsed(c.busySince, now);
      return { text: 'Working' + (e && e !== 'just now' ? ' · ' + e : ''), tone: 'work' };
    }
    if (c.state === 'opening') return { text: 'Starting…', tone: 'idle' };
    if (c.yourTurn) {
      const e = elapsed(c.turnEndedAt, now);
      return { text: 'Your turn' + (e ? ' · finished ' + (e === 'just now' ? e : e + ' ago') : ''), tone: 'turn' };
    }
    const e = elapsed(c.turnEndedAt, now);
    return { text: e ? 'Idle · finished ' + (e === 'just now' ? e : e + ' ago') : 'Idle', tone: 'idle' };
  }

  const HELPER_WORDS = {
    running: 'working',
    in_progress: 'working',
    working: 'working',
    pending: 'waiting',
    completed: 'done',
    done: 'done',
    finished: 'done',
    failed: 'failed',
    error: 'failed',
    cancelled: 'stopped',
    canceled: 'stopped',
    stopped: 'stopped',
  };
  const helperWord = (state) => HELPER_WORDS[str(state).toLowerCase()] || str(state) || 'unknown';

  /* Events (the phone payload) -> condensed rows, the "Chat" view: your prompts, the agent's messages, a fold for each run of
     steps between them, notices. {kind:'you'|'agent'|'steps'|'notice', key, text?, images?, steps?} */
  function rowsFrom(events) {
    const rows = [];
    const steps = new Map(); // toolCallId -> step
    const imagesOf = (list) => (Array.isArray(list) ? list : []).filter((a) => a && a.url).map((a) => a.url);
    for (const e of Array.isArray(events) ? events : []) {
      const data = obj(e.data);
      const key = 'e' + (e.seq || rows.length);
      const last = rows[rows.length - 1];
      if (e.kind === 'user') {
        rows.push({ kind: 'you', key, text: str(data.text), images: imagesOf(data.attachments) });
      } else if (e.kind === 'update') {
        const u = obj(data.update);
        const kind = u.sessionUpdate;
        if (kind === 'agent_message_chunk') {
          const c = obj(u.content);
          const image = c.url ? [c.url] : [];
          if (last && last.kind === 'agent' && !image.length && !last.images.length) last.text += str(c.text);
          else rows.push({ kind: 'agent', key, text: str(c.text), images: image });
        } else if (kind === 'user_message_chunk') {
          const c = obj(u.content);
          if (last && last.kind === 'you') last.text += str(c.text);
          else rows.push({ kind: 'you', key, text: str(c.text), images: c.url ? [c.url] : [] });
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          const id = str(u.toolCallId) || key;
          let step = steps.get(id);
          if (!step || (kind === 'tool_call' && step.done)) {
            step = { id, title: str(u.title) || 'Step', status: str(u.status) || 'pending', done: false };
            steps.set(id, step);
            if (last && last.kind === 'steps') last.steps.push(step);
            else rows.push({ kind: 'steps', key, steps: [step] });
          } else {
            if (u.title) step.title = str(u.title);
            if (u.status) step.status = str(u.status);
          }
          step.done = step.status === 'completed' || step.status === 'failed';
        }
      } else if (e.kind === 'permission' || e.kind === 'elicitation') {
        const params = obj(data.params);
        const title = str(obj(params.toolCall).title) || str(params.message);
        if (title) rows.push({ kind: 'notice', key, text: (e.kind === 'permission' ? 'Asked to: ' : 'Asked: ') + title });
      } else if (e.kind === 'error' || e.kind === 'disconnected' || e.kind === 'studio_note') {
        const text = str(data.message);
        if (text) rows.push({ kind: 'notice', key, text });
      }
    }
    return rows.filter((r) => r.kind !== 'agent' || r.text.trim() || r.images.length);
  }

  /* The live line of a working chat: the step running now, or "Working". */
  function liveLine(chat, rows, now) {
    if (!chat || !chat.busy) return '';
    let n = 0;
    let running = null;
    for (const r of rows) {
      if (r.kind !== 'steps') continue;
      for (const s of r.steps) {
        n++;
        if (!s.done) running = { n, title: s.title };
      }
    }
    const e = elapsed(chat.busySince, now);
    const time = e && e !== 'just now' ? ' · ' + e : '';
    return running ? 'Step ' + running.n + ' · ' + running.title + time : 'Working' + time;
  }

  /* The text both sides hash for the two check words (server/remote/words.ts checkWords). */
  const checkInput = (secretHex, phoneNonce, pcNonce) => 'aib-pair-check|' + secretHex + '|' + phoneNonce + '|' + pcNonce;

  const api = { rowsFrom, stateWords, elapsed, liveLine, helperWord, checkInput };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.AIBPhone = api;

  // ---- the page -------------------------------------------------------------------------------------------------------------
  const doc = root.document;
  const app = doc.getElementById('app');
  const S = {
    token: '',
    pcName: 'your PC',
    device: null,
    screen: 'loading',
    home: null,
    homeRev: '',
    chatId: '',
    chatTitle: '',
    chat: null,
    chatEvents: [],
    open: new Set(), // folds the reader opened
    lastOk: 0,
    offline: false,
    timer: 0,
    pairSecret: '', // hex, from the QR's '#p='
    pairing: null,
  };

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== '') n.textContent = String(text);
    return n;
  }
  function button(cls, text, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- storage (IndexedDB; only the device token) ----
  function db() {
    return new Promise((resolve, reject) => {
      const req = root.indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function stored(key, value) {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const tx = d.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
        const store = tx.objectStore('kv');
        const req = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
        req.onsuccess = () => resolve(value === undefined ? req.result : true);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return undefined;
    }
  }

  // ---- network ----
  class Offline extends Error {}
  async function call(method, path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const headers = {};
    if (S.token) headers['X-AIB-Device'] = S.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch {
      throw new Offline('unreachable');
    } finally {
      clearTimeout(timer);
    }
    // Tailscale Serve answers 502 when nothing listens behind it (AIB closed, the PC asleep, phone access off).
    if (response.status === 502 || response.status === 503 || response.status === 504) throw new Offline('down');
    let data = {};
    if (response.status !== 304) {
      try {
        data = await response.json();
      } catch {
        data = {};
      }
    }
    return { status: response.status, data };
  }

  function schedule(ms) {
    clearTimeout(S.timer);
    if (doc.visibilityState === 'hidden') return;
    S.timer = setTimeout(tick, ms);
  }

  async function tick() {
    if (doc.visibilityState === 'hidden') return;
    try {
      if (S.screen === 'chat') await loadChat(false);
      else if (S.screen === 'home' || (S.offline && S.device)) await loadHome();
      else return;
      if (S.offline) {
        S.offline = false;
        draw();
      }
      S.lastOk = Date.now();
    } catch (error) {
      if (!(error instanceof Offline)) throw error;
      if (!S.offline) {
        S.offline = true;
        draw();
      }
    }
    schedule(S.screen === 'chat' ? CHAT_MS : HOME_MS);
  }

  async function loadHome() {
    const r = await call('GET', '/api/remote/home' + (S.homeRev ? '?rev=' + encodeURIComponent(S.homeRev) : ''));
    if (r.status === 401) return removed();
    if (r.status === 304) return;
    if (r.status !== 200) throw new Offline('refused');
    S.home = r.data;
    S.homeRev = r.data.revision || '';
    if (r.data.pcName) S.pcName = r.data.pcName;
    if (S.screen === 'home') draw();
  }

  async function loadChat(fresh) {
    const after = !fresh && S.chat ? S.chat.cursor : 0;
    const r = await call('GET', '/api/remote/chat?id=' + encodeURIComponent(S.chatId) + '&tail=' + TAIL + (after ? '&after=' + after : ''));
    if (r.status === 401) return removed();
    if (r.status === 404) {
      S.chat = { gone: true, title: S.chat ? S.chat.title : '' };
      S.chatEvents = [];
      draw();
      return;
    }
    if (r.status !== 200) throw new Offline('refused');
    const c = r.data;
    if (!after || c.reset) S.chatEvents = c.events;
    else if (c.events.length) S.chatEvents = S.chatEvents.concat(c.events).slice(-TAIL * 2);
    const changed = !S.chat || !after || c.events.length || c.state !== S.chat.state || c.needs !== S.chat.needs || c.busy !== S.chat.busy;
    S.chat = { ...c, truncated: after ? S.chat.truncated : c.truncated };
    if (S.screen === 'chat' && changed) draw();
  }

  async function removed() {
    S.token = '';
    S.device = null;
    await stored('device', null);
    S.screen = 'removed';
    draw();
  }

  // ---- screens ----
  function header(title, opts) {
    const h = el('header', 'ph-head');
    if (opts && opts.back) {
      const b = button('ph-back', '‹', opts.back);
      b.setAttribute('aria-label', 'Back to all chats');
      h.append(b);
    }
    const h1 = el('h1');
    h1.append(doc.createTextNode(title));
    if (opts && opts.sub) h1.append(el('span', 'ph-sub', ' · ' + opts.sub));
    h.append(h1);
    if (opts && opts.chip) h.append(el('span', 'ph-chip ' + opts.chip[1], opts.chip[0]));
    return h;
  }

  function offlineBox() {
    const box = el('section', 'ph-offline');
    box.setAttribute('role', 'alert');
    box.append(el('h2', '', "Can't reach " + S.pcName));
    if (S.lastOk) {
      const t = new Date(S.lastOk);
      const hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      box.append(el('p', 'ph-note', 'Last update ' + hhmm + '. Showing what you saw then.'));
    }
    box.append(el('p', '', 'Check that:'));
    const ul = el('ul', 'ph-steps');
    ul.append(el('li', '', 'Tailscale is on, on this phone.'), el('li', '', 'The PC is awake and AIB is running.'));
    box.append(ul);
    box.append(
      button('ph-btn', 'Try again', () => {
        clearTimeout(S.timer);
        tick();
      }),
    );
    return box;
  }

  function chatCard(c, opts) {
    const w = stateWords(c);
    const card = button('ph-card' + (w.tone === 'need' ? ' need' : '') + (opts && opts.main ? ' main' : ''), '', () => openChat(c.id, c.title));
    card.dataset.chat = c.id;
    if (c.needs > 0) card.append(el('span', 'ph-badge', String(c.needs)));
    card.append(el('span', 'ph-title', c.title));
    const meta = el('span', 'ph-meta');
    const state = el('span', 'ph-state ' + w.tone, w.text);
    meta.append(state);
    const extra = [c.agent, c.helpers.length ? c.helpers.length + (c.helpers.length === 1 ? ' helper' : ' helpers') : ''].filter(Boolean);
    if (extra.length) meta.append(doc.createTextNode(' · ' + extra.join(' · ')));
    card.append(meta);
    if (opts && opts.main && c.helpers.length) {
      const ul = el('ul', 'ph-helpers');
      ul.setAttribute('aria-label', 'Helpers');
      for (const h of c.helpers) {
        const li = el('li');
        li.append(el('span', '', h.title), el('span', 'ph-state ' + (helperWord(h.state) === 'working' ? 'work' : ''), helperWord(h.state)));
        ul.append(li);
      }
      card.append(ul);
    }
    return card;
  }

  function drawHome() {
    const frag = doc.createDocumentFragment();
    frag.append(header('AIB', { sub: S.pcName, chip: S.offline ? ['Offline', 'off'] : ['Live', 'live'] }));
    if (S.offline) frag.append(offlineBox());
    const body = el('main', S.offline ? 'ph-stale' : '');
    const home = S.home;
    if (!home) {
      body.append(el('p', 'ph-empty', 'Loading your chats…'));
    } else if (!home.chats.length) {
      body.append(el('p', 'ph-empty', 'No chats are running on ' + S.pcName + '. Start one in AIB on the PC.'));
    } else {
      const need = home.chats.filter((c) => c.needs > 0);
      const main = home.chats.find((c) => c.id === home.main && c.needs === 0);
      const rest = home.chats.filter((c) => c.needs === 0 && c !== main);
      if (need.length) {
        body.append(el('h2', 'ph-section', 'Needs you · ' + need.length));
        for (const c of need) body.append(chatCard(c, { main: c.id === home.main }));
      }
      if (main) {
        body.append(el('h2', 'ph-section', 'Main chat'));
        body.append(chatCard(main, { main: true }));
      }
      if (rest.length) {
        body.append(el('h2', 'ph-section', main || need.length ? 'Other chats' : 'Chats'));
        for (const c of rest) body.append(chatCard(c));
      }
    }
    frag.append(body);
    return frag;
  }

  function drawRows(box, rows) {
    for (const r of rows) {
      if (r.kind === 'steps') {
        const open = S.open.has(r.key);
        const n = r.steps.length;
        const fold = button('ph-fold', (open ? 'Hide steps (' : 'Show steps (') + n + ')', () => {
          if (S.open.has(r.key)) S.open.delete(r.key);
          else S.open.add(r.key);
          draw();
        });
        fold.setAttribute('aria-expanded', open ? 'true' : 'false');
        box.append(fold);
        if (open) {
          const ul = el('ul', 'ph-fold-list');
          for (const s of r.steps) ul.append(el('li', '', s.title + (s.done ? '' : ' · ' + (s.status === 'pending' ? 'waiting' : 'running'))));
          box.append(ul);
        }
        continue;
      }
      const m = el('div', 'ph-msg ' + r.kind);
      if (r.kind === 'agent' && root.AgentMarkdown) root.AgentMarkdown.render(m, r.text);
      else if (r.text) m.textContent = r.text;
      for (const url of r.images || []) {
        const img = el('img', 'ph-img');
        img.loading = 'lazy';
        img.alt = 'Picture';
        img.src = url;
        m.append(img);
      }
      box.append(m);
    }
  }

  function drawChat() {
    const frag = doc.createDocumentFragment();
    const c = S.chat;
    const title = (c && c.title) || S.chatTitle || 'Chat';
    const w = c && !c.gone ? stateWords(c) : null;
    frag.append(header(title, { back: goHome, chip: S.offline ? ['Offline', 'off'] : w ? [w.text.split(' · ')[0], w.tone === 'work' ? 'live' : ''] : null }));
    if (S.offline) frag.append(offlineBox());
    const body = el('main', S.offline ? 'ph-stale' : '');
    if (!c) body.append(el('p', 'ph-empty', 'Loading…'));
    else if (c.gone) body.append(el('p', 'ph-empty', 'This chat is not running on ' + S.pcName + ' any more. Open it in AIB on the PC.'));
    else {
      for (const wait of c.waiting || []) {
        const box = el('div', 'ph-wait');
        box.append(el('b', '', wait.kind === 'permission' ? 'Waiting for your approval' : wait.kind === 'question' ? 'Waiting for your answer' : 'Waiting for you to sign in'));
        box.append(el('span', '', wait.title));
        box.append(el('p', 'ph-note', 'Answer it in AIB on ' + S.pcName + '.'));
        body.append(box);
      }
      const helpers = c.helpers || [];
      if (helpers.length) {
        const ul = el('ul', 'ph-helpers ph-card');
        ul.setAttribute('aria-label', 'Helpers');
        for (const h of helpers) {
          const li = el('li');
          li.append(el('span', '', h.title), el('span', '', helperWord(h.state)));
          ul.append(li);
        }
        body.append(ul);
      }
      if (c.truncated) body.append(el('p', 'ph-earlier', 'Earlier messages are on your PC.'));
      const rows = rowsFrom(S.chatEvents);
      const list = el('div', 'ph-list');
      drawRows(list, rows);
      if (!rows.length) list.append(el('p', 'ph-empty', 'No messages yet.'));
      body.append(list);
      const live = liveLine(c, rows);
      if (live) body.append(el('p', 'ph-live', live));
      body.append(el('p', 'ph-pconly', 'Reading only. Reply in AIB on ' + S.pcName + '.'));
    }
    frag.append(body);
    return frag;
  }

  function guessName() {
    const ua = String(root.navigator.userAgent || '');
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    if (m && m[1] && !/^K$/.test(m[1])) return m[1].trim().slice(0, 40);
    return /Android/.test(ua) ? 'Android phone' : 'Phone';
  }

  function drawPair() {
    const frag = doc.createDocumentFragment();
    frag.append(header('Pair with AIB'));
    const body = el('main');
    const p = S.pairing || {};
    if (p.waiting) {
      body.append(el('h2', 'ph-section', 'Check these match your PC'));
      const words = el('p', 'ph-words', p.checkWords.join(' '));
      words.id = 'checkWords';
      body.append(words);
      body.append(el('p', '', 'Your PC now shows the same two words. Click Approve there.'));
      body.append(el('p', 'ph-note', 'Waiting for you to approve on the PC…'));
      frag.append(body);
      return frag;
    }
    if (p.rejected) {
      body.append(el('p', 'ph-error', 'Pairing was rejected on the PC.'));
      body.append(
        button('ph-btn', 'Start again', () => {
          S.pairing = null;
          S.pairSecret = '';
          draw();
        }),
      );
      frag.append(body);
      return frag;
    }
    body.append(el('p', '', 'Connect this phone to ' + S.pcName + '.'));
    const form = el('form', 'ph-form');
    form.noValidate = true;
    if (!S.pairSecret) {
      const l = el('label', '', 'Pairing code');
      l.htmlFor = 'pairCode';
      const code = el('input');
      code.id = 'pairCode';
      code.autocomplete = 'off';
      code.autocapitalize = 'none';
      code.spellcheck = false;
      code.placeholder = 'six words';
      code.value = p.code || '';
      form.append(l, code, el('p', 'ph-note', 'On your PC: Settings → Devices → Add a phone shows the six words.'));
    }
    const nl = el('label', '', 'Name this phone');
    nl.htmlFor = 'pairName';
    const name = el('input');
    name.id = 'pairName';
    name.maxLength = 40;
    name.autocomplete = 'off';
    name.value = p.name || guessName();
    form.append(nl, name);
    if (p.error) {
      const e = el('p', 'ph-error', p.error);
      e.setAttribute('role', 'alert');
      form.append(e);
    }
    const go = el('button', 'ph-btn', p.busy ? 'Pairing…' : 'Pair this phone');
    go.type = 'submit';
    go.id = 'pairGo';
    go.disabled = !!p.busy;
    form.append(go);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const codeInput = doc.getElementById('pairCode');
      claim(codeInput ? codeInput.value : '', name.value);
    });
    body.append(form);
    frag.append(body);
    return frag;
  }

  function drawRemoved() {
    const frag = doc.createDocumentFragment();
    frag.append(header('AIB', { sub: S.pcName }));
    const body = el('main');
    body.append(el('p', 'ph-error', 'This phone is no longer paired with ' + S.pcName + '.'));
    body.append(el('p', '', 'To use it again, open Settings → Devices in AIB on the PC and click Add a phone.'));
    body.append(
      button('ph-btn', 'Pair again', () => {
        S.screen = 'pair';
        S.pairing = null;
        draw();
      }),
    );
    frag.append(body);
    return frag;
  }

  function draw() {
    const y = root.scrollY;
    const focusId = doc.activeElement && doc.activeElement.id;
    const parts =
      S.screen === 'home'
        ? drawHome()
        : S.screen === 'chat'
          ? drawChat()
          : S.screen === 'pair'
            ? drawPair()
            : S.screen === 'removed'
              ? drawRemoved()
              : el('p', 'ph-loading', 'Connecting…');
    app.replaceChildren(parts);
    app.dataset.screen = S.screen;
    if (focusId) {
      const f = doc.getElementById(focusId);
      if (f && f.focus) f.focus({ preventScroll: true });
    }
    root.scrollTo(0, y);
  }

  function goHome() {
    S.screen = 'home';
    S.chat = null;
    S.chatId = '';
    S.chatEvents = [];
    S.open.clear();
    draw();
    root.scrollTo(0, 0);
    clearTimeout(S.timer);
    tick();
  }

  function openChat(id, title) {
    S.screen = 'chat';
    S.chatId = id;
    S.chatTitle = title || '';
    S.chat = null;
    S.chatEvents = [];
    S.open.clear();
    draw();
    root.scrollTo(0, 0);
    clearTimeout(S.timer);
    loadChat(true)
      .then(() => schedule(CHAT_MS))
      .catch((error) => {
        if (!(error instanceof Offline)) throw error;
        S.offline = true;
        draw();
        schedule(CHAT_MS);
      });
  }

  // ---- pairing ----
  function secretHexFromWords(text) {
    const words = root.AIBPhoneWords || [];
    const list = String(text || '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean);
    if (list.length !== 6) return '';
    const bytes = list.map((w) => words.indexOf(w));
    return bytes.every((b) => b >= 0) ? bytes.map((b) => b.toString(16).padStart(2, '0')).join('') : '';
  }
  function randomHex(n) {
    return [...root.crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function computeCheckWords(secretHex, phoneNonce, pcNonce) {
    if (!root.crypto || !root.crypto.subtle) return null;
    const digest = new Uint8Array(
      await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(checkInput(secretHex, phoneNonce, pcNonce))),
    );
    const words = root.AIBPhoneWords || [];
    return [words[digest[0]], words[digest[1]]];
  }

  async function claim(codeText, name) {
    const secretHex = S.pairSecret || secretHexFromWords(codeText);
    S.pairing = { code: codeText, name, busy: true };
    if (!secretHex) {
      S.pairing = { code: codeText, name, error: 'Type the six words your PC shows, with spaces between them.' };
      return draw();
    }
    draw();
    const nonce = randomHex(16);
    let r;
    try {
      r = await call('POST', '/api/remote/pair/claim', { code: secretHex, name, nonce });
    } catch {
      S.pairing = { code: codeText, name, error: "Can't reach " + S.pcName + '. Check that Tailscale is on, on this phone.' };
      return draw();
    }
    if (r.status !== 200) {
      S.pairing = { code: codeText, name, error: r.data.error || 'Pairing did not work. Try again.' };
      if (r.data.code === 'expired' || r.data.code === 'already_used') S.pairSecret = '';
      return draw();
    }
    const mine = await computeCheckWords(secretHex, nonce, r.data.pcNonce);
    if (mine && mine.join(' ') !== (r.data.checkWords || []).join(' ')) {
      S.pairing = { error: 'The check words do not match what the PC sent. Do not approve this phone on the PC; start again there.' };
      S.pairSecret = '';
      return draw();
    }
    S.pairing = { waiting: true, checkWords: mine || r.data.checkWords, claim: r.data.claim, claimSecret: r.data.claimSecret, started: Date.now() };
    draw();
    pollClaim();
  }

  async function pollClaim() {
    const p = S.pairing;
    if (!p || !p.waiting) return;
    if (Date.now() - p.started > 10 * 60 * 1000) {
      S.pairing = { error: 'Nobody approved this phone on the PC in 10 minutes. Start again on the PC.' };
      S.pairSecret = '';
      return draw();
    }
    let r = null;
    try {
      r = await call('POST', '/api/remote/pair/status', { claim: p.claim, claimSecret: p.claimSecret });
    } catch {
      r = null; // keep waiting through a short drop
    }
    if (r && r.status === 200 && r.data.state === 'approved' && r.data.token) {
      S.token = r.data.token;
      S.device = r.data.device;
      await stored('device', { token: r.data.token, device: r.data.device });
      S.pairing = null;
      S.pairSecret = '';
      S.screen = 'home';
      draw();
      tick();
      return;
    }
    if (r && r.status === 200 && r.data.state === 'rejected') {
      S.pairing = { rejected: true };
      S.pairSecret = '';
      return draw();
    }
    if (r && r.status !== 200) {
      S.pairing = { error: r.data.error || 'This pairing is no longer open. Start again on the PC.' };
      S.pairSecret = '';
      return draw();
    }
    setTimeout(pollClaim, PAIR_POLL_MS);
  }

  // ---- start ----
  async function start() {
    const m = /^#p=([0-9a-f]{12})$/i.exec(root.location.hash || '');
    if (m) S.pairSecret = m[1].toLowerCase();
    if (root.location.hash) root.history.replaceState(null, '', root.location.pathname); // the secret leaves the address bar
    const saved = await stored('device');
    if (saved && saved.token) {
      S.token = saved.token;
      S.device = saved.device || null;
    }
    let boot;
    try {
      boot = await call('GET', '/api/remote/bootstrap');
    } catch {
      S.offline = true;
      S.screen = S.token ? 'home' : 'pair';
      draw();
      schedule(HOME_MS);
      return;
    }
    if (boot.data.pcName) S.pcName = boot.data.pcName;
    if (boot.status === 401) return removed();
    if (boot.status !== 200) {
      S.screen = 'pair';
      S.pairing = { error: boot.data.error || 'This page only works through Tailscale on your phone.' };
      return draw();
    }
    if (boot.data.layout !== 'phone') return;
    if (boot.data.paired) {
      S.device = boot.data.device;
      S.screen = 'home';
      draw();
      tick();
      return;
    }
    S.screen = 'pair';
    draw();
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') clearTimeout(S.timer);
    else if (S.screen === 'home' || S.screen === 'chat') {
      clearTimeout(S.timer);
      tick();
    }
  });
  root.__aibPhone = S; // tests read the page's state
  start();
})(typeof window !== 'undefined' ? window : globalThis);
