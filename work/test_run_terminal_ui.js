'use strict';
/* Run in terminal (run-terminal-ui.js): which commands get the button, what is pasted, and where. */
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { APP } = require('./_paths');
const { Node, page, load } = require('./fake_dom');
/* copy-ui.js walks up with parentElement; the shared fake DOM only has parentNode. */
if (!Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement'))
  Object.defineProperty(Node.prototype, 'parentElement', {
    get() {
      return this.parentNode;
    },
  });
const R = require(path.join(APP, 'run-terminal-ui.js'));

test('shell languages get the whole block as the command', () => {
  for (const lang of [
    'bash',
    'sh',
    'zsh',
    'shell',
    'powershell',
    'ps1',
    'pwsh',
    'cmd',
    'bat',
    'console',
    'Bash',
    'bash title=x',
  ])
    assert.equal(R.commandText('npm install\n', lang), 'npm install', lang);
  assert.equal(R.commandText('cd app\nnpm test\n\n', 'bash'), 'cd app\nnpm test');
  assert.equal(R.commandText('docker run \\\n  -p 80:80 nginx', 'sh'), 'docker run \\\n  -p 80:80 nginx');
  assert.equal(R.commandText('Get-ChildItem\r\nSet-Location ..\r\n', 'powershell'), 'Get-ChildItem\nSet-Location ..');
});

test('other languages and empty or comment-only blocks get no button', () => {
  for (const lang of ['js', 'python', 'json', 'text', 'diff', 'yaml', 'ts'])
    assert.equal(R.commandText('npm test', lang), null, lang);
  assert.equal(R.commandText('', 'bash'), null);
  assert.equal(R.commandText('   \n\n', 'bash'), null);
  assert.equal(R.commandText('# just a note\n# another', 'bash'), null);
  assert.equal(R.commandText('REM nothing to run', 'cmd'), null);
});

test('prompts are stripped and output lines skipped', () => {
  assert.equal(R.commandText('$ npm test\n> agent-studio@1 test\nok 1 - passes\n', 'console'), 'npm test');
  assert.equal(
    R.commandText('$ git status\nOn branch main\n$ git log -1\ncommit abc', 'console'),
    'git status\ngit log -1',
  );
  assert.equal(
    R.commandText('PS C:\\Users\\me> Get-Process node\n\nHandles  NPM(K)\n-------  ------', 'powershell'),
    'Get-Process node',
  );
  assert.equal(R.commandText('PS> dir', 'pwsh'), 'dir');
  assert.equal(R.commandText('C:\\work>dir /b\nfile.txt', 'cmd'), 'dir /b');
  assert.equal(R.commandText('C:\\Program Files\\x> where node\nC:\\node.exe', 'cmd'), 'where node');
  assert.equal(R.commandText('me@box:~/app$ make\ncc -o app', 'console'), 'make');
  /* a prompt in a plain shell block makes it a transcript too */
  assert.equal(R.commandText('$ ls\nREADME.md\nsrc', 'bash'), 'ls');
  /* continuation lines stay with their command */
  assert.equal(
    R.commandText('$ docker run \\\n> -p 80:80 \\\n> nginx\nUnable to find image', 'console'),
    'docker run \\\n-p 80:80 \\\nnginx',
  );
  assert.equal(R.commandText('PS> Get-Item x `\n>> -Force\n\nName', 'powershell'), 'Get-Item x `\n-Force');
  /* a console block of output only: nothing to run */
  assert.equal(R.commandText('$ \nsome output', 'console'), null);
  /* redirection in a cmd block is not a prompt */
  assert.equal(R.commandText('C:\\tools\\x.exe > out.txt', 'cmd'), 'C:\\tools\\x.exe > out.txt');
});

test('an unlabelled block counts only as one command line', () => {
  assert.equal(R.commandText('npm run lint', ''), 'npm run lint');
  assert.equal(R.commandText('\ngit push origin main\n', ''), 'git push origin main');
  assert.equal(R.commandText('$ pip install requests', ''), 'pip install requests');
  assert.equal(R.commandText('./build.sh --release', ''), './build.sh --release');
  assert.equal(R.commandText('.\\setup.ps1', ''), '.\\setup.ps1');
  assert.equal(R.commandText('Get-ChildItem -Recurse', ''), 'Get-ChildItem -Recurse');
  assert.equal(R.commandText('python.exe -m venv .venv', ''), 'python.exe -m venv .venv');
  /* programs, output, prose and multi-line text get no button */
  assert.equal(R.commandText('const x = require("y");', ''), null);
  assert.equal(R.commandText('console.log("hi")', ''), null);
  assert.equal(R.commandText('import os', ''), null);
  assert.equal(R.commandText('npm install\nnpm test', ''), null);
  assert.equal(R.commandText('function f() {\n  return 1;\n}', ''), null);
  assert.equal(R.commandText('All 12 tests passed', ''), null);
  assert.equal(R.commandText('C:\\Users\\me\\file.txt', ''), null);
  assert.equal(R.commandText('{"ok": true}', ''), null);
  assert.equal(R.commandText('git ' + 'x'.repeat(500), ''), null);
});

test('tool commands are pasted as they are, without trailing newlines', () => {
  assert.equal(R.toolCommandText('npm test\n'), 'npm test');
  assert.equal(R.toolCommandText('cd a && \\\n  make\r\n'), 'cd a && \\\n  make');
  assert.equal(R.toolCommandText('  \n'), null);
  assert.equal(R.toolCommandText(undefined), null);
});

/* ---- the page: buttons through copy-ui.js, pastes through window.AibTerminal ---- */
function setup({ terminal = true, current = 'claude:abc' } = {}) {
  const shell = page();
  shell.document.createElementNS = (ns, tag) => shell.document.createElement(tag);
  const ctx = load(shell, ['markdown.js', 'run-terminal-ui.js', 'tool-views.js', 'copy-ui.js']);
  const pastes = [];
  if (terminal)
    ctx.AibTerminal = {
      open: async () => {},
      isOpen: () => false,
      paste: async (id, text) => {
        pastes.push([id, text]);
      },
    };
  ctx.RunInTerminalUI.init({ current: () => current });
  const markdown = (source, parent) => {
    const box = shell.document.createElement('div');
    box.className = 'markdown';
    (parent || shell.byId.messages).append(box);
    ctx.AgentMarkdown.render(box, source);
    ctx.CopyUI.decorateCode(box);
    return box;
  };
  const buttons = (node) => node.querySelectorAll('button.run-term');
  const flush = () => new Promise((r) => setImmediate(r));
  return { shell, ctx, pastes, markdown, buttons, flush };
}

test('shell fences get the button, next to the copy button; other code does not', () => {
  const { markdown, buttons } = setup();
  const box = markdown(
    'Run:\n\n```bash\nnpm test\n```\n\n```js\nconst a = 1;\n```\n\n```\nnpm run lint\n```\n\n```\nok 1\nok 2\n```',
  );
  const found = buttons(box);
  assert.equal(found.length, 2);
  for (const btn of found) {
    assert.equal(btn.getAttribute('aria-label'), 'Run in terminal');
    assert.equal(btn.type, 'button');
    assert.equal(btn.tagName, 'BUTTON'); /* a real button: reachable with Tab, Enter and Space */
    const group = btn.parentNode;
    assert.ok(group.classList.contains('copy-code'), 'in the code block corner, where Copy was');
    assert.equal(group.firstChild, btn, 'left of Copy');
    assert.ok(group.children[1].classList.contains('copy-ctl') && group.children[1].querySelector('.copy-main'));
    assert.ok(!group.children[1].classList.contains('copy-code'), 'one corner group, not two');
    assert.equal(btn.textContent, '', 'icon only');
    assert.match(btn.title, /Nothing runs until you press Enter/);
    assert.ok(btn.querySelector('svg'), 'inline icon');
    assert.equal(btn.querySelector('svg').getAttribute('stroke'), 'currentColor');
  }
});

test('no window.AibTerminal: no button', () => {
  const { markdown, buttons } = setup({ terminal: false });
  const box = markdown('```bash\nnpm test\n```');
  assert.equal(buttons(box).length, 0);
  assert.ok(box.querySelector('.copy-main'), 'copy still there');
});

test('clicking pastes into this chat with the right text and no Enter; the button reads Pasted for 2 s, no toast', async () => {
  const { shell, ctx, markdown, buttons, pastes, flush } = setup();
  const box = markdown('```console\n$ npm test\n> agent-studio@1 test\nok\n$ npm run lint\n```');
  buttons(box)[0].click();
  await flush();
  assert.deepEqual(pastes, [['claude:abc', 'npm test\nnpm run lint']]);
  assert.ok(!/[\r\n]$/.test(pastes[0][1]), 'no Enter at the end');
  const btn = buttons(box)[0];
  assert.equal(btn.textContent, 'Pasted');
  assert.ok(btn.classList.contains('done'));
  assert.equal(btn.getAttribute('aria-label'), 'Pasted into the terminal');
  assert.equal(box.all().filter((n) => n.getAttribute('role') === 'status').length, 0, 'no toast or note');
  assert.ok(!/Pasted/.test(ctx.CopyUI.toPlain(box)), 'copying the message leaves the button out');
  assert.equal(ctx.RunInTerminalUI.STATE_MS, 2000);
  shell.window.runTimers();
  assert.equal(btn.textContent, '');
  assert.ok(!btn.classList.contains('done'));
  assert.equal(btn.getAttribute('aria-label'), 'Run in terminal');
});

test('a split side pane pastes into its own chat', async () => {
  const { shell, markdown, buttons, pastes, flush } = setup();
  const pane = shell.document.createElement('div');
  pane.className = 'mirror-msgs';
  pane.dataset.mirror = 'omp:other';
  pane.setAttribute('data-mirror', 'omp:other');
  shell.body.append(pane);
  buttons(markdown('```sh\nls -la\n```', pane))[0].click();
  await flush();
  assert.deepEqual(pastes, [['omp:other', 'ls -la']]);
});

test('no open chat: nothing pasted, the button says so briefly', async () => {
  const { markdown, buttons, pastes, flush } = setup({ current: '' });
  const box = markdown('```bash\nnpm test\n```');
  buttons(box)[0].click();
  await flush();
  assert.deepEqual(pastes, []);
  const btn = buttons(box)[0];
  assert.equal(btn.textContent, 'No chat');
  assert.ok(btn.classList.contains('failed'));
  assert.match(btn.getAttribute('aria-label'), /open a chat/);
});

test('a failed paste is reported, not thrown', async () => {
  const { ctx, markdown, buttons, flush } = setup();
  ctx.AibTerminal.paste = async () => {
    throw new Error('no pty');
  };
  const box = markdown('```bash\nnpm test\n```');
  buttons(box)[0].click();
  await flush();
  const btn = buttons(box)[0];
  assert.equal(btn.textContent, 'Not pasted');
  assert.match(btn.getAttribute('aria-label'), /could not be opened/);
  assert.equal(box.querySelectorAll('.run-term-note').length, 0);
});

test('tool calls that ran a command get the button on the command, not on their output', async () => {
  const { shell, ctx, buttons, pastes, flush } = setup();
  const view = ctx.ToolViews.renderCall({
    name: 'Bash',
    input: { command: 'npm test -- --grep x\n', description: 'Run tests' },
    result: { text: 'npm test\nall passed', isError: false },
  });
  shell.byId.messages.append(view);
  ctx.CopyUI.decorateCode(view);
  const found = buttons(view);
  assert.equal(found.length, 1);
  assert.ok(!found[0].closest('.tool-result'), 'not on the output');
  found[0].click();
  await flush();
  assert.deepEqual(pastes, [['claude:abc', 'npm test -- --grep x']]);
  /* live ACP tool calls (raw) too */
  const raw = ctx.ToolViews.render({
    kind: 'execute',
    title: 'pwsh',
    status: 'completed',
    rawInput: { command: 'Get-Date' },
    _meta: {},
  });
  ctx.CopyUI.decorateCode(raw);
  assert.equal(buttons(raw).length, 1);
  /* other tools' code blocks never get one */
  const write = ctx.ToolViews.renderCall({ name: 'Write', input: { file_path: 'a.sh', content: 'npm test' } });
  ctx.CopyUI.decorateCode(write);
  assert.equal(buttons(write).length, 0);
});

test('collapsed tool rows that ran a command get the button with its tooltip; others do not', async () => {
  const { shell, ctx, buttons, pastes, flush } = setup();
  const line = ctx.ToolViews.line(
    { role: 'tool', call: { name: 'Bash', input: { command: 'deno task test --filter pty' } } },
    () => shell.document.createElement('div'),
  );
  shell.byId.messages.append(line);
  const found = buttons(line);
  assert.equal(found.length, 1);
  assert.ok(found[0].classList.contains('tool-run'));
  assert.equal(found[0].getAttribute('aria-label'), 'Run in terminal: deno task test --filter pty');
  assert.match(found[0].title, /Pastes the command\. Nothing runs until you press Enter\./);
  found[0].click();
  await flush();
  assert.deepEqual(pastes, [['claude:abc', 'deno task test --filter pty']]);
  assert.equal(found[0].textContent, 'Pasted');
  const read = ctx.ToolViews.line({ role: 'tool', call: { name: 'Read', input: { file_path: 'a.ts' } } }, () =>
    shell.document.createElement('div'),
  );
  assert.equal(buttons(read).length, 0);
  const raw = ctx.ToolViews.line(
    { role: 'tool', raw: { kind: 'execute', title: 'bash', rawInput: { command: 'ls' } } },
    () => shell.document.createElement('div'),
  );
  assert.equal(buttons(raw).length, 1);
});

test('decorating twice adds one button', () => {
  const { ctx, markdown, buttons } = setup();
  const box = markdown('```bash\nnpm test\n```');
  ctx.CopyUI.decorateCode(box);
  assert.equal(buttons(box).length, 1);
});

test('run() pastes the text without a trailing newline', async () => {
  const { ctx, pastes } = setup();
  assert.equal(await ctx.RunInTerminalUI.run('claude:abc', 'echo hi\n\n'), true);
  assert.deepEqual(pastes, [['claude:abc', 'echo hi']]);
});
