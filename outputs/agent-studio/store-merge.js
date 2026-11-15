'use strict';
/* Page stores shared by several AIB windows (multi-window Phase 1B; design section 6, review section C).

   Every AIB window of one install shares one localStorage (Phase 0 spike: one WebView2 profile). A store that loads its whole value
   once and writes it back whole lets the last window to write wipe what another window changed (a draft typed in window A is gone
   when window B saves its own draft). This helper turns those writes into per-entry merges:

     * write rule: right before every write the stored value is read again, only the entries THIS window changed are applied on top
       (newest change wins per entry), and the result is written in the same task (no await between read and write, so it is safe
       in pagehide). Entries this window did not touch keep the stored value, so a write never removes another window's entry.
     * the saved formats do not change: each store says how its value splits into entries and how it is built back, so older
       versions of AIB and the server's view-prefs copy still read it.
     * refresh hints: the `storage` event (fired in every other page of the origin) and a BroadcastChannel message
       {t: 'store', key, from} re-read the key; onChange tells the module so it can take the newer entries.
     * self-repair: two windows writing in the same instant (two renderer processes) can still lose one write. When a refresh shows
       that an entry this window wrote moments ago is missing, it is written again, once.
     * ownership: a store may say which entries this window may write (a project window only its own project, a pop-out no layout).
     * per-window switches: winKey(k) gives the key this window uses (k for the main window, k + ':w<n>' for window n). On a
       window's first run the main window's value is copied, after that each window keeps its own.

   One window (today's case) behaves exactly as before: the re-read finds what this window wrote last, so the result is the same
   value, written at the same moments. */
(function (root) {
  const CHANNEL = 'aib-windows';
  const HEAL_MS = 3000;
  const W_RE = /^(m|w[2-8]|t-[a-z0-9]{4,12})$/;
  const pageId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /* ---- this window (K0): ?w=&kind=&mode=&project=&chat=, kept in sessionStorage (per window) for reloads ---------------- */
  function readContext(win) {
    const ctx = { w: 'm', kind: 'main', mode: '', project: '', chat: '' };
    let q = null,
      ss = null;
    try {
      q = new URLSearchParams((win.location && win.location.search) || '');
    } catch (e) {}
    try {
      ss = win.sessionStorage;
    } catch (e) {}
    let saved = null;
    try {
      saved = ss && JSON.parse(ss.getItem('aib-window-ctx') || 'null');
    } catch (e) {}
    const fromQ = q && W_RE.test(q.get('w') || '');
    const src = fromQ
      ? { w: q.get('w'), kind: q.get('kind'), mode: q.get('mode'), project: q.get('project'), chat: q.get('chat') }
      : saved && typeof saved === 'object' && W_RE.test(saved.w || '')
        ? saved
        : null;
    if (src) {
      ctx.w = src.w;
      ctx.kind = ['main', 'project', 'chat', 'doc'].includes(src.kind) ? src.kind : src.w === 'm' ? 'main' : 'project';
      ctx.mode = src.mode === 'chat' ? 'chat' : '';
      ctx.project = typeof src.project === 'string' ? src.project.slice(0, 400) : '';
      ctx.chat = typeof src.chat === 'string' ? src.chat.slice(0, 400) : '';
      if (fromQ && ss) {
        try {
          ss.setItem('aib-window-ctx', JSON.stringify(ctx));
        } catch (e) {}
      }
    }
    return ctx;
  }

  function make(win, opts) {
    win = win || root;
    opts = opts || {};
    const ctx = opts.ctx || readContext(win);
    const now = opts.now || (() => Date.now());
    const storage = () => {
      if (opts.storage) return opts.storage;
      try {
        return win.localStorage;
      } catch (e) {
        return null;
      }
    };
    const get = (k) => {
      try {
        const s = storage();
        return s ? s.getItem(k) : null;
      } catch (e) {
        return null;
      }
    };
    const put = (k, v) => {
      try {
        const s = storage();
        if (!s) return false;
        if (v == null) s.removeItem(k);
        else s.setItem(k, v);
        return true;
      } catch (e) {
        return false; // full or private: the store keeps working in memory
      }
    };

    /* A pop-out (a single chat or doc) writes no layout: it would store its small width over a real window's layout (E1). */
    const layoutWritable = () => !(ctx.mode === 'chat' || ctx.kind === 'chat' || ctx.kind === 'doc');
    /* Windows that own a project are known from the presence answer (Phase 1C sets this hook); until then nothing is owned elsewhere. */
    let ownedElsewhere = () => false;
    function mayWriteProject(p) {
      if (!layoutWritable()) return false;
      if (ctx.kind === 'project') return !!ctx.project && p === ctx.project;
      return !ownedElsewhere(p);
    }
    /* Entries tied to one chat: a pop-out writes only its own chat's entries. */
    const mayWriteChat = (chatKey) => ctx.kind !== 'chat' || !ctx.chat || chatKey === ctx.chat;

    /* ---- per-window keys (C8) --------------------------------------------------------------------------------------- */
    const suffixed = /^w[2-8]$/.test(ctx.w);
    const seededKey = 'studio-window-seeded:' + ctx.w;
    function winKey(base) {
      if (!suffixed) return base;
      const k = base + ':' + ctx.w;
      let done = [];
      try {
        done = JSON.parse(get(seededKey) || '[]');
        if (!Array.isArray(done)) done = [];
      } catch (e) {
        done = [];
      }
      if (!done.includes(base)) {
        // first run of this window for this key: start from the main window's value
        if (get(k) == null) {
          const main = get(base);
          if (main != null) put(k, main);
        }
        done.push(base);
        put(seededKey, JSON.stringify(done.slice(-200)));
      }
      return k;
    }

    /* ---- refresh hints ------------------------------------------------------------------------------------------- */
    const stores = new Map(); // key -> store
    let channel = null;
    try {
      channel = opts.channel !== undefined ? opts.channel : win.BroadcastChannel ? new win.BroadcastChannel(CHANNEL) : null;
    } catch (e) {
      channel = null;
    }
    const hint = (key) => {
      try {
        if (channel) channel.postMessage({ t: 'store', key, from: ctx.w, page: pageId });
      } catch (e) {}
    };
    if (channel) {
      const onMsg = (e) => {
        const d = e && e.data;
        if (!d || d.t !== 'store' || d.page === pageId || typeof d.key !== 'string') return;
        const s = stores.get(d.key);
        if (s) s.refresh();
      };
      if (channel.addEventListener) channel.addEventListener('message', onMsg);
      else channel.onmessage = onMsg;
    }
    if (win.addEventListener && !opts.noEvents) {
      win.addEventListener('storage', (e) => {
        try {
          if (e.storageArea && e.storageArea !== storage()) return;
        } catch (err) {}
        if (e.key == null) for (const s of stores.values()) s.refresh();
        else if (stores.has(e.key)) stores.get(e.key).refresh();
      });
    }

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const plainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

    /* ---- a map store --------------------------------------------------------------------------------------------- */
    /* spec: entries(parsed) -> {entryKey: entry} (today's format split into entries, in order: oldest first)
             build(obj, parsed) -> the value to save (keeps unknown fields of parsed)
             writable(entryKey) -> may this window write it (default: yes)
             cap: n -> keep the newest n entries (an entry this window sets moves to the end)
             skipSame: true -> no write when the text is unchanged (default true) */
    function map(key, spec) {
      spec = spec || {};
      const entriesOf = (parsed) => {
        try {
          const o = spec.entries ? spec.entries(parsed) : parsed;
          return plainObj(o) ? { ...o } : {};
        } catch (e) {
          return {};
        }
      };
      const parse = (raw) => {
        if (raw == null) return null;
        try {
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      };
      const build = (obj, parsed) => (spec.build ? spec.build(obj, parsed) : obj);
      const writable = (k) => {
        try {
          return !spec.writable || !!spec.writable(k);
        } catch (e) {
          return false;
        }
      };
      let base = null; // the entries as the module last saw them (load / write): what write() diffs against
      let lastRaw;
      let wrote = new Map(); // entryKey -> {v, at, healed}: what this window wrote last (self-repair)
      const listeners = [];

      function current() {
        const raw = get(key);
        const parsed = parse(raw);
        return { raw, parsed, obj: entriesOf(parsed) };
      }
      /* Apply ops [[k, value|undefined]] onto what is stored now, write, and return the merged entries. */
      function apply(ops) {
        const { raw, parsed, obj } = current();
        const t = now();
        let any = false;
        for (const [k, v] of ops) {
          if (!writable(k)) continue;
          any = true;
          if (v === undefined) {
            delete obj[k];
            wrote.set(k, { v: undefined, at: t });
          } else {
            delete obj[k]; // newest at the end (the cap drops from the front)
            obj[k] = v;
            wrote.set(k, { v, at: t });
          }
        }
        if (spec.cap > 0) {
          const ks = Object.keys(obj);
          for (const k of ks.slice(0, Math.max(0, ks.length - spec.cap))) delete obj[k];
        }
        if (wrote.size > 400) wrote = new Map([...wrote].slice(-200));
        if (!any) {
          lastRaw = raw;
          return obj;
        }
        const text = JSON.stringify(build(obj, parsed));
        if (text !== raw) {
          if (put(key, text)) {
            lastRaw = text;
            hint(key);
          } else lastRaw = raw;
        } else lastRaw = raw;
        return obj;
      }
      const s = {
        key,
        /** The stored entries now; the module's starting point (write() diffs against it). */
        load() {
          const { raw, obj } = current();
          lastRaw = raw;
          base = { ...obj };
          return { ...obj };
        },
        /** The stored entries now, without changing what write() diffs against. */
        read() {
          return current().obj;
        },
        /** The module's whole value as entries: only the entries that differ from what the module saw last are written. */
        write(obj) {
          obj = plainObj(obj) ? obj : {};
          if (base == null) base = current().obj;
          const ops = [];
          for (const k of Object.keys(obj)) if (!(k in base) || !same(obj[k], base[k])) ops.push([k, obj[k]]);
          for (const k of Object.keys(base)) if (!(k in obj)) ops.push([k, undefined]);
          base = { ...obj };
          return ops.length ? apply(ops) : current().obj;
        },
        set(k, v) {
          if (base) base[k] = v;
          return apply([[k, v]]);
        },
        del(k) {
          if (base) delete base[k];
          return apply([[k, undefined]]);
        },
        /** Take what is stored as the module's view (after onChange, when the module adopts the newer value). */
        adopt(obj) {
          base = { ...(obj || current().obj) };
        },
        /** Another window wrote the key: re-read, repair a lost write of ours, tell the module. */
        refresh() {
          const { raw, obj } = current();
          if (raw === lastRaw) return false;
          const t = now();
          const lost = [];
          for (const [k, w] of wrote) {
            if (w.healed || t - w.at > HEAL_MS || w.v === undefined) continue;
            if (!(k in obj)) lost.push([k, w.v]);
          }
          let merged = obj;
          if (lost.length) {
            merged = apply(lost);
            for (const [k] of lost) {
              const w = wrote.get(k);
              if (w) w.healed = true;
            }
          } else lastRaw = raw;
          const changed = [];
          const was = base || {};
          for (const k of Object.keys(merged)) if (!(k in was) || !same(merged[k], was[k])) changed.push(k);
          for (const k of Object.keys(was)) if (!(k in merged)) changed.push(k);
          if (changed.length)
            for (const fn of listeners) {
              try {
                fn({ ...merged }, changed);
              } catch (e) {}
            }
          return true;
        },
        onChange(fn) {
          if (typeof fn === 'function') listeners.push(fn);
          return s;
        },
      };
      stores.set(key, s);
      return s;
    }

    /* A key whose other users write it whole (no entries): only a refresh hint. */
    function watch(key, fn) {
      let last = get(key);
      const s = {
        refresh() {
          const v = get(key);
          if (v === last) return false;
          last = v;
          try {
            fn(v);
          } catch (e) {}
          return true;
        },
      };
      stores.set(key, s);
      return s;
    }

    return {
      ctx,
      pageId,
      windowId: () => ctx.w,
      layoutWritable,
      mayWriteProject,
      mayWriteChat,
      setOwnedElsewhere(fn) {
        ownedElsewhere = typeof fn === 'function' ? fn : () => false;
      },
      winKey,
      map,
      watch,
      hint,
      _stores: stores,
    };
  }

  const api = { make, readContext, W_RE, HEAL_MS, CHANNEL };
  root.AibStoreMerge = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && root === (typeof window !== 'undefined' ? window : null)) root.AibStore = make(root);
})(typeof window !== 'undefined' ? window : globalThis);
