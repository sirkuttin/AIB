(function (root) {
  'use strict';
  // What you have seen in each chat. The server keeps it (studio-read-state.json in Studio's state folder), keyed by the chat's
  // stable identity "provider:sessionId", so it survives restarts and is the same in every browser. Browser storage is only a
  // fast cache so the first paint is right before the server has answered. Positions only move forward.
  const CACHE = 'studio-read-state-v2',
    OLD_LAST_SEEN = 'studio-last-seen',
    OLD_VIEWED = 'studio-last-viewed-v1',
    MIGRATED = 'studio-read-state-migrated',
    MAX_CACHE = 2000,
    MAX_SET = 500,
    MAX_TIME = 4102444800000;
  const KEY_OK = /^[a-z0-9][a-z0-9_-]*:.+$/;
  let host = null,
    chats = {}, // key -> {seenAt (ms), seenIndex?}
    marks = {}, // key -> markedUnreadAt (ms): "Mark as unread" from a phone, until the chat is looked at again (the server's)
    pending = {},
    revision = null,
    flushTimer = 0,
    flushing = false,
    syncing = false;
  const store = () => {
    try {
      return root.localStorage;
    } catch (e) {
      return null;
    }
  };
  const readJson = (name) => {
    try {
      return JSON.parse(store().getItem(name) || 'null');
    } catch (e) {
      return null;
    }
  };
  const writeJson = (name, value) => {
    try {
      store().setItem(name, JSON.stringify(value));
    } catch (e) {
      /* storage may be unavailable */
    }
  };
  const validKey = (k) => typeof k === 'string' && k.length <= 300 && !/[\u0000-\u001f]/.test(k) && KEY_OK.test(k);
  const validTime = (t) => typeof t === 'number' && isFinite(t) && t >= 0 && t <= MAX_TIME;
  // Same rule as the server: only forward; equal keeps the larger index; newer without an index keeps the old one.
  function merge(into, key, next) {
    if (!validKey(key) || !next || !validTime(next.seenAt)) return false;
    const old = into[key],
      at = Math.floor(next.seenAt);
    if (old && at < old.seenAt) return false;
    let index = Number.isInteger(next.seenIndex) && next.seenIndex >= 0 ? next.seenIndex : null;
    if (old && (at === old.seenAt || index == null) && old.seenIndex != null)
      index = index == null ? old.seenIndex : at === old.seenAt ? Math.max(index, old.seenIndex) : index;
    if (old && old.seenAt === at && old.seenIndex === (index == null ? undefined : index)) return false;
    into[key] = index == null ? { seenAt: at } : { seenAt: at, seenIndex: index };
    return true;
  }
  function saveCache() {
    const keys = Object.keys(chats);
    if (keys.length > MAX_CACHE)
      for (const k of keys.sort((a, b) => chats[a].seenAt - chats[b].seenAt).slice(0, keys.length - MAX_CACHE))
        delete chats[k];
    writeJson(CACHE, chats);
  }
  const loadCache = () => {
    const raw = readJson(CACHE);
    chats = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      for (const k of Object.keys(raw)) merge(chats, k, raw[k]);
  };
  loadCache();

  const seenAt = (key) => (chats[key] ? chats[key].seenAt : 0);
  const seenIndex = (key) => (chats[key] && chats[key].seenIndex != null ? chats[key].seenIndex : null);
  // When a phone marked this chat unread (ms), while nothing newer was read since; else 0. The unread dot shows for it.
  const markedUnread = (key) => (marks[key] && marks[key] > seenAt(key) ? marks[key] : 0);
  function mark(key, at, index) {
    if (marks[key] && (Number(at) || 0) > marks[key]) delete marks[key]; // looked at again: the server clears it with this position
    const next = { seenAt: Number(at) || 0 };
    if (index != null) next.seenIndex = index;
    if (!merge(chats, key, next)) return false;
    merge(pending, key, next);
    saveCache();
    if (!flushTimer && root.setTimeout) flushTimer = root.setTimeout(flush, 800);
    return true;
  }
  async function post(set) {
    const keys = Object.keys(set);
    for (let i = 0; i < keys.length; i += MAX_SET) {
      const part = {};
      for (const k of keys.slice(i, i + MAX_SET)) part[k] = set[k];
      const out = await host.post('read-state', { set: part });
      if (out && out.revision) revision = out.revision;
    }
  }
  async function flush() {
    flushTimer = 0;
    if (!host || flushing || !Object.keys(pending).length) return;
    flushing = true;
    const set = pending;
    pending = {};
    try {
      await post(set);
    } catch (e) {
      for (const k of Object.keys(set)) merge(pending, k, set[k]); // try again with the next change
    } finally {
      flushing = false;
    }
  }
  // Fetch when the server's revision differs from what this page last saw (the list carries it); merges, never replaces.
  async function sync(rev) {
    if (!host || syncing || (rev && rev === revision)) return false;
    syncing = true;
    try {
      const data = await host.get('/api/live/read-state');
      let changed = false;
      const nextMarks = {};
      for (const k of Object.keys((data && data.chats) || {})) {
        changed = merge(chats, k, data.chats[k]) || changed;
        const m = data.chats[k] && data.chats[k].markedUnreadAt;
        if (validKey(k) && validTime(m) && m > 0) nextMarks[k] = m;
      }
      if (JSON.stringify(nextMarks) !== JSON.stringify(marks)) changed = true;
      marks = nextMarks;
      revision = (data && data.revision) || rev || revision;
      if (changed) saveCache();
      return changed;
    } catch (e) {
      return false;
    } finally {
      syncing = false;
    }
  }
  // Once per browser: send what older versions kept in this browser to the server. resolve(oldKey) maps a key that was a live
  // connection id to the chat's stable key (or returns it unchanged / null to drop it).
  async function migrate(resolve) {
    const s = store();
    if (!host || !s) return false;
    try {
      if (s.getItem(MIGRATED)) return false;
    } catch (e) {
      return false;
    }
    const set = {};
    for (const name of [OLD_LAST_SEEN, OLD_VIEWED]) {
      const old = readJson(name);
      if (!old || typeof old !== 'object' || Array.isArray(old)) continue;
      for (const k of Object.keys(old)) {
        const key = resolve ? resolve(k) : k;
        const t = Number(old[k]);
        if (key && validKey(key) && validTime(t)) merge(set, key, { seenAt: t });
      }
    }
    try {
      await sync();
      for (const k of Object.keys(set)) merge(chats, k, set[k]);
      saveCache();
      if (Object.keys(set).length) await post(set);
      s.setItem(MIGRATED, '1');
      s.removeItem(OLD_LAST_SEEN);
      s.removeItem(OLD_VIEWED);
      return true;
    } catch (e) {
      return false; // the old entries stay; the next page load tries again
    }
  }
  function init(h) {
    host = h;
    if (root.document && root.document.addEventListener)
      root.document.addEventListener('visibilitychange', () => {
        if (root.document.visibilityState === 'hidden') flush();
      });
  }
  const api = { init, seenAt, seenIndex, markedUnread, mark, sync, flush, migrate, _merge: merge, _reset: loadCache };
  root.AgentReadState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
