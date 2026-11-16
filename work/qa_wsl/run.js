'use strict';
/* QA (looks) run for the WSL screens: renders every state with the real page code against fake routes, in headless Chrome
   (no window), and writes screenshots + data.json under outputs/qa-wsl/. build_report.js turns data.json into measurements.md and
   index.html. Usage: node work/qa_wsl/run.js */
const fs = require('node:fs'),
  path = require('node:path');
const { launch } = require('./browser');
const P = require('./pages');
const PR = require('./probes');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'outputs', 'qa-wsl');
const SHOTS = path.join(OUT, 'shots');
const SCRATCH = path.join(ROOT, 'dist', '.scratch', 'qa-wsl');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const DARK = 'teal-dark'; // AIB's default theme (THEMES.md: also when <html> has no data-theme)
const LIGHT = 'teal-light';

// Equivalent elements in the mockup and the page (scoped to .st-content unless the selector says otherwise).
const SEL = {
  'card': '.st-card',
  'card title': '.st-card-title',
  'lead (C1)': '.wl-lead',
  'distro row': '.wl-distro',
  'distro letter': '.wl-distro .st-letter',
  'distro name': '.wl-distro strong',
  'distro tag': '.wl-distro .st-tag',
  'chip ok (Ready)': '.st-status.ok',
  'chip warn': '.st-status.warn',
  'chip bad': '.st-status.bad',
  'chip dim': '.st-status.dim',
  'group heading': '.st-group',
  'facts dt': '.st-facts dt',
  'facts dd': '.st-facts dd',
  'note (plain)': '.st-card > .st-note:not(.dim):not(.bad):not(.wl-lead):not(.wl-foot)',
  'note dim': '.st-note.dim',
  'note bad': '.st-note.bad',
  'checks list': '.dv-checks',
  'check row': '.dv-checks li',
  'check head': '.dv-check-head',
  'check mark ok': '.dv-checks li.ok .dv-mark',
  'check mark bad': '.dv-checks li.bad .dv-mark',
  'check state': '.wl-state',
  'agent row': '.st-card .st-agent:not(.wl-distro)',
  'agent head': '.st-agent:not(.wl-distro) .st-agent-head',
  'agent letter': '.st-agent:not(.wl-distro) .st-letter',
  'agent name': '.st-agent:not(.wl-distro) strong',
  'agent tag': '.st-agent:not(.wl-distro) .st-tag',
  'button primary': 'button.st-primary:not(:disabled)',
  'button primary (off)': 'button.st-primary:disabled',
  'button danger': 'button.st-danger',
  'button link': 'button.st-link',
  'button plain': 'button:not([class]):not(:disabled)',
  'button cancel': 'button.st-cancel',
  'button primary (card)': 'button.primary',
  'switch label': '.st-toggle',
  'switch input': '.st-toggle input',
  'command code': 'code.st-command',
  'copy row': '.st-beta-row',
  'progress': '.st-progress',
  'progress fill': '.st-progress-bar',
  'limits line': '.wl-limits',
  'limits value': '.wl-limits b',
  'usage list': '.wl-usage',
  'usage dt': '.wl-usage dt',
  'usage dd': '.wl-usage dd',
  'footer': '.wl-foot',
  'hint': '.st-hint',
  'needs first': '.st-beta-needs',
  'actions row': '.st-actions',
};
const PAGE_SEL = { 'page heading h2': '.st-head h2', 'nav active': '.st-section.active', 'search': '.st-search', 'content': '.st-content' };
const SIZE_MATTERS = /button|chip|tag|letter|switch|progress|search|check mark|distro row|agent head/;

const MOCK_PAIRS = [
  ['good', 'good'],
  ['node-missing', 'node'],
  ['installing', 'installing'],
  ['update', 'update'],
  ['error', 'error'],
  ['stopped', 'stopped'],
  ['nowsl', 'nowsl'],
  ['two', 'two'],
];

const SETTINGS = {
  'good': 'All good: Claude Code installed by AIB (signed in), Codex your own install with the usage line, OMP found; docker-desktop not supported',
  'node-missing': 'Node.js missing: Install Node.js in What Ubuntu needs; agent Install off with "Needs Node.js first"',
  'node-old': 'Node.js too old (18.19.1, system)',
  'asdf': 'asdf shim with no Node.js version set: the asdf commands, no nvm, no Install button',
  'pkg-missing': 'git and curl missing (dnf), 380 MB free, plain shell',
  'installing': 'Installing Claude Code: progress 46 % and Cancel',
  'update': 'Update available (Claude Code 0.98.1 -> 0.102.0), Codex not signed in',
  'error': 'Install failed (Codex, npm ETIMEDOUT) + git missing',
  'signin': 'Sign-in states: Signed in (account), Not signed in (Sign in), unknown (note)',
  'switch-fail': 'The per-distro switch could not be saved (rolled back, reason on the card)',
  'stopped': 'Distro stopped: Reconnect',
  'off': 'Distro not running: Start Ubuntu and check',
  'starting': 'Starting / setting up AIB (first time)',
  'problem': 'Problem: helper checksum, Reconnect',
  'nowsl': 'No WSL on this PC',
  'nodistro': 'WSL but no distro (wsl --install -d Ubuntu)',
  'two': 'Two distros + WSL 1 + docker-desktop, drop-down shown open (simulated as a list box: a native drop-down is drawn by Windows, not in a screenshot)',
  'two-debian': 'Two ready distros, the remembered choice Debian shown',
  'aib-clean': 'AIB in Ubuntu: no other data folders, no dirty copies, 2 chats working',
  'aib-notready': 'AIB in Ubuntu while the answer says not ready',
  'aib-error': 'AIB in Ubuntu: read error',
  'rm-check': 'Remove dialog: the check, nothing blocks (groups, kept, never touched)',
  'rm-blocked': 'Remove dialog: blocked (reasons, button off, Close + Check again)',
  'rm-second': 'Remove dialog: after the first click (second-click prompt)',
  'rm-tick': 'Remove dialog: chats running, the "I understand" tick',
  'rm-removing': 'Remove dialog: Removing…',
  'rm-done': 'After a successful Remove: "AIB is not set up in Ubuntu" + Set up again',
  'rm-partial': 'Remove dialog: partial failure (message, left list, what went)',
  'rm-partial-closed': 'After a partial failure, dialog closed: the card keeps the left list',
  'rm-long': 'Remove dialog with long paths and a long reason',
  'uninstall-ask': 'Uninstall: the question (native window.confirm, answered No)',
  'uninstall-refused': 'Uninstall refused: the blocked reason on the card',
  'node-term': 'Node.js install terminal panel on its card (terminal content is a stand-in)',
  'signin-term': 'Sign-in terminal panel on the Codex card (terminal content is a stand-in)',
  'long': 'Long distro name, long account, long path, long reason',
  'many-agents': '30 agent rows from the distro route',
  'about': 'Settings > AIB server (About) with the per-distro line',
  'win-agents': 'Reference: Windows AIB Linking (the agent cards the WSL page reuses)',
};
const LIGHT_SET = ['win-agents', 'rm-second', 'good', 'node-missing', 'asdf', 'installing', 'update', 'error', 'signin', 'stopped', 'off', 'nowsl', 'two', 'rm-check', 'rm-blocked', 'rm-tick', 'rm-partial', 'rm-done', 'node-term', 'about'];
const WIDTH_SET = ['good', 'long', 'rm-long', 'many-agents', 'two', 'error'];
const WIDTHS = [700, 900, 1280, 1400];

const OTHER = {
  'state-starting': 'Distro state line: Starting Ubuntu…',
  'state-setup': 'Distro state line: Setting up AIB in Ubuntu (first time)',
  'state-stopped': 'Distro state line: Ubuntu stopped. + Reconnect',
  'open-url': 'Open-URL bar: "Ubuntu wants to open <url>" (long OAuth URL)',
  'np-wsl': 'New project: Location WSL: Ubuntu',
  'np-browse': 'New project: Browse Ubuntu… folder list',
  'del-wsl': 'Delete project (WSL): default, tick off',
  'del-wsl-ticked': 'Delete project (WSL): "Move folder to trash in Ubuntu" ticked',
  'del-wsl-refused': 'Delete project (WSL): the distro refuses (tick off, reason)',
  'nc-missing': 'New chat, WSL project: Claude Code not installed in Ubuntu (Install box, copy command, links)',
  'nc-node': 'New chat, WSL project: not installed and Node.js missing',
  'nc-installing': 'New chat, WSL project: installing (progress, Cancel)',
  'nc-found': 'New chat, WSL project: found, installed by AIB, Sign in',
  'nc-update': 'New chat, WSL project: update available',
  'status-words': 'Chat list: Live "● Ready · Live in AIB" vs saved "Ready", Your turn, Working, Couldn\'t reopen; header "Ubuntu · ~/app"',
  'project-menu': 'Project menu: WSL rows with the distro chip',
  'publish-failed': 'Failed publish card with the reason line (the WSL path refusal)',
};

async function main() {
  const b = await launch(SCRATCH);
  const PARTS = (process.env.QA_PARTS || 'A,M,D,B,C,E').split(',');
  const prev = PARTS.length < 6 && fs.existsSync(path.join(OUT, 'data.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'data.json'), 'utf8')) : null;
  const data = { when: new Date().toISOString(), settings: {}, mockup: {}, other: {}, widths: {}, contrast: [], focus: {}, strings: [], errors: {}, dialogs: {} };
  if (prev) {
    Object.assign(data, prev, { when: new Date().toISOString() });
    if (PARTS.includes('B')) {
      data.other = {};
      data.strings = data.strings.filter((x) => !x.where.startsWith('B '));
    }
    if (PARTS.includes('C')) data.contrast = [];
  }
  const urls = {};
  const urlFor = (kind, theme) => {
    const k = kind + theme;
    if (!urls[k])
      urls[k] =
        kind === 'mockup'
          ? P.mockup(SCRATCH, theme)
          : kind === 'settings'
            ? P.page(SCRATCH, 'settings', P.SETTINGS_SCRIPTS, path.join(__dirname, 'settings_fixtures.js'), theme)
            : P.page(SCRATCH, 'other', P.OTHER_SCRIPTS, path.join(__dirname, 'other_fixtures.js'), theme);
    return urls[k];
  };
  const ev = (fn, ...a) => b.evaluate(fn, ...a);

  // the Settings page grows to show its whole content in one picture (the content box scrolls in the app)
  async function fullShot(file, width) {
    await b.size(width, 860);
    await new Promise((r) => setTimeout(r, 60));
    const dlg = await ev(() => {
      const d = document.querySelector('.wl-remove, .dp-dialog');
      return d ? { over: d.scrollHeight - d.clientHeight, h: d.scrollHeight } : null;
    });
    let h = 860;
    if (!dlg) {
      // grow until the content box no longer scrolls (its height depends on the window: re-measure each time)
      for (let i = 0; i < 6; i++) {
        const extra = await ev(() => {
          const c = document.querySelector('.st-content') || document.querySelector('#mkContent');
          return c ? Math.max(0, c.scrollHeight - c.clientHeight) : 0;
        });
        if (extra <= 1) break;
        h = Math.min(h + extra, 12000);
        await b.size(width, h);
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    await b.shot(file);
    const extraFiles = [];
    if (dlg && dlg.over > 0) {
      // the dialog scrolls inside (max-height 70vh): a second picture with the whole dialog unrolled, labelled as such
      await ev(() => {
        const d = document.querySelector('.wl-remove, .dp-dialog');
        d.style.maxHeight = 'none';
      });
      await b.size(width, Math.min(dlg.h + 300, 3000));
      await new Promise((r) => setTimeout(r, 60));
      const f2 = file.replace(/\.png$/, '-unrolled.png');
      await b.shot(f2);
      extraFiles.push(f2);
    }
    await b.size(width, 860);
    return { height: h, dialog: dlg, extraFiles };
  }

  // ---- A: Settings states ------------------------------------------------------------------------------------------------------
  if (PARTS.includes('A')) for (const theme of [DARK, LIGHT]) {
    for (const scen of Object.keys(SETTINGS)) {
      if (theme === LIGHT && !LIGHT_SET.includes(scen)) continue;
      await b.size(1280, 860);
      const err = await b.goto(urlFor('settings', theme) + '#' + scen);
      const key = `${scen}@${theme}`;
      if (err || b.log.errors.length) data.errors[key] = [err, ...b.log.errors].filter(Boolean);
      if (b.log.dialogs.length) data.dialogs[key] = b.log.dialogs.map((d) => ({ type: d.type, message: d.message }));
      const confirm = await ev('window.__qaConfirm || ""');
      const m = await ev(PR.measure, SEL, '.st-content');
      const pg = await ev(PR.measure, PAGE_SEL, null);
      const dlgM = await ev(PR.measure, { 'dialog': '.wl-remove', 'dialog title': '.wl-remove .dp-title', 'dialog main': '.wl-remove .dp-main', 'dialog list head': '.wl-rm-head', 'dialog item line': '.wl-rm-line', 'dialog size': '.wl-rm-line .wl-size', 'dialog path': '.wl-rm-path', 'dialog why': '.wl-rm-why', 'dialog reason': '.wl-reason', 'dialog warn': '.wl-remove .dp-warn', 'dialog tick': '.wl-remove .dp-disk', 'dialog yes': '.wl-remove .dp-ok', 'dialog cancel': '.wl-remove .dp-cancel', 'dialog check again': '.wl-remove button:not(.dp-ok):not(.dp-cancel)', 'scrim': '.dp-scrim' }, null);
      const file = path.join(SHOTS, `A-${scen}-${theme}.png`);
      const shot = await fullShot(file, 1280);
      const over = await ev(PR.overflow, '.st-content');
      data.settings[key] = { scen, theme, caption: SETTINGS[scen], file: path.relative(OUT, file), extra: shot.extraFiles.map((f) => path.relative(OUT, f)), measure: m, page: pg, dialog: dlgM, dialogBox: shot.dialog, confirm, overflow: over };
      if (theme === DARK) {
        const roots = ['.st-content', '.wl-remove'];
        for (const s of await ev(PR.strings, roots)) data.strings.push(Object.assign({ where: 'A ' + scen }, s));
      }
      process.stdout.write('.');
    }
  }
  // ---- A: the mockup states -----------------------------------------------------------------------------------------------------
  if (PARTS.includes('M')) for (const theme of [DARK, LIGHT]) {
    for (const [, mk] of MOCK_PAIRS) {
      await b.size(1280, 860);
      await b.goto(urlFor('mockup', theme) + '#' + mk);
      const m = await ev(PR.measure, SEL, '#mkContent');
      const pg = await ev(PR.measure, PAGE_SEL, null);
      const file = path.join(SHOTS, `M-${mk}-${theme}.png`);
      await fullShot(file, 1280);
      data.mockup[`${mk}@${theme}`] = { mk, theme, file: path.relative(OUT, file), measure: m, page: pg };
      process.stdout.write('m');
    }
  }
  data.pairs = MOCK_PAIRS;
  // ---- D: widths -------------------------------------------------------------------------------------------------------------------
  if (PARTS.includes('D')) for (const w of WIDTHS) {
    for (const scen of WIDTH_SET) {
      if (w === 1280 && !['long', 'rm-long', 'many-agents'].includes(scen)) continue;
      await b.size(w, 860);
      await b.goto(urlFor('settings', DARK) + '#' + scen);
      const over = await ev(PR.overflow, scen.startsWith('rm-') ? '.wl-remove' : '.st-content');
      const geo = await ev(() => {
        const r = (s) => {
          const e = document.querySelector(s);
          return e ? e.getBoundingClientRect().toJSON() : null;
        };
        return { content: r('.st-content'), nav: r('.st-nav'), pick: r('.wl-pick select'), dialog: r('.wl-remove'), page: r('.st-page') };
      });
      const file = path.join(SHOTS, `D-${scen}-${w}.png`);
      const shot = await fullShot(file, w);
      data.widths[`${scen}@${w}`] = { scen, width: w, file: path.relative(OUT, file), extra: shot.extraFiles.map((f) => path.relative(OUT, f)), overflow: over, geo };
      process.stdout.write('w');
    }
  }
  // ---- B: the other screens -------------------------------------------------------------------------------------------------------
  if (PARTS.includes('B')) for (const theme of [DARK, LIGHT]) {
    for (const scen of Object.keys(OTHER)) {
      await b.size(1280, 860);
      const err = await b.goto(urlFor('other', theme) + '#' + scen);
      const key = `${scen}@${theme}`;
      if (err || b.log.errors.length) data.errors[key] = [err, ...b.log.errors].filter(Boolean);
      const file = path.join(SHOTS, `B-${scen}-${theme}.png`);
      await b.shot(file);
      const m = await ev(PR.measure, {
        'state line': '#wslStateLine',
        'state line text': '#wslStateLine span',
        'state line button': '#wslStateLine button',
        'open bar': '#wslOpenAsk',
        'open bar text': '#wslOpenAsk span',
        'open bar button': '#wslOpenAsk button',
        'server notice (reference)': '#studioNotice',
        'np dialog': '.np-dialog',
        'np location': 'select.np-location',
        'np folder input': '.np-dialog input[type="text"]',
        'np browse wsl': '.np-dialog button.np-browse-wsl, .np-dialog .np-browse + button',
        'np dirs': '.np-dirs',
        'np dir row': '.np-dir',
        'np dirs here': '.np-dirs-here',
        'dp dialog': '.dp-dialog',
        'dp title': '.dp-dialog .dp-title',
        'dp main': '.dp-dialog .dp-main',
        'dp cancel': '.dp-dialog .dp-cancel',
        'dp running': '.dp-dialog .dp-running',
        'dp tick row': '.dp-disk',
        'dp tick input': '.dp-disk input',
        'dp note': '.dp-note',
        'dp warn': '.dp-warn',
        'dp yes': '.dp-ok',
        'nc box': '#ncWsl',
        'nc line bad': '#ncWsl .st-note.bad',
        'nc line': '#ncWsl > .st-note:not(.bad)',
        'nc install button': '#ncWsl button.st-primary',
        'nc link': '#ncWsl button.st-link',
        'nc cmd': '#ncWsl code',
        'nc progress': '#ncWsl .st-progress',
        'nc grid (form)': '.nc-grid',
        'nc folder': '#ncFolder',
        'nc agent select': '#ncAgent',
        'row phrase': '.row-phrase',
        'badge live': '.badge-live',
        'badge saved': '.badge-saved',
        'badge recovered': '.badge-recovered',
        'status detail': '.status-detail',
        'distro chip': '.ws-distro',
        'art card': '.art-card',
        'art card title': '.art-card-title',
        'art card sub': '.art-card-sub',
        'art card err': '.art-card-err',
      }, null);
      const over = await ev(PR.overflow, 'body');
      data.other[key] = { scen, theme, caption: OTHER[scen], file: path.relative(OUT, file), measure: m, overflow: over.slice(0, 40), card: await ev('window.__qaCardModel || null') };
      if (theme === DARK) {
        for (const s of await ev(PR.strings, ['#wslStateLine', '#wslOpenAsk', '.np-dialog', '.dp-dialog', '#ncWsl', '#connections', '.art-card', '.ws-pmenu, .ws-project-menu, [role="dialog"]', 'header'])) data.strings.push(Object.assign({ where: 'B ' + scen }, s));
      }
      process.stdout.write('b');
    }
  }
  // ---- C: contrast of the new elements, both themes ----------------------------------------------------------------------------------
  const CI = [
    ['chip Ready / Signed in (ok)', '.st-status.ok'],
    ['chip Not signed in / Not installed (warn)', '.st-status.warn'],
    ['chip Stopped / Install failed (bad)', '.st-status.bad'],
    ['chip Not running / Not supported (dim)', '.st-status.dim'],
    ['tag (Installed by AIB, WSL 2 · WSL default)', '.st-tag'],
    ['agent letter', '.st-letter'],
    ['button danger (Uninstall / Remove AIB)', 'button.st-danger'],
    ['button primary', 'button.st-primary:not(:disabled)'],
    ['button primary, off', 'button.st-primary:disabled'],
    ['button link (Check again, Copy)', 'button.st-link'],
    ['muted note (.st-note.dim)', '.st-note.dim'],
    ['note', '.st-note'],
    ['bad note (.st-note.bad)', '.st-note.bad'],
    ['check state found (ok)', '.wl-checks li.ok .wl-state'],
    ['check state missing (bad)', '.wl-checks li.bad .wl-state'],
    ['check mark bad', '.wl-checks li.bad .dv-mark'],
    ['node path (.wl-path)', '.wl-path'],
    ['Checked with line', '.wl-checked'],
    ['limits line', '.wl-limits'],
    ['limits value', '.wl-limits b'],
    ['usage dt', '.wl-usage dt'],
    ['size (.wl-size)', '.wl-size'],
    ['in use chip', '.wl-others .st-status'],
    ['hint', '.st-hint'],
    ['facts dt', '.st-facts dt'],
    ['group heading', '.st-group'],
    ['drop-down', '.wl-pick select'],
    ['drop-down disabled option (list box)', '.wl-pick select option:disabled'],
    ['dialog path (.wl-rm-path)', '.wl-rm-path'],
    ['dialog why (.wl-rm-why)', '.wl-rm-why'],
    ['dialog destructive button (dp-ok)', '.wl-remove .dp-ok:not(:disabled)'],
    ['dialog destructive button, off', '.wl-remove .dp-ok:disabled'],
    ['dialog warn', '.wl-remove .dp-warn'],
    ['dialog reason', '.wl-reason'],
    ['switch label', '.st-toggle'],
  ];
  if (PARTS.includes('C')) for (const theme of [DARK, LIGHT]) {
    for (const scen of ['good', 'node-missing', 'error', 'two', 'rm-check', 'rm-blocked', 'rm-second', 'stopped', 'off', 'update', 'installing']) {
      await b.size(1280, 860);
      await b.goto(urlFor('settings', theme) + '#' + scen);
      const r = await ev(PR.contrast, CI.map(([label, sel]) => ({ label, sel })));
      for (const x of r) data.contrast.push(Object.assign({ theme, where: scen }, x));
    }
    for (const scen of ['state-stopped', 'open-url', 'del-wsl-ticked', 'del-wsl-refused', 'nc-missing', 'status-words', 'project-menu', 'publish-failed', 'np-browse']) {
      await b.goto(urlFor('other', theme) + '#' + scen);
      const r = await ev(PR.contrast, [
        { label: 'state/open line text', sel: '.studio-notice:not([hidden]) span' },
        { label: 'state/open line button', sel: '.studio-notice:not([hidden]) button' },
        { label: 'delete: tick label', sel: '.dp-disk span' },
        { label: 'delete: tick label, off', sel: '.dp-disk input:disabled + span' },
        { label: 'delete: note', sel: '.dp-note' },
        { label: 'delete: warn', sel: '.dp-warn' },
        { label: 'delete: destructive button', sel: '.dp-ok' },
        { label: 'new chat: not installed line', sel: '#ncWsl .st-note.bad' },
        { label: 'new chat: dim copy line', sel: '#ncWsl .st-note.dim' },
        { label: 'new chat: link', sel: '#ncWsl .st-link' },
        { label: 'badge live (● Ready)', sel: '.badge-live' },
        { label: 'badge saved', sel: '.badge-saved' },
        { label: "badge recovered / Couldn't reopen", sel: '.badge-recovered' },
        { label: 'status detail (Live in AIB)', sel: '.status-detail' },
        { label: 'row phrase', sel: '.row-phrase' },
        { label: 'distro chip', sel: '.ws-distro' },
        { label: 'publish card reason', sel: '.art-card-err' },
        { label: 'publish card sub', sel: '.art-card-sub' },
        { label: 'folder list row', sel: '.np-dir' },
        { label: 'folder list here', sel: '.np-dirs-here' },
      ]);
      for (const x of r) data.contrast.push(Object.assign({ theme, where: scen }, x));
    }
  }
  // ---- E: keyboard and a11y ---------------------------------------------------------------------------------------------------------
  await b.size(1280, 860);
  if (PARTS.includes('E')) for (const scen of ['good', 'installing', 'two']) {
    await b.goto(urlFor('settings', DARK) + '#' + scen);
    data.focus[scen] = { attrs: await ev(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const sel = document.querySelector('.wl-pick select');
      return {
        select: sel && { role: sel.getAttribute('role') || '(implicit combobox)', ariaLabel: sel.getAttribute('aria-label'), label: sel.labels && sel.labels[0] ? sel.labels[0].textContent : '', options: [...sel.options].map((o) => ({ text: o.textContent, disabled: o.disabled, selected: o.selected })) },
        switches: q('.st-toggle input').map((i) => ({ type: i.type, role: i.getAttribute('role') || '', checked: i.checked, ariaChecked: i.getAttribute('aria-checked'), label: i.closest('label') ? i.closest('label').textContent.trim() : '', ariaLabel: i.getAttribute('aria-label') || '' })),
        progress: q('.st-progress').map((p) => ({ role: p.getAttribute('role'), now: p.getAttribute('aria-valuenow'), min: p.getAttribute('aria-valuemin'), max: p.getAttribute('aria-valuemax'), label: p.getAttribute('aria-label') })),
        chips: q('.st-status').map((c) => ({ text: c.textContent, role: c.getAttribute('role') || '', live: c.getAttribute('aria-live') || '', title: c.title || '' })),
        statusRegions: q('[role="status"],[aria-live]').map((n) => ({ cls: n.className, role: n.getAttribute('role'), live: n.getAttribute('aria-live') })),
      };
    }) };
    // focus walk: from the drop-down, Tab through the content
    await ev(() => {
      const s = document.querySelector('.wl-pick select') || document.querySelector('.st-content button');
      s.focus();
      return 1;
    });
    const walk = [await ev(PR.focusInfo)];
    for (let i = 0; i < 45; i++) {
      await b.key('Tab');
      walk.push(await ev(PR.focusInfo));
    }
    data.focus[scen].walk = walk;
  }
  // focus rings: shots of the drop-down, a switch, a primary button and a danger button with keyboard focus
  if (PARTS.includes('E')) {
    await b.goto(urlFor('settings', DARK) + '#good');
    const rings = [];
    for (const [label, sel] of [
      ['drop-down', '.wl-pick select'],
      ['switch', '.st-toggle input'],
      ['link button (Check again)', '.st-agent button.st-link'],
      ['danger button (Uninstall)', '.st-agent button.st-danger'],
      ['danger button (Remove AIB)', '.st-card:last-of-type button.st-danger'],
    ]) {
      await ev((s) => {
        document.activeElement && document.activeElement.blur && document.activeElement.blur();
        const e = [...document.querySelectorAll(s)].pop();
        e.scrollIntoView({ block: 'center' });
        return 1;
      }, sel);
      // reach it by keyboard so :focus-visible applies: focus the element before it, then Tab
      await ev((s) => {
        const e = [...document.querySelectorAll(s)].pop();
        const all = [...document.querySelectorAll('button, input, select, a[href], [tabindex]')].filter((x) => !x.disabled && x.getClientRects().length && x.tabIndex >= 0);
        const i = all.indexOf(e);
        (all[i - 1] || e).focus();
        return i;
      }, sel);
      await b.key('Tab');
      const info = await ev(PR.focusInfo);
      const box = await ev(() => {
        const r = document.activeElement.getBoundingClientRect();
        return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 };
      });
      const file = path.join(SHOTS, `E-focus-${rings.length}.png`);
      await b.shot(file, box);
      rings.push({ label, info, file: path.relative(OUT, file) });
    }
    data.focus.rings = rings;
  }
  // the Remove dialog: Cancel focused, Tab stays inside, Escape closes, focus goes back
  if (PARTS.includes('E')) {
    await b.goto(urlFor('settings', DARK) + '#rm-check');
    const first = await ev(PR.focusInfo);
    const tabs = [];
    for (let i = 0; i < 8; i++) {
      await b.key('Tab');
      tabs.push(await ev(PR.focusInfo));
    }
    const back = [];
    for (let i = 0; i < 4; i++) {
      await b.key('Tab', { shift: true });
      back.push(await ev(PR.focusInfo));
    }
    const attrs = await ev(() => {
      const d = document.querySelector('.wl-remove');
      return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), labelledby: d.getAttribute('aria-labelledby'), title: (document.getElementById(d.getAttribute('aria-labelledby')) || {}).textContent, describedby: d.getAttribute('aria-describedby') };
    });
    await b.key('Escape');
    const after = await ev(() => ({ open: !!document.querySelector('.wl-remove'), settingsOpen: !document.querySelector('.st-page').hidden }));
    const ret = await ev(PR.focusInfo);
    data.focus.removeDialog = { first, tabs, back, attrs, afterEscape: after, focusAfter: ret };
    // a Windows reference: the delete-project dialog's focus (delete-project-ui.js)
    await b.goto(urlFor('other', DARK) + '#del-wsl');
    const dfirst = await ev(PR.focusInfo);
    const dtabs = [];
    for (let i = 0; i < 5; i++) {
      await b.key('Tab');
      dtabs.push(await ev(PR.focusInfo));
    }
    data.focus.deleteDialog = { first: dfirst, tabs: dtabs };
  }
  fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data, null, 1));
  const gone = await b.close();
  console.log('\nprofile removed:', gone, 'errors:', Object.keys(data.errors).length);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
