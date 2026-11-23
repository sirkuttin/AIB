(function (root) {
  'use strict';
  // Settings > Sync (sync between your PCs, slice V1: pairing). Start a sync chain (six words), Join a sync chain (pick the other PC
  // from your Tailscale devices, type the words), the two check words and Approve on the first PC, the paired PCs with a small
  // always-visible Remove icon, and one plain status line. The server side is /api/live/pcsync* (server/web/pcsync_routes.ts).
  // settings-ui.js calls render(box, host); host: {get(path), post(name, body)}. The card reads the view every 2 s while it is on
  // screen and redraws only when something changed, so a half-typed code is never wiped.
  const doc = () => root.document;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };
  const POLL_MS = 2000;
  const NS = 'http://www.w3.org/2000/svg';

  const P = {
    host: null,
    box: null,
    view: null,
    devices: null, // the Tailscale devices Join picks from (null = the form is closed)
    pick: '',
    code: '',
    busy: '',
    error: '',
    info: '',
    sig: '',
    timer: 0,
    tick: 0,
  };

  // ---- pure helpers (node tests) ----
  /* The one plain status line of the card. */
  function statusText(v) {
    if (!v) return 'Loading.';
    if (!v.pc || !v.pc.signedIn) return 'Tailscale is not running or not signed in on this PC. Sync needs it.';
    if (v.problem) return v.problem;
    if (!v.on) return 'Sync is off on this PC.';
    const n = (v.peers || []).length;
    if (v.join && v.join.state === 'waiting') return 'Waiting for ' + v.join.name + ' to approve this PC.';
    if (v.pairing && v.pairing.pending && v.pairing.pending.length) return 'A PC wants to join. Check the two words, then Approve.';
    if (v.pairing && v.pairing.words && v.pairing.words.length) return 'Sync chain started. Type the six words on your other PC.';
    if (!v.serve || !v.serve.shared) {
      if (v.serve && v.serve.funnel) return 'Funnel is on for the sync address. Turn it off in Tailscale first.';
      return 'Sync is not shared on Tailscale yet, so your other PCs cannot reach this one.';
    }
    return n ? 'Paired with ' + n + (n === 1 ? ' PC.' : ' PCs.') : 'Ready. No PC is paired yet.';
  }
  function reachText(r) {
    if (r === 'online') return 'Connected';
    if (r === 'connecting') return 'Connecting';
    if (r === 'refused') return 'No longer trusts this PC. Remove it and pair again.';
    if (r === 'offline') return 'Offline';
    return 'Checking';
  }
  function countdown(expiresAt, now) {
    const s = Math.max(0, Math.floor(expiresAt - now / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ---- drawing ----
  function btn(text, onClick, cls, disabled) {
    const b = el('button', text, cls || '');
    b.type = 'button';
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }
  /* A small trash icon button, always visible (no hover menu): built with createElementNS (no markup is parsed, no inline style). */
  function removeIcon(label, onClick) {
    const b = el('button', null, 'ps-remove');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    const svg = doc().createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M3 4.5h10', 'M6.5 4.5V3h3v1.5', 'M4.5 4.5l.6 8.5h5.8l.6-8.5', 'M6.8 7v4M9.2 7v4']) {
      const p = doc().createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.3');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    }
    b.append(svg);
    b.addEventListener('click', onClick);
    return b;
  }

  function draw() {
    const box = P.box;
    if (!box || !box.isConnected) return;
    const v = P.view;
    const frag = doc().createDocumentFragment();
    const status = el('p', statusText(v), 'st-note ps-status');
    status.setAttribute('role', 'status');
    frag.append(
      el('p', 'Pair your own PCs for sync of aib-docs and aib-shared. PC to PC over your Tailscale: no cloud, no account. This step only pairs the PCs; nothing is copied between them yet.', 'st-note'),
      status,
    );
    if (P.error) {
      const e = el('p', P.error, 'st-note bad');
      e.setAttribute('role', 'alert');
      frag.append(e);
    }
    if (P.info) frag.append(el('p', P.info, 'st-note'));
    if (v && v.pc && v.pc.signedIn) {
      const actions = el('div', null, 'ps-actions');
      actions.append(
        btn('Start a sync chain', () => act('pcsync/start', {}, 'start'), 'primary', !!P.busy || (v.pairing && v.pairing.words.length > 0)),
        btn('Join a sync chain', openJoin, '', !!P.busy || P.devices !== null || (v.join && v.join.state === 'waiting')),
      );
      if (v.on && v.listening && !v.serve.shared && !v.serve.funnel) actions.append(btn('Share sync', () => act('pcsync/share', {}, 'share'), '', !!P.busy));
      if (v.on) actions.append(btn('Turn sync off', () => act('pcsync/on', { on: false }, 'off'), '', !!P.busy));
      else if ((v.peers || []).length) actions.append(btn('Turn sync on', () => act('pcsync/on', { on: true }, 'on'), '', !!P.busy));
      frag.append(actions);
      if (v.on && v.serve && !v.serve.shared && v.serve.command) {
        frag.append(el('p', 'Share sync runs: ' + v.serve.command, 'st-note ps-command'));
      }
    }
    if (v && v.pairing) frag.append(drawPairing(v.pairing));
    if (v && v.join && v.join.state !== 'approved') frag.append(drawJoin(v.join));
    if (P.devices !== null) frag.append(drawJoinForm());
    if (v && (v.peers || []).length) {
      frag.append(el('h4', 'Paired PCs', 'ps-head'));
      const list = el('ul', null, 'ps-peers');
      for (const p of v.peers) {
        const li = el('li', null, 'ps-peer');
        li.dataset.peer = p.id;
        const text = el('div', null, 'ps-peer-text');
        text.append(el('b', p.name), el('span', ' ' + p.host, 'ps-dim'), el('span', reachText(p.reach), 'ps-reach ' + p.reach));
        li.append(text, removeIcon('Remove ' + p.name, () => remove(p)));
        list.append(li);
      }
      frag.append(list);
    }
    box.replaceChildren(frag);
    box._psDrawn = true;
  }

  function drawPairing(pairing) {
    const wrap = el('div', null, 'ps-block');
    if (pairing.words && pairing.words.length) {
      wrap.append(el('p', 'On your other PC, choose Join a sync chain, pick this PC and type:', 'st-note'));
      const words = el('p', pairing.words.join(' '), 'ps-words');
      words.dataset.words = '1';
      const left = el('span', countdown(pairing.expiresAt, Date.now()), 'ps-left');
      left.dataset.expires = String(pairing.expiresAt);
      const line = el('p', 'The code works once and lasts ', 'st-note');
      line.append(left, doc().createTextNode('. '));
      line.append(btn('Cancel', () => act('pcsync/cancel', {}, 'cancel')));
      wrap.append(words, line);
    }
    for (const c of pairing.pending || []) {
      const row = el('div', null, 'ps-claim');
      row.dataset.claim = c.id;
      row.append(
        el('p', c.name + ' (' + c.host + ') wants to join this sync chain.', 'st-note'),
        el('p', 'Check words: ' + c.checkWords.join(' '), 'ps-check'),
        el('p', 'They must be the same two words on ' + c.name + '. If they are not, click Reject.', 'st-note'),
      );
      const actions = el('div', null, 'ps-actions');
      actions.append(btn('Approve', () => act('pcsync/approve', { claim: c.id }, 'approve'), 'primary'), btn('Reject', () => act('pcsync/reject', { claim: c.id }, 'reject')));
      row.append(actions);
      wrap.append(row);
    }
    if (pairing.anotherTried) wrap.append(el('p', 'Another device tried this code. Start again if that was not you.', 'st-note bad'));
    return wrap;
  }

  function drawJoin(join) {
    const wrap = el('div', null, 'ps-block');
    if (join.state === 'waiting') {
      wrap.append(
        el('p', 'Check words: ' + (join.checkWords || []).join(' '), 'ps-check'),
        el('p', 'They must be the same two words on ' + join.name + '. Click Approve there.', 'st-note'),
      );
      const actions = el('div', null, 'ps-actions');
      actions.append(btn('Cancel', () => act('pcsync/cancel', {}, 'cancel')));
      wrap.append(actions);
    } else {
      wrap.append(el('p', join.error || 'The join ended.', 'st-note bad'));
    }
    return wrap;
  }

  function drawJoinForm() {
    const wrap = el('div', null, 'ps-block ps-join');
    const sel = el('select');
    sel.setAttribute('aria-label', 'Your other PC');
    const first = el('option', P.devices.length ? 'Pick a PC' : 'No other PC found on your Tailscale');
    first.value = '';
    sel.append(first);
    for (const d of P.devices) {
      const o = el('option', d.name + (d.online ? '' : ' (offline)'));
      o.value = d.host;
      sel.append(o);
    }
    sel.value = P.pick;
    sel.addEventListener('change', () => {
      P.pick = sel.value;
    });
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'six words';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = P.code;
    input.setAttribute('aria-label', 'The six words shown on the other PC');
    input.addEventListener('input', () => {
      P.code = input.value;
    });
    const actions = el('div', null, 'ps-actions');
    actions.append(
      btn('Join', () => act('pcsync/join', { host: P.pick, code: P.code }, 'join').then((ok) => {
        if (ok) {
          P.devices = null;
          P.code = '';
          P.pick = '';
          draw();
        }
      }), 'primary', !!P.busy),
      btn('Cancel', () => {
        P.devices = null;
        P.error = '';
        draw();
      }),
    );
    wrap.append(el('p', 'Pick the PC that shows the six words, and type them.', 'st-note'), sel, input, actions);
    return wrap;
  }

  // ---- data ----
  function take(v) {
    if (!v || typeof v !== 'object' || !('on' in v)) return;
    P.view = v;
    const sig = JSON.stringify(v) + '|' + P.busy + '|' + P.error + '|' + P.info + '|' +
      (P.devices === null ? '' : 'form' + P.devices.length);
    if (sig !== P.sig || (P.box && P.box.isConnected && !P.box._psDrawn)) {
      P.sig = sig;
      draw();
    }
  }
  function refresh() {
    if (!P.host) return Promise.resolve();
    return Promise.resolve(P.host.get('/api/live/pcsync')).then(take, (e) => {
      P.error = 'Sync could not be loaded: ' + (e && e.message ? e.message : e);
      draw();
    });
  }
  function act(name, body, label) {
    P.busy = label || name;
    P.error = '';
    P.info = '';
    draw();
    return Promise.resolve(P.host.post(name, body || {})).then(
      (r) => {
        P.busy = '';
        if (r && typeof r === 'object' && 'on' in r) P.view = r;
        return refresh().then(() => true);
      },
      (e) => {
        P.busy = '';
        P.error = e && e.message ? e.message : String(e);
        draw();
        return false;
      },
    );
  }
  function openJoin() {
    P.error = '';
    P.info = '';
    Promise.resolve(P.host.get('/api/live/pcsync/devices')).then(
      (r) => {
        P.devices = (r && r.devices) || [];
        draw();
      },
      (e) => {
        P.error = e && e.message ? e.message : String(e);
        draw();
      },
    );
  }
  function remove(peer) {
    P.busy = 'remove';
    P.error = '';
    return Promise.resolve(P.host.post('pcsync/remove', { id: peer.id })).then(
      (r) => {
        P.busy = '';
        P.info = r && r.notified
          ? 'Removed ' + peer.name + '. It was told, so it stopped trusting this PC too.'
          : 'Removed ' + peer.name + ' here. It was not reachable: remove this PC there too.';
        return refresh();
      },
      (e) => {
        P.busy = '';
        P.error = e && e.message ? e.message : String(e);
        draw();
      },
    );
  }

  function render(box, host) {
    P.host = host;
    P.box = box;
    P.devices = null;
    P.error = '';
    P.info = '';
    P.sig = '';
    box._psDrawn = false;
    if (P.view) draw();
    else box.append(el('p', 'Loading.', 'st-note'));
    refresh();
    if (!P.timer) {
      P.timer = root.setInterval(() => {
        if (!P.box || !P.box.isConnected) {
          root.clearInterval(P.timer);
          P.timer = 0;
          return;
        }
        if (doc().visibilityState === 'hidden') return;
        refresh();
      }, POLL_MS);
      // the countdown ticks without a redraw
      P.tick = root.setInterval(() => {
        if (!P.box || !P.box.isConnected) {
          root.clearInterval(P.tick);
          P.tick = 0;
          return;
        }
        const left = P.box.querySelector('[data-expires]');
        if (left) left.textContent = countdown(Number(left.dataset.expires), Date.now());
      }, 1000);
    }
  }

  const api = { render, refresh, statusText, reachText, countdown, _state: P };
  root.AIBPcSyncUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
