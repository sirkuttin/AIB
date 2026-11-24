// Renders opt-in client terminals and file writes. All agent-controlled text goes in via textContent only.
(function () {
  'use strict';
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function describeStatus(t) {
    if (t.status === 'running') return 'running';
    if (t.signal) return t.status + ' (signal ' + t.signal + ')';
    return t.status + (t.exitCode === null || t.exitCode === undefined ? '' : ' (exit ' + t.exitCode + ')');
  }
  function render(root, caps) {
    if (!root) return;
    const enabled = !!caps && !!(caps.terminal || caps.fs);
    root.hidden = !enabled;
    root.textContent = '';
    if (!enabled) return;
    const terminals = Array.isArray(caps.terminals) ? caps.terminals : [];
    const writes = Array.isArray(caps.writes) ? caps.writes : [];
    const head = el('h3', 'client-caps-heading', 'Client access ');
    head.append(
      el(
        'span',
        'client-caps-modes',
        [
          caps.terminal ? 'terminal' : '',
          caps.fs === 'readwrite' ? 'files: read+write' : caps.fs === 'read' ? 'files: read-only' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    root.append(head);
    if (caps.terminal) {
      const list = el('div', 'client-terminals');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', 'Agent terminals');
      if (!terminals.length) list.append(el('p', 'note', 'No agent terminals open.'));
      for (const t of terminals) {
        const card = el('div', 'client-terminal client-terminal-' + String(t.status).replace(/[^a-z]/g, ''));
        const title = el('div', 'client-terminal-title');
        title.append(
          el('code', 'client-terminal-command', t.command),
          el('span', 'client-terminal-status', describeStatus(t)),
        );
        card.append(title, el('div', 'client-terminal-cwd', t.cwd));
        card.append(el('pre', 'client-terminal-output', t.outputTail || ''));
        if (t.truncated) card.append(el('div', 'note', 'Output truncated: showing the end.'));
        list.append(card);
      }
      root.append(list);
    }
    if (caps.fs === 'readwrite') {
      const box = el('div', 'client-writes');
      box.append(el('h4', 'client-writes-heading', 'Files written by agents'));
      if (!writes.length) box.append(el('p', 'note', 'No files written yet.'));
      for (const w of writes.slice().reverse()) {
        const row = el('div', 'client-write');
        row.append(
          el('code', 'client-write-path', w.path),
          el('span', 'client-write-bytes', (w.created ? 'created, ' : 'overwrote, ') + w.bytes + ' bytes'),
        );
        box.append(row);
      }
      root.append(box);
    }
  }
  window.AgentClientCapsUI = { render };
})();
