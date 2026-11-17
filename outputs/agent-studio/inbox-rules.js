(function (root) {
  'use strict';
  // The inbox's rules ("who needs you, across all projects"), in ONE place for every surface: the page's inbox, badge, window
  // title and in-page toasts (workspace-state.js, workspace-ui.js, sidebar-ui.js, notify-ui.js), the server's notifications
  // (server/attention/watcher.ts), the phone's home (server/remote/payloads.ts), both tray icons (server/main.ts and the agent
  // host's, server/host/agent_host.ts) and the agent connection's own facts (server/acp/connection.ts). Pure: no DOM, no clock,
  // no storage; the page loads it as a script, the server imports it (server/attention/inbox_rules.ts).
  //
  // One phase per chat, from the agent connection's attention facts and the chat's marks (studio-conversations.json):
  //   needs_you  an approval, a question or a sign-in of the agent or one of its helpers is open.
  //   failed     the last turn ended in an error the AGENT reported (usage limit, prompt too long, connection refused). A Stop is
  //              never a failure, and neither is AIB's own reconnecting: connection.ts records only the agent's prompt errors.
  //   asks       the last reply asks you something in plain text (asksOf below: rule R6 of the usage study, 2026-11-13).
  //   stalled    the agent stopped mid-work without saying it was done (Inbox v3.1): it died mid-turn (S1), its turn ended with no
  //              final message (S2), or a running turn has been quiet QUIET_SECONDS with nothing running (S3). stallOf below.
  //   working    a turn runs, or the chat's helpers (Claude Code) or background shells still run, or the follow-up window after
  //              the last of them ended (the agent usually starts its own follow-up within 20 s).
  //   your_turn  finished: the agent handed back and nothing runs. Listed under To review, never counted.
  //   idle / opening / closed
  // Blocked = needs_you, failed, asks or stalled: the inbox's "Needs you" section, and the ONE number every badge, title and tray shows.
  //
  // Open on the PC (openKeys, isOpen): the chat shown in the AIB window's active tab (and any split pane showing a chat), while
  // the window is visible, focused or not. It is already in front of you, so the DESKTOP leaves it out: no inbox row, not in
  // the badge, title, tray count or taskbar dot, no desktop notification or sound. Phones still count it, and pushes still go
  // by presence (server/attention/presence.ts). Minimized or closed to the tray: nothing is open.

  const FOLLOW_UP_SECONDS = 20; // helper or shell ended -> the agent's own follow-up starts within this (AIB: 100% in 20 s)
  const SHELL_CAP_SECONDS = 30 * 60; // a background shell counts as work this long at most (97% end within 30 min)
  const HELPER_CAP_SECONDS = 60 * 60; // a helper counts until its own end report, but this long at most (94% end within 60 min)
  const ASK_MIN_CHARS = 160; // shorter replies are greetings and small talk, not questions that block work
  const LONG_WAIT_SECONDS = 15 * 60; // a wait this long turns orange (only 10% of real questions wait longer)
  const QUIET_SECONDS = 20 * 60; // stalled (S3): a running turn with no output this long and nothing else running
  const TOOL_CAP_SECONDS = 60 * 60; // a tool call in progress counts as work this long at most (the helpers' cap)
  // The stall signals that make a row (Inbox v3.1 phase 2): S1 'died' (the agent's output ended mid-turn: can't misfire), S2
  // 'silent_end' (the turn ended with no final message) and S3 'quiet' (no output for QUIET_SECONDS while working with nothing
  // running) are on only as far as the keeper-journal check allowed (see the commit and the build report for the numbers).
  const STALL_ON = ['died', 'silent_end', 'quiet'];
  const BLOCKED = ['needs_you', 'failed', 'asks', 'stalled'];

  const isStr = (v) => typeof v === 'string' && v.length > 0;
  // An attention time (ISO text, or epoch seconds) as epoch seconds; 0 when there is none.
  function secondsOf(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
    if (!isStr(v)) return 0;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t / 1000 : 0;
  }

  // ---- plain-text questions: rule R6 ---------------------------------------------------------------------------------------
  // A reply asks you something when, outside code (fenced or inline), `>` quotes and quoted text:
  //   * its last paragraph has a "?", or
  //   * one of its sentences is a question aimed at you (you, your, should I, want me, which ..., a choice "A or B?", a numbered
  //     decision), or
  //   * it says it is waiting on you ("waiting on you", "your call", "still open", "need your answer", "your go" ...).
  // Replies under ASK_MIN_CHARS never ask. Measured on the owner's own 7 days: 86% precise, 90% of real questions found.
  const OWNER_WORDS =
    /\b(you|your|yours|should i|shall i|should we|shall we|want me|do i|can i|may i|which|ok to|okay to|good to|go ahead)\b/i;
  const ASKING_START = /^(should|shall|may|can|could|would|will|do|does|did|want|are you|have you)\b/i;
  const PENDING =
    /\b(waiting (on|for) (you|your)\b|your call\b|still open\b|need your (answer|reply|go|decision|input|ok|okay)\b|your go\b|until you decide\b|your (answer|decision) (is )?(still )?(needed|pending)\b)/i;
  const REPORTED = /\bthe question (was|is)\b/i;

  // The reply as prose: no code, no `>` quotes, no quoted text; each kept line knows whether it is a heading.
  function proseLines(text) {
    const out = [];
    let fence = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(raw)) {
        fence = !fence;
        out.push({ text: '', heading: false });
        continue;
      }
      if (fence || /^\s*>/.test(raw)) {
        out.push({ text: '', heading: false });
        continue;
      }
      let line = raw
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/"[^"\n]*"/g, ' ')
        .replace(/“[^”\n]*”/g, ' ');
      const t = line.trim();
      const heading = /^#{1,6}\s/.test(t) || /^(\*\*|__)[^*_]+(\*\*|__)$/.test(t);
      line = line.replace(/\*\*|__/g, '');
      out.push({ text: line, heading });
    }
    return out;
  }
  // The question sentences of a stretch of prose (each ends with "?").
  // (a full stop inside a word, as in "beta.3", does not end a sentence)
  // One pass, in linear time: the regex /(?:[^.!?\n]|[.!](?=\S))*\?/g said the same but retried from every character of a line
  // without a "?" (quadratic: a 3 MB reply line held the server for minutes).
  function questionsIn(s) {
    const text = String(s);
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '?') {
        const q = text.slice(start, i + 1).trim();
        if (q.length > 1) out.push(q);
        start = i + 1;
      } else if (ch === '\n' || ((ch === '.' || ch === '!') && !/\S/.test(text[i + 1] ?? ''))) start = i + 1;
    }
    return out;
  }
  function aimedAtYou(q, line, heading) {
    if (REPORTED.test(line)) return false;
    if (OWNER_WORDS.test(q)) return true;
    if (heading) return false; // a heading phrased as a question ("Why not make it offline?") asks nobody
    const bare = q.replace(/^[\s\-*+•\d.)]+/, '');
    if (ASKING_START.test(bare) || ASKING_START.test(bare.split(':').pop().trim())) return true; // "One question: should ...?"
    if (/\bor\b/i.test(q)) return true; // a choice: "Rewrite or just make it readable?"
    return /^\s*(\d+[.)]|[-*+•])\s/.test(line); // a numbered or listed decision
  }
  const clip = (s, n) => {
    const t = String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
  };
  // {asks, question}: does this reply ask you something, and the words of it (the last such sentence, at most 300 characters).
  function asksOf(text) {
    const whole = String(text || '');
    if (whole.trim().length < ASK_MIN_CHARS) return { asks: false, question: '' };
    const lines = proseLines(whole);
    let found = '';
    for (const l of lines) {
      for (const q of questionsIn(l.text)) if (aimedAtYou(q, l.text, l.heading)) found = q;
      if (!l.heading) {
        const p = l.text.match(PENDING);
        if (p) found = l.text.trim();
      }
    }
    // the last paragraph: the lines after the last blank line (headings and code count as nothing)
    let end = lines.length;
    while (end > 0 && !lines[end - 1].text.trim()) end--;
    let start = end;
    while (start > 0 && lines[start - 1].text.trim()) start--;
    const last = lines
      .slice(start, end)
      .filter((l) => !l.heading)
      .map((l) => l.text)
      .join(' ');
    const lastQ = questionsIn(last).filter((q) => !REPORTED.test(last));
    if (lastQ.length) found = lastQ[lastQ.length - 1];
    return found ? { asks: true, question: clip(found, 300) } : { asks: false, question: '' };
  }

  // ---- failed turns -----------------------------------------------------------------------------------------------------------
  // What kind of failure an agent's error is: limit (usage or rate limit, quota, prompt too long), auth (sign in again), network
  // (could not connect), crash (the agent itself broke) or other.
  function classifyError(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return '';
    if (/usage limit|session limit|rate limit|rate_limit|quota|credits used|out of credits|too many requests|\b429\b|limit reached|hit your .*limit|prompt is too long|context length|too long/.test(t))
      return 'limit';
    if (/auth|sign in|signin|log in|login|credential|unauthori[sz]ed|\b401\b|forbidden|\b403\b|api key|subscription/.test(t)) return 'auth';
    if (/connect|network|econn|timed? ?out|socket|dns|unreachable|offline|\b50[234]\b|overloaded/.test(t)) return 'network';
    if (/crash|panic|exited|segfault|internal error|traceback|exception/.test(t)) return 'crash';
    return 'other';
  }

  // ---- the phase of one chat ----------------------------------------------------------------------------------------------
  // The connection's own phase, before any marks (connection.ts attention().phase). f: {closed, ready, busy, needs, failedAt,
  // asksAt, helpers, shells, followUntil} (times in epoch seconds), now in epoch seconds.
  function basePhase(f, now) {
    const x = f || {};
    if (x.closed) return 'closed';
    if (Number(x.needs) > 0) return 'needs_you';
    if (x.ready === false) return 'opening';
    if (x.busy) return 'working';
    if (secondsOf(x.failedAt)) return 'failed';
    if (secondsOf(x.asksAt)) return 'asks';
    if (Number(x.helpers) > 0 || x.shells || secondsOf(x.followUntil) > (Number(now) || 0)) return 'working';
    return 'idle';
  }

  // The phase every surface shows. attention: the connection's attention() (an older agent host without the new facts reads as
  // before: needs_you / working / opening / idle). mark: the chat's marks entry ({yourTurnAt, handledAt, holdAt, archivedAt,
  // deletedAt}, seconds) or nothing. now: epoch seconds. Mark handled and putting a chat on hold clear a failure or a question
  // the agent reported before; a new one after that counts again. Sending clears both on the connection (a new turn starts).
  function phaseOf(attention, mark, now) {
    const a = attention && typeof attention === 'object' ? attention : {};
    const m = mark && typeof mark === 'object' ? mark : {};
    const state = isStr(a.state) ? a.state : 'idle';
    // stalled (Inbox v3.1): the agent stopped mid-work. A closed chat whose agent died mid-turn (S1, or a silent end, S2, saved
    // as a mark by the watcher) stays a row; a running turn gone quiet (S3) is one while it stays quiet.
    if (state === 'closed') return !m.archivedAt && !m.deletedAt && stallOf(a, m) ? 'stalled' : 'closed';
    if (state === 'needs_you' || state === 'opening') return state;
    if (state === 'working') {
      const s = stallOf(a, m);
      return s && s.kind === 'quiet' ? 'stalled' : 'working';
    }
    const handled = Math.max(Number(m.handledAt) || 0, Number(m.holdAt) || 0);
    const failed = secondsOf(a.failedAt),
      asks = secondsOf(a.asksAt);
    if (failed && failed > handled) return 'failed';
    if (asks && asks > handled) return 'asks';
    if (Number(a.helpers) > 0 || a.shells || secondsOf(a.followUntil) > (Number(now) || 0)) return 'working';
    const stall = stallOf(a, m);
    if (stall && stall.kind !== 'quiet') return 'stalled';
    const parked = m.holdAt || m.archivedAt || m.deletedAt;
    return Number(m.yourTurnAt) > 0 && !parked ? 'your_turn' : 'idle';
  }
  const blocked = (phase) => BLOCKED.indexOf(phase) >= 0;
  // When the chat started waiting on you (epoch seconds), for "waited 12m" and the oldest-first order: the agent's report time for
  // a failure or a question; for an open request, `requestAt` (the server's or the page's own first sight of it).
  function waitingSince(phase, attention, requestAt, mark) {
    const a = attention || {};
    if (phase === 'failed') return secondsOf(a.failedAt);
    if (phase === 'asks') return secondsOf(a.asksAt);
    if (phase === 'needs_you') return Number(requestAt) || 0;
    if (phase === 'stalled') {
      const s = stallOf(a, mark);
      return s ? s.at : secondsOf(a.stalledAt);
    }
    return 0;
  }

  // ---- rows, sections, the count -------------------------------------------------------------------------------------------
  // The reason word on a row (GitHub-style): what it wants from you.
  function reasonOf(phase, kinds) {
    if (phase === 'failed') return 'failed';
    if (phase === 'stalled') return 'stalled';
    if (phase === 'asks') return 'asks';
    if (phase === 'your_turn') return 'finished';
    const list = Array.isArray(kinds) ? kinds.map((k) => (k && k.kind) || k) : [];
    if (list.indexOf('auth') >= 0) return 'signin';
    if (list.indexOf('question') >= 0) return 'question';
    return 'approval';
  }
  const REASON_WORDS = {
    approval: 'Approval',
    question: 'Question',
    signin: 'Sign-in',
    asks: 'Asks',
    failed: 'Failed',
    stalled: 'Stalled',
    finished: 'Finished',
  };
  const reasonWord = (r) => REASON_WORDS[r] || 'Needs you';
  // The inbox panel's two section names, in one place (the owner may still rename the second; 2026-11-13: 'To review').
  // The panel shows no reason word on a row any more: line 1 is the request itself.
  const NEEDS_LABEL = 'Needs you';
  const REVIEW_LABEL = 'To review';
  const NOTHING_BLOCKED = 'Nothing blocked';
  // "2 subagents running" (the agent's own subagents still at work; the facts call them helpers), '' for none.
  const helpersLine = (n) => (Number(n) > 0 ? n + (Number(n) === 1 ? ' subagent' : ' subagents') + ' running' : '');
  // "waited 42m", "waited 1h 05m" (now and since in epoch seconds); long: past LONG_WAIT_SECONDS.
  function waitText(since, now) {
    const s = Math.max(0, Math.floor((Number(now) || 0) - (Number(since) || 0)));
    const m = Math.floor(s / 60);
    const text = m < 1 ? 'just now' : m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    return { text, long: s >= LONG_WAIT_SECONDS };
  }
  // Rows in their order: Needs you first, the longest wait first (new requests join at the bottom, so the row under the pointer
  // stays put); then Finished, newest first. Each row: {section: 'needs' | 'finished', since (needs) or at (finished), key}.
  function sortRows(rows) {
    const rank = (r) => (r.section === 'needs' ? 0 : 1);
    return (rows || []).slice().sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.section === 'needs') return (a.since || 0) - (b.since || 0) || String(a.key).localeCompare(String(b.key));
      return (b.at || 0) - (a.at || 0) || String(a.key).localeCompare(String(b.key));
    });
  }
  // The one number: chats blocked on you (rows in Needs you). Finished never counts.
  const countOf = (rows) => (rows || []).filter((r) => r && r.section === 'needs').length;
  // The chats open on the PC: {selected (the active tab's chat key), panes (the chat keys split panes show), visible (the window
  // is not minimized or hidden)}. Unique keys, or [] while the window is hidden.
  function openKeys(o) {
    const x = o || {};
    if (x.visible === false) return [];
    const out = [];
    for (const k of [x.selected].concat(Array.isArray(x.panes) ? x.panes : []))
      if (isStr(k) && k.length <= 400 && out.indexOf(k) < 0) out.push(k);
    return out.slice(0, 20);
  }
  // Is this chat (its page key, "provider:sessionId") open on the PC? open: openKeys().
  const isOpen = (key, open) => isStr(key) && Array.isArray(open) && open.indexOf(key) >= 0;
  // How many of these chats are blocked on you: [{attention, mark, key?}] (the trays and the phone count this way). open: the
  // chats open on the PC (the desktop's own count leaves them out; the phone passes none).
  const countBlocked = (chats, now, open) =>
    (chats || []).filter((c) => c && !isOpen(c.key, open) && blocked(phaseOf(c.attention, c.mark, now))).length;

  // ---- server-built rows (Inbox v3.1 phase 1) ------------------------------------------------------------------------------
  // ONE builder of the inbox's rows, counts and phases: the server runs it (server/attention/inbox.ts) for GET /api/live/inbox,
  // the phone's home (home.inbox), the notifications and both trays; the PC page and the phone only draw what it returns. Pure.
  //
  // A chat's facts (the server gathers them from the agent host's list, the marks file and one state read per change):
  //   {key, id, title, project: {key, name}, provider, agent, attention, mark, live (a running connection), requestAt (s: when the
  //    server first saw the open request), request ({kind: 'permission' | 'question', key, params}: the first open one, capped),
  //    more (other open requests), elicitations, auth, lastText (the agent's last words), lastStep (its last tool call's title)}
  // A row: {key, id, section: 'needs' | 'review', kind: approval | question | signin | asks | failed | stalled | finished, what
  //   (line 1, ready to show), whatCode (the part drawn as code), title, project, provider, agent, since (s: the wait's start;
  //   needs), at (s), needs, more, helpers, request, ask (the error, the question or the agent's words in full), stall, actions}.
  const clipText = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
  };
  const WHAT_MAX = 300;
  // Line 1 of an approval: "Run <command>", "Edit <file>", else the tool's own title. {what, code}.
  function requestWhat(req) {
    const r = req && typeof req === 'object' ? req : {};
    const p = r.params && typeof r.params === 'object' ? r.params : {};
    if (r.kind === 'question') return { what: clipText(p.message, WHAT_MAX) || 'The agent has a question', code: '' };
    const tc = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : {};
    const input = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
    const cmd = isStr(input.command) ? input.command : Array.isArray(input.command) ? input.command.filter(isStr).join(' ') : '';
    if (cmd.trim()) {
      const c = clipText(cmd, WHAT_MAX - 4);
      return { what: 'Run ' + c, code: c };
    }
    const file = isStr(input.file_path) ? input.file_path : isStr(input.path) ? input.path : '';
    const title = clipText(tc.title || p.title, WHAT_MAX);
    if (file && (/^(edit|write|multiedit|create|update|apply)/i.test(String(tc.title || '')) || tc.kind === 'edit')) {
      const f = clipText(file, WHAT_MAX - 5);
      return { what: 'Edit ' + f, code: f };
    }
    return { what: title || (file ? clipText(file, WHAT_MAX) : 'The agent asks to run something'), code: '' };
  }
  // Line 1 of a stalled row: what happened, and the agent's last step when it is known.
  function stallWhat(kind, step) {
    const s = clipText(step, 160);
    if (kind === 'died') return 'Stopped mid-work: the agent quit' + (s ? ' during ' + s : '');
    if (kind === 'quiet') return 'No output for ' + Math.round(QUIET_SECONDS / 60) + ' minutes' + (s ? ', last: ' + s : '');
    return 'Stopped without a final message' + (s ? ', after ' + s : '');
  }
  // The row's ONE action row (ids; each surface draws them in its own words). Approvals and questions are answered with the
  // request's own options (the row's request), so they list 'answer' first.
  const ACTIONS = {
    approval: [{ id: 'answer' }, { id: 'snooze' }],
    question: [{ id: 'answer' }, { id: 'handled', quiet: true }, { id: 'snooze' }],
    signin: [{ id: 'open' }, { id: 'handled', quiet: true }, { id: 'snooze' }],
    asks: [{ id: 'reply', label: 'Reply', default: true }, { id: 'handled', label: 'Mark handled', quiet: true }, { id: 'snooze' }],
    failed: [
      { id: 'retry', label: 'Retry', default: true },
      { id: 'reply', label: 'Reply' },
      { id: 'handled', label: 'Mark handled', quiet: true },
      { id: 'snooze' },
    ],
    stalled: [
      { id: 'continue', label: 'Continue', default: true },
      { id: 'reply', label: 'Reply' },
      { id: 'handled', label: 'Mark handled', quiet: true },
      { id: 'snooze' },
    ],
    finished: [{ id: 'reply', label: 'Reply' }, { id: 'handled', label: '×', quiet: true }],
  };
  // What Continue sends to a stalled chat.
  const CONTINUE_TEXT = 'Continue where you left off.';
  // The stall a chat shows ({kind, at, step}) or null: the live facts (S2 at the turn's end, S3 while it runs) and the saved mark
  // (S1 and S2, kept by the watcher because a closed connection can leave the list). Only after the last Mark handled / send.
  function stallOf(attention, mark) {
    const a = attention || {},
      m = mark || {};
    const handled = Math.max(Number(m.handledAt) || 0, Number(m.holdAt) || 0);
    const live = secondsOf(a.stalledAt),
      saved = Number(m.stalledAt) || 0;
    const pick =
      live >= saved && live
        ? { kind: String(a.stallKind || ''), at: live, step: String(a.stallStep || '') }
        : saved
          ? { kind: String(m.stallKind || ''), at: saved, step: String(m.stallStep || '') }
          : null;
    if (!pick || pick.at <= handled || STALL_ON.indexOf(pick.kind) < 0) return null;
    return pick;
  }
  // Snoozed: until a time (mark.snoozedUntil), unless the row changed since it was snoozed (a new request, a new reply that asks,
  // a new failure or stall: its signature differs from mark.snoozeSig, which the snooze saved). now in seconds. The signature
  // lives in the marks file, so a snooze survives a restart and still wakes early on a change.
  function snoozedOf(mark, sig, now) {
    const m = mark || {};
    const until = Number(m.snoozedUntil) || 0;
    if (!until || until <= (Number(now) || 0)) return 0;
    if (isStr(m.snoozeSig) && m.snoozeSig !== String(sig || '')) return 0;
    return until;
  }
  // A row's signature: what it waits on. It changes with a new request, a new failure, a new question in a reply or a new stall.
  function sigOf(row) {
    const r = row || {};
    const req = r.request && r.request.params ? r.request.params : {};
    const tc = req.toolCall && typeof req.toolCall === 'object' ? req.toolCall : {};
    const id = r.kind === 'approval' || r.kind === 'question' || r.kind === 'signin' ? String(tc.toolCallId || (r.request && r.request.key) || r.what || '') : '';
    return r.kind + '|' + (id || Math.round(Number(r.since) || 0));
  }
  // When "Snooze until tomorrow" wakes (local time 9:00; before 6:00 that is today at 9:00). now: epoch ms. Returns epoch s.
  function tomorrowNine(nowMs) {
    const d = new Date(Number(nowMs) || 0);
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0, 0);
    if (d.getHours() >= 6) t.setDate(t.getDate() + 1);
    return Math.floor(t.getTime() / 1000);
  }
  // The two snooze choices: [{id, label, until (s)}].
  function snoozeChoices(nowMs) {
    const now = Number(nowMs) || 0;
    return [
      { id: 'hour', label: '1 hour', until: Math.floor(now / 1000) + 3600 },
      { id: 'tomorrow', label: 'Tomorrow 9:00', until: tomorrowNine(now) },
    ];
  }
  // One chat's row, or null (nothing for the inbox). now: epoch seconds.
  function rowOf(c, now) {
    const x = c && typeof c === 'object' ? c : {};
    const m = x.mark && typeof x.mark === 'object' ? x.mark : {};
    if (m.archivedAt || m.deletedAt) return null;
    const a = x.live && x.attention && typeof x.attention === 'object' ? x.attention : { state: 'closed' };
    const phase = phaseOf(a, m, now);
    const stall = phase === 'stalled' ? stallOf(a, m) : null;
    const project = x.project && typeof x.project === 'object' ? x.project : {};
    const base = {
      key: String(x.key || ''),
      id: String(x.id || ''),
      title: clipText(x.title, 200) || 'Conversation',
      project: { key: String(project.key || ''), name: clipText(project.name, 120) || 'No folder' },
      provider: String(x.provider || ''),
      agent: String(x.agent || x.provider || ''),
      helpers: Number(a.helpers) || 0,
      needs: 0,
      more: 0,
    };
    if (phase === 'needs_you') {
      const req = x.request && typeof x.request === 'object' ? x.request : null;
      const kind = x.auth ? 'signin' : Number(x.elicitations) > 0 || (req && req.kind === 'question') ? 'question' : 'approval';
      const w =
        kind === 'signin'
          ? { what: 'Sign in to the agent again to continue', code: '' }
          : req
            ? requestWhat(req)
            : { what: kind === 'question' ? 'The agent has a question' : 'The agent asks to run something', code: '' };
      const since = Number(x.requestAt) || 0;
      return Object.assign(base, {
        section: 'needs',
        kind,
        what: w.what,
        whatCode: w.code,
        since,
        at: since,
        needs: Math.max(1, Number(a.needs) || 0),
        more: Math.max(0, Number(x.more) || 0),
        request: req,
        ask: kind === 'question' && req ? clipText(req.params && req.params.message, 2000) : '',
        actions: ACTIONS[kind],
      });
    }
    if (phase === 'failed' || phase === 'asks') {
      const words = String((phase === 'failed' ? a.error : a.question) || '').trim();
      const since = waitingSince(phase, a, 0);
      return Object.assign(base, {
        section: 'needs',
        kind: phase,
        what: clipText(words, WHAT_MAX) || (phase === 'failed' ? 'The last turn ended with an error.' : 'The agent asks you something'),
        whatCode: '',
        since,
        at: since,
        request: null,
        ask: clipText(phase === 'asks' && x.lastText ? x.lastText : words, 2000),
        failKind: phase === 'failed' ? String(a.failKind || classifyError(words)) : '',
        actions: ACTIONS[phase],
      });
    }
    if (phase === 'stalled' && stall) {
      const step = stall.step || x.lastStep || '';
      return Object.assign(base, {
        section: 'needs',
        kind: 'stalled',
        what: stallWhat(stall.kind, step),
        whatCode: '',
        since: stall.at,
        at: stall.at,
        request: null,
        ask: clipText(x.lastText, 2000),
        stall: { kind: stall.kind, lastStep: clipText(step, 160), at: stall.at },
        actions: ACTIONS.stalled,
      });
    }
    if (phase === 'your_turn') {
      const at = Number(m.yourTurnAt) || secondsOf(a.turnEndedAt) || 0;
      const words = String(x.lastText || '').trim();
      const first =
        words
          .split(/\r?\n/)
          .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
          .find(Boolean) || '';
      return Object.assign(base, {
        section: 'review',
        kind: 'finished',
        what: clipText(first, WHAT_MAX) || 'Done.',
        whatCode: '',
        since: 0,
        at,
        request: null,
        ask: clipText(words, 2000),
        actions: ACTIONS.finished,
      });
    }
    return null;
  }
  // The whole inbox: {rows (Needs you first, the longest wait first; then To review, newest first), count (Needs you rows not
  // open on the PC), working {chats, projects}, snoozed [{key, what, title, project, until, kind}]}. chats: facts as above.
  // opts: {open: chat keys open on the PC (left out of the count and the rows)}. Needs-you rows carry `sig` (sigOf).
  function rowsOf(chats, now, opts) {
    const o = opts || {};
    const open = Array.isArray(o.open) ? o.open : [];
    const rows = [],
      snoozed = [];
    const busy = new Set(),
      busyProjects = new Set();
    for (const c of chats || []) {
      if (!c || typeof c !== 'object') continue;
      const m = c.mark || {};
      if (m.archivedAt || m.deletedAt) continue;
      const a = c.live && c.attention ? c.attention : { state: 'closed' };
      if (phaseOf(a, m, now) === 'working') {
        busy.add(c.key);
        busyProjects.add((c.project && c.project.key) || '');
      }
      const r = rowOf(c, now);
      if (!r || isOpen(r.key, open)) continue;
      if (r.section === 'needs') {
        r.sig = sigOf(r);
        const until = snoozedOf(m, r.sig, now);
        if (until) {
          snoozed.push({ key: r.key, id: r.id, kind: r.kind, what: r.what, title: r.title, project: r.project, since: r.since, until });
          continue;
        }
      }
      rows.push(r);
    }
    const sorted = sortRows(rows);
    snoozed.sort((a, b) => a.until - b.until || String(a.key).localeCompare(String(b.key)));
    return {
      rows: sorted,
      count: countOf(sorted),
      working: { chats: busy.size, projects: busyProjects.size },
      snoozed,
    };
  }
  // "Working: 5 chats in 3 projects" (the inbox's foot), '' when nothing works.
  function workingText(w) {
    const n = Number(w && w.chats) || 0,
      p = Number(w && w.projects) || 0;
    if (!n) return '';
    return 'Working: ' + n + (n === 1 ? ' chat' : ' chats') + (p > 1 ? ' in ' + p + ' projects' : '');
  }
  // "until 15:40" / "until tomorrow 9:00" for a snoozed row (until in s; now in ms).
  function untilText(until, nowMs) {
    const d = new Date((Number(until) || 0) * 1000),
      n = new Date(Number(nowMs) || 0);
    const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return 'until ' + (same ? hm : 'tomorrow ' + hm);
  }

  const api = {
    QUIET_SECONDS,
    TOOL_CAP_SECONDS,
    CONTINUE_TEXT,
    STALL_ON,
    requestWhat,
    stallWhat,
    stallOf,
    snoozedOf,
    sigOf,
    snoozeChoices,
    tomorrowNine,
    rowOf,
    rowsOf,
    workingText,
    untilText,
    FOLLOW_UP_SECONDS,
    SHELL_CAP_SECONDS,
    HELPER_CAP_SECONDS,
    ASK_MIN_CHARS,
    LONG_WAIT_SECONDS,
    NEEDS_LABEL,
    REVIEW_LABEL,
    NOTHING_BLOCKED,
    secondsOf,
    asksOf,
    classifyError,
    basePhase,
    phaseOf,
    blocked,
    waitingSince,
    reasonOf,
    reasonWord,
    helpersLine,
    waitText,
    sortRows,
    countOf,
    countBlocked,
    openKeys,
    isOpen,
  };
  root.AgentInboxRules = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
