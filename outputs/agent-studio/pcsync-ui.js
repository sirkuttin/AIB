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
    linkPick: {}, // per peer id: the two projects picked in Link to…
    error: '',
    info: '',
    sig: '',
    timer: 0,
    tick: 0,
    scrollTo: '', // a project (sync id) to scroll to after the next draw
    bin: {}, // per project sync id: the sync bin list {open, entries, error}
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
  /* The line under a matched project saying why it is matched. */
  function howText(link) {
    if (link.missing) return 'This project is no longer on this PC.';
    if (!link.confirmed) return 'The other PC linked this by hand. Check it is the same project, then confirm.';
    return link.how === 'remote' ? 'Same git remote' : 'Linked by hand';
  }
  /* The small status next to a project's aib-shared switch (slice V4): one plain phrase, from the server's file status. */
  function filesText(f, peerName, folder) {
    if (!f || f.state === 'off') return '';
    const who = peerName || 'the other PC';
    switch (f.state) {
      case 'wsl': return 'Sync for WSL projects comes in a later update.';
      case 'offline': return 'Waiting for ' + who + ' to be online.';
      case 'blocked': return f.reason || 'Not synced here.';
      case 'other_off': return 'Waiting: ' + (folder || 'aib-shared') + ' is off on ' + who + '.';
      case 'waiting': return f.reason || 'Waiting.';
      case 'checking': return 'Checking files.';
    }
    if (f.pause) return 'Paused: big delete';
    if (f.pending > 0) return 'Syncing ' + f.pending + (f.pending === 1 ? ' file' : ' files');
    if (f.conflictCount > 0) return f.conflictCount + (f.conflictCount === 1 ? ' conflict' : ' conflicts');
    return 'Up to date';
  }
  function countdown(expiresAt, now) {
    const s = Math.max(0, Math.floor(expiresAt - now / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ---- the sidebar sync mark (slice V6) ----
  const MARK_ORDER = ['paused', 'conflict', 'waiting', 'syncing', 'ok'];
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  /* One area's (aib-shared or aib-docs) state for the mark, from the server's file status: {state, n, text}. null: that area is off. */
  function areaMark(f, folder, who) {
    if (!f || f.state === 'off') return null;
    switch (f.state) {
      case 'wsl': return { state: 'off', n: 0, text: 'Sync for WSL projects is not available yet.' };
      case 'offline': return { state: 'waiting', n: 0, text: who + ' is off or not reachable. Changes wait here.' };
      case 'other_off': return { state: 'waiting', n: 0, text: folder + ' sync is off on ' + who + '. Changes wait here.' };
      case 'blocked': return { state: 'waiting', n: 0, text: f.reason || 'Not synced here.' };
      case 'waiting': return { state: 'waiting', n: 0, text: f.reason || 'Waiting.' };
      case 'checking': return { state: 'syncing', n: 0, text: 'Checking ' + folder + ' with ' + who };
    }
    if (f.pause) {
      return { state: 'paused', n: f.pause.deletes, text: 'Sync paused: ' + f.pause.deletes + ' of ' + f.pause.total + ' files were deleted on ' + who + '. Click to choose.' };
    }
    if (f.conflictCount > 0) return { state: 'conflict', n: f.conflictCount, text: '' };
    if (f.pending > 0) return { state: 'syncing', n: f.pending, text: '' };
    return { state: 'ok', n: 0, text: '' };
  }
  /* The one mark of a linked project: aib-shared and docs combined, the state that needs you most wins. {state, n, text}.
     state: ok | syncing | waiting | conflict | paused | off. The tooltip is plain text and says PC to PC, no cloud where it fits. */
  function markOf(link, peerName) {
    const who = peerName || 'the other PC';
    const parts = [areaMark(link.files, 'aib-shared', who), areaMark(link.docsFiles, 'aib-docs', who)].filter(Boolean);
    if (!parts.length) return { state: 'off', n: 0, text: 'Sync is off for this project. Click to open Sync settings.' };
    const live = parts.filter((x) => x.state !== 'off');
    if (!live.length) return parts[0];
    const best = live.slice().sort((a, b) => MARK_ORDER.indexOf(a.state) - MARK_ORDER.indexOf(b.state))[0];
    const n = live.filter((x) => x.state === best.state).reduce((sum, x) => sum + x.n, 0);
    if (best.state === 'ok') return { state: 'ok', n: 0, text: 'Up to date with ' + who + '. PC to PC over Tailscale, no cloud.' };
    if (best.state === 'syncing') return { state: 'syncing', n, text: n ? 'Syncing ' + plural(n, 'file', 'files') + ' with ' + who + '. PC to PC, no cloud.' : best.text };
    if (best.state === 'conflict') return { state: 'conflict', n, text: plural(n, 'sync conflict', 'sync conflicts') + ' with ' + who + '. Click to open Sync settings.' };
    return { state: best.state, n, text: best.text };
  }
  const normFolder = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  const M = { host: null, data: null, timer: 0, changed: null, sig: '', nodes: new Set() };
  /* Every linked project in the marks data: [{folder, sync, name, peer, mark}]. */
  function marksList(data) {
    const out = [];
    for (const peer of (data && data.peers) || []) {
      for (const l of (peer.projects && peer.projects.links) || []) {
        if (!l.confirmed || l.missing || !l.folder) continue;
        out.push({ folder: normFolder(l.folder), sync: l.sync, name: l.name, peer: peer.name, mark: markOf(l, peer.name) });
      }
    }
    return out;
  }
  function markNode(entry) {
    const b = el('button', null, 'sync-mark');
    b.type = 'button';
    b.dataset.sync = entry.sync;
    const svg = doc().createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'sync-mark-ico');
    b.append(svg, el('span', null, 'sync-mark-n'));
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // the project row keeps its own click
      openSettingsAt(b.dataset.sync);
    });
    paintMark(b, entry);
    M.nodes.add(b);
    return b;
  }
  const ARROWS = ['M5.5 13V3M3 5.5L5.5 3 8 5.5', 'M10.5 3v10M8 10.5l2.5 2.5 2.5-2.5'];
  const BARS = ['M5.5 3.5v9', 'M10.5 3.5v9'];
  function paintMark(b, entry) {
    const m = entry.mark;
    b.dataset.state = m.state;
    b.title = m.text;
    b.setAttribute('aria-label', 'Sync with ' + entry.peer + ': ' + m.text);
    const svg = b.firstChild;
    svg.replaceChildren();
    const add = (d, width) => {
      const p = doc().createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', width || '1.4');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.append(p);
    };
    for (const d of m.state === 'paused' ? BARS : ARROWS) add(d);
    if (m.state === 'waiting') {
      const c = doc().createElementNS(NS, 'circle');
      c.setAttribute('cx', '12.5');
      c.setAttribute('cy', '12.5');
      c.setAttribute('r', '3');
      c.setAttribute('class', 'sync-mark-clock');
      c.setAttribute('stroke', 'currentColor');
      c.setAttribute('stroke-width', '1.2');
      svg.append(c);
      add('M12.5 11v1.6h1.2', '1');
    }
    if (m.state === 'off') add('M3 13L13 3');
    b.lastChild.textContent = m.state === 'conflict' && m.n ? (m.n > 9 ? '9+' : String(m.n)) : '';
  }
  /* The mark for the project in this folder, or null when it does not sync (no mark, no space). Never depends on focus. */
  function markFor(folder) {
    const want = normFolder(folder);
    if (!want || !M.data) return null;
    const entry = marksList(M.data).find((x) => x.folder === want);
    return entry ? markNode(entry) : null;
  }
  /* The sync id of the project in this folder (Files: the conflict actions need it), or ''. */
  function syncOf(folder) {
    const want = normFolder(folder);
    const entry = want && M.data ? marksList(M.data).find((x) => x.folder === want) : null;
    return entry ? entry.sync : '';
  }
  function openSettingsAt(sync) {
    P.scrollTo = sync || '';
    const S = root.AgentSettingsUI;
    if (S && S.open) S.open('sync');
    if (P.box && P.box.isConnected && P.view) draw();
  }
  function takeMarks(data) {
    if (!data || typeof data !== 'object' || !('peers' in data)) return;
    M.data = data;
    const list = marksList(data);
    const sig = list.map((x) => x.sync + '@' + x.folder).sort().join('|');
    for (const b of Array.from(M.nodes)) {
      const entry = list.find((x) => x.sync === b.dataset.sync);
      if (!b.isConnected || !entry) M.nodes.delete(b);
      else paintMark(b, entry);
    }
    if (sig !== M.sig) {
      M.sig = sig;
      if (M.changed) M.changed(); // the set of synced projects changed: the sidebar draws its marks again
    }
  }
  function pollMarks() {
    if (!M.host || doc().visibilityState === 'hidden') return Promise.resolve();
    return Promise.resolve(M.host.get('/api/live/pcsync/marks')).then(takeMarks, () => {});
  }
  /* host: {get(path)}; changed(): called when a project starts or stops syncing. Polls every 4 s while the page is visible. */
  function watch(host, changed) {
    M.host = host;
    M.changed = changed || null;
    pollMarks();
    if (!M.timer) M.timer = root.setInterval(pollMarks, 4000);
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

  /* A small restore icon button (an arrow turning back), always visible. */
  function restoreIcon(label, onClick) {
    const b = el('button', null, 'ps-remove ps-restore');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    const svg = doc().createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M3.5 8a4.5 4.5 0 1 0 1.4-3.3', 'M3 2.5v3h3']) {
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
  function binWhen(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    if (min < 1440) return Math.round(min / 60) + ' h ago';
    return Math.round(min / 1440) + ' d ago';
  }
  function loadBin(sync) {
    const b = P.bin[sync] || (P.bin[sync] = { open: true, entries: [], error: '' });
    return Promise.resolve(P.host.post('pcsync/projects/bin', { sync })).then(
      (r) => {
        b.entries = r && Array.isArray(r.entries) ? r.entries : [];
        b.error = '';
        draw();
      },
      (e) => {
        b.error = e && e.message ? e.message : String(e);
        draw();
      },
    );
  }
  /* The sync bin of one project: what sync replaced or deleted on this PC, kept under .git. Restore puts one back. */
  function drawBin(l) {
    const b = P.bin[l.sync];
    const wrap = el('div', null, 'ps-bin');
    wrap.dataset.bin = l.sync;
    const toggle = btn(b && b.open ? 'Hide sync bin' : 'Sync bin', () => {
      if (b && b.open) {
        b.open = false;
        draw();
      } else loadBin(l.sync);
    }, 'ps-small', false);
    toggle.dataset.act = 'bin';
    toggle.title = 'Files sync replaced or deleted on this PC are kept for 30 days. Restore puts one back.';
    wrap.append(toggle);
    if (b && b.open) {
      if (b.error) wrap.append(el('span', b.error, 'ps-files-text bad'));
      if (!b.error && !b.entries.length) wrap.append(el('span', 'Nothing in the sync bin.', 'ps-dim'));
      if (b.entries.length) {
        const list = el('ul', null, 'ps-filelist ps-binlist');
        for (const e of b.entries) {
          const li = el('li', null, 'ps-file bin');
          li.dataset.entry = e.id;
          li.append(
            el('code', (e.area === 'docs' ? 'aib-docs/' : 'aib-shared/') + e.path),
            el('span', ' ' + binWhen(e.at), 'ps-dim'),
            restoreIcon('Restore ' + e.path, () => {
              act('pcsync/projects/restore', { sync: l.sync, entry: e.id }, 'project').then(() => loadBin(l.sync));
            }),
          );
          list.append(li);
        }
        wrap.append(list);
      }
    }
    return wrap;
  }

  function draw() {
    const box = P.box;
    if (!box || !box.isConnected) return;
    const v = P.view;
    const frag = doc().createDocumentFragment();
    const status = el('p', statusText(v), 'st-note ps-status');
    status.setAttribute('role', 'status');
    frag.append(
      el('p', 'Pair your own PCs: PC to PC over your Tailscale, no cloud, no account. A project syncs when both PCs have its switch on; then its aib-shared files and AIB docs come too.', 'st-note'),
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
        if (p.projects) li.append(drawProjects(p));
        list.append(li);
      }
      frag.append(list);
    }
    box.replaceChildren(frag);
    box._psDrawn = true;
    if (P.scrollTo && v) {
      // a click on a sidebar mark: scroll that project's row into view (once)
      const row = Array.from(box.querySelectorAll('[data-sync]')).find((n) => n.dataset.sync === P.scrollTo);
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
      P.scrollTo = '';
    }
  }

  /* One project's switch: a labelled checkbox, saved at once, off by default. */
  function check(label, on, disabled, onChange) {
    const wrap = el('label', null, 'ps-switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!on;
    box.disabled = !!disabled;
    box.addEventListener('change', () => onChange(box.checked));
    wrap.append(box, el('span', label));
    return wrap;
  }

  /* The matched projects under one PC (slice V3): each with Docs and aib-shared switches and an always-visible Unlink icon,
     the name-only suggestions, and Link to… for the rest. Nothing is copied yet. */
  function drawProjects(peer) {
    const pr = peer.projects;
    const wrap = el('div', null, 'ps-projects');
    wrap.dataset.projects = peer.id;
    for (const l of pr.links) {
      const row = el('div', null, 'ps-project');
      row.dataset.sync = l.sync;
      const head = el('div', null, 'ps-project-head');
      const title = el('b', l.name);
      head.append(title);
      if (l.otherName && l.otherName !== l.name) head.append(el('span', ' is ' + l.otherName + ' on ' + peer.name, 'ps-dim'));
      head.append(el('span', howText(l), 'ps-dim ps-how'));
      row.append(head);
      const controls = el('div', null, 'ps-project-controls');
      if (!l.missing) {
        if (!l.confirmed) controls.append(btn('Confirm', () => projAct('pcsync/projects/confirm', { sync: l.sync }), '', !!P.busy));
        const docs = check('Docs', l.docs, !l.confirmed || !!P.busy, (on) => projAct('pcsync/projects/switch', { sync: l.sync, which: 'docs', on }));
        const shared = check('aib-shared', l.shared, !l.confirmed || !!P.busy, (on) => projAct('pcsync/projects/switch', { sync: l.sync, which: 'shared', on }));
        docs.dataset.switch = 'docs';
        shared.dataset.switch = 'shared';
        controls.append(docs, shared);
      }
      const gone = removeIcon('Unlink ' + l.name, () => projAct('pcsync/projects/unlink', { sync: l.sync }));
      gone.classList.add('ps-unlink');
      controls.append(gone);
      row.append(controls);
      /* the aib-shared line, then the Docs line (slice V5): the same status for each folder */
      for (const [f, folder, which] of [[l.files, 'aib-shared', 'shared'], [l.docsFiles, 'aib-docs', 'docs']]) {
        const line = filesText(f, peer.name, folder);
        if (!line) continue;
        const status = el('div', null, 'ps-files');
        status.dataset.files = f.state;
        status.dataset.area = which;
        status.setAttribute('role', 'status');
        status.append(el('span', (which === 'docs' ? 'Docs: ' : '') + line, 'ps-files-text' + (f.pause ? ' bad' : '')));
        if (f.pause) {
          status.append(
            el('span', f.pause.deletes + ' of ' + f.pause.total + ' files were deleted on ' + peer.name + '. They stay here until you choose.', 'ps-dim'),
            btn('Allow', () => projAct('pcsync/projects/files', { sync: l.sync, which, action: 'allow' }), 'ps-small', !!P.busy),
            btn('Keep files', () => projAct('pcsync/projects/files', { sync: l.sync, which, action: 'keep' }), 'ps-small', !!P.busy),
          );
        }
        row.append(status);
        const items = [];
        for (const c of f.conflicts || []) items.push(['conflict', c, 'Conflict copy: both versions are kept. Open Files to compare them and choose.']);
        for (const h of f.held || []) items.push(['held', h.path, h.why]);
        if (items.length) {
          const list = el('ul', null, 'ps-filelist');
          for (const [kind, path, why] of items) {
            const li = el('li', null, 'ps-file ' + kind);
            li.append(el('code', path), el('span', ' ' + why, 'ps-dim'));
            list.append(li);
          }
          row.append(list);
        }
      }
      if (l.autoStash && l.autoStash.length) {
        row.append(el(
          'div',
          'AIB turned on git autostash (' + l.autoStash.join(' and ') + ') in this project, so a git pull still works while your synced docs are uncommitted. It only changed this repo\'s own git settings.',
          'ps-dim ps-autostash',
        ));
      }
      if (l.confirmed && !l.missing) row.append(drawBin(l));
      wrap.append(row);
    }
    for (const sg of pr.suggestions || []) {
      const row = el('div', null, 'ps-project ps-suggest');
      row.dataset.suggest = sg.mine + ':' + sg.theirs;
      row.append(
        el('span', sg.name + ': same folder name on ' + peer.name + '. Check it is the same project.', 'st-note'),
        btn('Link', () => projAct('pcsync/projects/link', { peer: peer.id, mine: sg.mine, theirs: sg.theirs }), '', !!P.busy || peer.reach !== 'online'),
      );
      wrap.append(row);
    }
    if (peer.reach === 'online' && pr.mine.length && pr.theirs.length) {
      const pick = P.linkPick[peer.id] || (P.linkPick[peer.id] = { mine: '', theirs: '' });
      const row = el('div', null, 'ps-project ps-linkto');
      const select = (label, items, key) => {
        const sel = el('select');
        sel.setAttribute('aria-label', label);
        const first = el('option', label);
        first.value = '';
        sel.append(first);
        for (const it of items) {
          const o = el('option', it.name);
          o.value = it.oid;
          sel.append(o);
        }
        sel.value = items.some((it) => it.oid === pick[key]) ? pick[key] : '';
        sel.addEventListener('change', () => {
          pick[key] = sel.value;
        });
        return sel;
      };
      row.append(
        el('span', 'Link to…', 'ps-dim'),
        select('A project on this PC', pr.mine, 'mine'),
        select('A project on ' + peer.name, pr.theirs, 'theirs'),
        btn('Link', () => {
          if (!pick.mine || !pick.theirs) {
            P.error = 'Pick a project on each PC.';
            return draw();
          }
          const body = { peer: peer.id, mine: pick.mine, theirs: pick.theirs };
          pick.mine = '';
          pick.theirs = '';
          return projAct('pcsync/projects/link', body);
        }, '', !!P.busy),
      );
      wrap.append(row);
    }
    return wrap;
  }

  function projAct(name, body) {
    return act(name, body, 'project');
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
    const sig = JSON.stringify(v) + '|' + JSON.stringify(P.bin) + '|' + P.busy + '|' + P.error + '|' + P.info + '|' +
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

  const api = { _take: takeMarks, _poll: pollMarks, render, refresh, watch, markFor, markOf, syncOf, openSettingsAt, normFolder, statusText, reachText, howText, filesText, countdown, _state: P };
  root.AIBPcSyncUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
