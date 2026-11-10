'use strict';
const $ = (id) => document.getElementById(id);
const host = {
  getState: () => JSON.parse(sessionStorage.getItem('agent-watch-panel') || '{}'),
  setState: (value) => sessionStorage.setItem('agent-watch-panel', JSON.stringify(value)),
  postMessage: () => {},
};
const storage = {
  getItem: (key) => (host.getState() || {})[key],
  setItem: (key, value) => host.setState({ ...host.getState(), [key]: value }),
};
let requestId = 0;
const requests = new Map();
const state = {
  provider: storage.getItem('agent-watch-provider') || 'omp',
  sessions: [],
  agents: [],
  session: '',
  agent: '',
  activity: false,
  commandView: false,
  commandId: '',
  commands: [],
  paused: false,
  busy: false,
  limit: 120,
  signature: '',
  filterSignature: '',
  lastUpdate: 0,
};
const text = (tag, value, cls) => {
  const el = document.createElement(tag);
  el.textContent = value;
  if (cls) el.className = cls;
  return el;
};
const short = (s, n = 100) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .slice(0, n);
function date(value) {
  if (value === undefined || value === null || value === '') return '';
  const d = new Date(typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : value);
  return Number.isNaN(+d)
    ? ''
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function age(seconds) {
  const n = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  return n < 60
    ? `${n}s ago`
    : n < 3600
      ? `${Math.floor(n / 60)}m ago`
      : n < 86400
        ? `${Math.floor(n / 3600)}h ago`
        : `${Math.floor(n / 86400)}d ago`;
}
let apiToken = ''; // every /api/ route needs the page token; /api/bootstrap hands it out
async function loadToken() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw Error('Reader request failed');
  apiToken = (await response.json()).token || '';
}
async function api(endpoint, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    if (!apiToken) await loadToken();
    const send = () =>
      fetch(endpoint + '?' + new URLSearchParams(params), {
        signal: controller.signal,
        headers: { 'X-Studio-Token': apiToken },
      });
    let response = await send();
    if (response.status === 403) {
      await loadToken();
      response = await send();
    }
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Reader request failed');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function status(agent) {
  if (agent.last?.kind === 'error') return ['Error recorded', 'error'];
  if (Date.now() / 1000 - agent.modified < 90) return ['Recent', 'recent'];
  if (agent.last?.kind === 'assistant') return ['Last reply saved', 'finished'];
  return ['Quiet', ''];
}
function sessionTitle(s) {
  return s.title || (s.cwd ? s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() : 'Conversation');
}
function renderAgents() {
  const box = $('agents');
  const existing = new Map([...box.children].map((node) => [node.dataset.key, node]));
  for (const [index, a] of state.agents.entries()) {
    let button = existing.get(a.key);
    if (!button) {
      button = text('button', '', 'agent-card');
      button.dataset.key = a.key;
      button.onclick = () => selectAgent(a.key);
    }
    existing.delete(a.key);
    const [label, cls] = status(a);
    button.className = `agent-card${!state.activity && a.key === state.agent ? ' selected' : ''}`;
    const title = text('div', a.name, 'card-title');
    title.append(text('span', label, `status ${cls}`));
    const meta = text('div', '', 'card-meta');
    meta.append(text('span', a.model || (a.main ? 'Parent session' : 'Subagent')), text('span', age(a.modified)));
    button.replaceChildren(
      title,
      text('div', short(a.last?.intent || a.last?.text, 150) || 'Waiting for saved messages', 'card-preview'),
      meta,
    );
    button.title = `${a.name} · Created ${date(a.created)}\n${a.key}`;
    if (box.children[index] !== button) box.insertBefore(button, box.children[index] || null);
  }
  for (const node of existing.values()) node.remove();
  $('agentCount').textContent = Math.max(0, state.agents.length - 1);
  $('activity').classList.toggle('selected', state.activity);
}
function selectAgent(key) {
  state.commandView = false;
  renderModes();
  state.agent = key;
  state.activity = false;
  storage.setItem('selection', { session: state.session, provider: state.provider, agent: state.agent });
  resetView();
  renderAgents();
  update(true);
}
function resetView() {
  state.limit = 120;
  state.signature = '';
  $('transcript').replaceChildren(text('div', 'Loading saved transcript…', 'empty'));
  $('search').value = '';
  $('follow').checked = true;
}
function heading() {
  if (state.commandView) return;
  const session = state.sessions.find((s) => s.key === state.session);
  const agent = state.agents.find((a) => a.key === state.agent);
  $('project').textContent = sessionTitle(session || {});
  $('detailTitle').textContent = state.activity ? 'Across your subagents' : agent?.name || 'Main conversation';
  $('detailEyebrow').textContent = state.activity
    ? 'COMBINED ACTIVITY'
    : agent?.main
      ? 'PARENT SESSION'
      : 'SUBAGENT TRANSCRIPT';
  $('detailSubtitle').textContent = state.activity
    ? 'Recent saved events · Click an agent name to inspect its transcript'
    : `${session?.providerName ? session.providerName + ' · ' : ''}${session?.cwd || ''}${agent?.model ? ' · ' + agent.model : ''}${agent?.last?.time ? ' · Last event ' + date(agent.last.time) : ''}`;
}
function renderEvents(data) {
  const events = data.events;
  const sig = JSON.stringify([
    state.agent,
    state.activity,
    $('search').value,
    $('filter').value,
    $('thinking').checked,
    state.limit,
    data.revision,
    events,
  ]);
  if (sig === state.signature) return;
  state.signature = sig;
  const box = $('transcript');
  const oldTop = box.scrollTop;
  const oldHeight = box.scrollHeight;
  const open = new Set([...box.querySelectorAll('details[open]')].map((e) => e.dataset.id));
  const fragment = document.createDocumentFragment();
  if (!state.activity && data.before > 0) {
    const more = text('button', `Load earlier events (${data.before.toLocaleString()} more)`, 'load-more');
    more.onclick = () => {
      state.limit += 120;
      state.loadingEarlier = true;
      $('follow').checked = false;
      state.signature = '';
      update(true);
    };
    fragment.append(more);
  }
  if (!events.length) {
    fragment.append(
      text(
        'div',
        $('search').value ? 'No matching saved events.' : 'No saved events yet. This view updates automatically.',
        'empty',
      ),
    );
  }
  for (const event of events) {
    const card = text('article', '', `event ${event.kind}`);
    const head = text('div', '', 'event-header');
    head.append(text('span', event.kind, 'badge'));
    if (event.agent) {
      const link = text('button', event.agent, 'agent-link');
      link.onclick = () => selectAgent(event.key);
      head.append(link);
    }
    head.append(text('strong', event.label || event.kind));
    const stamp = text('time', date(event.time));
    stamp.title = String(event.time || '');
    head.append(stamp);
    card.append(head);
    if (event.intent) card.append(text('div', event.intent, 'intent'));
    if (['tool', 'result', 'thinking', 'assignment'].includes(event.kind)) {
      const detail = document.createElement('details');
      detail.dataset.id = (event.key || state.agent) + event.id;
      detail.open = open.has(detail.dataset.id);
      detail.append(text('summary', short(event.text, 150) || 'View details'), text('pre', event.text));
      card.append(detail);
    } else card.append(text('pre', event.text));
    fragment.append(card);
  }
  box.replaceChildren(fragment);
  if ($('follow').checked) box.scrollTop = box.scrollHeight;
  else box.scrollTop = oldTop + (state.loadingEarlier ? box.scrollHeight - oldHeight : 0);
  state.loadingEarlier = false;
  $('eventCount').textContent = state.activity
    ? `${events.length} recent subagent events`
    : `${events.length.toLocaleString()} of ${data.total.toLocaleString()} matching events`;
  host.postMessage({
    type: 'status',
    provider: state.provider,
    session: state.session,
    agent: state.agent,
    events: events.length,
    hasConversationList: !!document.querySelector('.sessions'),
    agentOrder: state.agents.map((a) => a.key),
  });
}
async function update(force = false) {
  if (state.busy) {
    if (force) state.pending = true;
    return;
  }
  if ((state.paused && !force) || !state.session) return;
  state.busy = true;
  try {
    const list = await api('/api/sessions');
    state.sessions = list.sessions;
    if (!state.session) {
      state.agents = [];
      renderAgents();
      $('detailTitle').textContent = 'No saved chats yet';
      $('detailSubtitle').textContent = 'Chats appear when this provider saves a transcript.';
      $('transcript').replaceChildren(text('div', 'No saved conversations found for this provider.', 'empty'));
      $('eventCount').textContent = 'No conversation selected';
    }
    if (state.session) {
      const sessionAtStart = state.session;
      const roster = await api('/api/agents', { session: sessionAtStart });
      if (sessionAtStart !== state.session) return;
      state.agents = roster.agents;
      renderAgents();
      const commandData = await api('/api/commands', { session: state.session });
      state.commands = commandData.commands;
      $('runningCount').textContent = commandData.running;
      renderCommands();
      renderModes();
      if (state.commandView) {
        await showCommand();
        $('error').hidden = true;
        $('connection').textContent = state.paused ? 'Updates paused' : 'Following saved activity';
        $('connectionDot').classList.toggle('off', state.paused);
        $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
        return;
      }
      heading();
      const agentAtStart = state.agent,
        activityAtStart = state.activity;
      const params = {
        key: state.agent,
        q: $('search').value,
        kind: $('filter').value,
        thinking: $('thinking').checked ? '1' : '0',
        limit: state.limit,
      };
      const data = state.activity
        ? await api('/api/activity', { session: state.session })
        : await api('/api/transcript', params);
      if (agentAtStart !== state.agent || activityAtStart !== state.activity || sessionAtStart !== state.session)
        return;
      if (state.activity) {
        const q = $('search').value.toLowerCase();
        data.events = data.events.filter(
          (e) =>
            (!q || `${e.text} ${e.agent} ${e.label}`.toLowerCase().includes(q)) &&
            (!$('filter').value ||
              ($('filter').value === 'tools'
                ? ['tool', 'result', 'error'].includes(e.kind)
                : $('filter').value === 'errors'
                  ? e.kind === 'error'
                  : !['tool', 'result', 'error', 'thinking'].includes(e.kind))),
        );
      }
      renderEvents(data);
    }
    $('error').hidden = true;
    $('connection').textContent = state.paused ? 'Updates paused' : 'Following saved activity';
    $('connectionDot').classList.toggle('off', state.paused);
    state.lastUpdate = Date.now();
    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (error) {
    $('error').textContent = 'Unable to refresh: ' + error.message + ' · Your agent chat is unaffected.';
    $('error').hidden = false;
    $('connection').textContent = 'Disconnected · retrying';
    $('connectionDot').classList.add('off');
  } finally {
    state.busy = false;
    if (state.pending) {
      state.pending = false;
      update(true);
    }
  }
}
$('pause').onclick = () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? 'Resume updates' : 'Pause updates';
  $('connection').textContent = state.paused ? 'Updates paused' : 'Following saved activity';
  $('connectionDot').classList.toggle('off', state.paused);
  if (!state.paused) update(true);
};
$('activity').onclick = () => {
  if (!state.session) return;
  state.commandView = false;
  renderModes();
  state.activity = true;
  resetView();
  renderAgents();
  update(true);
};
$('refresh').onclick = () => update(true);

let searchTimer;
for (const id of ['search', 'filter', 'thinking']) {
  $(id).addEventListener(id === 'search' ? 'input' : 'change', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
      () => {
        state.limit = 120;
        state.signature = '';
        update(true);
      },
      id === 'search' ? 250 : 0,
    );
  });
}
$('follow').onchange = () => {
  if ($('follow').checked) $('transcript').scrollTop = $('transcript').scrollHeight;
};
$('transcript').addEventListener(
  'wheel',
  (e) => {
    if (e.deltaY < 0) $('follow').checked = false;
  },
  { passive: true },
);
setInterval(() => update(), 2000);

const route = new URLSearchParams(location.search);
state.session = route.get('session') || '';
state.provider = route.get('provider') || 'omp';
state.commandView = route.get('view') === 'commands';
renderModes();
const previous = host.getState()?.selection;
state.agent = previous?.session === state.session ? previous.agent : state.session;
if (state.session) {
  storage.setItem('selection', { session: state.session, provider: state.provider, agent: state.agent });
  update(true);
} else {
  $('detailSubtitle').textContent = 'Choose a conversation in the sidebar.';
}

function duration(task) {
  if (typeof task.durationMs === 'number') return formatDuration(task.durationMs / 1000);
  const start = Date.parse(task.started);
  const end = Date.parse(task.ended);
  if (!Number.isFinite(start)) return 'Start time unavailable';
  if (Number.isFinite(end)) return formatDuration(Math.max(0, (end - start) / 1000));
  if (['running', 'in-progress'].includes(task.status))
    return formatDuration(Math.max(0, (Date.now() - start) / 1000)) + ' elapsed';
  return 'Duration not recorded';
}
function formatDuration(seconds) {
  const n = Math.floor(seconds);
  return n < 60
    ? n + 's'
    : n < 3600
      ? Math.floor(n / 60) + 'm ' + (n % 60) + 's'
      : Math.floor(n / 3600) + 'h ' + Math.floor((n % 3600) / 60) + 'm';
}
function commandStatus(task) {
  return (
    {
      running: 'Running · last reported',
      'in-progress': 'Started · awaiting result',
      completed: 'Completed',
      failed: 'Failed',
      killed: 'Stopped',
      cancelled: 'Cancelled',
      unknown: 'No completion recorded',
    }[task.status] || task.status
  );
}
function renderModes() {
  $('listHeading').textContent = state.commandView ? 'COMMANDS' : 'AGENTS';
  $('agentCount').textContent = state.commandView ? state.commands.length : Math.max(0, state.agents.length - 1);
  $('commandsFilter').classList.toggle('hidden', !state.commandView);
  $('agentsMode').setAttribute('aria-selected', String(!state.commandView));
  $('commandsMode').setAttribute('aria-selected', String(state.commandView));
  $('agents').classList.toggle('hidden', state.commandView);
  $('commandsList').classList.toggle('hidden', !state.commandView);
  $('activity').classList.toggle('hidden', state.commandView);
  document.querySelector('.toolbar').classList.toggle('hidden', state.commandView);
}
function renderCommands() {
  const box = $('commandsList');
  const oldTop = box.scrollTop;
  const existing = new Map([...box.children].map((node) => [node.dataset.key, node]));
  const rows = state.commands.filter(
    (c) => $('commandsFilter').value === 'all' || ['running', 'in-progress'].includes(c.status),
  );
  if (!rows.some((c) => c.id === state.commandId)) state.commandId = rows[0]?.id || '';
  for (const [index, task] of rows.entries()) {
    let button = existing.get(task.id);
    if (!button) {
      button = text('button', '', 'agent-card');
      button.dataset.key = task.id;
      button.onclick = () => {
        state.commandId = task.id;
        state.signature = '';
        renderCommands();
        update(true);
      };
    }
    existing.delete(task.id);
    button.className = 'agent-card command-card' + (state.commandId === task.id ? ' selected' : '');
    const title = text('div', short(task.title, 180), 'command-title');
    const meta = text('div', '', 'card-meta');
    meta.append(text('span', task.tool + ' · ' + duration(task)));
    const badge = text('div', commandStatus(task), 'command-state ' + task.status);
    button.replaceChildren(title, badge, text('div', task.agent, 'card-preview'), meta);
    if (box.children[index] !== button) box.insertBefore(button, box.children[index] || null);
  }
  for (const node of existing.values()) node.remove();
  if (!rows.length)
    box.replaceChildren(
      text(
        'div',
        $('commandsFilter').value === 'all'
          ? 'No background commands recorded.'
          : 'No commands last reported running. Select All commands & history to inspect earlier jobs.',
        'empty',
      ),
    );
  box.scrollTop = oldTop;
}
async function showCommand() {
  $('detailEyebrow').textContent = 'BACKGROUND COMMAND';
  $('detailTitle').textContent = 'Background commands';
  $('detailSubtitle').textContent = 'Saved lifecycle events · Running means last reported, not a live process check.';
  const box = $('transcript');
  if (!state.commandId) {
    box.replaceChildren(text('div', 'Background commands will appear here when an agent launches them.', 'empty'));
    $('eventCount').textContent = 'No command selected';
    host.postMessage({
      type: 'status',
      provider: state.provider,
      session: state.session,
      commandView: true,
      events: 0,
    });
    return;
  }
  const session = state.session,
    id = state.commandId;
  const task = await api('/api/command', { session, id });
  if (session !== state.session || id !== state.commandId || !state.commandView) return;
  $('detailTitle').textContent = task.title;
  $('detailSubtitle').textContent = task.agent + ' · ' + commandStatus(task) + ' · ' + duration(task);
  const sig = JSON.stringify([id, task.output, task.status, task.command]);
  if (state.signature !== sig) {
    state.signature = sig;
    const oldTop = box.scrollTop;
    const info = text('article', '', 'event');
    const head = text('div', '', 'event-header');
    head.append(text('strong', task.tool), text('span', task.jobId || task.callId, 'badge'));
    info.append(head, text('pre', task.command));
    const meta = text(
      'div',
      `Started: ${date(task.started) || 'Not recorded'}\nFinished: ${date(task.ended) || 'Not recorded'}${task.completionSummary ? '\n' + task.completionSummary : ''}`,
      'command-metadata',
    );
    info.append(meta);
    const output = text('article', '', 'event');
    output.append(
      text('div', 'Latest saved output', 'event-header'),
      text('pre', task.output || 'No output saved yet.'),
    );
    box.replaceChildren(info, output);
    if ($('follow').checked) box.scrollTop = box.scrollHeight;
    else box.scrollTop = oldTop;
  }
  $('eventCount').textContent = state.commands.length + ' recorded background commands';
  host.postMessage({
    type: 'status',
    provider: state.provider,
    session: state.session,
    agent: state.agent,
    events: state.commands.length,
    commandView: true,
    commandId: id,
    hasConversationList: false,
  });
}
$('agentsMode').onclick = () => {
  state.commandView = false;
  state.signature = '';
  renderModes();
  update(true);
};
$('commandsMode').onclick = () => {
  state.commandView = true;
  state.signature = '';
  renderModes();
  update(true);
};

$('commandsFilter').onchange = () => {
  state.commandId = '';
  state.signature = '';
  renderCommands();
  update(true);
};
