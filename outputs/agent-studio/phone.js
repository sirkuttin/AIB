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

  /* What this phone may do, from its switches: {answer, approve, send}. */
  function abilities(scopes) {
    const list = Array.isArray(scopes) ? scopes : [];
    return { answer: list.includes('phone.answer'), approve: list.includes('phone.approve'), send: list.includes('phone.prompt') };
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

  /* The Finish setup steps. o: {iphone, standalone, supported, permission ('default'|'granted'|'denied'), on (subscribed here),
     allowed (this phone's Push switch on the PC)}. [{id: 'home' | 'notify', state: 'todo' | 'done' | 'blocked' | 'off', text}] */
  function setupSteps(o) {
    const steps = [];
    if (o.iphone)
      steps.push({
        id: 'home',
        state: o.standalone ? 'done' : 'todo',
        text: o.standalone
          ? 'AIB is on your Home Screen.'
          : 'Tap the Share button, then Add to Home Screen. Open AIB from there: iPhone sends notifications only to apps on the Home Screen.',
      });
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

  const api = {
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
  function toast(text) {
    S.toast = text;
    if (!toastEl) {
      toastEl = el('div', 'ph-toast');
      toastEl.id = 'phToast';
      toastEl.setAttribute('role', 'status');
      doc.body.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      S.toast = '';
      toastEl.hidden = true;
    }, TOAST_MS);
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
    if (S.screen === 'chat' && (changed || noticed)) draw();
  }

  async function removed() {
    S.token = '';
    S.device = null;
    await stored('device', null);
    S.screen = 'removed';
    draw();
  }

  // ---- screens ----
  /* The header: Back (in a chat), the title with a line under it, and a chip on the right. opts: {back, sub (text or node), chip:
     [text, tone], extra (a node under the sub line)} */
  function header(title, opts) {
    const o = opts || {};
    const h = el('header', 'ph-head');
    if (o.back) {
      const b = button('ph-back', '', o.back);
      b.append(el('span', 'ph-chev', '‹'), doc.createTextNode('Chats'));
      b.setAttribute('aria-label', 'Back to all chats');
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
    if (o.chip) h.append(el('span', 'ph-chip ' + o.chip[1], o.chip[0]));
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
    return card;
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
    parts.push(header('AIB', { sub: S.pcName + (home ? ' · ' + all.length + (all.length === 1 ? ' chat' : ' chats') : ''), chip: liveChip() }));
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
      for (const item of list) cards.append(chatCard(item, now));
      body.append(cards);
    }
    parts.push(body);
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
    bar.append(name, close);
    box.append(bar);
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
    close.focus({ preventScroll: true });
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
    const parts = [
      header(title, {
        back: goHome,
        sub: project ? projectLine(project, [agent]) : agent,
        extra,
        chip: S.offline ? ['Offline', 'off'] : w ? [w.text.split(' · ')[0], w.tone] : null,
      }),
    ];
    if (S.offline) parts.push(offlineBox());
    parts.push(chatMain());
    if (!c || c.gone) return parts;
    const can = abilities(S.scopes);
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
    const op = c.busy ? (c.steerable ? 'steer' : 'queue') : 'prompt';
    const done = await act(op, { id: c.id, text, clientMessageId: newMessageId() });
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
    });
    let n = 0;
    for (const step of steps) {
      n++;
      const box = el('section', 'ph-step ' + step.state);
      box.dataset.step = step.id;
      box.dataset.state = step.state;
      box.append(el('p', 'ph-note', 'Step ' + n + (step.id === 'home' ? ' · iPhone only' : '')));
      box.append(el('h2', '', step.id === 'home' ? 'Add to Home Screen' : 'Turn on notifications'));
      box.append(el('p', '', step.text));
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
    if (event.key === 'Escape' && S.viewer) closeArtifact();
  });
  root.addEventListener('pagehide', left);
  root.__aibPhone = S; // tests read the page's state
  start();
})(typeof window !== 'undefined' ? window : globalThis);
