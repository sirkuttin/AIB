'use strict';
/* Colour tokens must not change a single painted colour (ported from test_theme_tokens.py).

   Step 1 of the themes work replaced the hard-coded colours in the page stylesheets with var(--token) names defined once in
   theme.css. This test compares every stylesheet as it was at BASE_COMMIT (the commit just before that change) with the
   THEME_COMMIT version: same rules in the same order, same selectors, same properties, and every value equal once each var(--x)
   is resolved from the :root definitions and every colour is normalised (#abc -> #aabbcc, lower case, rgba spacing).

   Pinned to those commits on purpose, so later CSS changes never break it. Skipped, not failed, when the history is too
   shallow to contain them. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { servedAsset } = require('./_served_assets');

const REPO = path.join(__dirname, '..');
const BASE_COMMIT = '09181dc1cde0f6625f05706bd6f76bf831255775';
const THEME_COMMIT = 'b61cc849972ef51653657d561c0f2ecaacd679b6'; // the themes step 1 commit
const THEME = 'theme.css';
// Every stylesheet that existed at BASE_COMMIT and is compared. The first 15 are the ones chat.html loads.
const PAGE_CSS = ['chat', 'activity', 'workspace', 'clamp', 'stream', 'header', 'inbox-reply', 'commands', 'queue', 'textsize', 'settings',
  'changes', 'artifacts', 'plan', 'split'];
const MONITOR_CSS = ['style', 'sidebar']; // the old monitor dashboard pages: not themed in step 1, must stay byte-equivalent

// ---------------------------------------------------------------- parsing

const COMMENT = /\/\*[\s\S]*?\*\//g;
const HEX = /#([0-9a-fA-F]{3,8})\b/g;
const RGB = /(rgba?|hsla?)\(([^()]*)\)/gi;
const VAR = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?))?\s*\)/g;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/** [[context, prelude, [[property, value], ...]]] in file order; at-rule bodies are walked with the at-rule as context. */
function parse(css) {
  const text = css.replace(COMMENT, '');
  const rules = [];
  const walk = (block, context) => {
    let i = 0;
    while (i < block.length) {
      const brace = block.indexOf('{', i);
      const semi = block.indexOf(';', i);
      if (semi !== -1 && (brace === -1 || semi < brace)) { // an at-rule with no body, e.g. @import
        i = semi + 1;
        continue;
      }
      if (brace === -1) break;
      const prelude = collapse(block.slice(i, brace));
      let depth = 1, end = brace + 1;
      while (end < block.length && depth) {
        if (block[end] === '{') depth++;
        else if (block[end] === '}') depth--;
        end++;
      }
      const body = block.slice(brace + 1, end - 1);
      if (prelude.startsWith('@')) walk(body, [...context, prelude.replace(/\s+/g, '')]);
      else {
        const decls = [];
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon !== -1) decls.push([collapse(part.slice(0, colon)).toLowerCase(), collapse(part.slice(colon + 1))]);
        }
        rules.push([context.join('\u0000'), prelude.replace(/\s*,\s*/g, ','), decls]);
      }
      i = end;
    }
  };
  walk(text, []);
  return rules;
}

/** Custom properties declared on a plain :root rule, as {name: raw value}. */
function rootVars(rules) {
  const found = {};
  for (const [context, prelude, decls] of rules) {
    if (prelude === ':root' && !context) for (const [name, value] of decls) if (name.startsWith('--')) found[name] = value;
  }
  return found;
}

/** Replace var(--x) with its :root value, repeatedly; a var with no :root value (and no fallback) stays and is noted. */
function resolve(value, variables, unresolved) {
  for (let n = 0; n < 20; n++) {
    const next = value.replace(VAR, (whole, name, fallback) => {
      if (Object.hasOwn(variables, name)) return variables[name];
      if (fallback !== undefined) return fallback;
      unresolved.add(name);
      return whole.replace('var(', 'unresolved-var(');
    });
    if (next === value) break;
    value = next;
  }
  return value.replaceAll('unresolved-var(', 'var(');
}

function normalise(value) {
  value = value.replace(HEX, (_, digits) => {
    digits = digits.toLowerCase();
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((c) => c + c).join('');
    return '#' + digits;
  });
  value = value.replace(RGB, (_, fn, args) => `${fn.toLowerCase()}(${args.replace(/\s+/g, '')})`);
  value = collapse(value).replace(/\s*,\s*/g, ',');
  return value.replace(/\s*!\s*important$/i, ' !important');
}

const withoutRootProps = (rules) =>
  rules
    .map(([c, p, ds]) => [c, p, ds.filter((d) => !(p === ':root' && d[0].startsWith('--')))])
    .filter((r) => r[2].length || r[1] !== ':root');

/** Human-readable differences between two {file: css text} sets; empty means equivalent. */
function compare(beforeByFile, afterByFile) {
  const problems = [];
  const before = Object.fromEntries(Object.entries(beforeByFile).map(([f, t]) => [f, parse(t)]));
  const after = Object.fromEntries(Object.entries(afterByFile).map(([f, t]) => [f, parse(t)]));
  const beforeVars = Object.assign({}, ...Object.values(before).map(rootVars));
  const afterVars = Object.assign({}, ...Object.values(after).map(rootVars));
  const beforeMissing = new Set(), afterMissing = new Set();

  // 1. every :root custom property of the old stylesheets still exists with the same resolved value
  for (const name of Object.keys(beforeVars).sort()) {
    if (!Object.hasOwn(afterVars, name)) {
      problems.push(`custom property ${name} is no longer defined`);
      continue;
    }
    const old = normalise(resolve(beforeVars[name], beforeVars, beforeMissing));
    const now = normalise(resolve(afterVars[name], afterVars, afterMissing));
    if (old !== now) problems.push(`custom property ${name} changed: ${old} -> ${now}`);
  }

  // 2. every rule, in order, with :root custom-property declarations left to step 1
  for (const fname of Object.keys(before).sort()) {
    if (!after[fname]) {
      problems.push(`${fname} is missing after the change`);
      continue;
    }
    const oldView = withoutRootProps(before[fname]), newView = withoutRootProps(after[fname]);
    if (oldView.length !== newView.length) problems.push(`${fname}: ${oldView.length} rules before, ${newView.length} after`);
    for (let n = 0; n < Math.min(oldView.length, newView.length); n++) {
      const [oc, op, ods] = oldView[n], [nc, np, nds] = newView[n];
      const where = `${fname} rule ${n + 1} (${op})`;
      if (oc !== nc || op !== np) {
        problems.push(`${where}: selector or at-rule changed to ${np} in ${nc}`);
        continue;
      }
      if (ods.map((d) => d[0]).join('|') !== nds.map((d) => d[0]).join('|')) {
        problems.push(`${where}: properties differ`);
        continue;
      }
      ods.forEach(([prop, oval], k) => {
        const a = normalise(resolve(oval, beforeVars, beforeMissing));
        const b = normalise(resolve(nds[k][1], afterVars, afterMissing));
        if (a !== b) problems.push(`${where}: ${prop} was ${a}, is now ${b}`);
      });
    }
  }

  // 3. no new undefined variable
  for (const name of [...afterMissing].filter((x) => !beforeMissing.has(x)).sort()) problems.push(`var(${name}) is used but never defined`);
  return problems;
}

// ---------------------------------------------------------------- inputs

const git = (args) => execFileSync('git', ['-C', REPO, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const gitShow = (file, commit = BASE_COMMIT) => git(['show', `${commit}:outputs/agent-studio/${file}`]).toString('utf8');

function baseAvailable() {
  try {
    for (const c of [BASE_COMMIT, THEME_COMMIT]) git(['cat-file', '-e', c + '^{commit}']);
    return true;
  } catch {
    return false;
  }
}

const readAfter = (name) => fs.readFileSync(path.join(APP, name + '.css'), 'utf8');

test('theme tokens keep every colour', { skip: baseAvailable() ? false : 'history does not contain BASE_COMMIT (shallow checkout)' }, async (t) => {
  const names = [...PAGE_CSS, ...MONITOR_CSS];
  const before = Object.fromEntries(names.map((n) => [n, gitShow(n + '.css')]));
  const after = Object.fromEntries(names.map((n) => [n, gitShow(n + '.css', THEME_COMMIT)]));
  const theme = gitShow('theme.css', THEME_COMMIT);

  await t.test('every page stylesheet resolves to the same values as before', () => {
    // The monitor sheets define their own --line/--muted/--accent, so each page's sheets are compared on their own.
    const b = Object.fromEntries(PAGE_CSS.map((n) => [n, before[n]]));
    const a = Object.fromEntries(PAGE_CSS.map((n) => [n, after[n]]));
    a.theme = theme;
    const problems = compare(b, a);
    assert.deepEqual(problems, [], problems.slice(0, 40).join('\n'));
  });

  await t.test('monitor stylesheets are untouched', () => {
    for (const name of MONITOR_CSS) assert.equal(before[name].replaceAll('\r\n', '\n'), after[name].replaceAll('\r\n', '\n'), name);
  });

  await t.test('the chat page loads theme.css first and the server serves it', () => {
    const html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/([a-z0-9-]+\.css)">/g)].map((m) => m[1]);
    assert.equal(sheets[0], THEME);
    // Sheets added after the themes work (views.css) are allowed; they have no before/after to compare, so they must only exist.
    const later = sheets.slice(1).filter((n) => !PAGE_CSS.includes(n.slice(0, -4)));
    assert.deepEqual(sheets.slice(1).filter((n) => !later.includes(n)).sort(), PAGE_CSS.map((n) => n + '.css').sort());
    for (const n of later) assert.ok(fs.statSync(path.join(APP, n)).isFile(), n);
    assert.equal(servedAsset('/theme.css'), 'theme.css');
  });
});

// Today's theme.css and stylesheets: runs on every checkout (the comparison above needs the old commits).
test('theme.css today', async (t) => {
  await t.test('theme.css defines literal colours only and is the only place for them', () => {
    const rules = parse(readAfter('theme'));
    assert.deepEqual([...new Set(rules.map(([c, p]) => `${c}|${p}`))], ['|:root'], 'theme.css must hold one plain :root rule');
    const variables = rootVars(rules);
    assert.ok(Object.keys(variables).length >= 30);
    for (const [name, value] of Object.entries(variables)) assert.match(value, /^#[0-9a-fA-F]{3,8}$/, `${name} must be one literal colour, got ${value}`);
  });

  await t.test('tokens are in use and defined', () => {
    // Checked against today's page stylesheets: later work adds tokens (the Bay teal styling's --link, --status-*).
    // KEPT are no longer painted on this page but stay defined so code on other branches that names them still resolves.
    const KEPT = ['--info', '--warn-bg'];
    const defined = rootVars(parse(readAfter('theme')));
    const sheets = fs
      .readdirSync(APP)
      .filter((n) => n.endsWith('.css') && n !== 'theme.css' && !MONITOR_CSS.includes(n.slice(0, -4)))
      .map((n) => fs.readFileSync(path.join(APP, n), 'utf8').replace(COMMENT, ''));
    const used = new Set(), ownNames = new Set();
    for (const text of sheets) {
      for (const m of text.matchAll(VAR)) used.add(m[1]);
      for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) ownNames.add(m[1]); // --hd-*, --need, --sel ... defined by a sheet itself
    }
    assert.deepEqual(Object.keys(defined).filter((n) => !used.has(n) && !KEPT.includes(n)).sort(), [], 'tokens defined in theme.css but used nowhere');
    for (const n of KEPT) assert.ok(Object.hasOwn(defined, n), `${n} stays defined`);
    // Sizes and fonts set from script (--side-w, --ui-scale ...) are not colours; every colour-family name must resolve.
    const COLOUR = /^--(text|muted|bg|panel|code|hover|line|accent|on-accent|link|danger|ok|warn|info|status|plan|shadow)/;
    const undefinedNames = [...used].filter((n) => COLOUR.test(n) && !Object.hasOwn(defined, n) && !ownNames.has(n));
    assert.deepEqual(undefinedNames.sort(), [], 'var() names defined nowhere');
  });

});

test('the equivalence check is strict: it fails when a colour, selector or property changes', async (t) => {
  const THEME_CSS = ':root { --a: #abc; --b: #0009; --c: #112233; }';
  const BEFORE = 'a { color: #AABBCC; border: 1px solid rgba(1, 2, 3, 0.5); } @media (hover: none) { b { color: #0009; } }';
  const AFTER = 'a { color: var(--a); border: 1px solid rgba(1,2,3,0.5); } @media (hover:none) { b { color: var(--b); } }';
  const run = (after, theme) => compare({ x: BEFORE }, { x: after, theme: theme ?? THEME_CSS });

  await t.test('equivalent spellings pass', () => assert.deepEqual(run(AFTER), []));
  await t.test('a changed token value fails', () => assert.ok(run(AFTER, ':root { --a: #abd; --b: #0009; }').length));
  await t.test('a changed alpha fails', () => assert.ok(run(AFTER, ':root { --a: #abc; --b: #000a; }').length));
  await t.test('a wrong token fails', () => assert.ok(run(AFTER.replace('var(--a)', 'var(--c)')).length));
  await t.test('a changed selector fails', () => assert.ok(run(AFTER.replace('a {', 'a.x {')).length));
  await t.test('a changed property fails', () => assert.ok(run(AFTER.replace('color: var(--a)', 'background: var(--a)')).length));
  await t.test('an extra or missing rule fails', () => {
    assert.ok(run(AFTER + ' c { color: red; }').length);
    assert.ok(run('a { color: var(--a); }').length);
  });
  await t.test('a changed at-rule fails', () => assert.ok(run(AFTER.replace('(hover:none)', '(hover:hover)')).length));
  await t.test('an undefined variable fails', () => assert.ok(run(AFTER.replace('var(--b)', 'var(--nope)')).length));
  await t.test('a changed :root custom property fails', () => {
    const before = { x: ':root { --line: #2d2e39; } a { border: 1px solid var(--line); }' };
    const after = { x: 'a { border: 1px solid var(--line); }', theme: ':root { --line: #2d2e3a; }' };
    assert.ok(compare(before, after).length);
    after.theme = ':root { --line: #2d2e39; }';
    assert.deepEqual(compare(before, after), []);
  });
});
