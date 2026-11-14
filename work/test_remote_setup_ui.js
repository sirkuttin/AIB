'use strict';
// Settings > Remote control's setup steps (devices-ui.js setupSteps, refreshEvery, missingNotice) and the Settings rename: what each
// step says and which button it shows for every state of the approved design (aib-remote-setup.html), the re-check cadence, the
// in-app notice, and the Silent reminders row. The server side runs in work/deno/remote_setup_test.ts; the page in a headless
// browser in work/deno/remote_setup_page_test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { page, load, APP } = require('./fake_dom.js');
const D = require(path.join(APP, 'devices-ui.js'));
const SET = require(path.join(APP, 'settings-ui.js'));

const NAME = 'studio-pc.tail-a1b2.ts.net';
const SIGNED_IN = { installed: true, signedIn: true, backend: 'Running', name: NAME, machine: 'studio-pc', tailnet: 'tail-a1b2.ts.net', login: 'someone@example.com', https: true, serving: false };
const base = (ts, setup, more) =>
  Object.assign({ on: true, listening: true, port: 8779, artifactPort: 8780, artifactListening: true, problem: null, tailscale: ts, setup: Object.assign({ os: 'windows', installMode: 'winget', changes: [], commands: { share: 'tailscale serve --bg --https=443 http://127.0.0.1:8779' }, links: { download: 'https://tailscale.com/download', appStore: 'https://apps.apple.com/app/id1475387142', adminMachines: 'https://login.tailscale.com/admin/machines' } }, setup || {}) }, more || {});
const acts = (step) => step.actions.map((a) => a.label);
const states = (m) => m.steps.map((s) => s.state);

test('Settings: the section is called Remote control (id devices: old links still open it); search finds it by its old and new words', () => {
  const sec = SET.SECTIONS.find((s) => s.id === 'devices');
  assert.equal(sec.label, 'Remote control');
  assert.ok(!SET.SECTIONS.some((s) => s.label === 'Devices'));
  for (const q of ['devices', 'phone', 'tailscale', 'remote control', 'silent', 'reminder', 'notification']) {
    const hits = SET.filterIndex(SET.INDEX, q).filter((e) => e.section === 'devices').map((e) => e.id);
    assert.ok(hits.length >= 1, q + ': ' + hits.join(','));
  }
  assert.deepEqual(SET.filterIndex(SET.INDEX, 'devices').filter((e) => e.section === 'devices').map((e) => e.id), ['devices-access', 'devices-phones']);
  assert.ok(SET.filterIndex(SET.INDEX, 'silent').some((e) => e.id === 'devices-phones'));
});

test('step 1, not installed: one Install button per OS (winget / MSI / .pkg with the App Store link / Linux terminal) and Download', () => {
  const missing = { installed: false, problem: 'not_installed' };
  let m = D.setupSteps(base(missing));
  assert.deepEqual(states(m), ['now', 'later', 'later', 'later']);
  assert.deepEqual(acts(m.steps[0]), ['Install Tailscale']);
  assert.equal(m.steps[0].actions[0].act, 'install');
  assert.equal(m.steps[0].notes[1], 'AIB installs it with winget. Windows asks once for permission (a UAC prompt). Click Yes.');
  assert.deepEqual(m.steps[0].links.map((l) => l.href), ['https://tailscale.com/download']);
  m = D.setupSteps(base(missing, { installMode: 'msi' }));
  assert.match(m.steps[0].notes[1], /Windows will ask for Tailscale Inc\./);
  m = D.setupSteps(base(missing, { os: 'darwin', installMode: 'pkg' }));
  assert.deepEqual(m.steps[0].links.map((l) => l.text), ['Download Tailscale', 'Get it from the Mac App Store instead']);
  m = D.setupSteps(base(missing, { os: 'linux', installMode: 'terminal' }));
  assert.equal(m.steps[0].actions[0].act, 'term-install');
  m = D.setupSteps(base(missing, { os: 'linux', installMode: 'terminal' }), { term: { step: 'tailscale-install' } });
  assert.equal(m.steps[0].state, 'wait');
  assert.equal(m.steps[0].terminal, true);
  assert.equal(m.steps[0].notes[0], 'Type your password in the terminal below. It goes to sudo, and AIB doesn’t keep it.');
});

test('step 1, installing and failed: progress, Cancel only when it can stop, "You chose No", other failures with details', () => {
  const missing = { installed: false, problem: 'not_installed' };
  const progress = [{ text: 'Found winget', state: 'done' }, { text: 'Windows is asking for permission.', state: 'now' }];
  let m = D.setupSteps(base(missing, { job: { action: 'install', state: 'running', progress, cancellable: false } }));
  assert.equal(m.steps[0].state, 'wait');
  assert.deepEqual(m.steps[0].progress, progress);
  assert.deepEqual(acts(m.steps[0]), []);
  assert.equal(m.waiting, true);
  m = D.setupSteps(base(missing, { job: { action: 'install', state: 'failed', code: 'declined', message: 'You chose No on the Windows prompt. Nothing was installed.' } }));
  assert.equal(m.steps[0].alert, 'You chose No on the Windows prompt. Nothing was installed. Click Install Tailscale to try again.');
  assert.deepEqual(acts(m.steps[0]), ['Install Tailscale']);
  const failed = { action: 'install', state: 'failed', code: 'failed', message: 'winget stopped with error 0x8A15000F: the package source could not be reached.', details: ['line 1', 'line 2'] };
  m = D.setupSteps(base(missing, { job: failed }));
  assert.match(m.steps[0].alert, /^Tailscale didn’t install\. winget stopped/);
  assert.deepEqual(acts(m.steps[0]), ['Install Tailscale', 'Show details']);
  assert.deepEqual(m.steps[0].links.map((l) => l.text), ['Download Tailscale']);
  m = D.setupSteps(base(missing, { job: failed }), { details: true });
  assert.deepEqual(m.steps[0].details, ['line 1', 'line 2']);
});

test('step 1, sign in: the button, the wait with the fallback link and Cancel, no link in time, flags and operator failures', () => {
  const out = { installed: true, signedIn: false, backend: 'NeedsLogin', problem: 'signed_out' };
  let m = D.setupSteps(base(out));
  assert.deepEqual(acts(m.steps[0]), ['Sign in to Tailscale']);
  m = D.setupSteps(base(out, { job: { action: 'login', state: 'running', phase: 'browser', link: 'https://login.tailscale.com/a/x' } }));
  assert.equal(m.steps[0].notes[0], 'Finish signing in in your browser. This turns green by itself.');
  assert.deepEqual(m.steps[0].links, [{ text: 'Open the sign-in page again', href: 'https://login.tailscale.com/a/x' }]);
  assert.deepEqual(acts(m.steps[0]), ['Cancel']);
  m = D.setupSteps(base(out, { job: { action: 'login', state: 'running', phase: 'no_link', message: 'No sign-in page came from Tailscale. Open Tailscale and sign in there.' } }));
  assert.deepEqual(acts(m.steps[0]), ['Open Tailscale', 'Cancel']);
  m = D.setupSteps(base(out, { job: { action: 'login', state: 'failed', code: 'flags', message: 'Tailscale wants to be started from its own app.' } }));
  assert.deepEqual(acts(m.steps[0]), ['Open Tailscale']);
  m = D.setupSteps(base(out, { os: 'linux', installMode: 'terminal', job: { action: 'login', state: 'failed', code: 'operator', message: 'x', fallback: 'sudo tailscale set --operator="$(id -un)"' } }));
  assert.equal(m.steps[0].actions[0].act, 'term-operator');
  assert.equal(m.steps[0].command, 'sudo tailscale set --operator="$(id -un)"', 'a copyable command when a step fails');
  m = D.setupSteps(base({ installed: true, signedIn: false, backend: 'NeedsMachineAuth', problem: 'needs_machine_auth' }));
  assert.equal(m.steps[0].state, 'wait');
});

test('Tailscale switched off later: a banner, Turn Tailscale on and Open Tailscale; the status line says phones can’t reach AIB', () => {
  const m = D.setupSteps(base({ installed: true, signedIn: false, backend: 'Stopped', problem: 'stopped', serving: true }));
  assert.equal(m.steps[0].state, 'err');
  assert.match(m.steps[0].alert, /AIB’s share is still set up/);
  assert.deepEqual(acts(m.steps[0]), ['Turn Tailscale on', 'Open Tailscale']);
  assert.equal(m.status.text, 'Tailscale is switched off, so phones can’t reach AIB right now.');
});

test('step 2, HTTPS: Turn on HTTPS with the certificate-log heads-up and rename link; then it waits; then green', () => {
  let m = D.setupSteps(base(Object.assign({}, SIGNED_IN, { https: false })));
  assert.deepEqual(states(m), ['ok', 'now', 'later', 'later']);
  assert.equal(m.steps[0].notes[0], 'Signed in as someone@example.com. This PC is STUDIO-PC on tail-a1b2.ts.net.');
  assert.deepEqual(acts(m.steps[1]), ['Turn on HTTPS']);
  assert.match(m.steps[1].notes[1], /public certificate logs/);
  m = D.setupSteps(base(Object.assign({}, SIGNED_IN, { https: false }), { httpsWaiting: true }));
  assert.equal(m.steps[1].state, 'wait');
  assert.deepEqual(acts(m.steps[1]), ['Open the page again']);
  m = D.setupSteps(base(SIGNED_IN));
  assert.deepEqual(states(m), ['ok', 'ok', 'now', 'later']);
});

test('step 3, Share AIB: the button, sharing progress, done with Stop sharing, Share again after a missing share', () => {
  let m = D.setupSteps(base(SIGNED_IN));
  assert.deepEqual(acts(m.steps[2]), ['Share AIB']);
  assert.match(m.steps[2].notes[0], /Only devices on your tailnet can reach it, not the internet\.$/);
  m = D.setupSteps(base(SIGNED_IN, { job: { action: 'share', state: 'running', progress: [{ text: 'Artifacts: x', state: 'now' }] } }));
  assert.equal(m.steps[2].state, 'wait');
  m = D.setupSteps(base(Object.assign({}, SIGNED_IN, { serving: true, artifactServing: true })));
  assert.deepEqual(states(m), ['ok', 'ok', 'ok', 'now']);
  assert.deepEqual(acts(m.steps[2]), ['Stop sharing']);
  assert.equal(m.status.text, '✓ Reachable at https://' + NAME + ' through Tailscale. All set: four score and no commands.');
  m = D.setupSteps(base(SIGNED_IN, { missingAtStart: true, shareAgain: true }));
  assert.match(m.steps[2].alert, /share on Tailscale was missing/);
  assert.deepEqual(acts(m.steps[2]), ['Share again']);
  m = D.setupSteps(base(SIGNED_IN, { job: { action: 'share', state: 'failed', message: 'Tailscale didn’t share AIB.', fallback: 'tailscale serve --bg --https=443 http://127.0.0.1:8779' } }));
  assert.equal(m.steps[2].state, 'err');
  assert.equal(m.steps[2].command, 'tailscale serve --bg --https=443 http://127.0.0.1:8779');
});

test('step 3, the address is used elsewhere: one confirm naming both ports, then a second click', () => {
  const ts = Object.assign({}, SIGNED_IN, { servingOther: 'http://127.0.0.1:3000', artifactServingOther: 'tcp://127.0.0.1:22' });
  let m = D.setupSteps(base(ts));
  assert.equal(
    m.steps[2].confirm,
    'https://' + NAME + ' is shared to http://127.0.0.1:3000 now. https://' + NAME + ':8443 is shared to tcp://127.0.0.1:22 now. Sharing AIB replaces both, and those programs stop being reachable over Tailscale.',
  );
  assert.deepEqual(acts(m.steps[2]), ['Replace and share']);
  m = D.setupSteps(base(ts), { replaceConfirm: true });
  assert.deepEqual(acts(m.steps[2]), ['Yes, replace it', 'Cancel']);
  assert.ok(m.steps[2].notes.includes('Click again to confirm.'));
});

test('step 3, Funnel on and port busy: what is public, Turn off Funnel with its confirm; the port message and Check again', () => {
  const ts = Object.assign({}, SIGNED_IN, { funnelPorts: [{ port: 443, to: 'http://127.0.0.1:3000' }] });
  const problem = { code: 'funnel', message: 'Funnel is on for this PC. https://' + NAME + ':443 → http://127.0.0.1:3000 is on the public internet.' };
  let m = D.setupSteps(base(ts, {}, { problem, listening: false }));
  assert.equal(m.steps[2].state, 'err');
  assert.deepEqual(acts(m.steps[2]), ['Turn off Funnel']);
  assert.equal(m.status.text, 'Phone access is waiting on step 3.');
  m = D.setupSteps(base(ts, {}, { problem, listening: false }), { funnelConfirm: true });
  assert.equal(m.steps[2].confirm, 'Turn off Funnel for port 443? http://127.0.0.1:3000 stops being public. AIB runs tailscale funnel --https=443 off.');
  assert.deepEqual(acts(m.steps[2]), ['Turn off Funnel', 'Cancel']);
  m = D.setupSteps(base(SIGNED_IN, {}, { problem: { code: 'port_busy', message: 'Port 8779 is busy.' }, listening: false }));
  assert.deepEqual([m.steps[2].alert, acts(m.steps[2])], ['Port 8779 is busy.', ['Check again']]);
});

test('switched off: the status line; pending unshare; "stopped sharing" after AIB removed its share', () => {
  let m = D.setupSteps(base(SIGNED_IN, {}, { on: false }));
  assert.equal(m.status.text, 'Off. Nothing on your PC is reachable from other devices.');
  m = D.setupSteps(base(SIGNED_IN, { pendingUnshare: true }, { on: false }));
  assert.match(m.status.text, /as soon as Tailscale runs again\.$/);
  m = D.setupSteps(base(SIGNED_IN, { changes: [{ label: 'Stopped sharing AIB', ok: true }] }, { on: false }));
  assert.match(m.status.text, /AIB stopped sharing on Tailscale\. Tailscale stays installed and signed in\.$/);
});

test('re-check cadence: 3 s while a step waits, 30 s otherwise, 30 s after 10 minutes on screen', () => {
  assert.equal(D.refreshEvery(true, 1000), 3000);
  assert.equal(D.refreshEvery(false, 1000), 30000);
  assert.equal(D.refreshEvery(true, 11 * 60 * 1000), 30000);
});

const flush = () => new Promise((r) => setTimeout(r, 5));
function shell(view, posts) {
  const sh = page();
  sh.window.setInterval = () => 1;
  sh.window.clearInterval = () => {};
  sh.window.setTimeout = (fn) => (fn(), 1);
  const ctx = load(sh, ['devices-ui.js']);
  const host = {
    get: async () => view,
    post: async (name, body) => {
      posts.push([name, body]);
      return view;
    },
  };
  return { sh, UI: ctx.AIBDevicesUI, host };
}

test('the in-app notice: AIB started with its share missing; Share again runs the Share AIB click; × dismisses it on the server', async () => {
  const view = base(SIGNED_IN, { missingAtStart: true, shareAgain: true });
  assert.equal(D.missingNotice(view), true);
  assert.equal(D.missingNotice(base(SIGNED_IN)), false);
  assert.equal(D.missingNotice(Object.assign({}, view, { on: false })), false);
  const posts = [];
  let { sh, UI, host } = shell(view, posts);
  UI.watch(host);
  await flush();
  let notice = sh.document.querySelector('#dvMissingNotice');
  assert.ok(notice, 'shown');
  assert.match(notice.className, /\btoast\b/, 'the page’s own notice look, not an OS notification');
  assert.ok(notice.textContent.includes('Phones can’t reach AIB'));
  sh.document.querySelector('#dvShareAgain').click();
  await flush();
  assert.equal(JSON.stringify(posts), JSON.stringify([['devices/tailscale/run', { action: 'share' }]]));
  posts.length = 0;
  ({ sh, UI, host } = shell(view, posts));
  UI.watch(host);
  await flush();
  notice = sh.document.querySelector('#dvMissingNotice');
  notice.querySelector('.toast-close').click();
  await flush();
  assert.equal(JSON.stringify(posts), JSON.stringify([['devices/tailscale/run', { action: 'dismiss-missing' }]]));
  assert.equal(sh.document.querySelector('#dvMissingNotice'), null);
});

test('Silent reminders: a switch under each phone, on unless the phone says off, saved at once', async () => {
  const view = base(Object.assign({}, SIGNED_IN, { serving: true }), {}, { devices: [{ id: 'p1', name: 'Pixel 9', scopes: ['phone.read'], lastSeen: 0, remind: true }, { id: 'p2', name: 'Old', scopes: ['phone.read'], lastSeen: 0, remind: false }], pairing: {} });
  const posts = [];
  const { sh, UI, host } = shell(view, posts);
  const box = sh.make('div', '', sh.body);
  Object.defineProperty(box, 'isConnected', { get: () => true });
  UI.render('phones', box, host);
  await flush();
  const boxes = box.querySelectorAll('input').filter((i) => i.dataset && i.dataset.remind);
  assert.equal(JSON.stringify(boxes.map((i) => [i.dataset.remind, i.checked])), JSON.stringify([['p1', true], ['p2', false]]));
  assert.ok(box.textContent.includes('Silent reminders'));
  assert.ok(box.textContent.includes('stays until you open AIB on the phone'));
  boxes[0].checked = false;
  boxes[0].dispatch ? boxes[0].dispatch('change') : boxes[0].dispatchEvent({ type: 'change' });
  await flush();
  assert.equal(JSON.stringify(posts.find((p) => p[0] === 'devices/prefs')), JSON.stringify(['devices/prefs', { id: 'p1', remind: false }]));
});
