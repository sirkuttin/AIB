/* AibTerminal: a terminal attached to each conversation, docked under the message box of the chat view.

   Interface (window.AibTerminal). Keys are chat keys: provider + ':' + (sessionId || id || key), the same string chat.js calls
   aliasKey and split side panes put on their message list as data-mirror.

     init(host)            chat.js, once. host = {
                             current(): {key, cwd, project, title} | null   the open chat. cwd: its worktree when it has one, else
                                                                            its folder; project: the project folder (offered,
                                                                            never used silently, when cwd is gone)
                             titleOf(key): string                           a chat's name (the "too many terminals" list)
                             token(): Promise<string>                       the page token (fetched when there is none yet)
                             refreshToken(): Promise<void>                  after a refused socket (Studio restarted)
                             get(path): Promise<object>                     GET /api/live/<path> with the token
                             post(path, body): Promise<object>              POST /api/live/<path> with the token
                             select(key): Promise<boolean>                  make that chat the open one (split panes: focus its pane)
                             changed(): void                                which chats have a terminal changed (sidebar icons)
                             focusComposer(): void                          Ctrl+` from inside the terminal hides it and comes back here
                           }
     sync()                chat.js, after the open chat may have changed: shows that chat's panel (or none), updates the button.
     open(key?)            show the panel for that chat (default: the open chat; another chat is opened first), starting its shell if
                           needed, and focus it. Resolves when the shell is attached; rejects with an Error saying why not (the panel
                           then shows the reason and what to do).
     paste(key, text)      open(key), then put `text` at the prompt WITHOUT running it: never a trailing Enter; several lines are
                           pasted so that none runs (the server does this: server/terminal/sessions.ts pasteInput). If a command is
                           still running (the server asks the PTY: Pty.busy), the panel asks "Paste anyway / Cancel" first.
                           Resolves true when pasted, false when the person cancelled; rejects on failure. No hint or overlay is shown.
     isOpen(key)           true while that chat's panel is shown and its shell attached.
     hasSession(key)       true while that chat has a running shell (shown or not).
     rowIcon(key)          the small terminal icon for a sidebar row whose chat has a running shell, or null.
     close(key?)           hide the panel; the shell keeps running (the header button then shows a green dot).
     end(key?)             end the shell (and everything it started) and remove the panel.
     toggle()              the header button: show or hide the open chat's panel.

   Keys: Ctrl+` and Ctrl+J (by e.code, so any keyboard layout): open the terminal and focus it; pressed in the terminal: hide it and
   focus the message box. On the divider: Up/Down 24 px, Home/End smallest/largest. In the terminal: Ctrl+Shift+C copies the
   selection (Ctrl+C too when text is selected, else it is the shell's interrupt); Ctrl+V pastes the same safe way as paste().

   Nothing typed in or printed by a terminal goes to an agent.

   Look: terminal.css; every colour a theme.css token (--term-* for the terminal itself). Classes:
     button.aib-term-toggle (+ span.aib-term-live dot, div.aib-term-tip tooltip)       far right of the chat header
     section#terminalDock.aib-term-dock                                                  last child of #chat, under the message box
       div.aib-term-divider[role=separator] > i                                          drag or keys to resize (height per window)
       div.aib-term-head: .aib-term-name, button.aib-term-path(.is-missing), span.aib-term-shell(.is-ok/.is-off/.is-bad),
                          span.aib-term-slot (phase 4: Send to chat), button.aib-term-collapse, button.aib-term-end(.is-close)
       div.aib-term-body: div.aib-term-warn (paste while busy), div.aib-term-view[data-key] (one per chat; xterm),
                          div.aib-term-msg (.is-failed/.is-missing/.is-limit), div.aib-term-ended (end line + actions)
     svg.aib-term-row-icon                                                                sidebar rows (rowIcon)
   xterm.js is vendored in vendor/xterm/ and loaded on first use. */
(function (root) {
  'use strict';
  const VENDOR = ['/vendor/xterm/xterm.js', '/vendor/xterm/addon-fit.js', '/vendor/xterm/addon-canvas.js'];
  const HEIGHT_KEY = 'aib-terminal-height';
  const MIN_HEIGHT = 120;
  const DEFAULT_HEIGHT = 300;
  const STEP = 24;
  const BUSY_TIMEOUT = 1500;

  /* ---- pure ---------------------------------------------------------------------------------------------------------------- */

  /** The socket address for a chat (same origin as the page). */
  function socketUrl(loc, key, cwd, cols, rows, shell) {
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ key, cwd: cwd || '', cols: String(cols || 80), rows: String(rows || 24) });
    if (shell) q.set('shell', shell);
    return scheme + '//' + loc.host + '/api/live/terminal?' + q;
  }
  /** The subprotocols the page offers: the terminal protocol and the page token (a WebSocket cannot carry headers). */
  function protocols(token) {
    return ['aib-terminal', 'aib-token.' + token];
  }
  /** An xterm theme from the page's colour tokens; `read(name)` returns a CSS variable's value or ''. */
  function themeFrom(read) {
    const v = (name, fallback) => (read(name) || '').trim() || fallback;
    const theme = {
      background: v('--term-bg', '#0c0d10'),
      foreground: v('--term-fg', v('--text', '#e5e7ec')),
      cursor: v('--term-cursor', v('--term-fg', v('--text', '#e5e7ec'))),
      cursorAccent: v('--term-bg', '#0c0d10'),
      selectionBackground: v('--term-sel', '#3d3456'),
      red: v('--term-red', '#f19999'),
      green: v('--term-green', '#7ad19c'),
      yellow: v('--term-yellow', '#e6c27a'),
      blue: v('--term-blue', '#7cb7ff'),
      magenta: v('--term-magenta', '#bba1ff'),
      cyan: v('--term-cyan', '#7fd3d8'),
      brightBlack: v('--term-dim', '#8a91a3'),
      black: v('--term-black', ''),
      white: v('--term-white', ''),
      brightRed: v('--term-bright-red', ''),
      brightGreen: v('--term-bright-green', ''),
      brightYellow: v('--term-bright-yellow', ''),
      brightBlue: v('--term-bright-blue', ''),
      brightMagenta: v('--term-bright-magenta', ''),
      brightCyan: v('--term-bright-cyan', ''),
      brightWhite: v('--term-bright-white', ''),
    };
    for (const k of Object.keys(theme)) if (!theme[k]) delete theme[k]; // a page without those tokens keeps xterm's own
    return theme;
  }
  function clampHeight(h, max) {
    const n = Math.round(Number(h));
    const top = Math.max(MIN_HEIGHT, Number(max) || 640);
    return Number.isFinite(n) ? Math.min(Math.max(n, MIN_HEIGHT), top) : Math.min(DEFAULT_HEIGHT, top);
  }
  /**
   * A folder as the header shows it: the home folder as ~, then only the last two names (~\…\worktrees\name). Returns
   * {prefix, last}: the text before the last name and the last name (drawn bold).
   */
  function shortPath(full) {
    const text = String(full || '');
    const sep = text.includes('\\') ? '\\' : '/';
    const home = text.match(/^([A-Za-z]:\\Users\\[^\\]+|\/Users\/[^/]+|\/home\/[^/]+)(?=$|[\\/])/);
    let head = '',
      rest = text;
    if (home) {
      head = '~';
      rest = text.slice(home[0].length);
    } else {
      const drive = text.match(/^([A-Za-z]:|)(?=[\\/])/);
      head = drive ? drive[1] : '';
      rest = text.slice(head.length);
    }
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return { prefix: head ? head + sep : '', last: head ? '' : text };
    const last = parts.pop();
    const shown = parts.length > 1 ? ['…', parts[parts.length - 1]] : parts;
    return { prefix: [head, ...shown].join(sep) + sep, last };
  }
  /** "idle 5m", "idle 3h", "idle 2d"; under a minute "active". */
  function idleText(ms) {
    const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
    if (m < 1) return 'active';
    if (m < 60) return 'idle ' + m + 'm';
    const h = Math.floor(m / 60);
    return h < 48 ? 'idle ' + h + 'h' : 'idle ' + Math.floor(h / 24) + 'd';
  }
  /** True for the keys that show or hide the terminal: Ctrl+` and Ctrl+J, by physical key. */
  function isToggleKey(ev) {
    if (!ev || !ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return false;
    return ev.code === 'Backquote' || ev.code === 'KeyJ' || (!ev.code && (ev.key === '`' || ev.key === 'j'));
  }

  /* ---- icons (16 px, 1.5 stroke, round caps) ------------------------------------------------------------------------------- */

  const ICONS = {
    terminal: [
      ['rect', { x: '1.75', y: '2.75', width: '12.5', height: '10.5', rx: '2' }],
      ['path', { d: 'M4.75 6.25 6.75 8l-2 1.75M8.5 10h2.75' }],
    ],
    folder: [
      ['path', { d: 'M1.75 4.25a1 1 0 0 1 1-1h3.1l1.5 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z' }],
    ],
    missing: [
      ['path', { d: 'M8 2.5 14 13H2z' }],
      ['path', { d: 'M8 6.5v3M8 11.25v.01' }],
    ],
    collapse: [['path', { d: 'M4 6l4 4 4-4' }]],
    end: [
      [
        'path',
        {
          d: 'M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.25a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-8.25M6.75 7v4M9.25 7v4',
        },
      ],
    ],
    close: [['path', { d: 'M4 4l8 8M12 4l-8 8' }]],
    newSession: [['path', { d: 'M2.75 8a5.25 5.25 0 1 0 1.6-3.8M2.75 2.75v2.5h2.5' }]],
  };

  /* ---- state --------------------------------------------------------------------------------------------------------------- */

  let host = null;
  const ui = {};
  const entries = new Map(); // key -> one chat's terminal
  const running = new Map(); // key -> TerminalInfo (server list, kept up to date here)
  let shownKey = '';
  let loading = null;
  let busySeq = 0;

  const doc = () => root.document;
  const store = () => {
    try {
      return root.localStorage || null;
    } catch {
      return null;
    }
  };

  function el(tag, className, text) {
    const n = doc().createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = String(text);
    return n;
  }
  function icon(name, className) {
    const d = doc();
    if (typeof d.createElementNS !== 'function') {
      const s = el('span', 'aib-term-icon' + (className ? ' ' + className : ''));
      s.setAttribute('aria-hidden', 'true');
      return s;
    }
    const ns = 'http://www.w3.org/2000/svg';
    const svg = d.createElementNS(ns, 'svg');
    const attrs = {
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      class: 'aib-term-icon' + (className ? ' ' + className : ''),
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const [tag, a] of ICONS[name]) {
      const part = d.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(a)) part.setAttribute(k, v);
      svg.append(part);
    }
    return svg;
  }
  function button(className, label, iconName, text) {
    const b = el('button', className);
    b.type = 'button';
    if (iconName) b.append(icon(iconName));
    if (text !== undefined) b.append(el('span', '', text));
    if (label) {
      b.setAttribute('aria-label', label);
      b.title = label;
    }
    return b;
  }
  function setLabel(b, label, title) {
    b.setAttribute('aria-label', label);
    b.title = title || label;
  }

  /* ---- xterm loading ------------------------------------------------------------------------------------------------------- */

  function libs() {
    const T = (host && host.Terminal) || root.Terminal;
    const Fit = (host && host.FitAddon) || (root.FitAddon && root.FitAddon.FitAddon);
    const Canvas = (host && host.CanvasAddon) || (root.CanvasAddon && root.CanvasAddon.CanvasAddon);
    return T ? { Terminal: T, FitAddon: Fit, CanvasAddon: Canvas } : null;
  }
  /** Load vendor/xterm on first use (our own files; nothing remote). */
  function loadXterm() {
    if (libs()) return Promise.resolve(libs());
    if (loading) return loading;
    loading = (async () => {
      const d = doc();
      if (!d.querySelector('link[data-aib-xterm]')) {
        const css = d.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/vendor/xterm/xterm.css';
        css.setAttribute('data-aib-xterm', '');
        d.head.append(css);
      }
      for (const src of VENDOR) {
        await new Promise((resolve, reject) => {
          const s = d.createElement('script');
          s.src = src;
          s.onload = resolve;
          s.onerror = () => reject(Error('Could not load the terminal (' + src + ').'));
          d.head.append(s);
        });
      }
      if (!libs()) throw Error('The terminal library did not load.');
      return libs();
    })();
    loading.catch(() => (loading = null));
    return loading;
  }

  /* ---- the panel ----------------------------------------------------------------------------------------------------------- */

  function maxHeight() {
    const chat = ui.dock && ui.dock.parentNode;
    const total = chat && chat.getBoundingClientRect ? chat.getBoundingClientRect().height : 0;
    return total ? Math.max(MIN_HEIGHT, total - 180) : (root.innerHeight || 900) - 240; // the chat stays visible above
  }
  function savedHeight() {
    let h = null;
    try {
      h = store() && store().getItem(HEIGHT_KEY);
    } catch {}
    return clampHeight(h === null || h === undefined ? DEFAULT_HEIGHT : h, maxHeight());
  }
  function setHeight(h, save) {
    const value = clampHeight(h, maxHeight());
    ui.dock.style.height = value + 'px';
    ui.divider.setAttribute('aria-valuenow', String(value));
    ui.divider.setAttribute('aria-valuemax', String(Math.round(maxHeight())));
    if (save) {
      try {
        store() && store().setItem(HEIGHT_KEY, String(value));
      } catch {}
    }
    fitShown();
  }
  function currentHeight() {
    const h = ui.dock.getBoundingClientRect ? ui.dock.getBoundingClientRect().height : 0;
    return h || Number(ui.divider.getAttribute('aria-valuenow')) || DEFAULT_HEIGHT;
  }

  function build() {
    const chat = doc().getElementById('chat');
    if (!chat || ui.dock) return;
    const dock = (ui.dock = el('section', 'aib-term-dock'));
    dock.id = 'terminalDock';
    dock.setAttribute('aria-label', 'Terminal');
    dock.hidden = true;

    const divider = (ui.divider = el('div', 'aib-term-divider'));
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'horizontal');
    divider.setAttribute('aria-label', 'Resize terminal');
    divider.setAttribute('aria-valuemin', String(MIN_HEIGHT));
    divider.tabIndex = 0;
    const grip = el('i');
    grip.setAttribute('aria-hidden', 'true');
    divider.append(grip);

    const head = el('div', 'aib-term-head');
    const name = el('span', 'aib-term-name');
    name.append(icon('terminal'), el('span', 'aib-term-name-text', 'Terminal'));
    ui.path = button('aib-term-path');
    ui.pathDot = el('i', 'aib-term-path-dot');
    ui.pathDot.setAttribute('aria-hidden', 'true');
    ui.pathIcon = el('span', 'aib-term-path-icon');
    ui.pathPrefix = el('span', 'aib-term-path-prefix');
    ui.pathLast = el('b', 'aib-term-path-last');
    ui.pathNote = el('span', 'aib-term-path-note');
    const pathText = el('span', 'aib-term-path-text');
    pathText.append(ui.pathPrefix, ui.pathLast, ui.pathNote);
    ui.path.append(ui.pathDot, ui.pathIcon, pathText);
    ui.shell = el('span', 'aib-term-shell');
    ui.shellDot = el('i');
    ui.shellDot.setAttribute('aria-hidden', 'true');
    ui.shellText = el('span');
    ui.shell.append(ui.shellDot, ui.shellText);
    const grow = el('span', 'aib-term-grow');
    ui.slot = el('span', 'aib-term-slot'); // phase 4: "Send to chat"
    ui.collapse = button('aib-term-btn aib-term-collapse', '', 'collapse');
    setLabel(ui.collapse, 'Collapse terminal (session keeps running)', 'Collapse (Ctrl+`)');
    ui.end = button('aib-term-btn aib-term-end', 'End terminal session', 'end');
    ui.end.title = 'End session';
    head.append(name, ui.path, ui.shell, grow, ui.slot, ui.collapse, ui.end);

    const body = (ui.body = el('div', 'aib-term-body'));
    ui.warn = el('div', 'aib-term-warn');
    ui.warn.setAttribute('role', 'alert');
    ui.warn.hidden = true;
    ui.views = el('div', 'aib-term-views');
    ui.msg = el('div', 'aib-term-msg');
    ui.msg.hidden = true;
    ui.ended = el('div', 'aib-term-ended');
    ui.ended.hidden = true;
    body.append(ui.warn, ui.views, ui.msg, ui.ended);
    dock.append(divider, head, body);
    chat.append(dock);

    ui.collapse.addEventListener('click', () => close(shownKey, true));
    ui.end.addEventListener('click', () => {
      const e = entries.get(shownKey);
      if (!e) return;
      if (e.status === 'ready' || e.status === 'connecting' || e.status === 'loading') end(e.key).catch(() => {});
      else discard(e, true); // nothing running: × closes the panel and clears its output
    });
    ui.path.addEventListener('click', () => {
      const e = entries.get(shownKey);
      const text = e && e.cwd;
      if (!text) return;
      try {
        const done = root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText(text);
        if (done && done.then)
          done.then(
            () => flashCopied(),
            () => {},
          );
      } catch {}
    });
    divider.addEventListener('pointerdown', (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      const startY = ev.clientY,
        startH = currentHeight();
      if (divider.setPointerCapture && ev.pointerId !== undefined) divider.setPointerCapture(ev.pointerId);
      dock.classList.add('is-resizing');
      const move = (m) => setHeight(startH - (m.clientY - startY), false);
      const up = (u) => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        divider.removeEventListener('pointercancel', up);
        dock.classList.remove('is-resizing');
        setHeight(startH - (u.clientY - startY), true);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
      divider.addEventListener('pointercancel', up);
      if (ev.preventDefault) ev.preventDefault();
    });
    divider.addEventListener('keydown', (ev) => {
      const h = currentHeight();
      if (ev.key === 'ArrowUp') setHeight(h + STEP, true);
      else if (ev.key === 'ArrowDown') setHeight(h - STEP, true);
      else if (ev.key === 'Home') setHeight(MIN_HEIGHT, true);
      else if (ev.key === 'End') setHeight(maxHeight(), true);
      else return;
      ev.preventDefault();
    });
    setHeight(savedHeight(), false);
    if (typeof root.ResizeObserver === 'function') new root.ResizeObserver(() => fitShown()).observe(ui.views);
  }

  function flashCopied() {
    ui.path.classList.add('is-copied');
    (root.setTimeout || setTimeout)(() => ui.path.classList.remove('is-copied'), 1200);
  }

  function buildButton() {
    if (ui.button) return;
    const actions = doc().querySelector('header .header-actions') || doc().querySelector('.header-actions');
    if (!actions) return;
    const wrap = (ui.buttonWrap = el('span', 'aib-term-toggle-wrap'));
    const sep = el('span', 'aib-term-hsep');
    sep.setAttribute('aria-hidden', 'true');
    const b = (ui.button = el('button', 'aib-term-toggle'));
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-controls', 'terminalDock');
    b.setAttribute('aria-keyshortcuts', 'Control+` Control+J');
    b.setAttribute('aria-label', 'Open terminal');
    b.setAttribute('aria-describedby', 'aibTermTip');
    b.append(icon('terminal'));
    ui.live = el('span', 'aib-term-live');
    ui.live.setAttribute('aria-hidden', 'true');
    ui.live.hidden = true;
    b.append(ui.live);
    const tip = (ui.tip = el('div', 'aib-term-tip'));
    tip.id = 'aibTermTip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    ui.tipTitle = el('span', 'aib-term-tip-title', 'Terminal ');
    const kbd = el('kbd', '', 'Ctrl+`');
    ui.tipTitle.append(kbd);
    ui.tipNote = el('span', 'aib-term-tip-note');
    tip.append(ui.tipTitle, ui.tipNote);
    b.addEventListener('click', () => toggle());
    const show = () => (tip.hidden = false);
    const hide = () => (tip.hidden = true);
    b.addEventListener('mouseenter', show);
    b.addEventListener('focus', show);
    b.addEventListener('mouseleave', hide);
    b.addEventListener('blur', hide);
    b.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') hide();
    });
    wrap.append(sep, b, tip);
    actions.append(wrap);
  }

  /** Draw the dock and the button for the open chat. */
  function render() {
    if (!ui.dock) return;
    const cur = host && host.current ? host.current() : null;
    const e = cur ? entries.get(cur.key) : null;
    const show = !!(e && e.visible);
    shownKey = show ? e.key : '';
    for (const other of entries.values()) other.box.hidden = !(show && other === e) || !viewShown(other);
    ui.dock.hidden = !show;
    renderButton(cur, e, show);
    if (!show) {
      ui.warn.hidden = true;
      return;
    }
    renderHead(e);
    renderBody(e);
    fitShown();
  }

  function viewShown(e) {
    return !!e.term && e.status !== 'failed' && e.status !== 'missing' && e.status !== 'limit';
  }

  function renderButton(cur, e, show) {
    const b = ui.button;
    if (!b) return;
    ui.buttonWrap.hidden = !(cur && cur.cwd);
    const live = !!(cur && hasSession(cur.key));
    b.setAttribute('aria-pressed', show ? 'true' : 'false');
    b.classList.toggle('is-on', show);
    ui.live.hidden = !(live && !show);
    const label = show ? 'Hide terminal' : live ? 'Show terminal (session running)' : 'Open terminal';
    b.setAttribute('aria-label', label);
    const folder = (e && e.cwd) || (cur && cur.cwd) || '';
    const p = shortPath(folder);
    ui.tipNote.textContent = folder ? (live ? 'Running in ' : 'Opens in ') + p.prefix + p.last : '';
  }

  function shellLabel(e) {
    return e.shellName || (e.shellChoice === 'windows-powershell' ? 'Windows PowerShell' : 'Shell');
  }

  function renderHead(e) {
    const missing = e.status === 'missing';
    const p = shortPath(e.cwd);
    ui.pathPrefix.textContent = p.prefix;
    ui.pathLast.textContent = p.last;
    ui.pathNote.textContent = missing ? ' (missing)' : '';
    ui.path.classList.toggle('is-missing', missing);
    ui.pathIcon.replaceChildren(icon(missing ? 'missing' : 'folder'));
    const live = e.status === 'ready';
    ui.path.title = shellLabel(e) + (live ? ', running in ' : ', in ') + e.cwd + ' (click to copy)';
    ui.path.setAttribute('aria-label', (missing ? 'Folder missing: ' : 'Folder: ') + e.cwd + '. Copy path');
    const states = {
      ready: ['is-ok', ''],
      loading: ['is-off', ' · starting'],
      connecting: ['is-off', ' · starting'],
      exited: ['is-off', ' · ended'],
      closed: ['is-off', ' · disconnected'],
      failed: ['is-bad', ' · didn’t start'],
      missing: ['is-off', ' · not started'],
      limit: ['is-off', ' · not started'],
    };
    const [cls, word] = states[e.status] || ['is-off', ''];
    ui.shell.className = 'aib-term-shell ' + cls;
    ui.pathDot.className = 'aib-term-path-dot ' + cls;
    ui.shellText.textContent = shellLabel(e) + word;
    ui.shell.title = 'Shell: ' + shellLabel(e) + (live ? ', running' : word);
    const active = e.status === 'ready' || e.status === 'loading' || e.status === 'connecting';
    ui.end.classList.toggle('is-close', !active);
    ui.end.replaceChildren(icon(active ? 'end' : 'close'));
    if (active) setLabel(ui.end, 'End terminal session', 'End session');
    else setLabel(ui.end, e.term ? 'Close terminal panel and clear its output' : 'Close terminal panel');
  }

  function renderBody(e) {
    ui.msg.hidden = true;
    ui.ended.hidden = true;
    ui.msg.className = 'aib-term-msg';
    if (e.status === 'failed') drawFailed(e);
    else if (e.status === 'missing') drawMissing(e);
    else if (e.status === 'limit') drawLimit(e);
    else if (e.status === 'exited') drawEnded(e);
    if (e.warning) drawWarning(e.warning);
    else ui.warn.hidden = true;
  }

  function heading(text, kind, iconName) {
    const h = el('h3', kind ? 'is-' + kind : '');
    if (iconName) h.append(icon(iconName));
    h.append(el('span', '', text));
    return h;
  }
  function action(text, primary, onClick, iconName, label) {
    const b = button('aib-term-act' + (primary ? ' is-primary' : ''), label || '', iconName, text);
    if (!label) b.removeAttribute('title');
    b.addEventListener('click', onClick);
    return b;
  }

  function drawFailed(e) {
    const err = e.error || {};
    ui.msg.className = 'aib-term-msg is-failed';
    ui.msg.setAttribute('role', 'alert');
    const acts = el('div', 'aib-term-acts');
    acts.append(action('Try again', true, () => restart(e)));
    if (isWindows() && shellLabel(e) !== 'Windows PowerShell')
      acts.append(action('Use Windows PowerShell', false, () => restart(e, { shellChoice: 'windows-powershell' })));
    ui.msg.replaceChildren(
      heading('The terminal couldn’t start', 'bad', 'missing'),
      el('span', 'aib-term-mono', err.message || 'The shell did not start.'),
      el(
        'p',
        '',
        'Nothing was run. Try again' + (isWindows() ? ', or use the PowerShell that ships with Windows.' : '.'),
      ),
      acts,
    );
    ui.msg.hidden = false;
  }

  function drawMissing(e) {
    ui.msg.className = 'aib-term-msg is-missing';
    ui.msg.setAttribute('role', 'alert');
    const acts = el('div', 'aib-term-acts');
    const project = e.project && e.project !== e.cwd ? e.project : '';
    if (project) {
      const p = shortPath(project);
      acts.append(
        action(
          'Start in the project folder (' + p.prefix + p.last + ')',
          false,
          () => restart(e, { cwd: project }),
          '',
          'Start the terminal in the project folder: ' + project,
        ),
      );
    }
    acts.append(action('Close panel', false, () => discard(e, true)));
    ui.msg.replaceChildren(
      heading('This chat’s folder no longer exists', 'warn', 'missing'),
      el('span', 'aib-term-mono', e.cwd),
      el(
        'p',
        '',
        (e.worktree ? 'The worktree was probably removed after a merge. ' : '') +
          'The terminal only starts in a folder you can see in its header, so it will not pick one for you.',
      ),
      acts,
    );
    ui.msg.hidden = false;
  }

  function drawLimit(e) {
    const err = e.error || {};
    const list = (Array.isArray(err.terminals) ? err.terminals : [])
      .slice()
      .sort((a, b) => (a.lastActivity || 0) - (b.lastActivity || 0));
    ui.msg.className = 'aib-term-msg is-limit';
    ui.msg.setAttribute('role', 'status');
    const box = el('div', 'aib-term-list');
    box.setAttribute('role', 'list');
    const now = Date.now();
    const shown = e.showAll ? list : list.slice(0, 3);
    for (const t of shown) {
      const row = el('div', 'aib-term-li');
      row.setAttribute('role', 'listitem');
      const name = (host.titleOf && host.titleOf(t.key)) || t.key;
      const p = shortPath(t.cwd);
      const endBtn = action('End', false, async () => {
        endBtn.disabled = true;
        try {
          await host.post('terminal/end', { key: t.key });
        } catch {}
        running.delete(t.key);
        const other = entries.get(t.key);
        if (other) discard(other, false);
        changed();
        restart(e);
      });
      endBtn.setAttribute('aria-label', 'End terminal in ' + name);
      row.append(
        el('span', 'aib-term-li-name', name),
        el('span', 'aib-term-li-folder', p.prefix + p.last),
        el('span', 'aib-term-li-idle', idleText(now - (t.lastActivity || now))),
        endBtn,
      );
      box.append(row);
    }
    const parts = [
      heading((err.max || list.length) + ' terminals are already open'),
      el('p', '', 'End one to start a terminal in this chat. Idle ones first:'),
      box,
    ];
    if (!e.showAll && list.length > shown.length) {
      const acts = el('div', 'aib-term-acts');
      acts.append(
        action('Show all ' + list.length, false, () => {
          e.showAll = true;
          render();
        }),
      );
      parts.push(acts);
    }
    ui.msg.replaceChildren(...parts);
    ui.msg.hidden = false;
  }

  function drawEnded(e) {
    const when = e.endedAt ? new Date(e.endedAt) : null;
    const time = when ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; // the chat's clock
    const line = el(
      'div',
      'aib-term-endline',
      ['Session ended', 'exit code ' + (e.exitCode ?? '?'), time].filter(Boolean).join(' · '),
    );
    line.setAttribute('role', 'status');
    const acts = el('div', 'aib-term-acts');
    const again = action('Start new session', true, () => restart(e), 'newSession');
    acts.append(
      again,
      action('Close panel', false, () => discard(e, true)),
    );
    ui.ended.replaceChildren(line, acts);
    ui.ended.hidden = false;
    if (e.focusEnded) {
      e.focusEnded = false;
      try {
        again.focus();
      } catch {}
    }
  }

  function drawWarning(w) {
    ui.warn.replaceChildren(
      el('span', '', 'A command is still running. Pasting would type into it.'),
      action('Paste anyway', false, () => w.answer(true)),
      action('Cancel', false, () => w.answer(false)),
    );
    ui.warn.hidden = false;
  }

  function fitShown() {
    const e = entries.get(shownKey);
    if (!e || !e.fit || !ui.dock || ui.dock.hidden || e.box.hidden) return;
    try {
      e.fit.fit();
    } catch {}
  }
  function focusEntry(e) {
    if (e && e.term && e.term.focus && viewShown(e)) {
      try {
        e.term.focus();
      } catch {}
    }
  }
  function isWindows() {
    const n = root.navigator;
    const p = (n && ((n.userAgentData && n.userAgentData.platform) || n.platform || n.userAgent)) || '';
    return /win/i.test(p);
  }
  function changed() {
    if (host && host.changed) {
      try {
        host.changed();
      } catch {}
    }
    render();
  }

  /* ---- one chat's terminal ------------------------------------------------------------------------------------------------- */

  function entryFor(cur) {
    let e = entries.get(cur.key);
    if (e) {
      if (!e.term && e.status !== 'ready') e.cwd = cur.cwd || e.cwd; // not started yet: follow the chat's folder
      e.project = cur.project || e.project;
      return e;
    }
    const box = el('div', 'aib-term-view');
    box.dataset.key = cur.key;
    box.hidden = true;
    ui.views.append(box);
    e = {
      key: cur.key,
      cwd: cur.cwd || '',
      project: cur.project || '',
      worktree: !!(cur.project && cur.project !== cur.cwd),
      box,
      term: null,
      fit: null,
      ws: null,
      status: 'loading',
      visible: false,
      ready: null,
      shellName: '',
      shellChoice: '',
      error: null,
      warning: null,
    };
    entries.set(cur.key, e);
    return e;
  }

  function send(e, message) {
    if (e.ws && e.ws.readyState === 1) e.ws.send(JSON.stringify(message));
  }

  /** Make sure the entry has an xterm and an attached shell; resolves when attached. */
  function ensure(e) {
    if ((e.status === 'ready' || e.status === 'connecting' || e.status === 'loading') && e.ready) return e.ready;
    e.status = e.term ? 'connecting' : 'loading';
    e.error = null;
    e.ready = (async () => {
      const lib = await loadXterm();
      if (!e.term) createTerm(e, lib);
      await connect(e, true);
    })();
    e.ready.catch(() => {});
    render();
    return e.ready;
  }

  /** Start again after an end, a failure, a missing folder or the limit (optionally in another folder or shell). */
  function restart(e, change) {
    if (change && change.cwd) e.cwd = change.cwd;
    if (change && change.shellChoice) e.shellChoice = change.shellChoice;
    e.status = 'restart';
    e.showAll = false;
    if (e.term && e.term.reset) e.term.reset();
    return ensure(e).then(
      () => focusEntry(e),
      () => {},
    );
  }

  function createTerm(e, lib) {
    const style = root.getComputedStyle ? root.getComputedStyle(doc().documentElement || doc().body) : null;
    const read = (name) => (style && style.getPropertyValue ? style.getPropertyValue(name) : '');
    const font = (read('--code-font') || '').trim();
    const term = new lib.Terminal({
      cursorBlink: true,
      fontFamily: (font ? font + ', ' : '') + "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: themeFrom(read),
    });
    // The canvas renderer goes in before open(): xterm's DOM renderer would insert <style> elements, which our CSP refuses.
    if (lib.CanvasAddon) term.loadAddon(new lib.CanvasAddon());
    const fit = lib.FitAddon ? new lib.FitAddon() : null;
    if (fit) term.loadAddon(fit);
    e.box.hidden = false;
    term.open(e.box);
    e.box.hidden = shownKey !== e.key;
    term.onData((data) => {
      if (e.status === 'closed') {
        ensure(e).catch(() => {}); // any key reconnects
        return;
      }
      if (e.status === 'ready') send(e, { type: 'input', data });
    });
    term.onResize(({ cols, rows }) => send(e, { type: 'resize', cols, rows }));
    if (term.attachCustomKeyEventHandler) {
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        if (isToggleKey(ev)) return false; // the document handler hides the terminal
        const key = String(ev.key || '').toLowerCase();
        if (ev.ctrlKey && !ev.altKey && key === 'c' && (ev.shiftKey || (term.hasSelection && term.hasSelection()))) {
          copySelection(term);
          return false;
        }
        if (ev.ctrlKey && !ev.altKey && key === 'v') return false; // the browser's paste event: see below
        return true;
      });
    }
    // Pasting (Ctrl+V, the context menu) goes the safe way: lines are put at the prompt, none runs.
    e.box.addEventListener(
      'paste',
      (ev) => {
        const text = ev.clipboardData && ev.clipboardData.getData ? ev.clipboardData.getData('text/plain') : '';
        if (ev.preventDefault) ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        if (text && e.status === 'ready') send(e, { type: 'paste', data: text });
      },
      true,
    );
    e.term = term;
    e.fit = fit;
    if (fit && e.visible) {
      try {
        fit.fit();
      } catch {}
    }
  }

  function copySelection(term) {
    const text = term.getSelection ? term.getSelection() : '';
    if (!text) return;
    try {
      root.navigator.clipboard.writeText(text).catch(() => {});
    } catch {}
  }

  function connect(e, retry) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      Promise.resolve(host.token())
        .then((token) => {
          const WS = (host && host.WebSocket) || root.WebSocket;
          const t = e.term;
          const ws = new WS(
            socketUrl(root.location, e.key, e.cwd, t && t.cols, t && t.rows, e.shellChoice),
            protocols(token),
          );
          ws.binaryType = 'arraybuffer';
          e.ws = ws;
          let attached = false;
          let refused = false;
          ws.onmessage = (ev) => {
            if (typeof ev.data !== 'string') {
              if (e.term) e.term.write(new Uint8Array(ev.data));
              return;
            }
            let m = null;
            try {
              m = JSON.parse(ev.data);
            } catch {
              return;
            }
            if (m.type === 'ready') {
              attached = true;
              if (m.resumed && e.term && e.term.reset) e.term.reset(); // its recent output follows
              e.status = 'ready';
              e.cwd = m.cwd || e.cwd;
              e.shellName = m.shellName || e.shellName;
              running.set(e.key, m);
              changed();
              if (e.term) send(e, { type: 'resize', cols: e.term.cols, rows: e.term.rows });
              done();
            } else if (m.type === 'exit') {
              e.status = 'exited';
              e.exitCode = m.code;
              e.endedAt = Date.now();
              e.focusEnded = shownKey === e.key;
              running.delete(e.key);
              cancelWarning(e);
              changed();
            } else if (m.type === 'busy') {
              const waiter = e.busyWaiters && e.busyWaiters.get(m.id);
              if (waiter) waiter(!!m.busy);
            } else if (m.type === 'error') {
              refused = true;
              e.error = m;
              e.shellName = m.shellName || e.shellName;
              e.status = m.code === 'folder_missing' ? 'missing' : m.code === 'too_many' ? 'limit' : 'failed';
              render();
              done(Error(String(m.message || 'The terminal could not start.')));
            }
          };
          ws.onclose = () => {
            if (e.ws !== ws) return;
            e.ws = null;
            if (!attached) {
              if (refused) return;
              // Refused before attaching: most likely a stale page token after a Studio restart. Try once with a fresh one.
              if (retry && host.refreshToken) {
                Promise.resolve(host.refreshToken())
                  .then(() => connect(e, false))
                  .then(() => done(), done);
                return;
              }
              e.status = 'failed';
              e.error = { message: 'Could not connect to the terminal. Is AIB still running?' };
              render();
              done(Error(e.error.message));
              return;
            }
            if (e.status === 'ready') {
              e.status = 'closed';
              running.delete(e.key);
              if (e.term) e.term.write('\r\n\x1b[2m[Disconnected. Press any key to reconnect.]\x1b[0m\r\n');
              changed();
            }
          };
        })
        .catch((error) => {
          e.status = 'failed';
          e.error = { message: error && error.message ? error.message : String(error) };
          render();
          done(error instanceof Error ? error : Error(String(error)));
        });
    });
  }

  /** Ask the server whether a command is running (Pty.busy). Unknown (no answer in time) counts as not running. */
  function askBusy(e) {
    return new Promise((resolve) => {
      if (!e.ws || e.ws.readyState !== 1) return resolve(false);
      const id = ++busySeq;
      e.busyWaiters = e.busyWaiters || new Map();
      const timer = (root.setTimeout || setTimeout)(() => finish(false), BUSY_TIMEOUT);
      const finish = (busy) => {
        if (!e.busyWaiters.has(id)) return;
        e.busyWaiters.delete(id);
        (root.clearTimeout || clearTimeout)(timer);
        resolve(busy);
      };
      e.busyWaiters.set(id, finish);
      send(e, { type: 'busy?', id });
    });
  }

  function cancelWarning(e) {
    if (e.warning) e.warning.answer(false);
  }

  function discard(e, hide) {
    entries.delete(e.key);
    cancelWarning(e);
    if (e.ws) {
      const ws = e.ws;
      e.ws = null;
      try {
        ws.close();
      } catch {}
    }
    if (e.term) {
      try {
        e.term.dispose();
      } catch {}
    }
    e.box.remove();
    e.status = 'gone';
    if (hide) render();
  }

  /* ---- interface ----------------------------------------------------------------------------------------------------------- */

  function init(h) {
    host = h;
    build();
    buildButton();
    doc().addEventListener('keydown', (ev) => {
      if (!isToggleKey(ev)) return;
      const cur = host.current && host.current();
      if (!cur || !cur.cwd) return;
      ev.preventDefault();
      const e = entries.get(cur.key);
      const inside = !!(ui.dock && ev.target && ui.dock.contains && ui.dock.contains(ev.target));
      if (e && e.visible && inside) {
        close(cur.key, true);
      } else if (e && e.visible) focusEntry(e);
      else show(cur);
    });
    if (typeof root.MutationObserver === 'function' && doc().documentElement) {
      new root.MutationObserver(() => retheme()).observe(doc().documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme'],
      });
    }
    render();
    // Shells that kept running while this page was away (a reload, another window): the sidebar icon and the button's dot.
    if (host.get) {
      Promise.resolve()
        .then(() => host.get('terminal/list'))
        .then((r) => {
          for (const t of (r && r.terminals) || []) running.set(t.key, t);
          changed();
        })
        .catch(() => {});
    }
  }

  function sync() {
    if (!ui.dock) return;
    render();
  }

  async function resolveKey(key) {
    const cur = host && host.current ? host.current() : null;
    if (!key || (cur && cur.key === key)) {
      if (!cur) throw Error('Open a chat first.');
      return cur;
    }
    const ok = host.select ? await host.select(key) : false;
    const now = host.current ? host.current() : null;
    if (!ok || !now || now.key !== key) throw Error('That chat could not be opened.');
    return now;
  }

  const STOPPED = new Set(['exited', 'failed', 'missing', 'limit']);

  /** open(): a stopped session (ended, failed, ...) starts again, since the caller wants a shell. */
  async function open(key) {
    if (!host || !ui.dock) throw Error('The terminal is not available on this page.');
    const cur = await resolveKey(key);
    if (!cur.cwd) throw Error('This chat has no folder to open a terminal in.');
    const e = entryFor(cur);
    e.visible = true;
    if (STOPPED.has(e.status)) e.status = 'restart';
    render();
    await ensure(e);
    render();
    fitShown();
    focusEntry(e);
  }

  /** The button and the keys: show the panel as it is (a stopped session keeps its message), start a shell only when there is none. */
  function show(cur) {
    const e = entryFor(cur);
    e.visible = true;
    if (STOPPED.has(e.status)) {
      render();
      return;
    }
    render();
    ensure(e).then(
      () => {
        fitShown();
        focusEntry(e);
      },
      () => {},
    );
  }

  async function paste(key, text) {
    const value = String(text == null ? '' : text);
    const k = key || ((host && host.current && host.current()) || {}).key;
    await open(k);
    const e = entries.get(k);
    if (!e || !e.ws || e.ws.readyState !== 1) throw Error('The terminal is not connected.');
    if (!value) return true;
    if (await askBusy(e)) {
      cancelWarning(e);
      const go = await new Promise((resolve) => {
        e.warning = {
          answer: (yes) => {
            e.warning = null;
            render();
            resolve(yes);
          },
        };
        render();
      });
      if (!go) {
        focusEntry(e);
        return false;
      }
    }
    if (!e.ws || e.ws.readyState !== 1) throw Error('The terminal is not connected.');
    send(e, { type: 'paste', data: value });
    focusEntry(e);
    return true;
  }

  function isOpen(key) {
    const k = key || (host && host.current && host.current() ? host.current().key : '');
    const e = entries.get(k);
    return !!(e && e.visible && e.status === 'ready');
  }

  function hasSession(key) {
    const e = entries.get(key);
    if (e && (e.status === 'ready' || e.status === 'connecting' || e.status === 'loading'))
      return e.status === 'ready' || running.has(key);
    if (e) return false;
    return running.has(key);
  }

  function rowIcon(key) {
    if (!hasSession(key)) return null;
    const svg = icon('terminal', 'aib-term-row-icon');
    svg.setAttribute('role', 'img');
    svg.removeAttribute('aria-hidden');
    svg.setAttribute('aria-label', 'Terminal session running');
    return svg;
  }

  function close(key, focusBack) {
    const k = key || shownKey;
    const e = entries.get(k);
    if (!e) return;
    e.visible = false;
    render();
    if (!focusBack) return;
    if (host && host.focusComposer) host.focusComposer();
    /* The message box can be disabled or gone (a chat that cannot take messages): focus must not fall to <body>, so it goes to
       the terminal button, where Ctrl+` or Enter brings the panel back. */
    const d = doc(),
      a = d.activeElement;
    if ((!a || a === d.body || (ui.dock && ui.dock.contains && ui.dock.contains(a))) && ui.button && ui.button.focus)
      ui.button.focus();
  }

  async function end(key) {
    const k = key || shownKey || (host && host.current && host.current() ? host.current().key : '');
    if (!k) return;
    const e = entries.get(k);
    if (e) discard(e, false);
    running.delete(k);
    changed();
    await host.post('terminal/end', { key: k });
  }

  function toggle() {
    const cur = host && host.current ? host.current() : null;
    if (!cur) return;
    const e = entries.get(cur.key);
    if (e && e.visible) close(cur.key, false);
    else show(cur);
  }

  function retheme() {
    const style = root.getComputedStyle ? root.getComputedStyle(doc().documentElement || doc().body) : null;
    const read = (name) => (style && style.getPropertyValue ? style.getPropertyValue(name) : '');
    const theme = themeFrom(read);
    for (const e of entries.values()) {
      if (e.term && e.term.options) e.term.options.theme = theme;
    }
  }

  /* ---- a sign-in terminal (Settings > AIB Linking > Beta agents) ------------------------------------------------------------ */

  /** The socket address of a Beta agent's sign-in terminal: the server picks the program (the agent's own login), never the page. */
  function signinUrl(loc, agentId, cols, rows) {
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ signin: agentId, cols: String(cols || 80), rows: String(rows || 24) });
    return scheme + '//' + loc.host + '/api/live/terminal?' + q;
  }
  /**
   * runSignin(box, agentId, hooks): run a Beta agent's own sign-in command (ACP terminal auth) in an AIB terminal inside `box`
   * (a ConPTY on the server: no window ever opens). hooks: {onReady(), onExit(code), onError(message)}. Returns {close()}, which ends
   * the command. Same look and keys as the chat terminal (copy with Ctrl+Shift+C); nothing typed here goes to an agent chat.
   */
  function runSignin(box, agentId, hooks) {
    const h = hooks || {};
    const run = { ws: null, term: null, closed: false, done: false };
    const fail = (message) => {
      if (run.done) return;
      run.done = true;
      if (h.onError) h.onError(message);
    };
    loadXterm()
      .then((lib) => {
        if (run.closed) return;
        const style = root.getComputedStyle ? root.getComputedStyle(doc().documentElement || doc().body) : null;
        const read = (name) => (style && style.getPropertyValue ? style.getPropertyValue(name) : '');
        const font = (read('--code-font') || '').trim();
        const term = new lib.Terminal({
          cursorBlink: true,
          fontFamily: (font ? font + ', ' : '') + "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
          fontSize: 13,
          lineHeight: 1.15,
          scrollback: 2000,
          theme: themeFrom(read),
        });
        if (lib.CanvasAddon) term.loadAddon(new lib.CanvasAddon()); // before open(): the DOM renderer's <style> breaks our CSP
        const fit = lib.FitAddon ? new lib.FitAddon() : null;
        if (fit) term.loadAddon(fit);
        term.open(box);
        try {
          if (fit) fit.fit();
        } catch {}
        run.term = term;
        if (term.attachCustomKeyEventHandler)
          term.attachCustomKeyEventHandler((ev) => {
            const key = String(ev.key || '').toLowerCase();
            if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && key === 'c') {
              copySelection(term);
              return false;
            }
            return true;
          });
        if (!host || !host.token) throw Error('The terminal is not ready yet. Open a chat once, then try again.');
        return Promise.resolve(host.token()).then((token) => {
          if (run.closed) return;
          const WS = (host && host.WebSocket) || root.WebSocket;
          const ws = new WS(signinUrl(root.location, agentId, term.cols, term.rows), protocols(token));
          ws.binaryType = 'arraybuffer';
          run.ws = ws;
          term.onData((data) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
          });
          term.onResize(({ cols, rows }) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
          });
          ws.onmessage = (ev) => {
            if (typeof ev.data !== 'string') return term.write(new Uint8Array(ev.data));
            let m = null;
            try {
              m = JSON.parse(ev.data);
            } catch {
              return;
            }
            if (m.type === 'ready') {
              if (h.onReady) h.onReady();
              if (term.focus) term.focus();
            } else if (m.type === 'exit' && !run.done) {
              run.done = true;
              if (h.onExit) h.onExit(Number(m.code));
            } else if (m.type === 'error') fail(String(m.message || 'The sign-in could not start.'));
          };
          ws.onclose = () => {
            if (!run.closed) fail('The sign-in terminal closed before the sign-in finished.');
          };
        });
      })
      .catch((error) => fail((error && error.message) || String(error)));
    return {
      close() {
        run.closed = true;
        run.done = true;
        try {
          if (run.ws) run.ws.close();
        } catch {}
        try {
          if (run.term) run.term.dispose();
        } catch {}
      },
    };
  }

  const api = {
    init,
    sync,
    open,
    paste,
    isOpen,
    hasSession,
    rowIcon,
    close,
    end,
    toggle,
    retheme,
    runSignin,
    signinUrl,
    socketUrl,
    protocols,
    themeFrom,
    clampHeight,
    shortPath,
    idleText,
    isToggleKey,
  };
  root.AibTerminal = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
