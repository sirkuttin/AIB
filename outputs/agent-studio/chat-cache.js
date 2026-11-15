/* The page's memory cache of live chats' events (history loading, design 5.1 / review M4). One entry per live connection id,
   shared by the main list, split side panes and the subagent view, so each chat is downloaded once and kept while you switch.
   Memory only (owner decision 2b): no disk copy. The newest LIMIT chats are kept (LRU).

   An entry holds the loaded events of every session, in seq order, without repeats:
   - the chat's own events as one contiguous range [from .. cursor] (the opening page, older pages joined below it, deltas above);
   - a helper's events from the time that helper was opened (session=<helper> page) or its deltas arrived.
   Seqs up to `stable` keep their number across a host restart; above it they may be renumbered, so opening a cached chat again
   drops them and fetches from `stable` (trust()).

   The event array is private: readers go through the named calls below (loaded, sinceTurnStart, helperLoaded ...), and
   work/test_event_readers.js fails if chat.js and the other readers keep a raw array of their own. */
(function (root) {
  'use strict';
  const LIMIT = 30;

  function seqOf(e) {
    return e && Number.isFinite(Number(e.seq)) ? Number(e.seq) : NaN;
  }

  function makeEntry(id) {
    let list = []; // every loaded event, ascending seq, no repeats
    const helpers = new Map(); // helper session id -> {edge, more, from} once its page was fetched
    const entry = {
      id,
      eventsId: '',
      cursor: 0, // the newest seq loaded (the next delta read is after it)
      stable: 0,
      from: 0, // the oldest seq of the chat's own loaded range (0: nothing loaded)
      first: 0, // the oldest seq the server keeps of the chat's own events
      more: false, // older events of the chat's own exist before `from`
      edge: null, // the server's boundary state before `from` (chat.js liveRows)
      turn: null, // the opening page's turn facts {promptSeq, since, step, steps, endSeq, talking}
      helpers: null, // the opening page's helper facts {id: {...}}
      snap: null, // the newest /api/live/state answer (settings, approvals... and the delta's events)
      opened: false, // the opening page (or the full state on an older host) was taken
      pulledAt: 0,
      busyOlder: null, // an older page in flight (a promise)

      /* All loaded events (any session), oldest first. Do not change it: a copy is cheap enough but not needed. */
      loaded() {
        return list;
      },
      size() {
        return list.length;
      },
      /* The loaded events from the current turn's prompt on (the live line, "your turn"); the whole range when the prompt is older. */
      sinceTurnStart() {
        const p = entry.turn && entry.turn.promptSeq;
        if (!(p > 0)) return list;
        const i = indexAt(p);
        return i > 0 ? list.slice(i) : list;
      },
      /* Is the current turn's prompt older than what is loaded (the readers then take the server's turn facts)? */
      promptMissing() {
        const p = entry.turn && entry.turn.promptSeq;
        return !!(p > 0 && entry.from > p);
      },
      /* Merge events in (deltas, an older page, a helper's page): sorted, a seq already kept is replaced by the newer copy. */
      merge(events) {
        if (!Array.isArray(events) || !events.length) return 0;
        const fresh = events.filter((e) => Number.isFinite(seqOf(e)));
        if (!fresh.length) return 0;
        const last = list.length ? seqOf(list[list.length - 1]) : -Infinity;
        fresh.sort((a, b) => seqOf(a) - seqOf(b));
        if (seqOf(fresh[0]) > last) {
          // the common case: deltas after the end
          for (const e of fresh) if (!list.length || seqOf(e) > seqOf(list[list.length - 1])) list.push(e);
        } else {
          const bySeq = new Map(list.map((e) => [seqOf(e), e]));
          for (const e of fresh) bySeq.set(seqOf(e), e);
          list = [...bySeq.values()].sort((a, b) => seqOf(a) - seqOf(b));
        }
        return fresh.length;
      },
      /* The opening page (/api/live/events with no before/after, or around=). */
      open(page) {
        if (page.eventsId && entry.eventsId && page.eventsId !== entry.eventsId) entry.reset(page.eventsId);
        if (page.eventsId) entry.eventsId = page.eventsId;
        entry.merge(page.events || []);
        entry.cursor = Math.max(entry.cursor, Number(page.cursor) || 0);
        entry.stable = Number(page.stable) || 0;
        entry.first = Number(page.first) || 0;
        if (!entry.from || (page.from && page.from <= entry.from)) {
          entry.from = Number(page.from) || 0;
          entry.more = !!page.more;
          entry.edge = page.edge || null;
        }
        if (page.turn) entry.turn = page.turn;
        if (page.helpers) entry.helpers = page.helpers;
        entry.opened = true;
      },
      /* An older page of the chat's own events (before=from) joins the range below it. */
      older(page) {
        if (page.eventsId && entry.eventsId && page.eventsId !== entry.eventsId) return false;
        entry.merge(page.events || []);
        if (page.from && (!entry.from || page.from < entry.from)) {
          entry.from = page.from;
          entry.edge = page.edge || null;
        }
        entry.more = !!page.more && !!page.events?.length;
        if (page.first !== undefined) entry.first = Number(page.first) || 0;
        return true;
      },
      /* A /api/live/state answer after the cursor (its events are deltas of every session). */
      delta(state) {
        if (state.reset) {
          list = [];
          entry.from = 0;
          entry.edge = null;
        }
        if (state.eventsId) entry.eventsId = state.eventsId;
        entry.merge(state.events || []);
        entry.cursor = Math.max(Number(state.cursor) || 0, state.reset ? 0 : entry.cursor);
        if (!entry.from && list.length) entry.from = seqOf(list[0]);
        if (state.stable !== undefined) entry.stable = Number(state.stable) || 0;
        entry.snap = state;
        entry.pulledAt = Date.now();
      },
      /* The full state of an older host (no /api/live/events): every kept event, as today. */
      full(state) {
        list = [];
        helpers.clear();
        entry.eventsId = state.eventsId || '';
        entry.merge(state.events || []);
        entry.cursor = Number(state.cursor) || 0;
        entry.stable = entry.cursor;
        entry.from = list.length ? seqOf(list[0]) : 0;
        entry.first = entry.from;
        entry.more = false;
        entry.edge = null;
        entry.snap = state;
        entry.opened = true;
        entry.pulledAt = Date.now();
      },
      /* Opening a cached chat again: keep what keeps its number, fetch the rest (review M4). */
      trust() {
        if (!entry.opened) return;
        const s = entry.stable;
        if (entry.cursor > s) {
          list = list.filter((e) => seqOf(e) <= s);
          entry.cursor = s;
        }
      },
      /* Another numbering: nothing loaded is valid any more. */
      reset(eventsId) {
        list = [];
        helpers.clear();
        Object.assign(entry, { eventsId: eventsId || '', cursor: 0, stable: 0, from: 0, first: 0, more: false, edge: null });
        Object.assign(entry, { turn: null, helpers: null, opened: false });
      },
      /* Drop the oldest events past `cut` (chat.js trimEvents): the boundary state is not known for the new start. */
      dropOldest(cut) {
        if (!(cut > 0)) return;
        list = list.slice(cut);
        entry.from = list.length ? seqOf(list[0]) : 0;
        entry.more = true;
        entry.edge = null;
      },
      /* Replace everything loaded (tests, and the old full-state path's resets). */
      replace(events) {
        list = Array.isArray(events) ? events.slice() : []; // as given (tests hand in events without seqs)
        entry.from = list.length && Number.isFinite(seqOf(list[0])) ? seqOf(list[0]) : 0;
      },
      /* A helper's own page (session=<helper>), fetched when it is opened. */
      helperLoaded(sid) {
        return helpers.has(sid);
      },
      helperEdge(sid) {
        return helpers.get(sid)?.edge || null;
      },
      helperPage(sid, page) {
        entry.merge(page.events || []);
        helpers.set(sid, { edge: page.edge || null, more: !!page.more, from: Number(page.from) || 0 });
      },
    };
    function indexAt(s) {
      let lo = 0,
        hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (seqOf(list[mid]) < s) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }
    return entry;
  }

  function create(limit = LIMIT) {
    const entries = new Map();
    return {
      /* The entry of a connection id (made when missing; touching it makes it the newest). */
      entry(id) {
        let e = entries.get(id);
        if (e) entries.delete(id);
        else e = makeEntry(id);
        entries.set(id, e);
        while (entries.size > limit) entries.delete(entries.keys().next().value);
        return e;
      },
      peek(id) {
        return entries.get(id) || null;
      },
      drop(id) {
        entries.delete(id);
      },
      ids() {
        return [...entries.keys()];
      },
    };
  }

  const api = { create, LIMIT };
  root.ChatCache = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
