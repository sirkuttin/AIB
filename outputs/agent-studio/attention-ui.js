(function (root) {
  'use strict';
  // "Whose turn is it": one description of the selected conversation, used for BOTH the header badge
  // (short label) and the line above the composer (long text). Everything is set with textContent.
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000)),
      h = Math.floor(total / 3600),
      m = Math.floor((total % 3600) / 60),
      s = total % 60;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + String(s).padStart(2, '0') + 's' : s + 's';
  }

  // Compact elapsed time for the header pill: "45s", "4m", "1h 05m".
  function shortElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000)),
      h = Math.floor(total / 3600),
      m = Math.floor((total % 3600) / 60);
    return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m ? m + 'm' : total + 's';
  }

  // Group pending approvals / questions / sign-in by the agent that is asking.
  function pendingGroups(snapshot, names, mainSessionId) {
    const groups = new Map(),
      totals = { approvals: 0, questions: 0, signIn: 0 };
    const add = (kind, sessionId, route) => {
      const label =
        route === 'setup' || sessionId == null
          ? 'Setup'
          : sessionId === mainSessionId || route === 'main'
            ? 'Main agent'
            : (names && names[sessionId]) || 'Subagent';
      const g = groups.get(label) || { label, approvals: 0, questions: 0, signIn: 0, sessionId };
      g[kind]++;
      totals[kind]++;
      groups.set(label, g);
    };
    for (const p of (snapshot && snapshot.permissions) || []) add('approvals', p.params && p.params.sessionId, p.route);
    for (const q of (snapshot && snapshot.elicitations) || [])
      add('questions', q.params && q.params.sessionId, q.route);
    if (snapshot && snapshot.auth) add('signIn', mainSessionId, 'main');
    return { groups: [...groups.values()], totals };
  }

  function countsText(t) {
    const parts = [];
    if (t.approvals) parts.push(plural(t.approvals, 'approval', 'approvals'));
    if (t.questions) parts.push(plural(t.questions, 'question', 'questions'));
    if (t.signIn) parts.push('sign-in');
    return parts.join(', ');
  }

  function turnStart(events, now, fallback) {
    // The newest user message that no later turn_end follows; otherwise when we first saw the agent busy.
    for (let i = (events || []).length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'turn_end') break;
      if (e.kind === 'user' && typeof e.time === 'number') return Math.min(now, e.time * 1000);
    }
    return fallback == null ? now : fallback;
  }

  const words = () => root.AgentStatusWords || (typeof require === 'function' ? require('./status-words.js') : null);

  // model: {connectionIssue, opening, connected, snapshot, events, names, now, busySince, yourTurn, handledAt, hint, elsewhereWorking}
  // `kind` / `short` / `text` / `detail` keep their old meaning; `status` and `pill` come from the shared vocabulary
  // (status-words.js), so the header chip, this line and the sidebar card use the same words.
  function describe(model) {
    const m = model || {},
      snap = m.snapshot,
      now = m.now || Date.now(),
      W = words();
    const facts = {
      now,
      issue: !!m.connectionIssue,
      connected: false,
      verdict: m.hint && m.hint.verdict,
      elsewhereWorking: !!m.elsewhereWorking,
      elsewhere: m.elsewhere,
    };
    const done = (d, extra) => {
      Object.assign(facts, extra);
      d.facts = facts;
      d.status = W ? W.statusOf(facts) : { label: d.short || d.text || '' }; // status-words.js missing (page loaded mid-restart): plain text
      d.pill = d.status.label;
      d.line = d.status.label;
      return d;
    };
    if (m.reconnecting && !(m.connected && snap && snap.ready !== false))
      return done(
        { kind: 'reconnecting', short: 'Reconnecting…', text: 'Reconnecting…' },
        { reconnecting: true, connected: !!m.connected, opening: true },
      );
    if (m.connectionIssue)
      return done({ kind: 'lost', short: 'Connection lost · reconnecting', text: 'Connection lost · reconnecting' });
    if (m.opening || (m.current && !snap))
      return done(
        { kind: 'opening', short: 'Opening conversation…', text: 'Opening conversation…' },
        { opening: true },
      );
    if (!m.connected || !snap)
      return done(
        { kind: 'saved', short: 'Saved conversation', text: 'Saved conversation — Continue to talk to it' },
        { recovered: !!m.recovered },
      );
    facts.connected = true;
    const pending = pendingGroups(snap, m.names, snap.sessionId);
    const needs = pending.totals.approvals + pending.totals.questions + pending.totals.signIn;
    if (needs) {
      const t = pending.totals;
      const short = t.signIn ? 'Sign-in needed' : t.questions ? 'Answer needed' : 'Approval needed';
      const detail =
        pending.groups.length > 1 ? pending.groups.map((g) => g.label + ': ' + countsText(g)).join(' · ') : '';
      const d = done(
        { kind: 'needs', short, text: 'Waiting for you: ' + countsText(t), detail, needs },
        { needs, needsKind: t.signIn ? 'sign-in' : t.questions ? 'question' : 'approval' },
      );
      d.line = d.status.label + ' — ' + countsText(t);
      return d;
    }
    if (snap.ready === false)
      return done(
        { kind: 'opening', short: 'Opening conversation…', text: 'Opening conversation…' },
        { opening: true },
      );
    if (snap.busy) {
      const start = turnStart(m.events, now, m.busySince);
      return done(
        { kind: 'working', short: 'Working', text: 'Agent is working… (' + formatElapsed(now - start) + ')', start },
        { busy: true, busySince: start },
      );
    }
    const yourTurn = typeof m.yourTurn === 'boolean' ? m.yourTurn : W.yourTurnFromEvents(m.events, m.handledAt);
    return done(
      { kind: 'idle', short: yourTurn ? 'Your turn' : 'Idle', text: yourTurn ? 'Your turn' : 'Idle' },
      { yourTurn },
    );
  }

  const FOCUSABLE = 'button, input, select, textarea, a[href]';
  function firstPendingCard(doc) {
    for (const sel of ['#authPrompts > *', '#setupQuestions > *', '#approvals > *', '#questions > *']) {
      const n = doc.querySelector(sel);
      if (n) return n;
    }
    return null;
  }

  function jumpToPending(doc) {
    const card = firstPendingCard(doc || root.document);
    if (!card) return false;
    if (card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const target = card.querySelector && card.querySelector(FOCUSABLE);
    if (target && target.focus) target.focus({ preventScroll: true });
    if (card.classList) {
      card.classList.add('attention-flash');
      root.setTimeout(() => card.classList.remove('attention-flash'), 1600);
    }
    return true;
  }

  const state = { line: null, status: null, desc: null, wired: false, timer: null };

  function paint() {
    const line = state.line,
      d = state.desc;
    if (!line || !d) return;
    let text = d.line || d.text;
    if (d.kind === 'working' && d.start != null) {
      // The label ticks: recompute it from the same vocabulary rather than keeping the text of the last poll.
      const live = words().statusOf(Object.assign({}, d.facts, { now: Date.now() }));
      text = live.label;
      if (state.status) state.status.textContent = live.label;
    }
    if (d.queueNote) text += ' · ' + d.queueNote;
    line.textContent = text;
    if (d.detail) {
      const small = line.ownerDocument.createElement('span');
      small.className = 'turn-detail';
      small.textContent = d.detail;
      line.appendChild(small);
    }
  }

  // els: {status, line}; the model is as for describe(). Returns the description.
  const busySince = {};
  function render(els, model) {
    const m = model || {};
    if (m.snapshot && m.snapshot.busy) busySince[m.key] = busySince[m.key] || Date.now();
    else delete busySince[m.key];
    const d = describe({ ...m, busySince: busySince[m.key] }),
      line = els.line;
    state.status = els.status || null;
    if (els.status) {
      els.status.textContent = d.pill || d.short;
      if (els.status.dataset) {
        els.status.dataset.kind = d.kind;
        els.status.dataset.tone = d.status.tone;
        els.status.dataset.status = d.status.kind;
      }
      els.status.title = d.status.title;
    }
    if (line) {
      d.queueNote = m.queueNote || '';
      state.line = line;
      state.desc = d;
      paint();
      line.dataset.kind = d.kind;
      line.dataset.tone = d.status.tone;
      line.dataset.status = d.status.kind;
      const link = d.kind === 'needs';
      line.setAttribute('role', link ? 'button' : 'status');
      if (link) {
        line.tabIndex = 0;
        line.title = 'Go to the first waiting request';
      } else {
        line.removeAttribute('tabindex');
        line.title = d.status.title;
      }
      if (!state.wired) {
        state.wired = true;
        line.addEventListener('click', () => {
          if (line.dataset.kind === 'needs') jumpToPending(line.ownerDocument);
        });
        line.addEventListener('keydown', (e) => {
          if (line.dataset.kind === 'needs' && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            jumpToPending(line.ownerDocument);
          }
        });
        state.timer = root.setInterval(paint, 1000);
      }
    }
    return d;
  }

  const api = {
    formatElapsed,
    shortElapsed,
    pendingGroups,
    countsText,
    turnStart,
    describe,
    render,
    jumpToPending,
    firstPendingCard,
  };
  root.AgentAttentionUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
