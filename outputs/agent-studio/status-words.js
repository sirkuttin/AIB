(function (root) {
  'use strict';
  // The ONE status vocabulary (docs/design/review-decisions.html, "Status words, the same everywhere"):
  //   Working · 4m   Your turn   Needs you   Idle   Not running   Elsewhere · Working / Elsewhere · Idle   Reconnecting…
  // statusOf(facts) maps what a caller knows about a conversation to {kind, label, tone, dotClass, title, detail}.
  // The header chip, the composer turn line and the sidebar card phrase all call it, so the words cannot drift.
  // Pure: no DOM, no clock except facts.now, no network.
  //
  // facts (every field optional):
  //   issue            the open chat lost its connection and Studio is retrying            -> Reconnecting…
  //   failed, error    the live connection reports an error and nothing is waiting          -> Failed (not part of the seven words)
  //   connected        an agent is attached in this Studio (a live, not-closed connection)
  //   opening          the agent is still starting                                           -> Opening… (transitional)
  //   needs, needsKind how many requests wait (approval / question / sign-in) and the first kind
  //   busy, busySince  the agent is working; busySince is when it started (ms)
  //   yourTurn         true = the agent finished its turn and the user has not acted since.
  //                    CONTRACT with the "your turn" mark owner (workspace code): expose a boolean `yourTurn` on the
  //                    conversation object (c.yourTurn or c.live.yourTurn); it is cleared only by acting (reply, hold,
  //                    archive, Mark handled). While it is undefined callers fall back: the header derives it from the
  //                    event log (a turn_end after the last user message), list cards use "finished, not viewed".
  //   verdict          ownership verdict of a chat that is not attached here (owned_elsewhere / possibly_active)
  //   elsewhereWorking the other app is visibly working (recent writes, running subagents or processes)
  //   reconnecting     Studio is reloading this chat by itself after a restart (server-side fact)   -> Reconnecting…
  //   recovered, recent, agentList   why a chat is not attached (only changes the tooltip)
  //   now              current time in ms
  const T = {
    working: { tone: 'work', dot: 'd-work' },
    'your-turn': { tone: 'turn', dot: 'd-turn' },
    needs: { tone: 'need', dot: 'd-need' },
    idle: { tone: 'idle', dot: 'd-idle' },
    'not-running': { tone: 'off', dot: 'd-off' },
    'elsewhere-working': { tone: 'else', dot: 'd-else' },
    'elsewhere-idle': { tone: 'else', dot: 'd-else' },
    reconnecting: { tone: 'idle', dot: 'd-idle' },
    opening: { tone: 'idle', dot: 'd-idle' },
    failed: { tone: 'bad', dot: 'd-fail' },
  };
  const ELSEWHERE = { owned_elsewhere: true, possibly_active: true };
  const NOT_RUNNING_TITLE = 'No agent is attached. Send a message to start it again.';

  // "4m", "1h 05m"; empty below one minute (the label then says just Working).
  function elapsedWords(ms) {
    const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
    if (m < 1) return '';
    const h = Math.floor(m / 60);
    return h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + 'm';
  }

  function make(kind, label, title, extra) {
    const t = T[kind];
    return Object.assign({ kind, label, tone: t.tone, dotClass: t.dot, title }, extra || {});
  }

  function statusOf(facts) {
    const f = facts || {},
      now = f.now || Date.now();
    if (f.reconnecting && !(f.connected && !f.opening))
      return make('reconnecting', 'Reconnecting…', 'Studio is reloading this chat after the restart. Nothing is sent.');
    if (f.issue) return make('reconnecting', 'Reconnecting…', 'Connection lost; Studio is trying to reconnect.');
    if (f.connected) {
      const needs = Math.max(0, Number(f.needs) || 0);
      if (f.failed && !needs)
        return make('failed', 'Failed', String(f.error || 'The agent reported an error.').slice(0, 200));
      if (needs) {
        const more = needs - 1,
          kind = f.needsKind || 'approval';
        return make('needs', 'Needs you', 'It asked a question or wants approval. Shows in the inbox.', {
          detail: kind + (more > 0 ? ' +' + more : ''),
        });
      }
      if (f.opening) return make('opening', 'Opening…', 'Studio is starting the agent.');
      if (f.busy) {
        const t = f.busySince ? elapsedWords(now - f.busySince) : '';
        return make('working', t ? 'Working · ' + t : 'Working', 'The agent is busy on your last message.', {
          elapsedMs: f.busySince ? Math.max(0, now - f.busySince) : 0,
        });
      }
      if (f.yourTurn) return make('your-turn', 'Your turn', 'It finished and is waiting for you. Shows in the inbox.');
      return make('idle', 'Idle', 'Connected, nothing pending.');
    }
    if (f.opening) return make('opening', 'Opening…', 'Studio is starting the agent.');
    // conversation.elsewhere = {working, confirmed, verdict} (steady, set by the ownership code) beats raw verdict facts.
    const ew = f.elsewhere && typeof f.elsewhere === 'object' ? f.elsewhere : null;
    if (ELSEWHERE[ew ? ew.verdict : f.verdict]) {
      return (ew ? ew.working : f.elsewhereWorking)
        ? make('elsewhere-working', 'Elsewhere · Working', 'Another app is running it. Read-only here.')
        : make(
            'elsewhere-idle',
            'Elsewhere · Idle',
            'Another app has this open but is not working right now. Read-only here.',
          );
    }
    let title = NOT_RUNNING_TITLE;
    if (f.recovered) title = 'It was open in Studio before the server restarted. Send a message to reconnect it.';
    else if (f.recent) title = 'Written a moment ago; not confirmed to be running. ' + NOT_RUNNING_TITLE;
    else if (f.agentList) title = 'The agent listed this chat; Studio has not read it. ' + NOT_RUNNING_TITLE;
    return make('not-running', 'Not running', title);
  }

  // Does the event log say "the agent finished and the user has not acted since"? handledAt (seconds) hides a turn end
  // the user already dismissed with Mark handled. Used by the header when the conversation carries no yourTurn flag.
  function yourTurnFromEvents(events, handledAt) {
    const list = Array.isArray(events) ? events : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e) continue;
      if (e.kind === 'user') return false;
      if (e.kind === 'turn_end') return !(handledAt != null && typeof e.time === 'number' && e.time <= handledAt);
    }
    return false;
  }

  // Is the other app visibly working? hint.working (when the ownership code sets it) wins; otherwise recent transcript
  // writes count as work. A hint with only weak or old evidence stays "Idle".
  function elsewhereWorking(hint) {
    if (!hint) return false;
    if (typeof hint.working === 'boolean') return hint.working;
    return (Array.isArray(hint.reasons) ? hint.reasons : []).some((r) => r && r.signal === 'transcript');
  }

  const api = {
    statusOf,
    elapsedWords,
    yourTurnFromEvents,
    elsewhereWorking,
    NOT_RUNNING_TITLE,
    KINDS: Object.keys(T),
  };
  root.AgentStatusWords = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
