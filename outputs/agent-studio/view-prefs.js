'use strict';
/* View and appearance preferences kept in AIB's data folder (server/state/view_prefs.ts, studio-view.json), not only in this
   browser profile. The page's modules keep using localStorage as before; this file, the first page script, makes localStorage a
   copy of the data folder for the keys below:
     * at start: the server writes the saved values into chat.html (<script type="application/json" id="aibViewPrefs">); each one
       is put into localStorage before any other page script reads it. A key the data folder does not have yet is taken from
       localStorage instead and sent to the server (the one-time move of what an older copy of the app remembered).
     * afterwards: every localStorage.setItem / removeItem of one of these keys is sent to the server at once (the changes of one
       moment go together, without waiting for a request still on its way; the server keeps the newest per key). Nothing
       waits for the page to close: quitting AIB ends the app process at once, so a change still waiting then would be lost
       (seen with 0.1.0-beta.8-test4: a project picked half a second before quitting was gone after the restart). Hiding or
       closing the page still sends anything left, as a last try.
     * each key stands alone: one the server refuses (too big, say) is dropped from the queue, the rest are saved; a server that
       cannot write its file just now (503) or cannot be reached gets the same keys again a few seconds later.
   Without the data block (a server without view preferences) nothing is changed. Per-chat drafts, read positions, caches and
   other transient state stay in this browser only. */
(function (root) {
  /* The keys that move, exact names first, then the ones remembered per window-width bucket (a ':<bucket>' suffix). */
  const KEYS = Object.freeze([
    'studio-workspace-v1', // the sidebar's project or "All chats", open tabs per project, last chat per project
    'studio-sidebar-group', // how the chat list is grouped
    'studio-sidebar-collapsed', // collapsed groups in the chat list
    'studio-archived-open', // the Archived group open
    'studio-deleted-open', // the Deleted group open
    'studio-hold-open-by-project', // "On hold" lines open per project
    'studio-pending-projects-v1', // projects made with New project that have no chat yet
    'studio-conversation-names', // chat display names (Rename)
    'studio-chat-views', // Full / Chat / Prompts per chat
    'studio-split-v1', // split panes
    'studio-side-hidden', // chat list hidden
    'studio-activity-hidden', // Activity column hidden
    'aib-terminal-height', // chat terminal height
    'studio-show-thinking', // show thinking
    'agentStudio.copyFormat', // the Copy button's format
    'agentStudio.copyFormat.code', // the code-block Copy button's format
    'studio-cwd', // the folder last typed for a new chat
    'studio-notifications-app', // the desktop app's notification choices (notify-ui.js; a browser's stay in that browser)
    'aib-theme', // the colour theme (themes.js)
    'aib-status-glyphs', // status symbols on or off (themes.js)
    'studio-seen-turns', // "your turn" chats already looked at, so they do not come back to the inbox (workspace-ui.js)
    'aib-sidebar-mode', // the sidebar's Chats | Files switch (files-ui.js)
    'aib-file-tabs-v1', // file tabs open per project (files-ui.js)
    'aib-files-open-v1', // folders open in the Files tree, per project and tree (files-ui.js)
    'studio-sidebar-epoch', // when this copy of AIB first ran: older finished chats do not show as unread (sidebar-ui.js)
    'studio-new-chat-agent', // the agent last picked for a new chat, the fallback when Settings names none (agent-choice.js)
  ]);
  const PREFIXES = Object.freeze([
    'studio-textsize-v1:', // chat text and interface size, code font, line spacing
    'studio-layout-v1:', // chat list and Activity column widths
  ]);
  const synced = (k) =>
    typeof k === 'string' && (KEYS.includes(k) || PREFIXES.some((p) => k.startsWith(p) && k.length > p.length));
  // A drag saves once, at its end; a held arrow key is one small request per repeat.
  const RETRY_MS = 5000;

  /* What to do at start. saved: {key: value} from the data folder; local: {key: value} of the synced keys in localStorage.
     Returns {seed: {key: value} to write into localStorage, upload: {key: value} to send to the server}. */
  function plan(saved, local) {
    const seed = {},
      upload = {};
    for (const k of Object.keys(saved || {})) {
      if (synced(k) && typeof saved[k] === 'string' && local[k] !== saved[k]) seed[k] = saved[k];
    }
    for (const k of Object.keys(local || {})) {
      if (synced(k) && typeof local[k] === 'string' && !Object.prototype.hasOwnProperty.call(saved || {}, k))
        upload[k] = local[k];
    }
    return { seed, upload };
  }

  /* The saved values from chat.html, or null when the page has no data block. */
  function readBlock(doc) {
    try {
      const el = doc && doc.getElementById && doc.getElementById('aibViewPrefs');
      if (!el) return null;
      const data = JSON.parse(el.textContent || '{}');
      const prefs =
        data && typeof data.prefs === 'object' && data.prefs && !Array.isArray(data.prefs) ? data.prefs : {};
      const out = {};
      for (const k of Object.keys(prefs)) if (typeof prefs[k] === 'string') out[k] = prefs[k];
      return out;
    } catch (e) {
      return null;
    }
  }

  let live = null;
  /* opts (tests): storage, proto (the Storage prototype to hook), fetch, setTimeout, clearTimeout. */
  function init(win, opts) {
    win = win || root;
    opts = opts || {};
    if (live) return live;
    const saved = readBlock(win.document);
    if (!saved) return null;
    let storage;
    try {
      storage = opts.storage || win.localStorage;
    } catch (e) {
      storage = null;
    }
    if (!storage) return null;
    const proto = opts.proto || (win.Storage && win.Storage.prototype) || Object.getPrototypeOf(storage);
    const doFetch = opts.fetch || (win.fetch && win.fetch.bind(win));
    const later = opts.setTimeout || win.setTimeout.bind(win),
      cancel = opts.clearTimeout || win.clearTimeout.bind(win);

    const local = {};
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (synced(k)) local[k] = storage.getItem(k);
      }
    } catch (e) {}
    const { seed, upload } = plan(saved, local);
    /* What the data folder has, key by key. Writing the value it already has sends nothing: the page rewrites the same sidebar
       state on every list update; each of those was a request a change made right after it had to wait for. */
    const known = new Map();
    for (const k of Object.keys(saved)) if (synced(k)) known.set(k, saved[k]);
    for (const k of Object.keys(seed)) {
      try {
        storage.setItem(k, seed[k]); // before the hook: these come from the server
      } catch (e) {}
    }

    let pending = { ...upload },
      timer = 0,
      token = '',
      seq = 0;
    /* Every batch goes out at once, without waiting for the one before it: AIB quits at once, and Studio can take ~30 ms to
       answer while it lists chats, so a project picked behind another save was lost (remember_ui_e2e_test, about one start in
       three). The server keeps the newest batch of this page per key (page id + batch number). */
    const pageId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    const lastBatch = new Map(); // key -> the number of the newest batch that carried it
    const schedule = (ms) => {
      if (timer) cancel(timer);
      timer = later(() => {
        timer = 0;
        return flush(false);
      }, ms);
    };
    // A change goes out on the next tick: the writes of one click travel together.
    const soon = () => {
      if (!timer) schedule(0);
    };
    async function getToken(fresh) {
      if (token && !fresh) return token;
      const r = await doFetch('/api/live/bootstrap', { cache: 'no-store' });
      if (!r.ok) throw new Error('bootstrap ' + r.status);
      token = (await r.json()).token || '';
      return token;
    }
    async function post(body, keepalive, fresh) {
      const t = await getToken(fresh);
      return doFetch('/api/live/view-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Token': t },
        body,
        // keepalive: a save sent just before the window closes still reaches Studio, which waits for it before AIB exits
        // (ViewPrefs.settle). The browser allows 64 KB of keepalive bodies on their way; a bigger one goes without.
        keepalive: !!keepalive || body.length < 32000,
      });
    }
    async function flush(keepalive) {
      if (!doFetch || !Object.keys(pending).length) return false;
      const batch = pending,
        n = ++seq;
      pending = {};
      for (const k of Object.keys(batch)) {
        known.set(k, batch[k]); // a failed batch goes back into pending
        lastBatch.set(k, n);
      }
      let retry = false;
      try {
        const body = JSON.stringify({ set: batch, page: pageId, seq: n });
        let r = await post(body, keepalive, false);
        if (r.status === 403) r = await post(body, keepalive, true); // Studio restarted: a new token
        if (r.status === 400) return false; // a malformed batch: the same body would fail again
        if (!r.ok) throw new Error('view-prefs ' + r.status); // 503: the file is busy just now
        return true; // keys the server refused (too big) are not sent again: they would be refused again
      } catch (e) {
        // again later, the keys no newer batch or change carries (newer changes win)
        for (const k of Object.keys(batch))
          if (lastBatch.get(k) === n && !Object.prototype.hasOwnProperty.call(pending, k)) pending[k] = batch[k];
        retry = Object.keys(pending).length > 0;
        return false;
      } finally {
        if (retry) schedule(RETRY_MS);
      }
    }
    function note(k, v) {
      if (!Object.prototype.hasOwnProperty.call(pending, k) && known.has(k) && known.get(k) === v) return; // it has it already
      pending[k] = v;
      soon();
    }

    const isOurs = (s) => {
      try {
        return s === storage;
      } catch (e) {
        return false;
      }
    };
    const origSet = proto.setItem,
      origRemove = proto.removeItem;
    proto.setItem = function (k, v) {
      const r = origSet.apply(this, arguments);
      k = String(k);
      if (isOurs(this) && synced(k)) note(k, String(v));
      return r;
    };
    proto.removeItem = function (k) {
      const r = origRemove.apply(this, arguments);
      k = String(k);
      if (isOurs(this) && synced(k)) note(k, null);
      return r;
    };
    const unload = () => {
      if (timer) cancel(timer);
      timer = 0;
      flush(true);
    };
    if (win.addEventListener) win.addEventListener('pagehide', unload);
    if (win.document && win.document.addEventListener) {
      win.document.addEventListener('visibilitychange', () => {
        if (win.document.visibilityState === 'hidden') unload();
      });
    }
    if (Object.keys(pending).length) soon();
    else if (doFetch) getToken(false).catch(() => {}); // ready before the first change, so it is one request, not two
    live = {
      seeded: Object.keys(seed),
      uploading: Object.keys(upload),
      flush: () => flush(false),
      pending: () => ({ ...pending }),
      stop() {
        proto.setItem = origSet;
        proto.removeItem = origRemove;
        if (timer) cancel(timer);
        live = null;
      },
    };
    return live;
  }

  const api = { KEYS, PREFIXES, synced, plan, readBlock, init };
  root.AibViewPrefs = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  /* Runs as soon as it is loaded: it is the first deferred script, so every other script (and DOMContentLoaded) comes after. */
  if (typeof document !== 'undefined' && root === (typeof window !== 'undefined' ? window : null)) init(root);
})(typeof window !== 'undefined' ? window : globalThis);
