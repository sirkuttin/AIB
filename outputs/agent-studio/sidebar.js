'use strict';
const host = {
  getState: () => JSON.parse(localStorage.getItem('agent-watch-sidebar') || '{}'),
  setState: (value) => localStorage.setItem('agent-watch-sidebar', JSON.stringify(value)),
  postMessage: () => {},
};
const saved = host.getState() || {};
let provider = saved.provider || 'omp',
  query = saved.query || '',
  selected = saved.selected || '',
  sessions = [],
  busy = false,
  nextId = 0,
  signature = '';
const pending = new Map();
const $ = (id) => document.getElementById(id);
const text = (tag, value, cls) => {
  const el = document.createElement(tag);
  el.textContent = value;
  if (cls) el.className = cls;
  return el;
};
function persist() {
  host.setState({ provider, query, selected });
}
let apiToken = ''; // every /api/ route needs the page token; /api/bootstrap hands it out
async function loadToken() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw Error('Reader unavailable');
  apiToken = (await response.json()).token || '';
}
async function request() {
  if (!apiToken) await loadToken();
  const send = () => fetch('/api/sessions', { headers: { 'X-Studio-Token': apiToken } });
  let response = await send();
  if (response.status === 403) {
    await loadToken();
    response = await send();
  }
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Reader unavailable');
  return data;
}
function startTime(s) {
  const d = new Date(s.created * 1000);
  return Number.isNaN(+d)
    ? ''
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function title(s) {
  return (s.title || s.prompt || 'Conversation started ' + startTime(s)).replace(/\s+/g, ' ').slice(0, 180);
}
function render() {
  $('omp').setAttribute('aria-selected', String(provider === 'omp'));
  $('claude').setAttribute('aria-selected', String(provider === 'claude'));
  const all = sessions.filter((s) => s.hasMessages);
  $('ompCount').textContent = all.filter((s) => s.provider === 'omp').length;
  $('claudeCount').textContent = all.filter((s) => s.provider === 'claude').length;
  $('listTitle').textContent = provider === 'omp' ? 'OMP CHATS' : 'CLAUDE CODE CHATS';
  const rows = all
    .filter(
      (s) =>
        s.provider === provider &&
        `${s.title} ${s.prompt} ${s.cwd} ${s.id}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => b.created - a.created || a.key.localeCompare(b.key));
  $('visibleCount').textContent = rows.length;
  const sig = JSON.stringify([
    provider,
    query,
    selected,
    rows.map((s) => [s.key, title(s), s.subagentCount, Date.now() / 1000 - s.modified < 90]),
  ]);
  if (sig === signature) return;
  signature = sig;
  host.postMessage({ type: 'sidebarStatus', provider, chatCount: rows.length });
  const focused = document.activeElement?.dataset?.key;
  const fragment = document.createDocumentFragment();
  for (const s of rows) {
    const button = text('button', '', `chat${s.key === selected ? ' selected' : ''}`);
    button.dataset.key = s.key;
    button.title = `${s.cwd || ''}\nStarted ${startTime(s)}\n${s.id || ''}`;
    const workspace = text('div', '', 'workspace');
    workspace.append(
      text('span', '', `dot${Date.now() / 1000 - s.modified < 90 ? ' recent' : ''}`),
      text('span', s.cwd?.split(/[\\/]/).filter(Boolean).pop() || 'Workspace', 'name'),
    );
    button.append(workspace, text('div', title(s), 'title'));
    const meta = text('div', '', 'meta');
    meta.append(
      text('span', startTime(s)),
      text('span', `${s.subagentCount || 0} agent${s.subagentCount === 1 ? '' : 's'}`, 'subagents'),
    );
    button.append(meta);
    button.onclick = () => {
      selected = s.key;
      persist();
      render();
      selectConversation(s);
    };
    fragment.append(button);
  }
  if (!rows.length)
    fragment.append(
      text(
        'div',
        query
          ? 'No conversations match your search.'
          : 'No saved chats yet. Keep using your connected agent; its chats will appear here.',
        'empty',
      ),
    );
  $('chats').replaceChildren(fragment);
  if (focused) {
    const target = [...$('chats').querySelectorAll('button')].find((e) => e.dataset.key === focused);
    target?.focus({ preventScroll: true });
  }
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const result = await request();
    sessions = result.sessions;
    render();
    $('error').hidden = true;
    $('connection').textContent = 'Read-only · Updates automatically';
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    $('connection').textContent = 'Waiting for the reader';
  } finally {
    busy = false;
  }
}
for (const name of ['omp', 'claude'])
  $(name).onclick = () => {
    provider = name;
    persist();
    render();
  };
$('search').value = query;
$('search').oninput = () => {
  query = $('search').value;
  persist();
  render();
};
render();
refresh();
setInterval(refresh, 5000);

function selectConversation(session) {
  const url = '/conversation.html?' + new URLSearchParams({ session: session.key, provider: session.provider });
  document.querySelector('#conversation').src = url;
  const title = session.title || session.cwd?.split(/[\\/]/).filter(Boolean).pop() || 'Conversation';
  document.querySelector('#currentChat').textContent = session.providerName + ' · ' + title;
  const link = document.querySelector('#openTab');
  link.href = url;
  link.classList.remove('hidden');
  history.replaceState(null, '', '/?' + new URLSearchParams({ session: session.key, provider: session.provider }));
  document.querySelector('#welcome').hidden = true;
}
const route = new URLSearchParams(location.search);
if (route.get('session')) {
  selected = route.get('session');
  provider = route.get('provider') || provider;
  persist();
  selectConversation({ key: selected, provider, providerName: provider === 'claude' ? 'Claude Code' : 'OMP' });
}
