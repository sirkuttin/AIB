/* "Run in terminal": a small button next to the copy button on shell commands in agent replies and on tool calls that ran a
   command. It pastes the command into this chat's terminal (window.AibTerminal, the per-chat terminal panel) and never presses
   Enter: the person reads it and runs it. Without window.AibTerminal there is no button.
   commandText() is pure: which code gets a button and what text is pasted. decorate() is called by copy-ui.js per code block. */
(function (root) {
  'use strict';
  /* Fenced-code languages that are a shell. console / shellsession are prompt-and-output transcripts. */
  const SHELL_LANGS = new Set([
    'bash',
    'sh',
    'zsh',
    'shell',
    'console',
    'shellsession',
    'powershell',
    'ps1',
    'pwsh',
    'cmd',
    'bat',
    'batch',
  ]);
  /* A prompt at the start of a line: "$ ", "user@host:~/x$ ", "PS C:\x> ", "PS> ", "C:\x>". Group 1 is the command after it. */
  const PROMPT = [
    /^\s*\$\s(.*)$/,
    /^\s*[\w.-]+@[\w.-]+(?::[^\s$#]*)?[$#]\s(.*)$/,
    /^\s*PS(?: [A-Za-z]:\\[^>]*| [^>\s]+)?>\s?(.*)$/,
    /^\s*[A-Za-z]:\\(?:[^>\s]*(?: [^>\s]+)*)>\s?(.*)$/,
  ];
  /* Continuation-line prefixes inside a transcript: bash PS2 "> ", PowerShell ">> ". */
  const CONTINUATION = /^\s*>>?\s?(.*)$/;
  /* Programs a lone, unlabelled line may start with to count as a command. Kept short on purpose. */
  const PROGRAMS = new Set(
    (
      'git gh npm npx pnpm yarn bun node deno tsc eslint prettier python python3 py pip pip3 pipx uv uvx poetry pytest ' +
      'cargo rustup go dotnet mvn gradle make cmake java ruby gem bundle php composer docker podman kubectl helm terraform ' +
      'brew apt apt-get dnf yum pacman winget choco scoop sudo cd ls dir mkdir rmdir rm cp mv cat type echo touch curl wget ' +
      'ssh scp tar unzip grep rg find chmod chown code claude cls clear pwd export set setx where which'
    ).split(' '),
  );
  const POWERSHELL_VERB =
    /^(?:Get|Set|New|Remove|Add|Copy|Move|Rename|Start|Stop|Restart|Test|Invoke|Import|Install|Update|Select|Write|Clear|Enable|Disable|Out|Push|Pop)-[A-Z][A-Za-z]+$/;
  const ENDS_CONTINUED = /(?:\\|`|\^)\s*$/;

  const langOf = (lang) =>
    String(lang || '')
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
  const promptCommand = (line) => {
    for (const re of PROMPT) {
      const m = line.match(re);
      if (m) return m[1];
    }
    return null;
  };
  const trimEnd = (text) => String(text).replace(/\s+$/, '');
  const meaningful = (text) => text.split('\n').some((l) => l.trim() && !/^\s*(?:#|::|rem\s|REM\s)/.test(l));

  /* Prompt-style block: keep the commands (prompts stripped, continuation lines kept), drop output lines. */
  function fromTranscript(lines) {
    const out = [];
    let continued = false;
    for (const line of lines) {
      if (continued) {
        const c = line.match(CONTINUATION);
        const rest = c ? c[1] : line;
        out.push(rest);
        continued = ENDS_CONTINUED.test(rest);
        continue;
      }
      const cmd = promptCommand(line);
      if (cmd != null && cmd.trim()) {
        out.push(cmd);
        continued = ENDS_CONTINUED.test(cmd);
      }
    }
    return out.join('\n');
  }
  function looksLikeCommand(line) {
    const word = line.trim().split(/\s+/)[0] || '';
    if (/^\.{1,2}[\\/]\S/.test(word)) return true; // ./script.sh, .\build.ps1
    if (POWERSHELL_VERB.test(word)) return true;
    return PROGRAMS.has(word.toLowerCase().replace(/\.exe$/, ''));
  }

  /* The text to paste for a code block, or null when it gets no button.
     lang: the fence's language ('' when unlabelled). Never ends with a newline. */
  function commandText(code, lang) {
    const text = trimEnd(String(code ?? '').replace(/\r\n?/g, '\n')).replace(/^\n+/, '');
    if (!text.trim()) return null;
    const lines = text.split('\n'),
      l = langOf(lang),
      prompted = lines.some((line) => promptCommand(line) != null);
    if (SHELL_LANGS.has(l)) {
      /* With prompts it is a transcript: commands only. A console block without prompts is taken as plain commands. */
      const out = prompted ? trimEnd(fromTranscript(lines)) : text;
      return out.trim() && meaningful(out) ? out : null;
    }
    if (l) return null;
    /* Unlabelled: exactly one line that is a command (optionally behind a prompt). Anything longer may be a program or output. */
    const filled = lines.filter((line) => line.trim());
    if (filled.length !== 1) return null;
    const line = filled[0],
      cmd = promptCommand(line);
    if (cmd != null) return cmd.trim() ? trimEnd(cmd.trim()) : null;
    if (line.length > 400 || !looksLikeCommand(line)) return null;
    return trimEnd(line.trim());
  }
  /* A command an agent's tool call ran: pasted as it is, without trailing newlines. */
  function toolCommandText(command) {
    const text = trimEnd(String(command ?? '').replace(/\r\n?/g, '\n')).replace(/^\n+/, '');
    return text.trim() ? text : null;
  }

  /* ---- Page side ---- */
  const doc = () => root.document || globalThis.document;
  let host = { current: () => '' };
  /* chat.js: init({ current() }) gives the open chat's id (the key split panes use as data-mirror). */
  function init(h) {
    host = Object.assign({ current: () => '' }, h || {});
  }
  const terminal = () => {
    const T = root.AibTerminal;
    return T && typeof T.paste === 'function' ? T : null;
  };
  /* The chat a node belongs to: a split side pane says so on its message list; anything else is the open chat. */
  function conversationFor(node) {
    const pane = node && node.closest ? node.closest('[data-mirror]') : null;
    if (pane && pane.dataset && pane.dataset.mirror) return pane.dataset.mirror;
    try {
      return host.current() || '';
    } catch {
      return '';
    }
  }
  const hasClass = (node, name) => (' ' + (node.className || '') + ' ').includes(' ' + name + ' ');
  /* The text a decorated block pastes, or null: tool calls mark their command block (runCommand); Markdown fences go by language. */
  function textForBlock(block, pre, lang) {
    if (typeof block.runCommand === 'string') return toolCommandText(block.runCommand);
    if (!hasClass(block, 'markdown-code')) return null;
    return commandText(pre ? pre.textContent : '', lang);
  }
  const NS = 'http://www.w3.org/2000/svg';
  /* A terminal prompt: a window with ">_", stroke only, like the app's other inline icons. */
  function icon() {
    const d = doc();
    if (!d.createElementNS) return null;
    const svg = d.createElementNS(NS, 'svg');
    for (const [k, v] of [
      ['viewBox', '0 0 16 16'],
      ['width', '13'],
      ['height', '13'],
      ['aria-hidden', 'true'],
      ['focusable', 'false'],
      ['fill', 'none'],
      ['stroke', 'currentColor'],
      ['stroke-width', '1.5'],
      ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'],
    ])
      svg.setAttribute(k, v);
    const path = d.createElementNS(NS, 'path');
    path.setAttribute('d', 'M2 3h12v10H2zM4.5 6.5 6.5 8.5l-2 2M8 10.5h3.5');
    svg.append(path);
    return svg;
  }
  const NOTE_MS = 2500;
  function note(block, message, failed) {
    const d = doc();
    let n = block.runNote;
    if (!n) {
      n = d.createElement('span');
      n.className = 'run-term-note';
      n.setAttribute('role', 'status');
      block.runNote = n;
      block.append(n);
    }
    n.textContent = message;
    n.className = 'run-term-note' + (failed ? ' failed' : '');
    n.hidden = false;
    if (n.timer) clearTimeout(n.timer);
    n.timer = setTimeout(() => {
      n.hidden = true;
      n.textContent = '';
    }, NOTE_MS);
  }
  /* Pastes text into the chat's terminal. Resolves true when pasted. Never adds Enter. */
  async function run(conversationId, text) {
    const T = terminal();
    if (!T || !conversationId || !text) return false;
    await T.paste(conversationId, trimEnd(text));
    return true;
  }
  function makeButton(block, getText) {
    const btn = doc().createElement('button');
    btn.type = 'button';
    btn.className = 'run-term';
    btn.title = 'Run in terminal (pastes the command; you press Enter)';
    btn.setAttribute('aria-label', 'Run in terminal');
    const svg = icon();
    if (svg) btn.append(svg);
    else btn.textContent = '>_';
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      event.preventDefault();
      const id = conversationFor(block);
      if (!id) {
        note(block, 'Open a chat to use its terminal', true);
        return;
      }
      try {
        if (await run(id, getText())) note(block, 'Pasted into terminal, press Enter to run');
        else note(block, 'Terminal not available', true);
      } catch {
        note(block, 'Could not open the terminal', true);
      }
    });
    return btn;
  }
  /* copy-ui.js decorateCode(): block is the code box, pre its <pre>, lang the fence label, ctl the copy control. */
  function decorate(block, pre, lang, ctl) {
    if (!block || block.runDone || !terminal()) return null;
    const text = textForBlock(block, pre, lang);
    if (text == null) return null;
    block.runDone = true;
    const btn = makeButton(block, () => text);
    if (ctl && ctl.firstChild) ctl.insertBefore(btn, ctl.firstChild);
    else if (ctl) ctl.append(btn);
    else block.append(btn);
    return btn;
  }

  const api = { commandText, toolCommandText, textForBlock, conversationFor, decorate, run, init, SHELL_LANGS };
  root.RunInTerminalUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
