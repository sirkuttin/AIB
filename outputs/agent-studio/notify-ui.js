(function (root) {
  'use strict';
  // Tells you when a chat needs you ("Needs you": a question, approval or sign-in) or has handed the turn back ("Your turn").
  // The workspace code (workspace-ui.js) feeds it the same normalized chats the inbox and tabs use, after every list refresh, so
  // the words and the rules (hidden projects, worktree and scratch folders) match the list. Everything here is decided from
  // TRANSITIONS: a chat newly entering needs-you or your-turn is announced once, never again for the same transition.
  //   * Studio in front (visible and focused): no desktop notification and no sound; the badge and the sidebar show it.
  //     Chats other than the one you are looking at get a small in-page toast (it saves a trip to the inbox).
  //   * Studio away (hidden or not focused): a desktop notification (if turned on) and a sound (per setting).
  //   * Transitions within about a minute merge into ONE notification ("3 agents are waiting for you") that replaces the older.
  //   * Muted projects (server-side project prefs) never notify or sound; the inbox still lists them.
  // In the AIB desktop app the app process shows the notification itself (desktop-bridge.js notify -> server/desktop/notify.ts):
  // no browser permission is involved, the choices are AIB's own (saved in the data folder: view-prefs.js syncs APP_PREF_KEY) and
  // desktop notifications start on, for Needs you only. In a browser the web Notification API and its permission, as before.
  const PREF_KEY = 'studio-notifications',
    APP_PREF_KEY = 'studio-notifications-app';
  const GROUP_MS = 60000;
  const TAG = 'studio-attention';

  // ---- pure logic ---------------------------------------------------------------------------------------------
  // entries: [{key, title, state, needs, yourTurn, yourTurnAt, eligible, muted, selected}]; prev: the last result's `next`, or null.
  // The first observation only sets the baseline. Returns {next, events:[{key, kind: "needs"|"turn", needs?}]}.
  function detect(prev, entries) {
    const next = { conns: {} },
      events = [];
    for (const e of entries || []) {
      if (!e || typeof e.key !== 'string') continue;
      const needs = e.state === 'needs_you' ? Math.max(1, Number(e.needs) || 1) : 0;
      const turnAt = e.yourTurn ? Number(e.yourTurnAt) || 1 : 0;
      next.conns[e.key] = { needs, turnAt };
      if (!prev || !e.eligible || e.muted || e.state === 'closed') continue; // state still tracked: un-hiding or unmuting later does not replay old news
      const was = prev.conns[e.key];
      if (needs > (was ? was.needs : 0)) events.push({ key: e.key, kind: 'needs', needs });
      else if (!needs && turnAt && was && turnAt !== was.turnAt) events.push({ key: e.key, kind: 'turn' });
    }
    return { next, events };
  }

  // Which sound a kind gets under a setting: "needs" (Needs you only), "both", "off". Returns "needs", "turn" or null.
  function soundFor(kind, pref) {
    if (pref === 'off') return null;
    if (kind === 'needs') return 'needs';
    return pref === 'both' ? 'turn' : null;
  }
  const SOUND_RANK = { turn: 1, needs: 2 };

  // What to do about one event. o: {kind, away, selected, eligible, muted, notifyFor, soundPref, desktopReady}
  function decide(o) {
    const none = { toast: false, desktop: false, sound: null };
    if (!o.eligible || o.muted) return none;
    if (o.kind === 'turn' && o.notifyFor === 'needs') return none;
    if (!o.away) return { toast: !o.selected, desktop: false, sound: null }; // in front: never a desktop notification or a sound
    return { toast: false, desktop: !!o.desktopReady, sound: soundFor(o.kind, o.soundPref) };
  }

  // Coalesce events into one group per ~60 s. group: null or {startedAt, entries:[{key, kind, title}], sounded}.
  // Returns {group, sound} where sound is the sound to play now (a louder kind than already played in this group) or null.
  function addToGroup(group, items, now, windowMs) {
    const win = windowMs || GROUP_MS;
    let g =
      group && now - group.startedAt <= win
        ? { startedAt: group.startedAt, entries: group.entries.map((x) => ({ ...x })), sounded: group.sounded }
        : { startedAt: now, entries: [], sounded: null };
    let best = null;
    for (const it of items) {
      const at = g.entries.findIndex((x) => x.key === it.key);
      if (at >= 0) {
        const old = g.entries[at];
        g.entries[at] = {
          key: it.key,
          title: it.title || old.title,
          kind: old.kind === 'needs' || it.kind === 'needs' ? 'needs' : 'turn',
        };
      } else g.entries.push({ key: it.key, title: it.title, kind: it.kind });
      if (it.sound && (!best || SOUND_RANK[it.sound] > SOUND_RANK[best])) best = it.sound;
    }
    let sound = null;
    if (best && (!g.sounded || SOUND_RANK[best] > SOUND_RANK[g.sounded])) {
      sound = best;
      g.sounded = best;
    }
    return { group: g, sound };
  }

  // The notification text for a group. One entry names the chat; several say how many are waiting (titles, up to 3).
  function describe(group) {
    const list = (group && group.entries) || [];
    if (list.length === 1)
      return {
        tag: TAG,
        title: list[0].title || 'AIB',
        body: list[0].kind === 'needs' ? 'Needs you' : 'Your turn',
        target: { type: 'chat', key: list[0].key },
      };
    const names = list.slice(0, 3).map((x) => x.title || 'Conversation');
    if (list.length > 3) names.push('and ' + (list.length - 3) + ' more');
    return {
      tag: TAG,
      title: list.length + ' agents are waiting for you',
      body: names.join('\n'),
      target: { type: 'inbox' },
    };
  }

  const SOUND_MODES = ['needs', 'both', 'off'],
    NOTIFY_FOR = ['both', 'needs'];
  // app: the desktop app's defaults (notifications on, Needs you only); a browser's stay off until allowed, for both kinds.
  function cleanPrefs(v, app) {
    v = v && typeof v === 'object' ? v : {};
    // The old checkbox ("Play a sound") was a boolean: on becomes "Needs you only", off stays off.
    const sound = SOUND_MODES.includes(v.sound) ? v.sound : v.sound === false ? 'off' : 'needs';
    return {
      desktop: app ? v.desktop !== false : v.desktop === true,
      sound,
      notifyFor: NOTIFY_FOR.includes(v.notifyFor) ? v.notifyFor : app ? 'needs' : 'both',
    };
  }

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
    blocked: false,
    testNote: null, // the desktop app's answer to the last test: {text, warn}
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
    else if (S.host.openInbox) S.host.openInbox();
  }

  // The desktop app: its notification was clicked and the window is in front again (server/desktop/window.ts
  // openFromNotification). True once the page is ready to open it; the app tries again while the page still loads.
  function openFromDesktop(target) {
    if (!S.host) return false;
    if (target && (target.type === 'chat' || target.type === 'inbox')) openTarget(target);
    return true;
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
    root.clearTimeout(t.timer);
    t.node.remove();
    S.toasts.delete(key);
  }
  function showToast(chat, kind, title) {
    const key = chat + ':' + kind;
    dropToast(key);
    const node = doc().createElement('div');
    node.className = 'toast toast-' + kind;
    node.setAttribute('role', 'status');
    const text = doc().createElement('div');
    text.className = 'toast-text';
    const head = doc().createElement('strong');
    head.textContent = title;
    const sub = doc().createElement('span');
    sub.textContent = kind === 'needs' ? 'Needs you' : 'Your turn';
    text.append(head, sub);
    const open = doc().createElement('button');
    open.type = 'button';
    open.className = 'toast-open';
    open.textContent = 'Open';
    open.addEventListener('click', () => {
      dropToast(key);
      openTarget({ type: 'chat', key: chat });
    });
    const close = doc().createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => dropToast(key));
    node.append(text, open, close);
    const entry = { node, chat, kind, timer: null };
    if (kind === 'turn') entry.timer = root.setTimeout(() => dropToast(key), 10000);
    S.toasts.set(key, entry);
    stack().append(node);
    while (S.toasts.size > 5) {
      const oldest = [...S.toasts.entries()].find(([, t]) => t.kind === 'turn') || [...S.toasts.entries()][0];
      dropToast(oldest[0]);
    }
  }

  // Remove toasts that no longer apply: the chat is open now, or it stopped needing you / handing you the turn.
  function reconcile() {
    const cur = new Map(S.current.map((e) => [e.key, e]));
    for (const [key, t] of [...S.toasts]) {
      const e = cur.get(t.chat);
      if (!e || e.muted || (e.selected && !away())) dropToast(key);
      else if (t.kind === 'needs' && e.state !== 'needs_you') dropToast(key);
      else if (t.kind === 'turn' && (!e.yourTurn || e.state === 'needs_you')) dropToast(key);
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
        desktopReady: desktopReady(),
      });
      if (d.toast) showToast(ev.key, ev.kind, e.title);
      if (d.desktop || d.sound)
        batch.push({ key: ev.key, kind: ev.kind, title: e.title, sound: d.sound, desktop: d.desktop });
    }
    if (batch.length) {
      // desktopReady() is the same for every event of a batch, so either all of them want a notification or none do.
      const r = addToGroup(S.group, batch, t);
      S.group = r.group;
      if (batch.some((b) => b.desktop)) showDesktop(r.group);
      if (r.sound) chime(r.sound);
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
          ['both', 'Needs you + Your turn'],
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

  // host: {openChat(key), openInbox(), mutedProjects() -> [{key, name}], unmute(key)}
  function init(host) {
    S.host = host;
    loadPrefs();
    doc().addEventListener('visibilitychange', comeBack);
    root.addEventListener('focus', comeBack);
    root.setInterval(reconcile, 1000); // DOM only: drops toasts for the chat you just opened
  }

  const api = {
    detect,
    decide,
    soundFor,
    addToGroup,
    describe,
    cleanPrefs,
    observeItems,
    init,
    enableDesktop,
    mountSettings,
    openFromDesktop,
    sendTest,
    testText,
    native,
    chime,
    GROUP_MS,
    _state: S,
  };
  root.AgentNotifyUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
