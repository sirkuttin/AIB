'use strict';
// Fixes after the QA of the phone remote: Settings > Devices redraws when its box is attached again, the copy, the Tailscale
// admin link, the phone page's helper dots / Live chip / helpers box / inline link rules. (Real layout is measured in
// work/deno/remote_artifacts_test.ts in a headless browser.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page, load, APP } = require('./fake_dom.js');
const { cssRules } = require('./css_rules.js');
const P = require(path.join(APP, 'phone.js'));

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const VIEW = {
  on: true,
  listening: true,
  port: 8779,
  serveCommand: 'tailscale serve --bg --https=443 http://127.0.0.1:8779',
  tailscale: { installed: true, signedIn: true, machine: 'pc', tailnet: 't.ts.net', name: 'pc.t.ts.net', https: false, serving: false },
  setup: { os: 'windows', installMode: 'winget', changes: [], links: { adminMachines: 'https://login.tailscale.com/admin/machines' } },
  phones: [],
  pairing: null,
  activity: [],
};

async function devices() {
  const shell = page();
  shell.window.setInterval = () => 1;
  shell.window.clearInterval = () => {};
  const ctx = load(shell, ['devices-ui.js']);
  const UI = ctx.AIBDevicesUI;
  const host = { get: async () => VIEW, post: async () => VIEW };
  const make = () => {
    const box = shell.make('div', '', shell.body);
    let attached = true;
    Object.defineProperty(box, 'isConnected', { get: () => attached });
    return { box, set: (v) => (attached = v) };
  };
  return { UI, host, make, shell };
}

test('Settings > Remote control draws again when the box is attached again (another section, then back)', async () => {
  const { UI, host, make } = await devices();
  const first = make();
  UI.render('access', first.box, host);
  await flush();
  assert.ok(first.box.textContent.includes('Tailscale on this PC'), 'drawn the first time');
  // leave the section, come back: a new box that is not attached yet when render() runs; the data has not changed
  first.set(false);
  const second = make();
  second.set(false);
  UI.render('access', second.box, host);
  await flush();
  assert.equal(second.box.textContent.includes('Tailscale on this PC'), false, 'nothing is drawn into a detached box');
  second.set(true);
  await UI.refresh(); // what the 2 s poll runs: the data is the same, the box was never drawn
  assert.ok(second.box.textContent.includes('Tailscale on this PC'), 'drawn once attached');
}
);

test('Remote control copy: the switch is not the card heading; the HTTPS step has Turn on HTTPS and the rename link', async () => {
  const { UI, host, make } = await devices();
  const m = make();
  UI.render('access', m.box, host);
  await flush();
  const spans = m.box.querySelectorAll('span').map((n) => n.textContent);
  assert.ok(spans.includes('Let paired phones reach AIB'), spans.join('|'));
  assert.ok(!spans.includes('Phone access'));
  const buttons = m.box.querySelectorAll('button').map((b) => b.textContent);
  assert.ok(buttons.includes('Turn on HTTPS'), buttons.join('|'));
  const links = m.box.querySelectorAll('a');
  const rename = links.find((a) => a.textContent === 'Rename this PC in Tailscale');
  assert.ok(rename, 'a rename link on the HTTPS step');
  assert.equal(rename.href, 'https://login.tailscale.com/admin/machines');
  assert.equal(rename.target, '_blank', 'opens in the system browser like other external links');
  assert.match(rename.rel, /noopener/);
  assert.ok(!fs.readFileSync(path.join(APP, 'devices-ui.js'), 'utf8').includes('Paired phones'));
  assert.ok(!fs.readFileSync(path.join(APP, 'devices-ui.js'), 'utf8').includes('never changes your Tailscale setup'), 'the old rule is gone');
});

test('Devices: one line under the switch says closing the window keeps AIB in the tray while phone access is on', async () => {
  const LINE = 'While this is on, closing the AIB window keeps AIB running in the tray. Use Quit to stop it.';
  for (const on of [true, false]) {
    const { UI, make } = await devices();
    const view = { ...VIEW, on };
    const m = make();
    UI.render('access', m.box, { get: async () => view, post: async () => view });
    await flush();
    assert.equal(UI.TRAY_NOTE, LINE);
    const ps = m.box.querySelectorAll('p');
    const note = ps.find((p) => p.textContent === LINE);
    assert.ok(note, `the line is there (phone access ${on ? 'on' : 'off'}): ${ps.map((p) => p.textContent).join('|')}`);
    assert.equal(note.id, 'dvTrayNote');
    assert.match(note.className, /\bst-note\b/);
    const kids = note.parentNode.children;
    const at = kids.indexOf(note);
    assert.ok(at > 0 && /\bdv-switch\b/.test(kids[at - 1].className), 'directly under the switch row');
    assert.equal(kids[at - 1].querySelector('input').id, 'dvAccess');
  }
});

test('helper state dots: needs you = warning, working = accent, done = good, idle = muted', () => {
  assert.equal(P.helperTone('needs_you'), 'need');
  assert.equal(P.helperTone('running'), 'work');
  assert.equal(P.helperTone('completed'), 'turn');
  assert.equal(P.helperTone('weird'), 'idle');
  assert.equal(P.helperTone(''), 'idle');
  const rules = cssRules(fs.readFileSync(path.join(APP, 'phone.css'), 'utf8'));
  const bg = (sel) => (rules.find((r) => r.selector === sel) || { declarations: {} }).declarations.background;
  assert.equal(bg('.ph-dot.need'), 'var(--hd-need)');
  assert.equal(bg('.ph-dot.work'), 'var(--accent)');
  assert.equal(bg('.ph-dot.turn'), 'var(--ok)');
  assert.equal(bg('.ph-dot.idle'), 'var(--muted)');
});

test('phone.css: Live chip is a green dot with muted text; helpers box and inline links are padded', () => {
  const rules = cssRules(fs.readFileSync(path.join(APP, 'phone.css'), 'utf8'));
  const d = (sel) => Object.assign({}, ...rules.filter((r) => r.selector === sel).map((r) => r.declarations));
  assert.equal(d('.ph-chip.live').color, 'var(--muted)');
  assert.equal(d('.ph-chip.live::before').background, 'var(--ok)');
  assert.match(d('.ph-helpers.ph-card').padding, /^\d+px (1[2-9]|[2-9]\d)px$/, 'inner horizontal padding');
  const pad = d('.ph-msg a').padding.split(' ');
  assert.ok(parseInt(pad[0], 10) * 2 + 21 >= 44, 'a link line (about 21 px) plus padding reaches 44 px');
});
