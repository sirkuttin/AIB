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
  /* The design's icons (16 px grid, stroke only): a terminal window with an arrow out of its corner, and the "Pasted" tick. */
  const RUN_PATHS = [
    'M8.25 2.75h-4.5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h8.5a2 2 0 0 0 2-2v-3.5',
    'M4.75 7.25 6.5 8.75l-1.75 1.5',
    'M14.25 1.75 10 6M10 3.5V6h2.5',
  ];
  const TICK_PATHS = ['M3.5 8.5 6.5 11.5 12.5 4.5'];
  function icon(paths, width) {
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
      ['stroke-width', width],
      ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'],
    ])
      svg.setAttribute(k, v);
    for (const d0 of paths) {
      const path = d.createElementNS(NS, 'path');
      path.setAttribute('d', d0);
      svg.append(path);
    }
    return svg;
  }
  const LABEL = 'Run in terminal',
    TIP = 'Run in terminal. Pastes the command. Nothing runs until you press Enter.',
    STATE_MS = 2000;
  /* Idle: the icon alone. After a click the button itself says what happened for about 2 s, then goes back (no toast). */
  function idle(btn) {
    btn.className = btn.runBase;
    btn.replaceChildren();
    const svg = icon(RUN_PATHS, '1.5');
    if (svg) btn.append(svg);
    else btn.textContent = '>_';
    btn.title = TIP;
    btn.setAttribute('aria-label', btn.runLabel);
  }
  function show(btn, state, text, label) {
    btn.className = btn.runBase + ' ' + state;
    btn.replaceChildren();
    if (state === 'done') {
      const svg = icon(TICK_PATHS, '1.75');
      if (svg) btn.append(svg);
    }
    btn.append(text);
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if (btn.runTimer) clearTimeout(btn.runTimer);
    btn.runTimer = setTimeout(() => {
      btn.runTimer = null;
      idle(btn);
    }, STATE_MS);
  }
  /* Pastes text into the chat's terminal. Resolves true when pasted. Never adds Enter. */
  async function run(conversationId, text) {
    const T = terminal();
    if (!T || !conversationId || !text) return false;
    await T.paste(conversationId, trimEnd(text));
    return true;
  }
  function makeButton(anchor, text, extraClass) {
    const btn = doc().createElement('button');
    btn.type = 'button';
    btn.runBase = 'run-term' + (extraClass ? ' ' + extraClass : '');
    btn.runLabel = LABEL;
    idle(btn);
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      event.preventDefault();
      const id = conversationFor(anchor);
      if (!id) {
        show(btn, 'failed', 'No chat', 'Not pasted: open a chat to use its terminal');
        return;
      }
      try {
        if (await run(id, text)) show(btn, 'done', 'Pasted', 'Pasted into the terminal');
        else show(btn, 'failed', 'Not pasted', 'Not pasted: the terminal is not available');
      } catch {
        show(btn, 'failed', 'Not pasted', 'Not pasted: the terminal could not be opened');
      }
    });
    return btn;
  }
  /* copy-ui.js decorateCode(): block is the code box, pre its <pre>, lang the fence label, ctl the copy control.
     The button goes left of Copy: both move into one corner group that takes over the copy control's place and fade. It carries
     copy-ctl so copying the message never picks up its "Pasted" text. */
  function decorate(block, pre, lang, ctl) {
    if (!block || block.runDone || !terminal()) return null;
    const text = textForBlock(block, pre, lang);
    if (text == null) return null;
    block.runDone = true;
    const btn = makeButton(block, text, 'copy-ctl');
    if (ctl && ctl.parentNode === block) {
      const group = doc().createElement('span');
      group.className = 'copy-code run-acts';
      block.insertBefore(group, ctl);
      ctl.classList.remove('copy-code');
      group.append(btn, ctl);
    } else block.append(btn);
    return btn;
  }
  /* tool-views.js line(): the collapsed row of a tool call that ran a command gets the button at its right end. */
  function decorateLine(line, command) {
    if (!line || line.runDone || !terminal()) return null;
    const text = toolCommandText(command);
    if (text == null) return null;
    line.runDone = true;
    const btn = makeButton(line, text, 'tool-run');
    btn.runLabel = LABEL + ': ' + (text.length > 80 ? text.slice(0, 79) + '…' : text).replace(/\s+/g, ' ');
    idle(btn);
    line.append(btn);
    return btn;
  }

  const api = {
    commandText,
    toolCommandText,
    textForBlock,
    conversationFor,
    decorate,
    decorateLine,
    run,
    init,
    SHELL_LANGS,
    STATE_MS,
  };
  root.RunInTerminalUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
