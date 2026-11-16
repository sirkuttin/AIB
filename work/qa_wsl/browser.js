'use strict';
/* Headless Chrome / Edge over the DevTools protocol, the pattern of work/test_card_layout.js: CHROME_PATH or a default install,
   --headless=new (no window), a temp profile that is deleted on close. One page; navigate, wait for window.__qaDone, measure,
   screenshot. Native dialogs (window.confirm) are answered at once and their text recorded, so nothing ever waits on screen. */
const fs = require('node:fs'),
  path = require('node:path'),
  { spawn } = require('node:child_process');

function findBrowser() {
  const list = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return list.find((p) => p && fs.existsSync(p)) || null;
}

async function cdp(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method) onEvent(m);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function launch(scratch) {
  const exe = findBrowser();
  if (!exe) throw new Error('no Chrome or Edge found');
  const dir = fs.mkdtempSync(path.join(scratch, 'profile-'));
  const proc = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--allow-file-access-from-files',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-pings',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const portFile = path.join(dir, 'DevToolsActivePort');
  const until = Date.now() + 20000;
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n')) {
    if (Date.now() > until) throw new Error('the browser did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  let target;
  while (!target) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  const log = { errors: [], dialogs: [] };
  let c;
  c = await cdp(target.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Runtime.exceptionThrown') log.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      log.errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') log.errors.push(m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Page.javascriptDialogOpening') {
      log.dialogs.push(m.params);
      c.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
  });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('DOM.enable');
  await c.send('CSS.enable');
  // no network: only file: and data: URLs load
  await c.send('Network.enable');
  await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
  let size = { width: 1280, height: 860 };
  const api = {
    log,
    send: c.send,
    async size(width, height) {
      size = { width, height };
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    get viewport() {
      return size;
    },
    async evaluate(fn, ...args) {
      const expr = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
      return r.result.value;
    },
    async goto(url) {
      log.errors.length = 0;
      log.dialogs.length = 0;
      await c.send('Page.navigate', { url: 'about:blank' });
      await new Promise((r) => setTimeout(r, 30));
      await c.send('Page.navigate', { url });
      for (let i = 0; i < 400; i++) {
        let v = false;
        try {
          v = await api.evaluate('!!window.__qaDone');
        } catch (e) {}
        if (v) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 120));
      return api.evaluate('window.__qaError || ""');
    },
    async shot(file, clip, format = 'png') {
      const params = { format, captureBeyondViewport: false };
      if (format !== 'png') params.quality = 80;
      if (clip) params.clip = Object.assign({ scale: 1 }, clip);
      const r = await c.send('Page.captureScreenshot', params);
      const buf = Buffer.from(r.data, 'base64');
      if (file) fs.writeFileSync(file, buf);
      return buf;
    },
    async key(key, opts = {}) {
      const codes = { Tab: 9, Escape: 27, Enter: 13, ' ': 32, ArrowDown: 40 };
      const base = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: codes[key] || 0, modifiers: opts.shift ? 8 : 0 };
      await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
      await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
      await new Promise((r) => setTimeout(r, 30));
    },
    async close() {
      c.close();
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000).unref())]);
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (e) {
        /* still locked: left in the scratch folder */
      }
      return !fs.existsSync(dir);
    },
  };
  return api;
}

module.exports = { launch, findBrowser };
