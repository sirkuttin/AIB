'use strict';
/* outputs/qa-wsl/data.json + work/qa_wsl/findings.json -> outputs/qa-wsl/measurements.md and outputs/qa-wsl/index.html (one
   self-contained page: every screenshot inline as base64, no network). Screenshots are re-encoded to WebP for the page by headless
   Chrome (the PNGs stay in outputs/qa-wsl/shots). Usage: node work/qa_wsl/build_report.js */
const fs = require('node:fs'),
  path = require('node:path');
const { launch } = require('./browser');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'outputs', 'qa-wsl');
const APP = path.join(ROOT, 'app', 'page');
const SCRATCH = path.join(ROOT, 'dist', '.scratch', 'qa-wsl');
const data = JSON.parse(fs.readFileSync(path.join(OUT, 'data.json'), 'utf8'));
const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'findings.json'), 'utf8'));

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const num = (v) => (typeof v === 'number' ? v : /^-?[\d.]+px$/.test(String(v)) ? parseFloat(v) : null);

// ---- A: mockup vs page differences -------------------------------------------------------------------------------------------------
const SIZE_MATTERS = /button|chip|tag|letter|switch|progress|search|check mark|distro row|agent head|copy row/;
const PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderTopLeftRadius', 'gap', 'textTransform', 'letterSpacing', 'textDecorationLine', 'opacity', 'textAlign', 'display', 'alignItems', 'whiteSpace', 'fontStyle'];
function diff(m, a) {
  const rows = [],
    same = [],
    onlyM = [],
    onlyA = [];
  for (const label of new Set([...Object.keys(m || {}), ...Object.keys(a || {})])) {
    let x = m[label],
      y = a[label];
    // the same element in both documents: prefer a pair whose text is the same
    if (x && y && x.text !== y.text) {
      const xs = [x, ...(x.items || [])],
        ys = [y, ...(y.items || [])];
      let hit = null;
      for (const xi of xs) {
        const yi = ys.find((v) => v.text === xi.text);
        if (yi) {
          hit = [xi, yi];
          break;
        }
      }
      if (hit) [x, y] = hit;
    }
    if (!x && !y) continue;
    if (!y) {
      onlyM.push(label + (x.text ? ` ("${x.text}")` : ''));
      continue;
    }
    if (!x) {
      onlyA.push(label + (y.text ? ` ("${y.text}")` : ''));
      continue;
    }
    const props = PROPS.concat(SIZE_MATTERS.test(label) ? ['h', 'w'] : []);
    let any = false;
    for (const p of props) {
      if (p === 'w' && /button|chip|tag/.test(label) && x.text !== y.text) continue; // a different word is a different width
      const vx = x[p],
        vy = y[p];
      const nx = num(vx),
        ny = num(vy);
      const differs = nx != null && ny != null ? Math.abs(nx - ny) > 0.5 : String(vx) !== String(vy);
      if (differs) {
        any = true;
        rows.push({ label, prop: p, mock: vx, app: vy, mtext: x.text, atext: y.text });
      }
    }
    if (!any) same.push(label);
  }
  return { rows, same, onlyM, onlyA };
}

function pairDiffs() {
  const out = [];
  for (const theme of ['teal-dark']) {
    for (const [app, mk] of data.pairs) {
      const a = data.settings[`${app}@${theme}`],
        m = data.mockup[`${mk}@${theme}`];
      if (!a || !m) continue;
      const d = diff(m.measure, a.measure);
      const p = diff(m.page, a.page);
      out.push({ theme, app, mk, d, p, aFile: a.file, mFile: m.file, caption: a.caption });
    }
  }
  return out;
}

// The page in each theme against the app's own Windows AIB Linking cards (the mockup has only teal-dark), and the Remove dialog
// against the delete-project dialog it borrows its look from (delete-project-ui.js).
const AGENT_LABELS = ['card', 'card title', 'agent row', 'agent head', 'agent letter', 'agent name', 'agent tag', 'chip ok (Ready)', 'chip warn', 'button link', 'button primary', 'switch label', 'switch input', 'command code', 'hint', 'footer', 'actions row'];
function windowsDiffs() {
  const out = [];
  for (const theme of ['teal-dark', 'teal-light']) {
    const w = data.settings[`win-agents@${theme}`] || data.settings['win-agents@teal-dark'];
    const a = data.settings[`good@${theme}`];
    if (!w || !a || w.theme !== theme) continue;
    const pick = (m) => Object.fromEntries(AGENT_LABELS.map((k) => [k, m[k]]).filter(([, v]) => v));
    out.push({ theme, d: diff(pick(w.measure), pick(a.measure)) });
  }
  return out;
}
const DLG_MAP = [['dialog', 'dp dialog'], ['dialog title', 'dp title'], ['dialog main', 'dp main'], ['dialog yes', 'dp yes'], ['dialog cancel', 'dp cancel'], ['dialog tick', 'dp tick row'], ['dialog warn', 'dp warn']];
function dialogDiffs() {
  const out = [];
  for (const theme of ['teal-dark', 'teal-light']) {
    const r = data.settings[`rm-tick@${theme}`],
      r2 = data.settings[`rm-second@${theme}`] || data.settings['rm-second@teal-dark'],
      d = data.other[`del-wsl-ticked@${theme}`];
    if (!r || !d) continue;
    const m = {},
      a = {};
    for (const [rk, dk] of DLG_MAP) {
      const v = (r.dialog && r.dialog[rk]) || (rk === 'dialog warn' && r2 && r2.theme === theme && r2.dialog[rk]) || null;
      if (v) a[rk] = v;
      if (d.measure[dk]) m[rk] = d.measure[dk];
    }
    out.push({ theme, d: diff(m, a) });
  }
  return out;
}

// ---- F: where each string comes from --------------------------------------------------------------------------------------------
const SRC_FILES = ['wsl-settings-ui.js', 'wsl-ui.js', 'settings-ui.js', 'new-project-ui.js', 'delete-project-ui.js', 'status-words.js', 'artifacts-ui.js', 'workspace-ui.js', 'chat.js', 'terminal-ui.js', 'composer-chips.js'];
const SRC = SRC_FILES.map((f) => ({ f, lines: fs.readFileSync(path.join(APP, f), 'utf8').split('\n') }));
const DYN = /(Ubuntu-24\.04[\w.-]*|Ubuntu-20\.04|Some-Other[\w-]*|Ubuntu|Debian|docker-desktop|Claude Code|Codex|OMP|Agent number \d+|a\.very\.long\S+|me@example\.com|\/home\/[\w./@~-]*|~\/[\w./-]*|data-[0-9a-f]{8}|\d[\d.,]*\s?(MB|GB|KB|%|min)?|https?:\/\/\S+|'|’)/g;
function whereFrom(s) {
  const frags = s
    .split(DYN)
    .filter((x) => x && x.length >= 7 && !DYN.test(x))
    .map((x) => x.trim())
    .filter((x) => x.length >= 7)
    .sort((a, b) => b.length - a.length);
  DYN.lastIndex = 0;
  for (const fr of frags.slice(0, 4)) {
    for (const { f, lines } of SRC) {
      const i = lines.findIndex((l) => l.includes(fr));
      if (i >= 0) return `${f}:${i + 1}`;
    }
  }
  return '';
}
function stringTable() {
  const seen = new Map();
  for (const s of data.strings) {
    if (/^(Copy|Copied|\d+|[A-Z]|×|✓|!|–|\.\.|\.)$/.test(s.s)) continue;
    if (s.where.startsWith('A win-agents') || s.where.startsWith('A about')) continue;
    const k = s.s;
    if (!seen.has(k)) seen.set(k, { s: s.s, kind: s.kind, where: [s.where], src: whereFrom(s.s) });
    else if (!seen.get(k).where.includes(s.where)) seen.get(k).where.push(s.where);
  }
  return [...seen.values()];
}

// ---- markdown ---------------------------------------------------------------------------------------------------------------------
function md(diffs, strings) {
  const L = [];
  L.push('# AIB WSL screens: measuring QA (looks)', '');
  L.push(`Run ${data.when}. Real page code (app/page/*.js + *.css) against fake routes of the contract shapes, headless Chrome, 1280 x 860 (the desktop window's default size, server/desktop/window.ts:29), device scale 1. Themes: teal-dark (AIB's default, THEMES.md) and teal-light. Reference: outputs/wsl-linking-mockup.html (embeds its own copy of theme.css/settings.css). Numbers are computed styles of the first visible matching element; colours as #rrggbb.`, '');
  L.push('## Findings (ranked)', '');
  for (const sev of ['broken', 'wrong vs reference', 'polish']) {
    const list = F.findings.filter((x) => x.sev === sev);
    L.push(`### ${sev} (${list.length})`, '');
    list.forEach((x, i) => L.push(`${i + 1}. **${x.title}** (${x.where}) ${x.detail}`));
    L.push('');
  }
  L.push('## A. Settings > AIB Linking (WSL) vs the mockup', '');
  for (const p of diffs) {
    L.push(`### ${p.app} vs mockup "${p.mk}" (${p.theme})`, '');
    L.push(`Matched exactly (${p.d.same.length}): ${p.d.same.join(', ') || 'none'}.`, '');
    if (p.d.onlyM.length) L.push(`Only in the mockup: ${p.d.onlyM.join('; ')}.`, '');
    if (p.d.onlyA.length) L.push(`Only in the page: ${p.d.onlyA.join('; ')}.`, '');
    const rows = p.d.rows.concat(p.p.rows.map((r) => Object.assign({}, r, { label: 'page: ' + r.label })));
    if (rows.length) {
      L.push('| element | property | mockup | page |', '| --- | --- | --- | --- |');
      for (const r of rows) L.push(`| ${mdc(r.label)} | ${r.prop} | ${mdc(r.mock)} | ${mdc(r.app)} |`);
      L.push('');
    }
  }
  L.push('The mockup embeds only the teal-dark theme (its copy of theme.css has no teal-light block), so teal-light is compared with the app\'s own Windows AIB Linking cards below.', '');
  for (const w of windowsDiffs()) {
    L.push(`### Agents card vs Windows AIB Linking (${w.theme})`, '', `Identical: ${w.d.same.join(', ')}.`, '');
    if (w.d.rows.length) {
      L.push('| element | property | Windows | WSL page |', '| --- | --- | --- | --- |');
      for (const r of w.d.rows) L.push(`| ${mdc(r.label)} | ${r.prop} | ${mdc(r.mock)} (${mdc(r.mtext)}) | ${mdc(r.app)} (${mdc(r.atext)}) |`);
      L.push('');
    }
  }
  for (const w of dialogDiffs()) {
    L.push(`### Remove dialog vs the delete-project dialog (${w.theme})`, '', `Identical: ${w.d.same.join(', ')}.`, '');
    if (w.d.rows.length) {
      L.push('| element | property | delete-project | Remove AIB |', '| --- | --- | --- | --- |');
      for (const r of w.d.rows) L.push(`| ${mdc(r.label)} | ${r.prop} | ${mdc(r.mock)} | ${mdc(r.app)} |`);
      L.push('');
    }
  }
  L.push('### States the mockup does not cover: key measurements (teal-dark)', '');
  L.push('| state | element | font | colour | bg | padding | radius | h x w |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(data.settings)) {
    if (!k.endsWith('@teal-dark') || data.pairs.some(([a]) => a === v.scen)) continue;
    for (const [label, s] of Object.entries(Object.assign({}, v.dialog || {}))) {
      if (!s) continue;
      L.push(`| ${v.scen} | ${label} | ${s.fontSize} ${s.fontWeight} ${mdc(s.fontFamily.split(',')[0])} lh ${s.lineHeight} | ${s.color} | ${s.backgroundColor} | ${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft} | ${s.borderTopLeftRadius} | ${s.h} x ${s.w} |`);
    }
  }
  L.push('');
  L.push('## B. Other screens: key measurements (teal-dark)', '');
  L.push('| screen | element | font | colour | bg | border | padding | radius | h x w |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(data.other)) {
    if (!k.endsWith('@teal-dark')) continue;
    for (const [label, s] of Object.entries(v.measure)) {
      if (!s) continue;
      L.push(`| ${v.scen} | ${label} | ${s.fontSize} ${s.fontWeight} ${mdc(s.fontFamily.split(',')[0])} lh ${s.lineHeight} | ${s.color} | ${s.backgroundColor} | ${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor} | ${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft} | ${s.borderTopLeftRadius} | ${s.h} x ${s.w} |`);
    }
  }
  L.push('');
  L.push('## C. Contrast (WCAG 2 ratio; target 4.5 text, 3 large text)', '');
  L.push('| theme | state | element | text | fg | bg | ratio | target | pass |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const seenC = new Set();
  const cs = data.contrast.slice().sort((a, b) => a.pass - b.pass || a.ratio - b.ratio);
  for (const c of cs) {
    const k = c.theme + c.label + c.fg + c.bg;
    if (seenC.has(k)) continue;
    seenC.add(k);
    L.push(`| ${c.theme} | ${c.where} | ${mdc(c.label)} | ${mdc(c.text)} | ${c.fg} | ${c.bg} | ${c.ratio} | ${c.target} | ${c.pass ? 'yes' : '**NO**'} |`);
  }
  L.push('');
  L.push('## D. Widths: overflow, clipping, sideways scroll', '');
  for (const [k, v] of Object.entries(data.widths)) {
    L.push(`### ${v.scen} at ${v.width} px`, '');
    const g = v.geo || {};
    L.push(`Content box ${g.content ? Math.round(g.content.width) + ' px wide' : '-'}; nav ${g.nav ? Math.round(g.nav.width) + ' x ' + Math.round(g.nav.height) : '-'}; drop-down ${g.pick ? Math.round(g.pick.width) + ' px' : '-'}${g.dialog ? '; dialog ' + Math.round(g.dialog.width) + ' x ' + Math.round(g.dialog.height) : ''}.`, '');
    if (!v.overflow.length) L.push('No overflow found.', '');
    else {
      L.push('| kind | element | text | by px |', '| --- | --- | --- | --- |');
      for (const o of v.overflow.slice(0, 30)) L.push(`| ${o.kind} | ${mdc(o.el)} | ${mdc(o.text)} | ${o.by} |`);
      L.push('');
    }
  }
  L.push('## E. Keyboard and a11y', '');
  for (const [scen, f] of Object.entries(data.focus)) {
    if (!f.walk) continue;
    L.push(`### Tab walk, ${scen}`, '');
    L.push('| # | element | text | role / type | focus mark |', '| --- | --- | --- | --- | --- |');
    f.walk.forEach((w, i) => L.push(`| ${i} | ${w.tag}${w.cls ? '.' + mdc(w.cls) : ''} | ${mdc(w.text)} | ${w.role || ''} ${w.type || ''}${w.checked != null ? ' checked=' + w.checked : ''} | ${w.ring ? mdc(w.outline + (w.boxShadow !== 'none' ? ' / ' + w.boxShadow : '')) : '**none**'} |`));
    L.push('', '```json', JSON.stringify(f.attrs, null, 1), '```', '');
  }
  const rd = data.focus.removeDialog;
  if (rd) {
    L.push('### Remove dialog', '');
    L.push('```json', JSON.stringify(rd, null, 1), '```', '');
  }
  if (data.focus.deleteDialog) L.push('### Delete-project dialog (reference)', '', '```json', JSON.stringify(data.focus.deleteDialog, null, 1), '```', '');
  L.push('## F. Copy: every user-visible string seen in the rendered states', '');
  L.push('Source = first file:line holding the string\'s longest fixed part (dynamic parts such as distro names, sizes and paths removed). Flags from the copy review are in the findings above.', '');
  L.push('| string | kind | source | seen in |', '| --- | --- | --- | --- |');
  for (const s of strings) L.push(`| ${mdc(s.s)} | ${s.kind} | ${s.src || '(dynamic / fixture)'} | ${mdc(s.where.slice(0, 4).join(', '))}${s.where.length > 4 ? ' +' + (s.where.length - 4) : ''} |`);
  L.push('', '## Could not render or measure', '');
  for (const x of F.notRendered) L.push(`- ${x}`);
  L.push('', '## Errors seen while rendering', '', '```json', JSON.stringify(data.errors, null, 1), '```', '');
  L.push('Native dialogs answered during the run:', '', '```json', JSON.stringify(data.dialogs, null, 1), '```');
  return L.join('\n');
}

// ---- html -------------------------------------------------------------------------------------------------------------------------
async function encodeAll(files) {
  const b = await launch(SCRATCH);
  const out = {};
  try {
    await b.goto('data:text/html,<script>window.__qaDone=1</script>');
    for (const f of files) {
      const abs = path.join(OUT, f);
      if (!fs.existsSync(abs)) continue;
      const b64 = fs.readFileSync(abs).toString('base64');
      out[f] = await b.evaluate(
        `new Promise((res) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; c.getContext('2d').drawImage(i, 0, 0); res(c.toDataURL('image/webp', 0.82)); }; i.onerror = () => res(''); i.src = 'data:image/png;base64,${b64}'; })`,
      );
    }
  } finally {
    await b.close();
  }
  return out;
}

function html(diffs, strings, img) {
  const H = [];
  const pic = (f, cap) => (img[f] ? `<figure><img loading="lazy" src="${img[f]}" alt="${esc(cap)}"><figcaption>${esc(cap)}<br><code>${esc(f)}</code></figcaption></figure>` : `<p class="miss">missing ${esc(f)}</p>`);
  H.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AIB WSL screens: measuring QA</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#1c1e22}
header.top{background:#16151b;color:#e8e8ea;padding:20px 28px}header.top h1{margin:0 0 6px;font-size:22px}header.top p{margin:0;color:#b9bac0;max-width:1100px}
nav.toc{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:8px 28px;z-index:2}nav.toc a{margin-right:14px;color:#0b6e63;text-decoration:none;font-weight:600}
main{padding:10px 28px 60px;max-width:1500px}h2{margin:34px 0 8px;font-size:19px;border-bottom:2px solid #2bb3a3;padding-bottom:4px}h3{margin:22px 0 6px;font-size:15px}
figure{margin:10px 0 18px;background:#fff;border:1px solid #ddd;border-radius:6px;padding:8px;display:inline-block;vertical-align:top;max-width:100%}figure img{max-width:100%;display:block;border:1px solid #eee}
figcaption{font-size:12px;color:#555;margin-top:6px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.pair figure{display:block}
table{border-collapse:collapse;margin:8px 0 16px;font-size:12px;background:#fff}th,td{border:1px solid #d6d8dc;padding:3px 6px;text-align:left;vertical-align:top}th{background:#eef0f2}
td code,li code{font-size:11px}.sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:700;margin-right:6px}.s-broken{background:#fde2e1;color:#8d1c17}.s-wrong{background:#fff1d6;color:#7a4b00}.s-polish{background:#e4eefc;color:#1d4c8f}
ol.find li{margin:0 0 8px}.no{color:#b3261e;font-weight:700}.yes{color:#1b6e3a}details{margin:6px 0 12px}summary{cursor:pointer;font-weight:600}.miss{color:#b3261e}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:10px}.grid figure{display:block}
</style></head><body>`);
  H.push(`<header class="top"><h1>AIB WSL screens: measuring QA (looks)</h1><p>${esc(F.summary)}</p></header>`);
  H.push('<nav class="toc"><a href="#find">Findings</a><a href="#a">A Settings</a><a href="#b">B Other screens</a><a href="#c">C Themes + contrast</a><a href="#d">D Widths</a><a href="#e">E Keyboard / a11y</a><a href="#f">F Copy</a><a href="#nr">Not rendered</a></nav><main>');
  H.push(`<p>Run ${esc(data.when)}. Real page code against fake routes of the contract shapes (docs/wsl/linking-design.md sections 12-13), headless Chrome, 1280 x 860, scale 1. Themes: <b>teal-dark</b> (AIB's default and the mockup's) and <b>teal-light</b>. Full numbers: <code>outputs/qa-wsl/measurements.md</code>. Harness: <code>work/qa_wsl/</code>.</p>`);
  // findings
  H.push('<h2 id="find">Findings, ranked</h2>');
  for (const [sev, cls] of [['broken', 's-broken'], ['wrong vs reference', 's-wrong'], ['polish', 's-polish']]) {
    const list = F.findings.filter((x) => x.sev === sev);
    H.push(`<h3><span class="sev ${cls}">${esc(sev)}</span>${list.length}</h3><ol class="find">`);
    for (const x of list) H.push(`<li><b>${esc(x.title)}</b> <code>${esc(x.where)}</code><br>${esc(x.detail)}</li>`);
    H.push('</ol>');
  }
  H.push(`<h3>Matched the reference exactly</h3><ul>${F.matched.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
  // A
  H.push('<h2 id="a">A. Settings &gt; AIB Linking (WSL)</h2><p>Left: the mockup state; right: the page in the same state. Below each pair: every property that differs (mockup value / page value).</p>');
  for (const p of diffs.filter((x) => x.theme === 'teal-dark')) {
    H.push(`<h3>${esc(p.app)} vs mockup "${esc(p.mk)}"</h3><div class="pair">${pic(p.mFile, 'Mockup: ' + p.mk)}${pic(p.aFile, 'Page: ' + p.caption)}</div>`);
    const rows = p.d.rows.concat(p.p.rows.map((r) => Object.assign({}, r, { label: 'page: ' + r.label })));
    H.push(`<details${rows.length ? ' open' : ''}><summary>${rows.length} differences · ${p.d.same.length} elements identical · only in mockup: ${p.d.onlyM.length} · only in page: ${p.d.onlyA.length}</summary>`);
    if (rows.length) H.push('<table><tr><th>element</th><th>property</th><th>mockup</th><th>page</th></tr>' + rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.prop)}</td><td>${esc(r.mock)}</td><td>${esc(r.app)}</td></tr>`).join('') + '</table>');
    H.push(`<p><b>Identical:</b> ${esc(p.d.same.join(', '))}</p><p><b>Only in the mockup:</b> ${esc(p.d.onlyM.join('; ') || '-')}</p><p><b>Only in the page:</b> ${esc(p.d.onlyA.join('; ') || '-')}</p></details>`);
  }
  const tbl = (rows, a, b) => (rows.length ? `<table><tr><th>element</th><th>property</th><th>${a}</th><th>${b}</th></tr>` + rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.prop)}</td><td>${esc(r.mock)}</td><td>${esc(r.app)}</td></tr>`).join('') + '</table>' : '<p>No differences.</p>');
  H.push('<h3>Teal-light and the app\'s own references</h3><p>The mockup embeds only teal-dark, so the light theme is compared with the Windows AIB Linking cards, and the Remove dialog with the delete-project dialog whose look it borrows.</p>');
  for (const w of windowsDiffs()) H.push(`<details open><summary>Agents card vs Windows AIB Linking (${w.theme}): ${w.d.rows.length} differences, identical: ${esc(w.d.same.join(', '))}</summary>${tbl(w.d.rows, 'Windows', 'WSL page')}</details>`);
  for (const w of dialogDiffs()) H.push(`<details open><summary>Remove dialog vs delete-project dialog (${w.theme}): ${w.d.rows.length} differences, identical: ${esc(w.d.same.join(', '))}</summary>${tbl(w.d.rows, 'delete-project', 'Remove AIB')}</details>`);
  H.push('<h3>States the mockup does not cover (teal-dark)</h3><div class="grid">');
  for (const v of Object.values(data.settings)) {
    if (v.theme !== 'teal-dark' || data.pairs.some(([a]) => a === v.scen)) continue;
    H.push(pic(v.file, v.caption + (v.confirm ? ' · confirm text: "' + v.confirm + '"' : '')));
    for (const e of v.extra || []) H.push(pic(e, v.caption + ' (dialog unrolled: it scrolls inside at 70vh)'));
  }
  H.push('</div>');
  // B
  H.push('<h2 id="b">B. Other changed screens</h2><div class="grid">');
  for (const v of Object.values(data.other)) if (v.theme === 'teal-dark') H.push(pic(v.file, v.caption));
  H.push('</div>');
  // C
  H.push('<h2 id="c">C. Themes and contrast</h2><p>teal-light captures of the same states (the dark ones are in A and B).</p><div class="grid">');
  for (const v of Object.values(data.settings)) if (v.theme === 'teal-light') H.push(pic(v.file, v.caption + ' · teal-light'));
  for (const v of Object.values(data.mockup)) if (v.theme === 'teal-light') H.push(pic(v.file, 'Mockup ' + v.mk + ' · teal-light'));
  for (const v of Object.values(data.other)) if (v.theme === 'teal-light') H.push(pic(v.file, v.caption + ' · teal-light'));
  H.push('</div>');
  const seenC = new Set();
  const cs = data.contrast.slice().sort((a, b) => a.pass - b.pass || a.ratio - b.ratio).filter((c) => {
    const k = c.theme + c.label + c.fg + c.bg;
    if (seenC.has(k)) return false;
    seenC.add(k);
    return true;
  });
  H.push('<table><tr><th>theme</th><th>state</th><th>element</th><th>text</th><th>fg</th><th>bg</th><th>ratio</th><th>target</th><th>pass</th></tr>' + cs.map((c) => `<tr><td>${c.theme}</td><td>${esc(c.where)}</td><td>${esc(c.label)}</td><td>${esc(c.text)}</td><td><span style="display:inline-block;width:10px;height:10px;background:${c.fg};border:1px solid #999"></span> ${c.fg}</td><td><span style="display:inline-block;width:10px;height:10px;background:${c.bg};border:1px solid #999"></span> ${c.bg}</td><td>${c.ratio}</td><td>${c.target}</td><td class="${c.pass ? 'yes' : 'no'}">${c.pass ? 'yes' : 'NO'}</td></tr>`).join('') + '</table>');
  // D
  H.push('<h2 id="d">D. Widths (700 / 900 / 1280 / 1400 px)</h2>');
  for (const v of Object.values(data.widths)) {
    H.push(`<h3>${esc(v.scen)} at ${v.width} px</h3>`);
    H.push(pic(v.file, `${v.scen} at ${v.width} px`));
    for (const e of v.extra || []) H.push(pic(e, `${v.scen} at ${v.width} px (dialog unrolled)`));
    if (v.overflow.length) H.push('<table><tr><th>kind</th><th>element</th><th>text</th><th>by px</th></tr>' + v.overflow.slice(0, 20).map((o) => `<tr><td>${esc(o.kind)}</td><td>${esc(o.el)}</td><td>${esc(o.text)}</td><td>${o.by}</td></tr>`).join('') + '</table>');
    else H.push('<p>No overflow found.</p>');
  }
  // E
  H.push('<h2 id="e">E. Keyboard and a11y</h2>');
  H.push('<div class="grid">' + (data.focus.rings || []).map((r) => pic(r.file, `Keyboard focus on the ${r.label}: ${r.info.ring ? r.info.outline : 'no focus mark'}`)).join('') + '</div>');
  for (const [scen, f] of Object.entries(data.focus)) {
    if (!f.walk) continue;
    H.push(`<details><summary>Tab walk: ${esc(scen)} (${f.walk.length} stops)</summary><table><tr><th>#</th><th>element</th><th>text</th><th>role / type</th><th>focus mark</th></tr>` + f.walk.map((w, i) => `<tr><td>${i}</td><td>${esc(w.tag)}${w.cls ? '.' + esc(w.cls) : ''}</td><td>${esc(w.text)}</td><td>${esc((w.role || '') + ' ' + (w.type || '') + (w.checked != null ? ' checked=' + w.checked : ''))}</td><td class="${w.ring ? '' : 'no'}">${w.ring ? esc(w.outline) : 'none'}</td></tr>`).join('') + `</table><pre>${esc(JSON.stringify(f.attrs, null, 1))}</pre></details>`);
  }
  H.push(`<details open><summary>Remove dialog: focus and roles</summary><pre>${esc(JSON.stringify(data.focus.removeDialog, null, 1))}</pre></details>`);
  // F
  H.push('<h2 id="f">F. Copy</h2>');
  H.push(`<ol class="find">${F.copy.map((x) => `<li><b>${esc(x.title)}</b> <code>${esc(x.where)}</code><br>${esc(x.detail)}</li>`).join('')}</ol>`);
  H.push(`<details><summary>Every user-visible string seen (${strings.length}), with its source line</summary><table><tr><th>string</th><th>kind</th><th>source</th><th>seen in</th></tr>` + strings.map((s) => `<tr><td>${esc(s.s)}</td><td>${s.kind}</td><td>${esc(s.src || '(dynamic / fixture)')}</td><td>${esc(s.where.slice(0, 3).join(', '))}${s.where.length > 3 ? ' +' + (s.where.length - 3) : ''}</td></tr>`).join('') + '</table></details>');
  H.push(`<h2 id="nr">Could not render or measure</h2><ul>${F.notRendered.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
  H.push('</main></body></html>');
  return H.join('\n');
}

(async () => {
  const diffs = pairDiffs();
  const strings = stringTable();
  fs.writeFileSync(path.join(OUT, 'measurements.md'), md(diffs, strings));
  const files = new Set();
  for (const v of Object.values(data.settings)) [v.file, ...(v.extra || [])].forEach((f) => files.add(f));
  for (const v of Object.values(data.mockup)) files.add(v.file);
  for (const v of Object.values(data.other)) files.add(v.file);
  for (const v of Object.values(data.widths)) [v.file, ...(v.extra || [])].forEach((f) => files.add(f));
  for (const r of data.focus.rings || []) files.add(r.file);
  const img = await encodeAll([...files]);
  fs.writeFileSync(path.join(OUT, 'index.html'), html(diffs, strings, img));
  console.log('images', Object.keys(img).length, 'html bytes', fs.statSync(path.join(OUT, 'index.html')).size);
})();
