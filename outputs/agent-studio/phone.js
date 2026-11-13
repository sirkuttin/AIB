'use strict';
/* The phone page (phone.html), served only on the phone port (server/remote/server.ts) through Tailscale Serve.
   Owner-approved layout (phone prototypes round 3, aib-phone-prototypes.html):
   Home: ONE plain list of chat cards, newest change of state first (starts working, asks, finishes, you send; cards do not move for
   every step). No sections, no main chat. A card: title, unread dot, time, the project (its colour mark from the PC), agent, state
   in the PC's words (Working, Needs you, Your turn, Idle, Not running), and the last line. Chats that are not running are in the
   same list by time, drawn lighter. "All projects ▾" filters by project (no grouping), remembered on this phone.
   A chat: one agent. Its subagents are a "Subagents · N" card in the stream (title and state only) with a shortcut under the
   title. Approvals and questions are cards IN the stream ("Needs you · approval / question"), never a sheet over the chat: a card
   is open when it is the newest thing in the chat, closed (tap to open) once newer activity follows it, and open when a
   notification brought you to it. After you act, the card is a one-line record ("You allowed once from this phone: …"). While a
   waiting card is scrolled out of view, a "Needs you · Show ↑" bar sits above the message box. The bottom: what waits to be sent
   (Edit, Remove, Send now; Resume after Stop), the message box with Send, and Stop (■) while the agent works.
   Each control shows only when this phone's switch for it is on (Settings → Remote control on the PC); the server checks the same
   switches. While the PC can't be reached, nothing can be sent or answered. The layout is chosen by the server (remote bootstrap
   says layout 'phone'), never by the window width.
   The device token lives in IndexedDB on this origin and goes in the X-AIB-Device header; images load by the HttpOnly cookie.
   Polls every 4 s (home) or 3 s (a chat) while the page is visible, and stops while it is hidden.
   Phase C: a service worker (/sw.js, pwa/sw.js) keeps the page's own files, so the page still opens when AIB is closed; it then
   says "Reconnecting…" for about 20 s (the keeper starts a crashed AIB again in 5 s), then that AIB is closed on the PC (Tailscale
   Serve answers 502) or that the PC can't be reached (no answer at all), with Try again. It never claims the chats still run.
   Notifications: the Finish setup screen (after pairing, and from home) turns them on with a tap (a phone only asks from a tap);
   on an iPhone it first says to add the page to the Home Screen (iPhone sends pushes only to Home Screen apps). The page subscribes
   again each time it opens. A tap on a push opens the chat at its waiting card, open (#chat=<id>&sheet=1, or a message from the
   worker).
   Phase D: artifacts. A chat's artifacts (the artifact events, finished studio_artifact calls, studio-artifact:// links and links
   to the artifact origin in replies) show as cards; a tap asks the PC for a short-lived link on the phone's artifact origin
   (https://<name>:8443) and shows it full screen with Close: pages, SVG, Markdown and CSV tables in a sandboxed frame (never
   same-origin), pictures as pictures, text in a sandboxed frame. A PDF, or any artifact while that origin is not set up, says
   "Open on your PC".
   Not running (owner decisions 3b, 4): such a chat opens read only with its saved messages and Continue this chat (only when this
   phone may send), which starts it again on the PC with its saved agent and settings; a chat another app has open is refused with
   the reason. A chat whose newest messages are on screen (page visible, scrolled to the end) is marked read on the PC, at most
   every READ_MS.
   Presence (server/attention/presence.ts): the polls tell the PC this phone is in hand and which chat it shows; when the page is
   hidden it says so (POST /api/remote/left). While it is in hand the PC sends no push: news about the chat on screen just shows
   there, and news about another chat comes with the next poll's answer (`notices`). Inside a chat it shows as a banner under the
   header ("A chat needs you" / "Chat finished"; tap: open that chat; × closes it; "Chat finished" goes by itself after
   BANNER_TURN_MS). Never on the chat list: each card's state already says it (owner, prototypes round 2).
   Part 2 (prototypes round 4): "+ New chat" (Start new chats switch, a child of Send): project -> agent (one that cannot start is
   greyed with its reason) -> model -> mode (every mode, no warning) -> first message; the picks are for that chat only; the first
   message goes once the chat is ready, and is held (text kept in the box, error shown) when the mode could not be set. A card menu
   (⋯ or a long press / right-click): View artifacts, Mark as read / unread (running chats), Mark handled (your turn), Rename,
   Archive (Keep running / End its session: ending needs Send), Delete (confirmation; a running chat needs Send), Undo on the toast.
   A chat's Artifacts page (▤ in the header with a count, read when the chat opens; never on home polls) and a version menu in the
   viewer (v3 ▾, "vN is available · Switch"). Theme: the PC's theme in this phone's light or dark (themes.js phoneTheme), or this
   phone's own pick (⋯ at the top of the list → Theme, localStorage). Install AIB: our button from beforeinstallprompt (Finish
   setup and the ⋯ menu; never a banner), the Share steps on an iPhone, Firefox's menu steps, hidden once installed.
   Pure helpers (rowsFrom, stateWords, orderHome, reqOpen, elapsed, checkWords' input, offlineView, setupSteps, artifactFrom,
   artifactRef...) are exported for node tests. */
(function (root) {
  const HOME_MS = 4000;
  const CHAT_MS = 3000;
  const PAIR_POLL_MS = 2000;
  const TIMEOUT_MS = 10000;
  const TAIL = 300;
  const DB = 'aib-phone';
  const READ_MS = 5000; // a chat's read position goes to the PC at most this often
  const RECONNECT_MS = 20000; // "Reconnecting…" this long before saying AIB is closed (the keeper restarts a crashed AIB in 5 s)
  const BANNER_TURN_MS = 10000; // a "Chat finished" banner goes by itself after this; a "Needs you" one stays until tapped or closed

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

  /* The status words for a chat card: {text, tone} (tone: need | work | turn | idle | nr). Same words as the PC: Needs you,
     Working, Your turn, Idle, Not running. */
  function stateWords(c, now) {
    if (c && c.notRunning) return { text: 'Not running', tone: 'nr' };
    if (c.needs > 0 || c.state === 'needs_you') return { text: 'Needs you', tone: 'need' };
    if (c.state === 'working') {
      const e = ago(c.busySince, now);
      return { text: 'Working' + (e && e !== 'now' ? ' · ' + e : ''), tone: 'work' };
    }
    if (c.state === 'opening') return { text: 'Starting…', tone: 'idle' };
    if (c.yourTurn) return { text: 'Your turn', tone: 'turn' };
    return { text: 'Idle', tone: 'idle' };
  }

  /* The short time on a card: "now", "4m", "2h", "3d" since an ISO time, or ''. */
  function ago(iso, now) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const m = Math.max(0, Math.floor(((now || Date.now()) - t) / 60000));
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    if (m < 1440) return Math.floor(m / 60) + 'h';
    return Math.floor(m / 1440) + 'd';
  }

  const HELPER_WORDS = {
    running: 'working',
    in_progress: 'working',
    working: 'working',
    pending: 'waiting',
    needs_you: 'needs you',
    needs_input: 'needs you',
    needs: 'needs you',
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
  /* The colour of a helper's state dot: needs you = need (warning), working = work (accent), done = turn (good), else idle (muted). */
  const helperTone = (state) => {
    const w = helperWord(state);
    return w === 'needs you' ? 'need' : w === 'working' ? 'work' : w === 'done' ? 'turn' : 'idle';
  };

  /* ---- artifacts ---- */
  const ARTIFACT_ID = /^[0-9a-f]{16}$/;
  const ARTIFACT_KINDS = {
    html: 'HTML page',
    svg: 'SVG image',
    md: 'Markdown',
    image: 'Image',
    pdf: 'PDF',
    csv: 'CSV table',
    json: 'JSON',
    text: 'Text',
  };
  const artifactKind = (k) => ARTIFACT_KINDS[k] || 'File';
  /* An artifact summary ({id, title, kind, version}) from an object that names one, or null. */
  function artifactOf(o) {
    o = obj(o);
    const id = str(o.id).toLowerCase();
    if (!ARTIFACT_ID.test(id)) return null;
    return {
      id,
      title: str(o.title).slice(0, 200) || 'Artifact',
      kind: str(o.kind),
      version: Math.max(0, Number(o.version) || 0),
    };
  }
  /* Every piece of text a finished tool call carries its answer in (rawOutput, content, MCP content blocks). */
  function textsOf(v, out, depth) {
    out = out || [];
    if (depth > 6 || v == null) return out;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => textsOf(x, out, (depth || 0) + 1));
    else if (typeof v === 'object') {
      if (artifactOf(v)) out.push(JSON.stringify(v));
      if (typeof v.text === 'string') out.push(v.text);
      if (v.content !== undefined) textsOf(v.content, out, (depth || 0) + 1);
      if (v.structuredContent !== undefined) out.push(JSON.stringify(v.structuredContent));
    }
    return out;
  }
  /* The artifact a studio_artifact result text names (plain JSON, or JSON after a sentence), or null. */
  function artifactInText(text) {
    const t = String(text || '');
    const a = t.indexOf('{'),
      b = t.lastIndexOf('}');
    for (const part of a >= 0 && b > a ? [t, t.slice(a, b + 1)] : [t]) {
      try {
        const found = artifactOf(JSON.parse(part));
        if (found) return found;
      } catch {
        /* not JSON */
      }
    }
    return null;
  }
  const isArtifactTool = (u) => {
    try {
      return /studio_artifact/i.test(JSON.stringify([u.title, u.toolName, u._meta]).slice(0, 3000));
    } catch {
      return false;
    }
  };
  /* The artifact an event shows: an artifact event (made or new version), or a finished studio_artifact call's answer. `tool`:
     this call was named as a studio_artifact call earlier (updates often carry no title). */
  function artifactFrom(e, tool) {
    e = obj(e);
    const data = obj(e.data);
    if (e.kind === 'artifact') return artifactOf(data.artifact);
    const u = obj(data.update);
    if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return null;
    if (u.status !== 'completed' || !(tool || isArtifactTool(u))) return null;
    for (const t of textsOf([u.rawOutput, u.content])) {
      const found = artifactInText(t);
      if (found) return found;
    }
    return null;
  }
  /* {id, version} of a link to an artifact: studio-artifact://<id>, or a link to /a/<id>/v<n>/ on the phone's artifact origin
     (`origin`), else null. */
  function artifactRef(href, origin) {
    const h = String(href || '');
    let m = /^studio-artifact:\/\/([0-9a-f]{16})\/?$/i.exec(h);
    if (m) return { id: m[1].toLowerCase(), version: 0 };
    if (!origin || h.slice(0, origin.length + 1) !== origin + '/') return null;
    m = /^\/(?:r\/[^/]+\/)?a\/([0-9a-f]{16})\/v([0-9]{1,6})\//.exec(h.slice(origin.length));
    return m ? { id: m[1], version: Number(m[2]) } : null;
  }

  /* Events (the phone payload) -> condensed rows, the "Chat" view: your prompts, the agent's messages, a fold for each run of
     steps between them, notices, artifact cards (one per artifact version), and each waiting approval or question where it was
     asked (opts.waiting: the chat's waiting list; one that has no event in these rows, or a sign-in, comes last). A request you
     answered from this phone (opts.acted: key -> what you did) is a one-line record there.
     {kind:'you'|'agent'|'steps'|'notice'|'artifact'|'req'|'record', key, text?, images?, steps?, artifact?} */
  function rowsFrom(events, opts) {
    const o = obj(opts);
    const acted = obj(o.acted);
    const waiting = (Array.isArray(o.waiting) ? o.waiting : []).map((w) => str(obj(w).key) || 'sign-in');
    const placed = new Set();
    const has = (k) => Object.prototype.hasOwnProperty.call(acted, k);
    const rows = [];
    const steps = new Map(); // toolCallId -> step
    const shown = new Set(); // artifact id + version with a card already
    const card = (art, key) => {
      if (!art) return;
      const at = art.id + ':' + art.version;
      if (shown.has(at) || (art.version === 0 && [...shown].some((x) => x.startsWith(art.id + ':')))) return;
      shown.add(at);
      rows.push({ kind: 'artifact', key: key + 'a', artifact: art });
    };
    const imagesOf = (list) => (Array.isArray(list) ? list : []).filter((a) => a && a.url).map((a) => a.url);
    for (const e of Array.isArray(events) ? events : []) {
      const data = obj(e.data);
      const key = 'e' + (e.seq || rows.length);
      const last = rows[rows.length - 1];
      if (e.kind === 'user') {
        rows.push({ kind: 'you', key, text: str(data.text), images: imagesOf(data.attachments), steered: data.steered === true });
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
          if (kind === 'tool_call' || isArtifactTool(u)) step.artifactTool = step.artifactTool || isArtifactTool(u);
          card(artifactFrom(e, step.artifactTool), key);
        }
      } else if (e.kind === 'artifact') {
        card(artifactFrom(e), key);
      } else if (e.kind === 'permission' || e.kind === 'elicitation') {
        const k = str(data.key);
        if (k && has(k) && !placed.has(k)) {
          placed.add(k);
          rows.push({ kind: 'record', key: k, text: recordText(acted[k]) });
          continue;
        }
        if (k && waiting.includes(k) && !placed.has(k)) {
          placed.add(k);
          rows.push({ kind: 'req', key: k });
          continue;
        }
        const params = obj(data.params);
        const title = str(obj(params.toolCall).title) || str(params.message);
        if (title) rows.push({ kind: 'notice', key, text: (e.kind === 'permission' ? 'Asked to: ' : 'Asked: ') + title });
      } else if (e.kind === 'error' || e.kind === 'disconnected' || e.kind === 'studio_note') {
        const text = str(data.message);
        if (text) rows.push({ kind: 'notice', key, text });
      }
    }
    const out = rows.filter((r) => r.kind !== 'agent' || r.text.trim() || r.images.length);
    for (const k of waiting) {
      if (placed.has(k)) continue;
      placed.add(k);
      out.push(has(k) ? { kind: 'record', key: k, text: recordText(acted[k]) } : { kind: 'req', key: k });
    }
    return out;
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

  /* The fields of a form question (the agent's requestedSchema), in order, as the question card draws them:
     {key, title, description, required, type: 'choice' | 'multi' | 'bool' | 'number' | 'text', choices?: [{value, label}]} */
  function fieldsOf(schema) {
    const props = obj(obj(schema).properties);
    const required = Array.isArray(obj(schema).required) ? obj(schema).required : [];
    const out = [];
    for (const key of Object.keys(props)) {
      const s = obj(props[key]);
      const f = { key, title: str(s.title) || key, description: str(s.description), required: required.includes(key), type: 'text' };
      const one = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null;
      const items = obj(s.items);
      if (s.type === 'boolean') {
        f.type = 'bool';
        f.choices = [{ value: true, label: 'Yes' }, { value: false, label: 'No' }];
      } else if (one || Array.isArray(s.enum)) {
        f.type = 'choice';
        f.choices = one ? one.map((x) => ({ value: obj(x).const, label: str(obj(x).title) || String(obj(x).const) })) : s.enum.map((x) => ({ value: x, label: String(x) }));
      } else if (s.type === 'array' && (Array.isArray(items.enum) || Array.isArray(items.anyOf))) {
        f.type = 'multi';
        f.choices = Array.isArray(items.anyOf)
          ? items.anyOf.map((x) => ({ value: obj(x).const, label: str(obj(x).title) || String(obj(x).const) }))
          : items.enum.map((x) => ({ value: x, label: String(x) }));
      } else if (s.type === 'number' || s.type === 'integer') {
        f.type = 'number';
        f.integer = s.type === 'integer';
      }
      out.push(f);
    }
    return out;
  }

  /* The answer to send from what was picked and typed: {content, missing: [field titles]}. Empty optional fields are left out. */
  function contentFrom(fields, values) {
    const content = {};
    const missing = [];
    for (const f of fields) {
      let v = obj(values)[f.key];
      if (f.type === 'number' && typeof v === 'string') v = v.trim() === '' ? undefined : Number(v);
      if (f.type === 'text' && typeof v === 'string' && !v.trim()) v = undefined;
      if (f.type === 'multi' && Array.isArray(v) && !v.length && !f.required) v = undefined;
      if (v === undefined || (typeof v === 'number' && Number.isNaN(v))) {
        if (f.required) missing.push(f.title);
        continue;
      }
      content[f.key] = v;
    }
    return { content, missing };
  }

  /* The approval card's buttons for a request: Deny then Allow once, each only when the PC lets a phone pick it. */
  function approvalButtons(wait) {
    const options = Array.isArray(obj(wait).options) ? wait.options : [];
    const out = [];
    const deny = options.find((o) => o.kind === 'reject_once');
    const allow = options.find((o) => o.kind === 'allow_once');
    if (deny) out.push({ label: 'Deny', optionId: deny.optionId, tone: 'deny' });
    if (allow) out.push({ label: 'Allow once', optionId: allow.optionId, tone: 'allow' });
    return out;
  }

  /* What this phone may do, from its switches: {answer, approve, send, start}. */
  function abilities(scopes) {
    const list = Array.isArray(scopes) ? scopes : [];
    return {
      answer: list.includes('phone.answer'),
      approve: list.includes('phone.approve'),
      send: list.includes('phone.prompt'),
      start: list.includes('phone.start') && list.includes('phone.prompt'), // Start new chats: a child of Send
    };
  }

  /* Can this waiting item be handled on this phone now? */
  function actionable(wait, can) {
    if (!wait || !wait.key || wait.pcOnly) return false;
    if (wait.kind === 'permission') return can.approve && approvalButtons(wait).length > 0;
    if (wait.kind === 'question') return can.answer;
    return false;
  }

  /* The words under a chat that is not running: "Not running · Claude Code · last active 3 h ago". */
  function savedWords(c, now) {
    const e = elapsed(obj(c).lastActive, now);
    const when = e ? 'last active ' + (e === 'just now' ? e : e + ' ago') : '';
    return ['Not running', str(obj(c).agent), when].filter(Boolean).join(' · ');
  }

  /* The event a live chat may be marked read up to on the PC, or 0: the page is visible, the chat's end is on screen, it runs, and
     there is something newer than what was last sent (`sent`: {seq, at}) and READ_MS has passed since then. */
  function readTarget(chat, view, sent, now) {
    const c = obj(chat);
    const v = obj(view);
    const last = obj(sent);
    if (!v.visible || !v.atEnd || c.gone || c.closed || !c.id) return 0;
    const seq = Number(c.cursor) || 0;
    if (seq <= (Number(last.seq) || 0)) return 0;
    if ((now || Date.now()) - (Number(last.at) || 0) < READ_MS) return 0;
    return seq;
  }

  /* The text both sides hash for the two check words (server/remote/words.ts checkWords). */
  const checkInput = (secretHex, phoneNonce, pcNonce) => 'aib-pair-check|' + secretHex + '|' + phoneNonce + '|' + pcNonce;

  /* What the page says while AIB does not answer. why: 'down' (Tailscale Serve answered 502/503/504: nothing listens behind it, so
     AIB is closed or phone access is off) or 'unreachable' (no answer: Tailscale off on the phone, the PC asleep or offline).
     {kind: 'reconnecting' | 'closed' | 'unreachable', title, lines: [text], checks: [text], retry: bool}. Never says the chats run. */
  function offlineView(since, now, why, pcName, waitMs) {
    const pc = pcName || 'your PC';
    if (now - since < (waitMs || RECONNECT_MS))
      return { kind: 'reconnecting', title: 'Reconnecting…', lines: ['AIB on ' + pc + ' is not answering. Trying again.'], checks: [], retry: false };
    if (why === 'down')
      return {
        kind: 'closed',
        title: 'AIB is closed on ' + pc,
        lines: ['Open AIB on your PC, then tap Try again.', 'If AIB is open, check that phone access is on in Settings → Remote control.'],
        checks: [],
        retry: true,
      };
    return {
      kind: 'unreachable',
      title: "Can't reach " + pc,
      lines: [],
      checks: ['Tailscale is on, on this phone.', 'The PC is awake and AIB is running.'],
      retry: true,
    };
  }

  /* An iPhone or iPad (iPadOS says "Macintosh" but has a touch screen): pushes need the page on the Home Screen there. */
  function isIPhone(ua, touchPoints) {
    const s = String(ua || '');
    return /iPhone|iPod|iPad/.test(s) || (/Macintosh/.test(s) && Number(touchPoints) > 1);
  }

  /* Firefox on Android (no install prompt event: it has its own menu item). */
  function isFirefoxAndroid(ua) {
    const s = String(ua || '');
    return /Android/.test(s) && /Firefox\//.test(s);
  }
  /* How this phone installs the page as an app (owner: an Install AIB button where the browser offers it):
     'installed' (running installed, or just installed), 'iphone' (Share → Add to Home Screen, any iPhone browser), 'prompt' (the
     browser offered beforeinstallprompt: our own button), 'firefox' (its menu), 'other' (the browser menu, neutral words). */
  function installKind(o) {
    const x = obj(o);
    if (x.standalone || x.installed) return 'installed';
    if (x.iphone) return 'iphone';
    if (x.prompt) return 'prompt';
    if (x.firefox) return 'firefox';
    return 'other';
  }
  /* The words of each way (menu labels: Firefox for Android 138+ "Add app to Home screen", older "Add to Home screen", per
     support.mozilla.org "Use Web Apps with Firefox for Android"; iOS 26 Safari: Share → Add to Home Screen → Open as Web App → Add). */
  const INSTALL_WORDS = {
    installed: 'AIB is installed on this phone. Open it from its icon.',
    iphone:
      'Tap the Share button (in Safari it can be under ⋯ next to the address), then Add to Home Screen. Leave Open as Web App on and tap Add. ' +
      'Open AIB from the Home Screen: iPhone sends notifications only to apps on the Home Screen.',
    prompt: 'Put AIB on this phone as an app: it opens from its own icon, full screen, without the browser bar. Tap Install AIB, then Install.',
    firefox: 'In Firefox, tap the menu ⋮, then Add app to Home screen (older versions: Add to Home screen), then Add. Open AIB from that icon.',
    other: 'Open the browser menu and choose Install app or Add to Home screen. Then open AIB from that icon.',
  };
  function installText(kind) {
    return INSTALL_WORDS[kind] || INSTALL_WORDS.other;
  }

  /* The Finish setup steps. o: {iphone, standalone, supported, permission ('default'|'granted'|'denied'), on (subscribed here),
     allowed (this phone's Push switch on the PC), installed, prompt, firefox}.
     [{id: 'home' | 'install' | 'notify', state: 'todo' | 'done' | 'blocked' | 'off', text, kind?}] */
  function setupSteps(o) {
    const steps = [];
    if (o.iphone)
      steps.push({
        id: 'home',
        state: o.standalone ? 'done' : 'todo',
        text: o.standalone ? 'AIB is on your Home Screen.' : installText('iphone'),
      });
    else {
      const kind = installKind(o);
      steps.push({ id: 'install', kind, state: kind === 'installed' ? 'done' : 'todo', text: installText(kind) });
    }
    let notify;
    if (!o.allowed) notify = { state: 'off', text: 'Notifications are off for this phone. Turn on Push for it in AIB on your PC: Settings → Remote control.' };
    else if (o.iphone && !o.standalone) notify = { state: 'todo', text: 'After step 1, open AIB from the Home Screen and turn notifications on there.' };
    else if (!o.supported) notify = { state: 'off', text: 'This browser cannot show notifications from AIB.' };
    else if (o.permission === 'denied') notify = { state: 'blocked', text: 'Notifications are blocked for this page. Allow them in the browser’s site settings.' };
    else if (o.permission === 'granted' && o.on) notify = { state: 'done', text: 'Notifications are on. You get one when a chat needs you or finishes.' };
    else notify = { state: 'todo', text: 'Get a notification when a chat needs you or finishes. It says only that, and the chat’s name.' };
    steps.push({ id: 'notify', ...notify });
    return steps;
  }

  /* What a push or a link asks to open: '#chat=<id>&sheet=1' -> {chat, sheet}, or null. */
  function openTarget(hash) {
    const m = /^#chat=([^&]{1,100})(&sheet=1)?$/.exec(String(hash || ''));
    if (!m) return null;
    try {
      return { chat: decodeURIComponent(m[1]), sheet: !!m[2] };
    } catch {
      return null;
    }
  }

  /* The banner after a poll's `notices` (news held back because this phone is in hand): the newest one about another chat than the
     one on screen (`current`); a "Needs you" banner is not replaced by another chat's "finished". old: the banner up now, or null.
     Returns {chat, kind: 'needs' | 'turn', title, text} or null. */
  function bannerFrom(notices, current, old) {
    let best = old && old.chat !== current ? old : null;
    for (const n of Array.isArray(notices) ? notices : []) {
      const x = obj(n);
      const chat = str(x.chat).slice(0, 100);
      if (!chat || chat === current) continue;
      const kind = x.kind === 'needs' ? 'needs' : 'turn';
      if (best && best.kind === 'needs' && kind === 'turn' && best.chat !== chat) continue;
      best = { chat, kind, title: str(x.title).slice(0, 120) || 'A chat', text: kind === 'needs' ? 'A chat needs you' : 'Chat finished' };
    }
    return best;
  }

  /* base64url -> bytes (the application server key a phone subscribes with). */
  function keyBytes(b64url) {
    const b64 = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* The PC's project colours (workspace-state.js PALETTE): a palette id -> a CSS colour; '' or unknown -> the muted text colour. */
  const PALETTE = {
    blue: [215, 55, 62],
    sky: [195, 55, 60],
    teal: [172, 40, 56],
    indigo: [240, 50, 68],
    violet: [268, 50, 68],
    orchid: [295, 42, 64],
    pink: [328, 52, 66],
    slate: [220, 14, 60],
  };
  function projectColor(id) {
    const c = Object.prototype.hasOwnProperty.call(PALETTE, id) ? PALETTE[id] : null;
    return c ? 'hsl(' + c[0] + ' ' + c[1] + '% ' + c[2] + '%)' : 'var(--muted)';
  }

  /* Home's one list: the live chats and the ones that are not running, newest change of state first (a chat that is not running by
     when it was last active), only the picked project's when `filter` (a project id) is set. Each item:
     {kind: 'live' | 'saved', id, key, title, agent, project: {id, name, color}, at (ms), chat}. */
  function orderHome(home, filter) {
    const h = obj(home);
    const items = [];
    for (const c of Array.isArray(h.chats) ? h.chats : []) {
      items.push({ kind: 'live', id: c.id, title: c.title, agent: c.agent, project: obj(c.project), at: Date.parse(c.changedAt || '') || 0, chat: c });
    }
    for (const c of Array.isArray(h.saved) ? h.saved : []) {
      items.push({ kind: 'saved', key: c.key, title: c.title, agent: c.agent, project: obj(c.project), at: Date.parse(c.lastActive || '') || 0, chat: c });
    }
    items.sort((a, b) => b.at - a.at || (a.kind === b.kind ? 0 : a.kind === 'live' ? -1 : 1));
    return filter ? items.filter((i) => i.project.id === filter) : items;
  }

  /* The projects the filter lists (from the cards, in the order they first appear in the list): [{id, name, color, count}]. */
  function homeProjects(items) {
    const out = new Map();
    for (const i of items) {
      const p = i.project;
      if (!p || !p.id) continue;
      if (!out.has(p.id)) out.set(p.id, { id: p.id, name: str(p.name) || 'No folder', color: str(p.color), count: 0 });
      out.get(p.id).count++;
    }
    return [...out.values()];
  }

  /* Is a waiting card open? Your tap wins (`opened`: key -> true/false); else it is open when it is the newest thing in the chat
     (the last row) or a notification brought you to it (`land`). */
  function reqOpen(rows, key, opened, land) {
    const o = obj(opened);
    if (Object.prototype.hasOwnProperty.call(o, key)) return !!o[key];
    if (land && land === key) return true;
    const list = Array.isArray(rows) ? rows : [];
    const last = list[list.length - 1];
    return !!last && last.kind === 'req' && last.key === key;
  }

  /* The one-line record after you acted on a waiting card from this phone. what: {kind: 'allow' | 'deny' | 'answer' | 'decline',
     detail?, answer?} */
  function recordText(what) {
    const w = obj(what);
    if (w.kind === 'allow') return 'You allowed once from this phone: ' + str(w.detail);
    if (w.kind === 'deny') return 'You denied from this phone: ' + str(w.detail);
    if (w.kind === 'answer') return 'You answered from this phone' + (str(w.answer) ? ': ' + str(w.answer) : '.');
    return 'You declined to answer from this phone.';
  }

  /* An answer's words for its record: the picked and typed values, in order. */
  function answerWords(fields, content) {
    const parts = [];
    for (const f of Array.isArray(fields) ? fields : []) {
      const v = obj(content)[f.key];
      if (v === undefined) continue;
      const label = (x) => {
        const ch = (f.choices || []).find((c) => c.value === x);
        return ch ? ch.label : String(x);
      };
      parts.push(Array.isArray(v) ? v.map(label).join(', ') : f.type === 'bool' ? f.title + ': ' + label(v) : label(v));
    }
    const s = parts.join(', ');
    return s.length > 160 ? s.slice(0, 159) + '…' : s;
  }

  /* "Subagents · 3 · 1 working" and the shortcut under the title ("1 subagent working", "3 subagents, done"). */
  function subsWords(helpers) {
    const list = Array.isArray(helpers) ? helpers : [];
    const working = list.filter((h) => helperWord(h.state) === 'working' || helperWord(h.state) === 'needs you').length;
    return {
      card: 'Subagents · ' + list.length + (working ? ' · ' + working + ' working' : ' · all done'),
      short: working
        ? working + (working === 1 ? ' subagent' : ' subagents') + ' working'
        : list.length + (list.length === 1 ? ' subagent, done' : ' subagents, done'),
    };
  }

  // ---- part 2: new chat, the card menu, themes, a chat's artifacts (owner, phone prototypes round 4) ----
  /* The card menu's items for one home card ({kind, chat}), in order: View artifacts; Mark as read / Mark as unread (running chats
     only, swapping with the chat's state); Mark handled (only on your turn); Rename, Archive, Delete (every paired phone). Nothing
     else (owner round 4 decision 2). */
  function menuItems(item) {
    const it = obj(item);
    const c = obj(it.chat);
    const live = it.kind === 'live';
    const out = ['arts'];
    if (live) out.push(c.unread ? 'read' : 'unread');
    if (live && c.yourTurn && !(c.needs > 0) && c.state !== 'working') out.push('handled');
    out.push('rename', 'archive', 'delete');
    return out;
  }
  /* Archive of a running chat: the PC's two choices; ending its session needs Send (owner decision B). [] = archive at once. */
  function archiveChoices(running, can) {
    if (!running) return [];
    return obj(can).send ? ['keep', 'end'] : ['keep'];
  }
  /* The Delete confirmation (what leaves, where to restore it, what is not touched, and for a running chat what ending it does). */
  function deleteText(title, running, pcName, can) {
    const pc = pcName || 'your PC';
    let t =
      'Delete “' + title + '”? It leaves AIB’s chat lists on ' + pc + ' and goes to Recently deleted there, where you can restore it. ' +
      'The agent’s own saved transcript is not touched.';
    if (running && obj(can).send)
      t +=
        ' It is running: AIB ends its session first, which drops its queued messages and stops its helpers and terminals. ' +
        'If it has its own copy of the project with no changes, that copy is removed.';
    return t;
  }
  /* A running chat this phone may not end (Send off): Delete waits until it stops. */
  function deleteBlocked(running, can) {
    return !!running && !obj(can).send;
  }
  /* One line of the viewer's version menu: "5m ago · Made by the agent · latest". */
  function versionMeta(v, now) {
    const x = obj(v);
    const at = Number(x.at) || 0;
    const when = at ? ago(new Date(at > 1e12 ? at : at * 1000).toISOString(), now) : '';
    const parts = [];
    if (when) parts.push(when === 'now' ? 'now' : when + ' ago');
    if (str(x.by)) parts.push(str(x.by));
    if (x.latest) parts.push('latest');
    return parts.join(' · ');
  }
  /* New chat can start: a project and an agent that can start a chat are picked, and the message is typed. */
  function newChatReady(nc, text) {
    const n = obj(nc);
    const a = (Array.isArray(n.agents) ? n.agents : []).find((x) => x && x.id === n.agent);
    return !!(n.project && a && a.ok && String(text || '').trim());
  }
  /* The first message's own checks before anything starts (the server checks the same). '' = fine. */
  function firstMessageProblem(text) {
    const t = String(text || '');
    if (!t.trim()) return 'Type your first message.';
    if (t.trimStart().startsWith('/')) return 'Messages that start with / are commands. Type them in AIB on your PC.';
    if (t.length > 8000) return 'A message from a phone can be at most 8000 characters.';
    return '';
  }

  const api = {
    isFirefoxAndroid,
    installKind,
    installText,
    menuItems,
    archiveChoices,
    deleteText,
    deleteBlocked,
    versionMeta,
    newChatReady,
    firstMessageProblem,
    rowsFrom,
    stateWords,
    ago,
    projectColor,
    orderHome,
    homeProjects,
    reqOpen,
    recordText,
    answerWords,
    subsWords,
    elapsed,
    liveLine,
    helperWord,
    helperTone,
    checkInput,
    fieldsOf,
    contentFrom,
    approvalButtons,
    abilities,
    actionable,
    savedWords,
    readTarget,
    READ_MS,
    offlineView,
    isIPhone,
    setupSteps,
    openTarget,
    keyBytes,
    bannerFrom,
    BANNER_TURN_MS,
    artifactFrom,
    artifactRef,
    artifactKind,
    RECONNECT_MS,
  };
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
    chatMeta: null, // {project, agent} from the card that opened the chat (its header before the chat loads; a saved chat's always)
    chat: null,
    chatEvents: [],
    open: new Set(), // folds the reader opened
    lastOk: 0,
    offline: false,
    offlineSince: 0, // when AIB stopped answering
    offlineWhy: '', // 'down' (Serve: nothing listens, AIB closed) or 'unreachable' (no answer)
    reconnectMs: RECONNECT_MS, // tests shorten it
    timer: 0,
    push: { key: '', on: false, permission: '', busy: false, error: '' }, // this phone's notifications
    openOnStart: null, // {chat, sheet}: a push or link asked to open this chat
    pairSecret: '', // hex, from the QR's '#p='
    pairing: null,
    scopes: [], // this phone's switches (bootstrap, then every home / chat answer)
    filter: '', // the project id home shows ('' = All projects), remembered on this phone
    filterOpen: false,
    reqOpened: {}, // waiting card key -> open (true) / closed (false), as you tapped it
    land: '', // a notification (or a banner) brought you to this chat: its first waiting card opens and comes into view
    landKey: '', // that card, once the chat loaded
    scrollTo: '', // 'end' | 'req:<key>' | 'subs': where the next draw puts the chat
    acted: {}, // waiting card key -> {kind, detail?, answer?}: what you did from this phone (its one-line record)
    subsOpen: false, // the Subagents card is open
    subOpen: new Set(), // subagents whose line is open
    qopen: false, // the waiting-to-send list is open
    answers: {}, // question key -> {field: value}
    draft: '', // the composer's text
    sending: false,
    actError: '', // the last refused or failed action, shown on the card it came from or above the composer
    actKey: '', // the waiting card the error belongs to ('' = the composer)
    editing: null, // {messageId, leaseId, text, renewed}
    artifacts: '', // the phone's artifact origin (https://<name>:8443), '' while it is not set up: artifacts open on the PC
    viewer: null, // {id, version, title, kind, state: 'loading' | 'open' | 'pc' | 'error', view?, url?, why?} while one is open
    savedKey: '', // the chat that is not running shown now (provider:sessionId)
    saved: null, // its saved messages (GET /api/remote/saved), or {gone: true}
    continuing: false, // Continue this chat was tapped and the PC has not answered yet
    readSent: { id: '', seq: 0, at: 0 }, // the read position last sent to the PC
    banner: null, // {chat, kind, title, text, at}: news about another chat while this phone is in hand (bannerFrom)
    toast: '', // a short confirmation ("Allowed once"), for TOAST_MS
    menu: null, // the sheet open over the page: {kind: 'card', item, step, name, error} or {kind: 'phone', step}
    nc: null, // New chat: {project, agent, model, mode, projects, agents, lists, error, starting}
    ncText: '', // New chat's first message
    newJob: null, // the chat this phone just started: {id, text, cmid, state, error, note}
    arts: null, // a chat's Artifacts page: {key, id, title, agent, from, list, error}
    artsBack: null, // where its Back goes (a chat), or null (home)
    artCount: {}, // chat key -> how many artifacts (read when a chat opens or its page loads; never on home polls)
    pcTheme: '', // the PC's theme (bootstrap, home): the phone follows it unless it picked its own
    pcSymbols: false,
    install: { event: null, installed: false, used: false }, // beforeinstallprompt kept for our Install AIB button; appinstalled
  };
  const TOAST_MS = 2200;
  const FILTER_KEY = 'aib-phone-filter';
  try {
    S.filter = String(root.localStorage.getItem(FILTER_KEY) || '').slice(0, 40);
  } catch {
    /* storage blocked: All projects */
  }

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
    if (S.banner && S.banner.kind === 'turn' && Date.now() - S.banner.at >= BANNER_TURN_MS) {
      S.banner = null;
      draw();
    }
    try {
      if (S.screen === 'chat') await loadChat(false);
      else if (S.screen === 'saved') await loadSaved();
      else if (S.screen === 'home' || (S.offline && S.device)) await loadHome();
      else return;
      if (S.offline) {
        S.offline = false;
        draw();
        toast('Back online');
      }
      S.lastOk = Date.now();
    } catch (error) {
      if (!(error instanceof Offline)) throw error;
      goneOffline(error.message);
    }
    schedule(S.screen === 'chat' ? CHAT_MS : HOME_MS);
    markRead();
  }

  /* The chat on screen is read up to its newest event: tell the PC (its unread dot clears). Needs See chats. */
  function markRead() {
    if (S.screen !== 'chat' || !S.chat || S.offline || !S.scopes.includes('phone.read')) return;
    const d = doc.documentElement;
    const view = {
      visible: doc.visibilityState !== 'hidden',
      atEnd: root.innerHeight + root.scrollY >= Math.max(d.scrollHeight, doc.body ? doc.body.scrollHeight : 0) - 120,
    };
    const sent = S.readSent.id === S.chatId ? S.readSent : { id: S.chatId, seq: 0, at: 0 };
    const seq = readTarget(S.chat, view, sent, Date.now());
    if (!seq) return;
    S.readSent = { id: S.chatId, seq, at: Date.now() };
    call('POST', '/api/remote/read', { id: S.chatId, seq }).catch(() => {});
  }

  /* A chat that is not running: its saved messages (read only). It was started again (here or on the PC): open the live chat. */
  async function loadSaved() {
    const key = S.savedKey;
    const r = await call('GET', '/api/remote/saved?key=' + encodeURIComponent(key) + '&tail=' + TAIL);
    if (r.status === 401) return removed();
    if (takeNotices(r.data)) draw();
    if (key !== S.savedKey || S.screen !== 'saved') return;
    if (r.status === 404) {
      S.saved = { gone: true, title: S.saved ? S.saved.title : '' };
      draw();
      return;
    }
    if (r.status !== 200) throw new Offline('refused');
    const sig = (x, scopes) => JSON.stringify([x && x.events && x.events.length, x && x.lastActive, x && x.title, scopes]);
    const before = sig(S.saved, S.scopes);
    if (Array.isArray(r.data.scopes)) S.scopes = r.data.scopes;
    if (r.data.live) return openChat(r.data.live, (S.saved && S.saved.title) || S.chatTitle);
    const changed = before !== sig(r.data, S.scopes);
    if (!S.saved || S.saved.gone) S.scrollTo = 'end';
    S.saved = r.data;
    if (changed) draw();
  }

  /* AIB stopped answering (or still does not): "Reconnecting…" first, then closed / can't reach (offlineView). */
  function goneOffline(why) {
    if (!S.offline) {
      S.offline = true;
      S.offlineSince = Date.now();
    }
    S.offlineWhy = why === 'down' ? 'down' : why === 'unreachable' ? 'unreachable' : S.offlineWhy || 'down';
    if (offlineView(S.offlineSince, Date.now(), S.offlineWhy, S.pcName, S.reconnectMs).kind !== S.offlineShown) draw();
  }

  /* News the PC held back because this phone is in hand (attention/presence.ts): inside a chat, a banner for another chat. On the
     chat list nothing (each card's state already says it). */
  const inChat = () => S.screen === 'chat' || S.screen === 'saved';
  function takeNotices(data) {
    if (!inChat()) {
      if (!S.banner) return false;
      S.banner = null;
      return true;
    }
    const next = bannerFrom(data && data.notices, S.screen === 'chat' ? S.chatId : '', S.banner);
    if (next === S.banner) return false;
    S.banner = next ? { ...next, at: Date.now() } : null;
    if (S.banner && S.banner.kind === 'turn') {
      const b = S.banner;
      setTimeout(() => {
        if (S.banner === b) {
          S.banner = null;
          draw();
        }
      }, BANNER_TURN_MS);
    }
    return true;
  }

  /* The banner tapped: that chat opens (at its waiting card, open, for Needs you). */
  function openBanner() {
    const b = S.banner;
    if (!b) return;
    S.banner = null;
    openChat(b.chat, b.title, b.kind === 'needs');
  }

  function bannerEl() {
    const b = S.banner;
    const box = el('div', 'ph-banner ' + (b.kind === 'needs' ? 'need' : 'turn'));
    box.setAttribute('role', 'status');
    box.append(el('span', 'ph-dot ' + (b.kind === 'needs' ? 'need' : 'turn')));
    const open = button('ph-banner-open', '', openBanner);
    open.append(el('strong', '', b.text), el('span', '', b.title));
    const close = button('ph-banner-close', '×', () => {
      S.banner = null;
      draw();
    });
    close.setAttribute('aria-label', 'Close');
    box.append(open, close);
    return box;
  }

  /* A short confirmation at the bottom of the screen ("Allowed once", "Back online"). Outside #app: a poll's draw never takes it. */
  let toastEl = null;
  let toastTimer = 0;
  function toast(text, undo) {
    S.toast = text;
    if (!toastEl) {
      toastEl = el('div', 'ph-toast');
      toastEl.id = 'phToast';
      toastEl.setAttribute('role', 'status');
      doc.body.append(toastEl);
    }
    toastEl.replaceChildren(el('span', '', text));
    if (undo) {
      // Archive and Delete: Undo brings the chat back (unarchive / restore), for a little longer than a plain toast
      const b = button('ph-toast-undo', 'Undo', () => {
        toastEl.hidden = true;
        undoOp(undo);
      });
      b.id = 'phUndo';
      toastEl.append(b);
    }
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      S.toast = '';
      toastEl.hidden = true;
    }, undo ? TOAST_MS * 3 : TOAST_MS);
  }

  /* The page is hidden (another app, the screen off): tell the PC this phone is no longer in hand (best effort). */
  function left() {
    if (!S.token || !S.device) return;
    try {
      root
        .fetch('/api/remote/left', {
          method: 'POST',
          keepalive: true,
          headers: { 'X-AIB-Device': S.token },
          credentials: 'same-origin',
          cache: 'no-store',
        })
        .catch(() => {});
    } catch {
      /* the PC finds out when the polls stop */
    }
  }

  async function loadHome() {
    const r = await call('GET', '/api/remote/home' + (S.homeRev ? '?rev=' + encodeURIComponent(S.homeRev) : ''));
    if (r.status === 401) return removed();
    if (r.status === 304) return;
    if (takeNotices(r.data) && S.screen !== 'home') draw();
    if (r.status !== 200) throw new Offline('refused');
    S.home = r.data;
    S.homeRev = r.data.revision || '';
    takeTheme(r.data);
    if (Array.isArray(r.data.scopes)) S.scopes = r.data.scopes;
    if (r.data.pcName) S.pcName = r.data.pcName;
    if (S.screen === 'home') draw();
  }

  async function loadChat(fresh) {
    const after = !fresh && S.chat ? S.chat.cursor : 0;
    const r = await call('GET', '/api/remote/chat?id=' + encodeURIComponent(S.chatId) + '&tail=' + TAIL + (after ? '&after=' + after : ''));
    if (r.status === 401) return removed();
    const noticed = takeNotices(r.data);
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
    const sig = (x) =>
      JSON.stringify([x.state, x.needs, x.busy, x.steerable, x.ready, x.waiting, x.queue, x.unknown, x.scopes, x.helpers, x.project]);
    const first = !S.chat || !after;
    const changed = first || c.events.length || sig(c) !== sig(S.chat);
    S.chat = { ...c, truncated: after ? S.chat.truncated : c.truncated };
    if (Array.isArray(c.scopes)) S.scopes = c.scopes;
    const keys = new Set((c.waiting || []).map((w) => w.key || 'sign-in'));
    // A record of what you did stays once the request is gone; a card you opened or closed that is gone is forgotten.
    for (const k of Object.keys(S.reqOpened)) if (!keys.has(k)) delete S.reqOpened[k];
    if (S.actKey && !keys.has(S.actKey)) S.actKey = '';
    if (S.land) {
      // a notification (or the banner) brought you here: its first waiting card opens and comes into view
      S.land = '';
      const can = abilities(S.scopes);
      const w = (c.waiting || []).find((x) => actionable(x, can)) || (c.waiting || [])[0];
      if (w) {
        S.landKey = w.key || 'sign-in';
        S.scrollTo = 'req:' + S.landKey;
      }
    }
    if (first && !S.scrollTo) S.scrollTo = 'end';
    if (S.editing && !((c.queue && c.queue.items) || []).some((i) => i.id === S.editing.messageId)) S.editing = null;
    if (S.editing && Date.now() - S.editing.renewed > 60000) renewEdit();
    if (first && c.savedKey) countArts(c.savedKey, c.id);
    if (S.newJob && S.newJob.id === S.chatId && S.newJob.state === 'opening') checkNewJob();
    if (S.screen === 'chat' && (changed || noticed)) draw();
  }

  async function removed() {
    S.token = '';
    S.device = null;
    await stored('device', null);
    S.screen = 'removed';
    draw();
  }


  // ---- part 2 screens: the card menu, the phone's own menu (Theme), New chat, a chat's Artifacts page ----
  const THEME = root.AibThemes || null;
  /* The phone's theme now: the PC's (S.pcTheme) in the phone's light or dark, unless this phone picked one (localStorage). */
  function paintTheme() {
    const html = doc.documentElement;
    if (S.pcTheme) html.setAttribute('data-theme-pref', S.pcTheme);
    html.setAttribute('data-status-glyphs', S.pcSymbols ? 'on' : 'off');
    if (THEME && THEME.paintPhone) THEME.paintPhone(S.pcTheme || html.getAttribute('data-theme-pref') || 'teal-dark');
  }
  function takeTheme(data) {
    const d = obj(data);
    if (typeof d.pcTheme !== 'string') return;
    const symbols = d.pcSymbols === true;
    if (d.pcTheme === S.pcTheme && symbols === S.pcSymbols) return;
    S.pcTheme = d.pcTheme;
    S.pcSymbols = symbols;
    paintTheme();
  }
  function themePick() {
    return THEME && THEME.phonePick ? THEME.phonePick() : 'follow';
  }
  function setThemePick(v) {
    try {
      if (v === 'follow') root.localStorage.removeItem('aib-phone-theme');
      else root.localStorage.setItem('aib-phone-theme', v);
    } catch {
      /* storage blocked: for this visit only */
    }
    paintTheme();
    S.menu = null;
    drawMenu();
    toast('Theme saved on this phone');
  }
  const themeName = (id) => {
    if (id === 'system') return 'Match system';
    if (id === 'follow') return 'Follow PC';
    const t = THEME && THEME.THEMES.find((x) => x.id === id);
    return t ? t.label : id;
  };

  /* A sheet over the page (outside #app, so polls never redraw it away). */
  let menuEl = null;
  let menuFocus = null;
  function drawMenu() {
    const m = S.menu;
    if (!m) {
      if (menuEl) menuEl.remove();
      menuEl = null;
      if (menuFocus && menuFocus.isConnected) menuFocus.focus({ preventScroll: true });
      menuFocus = null;
      return;
    }
    if (!menuEl) menuFocus = doc.activeElement;
    const layer = el('div', 'ph-layer');
    layer.id = 'phMenu';
    const shade = button('ph-shade', '', closeMenu);
    shade.setAttribute('aria-label', 'Close menu');
    const sheet = el('div', 'ph-menu');
    sheet.setAttribute('role', 'menu');
    sheet.append(el('div', 'ph-grab'));
    if (m.kind === 'phone') phoneMenu(sheet, m);
    else cardMenu(sheet, m);
    layer.append(shade, sheet);
    if (menuEl) menuEl.replaceWith(layer);
    else doc.body.append(layer);
    menuEl = layer;
    const first = sheet.querySelector('input, .ph-mi, .ph-btn');
    if (first && !sheet.contains(doc.activeElement)) first.focus({ preventScroll: true });
  }
  function closeMenu() {
    S.menu = null;
    drawMenu();
  }
  function menuItem(id, icon, label, onClick, extra) {
    const b = button('ph-mi' + (id === 'delete' ? ' danger' : ''), '', onClick);
    b.setAttribute('role', 'menuitem');
    b.dataset.mi = id;
    b.append(el('span', 'ph-mic', icon), el('span', 'ph-mlabel', label));
    if (extra) b.append(el('small', '', extra));
    return b;
  }
  function phoneMenu(sheet, m) {
    sheet.setAttribute('aria-label', 'This phone');
    const pick = themePick();
    if (m.step === 'install') {
      const kind = installKind(installFacts());
      const head = el('div', 'ph-mh');
      head.append(el('b', '', 'Install AIB'), el('span', '', 'On this phone'));
      const p = el('p', 'ph-mtext', installText(kind));
      p.id = 'phInstallText';
      sheet.append(head, p, menuItem('cancel', '', 'Close', closeMenu));
      return;
    }
    if (m.step !== 'theme') {
      const head = el('div', 'ph-mh');
      head.append(el('b', '', 'This phone'), el('span', '', 'Saved on this phone only'));
      sheet.append(head);
      sheet.append(
        menuItem('theme', '◐', 'Theme', () => {
          S.menu = { kind: 'phone', step: 'theme' };
          drawMenu();
        }, themeName(pick) + ' ›'),
      );
      // Install AIB: hidden once it runs installed (or was just installed)
      if (installKind(installFacts()) !== 'installed') sheet.append(menuItem('install', '⤓', 'Install AIB', () => installNow()));
      sheet.append(menuItem('cancel', '', 'Cancel', closeMenu));
      return;
    }
    const now = THEME ? THEME.phoneTheme(S.pcTheme, pick, matchLight()) : '';
    const head = el('div', 'ph-mh');
    head.append(el('b', '', 'Theme on this phone'), el('span', '', 'Now showing: ' + themeName(now)));
    sheet.append(head);
    const row = (v, label, sub) => {
      const b = button('ph-mi', '', () => setThemePick(v));
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', pick === v ? 'true' : 'false');
      b.dataset.theme = v;
      const text = el('span', 'ph-mlabel', label);
      if (sub) text.append(el('span', 'ph-msub', sub));
      b.append(el('span', 'ph-mic', pick === v ? '✓' : ''), text);
      return b;
    };
    sheet.append(
      row('follow', 'Follow PC', 'The PC’s theme (' + themeName(S.pcTheme || 'teal-dark') + '), in this phone’s light or dark setting.'),
      row('system', 'Match system', 'AIB teal, light or dark like this phone.'),
    );
    let group = '';
    for (const t of THEME ? THEME.THEMES : []) {
      if (t.group !== group) {
        group = t.group;
        sheet.append(el('p', 'ph-mgroup', group));
      }
      sheet.append(row(t.id, t.label));
    }
  }
  const matchLight = () => {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches);
    } catch {
      return false;
    }
  };

  /* The card menu of one chat (⋯ or a long press on its card). */
  function openCardMenu(item) {
    if (S.menu || !item) return;
    S.menu = { kind: 'card', item, step: 'list', name: item.title, error: '' };
    drawMenu();
  }
  function cardMenu(sheet, m) {
    const item = m.item;
    const c = obj(item.chat);
    const live = item.kind === 'live';
    const can = abilities(S.scopes);
    sheet.setAttribute('aria-label', item.title);
    const head = el('div', 'ph-mh');
    const w = live ? stateWords(c) : stateWords({ notRunning: true });
    const sub = el('span', '');
    sub.append(projectLine(item.project, [str(item.agent), w.text]));
    head.append(el('b', '', item.title), sub);
    sheet.append(head);
    if (m.error) {
      const err = el('p', 'ph-error', m.error);
      err.setAttribute('role', 'alert');
      sheet.append(err);
    }
    const key = live ? c.key : c.key;
    if (m.step === 'rename') {
      const label = el('label', 'ph-mtext', 'New name');
      label.htmlFor = 'phRename';
      const input = el('input', 'ph-tin');
      input.id = 'phRename';
      input.type = 'text';
      input.maxLength = 200;
      input.value = m.name;
      input.addEventListener('input', () => (m.name = input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          chatOp('rename', item, { name: m.name });
        }
      });
      const row = el('div', 'ph-mbtns two');
      row.append(
        button('ph-btn quiet', 'Cancel', () => {
          m.step = 'list';
          drawMenu();
        }),
        button('ph-btn', 'Save', () => chatOp('rename', item, { name: m.name })),
      );
      sheet.append(label, input, row);
      return;
    }
    if (m.step === 'archive') {
      sheet.append(
        el(
          'p',
          'ph-mtext',
          '“' + item.title + '” is running on ' + S.pcName + '. Archiving moves it out of your lists; it never stops the chat on its own. ' +
            'Find it again under Archived on your PC.',
        ),
      );
      const row = el('div', 'ph-mbtns');
      const keep = button('ph-btn', 'Keep running and archive', () => chatOp('archive', item, { end: false }));
      keep.dataset.how = 'keep';
      row.append(keep);
      if (archiveChoices(true, can).includes('end')) {
        const end = button('ph-btn quiet', 'End its session and archive', () => chatOp('archive', item, { end: true }));
        end.dataset.how = 'end';
        row.append(end);
      } else
        row.append(
          el('p', 'ph-note', 'Ending its session from this phone needs “Send messages, stop turns and continue chats” (Settings → Remote control on your PC).'),
        );
      row.append(
        button('ph-btn quiet', 'Cancel', () => {
          m.step = 'list';
          drawMenu();
        }),
      );
      sheet.append(row);
      return;
    }
    if (m.step === 'delete') {
      const blocked = deleteBlocked(live, can);
      const p = el('p', 'ph-mtext');
      p.id = 'phDeleteText';
      p.textContent = blocked
        ? '“' + item.title + '” is running. Deleting it from this phone ends its session first, which needs “Send messages, stop turns ' +
          'and continue chats” on for this phone (Settings → Remote control on your PC). You can delete it here once it has stopped, or archive it and keep it running.'
        : deleteText(item.title, live, S.pcName, can);
      sheet.append(p);
      const row = el('div', 'ph-mbtns');
      if (!blocked) {
        const del = button('ph-btn danger', 'Delete', () => chatOp('delete', item, {}));
        del.id = 'phDeleteGo';
        row.append(del);
      }
      row.append(
        button('ph-btn quiet', blocked ? 'Back' : 'Cancel', () => {
          m.step = 'list';
          drawMenu();
        }),
      );
      sheet.append(row);
      return;
    }
    for (const id of menuItems(item)) {
      if (id === 'arts') {
        const n = S.artCount[key];
        sheet.append(menuItem('arts', '▤', 'View artifacts', () => openArts(item, 'home'), n == null ? '' : String(n)));
      } else if (id === 'read') sheet.append(menuItem('read', '○', 'Mark as read', () => chatOp('mark', item, { read: true })));
      else if (id === 'unread') sheet.append(menuItem('unread', '●', 'Mark as unread', () => chatOp('mark', item, { read: false })));
      else if (id === 'handled') sheet.append(menuItem('handled', '✓', 'Mark handled', () => chatOp('handled', item, {})));
      else if (id === 'rename')
        sheet.append(
          menuItem('rename', '✎', 'Rename', () => {
            m.step = 'rename';
            m.name = item.title;
            drawMenu();
          }),
        );
      else if (id === 'archive')
        sheet.append(
          menuItem('archive', '⇩', 'Archive', () => {
            if (live) {
              m.step = 'archive';
              drawMenu();
            } else chatOp('archive', item, { end: false });
          }),
        );
      else if (id === 'delete')
        sheet.append(
          menuItem('delete', '🗑', 'Delete…', () => {
            m.step = 'delete';
            drawMenu();
          }),
        );
    }
    sheet.append(menuItem('cancel', '', 'Cancel', closeMenu));
  }

  /* One card menu action on the PC. op: rename | mark | handled | archive | delete. */
  async function chatOp(op, item, extra) {
    const m = S.menu;
    if (!m || m.busy) return;
    const key = item.chat.key;
    const path = op === 'rename' ? 'rename' : op === 'mark' ? 'mark' : 'chat-op';
    const body = op === 'rename' || op === 'mark' ? { key, ...extra } : { key, op, ...extra };
    m.busy = true;
    m.error = '';
    let r = null;
    try {
      r = await call('POST', '/api/remote/' + path, body);
    } catch {
      r = null;
    }
    m.busy = false;
    if (r && r.status === 401) {
      closeMenu();
      return removed();
    }
    if (!r || r.status !== 200) {
      m.error = r ? r.data.error || 'That did not work. Try again.' : "Can't reach " + S.pcName + '. Nothing was changed.';
      if (S.menu === m) drawMenu();
      return;
    }
    closeMenu();
    S.homeRev = '';
    if (op === 'rename') toast('Renamed');
    else if (op === 'mark') toast(extra.read ? 'Marked as read' : 'Marked as unread');
    else if (op === 'handled') toast('Marked handled');
    else if (op === 'archive') toast('Archived “' + item.title + '”', { key, op: 'unarchive' });
    else if (op === 'delete') toast('Deleted “' + item.title + '”', { key, op: 'restore' });
    if ((op === 'archive' || op === 'delete') && S.screen !== 'home') goHome();
    else {
      clearTimeout(S.timer);
      tick();
    }
  }
  /* Undo on the toast after Archive or Delete: unarchive / restore (no restart). */
  async function undoOp(u) {
    let r = null;
    try {
      r = await call('POST', '/api/remote/chat-op', { key: u.key, op: u.op });
    } catch {
      r = null;
    }
    if (!r || r.status !== 200) toast(r ? r.data.error || 'That did not work.' : "Can't reach " + S.pcName + '.');
    else toast(u.op === 'restore' ? 'Restored' : 'Back in your chats');
    S.homeRev = '';
    clearTimeout(S.timer);
    tick();
  }

  /* Long press (and right-click on a PC browser) on a card opens its menu; the press does not also open the chat. */
  let pressTimer = 0;
  let pressed = false;
  app.addEventListener('pointerdown', (e) => {
    pressed = false;
    const card = e.target && e.target.closest ? e.target.closest('[data-menu-key]') : null;
    if (!card) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressed = true;
      openCardMenu(cardItems.get(card.dataset.menuKey));
    }, 550);
  });
  for (const n of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'])
    app.addEventListener(n, (e) => {
      if (n === 'pointermove' && Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0) < 6) return;
      clearTimeout(pressTimer);
    });
  app.addEventListener(
    'click',
    (e) => {
      if (!pressed) return;
      pressed = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  app.addEventListener('contextmenu', (e) => {
    const card = e.target && e.target.closest ? e.target.closest('[data-menu-key]') : null;
    if (!card) return;
    e.preventDefault();
    clearTimeout(pressTimer);
    openCardMenu(cardItems.get(card.dataset.menuKey));
  });
  /* menu key -> the home item it belongs to (filled as home draws its cards). */
  const cardItems = new Map();

  // ---- New chat ----
  function openNew() {
    if (!abilities(S.scopes).start) return;
    S.screen = 'new';
    S.nc = { project: '', agent: '', model: '', mode: '', projects: null, agents: [], lists: null, error: '', starting: false, loadError: '' };
    S.ncText = S.ncText || '';
    draw();
    root.scrollTo(0, 0);
    clearTimeout(S.timer);
    loadNewOptions();
  }
  async function loadNewOptions() {
    let r = null;
    try {
      r = await call('GET', '/api/remote/new/options');
    } catch {
      r = null;
    }
    const nc = S.nc;
    if (!nc || S.screen !== 'new') return;
    if (r && r.status === 401) return removed();
    if (!r || r.status !== 200) {
      nc.loadError = r ? r.data.error || 'The projects could not be read.' : "Can't reach " + S.pcName + '.';
      draw();
      return;
    }
    nc.projects = Array.isArray(r.data.projects) ? r.data.projects : [];
    nc.agents = Array.isArray(r.data.agents) ? r.data.agents : [];
    draw();
  }
  function pickProject(p) {
    const nc = S.nc;
    nc.project = p.id;
    const def = nc.agents.find((a) => a.id === p.agent && a.ok) || nc.agents.find((a) => a.ok);
    nc.agent = def ? def.id : '';
    nc.error = '';
    loadLists();
    draw();
  }
  function pickAgent(a) {
    if (!a.ok) return;
    S.nc.agent = a.id;
    S.nc.error = '';
    loadLists();
    draw();
  }
  let listsTimer = 0;
  async function loadLists(again) {
    const nc = S.nc;
    clearTimeout(listsTimer);
    if (!nc || !nc.project || !nc.agent) return;
    const want = nc.project + '|' + nc.agent;
    if (!again) {
      nc.lists = null;
      nc.model = '';
      nc.mode = '';
    }
    let r = null;
    try {
      r = await call('GET', '/api/remote/new/options?project=' + encodeURIComponent(nc.project) + '&agent=' + encodeURIComponent(nc.agent));
    } catch {
      r = null;
    }
    if (S.nc !== nc || S.screen !== 'new' || nc.project + '|' + nc.agent !== want) return;
    if (!r || r.status !== 200) {
      nc.lists = { model: null, mode: null, loading: false };
      draw();
      return;
    }
    const first = !nc.lists || (!nc.lists.model && !nc.lists.mode);
    nc.lists = { model: r.data.model || null, mode: r.data.mode || null, loading: !!r.data.loading };
    if (first) {
      nc.model = nc.lists.model ? nc.lists.model.default || '' : '';
      nc.mode = nc.lists.mode ? nc.lists.mode.default || '' : '';
    }
    draw();
    if (nc.lists.loading && !nc.lists.model && !nc.lists.mode && (nc.tries = (nc.tries || 0) + 1) < 20)
      listsTimer = setTimeout(() => loadLists(true), 2500);
  }
  function pills(kind, list, picked, onPick) {
    const box = el('div', 'ph-pills');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', kind === 'model' ? 'Model' : 'Mode');
    for (const c of list.choices) {
      const b = button('ph-pill', '', () => onPick(c.value));
      b.dataset[kind] = c.value;
      b.setAttribute('aria-pressed', picked === c.value ? 'true' : 'false');
      b.append(doc.createTextNode(c.name));
      if (c.value === list.default) b.append(el('small', '', 'default'));
      box.append(b);
    }
    return box;
  }
  function drawNew() {
    const nc = S.nc || {};
    const h = header('New chat', { back: goHome, backLabel: 'Chats', sub: 'Runs on ' + S.pcName, chip: liveChip() });
    const parts = [h];
    if (S.offline) parts.push(offlineBox());
    const body = el('main', 'ph-new' + (S.offline ? ' ph-stale' : ''));
    body.append(el('p', 'ph-ncs', '1 · Project'));
    const project = (nc.projects || []).find((p) => p.id === nc.project);
    if (nc.loadError) body.append(el('p', 'ph-error', nc.loadError));
    else if (!nc.projects) body.append(el('p', 'ph-empty', 'Loading your projects…'));
    else if (!project) {
      if (!nc.projects.length) body.append(el('p', 'ph-empty', 'No projects in AIB on ' + S.pcName + ' yet. Add one there first.'));
      for (const p of nc.projects) {
        const b = button('ph-pick', '', () => pickProject(p));
        b.dataset.project = p.id;
        const dot = el('span', 'ph-pdot big');
        dot.style.background = projectColor(p.color);
        const t = el('span', 'ph-pt');
        t.append(el('b', '', p.name), el('span', '', p.chats + (p.chats === 1 ? ' chat' : ' chats')));
        b.append(dot, t);
        body.append(b);
      }
      body.append(el('p', 'ph-note', 'New projects (a new folder) are added in AIB on your PC.'));
    } else {
      const chosen = el('div', 'ph-chosen');
      const dot = el('span', 'ph-pdot big');
      dot.style.background = projectColor(project.color);
      const t = el('span', 'ph-pt');
      t.append(el('b', '', project.name), el('span', '', project.chats + (project.chats === 1 ? ' chat' : ' chats')));
      const change = button('ph-btn sm quiet', 'Change', () => {
        nc.project = '';
        nc.agent = '';
        nc.lists = null;
        draw();
      });
      change.id = 'phNcChange';
      chosen.append(dot, t, change);
      body.append(chosen, el('p', 'ph-ncs', '2 · Agent'));
      for (const a of nc.agents) {
        const b = button('ph-pick', '', () => pickAgent(a));
        b.dataset.agent = a.id;
        b.disabled = !a.ok;
        b.setAttribute('aria-pressed', nc.agent === a.id ? 'true' : 'false');
        const tt = el('span', 'ph-pt');
        const name = el('b', '', a.name);
        if (a.beta) name.append(el('span', 'ph-tag', 'Beta'));
        tt.append(name, el('span', '', !a.ok ? a.why || a.reason : a.id === project.agent ? 'Default for ' + project.name : ''));
        b.append(tt);
        if (nc.agent === a.id) b.append(el('span', 'ph-mark', '✓ Picked'));
        body.append(b);
      }
      const agent = nc.agents.find((a) => a.id === nc.agent);
      if (agent && agent.ok) {
        const lists = nc.lists;
        body.append(el('p', 'ph-ncs', '3 · Model'));
        if (!lists) body.append(el('p', 'ph-note', 'Reading ' + agent.name + '’s models…'));
        else if (lists.model) body.append(pills('model', lists.model, nc.model, (v) => ((nc.model = v), draw())));
        else body.append(el('p', 'ph-note', lists.loading ? 'Asking ' + agent.name + ' for its models…' : agent.name + ' uses its own model.'));
        body.append(el('p', 'ph-ncs', '4 · Mode'));
        if (lists && lists.mode) body.append(pills('mode', lists.mode, nc.mode, (v) => ((nc.mode = v), draw())));
        else if (lists) body.append(el('p', 'ph-note', lists.loading ? 'Asking ' + agent.name + ' for its modes…' : agent.name + ' uses its own mode.'));
        const defs = el('div', 'ph-defs');
        defs.append(
          doc.createTextNode('“default” marks your defaults for '),
          el('b', '', agent.name),
          doc.createTextNode(' in '),
          el('b', '', project.name),
          doc.createTextNode('. A change here is for this chat only; your defaults stay as they are.'),
        );
        body.append(defs);
      }
    }
    parts.push(body);
    const ready = !!(project && nc.agents.some((a) => a.id === nc.agent && a.ok));
    const bottom = el('form', 'ph-bottom ph-newbottom');
    bottom.id = 'phNewBottom';
    bottom.noValidate = true;
    bottom.append(el('p', 'ph-ncs', '5 · First message'));
    const ta = el('textarea', 'ph-input');
    ta.id = 'phNewPrompt';
    ta.rows = 2;
    ta.disabled = !ready || nc.starting;
    ta.placeholder = ready ? 'What should ' + (nc.agents.find((a) => a.id === nc.agent) || {}).name + ' do?' : 'Pick a project and an agent first';
    ta.setAttribute('aria-label', 'First message');
    ta.value = S.ncText || '';
    ta.addEventListener('input', () => {
      S.ncText = ta.value;
      const go = doc.getElementById('phNewStart');
      if (go) go.disabled = !newChatReady(S.nc, S.ncText) || S.nc.starting || S.offline;
    });
    bottom.append(ta);
    if (nc.error) {
      const err = el('p', 'ph-error', nc.error);
      err.id = 'phNewError';
      err.setAttribute('role', 'alert');
      bottom.append(err);
    }
    const go = el('button', 'ph-btn', nc.starting ? 'Starting…' : 'Start chat');
    go.type = 'submit';
    go.id = 'phNewStart';
    go.disabled = !newChatReady(nc, S.ncText) || nc.starting || S.offline;
    bottom.append(go);
    bottom.addEventListener('submit', (e) => {
      e.preventDefault();
      startNew();
    });
    parts.push(bottom);
    return parts;
  }
  async function startNew() {
    const nc = S.nc;
    if (!nc || nc.starting) return;
    const text = S.ncText || '';
    const problem = firstMessageProblem(text);
    if (problem) {
      nc.error = problem;
      return draw();
    }
    if (!newChatReady(nc, text)) return;
    nc.starting = true;
    nc.error = '';
    draw();
    const cmid = newMessageId();
    const body = { project: nc.project, agent: nc.agent, text, clientMessageId: cmid };
    if (nc.model) body.model = nc.model;
    if (nc.mode) body.mode = nc.mode;
    let r = null;
    try {
      r = await call('POST', '/api/remote/new', body);
    } catch {
      r = null;
    }
    if (S.nc !== nc) return;
    nc.starting = false;
    if (r && r.status === 401) return removed();
    if (!r || r.status !== 200 || !r.data.id) {
      nc.error = r ? r.data.error || 'That did not work. Try again.' : "Can't reach " + S.pcName + '. Nothing was started.';
      return draw();
    }
    const project = nc.projects.find((p) => p.id === nc.project) || {};
    const agent = nc.agents.find((a) => a.id === nc.agent) || {};
    const name = (list, v) => ((list && list.choices.find((c) => c.value === v)) || {}).name || '';
    const picks = [agent.name, name(nc.lists && nc.lists.model, nc.model), name(nc.lists && nc.lists.mode, nc.mode)].filter(Boolean);
    S.ncText = '';
    S.nc = null;
    const id = r.data.id;
    openChat(id, text.length > 60 ? text.slice(0, 58) + '…' : text, false, { project, agent: agent.name });
    S.newJob = {
      id,
      text,
      cmid,
      state: 'opening',
      error: '',
      note: 'Started from this phone in ' + (project.name || 'a project') + ' with ' + picks.join(' · ') + '.',
    };
    draw();
  }
  /* The chat this phone just started: its first message's fate (GET /api/remote/new) while it opens. */
  async function checkNewJob() {
    const j = S.newJob;
    if (!j || j.id !== S.chatId || j.state !== 'opening') return;
    let r = null;
    try {
      r = await call('GET', '/api/remote/new?id=' + encodeURIComponent(j.id));
    } catch {
      return;
    }
    if (S.newJob !== j) return;
    if (r.status === 404) {
      j.state = 'gone';
      return;
    }
    if (r.status !== 200) return;
    const st = str(r.data.state);
    if (st === 'opening') return;
    j.state = st;
    if (r.data.warning) toast(str(r.data.warning).slice(0, 160));
    if (st === 'sent') {
      j.error = '';
      S.scrollTo = 'end';
    } else {
      j.error = str(r.data.error) || 'Your first message was not sent.';
      S.draft = j.text;
      S.actError = j.error;
      S.actKey = '';
    }
    draw();
  }

  // ---- a chat's Artifacts page ----
  function openArts(item, from) {
    closeMenu();
    const c = obj(item.chat);
    S.arts = { key: c.key, id: item.kind === 'live' ? c.id : '', title: item.title, agent: item.agent, from, list: null, error: '' };
    S.artsBack = from === 'chat' ? { id: S.chatId, title: S.chatTitle, meta: S.chatMeta } : null;
    S.screen = 'arts';
    draw();
    root.scrollTo(0, 0);
    clearTimeout(S.timer);
    loadArts();
  }
  async function loadArts() {
    const a = S.arts;
    if (!a) return;
    let r = null;
    try {
      r = await call('GET', '/api/remote/artifacts?key=' + encodeURIComponent(a.key) + (a.id ? '&id=' + encodeURIComponent(a.id) : ''));
    } catch {
      r = null;
    }
    if (S.arts !== a) return;
    if (r && r.status === 401) return removed();
    if (!r || r.status !== 200) {
      a.error = r ? r.data.error || 'The artifacts could not be read.' : "Can't reach " + S.pcName + '.';
      a.list = a.list || [];
    } else {
      a.list = Array.isArray(r.data.artifacts) ? r.data.artifacts : [];
      a.error = '';
      S.artCount[a.key] = a.list.length;
    }
    draw();
  }
  /* The ▤ count in a chat's header: read once when the chat opens (never on home polls). */
  async function countArts(key, id) {
    if (!key) return;
    let r = null;
    try {
      r = await call('GET', '/api/remote/artifacts?key=' + encodeURIComponent(key) + (id ? '&id=' + encodeURIComponent(id) : ''));
    } catch {
      return;
    }
    if (r.status !== 200 || !Array.isArray(r.data.artifacts)) return;
    const before = S.artCount[key];
    S.artCount[key] = r.data.artifacts.length;
    if (before !== S.artCount[key] && S.screen === 'chat') draw();
  }
  function artsBack() {
    const b = S.artsBack;
    S.arts = null;
    S.artsBack = null;
    if (b && b.id) return openChat(b.id, b.title, false, b.meta);
    goHome();
  }
  function drawArts() {
    const a = S.arts || {};
    const list = a.list || [];
    const h = header('Artifacts' + (a.list ? ' · ' + list.length : ''), {
      back: artsBack,
      backLabel: a.from === 'chat' ? 'Chat' : 'Chats',
      sub: a.title || '',
      chip: liveChip(),
    });
    const parts = [h];
    if (S.offline) parts.push(offlineBox());
    const body = el('main', 'ph-arts' + (S.offline ? ' ph-stale' : ''));
    if (a.error) body.append(el('p', 'ph-error', a.error));
    if (!a.list) body.append(el('p', 'ph-empty', 'Loading…'));
    else if (!list.length && !a.error) {
      const empty = el('div', 'ph-empty-box');
      empty.id = 'phArtsEmpty';
      empty.append(
        el('b', '', 'No artifacts yet'),
        el('span', '', 'When ' + (a.agent || 'the agent') + ' makes a page, picture, table or document in this chat, it shows up here.'),
      );
      body.append(empty);
    } else {
      const now = Date.now();
      for (const x of list) {
        const here = x.kind !== 'pdf' && !!S.artifacts;
        const card = button('ph-art', '', () => openArtifact(x.id, 0, x));
        card.dataset.artifact = x.id;
        const text = el('span', 'ph-art-text');
        const when = x.updatedAt ? ago(new Date(x.updatedAt * 1000).toISOString(), now) : '';
        text.append(
          el('b', 'ph-art-title', x.title),
          el(
            'span',
            'ph-art-kind',
            [
              artifactKind(x.kind),
              'v' + x.version,
              x.versions > 1 ? x.versions + ' versions' : '',
              when ? (when === 'now' ? 'now' : when + ' ago') : '',
              x.archived ? 'archived' : '',
              here ? '' : 'open on your PC',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        );
        card.append(el('span', 'ph-art-icon', ART_BADGE[x.kind] || 'FILE'), text);
        body.append(card);
      }
    }
    parts.push(body);
    return parts;
  }

  // ---- screens ----
  /* The header: Back (in a chat), the title with a line under it, and a chip on the right. opts: {back, sub (text or node), chip:
     [text, tone], extra (a node under the sub line)} */
  function header(title, opts) {
    const o = opts || {};
    const h = el('header', 'ph-head');
    if (o.back) {
      const b = button('ph-back', '', o.back);
      const label = o.backLabel || 'Chats';
      b.append(el('span', 'ph-chev', '‹'), doc.createTextNode(label));
      b.setAttribute('aria-label', label === 'Chats' ? 'Back to all chats' : 'Back to ' + label.toLowerCase());
      b.id = 'phBack';
      h.append(b);
    }
    const tt = el('div', 'ph-tt');
    const h1 = el('h1', '', title);
    tt.append(h1);
    if (o.sub) {
      const sub = el('span', 'ph-sub');
      if (typeof o.sub === 'string') sub.textContent = o.sub;
      else sub.append(o.sub);
      tt.append(sub);
    }
    if (o.extra) tt.append(o.extra);
    h.append(tt);
    for (const t of o.tools || []) if (t) h.append(t);
    if (o.chip) h.append(el('span', 'ph-chip ' + o.chip[1], o.chip[0]));
    for (const t of o.after || []) if (t) h.append(t);
    return h;
  }

  /* The project mark and name, then more words: "▪ Shop web · Claude Code". */
  function projectLine(project, rest) {
    const frag = doc.createDocumentFragment();
    const p = obj(project);
    const dot = el('span', 'ph-pdot');
    dot.style.background = projectColor(p.color);
    dot.setAttribute('aria-hidden', 'true');
    frag.append(dot, el('span', 'ph-pname', str(p.name) || 'No folder'));
    for (const r of rest) if (r) frag.append(doc.createTextNode(' · '), typeof r === 'string' ? doc.createTextNode(r) : r);
    return frag;
  }

  const liveChip = () => (S.offline ? ['Offline', 'off'] : ['Live', 'live']);

  function offlineBox() {
    const v = offlineView(S.offlineSince, Date.now(), S.offlineWhy, S.pcName, S.reconnectMs);
    S.offlineShown = v.kind; // what the page says now (goneOffline redraws when it changes)
    const box = el('section', 'ph-offline ' + v.kind);
    box.dataset.offline = v.kind;
    box.setAttribute('role', v.kind === 'reconnecting' ? 'status' : 'alert');
    box.append(el('h2', '', v.title));
    for (const line of v.lines) box.append(el('p', '', line));
    if (S.lastOk && v.kind !== 'reconnecting') {
      const t = new Date(S.lastOk);
      const hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      box.append(el('p', 'ph-note', 'Last update ' + hhmm + '. What you see below is from then. It does not update.'));
    }
    if (v.checks.length) {
      box.append(el('p', '', 'Check that:'));
      const ul = el('ul', 'ph-steps');
      for (const c of v.checks) ul.append(el('li', '', c));
      box.append(ul);
    }
    if (v.retry)
      box.append(
        button('ph-btn', 'Try again', () => {
          clearTimeout(S.timer);
          S.offlineSince = Date.now(); // trying again: "Reconnecting…" first
          draw();
          retry();
        }),
      );
    return box;
  }

  /* Try again: the start screen when the page opened offline (no bootstrap yet), else the normal poll. */
  function retry() {
    if (!S.booted) return start();
    tick();
  }

  /* One chat card (a live chat, or one that is not running: lighter, "Not running"). */
  function chatCard(item, now) {
    const c = item.chat;
    const live = item.kind === 'live';
    const w = live ? stateWords(c, now) : stateWords({ notRunning: true });
    const card = button('ph-card' + (live ? '' : ' nr') + (w.tone === 'need' ? ' need' : ''), '', () =>
      live ? openChat(c.id, c.title, false, item) : openSaved(c.key, c.title, item),
    );
    if (live) card.dataset.chat = c.id;
    else card.dataset.saved = c.key;
    const r1 = el('span', 'ph-r1');
    r1.append(el('b', 'ph-title', item.title));
    if (live && c.unread) {
      const dot = el('span', 'ph-unread');
      dot.setAttribute('aria-label', 'Unread');
      dot.setAttribute('role', 'img');
      r1.append(dot);
    }
    r1.append(el('span', 'ph-time', ago(live ? c.changedAt : c.lastActive, now)));
    const r2 = el('span', 'ph-r2');
    r2.append(projectLine(item.project, [str(item.agent), el('span', 'ph-state ' + w.tone, w.text)]));
    card.append(r1, r2);
    const line = live ? str(c.line) : '';
    if (line) card.append(el('span', 'ph-r3', line));
    // ⋯ (and a long press on the card) opens its menu
    const key = (live ? 'l:' : 's:') + (live ? c.id : c.key);
    const opening = live && (c.state === 'opening' || !/:.+/.test(str(c.key))); // still starting: no menu until it is a chat
    if (!opening) {
      card.dataset.menuKey = key;
      cardItems.set(key, item);
    }
    const wrap = el('div', 'ph-cw');
    const more = button('ph-more-btn', '⋯', () => openCardMenu(item));
    more.disabled = opening;
    more.setAttribute('aria-label', 'More for ' + item.title);
    more.setAttribute('aria-haspopup', 'menu');
    more.dataset.menuFor = key;
    wrap.append(card, more);
    return wrap;
  }

  function setFilter(id) {
    S.filter = id || '';
    S.filterOpen = false;
    try {
      if (S.filter) root.localStorage.setItem(FILTER_KEY, S.filter);
      else root.localStorage.removeItem(FILTER_KEY);
    } catch {
      /* storage blocked: kept for this visit only */
    }
    draw();
  }

  function drawHome() {
    const parts = [];
    const home = S.home;
    const all = orderHome(home, '');
    const projects = homeProjects(all);
    // a remembered project that has no chats any more: All projects
    const picked = S.filter && projects.find((p) => p.id === S.filter);
    const list = picked ? all.filter((i) => i.project.id === S.filter) : all;
    const phoneBtn = button('ph-ic', '⋯', () => {
      S.menu = { kind: 'phone', step: 'phone' };
      drawMenu();
    });
    phoneBtn.id = 'phPhoneMenu';
    phoneBtn.setAttribute('aria-label', 'This phone: theme');
    phoneBtn.setAttribute('aria-haspopup', 'menu');
    parts.push(
      header('AIB', {
        sub: S.pcName + (home ? ' · ' + all.length + (all.length === 1 ? ' chat' : ' chats') : ''),
        chip: liveChip(),
        after: [phoneBtn],
      }),
    );
    if (S.offline) parts.push(offlineBox());
    else if (S.device && !pushReady()) {
      const bar = el('div', 'ph-setup-bar');
      bar.append(el('span', '', 'Get a notification when a chat needs you.'));
      const go = button('ph-btn quiet', 'Set up', () => openSetup());
      go.id = 'setupOpen';
      bar.append(go);
      parts.push(bar);
    }
    const body = el('main', 'ph-home' + (S.offline ? ' ph-stale' : ''));
    if (home && all.length) {
      const bar = el('div', 'ph-filter');
      const fb = button('ph-fb', '', () => {
        S.filterOpen = !S.filterOpen;
        draw();
      });
      fb.id = 'phFilter';
      fb.setAttribute('aria-expanded', S.filterOpen ? 'true' : 'false');
      if (picked) {
        const dot = el('span', 'ph-pdot');
        dot.style.background = projectColor(picked.color);
        fb.append(dot);
      }
      fb.append(doc.createTextNode((picked ? picked.name : 'All projects') + ' ▾'));
      bar.append(fb, el('span', 'ph-fn', list.length + (list.length === 1 ? ' chat' : ' chats') + ' · newest first'));
      body.append(bar);
      if (S.filterOpen) {
        const fl = el('div', 'ph-flist');
        fl.setAttribute('role', 'group');
        fl.setAttribute('aria-label', 'Show chats of');
        const allBtn = button('', '', () => setFilter(''));
        allBtn.dataset.project = '';
        allBtn.setAttribute('aria-pressed', picked ? 'false' : 'true');
        allBtn.append(doc.createTextNode('All projects'), el('span', 'ph-n', String(all.length)));
        fl.append(allBtn);
        for (const p of projects) {
          const b = button('', '', () => setFilter(p.id));
          b.dataset.project = p.id;
          b.setAttribute('aria-pressed', picked && picked.id === p.id ? 'true' : 'false');
          const dot = el('span', 'ph-pdot');
          dot.style.background = projectColor(p.color);
          b.append(dot, doc.createTextNode(p.name), el('span', 'ph-n', String(p.count)));
          fl.append(b);
        }
        body.append(fl);
      }
    }
    if (!home) body.append(el('p', 'ph-empty', 'Loading your chats…'));
    else if (!all.length) body.append(el('p', 'ph-empty', 'No chats on ' + S.pcName + ' yet. Start one in AIB on the PC.'));
    else {
      const now = Date.now();
      const cards = el('div', 'ph-cards');
      cardItems.clear();
      for (const item of list) cards.append(chatCard(item, now));
      body.append(cards);
    }
    parts.push(body);
    if (home && !S.offline) {
      if (abilities(S.scopes).start) {
        const fab = button('ph-fab', '+ New chat', openNew);
        fab.id = 'phNewChat';
        parts.push(fab);
      } else {
        const off = el('p', 'ph-startoff');
        off.id = 'phStartOff';
        off.append(
          doc.createTextNode('Starting new chats from this phone is off. To turn it on: AIB on ' + S.pcName + ' → Settings → Remote control → this phone → '),
          el('b', '', 'Start new chats'),
          doc.createTextNode(abilities(S.scopes).send ? '.' : ' (it needs “Send messages, stop turns and continue chats” on first).'),
        );
        parts.push(off);
      }
    }
    return parts;
  }

  /* Continue this chat (or why this phone can't): the bottom bar of a chat that is not running. */
  function continueBar(key) {
    const bar = el('div', 'ph-continue');
    bar.id = 'phContinue';
    if (S.actError) {
      const err = el('p', 'ph-error', S.actError);
      err.setAttribute('role', 'alert');
      bar.append(err);
    }
    if (!abilities(S.scopes).send) {
      bar.append(
        el(
          'p',
          'ph-note',
          'To continue this chat from this phone, turn on "Send messages, stop turns and continue chats" for this phone in AIB on ' +
            S.pcName +
            ': Settings → Remote control.',
        ),
      );
      return bar;
    }
    const agent = (S.saved && S.saved.agent) || (S.chatMeta && S.chatMeta.agent) || '';
    const p = el('p', 'ph-note');
    p.append(
      el('b', '', 'Continue this chat'),
      doc.createTextNode(
        ' starts it again on ' + S.pcName + ' with its saved agent' + (agent ? ' (' + agent + ')' : '') + ' and settings. Then you can send messages here.',
      ),
    );
    bar.append(p);
    const go = button('ph-btn', S.continuing ? 'Starting…' : 'Continue this chat', () => continueChat(key));
    go.id = 'phContinueBtn';
    go.disabled = S.continuing || S.offline;
    bar.append(go);
    return bar;
  }

  /* The saved chat screen: header, its saved messages (read only), Continue this chat. */
  function drawSaved() {
    const c = S.saved;
    const meta = S.chatMeta || {};
    const title = (c && c.title) || S.chatTitle || 'Chat';
    const agent = (c && c.agent) || meta.agent || '';
    const parts = [
      header(title, {
        back: goHome,
        sub: meta.project ? projectLine(meta.project, [agent]) : agent,
        chip: S.offline ? ['Offline', 'off'] : ['Not running', 'idle'],
      }),
    ];
    if (S.offline) parts.push(offlineBox());
    const body = el('main', 'ph-chat' + (S.offline ? ' ph-stale' : ''));
    if (!c) body.append(el('p', 'ph-empty', 'Loading…'));
    else if (c.gone) body.append(el('p', 'ph-empty', 'This chat is no longer in the list on ' + S.pcName + '.'));
    else {
      body.append(el('p', 'ph-earlier', 'Not running on ' + S.pcName + '. These are its saved messages.'));
      if (c.truncated) body.append(el('p', 'ph-earlier', 'Earlier messages are on your PC.'));
      const rows = rowsFrom(c.events);
      const list = el('div', 'ph-list');
      drawRows(list, rows, null);
      if (!rows.length) list.append(el('p', 'ph-empty', c.history ? 'No messages yet.' : 'The messages of this chat are on your PC.'));
      body.append(list);
    }
    parts.push(body);
    if (c && !c.gone) parts.push(continueBar(S.savedKey));
    return parts;
  }

  /* The rows of a chat. `c`: the live chat (its waiting requests, subagents and agent) or null for a saved one. */
  function drawRows(box, rows, c) {
    const agent = (c && c.agent) || '';
    // The Subagents card goes after the newest prompt (subagents belong to the turn that started them).
    let subsAt = -1;
    if (c && (c.helpers || []).length) {
      subsAt = 0;
      rows.forEach((r, i) => {
        if (r.kind === 'you') subsAt = i + 1;
      });
    }
    rows.forEach((r, i) => {
      if (i === subsAt) box.append(subsCard(c));
      if (r.kind === 'steps') {
        const open = S.open.has(r.key);
        const n = r.steps.length;
        const running = c && c.busy ? r.steps.filter((s) => !s.done).length : 0;
        const fold = button('ph-fold', '', () => {
          if (S.open.has(r.key)) S.open.delete(r.key);
          else S.open.add(r.key);
          draw();
        });
        fold.append(
          running ? el('span', 'ph-spin') : el('span', 'ph-check', '✓'),
          doc.createTextNode(n + (n === 1 ? ' step' : ' steps') + (running ? ' · ' + running + ' running' : '')),
          el('span', 'ph-chev2', '›'),
        );
        fold.setAttribute('aria-expanded', open ? 'true' : 'false');
        const wrap = el('div', 'ph-steps-fold' + (open ? ' open' : ''));
        wrap.append(fold);
        if (open) {
          const ul = el('ol', 'ph-fold-list');
          for (const s of r.steps) {
            const li = el('li', s.done ? '' : 'run', s.title + (s.done ? '' : ' · ' + (s.status === 'pending' ? 'waiting' : 'running')));
            ul.append(li);
          }
          wrap.append(ul);
        }
        box.append(wrap);
        return;
      }
      if (r.kind === 'artifact') {
        box.append(artifactCard(r.artifact));
        return;
      }
      if (r.kind === 'req') {
        box.append(reqCard(c, r.key, reqOpen(rows, r.key, S.reqOpened, S.landKey)));
        return;
      }
      if (r.kind === 'record') {
        const rec = el('div', 'ph-req done');
        rec.dataset.req = r.key;
        rec.dataset.record = '1';
        const line = el('p', 'ph-rec');
        line.append(el('span', 'ph-check', '✓'), doc.createTextNode(r.text));
        rec.append(line);
        box.append(rec);
        return;
      }
      if (r.kind === 'notice') {
        box.append(el('p', 'ph-notice' + (r.mine ? ' mine' : ''), r.text));
        return;
      }
      const m = el('div', 'ph-msg ' + r.kind);
      if (r.kind === 'agent') {
        if (agent) m.append(el('div', 'ph-who', agent));
        const text = el('div', 'ph-text');
        if (root.AgentMarkdown) root.AgentMarkdown.render(text, r.text);
        else text.textContent = r.text;
        m.append(text);
      } else if (r.text) {
        const bub = el('div', 'ph-bub', r.text);
        m.append(bub);
      }
      if (r.steered) m.append(el('span', 'ph-steered', 'Sent while working'));
      const imgBox = r.kind === 'you' ? m.querySelector('.ph-bub') || m : m;
      for (const url of r.images || []) {
        const img = el('img', 'ph-img');
        img.loading = 'lazy';
        img.alt = 'Picture';
        img.src = url;
        imgBox.append(img);
      }
      box.append(m);
    });
    if (subsAt >= rows.length) box.append(subsCard(c));
  }

  /* The Subagents card in the stream: each subagent's title and state (its own steps are on the PC). */
  function subsCard(c) {
    const helpers = c.helpers || [];
    const wrap = el('div', 'ph-subs' + (S.subsOpen ? ' open' : ''));
    wrap.id = 'phSubs';
    const head = button('ph-fold', '', () => {
      S.subsOpen = !S.subsOpen;
      draw();
    });
    head.setAttribute('aria-expanded', S.subsOpen ? 'true' : 'false');
    head.append(el('span', 'ph-subs-mark', '⑂'), doc.createTextNode(subsWords(helpers).card), el('span', 'ph-chev2', '›'));
    wrap.append(head);
    if (S.subsOpen) {
      const ul = el('ul', 'ph-sub-list');
      ul.setAttribute('aria-label', 'Subagents');
      for (const h of helpers) {
        const li = el('li');
        li.dataset.sub = h.id;
        const open = S.subOpen.has(h.id);
        const b = button('ph-sub', '', () => {
          if (S.subOpen.has(h.id)) S.subOpen.delete(h.id);
          else S.subOpen.add(h.id);
          draw();
        });
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
        b.append(el('span', 'ph-dot ' + helperTone(h.state)), el('span', 'ph-sub-title', h.title), el('span', 'ph-sw', helperWord(h.state)));
        li.append(b);
        if (open)
          li.append(
            el(
              'p',
              'ph-more',
              'A sub-task ' + (c.agent || 'the agent') + ' started in this chat. The phone shows its title and state; its own steps are on your PC.',
            ),
          );
        ul.append(li);
      }
      wrap.append(ul);
    }
    return wrap;
  }

  const ART_BADGE = { html: 'HTML', svg: 'SVG', md: 'MD', image: 'IMG', pdf: 'PDF', csv: 'CSV', json: 'JSON', text: 'TXT' };
  /* An artifact in the chat: its kind, title and version; a tap shows it here, or it says to open it on the PC. */
  function artifactCard(a) {
    const here = a.kind !== 'pdf' && !!S.artifacts;
    const card = here ? button('ph-art', '', () => openArtifact(a.id, a.version, a)) : el('div', 'ph-art');
    card.dataset.artifact = a.id;
    if (here) {
      card.dataset.openArtifact = a.id;
      card.setAttribute('aria-label', 'Open ' + a.title);
    }
    const text = el('span', 'ph-art-text');
    text.append(
      el('b', 'ph-art-title', a.title),
      el(
        'span',
        'ph-art-kind',
        artifactKind(a.kind) + (a.version > 1 ? ' · v' + a.version : '') + (here ? ' · tap to open' : ' · open on your PC'),
      ),
    );
    card.append(el('span', 'ph-art-icon', ART_BADGE[a.kind] || 'FILE'), text);
    return card;
  }

  // ---- the artifact viewer (full screen, outside #app so polls never reload the frame) ----
  let viewerEl = null;
  const SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads'; // as on the PC; never allow-same-origin
  async function openArtifact(id, version, known) {
    const k = obj(known);
    S.viewer = { id, version: version || 0, title: str(k.title) || 'Artifact', kind: str(k.kind), state: 'loading' };
    drawViewer();
    let r;
    try {
      r = await call('GET', '/api/remote/artifact?id=' + encodeURIComponent(id) + (version ? '&v=' + version : ''));
    } catch {
      r = null;
    }
    if (!S.viewer || S.viewer.id !== id) return; // closed meanwhile
    if (!r || r.status !== 200) {
      const why = (r && r.data && r.data.error) || "Your PC can't be reached right now. Try again.";
      S.viewer = { ...S.viewer, state: 'error', why };
    } else if (r.data.view === 'pc' || !r.data.url) {
      S.viewer = { ...S.viewer, ...artifactOf(r.data), state: 'pc', why: str(r.data.why) };
    } else {
      S.viewer = { ...S.viewer, ...artifactOf(r.data), state: 'open', view: r.data.view, url: r.data.url };
    }
    if (r && r.status === 200) {
      S.viewer.latest = Math.max(1, Number(r.data.latest) || S.viewer.version || 1);
      S.viewer.versions = Array.isArray(r.data.versions) ? r.data.versions : [];
      S.viewer.drop = false;
    }
    drawViewer();
  }
  function closeArtifact() {
    S.viewer = null;
    drawViewer();
  }
  function drawViewer() {
    const v = S.viewer;
    doc.documentElement.classList.toggle('ph-viewing', !!v);
    if (!v) {
      if (viewerEl) viewerEl.remove();
      viewerEl = null;
      return;
    }
    const box = el('div', 'ph-viewer');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', v.title);
    box.dataset.state = v.state;
    const bar = el('div', 'ph-viewer-bar');
    const name = el('div', 'ph-viewer-name');
    name.append(
      el('b', '', v.title),
      el('span', 'ph-art-kind', artifactKind(v.kind) + (v.version > 1 ? ' · v' + v.version : '')),
    );
    const close = button('ph-btn quiet', 'Close', closeArtifact);
    close.id = 'viewerClose';
    // the version menu (like the PC's version chip): v3 ▾ lists each version with its time, what made it, its note, "latest"
    const versions = Array.isArray(v.versions) ? v.versions : [];
    let chip = null;
    if (versions.length > 1) {
      chip = button('ph-vchip', 'v' + v.version + ' ▾', () => {
        v.drop = !v.drop;
        drawViewer();
      });
      chip.id = 'phVersions';
      chip.setAttribute('aria-haspopup', 'listbox');
      chip.setAttribute('aria-expanded', v.drop ? 'true' : 'false');
    } else if (v.version) chip = el('span', 'ph-vchip plain', 'v' + v.version);
    bar.append(name);
    if (chip) bar.append(chip);
    bar.append(close);
    box.append(bar);
    if (v.drop && versions.length > 1) {
      const drop = el('div', 'ph-vdrop');
      drop.id = 'phVersionList';
      drop.setAttribute('role', 'listbox');
      drop.setAttribute('aria-label', 'Versions');
      const now = Date.now();
      for (const x of versions) {
        const o = button('ph-vopt', '', () => openArtifact(v.id, x.n, { title: v.title, kind: v.kind }));
        o.setAttribute('role', 'option');
        o.setAttribute('aria-selected', x.n === v.version ? 'true' : 'false');
        o.dataset.v = String(x.n);
        const meta = el('span', 'ph-vm', versionMeta(x, now));
        if (str(x.note)) meta.append(el('span', 'ph-vnote', str(x.note)));
        o.append(el('span', 'ph-vn', (x.n === v.version ? '✓ ' : '') + 'v' + x.n), meta);
        drop.append(o);
      }
      box.append(drop);
    }
    if (v.latest && v.version && v.version < v.latest) {
      const old = el('div', 'ph-vold');
      old.id = 'phVersionOld';
      old.append(doc.createTextNode('You are looking at v' + v.version + '. v' + v.latest + ' is available. '));
      const sw = button('ph-vswitch', 'Switch', () => openArtifact(v.id, v.latest, { title: v.title, kind: v.kind }));
      sw.id = 'phVersionSwitch';
      old.append(sw);
      box.append(old);
    }
    const body = el('div', 'ph-viewer-body');
    if (v.state === 'loading') body.append(el('p', 'ph-empty', 'Opening…'));
    else if (v.state === 'open' && v.view === 'image') {
      const img = el('img', 'ph-viewer-img');
      img.alt = v.title;
      img.src = v.url;
      body.append(img);
    } else if (v.state === 'open') {
      const frame = el('iframe', 'ph-viewer-frame');
      frame.setAttribute('sandbox', SANDBOX);
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = v.title;
      frame.src = v.url;
      body.append(frame);
    } else {
      const note = el('div', 'ph-viewer-note');
      note.append(el('p', '', v.state === 'pc' ? 'Open this on your PC: AIB → Artifacts.' : v.why));
      if (v.state === 'pc' && v.why) note.append(el('p', 'ph-note', v.why));
      body.append(note);
    }
    box.append(body);
    if (viewerEl) viewerEl.replaceWith(box);
    else doc.body.append(box);
    viewerEl = box;
    if (!box.contains(doc.activeElement) || doc.activeElement === box) close.focus({ preventScroll: true });
  }

  /* A waiting approval or question as a card in the stream. Closed: one line with Review / Answer. Open: Deny / Allow once (only
     the options a phone may pick), or the question's fields with Send answer / Decline. */
  function reqCard(c, key, open) {
    const wait = ((c && c.waiting) || []).find((w) => (w.key || 'sign-in') === key);
    const box = el('div', 'ph-req' + (open ? ' open' : '') + (S.landKey === key ? ' flash' : ''));
    box.dataset.req = key;
    if (!wait) return box;
    box.dataset.kind = wait.kind;
    const can = abilities(S.scopes);
    const kindWord = wait.kind === 'permission' ? 'approval' : wait.kind === 'question' ? 'question' : 'sign-in';
    const head = button('ph-req-head', '', () => {
      S.reqOpened[key] = !open;
      if (S.landKey === key) S.landKey = '';
      draw();
    });
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    const rt = el('span', 'ph-rt');
    rt.append(el('b', '', 'Needs you · ' + kindWord));
    const title = wait.kind === 'permission' ? (c.agent ? c.agent + ' asks to: ' : 'Asks to: ') + wait.title : wait.title;
    rt.append(el('span', 'ph-req-title', title));
    if (!open && wait.detail) rt.append(el('span', 'ph-pv', wait.detail));
    head.append(el('span', 'ph-dot need'), rt);
    head.append(
      open
        ? el('span', 'ph-go quiet', 'Hide')
        : el('span', 'ph-go', wait.kind === 'permission' ? 'Review' : wait.kind === 'question' ? 'Answer' : 'Open'),
    );
    box.append(head);
    if (!open) return box;
    const body = el('div', 'ph-rb');
    if (wait.kind === 'permission') {
      if (wait.detail) body.append(el('pre', 'ph-cmd', wait.detail));
      if (c.folder) body.append(el('p', 'ph-note', 'In ' + c.folder));
      const buttons = can.approve && !wait.pcOnly && !S.offline ? approvalButtons(wait) : [];
      if (buttons.length) {
        const row = el('div', 'ph-row ph-answer');
        for (const b of buttons) {
          const x = button('ph-btn ' + b.tone, b.label, () =>
            decide(c, wait, b),
          );
          x.dataset.option = b.optionId;
          x.disabled = S.sending;
          row.append(x);
        }
        body.append(row);
        if (wait.hidden > 0) body.append(el('p', 'ph-note ph-center', 'Other choices are on your PC.'));
      } else if (!can.approve && !wait.pcOnly)
        body.append(
          el('p', 'ph-note', 'Allowing from this phone is off. Answer in AIB on ' + S.pcName + ', or turn it on there in Settings → Remote control.'),
        );
      else if (!S.offline) body.append(el('p', 'ph-note', 'Finish this on your PC.'));
    } else if (wait.kind === 'question') {
      if (wait.pcOnly || !can.answer || S.offline) {
        if (!S.offline)
          body.append(
            el(
              'p',
              'ph-note',
              !wait.pcOnly && !can.answer
                ? 'Answering from this phone is off. Answer in AIB on ' + S.pcName + ', or turn it on there in Settings → Remote control.'
                : 'Finish this on your PC.',
            ),
          );
      } else {
        const values = (S.answers[key] = S.answers[key] || {});
        const fields = fieldsOf(wait.schema);
        for (const f of fields) body.append(fieldEl(key, f, values));
        if (S.actError && S.actKey === key) {
          const e = el('p', 'ph-error', S.actError);
          e.setAttribute('role', 'alert');
          body.append(e);
        }
        const row = el('div', 'ph-row ph-answer');
        const decline = button('ph-btn deny', 'Decline', () => answer(c, wait, fields, false));
        decline.dataset.decline = key;
        decline.disabled = S.sending;
        const go = button('ph-btn allow', 'Send answer', () => answer(c, wait, fields, true));
        go.dataset.answer = key;
        go.disabled = S.sending;
        row.append(decline, go);
        body.append(row);
        body.append(el('p', 'ph-note ph-center', 'Decline tells ' + (c.agent || 'the agent') + ' you won’t answer.'));
      }
    } else body.append(el('p', 'ph-note', 'Finish this on your PC.'));
    if (wait.kind === 'permission' && S.actError && S.actKey === key) {
      const e = el('p', 'ph-error', S.actError);
      e.setAttribute('role', 'alert');
      body.append(e);
    }
    box.append(body);
    return box;
  }

  async function decide(c, wait, b) {
    const done = await act('permission', { id: c.id, key: wait.key, option: b.optionId }, wait.key);
    if (!done) return;
    S.acted[wait.key] = { kind: b.tone === 'allow' ? 'allow' : 'deny', detail: wait.detail || wait.title };
    toast(b.tone === 'allow' ? 'Allowed once' : 'Denied');
    draw();
  }

  async function answer(c, wait, fields, yes) {
    const values = S.answers[wait.key] || {};
    let body;
    let words = '';
    if (yes) {
      const { content, missing } = contentFrom(fields, values);
      if (missing.length) {
        S.actError = 'Fill in: ' + missing.join(', ') + '.';
        S.actKey = wait.key;
        return draw();
      }
      body = { id: c.id, key: wait.key, action: 'accept', content };
      words = answerWords(fields, content);
    } else body = { id: c.id, key: wait.key, action: 'decline' };
    const done = await act('elicitation', body, wait.key);
    if (!done) return;
    delete S.answers[wait.key];
    S.acted[wait.key] = yes ? { kind: 'answer', answer: words } : { kind: 'decline' };
    toast(yes ? 'Answer sent' : 'Declined');
    draw();
  }

  function unknownBox(c, can) {
    if (!can.send || S.offline || !(c.unknown || []).length) return null;
    const box = el('section', 'ph-wait');
    for (const u of c.unknown) {
      box.append(el('p', '', 'AIB restarted while a message was being sent. The agent may not have received it.'));
      box.append(button('ph-btn quiet', 'It arrived, dismiss', () => act('dismiss-unknown', { id: c.id, clientMessageId: u.clientMessageId })));
    }
    return box;
  }

  /* The "Needs you · Show ↑" bar and what waits to be sent: the top of the bottom bar. */
  function bottomExtra(c, can) {
    const frag = doc.createDocumentFragment();
    const rows = rowsFrom(S.chatEvents, { waiting: c.waiting, acted: S.acted });
    const pending = rows.find((r) => r.kind === 'req');
    if (pending) {
      const wait = (c.waiting || []).find((w) => (w.key || 'sign-in') === pending.key);
      const above = button('ph-above', '', () => {
        S.reqOpened[pending.key] = true;
        S.scrollTo = 'req:' + pending.key;
        draw();
      });
      above.id = 'phAbove';
      above.dataset.above = pending.key;
      above.hidden = true; // checkAbove shows it while the card is out of view
      above.append(
        el('span', 'ph-dot need'),
        el('span', 'ph-above-text', ''),
        el('span', 'ph-above-go', 'Show ↑'),
      );
      above.querySelector('.ph-above-text').append(
        el('b', '', 'Needs you'),
        doc.createTextNode(' · ' + (wait && wait.kind === 'permission' ? 'approval' : wait && wait.kind === 'question' ? 'question' : 'sign-in') + ' above'),
      );
      frag.append(above);
    }
    const q = queueBox(c, can);
    if (q) frag.append(q);
    return frag;
  }

  function queueBox(c, can) {
    const items = (c.queue && c.queue.items) || [];
    if (!items.length) return null;
    const box = el('section', 'ph-queue');
    box.setAttribute('aria-label', 'Messages waiting to send');
    const open = S.qopen || !!S.editing || c.queue.paused;
    const head = button('ph-qh', '', () => {
      S.qopen = !open;
      draw();
    });
    head.id = 'phQueueToggle';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.append(
      el('span', 'ph-qh-title', 'Waiting to send · ' + items.length + (c.queue.paused ? ' · paused' : '')),
      el('span', 'ph-qh-go', open ? 'Hide' : 'Show'),
    );
    box.append(head);
    if (!open) return box;
    let actions = false;
    for (const item of items) {
      const row = el('div', 'ph-queued');
      row.dataset.queued = item.id;
      const mine = S.editing && S.editing.messageId === item.id;
      if (mine) {
        const ta = el('textarea', 'ph-input');
        ta.id = 'queueEdit';
        ta.rows = 3;
        ta.value = S.editing.text;
        ta.setAttribute('aria-label', 'Edit the queued message');
        ta.addEventListener('input', () => (S.editing.text = ta.value));
        row.append(ta);
        const acts = el('div', 'ph-qa');
        const save = button('ph-btn sm', 'Save', () => queueEdit(item.id, 'save'));
        save.dataset.act = 'save';
        acts.append(save, button('ph-btn sm quiet', 'Cancel', () => queueEdit(item.id, 'cancel')));
        row.append(acts);
      } else {
        row.append(el('p', 'ph-queued-text', item.text.length > 400 ? item.text.slice(0, 400) + '…' : item.text));
        if (item.files) row.append(el('p', 'ph-note', item.files === 1 ? 'With 1 file' : 'With ' + item.files + ' files'));
        if (item.sending) row.append(el('p', 'ph-note', 'Sending now…'));
        else if (item.editing) row.append(el('p', 'ph-note', 'Being edited on your PC.'));
        else if (can.send && !S.offline) {
          actions = true;
          const acts = el('div', 'ph-qa');
          const edit = button('ph-btn sm quiet', 'Edit', () => queueEdit(item.id, 'acquire'));
          edit.dataset.act = 'edit';
          const remove = button('ph-btn sm quiet', 'Remove', async () => {
            if (await act('queue-remove', { id: c.id, messageId: item.id })) toast('Removed from the queue');
          });
          remove.dataset.act = 'remove';
          const now = button('ph-btn sm quiet', 'Send now', () => act('queue-send-now', { id: c.id, messageId: item.id }));
          now.dataset.act = 'send-now';
          acts.append(edit, remove, now);
          row.append(acts);
        }
      }
      box.append(row);
    }
    if (c.queue.paused && can.send && !S.offline && items.some((i) => !i.sending && !i.editing)) {
      const row = el('div', 'ph-queued ph-paused');
      row.append(el('p', 'ph-note', (c.queue.message ? c.queue.message + '. ' : 'Paused after Stop. ') + 'Resume sends the next message.'));
      const resume = button('ph-btn sm', 'Resume', () => act('queue-resume', { id: c.id }));
      resume.dataset.act = 'resume';
      row.append(resume); // a Stop (or a failed turn) paused the queue: it goes on from here too
      box.append(row);
    } else if (actions && c.busy) box.append(el('p', 'ph-note ph-qnote', 'Send now stops the current turn and sends that message first.'));
    return box;
  }

  /* The bottom bar: the Needs you bar, what waits to be sent, the message box and Send, and Stop while the agent works. The same
     form stays between polls, so the text and the caret are never lost; only its parts around the box change. */
  let composerEl = null;
  function composer() {
    if (!composerEl) {
      const bar = el('form', 'ph-bottom ph-composer');
      bar.id = 'phComposer';
      bar.noValidate = true;
      const extra = el('div', 'ph-extra');
      extra.id = 'phBottomExtra';
      const err = el('p', 'ph-error ph-act-error');
      err.id = 'phActError';
      err.setAttribute('role', 'alert');
      const row = el('div', 'ph-composer-row');
      const ta = el('textarea', 'ph-input');
      ta.id = 'phPrompt';
      ta.rows = 1;
      ta.setAttribute('aria-label', 'Message');
      ta.addEventListener('input', () => {
        S.draft = ta.value;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
      });
      const stop = el('button', 'ph-stop', '■');
      stop.type = 'button';
      stop.id = 'phStop';
      stop.setAttribute('aria-label', 'Stop the current turn');
      stop.addEventListener('click', async () => {
        if (await act('cancel', { id: S.chatId })) toast('Stopped');
      });
      const send = el('button', 'ph-send', '↑');
      send.type = 'submit';
      send.id = 'phSend';
      send.setAttribute('aria-label', 'Send');
      row.append(ta, stop, send);
      const hint = el('p', 'ph-hint');
      hint.id = 'phHint';
      bar.append(extra, err, row, hint);
      bar.addEventListener('submit', (event) => {
        event.preventDefault();
        sendDraft();
      });
      composerEl = bar;
    }
    const bar = composerEl;
    const c = S.chat || {};
    const ta = bar.querySelector('#phPrompt');
    if (ta.value !== S.draft) ta.value = S.draft;
    ta.placeholder = 'Message ' + (c.agent || 'the agent');
    bar.querySelector('#phSend').disabled = S.sending;
    bar.querySelector('#phStop').hidden = !c.busy;
    bar.querySelector('#phBottomExtra').replaceChildren(bottomExtra(c, abilities(S.scopes)));
    const err = bar.querySelector('#phActError');
    err.textContent = S.actKey ? '' : S.actError;
    err.hidden = !err.textContent;
    const hint = bar.querySelector('#phHint');
    hint.textContent = c.busy
      ? (c.agent || 'The agent') + ' is working. Send ' + (c.steerable ? 'gives it your message now' : 'adds your message to the queue') + '; ■ stops the turn.'
      : '';
    hint.hidden = !hint.textContent || !!err.textContent;
    return bar;
  }

  /* The bottom bar when this phone can't send here (its switch is off, or the chat can't take messages): what waits, and why. */
  function bottomNote(c, text) {
    const bar = el('div', 'ph-bottom');
    bar.id = 'phBottom';
    bar.append(bottomExtra(c, abilities(S.scopes)));
    if (text) bar.append(el('p', 'ph-pconly', text));
    return bar;
  }

  /* Show the "Needs you · Show ↑" bar while its waiting card is out of view (above or below what the screen shows). */
  function checkAbove() {
    const bar = doc.getElementById('phAbove');
    if (!bar) return;
    const card = doc.querySelector('.ph-req[data-req="' + CSS.escape(bar.dataset.above) + '"]');
    if (!card) {
      bar.hidden = true;
      return;
    }
    const head = doc.querySelector('.ph-head');
    const bottom = bar.closest('.ph-bottom');
    const top = head ? head.getBoundingClientRect().bottom : 0;
    const r = card.getBoundingClientRect();
    bar.hidden = true; // measure the bottom bar without it
    const end = bottom ? bottom.getBoundingClientRect().top : root.innerHeight;
    const out = r.bottom < top + 8 || r.top > end - 8;
    bar.hidden = !out;
  }

  function fieldEl(reqKey, f, values) {
    const wrap = el('div', 'ph-field');
    wrap.dataset.field = f.key;
    wrap.append(el('p', 'ph-field-title', f.title + (f.required ? '' : ' (optional)')));
    if (f.description) wrap.append(el('p', 'ph-note', f.description));
    if (f.type === 'choice' || f.type === 'bool' || f.type === 'multi') {
      for (const ch of f.choices) {
        const picked = f.type === 'multi' ? (values[f.key] || []).includes(ch.value) : values[f.key] === ch.value;
        const b = button('ph-opt' + (picked ? ' on' : ''), ch.label, () => {
          if (f.type === 'multi') {
            const now = new Set(values[f.key] || []);
            if (now.has(ch.value)) now.delete(ch.value);
            else now.add(ch.value);
            values[f.key] = [...now];
          } else values[f.key] = ch.value;
          if (S.actKey === reqKey) S.actError = '';
          draw();
        });
        b.setAttribute('aria-pressed', picked ? 'true' : 'false');
        wrap.append(b);
      }
    } else {
      const input = el(f.type === 'number' ? 'input' : 'textarea', 'ph-input');
      input.id = 'phField-' + reqKey + '-' + f.key;
      if (f.type === 'number') {
        input.type = 'number';
        input.inputMode = f.integer ? 'numeric' : 'decimal';
      } else input.rows = 2;
      input.value = values[f.key] == null ? '' : String(values[f.key]);
      input.setAttribute('aria-label', f.title);
      input.addEventListener('input', () => (values[f.key] = input.value));
      wrap.append(input);
    }
    return wrap;
  }

  function chatMain() {
    const c = S.chat;
    const body = el('main', 'ph-chat' + (S.offline ? ' ph-stale' : ''));
    if (!c) {
      body.append(el('p', 'ph-empty', 'Loading…'));
      return body;
    }
    if (c.gone) {
      body.append(el('p', 'ph-empty', 'This chat is not running on ' + S.pcName + ' any more. Go back to your chats: it is in the list as Not running.'));
      return body;
    }
    const can = abilities(S.scopes);
    if (c.truncated) body.append(el('p', 'ph-earlier', 'Earlier messages are on your PC.'));
    const rows = rowsFrom(S.chatEvents, { waiting: c.waiting, acted: S.acted });
    const list = el('div', 'ph-list');
    drawRows(list, rows, c);
    if (!rows.length && !(c.helpers || []).length) list.append(el('p', 'ph-empty', 'No messages yet.'));
    body.append(list);
    const unknown = unknownBox(c, can);
    if (unknown) body.append(unknown);
    const live = liveLine(c, rows);
    if (live) {
      const p = el('p', 'ph-live');
      p.setAttribute('role', 'status');
      p.append(el('span', 'ph-spin'), doc.createTextNode(live));
      body.append(p);
    }
    if (c.closed) body.append(el('p', 'ph-pconly', 'This chat stopped on ' + S.pcName + '.' + (c.error ? ' ' + c.error : '')));
    return body;
  }

  /* The chat screen: header, the conversation, the bottom bar (the composer when this phone may send and the PC answers). */
  function drawChat() {
    const c = S.chat;
    const meta = S.chatMeta || {};
    const title = (c && c.title) || S.chatTitle || 'Chat';
    const w = c && !c.gone ? stateWords(c) : null;
    const agent = (c && c.agent) || meta.agent || '';
    const project = (c && c.project) || meta.project;
    let extra = null;
    const helpers = (c && !c.gone && c.helpers) || [];
    if (helpers.length) {
      extra = button('ph-subs-go', subsWords(helpers).short + ' ›', () => {
        S.subsOpen = true;
        S.scrollTo = 'subs';
        draw();
      });
      extra.id = 'phSubsGo';
    }
    let arts = null;
    if (c && !c.gone && c.savedKey) {
      const n = S.artCount[c.savedKey];
      arts = button('ph-ic ph-hdart', '▤', () =>
        openArts({ kind: 'live', chat: { key: c.savedKey, id: c.id }, title, agent, project }, 'chat'),
      );
      arts.id = 'phArtsBtn';
      arts.setAttribute('aria-label', 'Artifacts' + (n == null ? '' : ' (' + n + ')'));
      if (n != null) arts.append(el('span', 'ph-cnt', String(n)));
    }
    const parts = [
      header(title, {
        back: goHome,
        sub: project ? projectLine(project, [agent]) : agent,
        extra,
        tools: [arts],
        chip: S.offline ? ['Offline', 'off'] : w ? [w.text.split(' · ')[0], w.tone] : null,
      }),
    ];
    if (S.offline) parts.push(offlineBox());
    const main = chatMain();
    const job = S.newJob && S.newJob.id === S.chatId ? S.newJob : null;
    if (job && job.note) {
      const note = el('p', 'ph-notice mine', job.note);
      note.id = 'phNewNote';
      const list = main.querySelector('.ph-list');
      if (list) list.prepend(note);
      else main.prepend(note);
    }
    parts.push(main);
    if (!c || c.gone) return parts;
    const can = abilities(S.scopes);
    if (job && job.state === 'opening' && !c.closed) {
      parts.push(bottomNote(c, 'Starting this chat on ' + S.pcName + '… Your first message goes as soon as it is ready.'));
      return parts;
    }
    if (c.closed) {
      if (c.savedKey) parts.push(continueBar(c.savedKey));
    } else if (!S.offline && can.send && c.ready) parts.push(composer());
    else if (S.offline) parts.push(bottomNote(c, ''));
    else if (!can.send) parts.push(bottomNote(c, 'Sending from this phone is off. Reply in AIB on ' + S.pcName + '.'));
    else if (c.state === 'opening') parts.push(bottomNote(c, 'Starting this chat on ' + S.pcName + '…'));
    else parts.push(bottomNote(c, 'This chat cannot take messages right now. Open it in AIB on your PC.'));
    return parts;
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
      form.append(l, code, el('p', 'ph-note', 'On your PC: Settings → Remote control → Add a phone shows the six words.'));
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
    body.append(el('p', '', 'To use it again, open Settings → Remote control in AIB on the PC and click Add a phone.'));
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

  /* Put the screen's parts in #app. The composer, when it is already there, is never taken out (the keyboard stays up). */
  function place(parts) {
    const keep = composerEl && parts.includes(composerEl) && composerEl.parentNode === app ? composerEl : null;
    if (!keep) return app.replaceChildren(...parts);
    for (const n of [...app.childNodes]) if (n !== keep) n.remove();
    const at = parts.indexOf(keep);
    keep.before(...parts.slice(0, at));
    keep.after(...parts.slice(at + 1));
  }

  function draw() {
    const y = root.scrollY;
    const d = doc.documentElement;
    const atEnd = root.innerHeight + y >= d.scrollHeight - 40;
    const active = doc.activeElement;
    const focusId = active && active.id;
    const range = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const parts =
      S.screen === 'home'
        ? drawHome()
        : S.screen === 'chat'
          ? drawChat()
          : S.screen === 'saved'
            ? drawSaved()
            : S.screen === 'new'
              ? drawNew()
              : S.screen === 'arts'
                ? drawArts()
            : S.screen === 'pair'
              ? drawPair()
              : S.screen === 'removed'
                ? drawRemoved()
                : S.screen === 'setup'
                  ? drawSetup()
                  : S.screen === 'offline'
                    ? drawOfflineStart()
                    : el('p', 'ph-loading', 'Connecting…');
    const list = Array.isArray(parts) ? parts : [parts];
    // the banner: only inside a chat, about another chat (never on the chat list)
    if (S.banner && inChat() && !S.offline) list.splice(1, 0, bannerEl());
    place(list);
    if (S.viewer && (S.screen === 'removed' || S.screen === 'pair')) closeArtifact(); // this phone may not see it any more
    app.dataset.screen = S.screen;
    if (focusId) {
      const f = doc.getElementById(focusId);
      if (f && f.focus && doc.activeElement !== f) {
        f.focus({ preventScroll: true });
        if (range && f.setSelectionRange) {
          try {
            f.setSelectionRange(range[0], range[1]);
          } catch {
            /* not a text box */
          }
        }
      }
    }
    const to = S.scrollTo;
    if (to && (S.screen === 'chat' || S.screen === 'saved') && (S.chat || S.saved)) {
      S.scrollTo = '';
      let target = null;
      if (to.startsWith('req:')) target = doc.querySelector('.ph-req[data-req="' + CSS.escape(to.slice(4)) + '"]');
      else if (to === 'subs') target = doc.getElementById('phSubs');
      if (target) {
        const head = doc.querySelector('.ph-head');
        const top = target.getBoundingClientRect().top + root.scrollY - (head ? head.getBoundingClientRect().height : 0) - 12;
        root.scrollTo(0, Math.max(0, top));
      } else root.scrollTo(0, d.scrollHeight);
    } else if ((S.screen === 'chat' || S.screen === 'saved') && atEnd && y > 0) root.scrollTo(0, d.scrollHeight); // keep up with new rows
    else root.scrollTo(0, y);
    checkAbove();
  }

  /* Leaving a chat: what belongs to it goes. */
  function leaveChat() {
    if (S.editing) queueEdit(S.editing.messageId, 'cancel');
    S.chat = null;
    S.chatId = '';
    S.chatEvents = [];
    S.chatMeta = null;
    S.savedKey = '';
    S.saved = null;
    S.continuing = false;
    S.actError = '';
    S.actKey = '';
    S.open.clear();
    S.reqOpened = {};
    S.land = '';
    S.landKey = '';
    S.scrollTo = '';
    S.subsOpen = false;
    S.subOpen.clear();
    S.qopen = false;
    S.banner = null;
    S.newJob = null;
  }

  function goHome() {
    leaveChat();
    S.screen = 'home';
    draw();
    root.scrollTo(0, 0);
    clearTimeout(S.timer);
    tick();
  }

  /* A chat that is not running (item: its home card, for the header's project and agent). */
  function openSaved(key, title, item) {
    leaveChat();
    S.screen = 'saved';
    S.savedKey = key;
    S.chatTitle = title || '';
    S.chatMeta = item ? { project: item.project, agent: item.agent } : null;
    S.scrollTo = 'end';
    draw();
    root.scrollTo(0, 0);
    clearTimeout(S.timer);
    loadSaved()
      .then(() => schedule(HOME_MS))
      .catch((error) => {
        if (!(error instanceof Offline)) throw error;
        S.offline = true;
        draw();
        schedule(HOME_MS);
      });
  }

  /* Continue this chat: the PC starts it again with its saved settings; then the chat opens here as a live chat. */
  async function continueChat(key) {
    if (S.continuing || !key) return;
    S.continuing = true;
    S.actError = '';
    draw();
    let r = null;
    try {
      r = await call('POST', '/api/remote/continue', { key });
    } catch {
      r = null;
    }
    S.continuing = false;
    if (r && r.status === 401) return removed();
    if (!r || r.status !== 200 || !r.data.id) {
      S.actError = r ? r.data.error || 'That did not work. Try again.' : "Can't reach " + S.pcName + '. Nothing was started.';
      draw();
      return;
    }
    const title = (S.saved && S.saved.title) || (S.chat && S.chat.title) || S.chatTitle;
    const meta = S.chatMeta;
    toast('Running on ' + S.pcName);
    openChat(r.data.id, title, false, meta);
  }

  /* Open a live chat. land: a notification or a banner brought you here (its waiting card opens and comes into view). item: the
     home card (or {project, agent}) for the header before the chat loads. */
  function openChat(id, title, land, item) {
    const meta = item ? { project: item.project, agent: item.agent } : S.chatMeta;
    leaveChat();
    S.screen = 'chat';
    S.chatId = id;
    S.chatTitle = title || '';
    S.chatMeta = meta || null;
    S.land = land ? 'first' : '';
    S.answers = {};
    S.draft = '';
    S.editing = null;
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

  // ---- actions (answer, approve once, send, stop, queued messages) ----
  /* One phone action; on success the chat reloads at once. A refusal's own words are shown (on the card it came from, `key`, or
     above the composer). */
  async function act(op, body, key) {
    if (S.sending) return null;
    S.sending = true;
    S.actError = '';
    S.actKey = key || '';
    draw();
    let r = null;
    try {
      r = await call('POST', '/api/remote/' + op, body);
    } catch {
      r = null;
    }
    S.sending = false;
    if (r && r.status === 401) {
      removed();
      return null;
    }
    if (!r || r.status !== 200) {
      S.actError = r ? r.data.error || 'That did not work. Try again.' : "Can't reach " + S.pcName + '. Nothing was sent.';
      draw();
      return null;
    }
    S.actKey = '';
    draw();
    clearTimeout(S.timer);
    tick();
    return r.data;
  }

  function newMessageId() {
    return 'phone-' + randomHex(12);
  }

  async function sendDraft() {
    const text = S.draft;
    const c = S.chat;
    if (!c || !text.trim() || S.sending) return;
    const job = S.newJob && S.newJob.id === c.id && S.newJob.state !== 'sent' && S.newJob.state !== 'opening' ? S.newJob : null;
    const op = job ? 'new/first' : c.busy ? (c.steerable ? 'steer' : 'queue') : 'prompt';
    const done = await act(op, { id: c.id, text, clientMessageId: job ? job.cmid : newMessageId() });
    if (done && job) job.state = 'sent';
    if (done) {
      S.draft = '';
      const ta = doc.getElementById('phPrompt');
      if (ta) {
        ta.value = '';
        ta.style.height = 'auto';
      }
      if (op === 'queue') {
        S.qopen = true;
        toast('Added to the queue');
      }
      S.scrollTo = 'end';
      draw();
    }
  }

  async function queueEdit(messageId, action) {
    const ed = S.editing;
    const body = { id: S.chatId, messageId, action };
    if (action !== 'acquire') body.leaseId = ed ? ed.leaseId : null;
    if (action === 'save') body.text = ed ? ed.text : '';
    if (action === 'cancel') S.editing = null;
    const r = await act('queue-edit', body);
    if (action === 'acquire' && r && r.leaseId) {
      S.editing = { messageId, leaseId: r.leaseId, text: typeof r.text === 'string' ? r.text : '', renewed: Date.now() };
      draw();
    } else if (action === 'save' && r) {
      S.editing = null;
      draw();
    }
  }

  function renewEdit() {
    const ed = S.editing;
    if (!ed) return;
    ed.renewed = Date.now();
    call('POST', '/api/remote/queue-edit', { id: S.chatId, messageId: ed.messageId, action: 'renew', leaseId: ed.leaseId }).catch(() => {});
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
      S.scopes = (r.data.device && r.data.device.scopes) || [];
      try {
        const boot = await call('GET', '/api/remote/bootstrap'); // now paired: the push key
        const push = (boot.status === 200 && boot.data.push) || {};
        S.push.key = typeof push.key === 'string' ? push.key : '';
        S.push.on = push.on === true;
        if (boot.status === 200) {
          S.artifacts = typeof boot.data.artifacts === 'string' ? boot.data.artifacts : '';
          if (boot.data.pcName) S.pcName = boot.data.pcName;
        }
      } catch {
        /* Finish setup says so when the button is tapped */
      }
      S.booted = true;
      bootPush();
      openSetup(); // Finish setup: notifications (and on an iPhone, the Home Screen first)
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

  // ---- the service worker, notifications ----
  function registerWorker() {
    const sw = root.navigator.serviceWorker;
    if (!sw || S.worker) return;
    S.worker = true;
    sw.register('/sw.js', { scope: '/' }).catch(() => {
      /* no worker: no copy for when AIB is closed, and no notifications */
    });
    sw.addEventListener('message', (event) => {
      const d = event.data || {};
      if (d.type === 'aib-open' && d.chat && S.device) openChat(String(d.chat), '', !!d.sheet); // a tap on a push
    });
  }

  const pushSupported = () =>
    !!(root.navigator.serviceWorker && root.PushManager && typeof root.Notification === 'function');
  const permissionNow = () => (typeof root.Notification === 'function' ? root.Notification.permission : 'denied');
  const pushAllowed = () => S.scopes.includes('phone.push');
  const standalone = () =>
    root.navigator.standalone === true ||
    !!(root.matchMedia && root.matchMedia('(display-mode: standalone)').matches);
  const iphone = () => isIPhone(root.navigator.userAgent, root.navigator.maxTouchPoints);
  /* Installing the page as an app: what this phone and browser can do now. */
  const installFacts = () => ({
    standalone: standalone(),
    installed: S.install.installed,
    prompt: !!S.install.event && !S.install.used,
    iphone: iphone(),
    firefox: isFirefoxAndroid(root.navigator.userAgent),
  });
  /* Our Install AIB button: the browser's own install dialog (the event kept from beforeinstallprompt; it can be shown once). */
  async function installNow() {
    const e = S.install.event;
    if (!e || S.install.used) {
      S.menu = { kind: 'phone', step: 'install' };
      drawMenu();
      return;
    }
    S.install.used = true;
    let outcome = '';
    try {
      e.prompt();
      const choice = await e.userChoice;
      outcome = choice && choice.outcome;
    } catch {
      outcome = '';
    }
    if (outcome === 'accepted') {
      S.install.installed = true;
      S.install.event = null;
      toast('Installing AIB');
    }
    if (S.menu && S.menu.kind === 'phone') {
      S.menu = null;
      drawMenu();
    }
    if (S.screen === 'setup' || S.screen === 'home') draw();
  }
  root.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // no mini-infobar: our own Install AIB button shows it
    S.install.event = e;
    S.install.used = false;
    if (S.screen === 'setup') draw();
    if (S.menu && S.menu.kind === 'phone') drawMenu();
  });
  root.addEventListener('appinstalled', () => {
    S.install.installed = true;
    S.install.event = null;
    if (S.screen === 'setup') draw();
    if (S.menu && S.menu.kind === 'phone') drawMenu();
  });
  const pushReady = () => !pushAllowed() || (S.push.on && permissionNow() === 'granted');

  function withTimeout(promise, ms) {
    let t;
    return Promise.race([promise, new Promise((_, reject) => (t = setTimeout(() => reject(new Error('timed out')), ms)))]).finally(
      () => clearTimeout(t),
    );
  }

  /* Subscribe (or subscribe again) and give the PC the subscription. Only once permission is granted; never asks for it. */
  async function subscribe() {
    if (!pushSupported() || !pushAllowed() || !S.push.key || permissionNow() !== 'granted') return false;
    const reg = await withTimeout(root.navigator.serviceWorker.ready, 10000);
    let sub = await reg.pushManager.getSubscription();
    const want = keyBytes(S.push.key);
    const have = sub && sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
      await sub.unsubscribe().catch(() => {}); // the PC made new keys (Remove all phones): the old subscription is dead
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    const r = await call('POST', '/api/remote/push/subscribe', { subscription: sub.toJSON() });
    S.push.on = r.status === 200;
    if (r.status !== 200) S.push.error = r.data.error || 'Your PC did not take the notification address. Try again.';
    return S.push.on;
  }

  /* At every page open: subscribe again when notifications are already allowed (quietly; Finish setup shows any problem). */
  async function bootPush() {
    S.push.permission = permissionNow();
    try {
      await subscribe();
    } catch {
      /* Finish setup offers the button again */
    }
  }

  /* "Turn on notifications": a tap (iPhone and Chrome ask only from one). */
  async function turnOnNotifications() {
    if (S.push.busy) return;
    S.push.busy = true;
    S.push.error = '';
    draw();
    try {
      let perm = permissionNow();
      if (perm !== 'granted') perm = await root.Notification.requestPermission();
      S.push.permission = perm;
      if (perm === 'granted' && !(await subscribe()) && !S.push.error) S.push.error = 'Notifications could not be turned on. Try again.';
    } catch (error) {
      if (!(error instanceof Offline)) S.push.error = 'Notifications could not be turned on here. Try again.';
      else S.push.error = "Can't reach " + S.pcName + '. Try again.';
    }
    S.push.busy = false;
    draw();
  }

  function openSetup() {
    S.screen = 'setup';
    S.push.permission = permissionNow();
    draw();
    root.scrollTo(0, 0);
  }

  function drawSetup() {
    const frag = doc.createDocumentFragment();
    frag.append(header('Finish setup'));
    const body = el('main', 'ph-setup');
    body.append(el('p', '', 'Paired with ' + S.pcName + '. You can close this and open it again any time.'));
    const steps = setupSteps({
      iphone: iphone(),
      standalone: standalone(),
      supported: pushSupported(),
      permission: permissionNow(),
      on: S.push.on,
      allowed: pushAllowed(),
      ...installFacts(),
    });
    let n = 0;
    for (const step of steps) {
      n++;
      const box = el('section', 'ph-step ' + step.state);
      box.dataset.step = step.id;
      box.dataset.state = step.state;
      box.append(el('p', 'ph-note', 'Step ' + n + (step.id === 'home' ? ' · iPhone only' : '')));
      box.append(el('h2', '', step.id === 'home' ? 'Add to Home Screen' : step.id === 'install' ? 'Install AIB' : 'Turn on notifications'));
      box.append(el('p', '', step.text));
      if (step.id === 'install' && step.kind === 'prompt') {
        const b = button('ph-btn', 'Install AIB', () => installNow());
        b.id = 'installAib';
        box.append(b);
      }
      if (step.id === 'notify' && step.state === 'todo' && !(iphone() && !standalone())) {
        const b = button('ph-btn', S.push.busy ? 'Turning on…' : 'Turn on notifications', () => turnOnNotifications());
        b.id = 'pushOn';
        b.disabled = S.push.busy;
        box.append(b);
      }
      if (step.id === 'notify' && S.push.error) {
        const e = el('p', 'ph-error', S.push.error);
        e.setAttribute('role', 'alert');
        box.append(e);
      }
      body.append(box);
    }
    const done = button('ph-btn quiet', 'Done', () => {
      S.screen = 'home';
      draw();
      tick();
    });
    done.id = 'setupDone';
    body.append(done);
    frag.append(body);
    return frag;
  }

  /* The page opened while AIB does not answer (the worker's copy): no chats to show, only what is wrong. */
  function drawOfflineStart() {
    const frag = doc.createDocumentFragment();
    frag.append(header('AIB', { sub: S.pcName, chip: ['Offline', 'off'] }));
    frag.append(offlineBox());
    return frag;
  }

  // ---- start ----
  async function start() {
    const m = /^#p=([0-9a-f]{12})$/i.exec(root.location.hash || '');
    if (m) S.pairSecret = m[1].toLowerCase();
    S.openOnStart = openTarget(root.location.hash) || S.openOnStart;
    if (root.location.hash) root.history.replaceState(null, '', root.location.pathname); // the secret leaves the address bar
    registerWorker();
    const saved = await stored('device');
    if (saved && saved.token) {
      S.token = saved.token;
      S.device = saved.device || null;
    }
    let boot;
    try {
      boot = await call('GET', '/api/remote/bootstrap');
    } catch (error) {
      // AIB is closed or the PC can't be reached: the service worker opened the page from its copy.
      S.screen = 'offline';
      goneOffline(error && error.message);
      draw();
      clearTimeout(S.timer);
      S.timer = setTimeout(() => retry(), S.offline && Date.now() - S.offlineSince < S.reconnectMs ? 2000 : HOME_MS);
      return;
    }
    S.booted = true;
    if (S.offline) {
      S.offline = false;
      S.offlineSince = 0;
    }
    if (boot.data.pcName) S.pcName = boot.data.pcName;
    if (boot.status === 401) return removed();
    if (boot.status !== 200) {
      S.screen = 'pair';
      S.pairing = { error: boot.data.error || 'This page only works through Tailscale on your phone.' };
      return draw();
    }
    if (boot.data.layout !== 'phone') return;
    takeTheme(boot.data);
    if (boot.data.paired) {
      S.device = boot.data.device;
      S.artifacts = typeof boot.data.artifacts === 'string' ? boot.data.artifacts : '';
      S.scopes = (boot.data.device && boot.data.device.scopes) || [];
      const push = boot.data.push || {};
      S.push.key = typeof push.key === 'string' ? push.key : '';
      S.push.on = push.on === true;
      bootPush(); // subscribe again on every page open (a new key after Remove all, a subscription the browser renewed)
      const open = S.openOnStart;
      S.openOnStart = null;
      if (open && open.chat) {
        openChat(open.chat, '', open.sheet);
        return;
      }
      S.screen = 'home';
      draw();
      tick();
      return;
    }
    S.screen = 'pair';
    draw();
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      clearTimeout(S.timer);
      left();
    }
    else if (S.screen === 'home' || S.screen === 'chat' || S.screen === 'saved') {
      clearTimeout(S.timer);
      tick();
    } else if (S.screen === 'offline') {
      clearTimeout(S.timer);
      retry();
    }
  });
  // A push's link while the page is already open (the same page, only the #chat=... part changes).
  root.addEventListener('hashchange', () => {
    const open = openTarget(root.location.hash);
    if (!open) return;
    root.history.replaceState(null, '', root.location.pathname);
    if (S.device && S.booted) openChat(open.chat, '', open.sheet);
    else S.openOnStart = open;
  });
  // Artifact links in replies (studio-artifact://<id>, or a link to the phone's artifact origin) open the viewer here.
  app.addEventListener('click', (event) => {
    const a = event.target && event.target.closest ? event.target.closest('a') : null;
    if (!a) return;
    const ref = a.dataset.artifactId
      ? { id: a.dataset.artifactId, version: 0 }
      : artifactRef(a.getAttribute('href'), S.artifacts);
    if (!ref || !ARTIFACT_ID.test(ref.id)) return;
    event.preventDefault();
    if (S.artifacts) openArtifact(ref.id, ref.version);
    else {
      S.viewer = { id: ref.id, version: ref.version, title: 'Artifact', kind: '', state: 'pc', why: '' };
      drawViewer();
    }
  });
  // Scrolled to the end of a chat: mark it read on the PC (markRead keeps to READ_MS).
  // and the "Needs you · Show ↑" bar follows its card in and out of view.
  root.addEventListener(
    'scroll',
    () => {
      markRead();
      checkAbove();
    },
    { passive: true },
  );
  root.addEventListener('resize', () => checkAbove(), { passive: true });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && S.menu) closeMenu();
    else if (event.key === 'Escape' && S.viewer && S.viewer.drop) {
      S.viewer.drop = false;
      drawViewer();
    } else if (event.key === 'Escape' && S.viewer) closeArtifact();
  });
  root.addEventListener('pagehide', left);
  root.__aibPhone = S; // tests read the page's state
  start();
})(typeof window !== 'undefined' ? window : globalThis);
