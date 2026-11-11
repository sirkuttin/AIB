/* The local docs' test page (the real UI is being designed): /doc.html?chat=<chat id>&name=<doc name>; a new name makes a new doc. Opens the doc in the chat's project (its Markdown copy is
 * docs/<name>.md there) and binds the vendored TipTap editor (vendor/docs/editor.js) to the server's live Y.Doc over the doc socket.
 * Agents' words show tinted (the agentEdit mark), with the agent's name on hover. Ctrl+Z undoes only your own edits. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const fail = (text) => {
    $('docError').textContent = text;
    $('docError').hidden = false;
    $('docStatus').textContent = 'Not open';
  };
  async function start() {
    const boot = await (await fetch('/api/live/bootstrap', { cache: 'no-store' })).json();
    const token = boot.token;
    const open = (create) =>
      fetch('/api/live/docs/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
        body: JSON.stringify({ id: params.get('chat') || '', name: params.get('name') || '', create }),
      });
    let response = await open(undefined);
    let opened = await response.json();
    if (opened.code === 'no_doc') {
      response = await open('');
      opened = await response.json();
    }
    if (!response.ok) return fail(opened.error || 'Could not open the doc');
    $('docTitle').textContent = opened.name;
    $('docFile').textContent = opened.file;
    document.title = opened.name + ' - AIB';
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/live/docs/socket?doc=' + encodeURIComponent(opened.doc);
    window.AIBDocEditor.mount($('docEditor'), {
      url,
      protocols: ['aib-docs', 'aib-token.' + token],
      user: { name: 'You' },
      onStatus: (s) => ($('docStatus').textContent = s === 'connected' ? 'Live' : s === 'connecting' ? 'Connecting…' : 'Offline, reconnecting…'),
    });
  }
  start().catch((error) => fail(String(error && error.message || error)));
})();
