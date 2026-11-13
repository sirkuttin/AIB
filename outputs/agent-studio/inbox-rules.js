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
  //   working    a turn runs, or the chat's helpers (Claude Code) or background shells still run, or the follow-up window after
  //              the last of them ended (the agent usually starts its own follow-up within 20 s).
  //   your_turn  finished: the agent handed back and nothing runs. Listed under Finished, never counted.
  //   idle / opening / closed
  // Blocked = needs_you, failed or asks: the inbox's "Needs you" section, and the ONE number every badge, title and tray shows.

  const FOLLOW_UP_SECONDS = 20; // helper or shell ended -> the agent's own follow-up starts within this (AIB: 100% in 20 s)
  const SHELL_CAP_SECONDS = 30 * 60; // a background shell counts as work this long at most (97% end within 30 min)
  const HELPER_CAP_SECONDS = 60 * 60; // a helper counts until its own end report, but this long at most (94% end within 60 min)
  const ASK_MIN_CHARS = 160; // shorter replies are greetings and small talk, not questions that block work
  const LONG_WAIT_SECONDS = 15 * 60; // a wait this long turns orange (only 10% of real questions wait longer)
  const BLOCKED = ['needs_you', 'failed', 'asks'];

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
    if (state === 'closed' || state === 'needs_you' || state === 'opening' || state === 'working') return state;
    const handled = Math.max(Number(m.handledAt) || 0, Number(m.holdAt) || 0);
    const failed = secondsOf(a.failedAt),
      asks = secondsOf(a.asksAt);
    if (failed && failed > handled) return 'failed';
    if (asks && asks > handled) return 'asks';
    if (Number(a.helpers) > 0 || a.shells || secondsOf(a.followUntil) > (Number(now) || 0)) return 'working';
    const parked = m.holdAt || m.archivedAt || m.deletedAt;
    return Number(m.yourTurnAt) > 0 && !parked ? 'your_turn' : 'idle';
  }
  const blocked = (phase) => BLOCKED.indexOf(phase) >= 0;
  // When the chat started waiting on you (epoch seconds), for "waited 12m" and the oldest-first order: the agent's report time for
  // a failure or a question; for an open request, `requestAt` (the server's or the page's own first sight of it).
  function waitingSince(phase, attention, requestAt) {
    const a = attention || {};
    if (phase === 'failed') return secondsOf(a.failedAt);
    if (phase === 'asks') return secondsOf(a.asksAt);
    if (phase === 'needs_you') return Number(requestAt) || 0;
    return 0;
  }

  // ---- rows, sections, the count -------------------------------------------------------------------------------------------
  // The reason word on a row (GitHub-style): what it wants from you.
  function reasonOf(phase, kinds) {
    if (phase === 'failed') return 'failed';
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
    finished: 'Finished',
  };
  const reasonWord = (r) => REASON_WORDS[r] || 'Needs you';
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
  // How many of these chats are blocked on you: [{attention, mark}] (the trays and the phone count this way).
  const countBlocked = (chats, now) => (chats || []).filter((c) => c && blocked(phaseOf(c.attention, c.mark, now))).length;

  const api = {
    FOLLOW_UP_SECONDS,
    SHELL_CAP_SECONDS,
    HELPER_CAP_SECONDS,
    ASK_MIN_CHARS,
    LONG_WAIT_SECONDS,
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
  };
  root.AgentInboxRules = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
