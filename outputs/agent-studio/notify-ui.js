(function (root) {
  'use strict';
  // Tells you when a chat needs you ("Needs you": a question, approval or sign-in) or has handed the turn back ("To review").
  // The workspace code (workspace-ui.js) feeds it the same normalized chats the inbox and tabs use, after every list refresh, so
  // the words and the rules (hidden projects, worktree and scratch folders) match the list. Everything here is decided from
  // TRANSITIONS: a chat newly entering needs-you or your-turn is announced once, never again for the same transition.
  //   * Studio in front (visible and focused): no desktop notification and no sound; the badge and the sidebar show it.
  //     Chats other than the one you are looking at get a small in-page toast (it saves a trip to the inbox).
  //   * Studio away (hidden or not focused): a desktop notification (if turned on) and a sound (per setting).
  //   * Transitions within about a minute merge into ONE notification ("3 agents are waiting for you") that replaces the older.
  //   * Muted projects (server-side project prefs) never notify or sound; the inbox still lists them.
  // In the AIB desktop app the SERVER shows desktop notifications (server/attention/watcher.ts, through server/desktop/notify.ts):
  // it watches every chat itself, so they also come with the window closed, and this page never asks for one (no double
  // notification); only the Settings test goes through desktop-bridge.js. The choices are AIB's own (saved in the data folder:
  // view-prefs.js syncs APP_PREF_KEY, the server reads them) and start on, for Needs you only. The page still shows its in-page
  // toasts and plays the sounds. In a browser the web Notification API and its permission, as before.
  const PREF_KEY = 'studio-notifications',
    APP_PREF_KEY = 'studio-notifications-app';
  // The rules shared with the server (notify-rules.js): grouping, the notification text, the desktop app's choices.
  const R =
    root.AgentNotifyRules || (typeof module === 'object' && typeof require === 'function' ? require('./notify-rules.js') : null);
  const GROUP_MS = R.GROUP_MS;

  // ---- pure logic ---------------------------------------------------------------------------------------------
  // entries: [{key, title, state, phase, since, needs, yourTurn, yourTurnAt, eligible, muted, selected}]; prev: the last result's
  // `next`, or null. phase is the inbox's (inbox-rules.js): a failed turn and a question in the reply are "needs" news like a
  // request; a finished turn is news only once the chat is really done (not while its helpers, a background shell or their
  // follow-up still run: the phase says working until then). The first observation only sets the baseline.
  // Returns {next, events:[{key, kind: "needs"|"turn", needs?}]}.
  function detect(prev, entries) {
    const next = { conns: {} },
      events = [];
    for (const e of entries || []) {
      if (!e || typeof e.key !== 'string') continue;
      const phase =
        typeof e.phase === 'string' && e.phase
          ? e.phase
          : e.state === 'needs_you'
            ? 'needs_you'
            : e.yourTurn
              ? 'your_turn'
              : 'idle';
      const was = prev ? prev.conns[e.key] : null;
      const needs = phase === 'needs_you' ? Math.max(1, Number(e.needs) || 1) : 0;
      const asked = phase === 'failed' || phase === 'asks' ? phase + ':' + (Number(e.since) || 1) : '';
      // the last finished turn seen as finished: kept while the chat works again, so its end is news once
      const turnAt = phase === 'your_turn' ? Number(e.yourTurnAt) || 1 : was ? was.turnAt : 0;
      next.conns[e.key] = { needs, asked, turnAt };
      if (!prev || !e.eligible || e.muted || e.state === 'closed') continue; // state still tracked: un-hiding or unmuting later does not replay old news
      if (needs > (was ? was.needs : 0)) events.push({ key: e.key, kind: 'needs', needs });
      else if (asked && was && asked !== was.asked) events.push({ key: e.key, kind: 'needs', needs: 1 });
      else if (phase === 'your_turn' && was && turnAt !== was.turnAt) events.push({ key: e.key, kind: 'turn' });
    }
    return { next, events };
  }

  // Which sound a kind gets under a setting: "needs" (Needs you only), "both", "off". Returns "needs", "turn" or null.
  function soundFor(kind, pref) {
    if (pref === 'off') return null;
    if (kind === 'needs') return 'needs';
    return pref === 'both' ? 'turn' : null;
  }

  // What to do about one event. o: {kind, away, selected (open in the window), eligible, muted, notifyFor, soundPref, desktopReady}
  function decide(o) {
    const none = { toast: false, desktop: false, sound: null };
    if (!o.eligible || o.muted) return none;
    if (o.kind === 'turn' && o.notifyFor === 'needs') return none;
    // The chat open in the window (even while it has no focus) is in front of you already (inbox-rules.js isOpen).
    if (o.selected) return none;
    if (!o.away) return { toast: true, desktop: false, sound: null }; // in front: never a desktop notification or a sound
    return { toast: false, desktop: !!o.desktopReady, sound: soundFor(o.kind, o.soundPref) };
  }

  const addToGroup = R.addToGroup;
  const describe = R.describe;
  const cleanPrefs = R.cleanPrefs;

  // ---- runtime ------------------------------------------------------------------------------------------------
  const S = {
    host: null,
    prev: null,
    prefs: cleanPrefs(),
    toasts: new Map(),
    group: null,
    shown: null,
    audio: null,
    current: [],
    pop: null,
    stack: null,
    more: null, // the "+N more in the inbox" line under the toasts
    seq: 0,
    blocked: false,
    testNote: null, // the desktop app's answer to the last test: {text, warn}
    chimes: 0, // how many chimes this window played (tests: only the sound owner chimes)
  };
  // Several AIB windows (window-context.js, multi-window D1/D2): only the sound owner chimes (and, in a browser, shows the desktop
  // notification); chats open in ANY window stay out of this window's toasts. Without window-context.js or a fresh presence
  // answer this window acts as the only one (today's behaviour).
  const Win = () => root.AibWindow || null;
  const soundMine = () => {
    const W = Win();
    return !W || W.soundMine();
  };

  function loadPrefs() {
    const app = native();
    try {
      S.prefs = cleanPrefs(JSON.parse(root.localStorage.getItem(app ? APP_PREF_KEY : PREF_KEY) || '{}'), app);
    } catch {
      S.prefs = cleanPrefs(null, app);
    }
  }
  function savePrefs() {
    try {
      root.localStorage.setItem(native() ? APP_PREF_KEY : PREF_KEY, JSON.stringify(S.prefs));
    } catch {
      /* storage unavailable */
    }
  }

  const doc = () => root.document;
  // In the AIB desktop app the app shows notifications itself (no permission to ask for); in a browser the web Notification API
  // does, as before.
  function native() {
    return !!(root.AibDesktop && root.AibDesktop.available());
  }
  const supported = () => native() || typeof root.Notification === 'function';
  const permission = () => (native() ? 'granted' : supported() ? root.Notification.permission : 'unsupported');
  const desktopReady = () => S.prefs.desktop && permission() === 'granted';
  // Studio is "in front" only when the page is visible AND has focus; otherwise you are away.
  const away = () => {
    const d = doc();
    return (
      !d || d.hidden === true || d.visibilityState === 'hidden' || (typeof d.hasFocus === 'function' && !d.hasFocus())
    );
  };

  // Two short WebAudio chimes (no files): a rising two-note one for Needs you, a single soft low one for Your turn.
  function tone(ctx, freq, start, len, peak) {
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + len + 0.05);
  }
  function chime(kind) {
    try {
      const Ctx = root.AudioContext || root.webkitAudioContext;
      if (!Ctx) return;
      S.chimes++;
      S.audio = S.audio || new Ctx();
      if (S.audio.state === 'suspended' && S.audio.resume) S.audio.resume();
      const t = S.audio.currentTime;
      if (kind === 'needs') {
        tone(S.audio, 880, t, 0.22, 0.16);
        tone(S.audio, 1318.5, t + 0.16, 0.34, 0.16);
      } else tone(S.audio, 587.3, t, 0.3, 0.05);
    } catch {
      /* sound is optional */
    }
  }

  function openTarget(target) {
    try {
      root.focus();
    } catch {
      /* ignore */
    }
    if (!S.host) return;
    if (target && target.type === 'chat' && S.host.openChat) S.host.openChat(target.key);
    else if (S.host.openInbox) S.host.openInbox(target && typeof target.key === 'string' ? target.key : undefined);
  }

  // The desktop app: its notification was clicked and the window is in front again (server/desktop/window.ts
  // openFromNotification). K6: 'mine' once this window opened it, 'no' when the chat is not this window's (another window owns
  // its project or shows it popped out: the app tries the next window), false while the page still loads (the app tries again).
  // A {type: 'inbox', key} target opens the inbox on that chat's request, highlighted: the chat on screen does not change.
  function openFromDesktop(target) {
    if (!S.host) return false;
    if (target && target.type === 'chat' && typeof S.host.mayOpen === 'function' && !S.host.mayOpen(target.key)) return 'no';
    // a routed project or doc (K3 route): this window opens it, or says it is not its own (a pop-out, another window's project)
    if (target && target.type === 'project')
      return typeof S.host.openProject === 'function' && S.host.openProject(String(target.key || '')) ? 'mine' : 'no';
    if (target && target.type === 'doc')
      return typeof S.host.openDoc === 'function' && S.host.openDoc(String(target.project || ''), String(target.name || ''))
        ? 'mine'
        : 'no';
    if (target && (target.type === 'chat' || target.type === 'inbox')) openTarget(target);
    return 'mine';
  }

  function closeShown() {
    if (S.shown) {
      try {
        S.shown.close();
      } catch {
        /* ignore */
      }
      S.shown = null;
    }
  }
  // One notification with a stable tag: a newer (grouped) one replaces the older.
  function showDesktop(group) {
    const d = describe(group);
    if (native()) {
      root.AibDesktop.notify(d.title, d.body, d.target).catch(() => {
        /* the server could not be reached: nothing to fall back to that would work here */
      });
      return;
    }
    try {
      const n = new root.Notification(d.title, { body: d.body, tag: d.tag, silent: true });
      n.onclick = () => {
        try {
          n.close();
        } catch {
          /* ignore */
        }
        if (S.shown === n) S.shown = null;
        openTarget(d.target);
      };
      S.shown = n;
    } catch {
      /* some contexts refuse to construct notifications */
    }
  }

  // ---- in-page toasts (Studio in front, a chat other than the one you are looking at) ----
  // The toast is where you answer (inbox prototype v3): the same card as the inbox. Line 1 is the thing itself (the command,
  // file, question or error), line 2 "chat · project" and the wait; ONE row of actions: the agent's own once-options (Allow /
  // Deny), the choices, Reply with the box in place, Retry. Risky commands (push, force push, delete) show Review first, then
  // the full command and Allow / Deny: never one tap, never "Always allow". The chat on screen never changes.
  //   * A needs-you toast steps back into the inbox after NEEDS_MS unless the pointer or focus is in it (or a reply / a review
  //     is open); × also sends it there. To review (the agent finished its turn) is quiet: no buttons, gone after TURN_MS.
  //   * At most MAX_TOASTS at once, the oldest wait first; the rest say "+N more in the inbox".
  //   * Answering anywhere (here, the inbox, the chat, the phone) clears it: the next list refresh drops it (reconcile).
  // host.toastCard(key) gives the card ({reason, line1, title, project, since, buttons, reply, retry, loading, openOnly, more,
  // full}); host.toastAnswer / toastReply / toastRetry send, the same way the inbox's own row does.
  const NEEDS_MS = 15000,
    TURN_MS = 6000,
    MAX_TOASTS = 2;
  const BLOCKED_PHASES = ['needs_you', 'failed', 'asks'];
  const isBlocked = (e) =>
    BLOCKED_PHASES.indexOf(typeof e.phase === 'string' && e.phase ? e.phase : e.state === 'needs_you' ? 'needs_you' : '') >= 0;

  // The one row of actions for a card (pure). reviewing: Review was pressed on a risky command. Returns {risky, detail (the
  // text the read-only view shows, or ''), link ({label} quiet "Full command" text at the right, or null), buttons: [{label,
  // def, act: 'answer'|'review'|'reply'|'retry', button?}], note}.
  function toastActions(card, reviewing, showing) {
    const c = card || {};
    const out = { risky: false, detail: '', link: null, buttons: [], note: '' };
    if (c.reason === 'finished') return out; // To review: quiet, no buttons
    const full = String(c.full || c.line1 || '');
    const perms = (c.buttons || []).filter((b) => b && b.op === 'permission');
    if (perms.length) {
      // the agent's once-options only: "Always allow" belongs in the chat
      const always = (b) => /always/i.test(String(b.kind || '')) || /\balways\b/i.test(String(b.label || ''));
      const once = perms.filter((b) => !always(b));
      const allow = once.filter((b) => b.tone === 'ok'),
        deny = once.filter((b) => b.tone === 'no'),
        rest = once.filter((b) => b.tone !== 'ok' && b.tone !== 'no');
      const list = allow.concat(rest, deny);
      out.risky = !!(R.isRisky && R.isRisky(full));
      if (out.risky && !reviewing) {
        out.buttons.push({ label: 'Review', def: true, act: 'review' });
        if (deny[0]) out.buttons.push({ label: deny[0].label, def: false, act: 'answer', button: deny[0] });
      } else {
        const pick = out.risky ? [allow[0] || list[0], deny[0]].filter(Boolean) : list;
        pick.forEach((b, i) => out.buttons.push({ label: b.label, def: i === 0 && b.tone !== 'no', act: 'answer', button: b }));
        if (out.risky) out.detail = full;
        else if (full && full !== String(c.line1 || '')) {
          out.link = { label: showing ? 'Hide command' : 'Full command' };
          if (showing) out.detail = full;
        }
      }
    } else if ((c.buttons || []).length) {
      c.buttons.forEach((b, i) => out.buttons.push({ label: b.label, def: i === 0, act: 'answer', button: b }));
    } else if (c.retry) {
      out.buttons.push({ label: 'Retry', def: true, act: 'retry' }, { label: 'Reply', def: false, act: 'reply' });
    } else if (c.reply) {
      out.buttons.push({ label: 'Reply', def: true, act: 'reply' });
    } else if (c.loading) out.note = 'Loading the request…';
    if (c.more && out.buttons.length) out.note = '+' + c.more + ' more';
    return out;
  }

  // The card of a chat: the page's (workspace-ui.js) when it gives one, else the title alone.
  function cardOf(t) {
    let c = null;
    try {
      c = S.host && typeof S.host.toastCard === 'function' ? S.host.toastCard(t.chat) : null;
    } catch {
      c = null;
    }
    if (!c) c = { line1: t.title, title: t.title, project: '', buttons: [] };
    if (t.kind === 'turn') c = Object.assign({}, c, { reason: 'finished' });
    return c;
  }

  function stack() {
    if (!S.stack) {
      S.stack = doc().createElement('div');
      S.stack.className = 'toast-stack';
      S.stack.setAttribute('aria-live', 'polite');
      S.stack.setAttribute('role', 'region');
      S.stack.setAttribute('aria-label', 'Notifications');
      doc().body.append(S.stack);
    }
    return S.stack;
  }
  function dropToast(key) {
    const t = S.toasts.get(key);
    if (!t) return;
    if (t.node) t.node.remove();
    S.toasts.delete(key);
    arrange();
  }
  function make(tag, cls, text) {
    const n = doc().createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function tbtn(label, cls, onClick, title) {
    const b = make('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      onClick();
    });
    return b;
  }
  const errText = (e, fallback) => (e && e.message) || fallback;
  function runAct(t, a) {
    if (t.busy) return;
    if (a.act === 'review') {
      t.reviewing = true;
      paintToast(t);
      return;
    }
    if (a.act === 'reply') {
      t.replying = true;
      paintToast(t);
      const ta = t.node && t.node.querySelector('textarea');
      if (ta && ta.focus) ta.focus();
      return;
    }
    const send =
      a.act === 'retry'
        ? S.host && S.host.toastRetry && (() => S.host.toastRetry(t.chat))
        : S.host && S.host.toastAnswer && (() => S.host.toastAnswer(t.chat, a.button));
    if (!send) return;
    t.busy = true;
    t.error = '';
    paintToast(t);
    Promise.resolve()
      .then(send)
      .then(
        () => dropToast(t.key),
        (e) => {
          t.busy = false;
          t.error = errText(e, 'The answer could not be sent.');
          paintToast(t);
        },
      );
  }
  function sendReply(t) {
    const text = String(t.text || '').trim();
    if (t.busy || !text || !S.host || !S.host.toastReply) return;
    t.busy = true;
    t.error = '';
    paintToast(t);
    Promise.resolve()
      .then(() => S.host.toastReply(t.chat, text))
      .then(
        () => dropToast(t.key),
        (e) => {
          t.busy = false;
          t.error = errText(e, 'The message could not be sent.');
          paintToast(t);
        },
      );
  }
  // Draws one toast from its card (again when the card or its state changes).
  function paintToast(t) {
    const c = t.card,
      turn = t.kind === 'turn',
      node = t.node;
    node.className = 'toast toast-card toast-' + t.kind + (t.busy ? ' busy' : '');
    node.replaceChildren();
    const body = make('div', 'toast-body');
    const IR = root.AgentInboxRules;
    const w = !turn && c.since && IR && IR.waitText ? IR.waitText(c.since, Date.now() / 1000) : null;
    if (turn) {
      body.append(make('div', 'toast-l1', c.title || t.title));
      body.append(make('div', 'toast-l2', [R.TO_REVIEW, c.project].filter(Boolean).join(' · ')));
    } else {
      body.append(make('div', 'toast-l1', c.line1 || c.title || t.title));
      const l2 = make('div', 'toast-l2', [c.title || t.title, c.project].filter(Boolean).join(' · '));
      if (w && w.text !== 'just now') l2.append(make('span', 'toast-age' + (w.long ? ' long' : ''), w.text));
      body.append(l2);
    }
    const a = toastActions(c, t.reviewing, t.showFull);
    if (a.detail) body.append(make('div', 'toast-detail', '$ ' + a.detail));
    if (t.replying) {
      const box = make('div', 'toast-reply');
      const ta = make('textarea');
      ta.rows = 2;
      ta.value = t.text || '';
      ta.disabled = !!t.busy;
      ta.placeholder = 'Reply. Enter sends, Esc closes.';
      ta.setAttribute('aria-label', 'Reply to ' + (c.title || t.title));
      const send = tbtn(t.busy ? 'Sending…' : 'Send', 'toast-btn def', () => sendReply(t));
      send.disabled = !!t.busy || !String(t.text || '').trim();
      ta.addEventListener('input', () => {
        t.text = ta.value;
        send.disabled = !!t.busy || !ta.value.trim();
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          if (e.preventDefault) e.preventDefault();
          sendReply(t);
        } else if (e.key === 'Escape') {
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          t.replying = false;
          paintToast(t);
        }
      });
      ta.addEventListener('click', (e) => e && e.stopPropagation && e.stopPropagation());
      box.append(ta, send);
      body.append(box);
    } else if (a.buttons.length || a.link || a.note) {
      const row = make('div', 'toast-acts');
      for (const b of a.buttons) {
        const x = tbtn(b.label, 'toast-btn' + (b.def ? ' def' : ''), () => runAct(t, b));
        x.disabled = !!t.busy;
        row.append(x);
      }
      if (a.note) row.append(make('span', 'toast-note', a.note));
      if (a.link)
        row.append(
          tbtn(a.link.label, 'toast-link', () => {
            t.showFull = !t.showFull;
            paintToast(t);
          }),
        );
      body.append(row);
    }
    if (t.error) {
      const er = make('div', 'toast-err', t.error);
      er.setAttribute('role', 'alert');
      body.append(er);
    }
    // clicking the card (not a button or the box) opens the chat, as an inbox row does
    body.addEventListener('click', (e) => {
      const tg = e && e.target;
      if (tg && tg.closest && tg.closest('button, textarea, .toast-detail')) return;
      dropToast(t.key);
      openTarget({ type: 'chat', key: t.chat });
    });
    const close = tbtn('×', 'toast-close', () => dropToast(t.key), turn ? 'Dismiss' : 'Dismiss: it stays in the inbox');
    close.setAttribute('aria-label', turn ? 'Dismiss' : 'Dismiss: it stays in the inbox');
    node.append(body, close);
  }
  // The toasts in their order: needs you first, the oldest wait first; then To review, newest first.
  function ordered() {
    return [...S.toasts.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'needs' ? -1 : 1;
      if (a.kind === 'needs') return (a.since || 0) - (b.since || 0) || a.seq - b.seq;
      return b.seq - a.seq;
    });
  }
  // Shows at most MAX_TOASTS (their timers start when they show) and "+N more in the inbox" for the rest.
  function arrange(now) {
    if (!S.toasts.size && !S.stack) return;
    const t0 = now === undefined ? Date.now() : now;
    const list = ordered(),
      shown = list.slice(0, MAX_TOASTS),
      rest = list.length - shown.length;
    const st = stack();
    for (const t of list) if (shown.indexOf(t) < 0 && t.node) t.node.remove();
    for (const t of shown) if (!t.hideAt) t.hideAt = t0 + (t.kind === 'turn' ? TURN_MS : NEEDS_MS);
    if (S.more) S.more.remove();
    S.more = null;
    // put them in order only when it changed (moving a node would take the focus out of a reply being typed)
    const want = shown.map((t) => t.node),
      now0 = Array.from(st.children || []);
    if (want.length !== now0.length || want.some((n, i) => n !== now0[i])) {
      for (const n of want) n.remove();
      st.append(...want);
    }
    if (rest > 0) {
      S.more = tbtn('+' + rest + ' more in the inbox', 'toast-more', () => {
        if (S.host && S.host.openInbox) S.host.openInbox();
      });
      st.append(S.more);
    }
  }
  function showToast(chat, kind, title, since, now) {
    const old = S.toasts.get(chat);
    if (old && old.node) old.node.remove();
    S.toasts.delete(chat);
    const t = {
      key: chat,
      chat,
      kind,
      title,
      since: Number(since) || 0,
      seq: ++S.seq,
      node: make('div', 'toast'),
      hideAt: 0,
      hover: false,
      reviewing: false,
      replying: false,
      showFull: false,
      busy: false,
      error: '',
      text: '',
      card: null,
    };
    t.node.setAttribute('role', kind === 'needs' ? 'alert' : 'status');
    t.node.dataset.chat = chat;
    t.node.addEventListener('mouseenter', () => (t.hover = true));
    t.node.addEventListener('mouseleave', () => (t.hover = false));
    t.card = cardOf(t);
    t.cardSig = JSON.stringify(t.card);
    paintToast(t);
    S.toasts.set(chat, t);
    arrange(now);
    return t;
  }
  // Is the owner in this toast (pointer, focus, a reply or a review open)? Then it waits.
  function engaged(t) {
    const a = doc().activeElement;
    return (
      t.hover ||
      t.replying ||
      t.reviewing ||
      t.showFull ||
      t.busy ||
      !!(a && t.node && t.node.contains && t.node.contains(a))
    );
  }
  // Every second: toasts past their time step back into the inbox (not while you are in one); cards still loading (an
  // approval's body is fetched) are drawn again once they change.
  function tickToasts(now) {
    const t0 = now === undefined ? Date.now() : now;
    const shown = ordered().slice(0, MAX_TOASTS);
    let gone = false;
    for (const t of shown) {
      if (engaged(t)) {
        t.hideAt = t0 + (t.kind === 'turn' ? TURN_MS : NEEDS_MS);
        continue;
      }
      if (t.hideAt && t0 >= t.hideAt) {
        if (t.node) t.node.remove();
        S.toasts.delete(t.key);
        gone = true;
        continue;
      }
      if (!t.replying && !t.busy) {
        const c = cardOf(t),
          sig = JSON.stringify(c);
        if (sig !== t.cardSig) {
          t.card = c;
          t.cardSig = sig;
          paintToast(t);
        }
      }
    }
    if (gone) arrange(t0);
  }

  // Remove toasts that no longer apply: the chat is open now, or it stopped needing you / handing you the turn (answered
  // anywhere: here, the inbox, the chat itself, the phone).
  function reconcile() {
    const cur = new Map(S.current.map((e) => [e.key, e]));
    for (const [key, t] of [...S.toasts]) {
      const e = cur.get(t.chat);
      if (!e || e.muted || e.selected) dropToast(key);
      else if (t.kind === 'needs' && !isBlocked(e)) dropToast(key);
      else if (t.kind === 'turn' && (!e.yourTurn || isBlocked(e))) dropToast(key);
    }
  }

  // Studio came back to the front: the notification has done its job.
  function comeBack() {
    if (!away()) {
      closeShown();
      S.group = null;
    }
    reconcile();
  }

  // entries as in detect(). Called by workspace-ui.js after every list refresh.
  function observeItems(entries, now) {
    if (!Array.isArray(entries)) return [];
    S.current = entries;
    if (!entries.length) return []; // the list has not loaded yet: wait for the real baseline
    const { next, events } = detect(S.prev, entries);
    S.prev = next;
    reconcile();
    if (!events.length) return events;
    const byKey = new Map(entries.map((e) => [e.key, e])),
      t = now === undefined ? Date.now() : now;
    const isAway = away(),
      batch = [];
    for (const ev of events) {
      const e = byKey.get(ev.key);
      const d = decide({
        kind: ev.kind,
        away: isAway,
        selected: !!e.selected,
        eligible: e.eligible,
        muted: e.muted,
        notifyFor: S.prefs.notifyFor,
        soundPref: S.prefs.sound,
        desktopReady: !native() && desktopReady(), // the desktop app: the server notifies (see the top)
      });
      if (d.toast) showToast(ev.key, ev.kind, e.title, e.since, t);
      if (d.desktop || d.sound)
        batch.push({ key: ev.key, kind: ev.kind, title: e.title, sound: d.sound, desktop: d.desktop });
    }
    if (batch.length) {
      // desktopReady() is the same for every event of a batch, so either all of them want a notification or none do.
      const r = addToGroup(S.group, batch, t);
      S.group = r.group;
      const mine = soundMine(); // D1: one window chimes, not every window in the background
      if (mine && batch.some((b) => b.desktop)) showDesktop(r.group);
      if (mine && r.sound) chime(r.sound);
    }
    return events;
  }

  // ---- settings, inside the inbox popover's Notifications block ----
  function el(tag, text, cls) {
    const n = doc().createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function selectRow(label, options, value, onChange) {
    const row = el('label', null, 'notify-row');
    row.append(el('span', label));
    const sel = el('select');
    sel.setAttribute('aria-label', label);
    for (const [v, t] of options) {
      const o = el('option', t);
      o.value = v;
      sel.append(o);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    row.append(sel);
    return row;
  }
  function paintPop() {
    const pop = S.pop;
    if (!pop) return;
    pop.replaceChildren();
    const on = desktopReady(),
      p = permission(),
      app = native();
    // One name on every system (owner's choice): "Desktop notifications".
    const label = 'Desktop notifications';
    pop.append(
      selectRow(
        label,
        [
          ['on', 'On'],
          ['off', 'Off'],
        ],
        on ? 'on' : 'off',
        (v) => {
          if (v === 'on') enableDesktop();
          else {
            S.prefs.desktop = false;
            S.blocked = false;
            savePrefs();
            paintPop();
          }
        },
      ),
    );
    if (app) {
      if (S.testNote) pop.append(el('p', S.testNote.text, S.testNote.warn ? 'note warn' : 'note'));
    } else if (p === 'unsupported') pop.append(el('p', 'This browser does not support desktop notifications.', 'note'));
    else if (p === 'denied' || S.blocked)
      pop.append(el('p', 'Blocked by the browser - allow it in site settings', 'note warn'));
    pop.append(
      el(
        'p',
        "Only when AIB isn't in front. While you are looking at AIB, the badge and the list show what needs you.",
        'note',
      ),
    );
    pop.append(
      selectRow(
        'Notify for',
        [
          ['both', 'Needs you + ' + R.TO_REVIEW],
          ['needs', 'Needs you only'],
        ],
        S.prefs.notifyFor,
        (v) => {
          S.prefs.notifyFor = v;
          savePrefs();
        },
      ),
    );
    pop.append(
      selectRow(
        'Sound',
        [
          ['needs', 'Needs you only'],
          ['both', 'Both'],
          ['off', 'Off'],
        ],
        S.prefs.sound,
        (v) => {
          S.prefs.sound = v;
          savePrefs();
          const heard = soundFor('needs', v);
          if (heard) chime(heard);
        },
      ),
    );
    if (app) {
      // Always offered in the app (also while off: it shows what a notification looks like), with the app's answer above.
      const t = el('button', 'Send a test notification');
      t.type = 'button';
      t.addEventListener('click', () => sendTest(t));
      pop.append(t);
    } else if (on) {
      const t = el('button', 'Send a test notification');
      t.type = 'button';
      t.addEventListener('click', () =>
        showDesktop({ startedAt: Date.now(), entries: [{ key: '', title: 'AIB', kind: 'turn' }] }),
      );
      pop.append(t);
    }
    const muted = S.host && S.host.mutedProjects ? S.host.mutedProjects() : [];
    const head = el('strong', 'Muted projects');
    head.className = 'notify-muted-head';
    pop.append(head);
    if (!muted.length) pop.append(el('p', 'None. Mute a project from its menu (the ⋯ next to it).', 'note'));
    for (const m of muted) {
      const row = el('div', null, 'notify-muted');
      const name = el('span', m.name, 'notify-muted-name');
      name.title = m.name;
      const b = el('button', 'Unmute');
      b.type = 'button';
      b.setAttribute('aria-label', 'Unmute ' + m.name);
      b.addEventListener('click', () => {
        if (S.host.unmute) S.host.unmute(m.key);
        paintPop();
      });
      row.append(name, b);
      pop.append(row);
    }
  }

  // The desktop app's test: what it answered, as a line under the setting.
  function testText(r) {
    if (r && r.shown) return { text: 'Test sent. If nothing showed, Do not disturb may be on.', warn: false };
    const why = (r && r.reason) || 'the system did not show it';
    return { text: 'Not shown: ' + why + '.', warn: true };
  }
  function sendTest(button) {
    if (button) button.disabled = true;
    return root.AibDesktop.notify('AIB', 'This is a test notification.', null, true)
      .then(testText, (e) => ({ text: 'Not shown: ' + ((e && e.message) || 'AIB could not be reached') + '.', warn: true }))
      .then((note) => {
        S.testNote = note;
        if (button) button.disabled = false;
        paintPop();
        return note;
      });
  }

  function enableDesktop() {
    if (native()) {
      S.prefs.desktop = true;
      savePrefs();
      paintPop();
      return;
    }
    if (!supported()) {
      paintPop();
      return;
    }
    const done = (result) => {
      S.prefs.desktop = result === 'granted';
      S.blocked = result !== 'granted';
      savePrefs();
      paintPop();
    };
    try {
      const r = root.Notification.requestPermission(done); // the legacy callback form; modern browsers also return a promise
      if (r && typeof r.then === 'function') r.then(done, () => done('denied'));
    } catch {
      done('denied');
    }
  }

  // The settings live inside the needs-you inbox popover (workspace-ui.js), which hands us a node to fill.
  function mountSettings(node) {
    if (!node) return;
    S.pop = node;
    S.blocked = false;
    S.testNote = null;
    paintPop();
  }

  // ---- presence: is the owner at the PC? (server/attention/presence.ts) ----
  // The server sends no desktop notification while an AIB window has focus, and no phone push while you are working in it (focus
  // and input in the last 2 minutes). This page tells it: at once when focus changes, else every 20 s.
  const PRESENCE_MS = 20000;
  // It also says which chats the window shows (`open`, host.openKeys: inbox-rules.js openKeys): the server leaves them out of the
  // desktop notifications, the tray count and the taskbar dot (they are in front of you), never out of the phone's pushes. A
  // change of the open chats is sent at once.
  const P = { lastInput: Date.now(), sent: 0, focused: null, open: null };
  function openNow() {
    try {
      const k = S.host && typeof S.host.openKeys === 'function' ? S.host.openKeys() : [];
      return Array.isArray(k) ? k : [];
    } catch {
      return [];
    }
  }
  // K2: every report also says which window it is (w, kind, its project; a pop-out its chat) and whether it is visible.
  function presenceNow() {
    const d = doc(),
      W = Win();
    const base = { focused: !away(), idleMs: Math.max(0, Date.now() - P.lastInput), open: openNow() };
    if (!W) return base;
    let project = null;
    try {
      project = S.host && typeof S.host.windowProject === 'function' ? S.host.windowProject() : null;
    } catch {
      project = null;
    }
    return Object.assign(W.presenceFields(project), base, { visible: !d || d.visibilityState !== 'hidden' });
  }
  function reportPresence(force) {
    if (!S.host || typeof S.host.presence !== 'function') return null;
    const now = Date.now(),
      body = presenceNow(),
      open = body.open.join('\n');
    // with other windows open, the answer (their open chats, the sound owner) is kept fresh: it counts for 10 s only
    const W = Win(),
      a = W && W.answer && W.answer(),
      stale = !!(a && W.others().length && now - a.at > 6000);
    if (!force && !stale && body.focused === P.focused && open === P.open && now - P.sent < PRESENCE_MS) return null;
    const openChanged = P.open !== null && open !== P.open;
    P.focused = body.focused;
    P.open = open;
    P.sent = now;
    const failed = () => {
      P.sent = 0; // not delivered (the page is still starting, the server restarted): the next 5 s tick sends it again
      P.focused = null;
      P.open = null;
    };
    try {
      Promise.resolve(S.host.presence(body)).then((ans) => {
        if (ans === false) return failed();
        if (W && ans && typeof ans === 'object') W.noteAnswer(ans, body.open);
      }, failed);
      if (W && openChanged) W.hint('open'); // the other windows ask for a fresh answer at once
    } catch {
      failed();
    }
    return body;
  }
  function noteInput() {
    P.lastInput = Date.now();
  }

  // host: {openChat(key), openInbox(), mutedProjects() -> [{key, name}], unmute(key), presence?(body) -> answer|false,
  //        openKeys?() -> [chat keys open in THIS window], windowProject?() -> {key, name}|null, mayOpen?(chatKey) -> boolean}
  function init(host) {
    S.host = host;
    loadPrefs();
    doc().addEventListener('visibilitychange', comeBack);
    root.addEventListener('focus', comeBack);
    root.setInterval(() => {
      reconcile(); // DOM only: drops toasts for the chat you just opened
      tickToasts();
    }, 1000);
    const changed = () => reportPresence(true);
    doc().addEventListener('visibilitychange', changed);
    root.addEventListener('focus', () => {
      const W = Win();
      if (W) W.hint('focus'); // I am the sound owner now (the server's answer says so too)
      changed();
    });
    root.addEventListener('blur', changed);
    const W = Win();
    if (W) {
      // another window's hint (focus, its open chats changed, it went away): ask for a fresh answer
      let soon = 0;
      W.onHint(() => {
        if (soon) return;
        soon = root.setTimeout(() => {
          soon = 0;
          reportPresence(true);
        }, 60);
      });
      // what other windows show changed: the toasts for chats now open there go
      W.onChange(() => reconcile());
      const D = root.AibDesktop;
      if (D && D.pageToken) D.pageToken().catch(() => {}); // for the pagehide "left" report (window-context.js leave)
    }
    for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart'])
      doc().addEventListener(type, noteInput, { passive: true, capture: true });
    root.setInterval(() => reportPresence(false), 5000);
    reportPresence(true);
  }

  const api = {
    detect,
    decide,
    soundFor,
    addToGroup,
    describe,
    cleanPrefs,
    observeItems,
    toastActions,
    tickToasts,
    NEEDS_MS,
    TURN_MS,
    MAX_TOASTS,
    init,
    enableDesktop,
    mountSettings,
    openFromDesktop,
    sendTest,
    testText,
    native,
    chime,
    reportPresence,
    noteInput,
    GROUP_MS,
    _state: S,
  };
  root.AgentNotifyUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
