'use strict';
/* Activity pane subagent list: Working vs Finished groups, names, state, and cheap re-render. Pure DOM via textContent. */
(function (root) {
  const RUNNING = /^(running|working|in[-_ ]progress|active|starting|queued|busy|streaming)$/i;
  const GENERIC = /^Subagent [0-9a-f]{8}$/;
  const first = (v) =>
    typeof v === 'string' && v.trim() ? v.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').slice(0, 120) : '';
  const stateText = (raw) => {
    const v =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? (raw.state ?? raw.status ?? raw.phase ?? raw.name ?? '')
          : '';
    return String(v || '').trim();
  };
  const LABELS = {
    running: 'Working',
    working: 'Working',
    active: 'Working',
    busy: 'Working',
    streaming: 'Working',
    'in-progress': 'Working',
    in_progress: 'Working',
    'in progress': 'Working',
    starting: 'Starting',
    queued: 'Queued',
    idle: 'Idle',
    completed: 'Completed',
    complete: 'Completed',
    failed: 'Failed',
    error: 'Failed',
    cancelled: 'Stopped',
    canceled: 'Stopped',
    stopped: 'Stopped',
    killed: 'Stopped',
    interrupted: 'Interrupted',
  };
  /* kind: working | probable | failed | completed | idle | stopped. group: working | finished. */
  function classify(a) {
    if (a.live) {
      const s = stateText(a.state),
        l = s.toLowerCase();
      if (RUNNING.test(s)) return { group: 'working', kind: 'working', label: LABELS[l] || 'Working' };
      if (/^(failed|error)$/.test(l)) return { group: 'finished', kind: 'failed', label: 'Failed' };
      if (/^(cancelled|canceled|stopped|killed|interrupted)$/.test(l))
        return { group: 'finished', kind: 'stopped', label: l === 'interrupted' ? 'Interrupted' : 'Stopped' };
      /* The agent's own word on how the work ended (subagents RFD form: {state: 'idle', stopReason}): a child the agent stopped is
         Stopped, one that ended on an error Failed. */
      const why = a.state && typeof a.state === 'object' ? String(a.state.stopReason || '').toLowerCase() : '';
      if (/^(cancelled|canceled)$/.test(why)) return { group: 'finished', kind: 'stopped', label: 'Stopped' };
      if (why === 'error') return { group: 'finished', kind: 'failed', label: 'Failed' };
      if (/^(completed|complete)$/.test(l)) return { group: 'finished', kind: 'completed', label: 'Completed' };
      return { group: 'finished', kind: 'idle', label: LABELS[l] || s || 'Idle' };
    }
    if (a.failed) return { group: 'finished', kind: 'failed', label: 'Failed' };
    if (a.finished === true || a.completedMarker) return { group: 'finished', kind: 'completed', label: 'Completed' };
    if (a.active && a.finished !== true) return { group: 'working', kind: 'probable', label: 'Probably running' };
    return { group: 'finished', kind: 'idle', label: a.finished === false ? 'Not marked finished' : 'Ended' };
  }
  function names(a) {
    const id = String(a.agentId || a.key || '')
      .replace(/^.*[\\/]agent-/, '')
      .replace(/\.jsonl$/, '');
    const t = first(a.title) || first(a.name),
      d = first(a.description),
      type = first(a.agentType);
    const typeLike = (s) => !!s && (s === type || /^[\w.-]+$/.test(s));
    let title,
      kind = type;
    if (t && !GENERIC.test(t) && t !== id) {
      if (d && d !== t && typeLike(t)) {
        title = d;
        kind = kind || t;
      } else title = t;
    } else title = d || first(a.firstPrompt) || t || 'Subagent ' + id.slice(0, 8);
    if (kind === title) kind = '';
    return {
      title,
      type: kind,
      id,
      tip: [
        title,
        kind && 'Type: ' + kind,
        id && 'Id: ' + id,
        a.description && first(a.description) !== title && 'Task: ' + String(a.description).trim().slice(0, 300),
        a.result && 'Result: ' + String(a.result).replace(/\s+/g, ' ').slice(0, 200),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  function span(secs) {
    if (!(secs >= 0)) return '';
    if (secs < 60) return '<1m';
    const m = Math.floor(secs / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    return Math.floor(h / 24) + 'd';
  }
  /* ---- model, tokens and what a helper is doing ---------------------------------------------------------------------------- */
  const chips = () => root.AgentComposerChips || null;
  const friendly = (id) =>
    chips() && chips().friendlyModel ? chips().friendlyModel(id) : String(id == null ? '' : id).slice(0, 60);
  const parse = (id) => (chips() && chips().parseModel ? chips().parseModel(id) : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  /* The friendly model name (the composer chip's names): the helper's own model, else the chat's. A family alone ("opus") borrows
     the chat's version when the chat runs the same family; "inherit" / "default" mean the chat's model. Unknown → ''. */
  function modelName(own, chat) {
    const o = str(own),
      c = str(chat);
    const usable = (m) => !!m && !/^(inherit|default)\b/i.test(m);
    if (usable(o)) {
      const po = parse(o),
        pc = parse(c);
      if (po && !po.version && pc && pc.family === po.family && pc.version) return friendly(c);
      return friendly(o);
    }
    return usable(c) ? friendly(c) : '';
  }
  /* "842 tokens", "4.2k tokens", "198k tokens", "1.3M tokens"; '' when unknown or zero (never "0 tokens"). */
  function tokensText(n) {
    n = Number(n);
    if (!(n > 0) || !Number.isFinite(n)) return '';
    const t = (v, unit) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + unit;
    if (n < 1000) return Math.round(n) + ' tokens';
    if (n < 999500) return t(n / 1000, 'k') + ' tokens';
    return t(n / 1e6, 'M') + ' tokens';
  }
  const base = (p) =>
    String(p || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop();
  const oneLine = (v) =>
    String(v || '')
      .replace(/\s+/g, ' ')
      .trim();
  /* What one tool call is doing, in a few words: "Running: deno test x.ts", "Editing chat.js", "Reading a.md", "Searching: foo". */
  function activityOf(call) {
    const c = call && typeof call === 'object' ? call : {},
      input = c.rawInput && typeof c.rawInput === 'object' ? c.rawInput : {},
      title = oneLine(String(c.title || '').replace(/`/g, '')),
      name = str(c._meta && c._meta.claudeCode && c._meta.claudeCode.toolName),
      loc = Array.isArray(c.locations) ? c.locations.find((l) => l && typeof l.path === 'string' && l.path) : null,
      path = str(input.file_path) || str(input.path) || str(input.notebook_path) || (loc && loc.path) || '';
    const cmd = Array.isArray(input.command) ? input.command.join(' ') : str(input.command) || str(input.cmd);
    let kind = String(c.kind || '');
    if (!kind || kind === 'other') {
      if (cmd) kind = 'execute';
      else if (/^(edit|multiedit|write|notebookedit)$/i.test(name)) kind = 'edit';
      else if (/^read$/i.test(name)) kind = 'read';
      else if (/^(grep|glob|search)$/i.test(name)) kind = 'search';
    }
    if (kind === 'execute') return 'Running: ' + oneLine(cmd || title.replace(/^(run|bash|shell)\s*:?\s*/i, ''));
    if (kind === 'edit')
      return (/^write$/i.test(name) ? 'Writing ' : 'Editing ') + (base(path) || title.replace(/^(edit|write)\s+/i, ''));
    if (kind === 'read') return 'Reading ' + (base(path) || title.replace(/^read\s+/i, ''));
    if (kind === 'delete') return 'Deleting ' + (base(path) || title);
    if (kind === 'search') return 'Searching: ' + oneLine(str(input.pattern) || str(input.query) || title);
    if (kind === 'fetch') return 'Fetching ' + oneLine(str(input.url) || str(input.query) || title);
    if (kind === 'think' && !title) return 'Thinking';
    return title || name;
  }
  const TOKENS_RE = /total[_ ]?tokens["'\s]*[:=>]\s*["']?(\d+)|totalTokens["'\s]*[:=]\s*(\d+)/i;
  function usageTotal(u) {
    if (!u || typeof u !== 'object') return 0;
    let n = 0;
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'])
      if (Number.isInteger(u[k]) && u[k] > 0) n += u[k];
    return n;
  }
  /* Tokens a value reports: totalTokens / total_tokens / tokens / usage{…}, or "total_tokens: N" in text. 0 = unknown. */
  function tokensIn(v, depth) {
    const d = depth || 0;
    if (v == null || d > 3) return 0;
    if (typeof v === 'string') {
      const m = TOKENS_RE.exec(v);
      return m ? Number(m[1] || m[2]) || 0 : 0;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        const n = tokensIn(x, d + 1);
        if (n) return n;
      }
      return 0;
    }
    if (typeof v !== 'object') return 0;
    for (const k of ['totalTokens', 'total_tokens', 'tokens'])
      if (typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] > 0) return v[k];
    const u = usageTotal(v.usage);
    if (u) return u;
    for (const k of ['text', 'content', 'toolResponse', 'rawOutput', 'output', 'result'])
      if (k in v) {
        const n = tokensIn(v[k], d + 1);
        if (n) return n;
      }
    return 0;
  }
  const textOf = (u) => {
    const c = u && u.content;
    if (typeof c === 'string') return c;
    if (c && typeof c.text === 'string') return c.text;
    if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('');
    return '';
  };
  const ownModel = (u) => {
    const meta = (u && u._meta) || {};
    return str(u && u.model) || str(meta.model) || str(meta.claudeCode && meta.claudeCode.model);
  };
  /* A child session's config_option_update (claude-agent-acp's subagent form): {model, agentType}. The model option's current
     choice by its shown name ("Sonnet 5.5") when that names a model, else its value ("sonnet"). */
  function configFacts(u) {
    const out = {};
    for (const o of Array.isArray(u && u.configOptions) ? u.configOptions : []) {
      if (!o || typeof o !== 'object') continue;
      const value = str(o.currentValue);
      if (!value) continue;
      if (o.id === 'model' || o.category === 'model') {
        const pick = (Array.isArray(o.options) ? o.options : []).find((x) => x && x.value === o.currentValue);
        const name = str(pick && pick.name);
        out.model = name && parse(name) ? name : value;
      } else if (o.id === 'agent') out.agentType = value;
    }
    return out;
  }
  /* Model ids the chat's turns report spending on (turn_end usage: _meta.quota.model_usage[].model), newest last. */
  function spentModels(e) {
    const q = e && e.data && e.data._meta && e.data._meta.quota;
    return (Array.isArray(q && q.model_usage) ? q.model_usage : []).map((m) => str(m && m.model)).filter(Boolean);
  }
  /* Per child session: {model, tokens, activity, agentType, toolUseId} from a live chat's recorded updates. Sources: the parent's
     Agent / Task tool call (input model + subagent_type; its result's totalTokens / usage), the subagent_update itself (model, usage,
     the tool use it belongs to), the parent's <task-notification> (total_tokens), and the child's own updates (its latest tool call or
     message is what it is doing; usage_update.used is its token count so far). Unknown parts are left out. */
  function details(events, mainSid) {
    const tools = new Map(), // parent tool call id -> {input, tokens, agentId}
      link = new Map(), // child -> parent tool call id
      notes = new Map(), // task id / tool use id / agent id -> total tokens
      own = new Map(); // child -> facts from the child itself or its subagent_update
    const facts = (id) => {
      if (!own.has(id)) own.set(id, {});
      return own.get(id);
    };
    const spent = []; // model ids with a version, from the chat's turn results
    for (const e of events || []) {
      if (e && e.kind === 'turn_end') for (const m of spentModels(e)) if (parse(m) && parse(m).version) spent.push(m);
      if (!e || e.kind !== 'update' || !e.data) continue;
      const u = e.data.update || {},
        sid = e.data.sessionId,
        kind = u.sessionUpdate,
        cc = (u._meta && u._meta.claudeCode) || {};
      if (kind === 'subagent_update') {
        const sub = u.subagent && typeof u.subagent === 'object' ? u.subagent : u;
        const id = str(sub.sessionId) || str(sub.subagentSessionId);
        if (!id || id === mainSid) continue;
        const f = facts(id),
          scc = (sub._meta && sub._meta.claudeCode) || {},
          use = str(sub.toolCallId) || str(sub.toolUseId) || str(scc.toolUseId) || str(scc.parentToolUseId);
        if (use) link.set(id, use);
        const m = ownModel(sub);
        if (m) f.model = m;
        const t =
          tokensIn({ usage: sub.usage, tokens: sub.tokens, totalTokens: sub.totalTokens }) || tokensIn(sub._meta);
        if (t) f.tokens = t;
        continue;
      }
      if (sid && mainSid && sid !== mainSid) {
        const f = facts(sid);
        if (str(cc.parentToolUseId) && !link.has(sid)) link.set(sid, cc.parentToolUseId);
        const m = ownModel(u);
        if (m) f.model = m;
        if (kind === 'config_option_update') {
          const c = configFacts(u);
          if (c.model) f.configModel = c.model;
          if (c.agentType) f.agentType = c.agentType;
          continue;
        }
        if (kind === 'tool_call' || (kind === 'tool_call_update' && u.toolCallId === f.toolId)) {
          if (kind === 'tool_call' || !f.call) f.call = {};
          for (const k of ['title', 'kind', 'rawInput', 'locations', '_meta']) if (u[k] != null) f.call[k] = u[k];
          f.toolId = u.toolCallId;
          const a = activityOf(f.call);
          if (a) f.activity = a;
          f.msg = '';
          f.thinking = false;
        } else if (kind === 'agent_message_chunk') {
          f.msg = (f.msg || '') + textOf(u);
          f.thinking = false;
          const line = oneLine(f.msg);
          if (line) f.activity = line.slice(0, 200);
        } else if (kind === 'agent_thought_chunk') {
          if (!f.thinking) f.activity = 'Thinking';
          f.thinking = true;
          f.msg = '';
        } else if (kind === 'usage_update' && Number(u.used) > 0) f.used = Number(u.used);
        continue;
      }
      // The parent's own updates.
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = str(u.toolCallId);
        if (!id) continue;
        const name = str(cc.toolName) || str(u.title),
          input = u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : null;
        if (!tools.has(id) && !/(^|__)(agent|task)$/i.test(name) && !(input && 'subagent_type' in input)) continue;
        const rec = tools.get(id) || {};
        if (input && Object.keys(input).length) rec.input = Object.assign({}, rec.input, input);
        const out = cc.toolResponse != null ? cc.toolResponse : u.rawOutput;
        const t = tokensIn(out) || (kind === 'tool_call_update' ? tokensIn(u.content) : 0);
        if (t) rec.tokens = t;
        const aid = /agentId["'\s:\\]*([\w-]{6,})/.exec(JSON.stringify(out == null ? '' : out).slice(0, 4000));
        if (aid) rec.agentId = aid[1];
        tools.set(id, rec);
      } else if (/^(user|agent)_message(_chunk)?$/.test(String(kind))) {
        const s = textOf(u);
        if (!/<task-notification/i.test(s)) continue;
        for (const m of s.matchAll(/<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/gi)) {
          const t = tokensIn(m[1]);
          if (!t) continue;
          for (const tag of ['task-id', 'tool-use-id', 'agent-id']) {
            const hit = new RegExp('<' + tag + '>\\s*([^<\\s]+)\\s*</' + tag + '>', 'i').exec(m[1]);
            if (hit) notes.set(hit[1], t);
          }
        }
      }
    }
    const result = new Map();
    for (const [id, f] of own) {
      const use = link.get(id),
        tool = (use && tools.get(use)) || {},
        input = tool.input || {},
        d = {};
      /* The model the helper runs: what its own session reports (its config's model choice, a model id on its updates), else the
         Agent call's `model` input. A family alone ("sonnet") takes the version the chat's turns report spending on that family. */
      let model = f.configModel || f.model || str(input.model);
      const pm = model && parse(model);
      if (pm && !pm.version) {
        const full = spent.filter((s) => parse(s).family === pm.family).pop();
        if (full) model = full;
      }
      if (model) d.model = model;
      const type = str(input.subagent_type) || str(f.agentType);
      if (type) d.agentType = type;
      const tokens =
        f.tokens ||
        notes.get(id) ||
        (use && notes.get(use)) ||
        (tool.agentId && notes.get(tool.agentId)) ||
        tool.tokens ||
        f.used;
      if (tokens) d.tokens = tokens;
      if (f.activity) d.activity = f.activity;
      if (use) d.toolUseId = use;
      result.set(id, d);
    }
    return result;
  }
  function nest(list) {
    const ids = new Map(list.filter((i) => i.agentId).map((i) => [i.agentId, i])),
      kids = new Map(),
      roots = [];
    for (const i of list) {
      const p = i.parentId && i.parentId !== i.agentId ? ids.get(i.parentId) : null;
      if (p) {
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(i);
      } else roots.push(i);
    }
    const out = [],
      seen = new Set();
    const walk = (i, d) => {
      if (seen.has(i)) return;
      seen.add(i);
      i.depth = Math.min(d, 3);
      out.push(i);
      for (const k of kids.get(i) || []) walk(k, d + 1);
    };
    roots.forEach((r) => walk(r, 0));
    list.forEach((i) => walk(i, 0));
    return out;
  }
  /* What a working helper is doing now: its latest tool call or message (live), or the last thing its saved transcript says. */
  function doing(a) {
    const s = str(a.activity) || (a.live ? '' : str(a.last && (a.last.text || a.last.intent)));
    return s ? oneLine(s).slice(0, 200) : '';
  }
  /* The words of the background line: the send menu's one copy table (send-menu-ui.js), the same as on a command's row. */
  const BACKGROUND_TEXT = () =>
    (root.AgentSendMenu && root.AgentSendMenu.COPY && root.AgentSendMenu.COPY.bgRunning) || 'Still running in the background';
  /* The outcome a finished line names; '' for a normal finish (Done) so only the exceptions show. */
  const OUTCOME = { failed: 'Failed', stopped: 'Stopped' };
  function model(rows, now, chatModel) {
    const items = rows.map((a) => {
      const c = classify(a),
        n = names(a);
      const start = Number(a.created) || 0;
      const end = a.live ? Number(a.since) || Number(a.created) || 0 : Number(a.modified) || 0;
      const ago = end ? span(now - end) : '';
      const ran = start && end >= start ? span(end - start) : '';
      const modelText = modelName(a.model, chatModel),
        tokens = tokensText(a.tokens),
        activity = c.group === 'working' ? doing(a) : '',
        /* went on in the background after a steer (Claude Code): its card says so; no Stop, it runs inside the agent's process */
        background = c.group === 'working' && a.background === true,
        outcome = c.group === 'finished' ? (c.kind === 'stopped' ? c.label : OUTCOME[c.kind] || '') : '';
      const when =
        c.group === 'working'
          ? start
            ? 'running ' + span(now - start)
            : ''
          : ago
            ? ago === '<1m'
              ? 'just now'
              : ago + ' ago'
            : '';
      const cmds = Math.max(0, Number(a.runningCommands) || 0);
      return {
        a,
        key: String(a.key),
        agentId: String(a.agentId || ''),
        parentId: String(a.parentAgentId || ''),
        depth: 0,
        cmds,
        group: c.group,
        kind: c.kind,
        label: c.label,
        title: n.title,
        type: n.type,
        tip: [
          n.tip,
          modelText && 'Model: ' + modelText + (str(a.model) ? '' : ' (the chat’s model)'),
          tokens && 'Tokens: ' + tokens.replace(/ tokens$/, ''),
          c.group === 'finished' && ran && 'Ran ' + ran + (when ? ', finished ' + when : ''),
          activity && 'Now: ' + activity,
        ]
          .filter(Boolean)
          .join('\n'),
        when,
        ran,
        modelText,
        tokens,
        activity,
        background,
        outcome,
        source: a.live ? 'live' : 'saved',
        end,
        start,
      };
    });
    const by = (x, y) => y.start - x.start || x.key.localeCompare(y.key);
    const fin = items
      .filter((i) => i.group === 'finished')
      .sort((x, y) => (y.kind === 'failed') - (x.kind === 'failed') || y.end - x.end || x.key.localeCompare(y.key));
    /* top = working then failed (the always-visible list); done = the other finished rows (collapsed by default). */
    const top = nest(
      items
        .filter((i) => i.group === 'working')
        .sort(by)
        .concat(fin.filter((i) => i.kind === 'failed')),
    );
    const done = nest(fin.filter((i) => i.kind !== 'failed'));
    const working = top.filter((i) => i.group === 'working'),
      failedRows = top.filter((i) => i.kind === 'failed');
    return {
      top,
      done,
      working,
      finished: failedRows.concat(done),
      failed: failedRows.length,
      cmds: items.reduce((n, i) => n + i.cmds, 0),
    };
  }
  /* Section heading qualifier: "2 working · 1 failed". */
  function sectionHeading(m) {
    return m.working.length + ' working · ' + m.failed + ' failed';
  }
  function heading(m) {
    return m.working.length + ' working · ' + m.finished.length + ' finished';
  }
  /* Slim counts strip: "2 working · 1 failed · 1 cmd". Zero parts are left out. */
  function strip(m, cmdCount) {
    const parts = [];
    if (m.working.length) parts.push(m.working.length + ' working');
    if (m.failed) parts.push(m.failed + ' failed');
    const c = cmdCount == null ? m.cmds : cmdCount;
    if (c) parts.push(c + (c === 1 ? ' cmd' : ' cmds'));
    return parts.length ? parts.join(' · ') : m.finished.length ? m.finished.length + ' finished' : 'No activity';
  }
  /* Drawer header facts for one subagent row: name, type, state and how long it has run. */
  function header(a, now, chatModel) {
    const c = classify(a),
      n = names(a),
      start = Number(a.created) || 0;
    const end = c.group === 'working' ? now : a.live ? Number(a.since) || now : Number(a.modified) || now;
    const d = start ? span(Math.max(0, end - start)) : '';
    return {
      title: n.title,
      type: n.type,
      model: modelName(a.model, chatModel),
      tokens: tokensText(a.tokens),
      state: c.label,
      kind: c.kind,
      group: c.group,
      duration: d,
      cmds: Math.max(0, Number(a.runningCommands) || 0),
    };
  }
  /* Inspector subtitle: "Opus 5.5 · general-purpose · Working · 2m · 198k tokens · live"; unknown parts are left out. */
  function subtitle(h, live) {
    return [h.model, h.type, h.state, h.duration, h.tokens, live ? 'live' : 'saved transcript']
      .filter(Boolean)
      .join(' · ');
  }
  /* Direct children of one agent among all rows (matches parentAgentId to agentId). */
  function childrenOf(rows, a) {
    const id = a && a.agentId;
    return id ? rows.filter((r) => r !== a && r.parentAgentId === id) : [];
  }
  const storeKey = (k) => 'studio-subagents-finished:' + k;
  function expanded(convKey) {
    try {
      return localStorage.getItem(storeKey(convKey)) === '1';
    } catch (e) {
      return false;
    }
  }
  function remember(convKey, open) {
    try {
      localStorage.setItem(storeKey(convKey), open ? '1' : '0');
    } catch (e) {}
  }
  let lastSignature = '',
    lastBox = null;
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  /* A working helper is a card: line 1 dot, name, optional "1 cmd" chip, run time; line 2 model · type with tokens on the right;
     line 3 what it is doing now (only when known). A finished helper is one 28 px line: dot, name, outcome when it is not a normal
     finish (Failed / Stopped / Interrupted), short model, run time. State and tokens of finished lines live in the tooltip. */
  function card(i, ctx) {
    const b = el(
      'button',
      'subagent-card sa-card sa-' +
        i.group +
        ' sa-' +
        i.kind +
        (i.group === 'working' ? ' sa-big' : '') +
        (ctx.selectedKey === i.key ? ' selected' : ''),
    );
    b.type = 'button';
    b.dataset.key = i.key;
    b.title = i.tip + '\n' + i.label + (i.source === 'saved' ? ' (from saved events)' : '');
    b.onclick = () => ctx.onOpen(i.a);
    if (i.depth) b.style.setProperty('--depth', i.depth);
    const cmd = i.cmds ? el('span', 'sa-cmd', i.cmds + (i.cmds === 1 ? ' cmd' : ' cmds')) : null;
    if (i.group === 'working') {
      const l1 = el('span', 'sa-line sa-l1');
      l1.append(el('span', 'sa-dot'), el('strong', 'sa-title', i.title));
      if (cmd) l1.append(cmd);
      if (i.when) l1.append(el('span', 'sa-when', i.when));
      b.append(l1);
      const meta = [i.modelText, i.type].filter(Boolean).join(' · ');
      if (meta || i.tokens) {
        const l2 = el('span', 'sa-line sa-l2');
        l2.append(el('span', 'sa-meta', meta));
        if (i.tokens) l2.append(el('span', 'sa-tokens', i.tokens));
        b.append(l2);
      }
      if (i.activity) b.append(el('span', 'sa-line sa-l3 sa-doing', i.activity));
      if (i.background) b.append(el('span', 'sa-line sa-l3 sa-bg', BACKGROUND_TEXT()));
      return b;
    }
    b.append(el('span', 'sa-dot'), el('strong', 'sa-title', i.title));
    if (cmd) b.append(cmd);
    if (i.outcome) b.append(el('span', 'sa-outcome', i.outcome));
    if (i.modelText) b.append(el('span', 'sa-model', i.modelText));
    if (i.ran) b.append(el('span', 'sa-when', i.ran));
    return b;
  }
  function render(ctx) {
    const m = model(ctx.rows, ctx.now, ctx.chatModel),
      open = expanded(ctx.convKey);
    if (ctx.countEl) ctx.countEl.textContent = ctx.rows.length ? sectionHeading(m) : '0';
    if (ctx.onModel) ctx.onModel(m);
    const sig = JSON.stringify([
      ctx.convKey,
      ctx.empty,
      ctx.selectedKey,
      open,
      [...m.top, ...m.done].map((i) => [
        i.key,
        i.group,
        i.kind,
        i.label,
        i.title,
        i.type,
        i.when,
        i.tip,
        i.cmds,
        i.depth,
        i.ran,
        i.modelText,
        i.tokens,
        i.activity,
        i.background,
        i.outcome,
      ]),
    ]);
    if (sig === lastSignature && ctx.box === lastBox && ctx.box.firstChild) return;
    lastSignature = sig;
    lastBox = ctx.box;
    const box = ctx.box,
      focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null,
      focusKey = focus?.dataset?.key,
      focusToggle = focus?.classList?.contains('sa-toggle');
    const tops = [...box.querySelectorAll('.sa-scroll')].map((n) => n.scrollTop);
    const frag = document.createDocumentFragment();
    const h = el('h4', 'sa-heading', 'Subagents');
    if (ctx.rows.length) {
      const q = el('span', 'sa-qualifier', m.working.length + ' working · ');
      q.append(el('span', m.failed ? 'sa-failed-count' : '', m.failed + ' failed'));
      h.append(q);
    }
    const hideBtn = document.getElementById('activityHide');
    if (hideBtn) h.append(hideBtn);
    frag.append(h);
    if (!ctx.rows.length) frag.append(el('p', 'empty-state sa-empty', ctx.empty));
    else {
      const list = el('div', 'sa-scroll');
      for (const i of m.top) list.append(card(i, ctx));
      if (!m.top.length && !m.done.length) list.append(el('p', 'sa-none', 'Nothing running right now.'));
      if (m.done.length) {
        const t = el('button', 'sa-toggle sa-card');
        t.type = 'button';
        t.setAttribute('aria-expanded', open ? 'true' : 'false');
        t.setAttribute('aria-label', m.done.length + ' finished subagents, ' + (open ? 'hide' : 'show'));
        t.append(el('span', 'sa-caret', open ? '▾' : '▸'), el('span', 'sa-title', m.done.length + ' finished'));
        t.onclick = () => {
          remember(ctx.convKey, !open);
          lastSignature = '';
          ctx.rerender();
        };
        list.append(t);
        if (open) for (const i of m.done) list.append(card(i, ctx));
      }
      frag.append(list);
    }
    box.replaceChildren(frag);
    box.querySelectorAll('.sa-scroll').forEach((n, k) => {
      if (tops[k]) n.scrollTop = tops[k];
    });
    if (focusToggle) box.querySelector('.sa-toggle')?.focus();
    else if (focusKey)
      for (const n of box.querySelectorAll('.subagent-card'))
        if (n.dataset.key === focusKey) {
          n.focus();
          break;
        }
  }
  /* Live-child bookkeeping used by chat.js collectChildren. */
  function enrich(next, old, child, time) {
    const t = typeof child.title === 'string' && child.title.trim() ? child.title.trim() : '';
    if (t) next.title = t;
    const ty = child.agentType || child.subagentType || child.subagent_type;
    if (typeof ty === 'string' && ty.trim()) next.agentType = ty.trim();
    if (!old || stateText(old.state) !== stateText(next.state) || !next.since) next.since = time;
  }
  function noteEvent(c, e) {
    if (!c || c.firstPrompt) return;
    const u = e.data?.update;
    if (u?.sessionUpdate === 'user_message_chunk' && typeof u.content?.text === 'string' && u.content.text.trim())
      c.firstPrompt = u.content.text.trim().slice(0, 300);
  }
  root.SubagentsUI = {
    classify,
    names,
    model,
    heading,
    sectionHeading,
    strip,
    header,
    childrenOf,
    nest,
    render,
    enrich,
    noteEvent,
    span,
    stateText,
    modelName,
    tokensText,
    activityOf,
    details,
    subtitle,
  };
  if (typeof module === 'object' && module.exports) module.exports = root.SubagentsUI;
})(typeof window !== 'undefined' ? window : globalThis);
