/* Plan / task-list checklist. Folds an agent's plan updates into ONE card per turn that updates in place.
   Sources: ACP "plan" updates (live rows with .entries), Claude Code TodoWrite, the Claude desktop app's update_plan
   (full lists and advance/done/start patches) and Codex's update_plan ({plan:[{step,status}]}).
   fold(rows) is pure; card(row) builds the DOM with textContent only. */
(function (root) {
  'use strict';
  const state = (s) => {
    s = String(s || '').toLowerCase();
    return /^(completed|complete|done)$/.test(s)
      ? 'completed'
      : /^(in_progress|in-progress|active|running)$/.test(s)
        ? 'in_progress'
        : 'pending';
  };
  const clean = (list) =>
    (Array.isArray(list) ? list : [])
      .map((e) =>
        typeof e === 'string'
          ? { content: e, status: 'pending' }
          : e && typeof e === 'object'
            ? { content: String(e.content ?? e.step ?? e.title ?? e.text ?? '').trim(), status: state(e.status) }
            : null,
      )
      .filter((e) => e && e.content);
  const isPlanTool = (name) => /^TodoWrite$/i.test(String(name || '')) || /(^|__)update_plan$/.test(String(name || ''));
  /* Incremental update to the latest list; returns a new list, or null when there is nothing to change. */
  function applyPatch(base, p) {
    if (!base || !base.length || !p || typeof p !== 'object') return null;
    const list = base.map((e) => ({ ...e }));
    let changed = false;
    if (p.advance) {
      const i = list.findIndex((e) => e.status === 'in_progress');
      if (i >= 0) {
        list[i].status = 'completed';
        changed = true;
      }
      const n = list.findIndex((e) => e.status === 'pending');
      if (n >= 0) {
        list[n].status = 'in_progress';
        changed = true;
      }
    }
    if (Array.isArray(p.done))
      for (const n of p.done) {
        const e = list[Number(n) - 1];
        if (e) {
          e.status = 'completed';
          changed = true;
        }
      }
    if (Number.isInteger(p.start) && list[p.start - 1]) {
      list[p.start - 1].status = 'in_progress';
      changed = true;
    }
    return changed ? list : null;
  }
  /* {entries,raw}|{patch,raw}|null for a row. */
  function source(row) {
    if (!row) return null;
    if (row.role === 'plan' && Array.isArray(row.entries) && !row.sources)
      return { entries: clean(row.entries), raw: { entries: row.entries } };
    const call = row.role === 'tool' && row.call;
    if (!call || !isPlanTool(call.name) || !call.input || typeof call.input !== 'object') return null;
    const i = call.input,
      full = Array.isArray(i.todos)
        ? i.todos
        : Array.isArray(i.items)
          ? i.items
          : Array.isArray(i.plan)
            ? i.plan
            : null;
    const raw = { name: call.name, input: i };
    if (full) return { entries: clean(full), raw };
    if (i.advance || Array.isArray(i.done) || Number.isInteger(i.start)) return { patch: i, raw };
    return null;
  }
  /* A tool call that leaves work running after the turn: a background agent or a backgrounded command. */
  /* Only the tool's own opening line counts: output that merely mentions these words (a grep, a cat) is not a launch. */
  const BG_TEXT = /^[\s"{\[]*(?:Async agent launched|Command running in background with ID|Backgrounded as job)/i;
  function resultText(row) {
    if (row.role === 'result') return String(row.value || '');
    const r = row.call && row.call.result;
    if (r) return typeof r === 'string' ? r : String(r.text || '');
    const raw = row.raw;
    if (!raw) return '';
    const v = raw.rawOutput !== undefined ? raw.rawOutput : raw.content || '';
    if (typeof v === 'string') return v.slice(0, 4000);
    /* ACP content blocks: [{type:'content',content:{type:'text',text}}] or [{type:'text',text}]. */
    if (Array.isArray(v)) {
      const t = v
        .map(
          (b) =>
            b &&
            (typeof b.text === 'string'
              ? b.text
              : b.content && typeof b.content.text === 'string'
                ? b.content.text
                : ''),
        )
        .join('\n');
      if (t.trim()) return t.slice(0, 4000);
    }
    try {
      return JSON.stringify(v).slice(0, 4000);
    } catch {
      return '';
    }
  }
  function startsBackground(row) {
    if (!row || (row.role !== 'tool' && row.role !== 'result')) return false;
    const input = row.call && row.call.input;
    if (input && typeof input === 'object' && input.run_in_background === true) return true;
    return BG_TEXT.test(resultText(row));
  }
  /* A background agent (the Agent/Task tool, or its "Async agent launched" result), not a background command. */
  function isAgentLaunch(row) {
    if (row.role === 'tool' && row.call && /(^|__)(Agent|Task)$/.test(String(row.call.name || ''))) return true;
    return /^[\s"{\[]*Async agent launched/i.test(resultText(row));
  }
  /* The id a launch reports, so its later task-notification can close it: "agentId: x" or "...in background with ID: x". */
  function backgroundId(row) {
    const m = /agentId:\s*([\w-]+)|in background with ID:?\s*([\w-]+)/i.exec(resultText(row));
    return m ? m[1] || m[2] : '';
  }
  const userText = (row) => (typeof row.value === 'string' ? row.value : typeof row.text === 'string' ? row.text : '');
  /* Task ids a <task-notification> reports as finished (any status except running), and agents that sent their hand-back. */
  function finishedIds(row) {
    const ids = [],
      re = /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/gi;
    let m;
    const s = userText(row);
    for (const k of s.matchAll(/Successfully (?:stopped|killed) task:?\s*([\w-]+)/gi)) ids.push(k[1]);
    if (/\[Subagent hand-back\]/.test(s)) {
      const from = /<agent-message\s+from="([\w-]+)"/i.exec(s);
      if (from) ids.push(from[1]);
    }
    while ((m = re.exec(s))) {
      const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/i.exec(m[1]),
        st = /<status>\s*([^<\s]+)\s*<\/status>/i.exec(m[1]);
      if (id && !(st && /^running$/i.test(st[1]))) ids.push(id[1]);
    }
    return ids;
  }
  const checklist = (entries) =>
    entries
      .map(
        (e) =>
          '- [' +
          (e.status === 'completed' ? 'x' : ' ') +
          '] ' +
          e.content +
          (e.status === 'in_progress' ? ' (in progress)' : ''),
      )
      .join('\n');
  /* One card per turn (a turn ends at the next user message or turn-end row); the card sits where the plan first appears. */
  function fold(rows, opts) {
    const out = [];
    let cur = null,
      last = null,
      latest = null,
      step = null,
      bg = 0,
      anon = 0,
      anonCmd = 0,
      turn = 0;
    /* Background work still running, across turns: launches with an id stay open until their task-notification arrives;
     launches without one count only for the rest of their turn. */
    const open = new Map(); /* id -> the turn it was launched in */
    /* The next-step box comes after the turn's closing message, as in Claude's app: hold it until the turn ends. */
    const flush = () => {
      if (step) {
        out.push(step);
        step = null;
      }
    };
    for (const row of rows) {
      /* The transcript reader's marker for background tasks that finished mid-turn: used here, never drawn. */
      if (row.role === 'task-done') {
        for (const id of String(row.value || '').split(/\s+/)) if (id) open.delete(id);
        continue;
      }
      if (row.role === 'user' || row.role === 'turn-end') {
        flush();
        cur = null;
        bg = 0;
        anon = 0;
        anonCmd = 0;
        if (row.role === 'user') turn++;
        if (row.role === 'user') for (const id of finishedIds(row)) open.delete(id);
        out.push(row);
        continue;
      }
      /* Notices that arrive mid-turn ride along with a tool result. */
      if (row.role === 'result' || row.role === 'tool')
        for (const id of finishedIds({ value: resultText(row) })) open.delete(id);
      /* Saved transcripts keep the call (run_in_background) and its result ("...with ID: x") as two rows of one launch. */
      /* Like Claude's app, "N running tasks" counts background agents only; background commands still hold the wrap-up (bg). */
      if (startsBackground(row)) {
        const id = backgroundId(row),
          agent = isAgentLaunch(row);
        if (id && row.role === 'result' && (agent ? anon : anonCmd) > 0) {
          if (agent) {
            anon--;
            open.set(id, turn);
          } else anonCmd--;
        } else {
          bg++;
          if (agent) {
            if (id) open.set(id, turn);
            else anon++;
          } else if (!id) anonCmd++;
        }
      }
      /* The Claude desktop app's wrap-up call ticks off the whole task list without another update_plan,
      except while a background agent or command the turn started is still running: then the plan stays as it is. */
      if (row.role === 'tool' && row.call && /(^|__)ccd_turn__wrap_up$/.test(String(row.call.name || ''))) {
        /* It ticks off the latest plan, even when a message arrived mid-turn since it was set. */
        const target = cur || latest;
        if (target && bg) {
          target.running = bg;
          target.sources = [...target.sources, { name: row.call.name }];
        } else if (target) {
          target.running = 0;
          target.entries = target.entries.map((e) => ({ ...e, status: 'completed' }));
          last = target.entries;
          target.value = checklist(target.entries);
          target.sources = [...target.sources, { name: row.call.name }];
        }
        const next = nextStep(row);
        if (next) {
          flush();
          step = next;
          continue;
        }
      }
      const src = source(row);
      const entries = src ? src.entries || applyPatch(last, src.patch) : null;
      if (!entries || !entries.length) {
        out.push(row);
        continue;
      }
      last = entries;
      if (!cur) {
        if (latest) latest.running = 0;
        cur = {
          role: 'plan',
          label: 'Plan',
          time: row.time,
          turn,
          entries,
          sources: [src.raw],
          value: checklist(entries),
          ...(row.ctx ? { ctx: true } : {}),
        };
        out.push(cur);
        latest = cur;
      } else {
        cur.entries = entries;
        cur.sources = [...cur.sources, src.raw];
        cur.value = checklist(entries);
      }
    }
    flush();
    /* Like Claude's app: the first in-progress step says how many background tasks started since this plan's turn began are still running. */
    if (latest) {
      let n = 0;
      for (const t of open.values()) if (t >= latest.turn) n++;
      latest.running = n + (latest.turn === turn ? anon : 0);
    }
    if (opts && opts.live && cur) cur.active = true;
    /* Like Claude's app: in-progress steps spin only while the agent is working; otherwise they show the three dots ("in progress, waiting"). */
    if (latest && opts && opts.working) latest.active = true;
    return out;
  }
  /* The Claude desktop app's end-of-turn box (recap, one question, answer buttons) as a row of its own. */
  const ACTION_LABELS = {
    commit: 'Commit',
    create_pr: 'Create PR',
    merge: 'Merge',
    fix_ci: 'Fix CI',
    address_comments: 'Address comments',
    resolve_conflicts: 'Resolve conflicts',
    verify: 'Verify',
    archive: 'Archive',
    new_session: 'New session',
  };
  function nextStep(row) {
    const i = row.call && row.call.input;
    if (!i || typeof i !== 'object') return null;
    const recap = typeof i.recap === 'string' ? i.recap.trim() : '',
      ask = typeof i.ask === 'string' ? i.ask.trim() : '';
    if (!recap && !ask) return null;
    const actions = (Array.isArray(i.actions) ? i.actions : [])
      .map((a) => a && (a.label || ACTION_LABELS[a.action] || a.action))
      .filter((x) => typeof x === 'string' && x)
      .slice(0, 3);
    return {
      role: 'nextstep',
      label: 'Next step',
      time: row.time,
      recap,
      ask,
      actions,
      value: [recap, ask, actions.length ? '[' + actions.join('] [') + ']' : ''].filter(Boolean).join('\n\n'),
    };
  }
  function nextStepCard(row) {
    const make = (tag, value, cls) => {
      const n = document.createElement(tag);
      if (value != null) n.textContent = String(value);
      if (cls) n.className = cls;
      return n;
    };
    const box = make('article', '', 'bubble nextstep');
    const head = make('div', '', 'bubble-head');
    head.append(make('strong', 'Next step'));
    box.append(head);
    if (row.recap) box.append(make('p', row.recap, 'nextstep-recap'));
    if (row.ask) {
      box.append(make('p', row.ask, 'nextstep-ask'));
      if (row.actions && row.actions.length) {
        const btns = make('div', '', 'nextstep-actions');
        row.actions.forEach((label, n) => {
          const b = make('button', label, 'nextstep-btn' + (n === 0 ? ' primary' : ''));
          b.type = 'button';
          b.disabled = true;
          b.title = 'Answer in the app this chat is running in';
          btns.append(b);
        });
        box.append(btns, make('p', 'Answer in the app this chat is running in.', 'nextstep-note'));
      }
    }
    return box;
  }
  const counts = (entries) => ({ done: entries.filter((e) => e.status === 'completed').length, total: entries.length });
  function card(row) {
    const make = (tag, value, cls) => {
      const n = document.createElement(tag);
      if (value != null) n.textContent = String(value);
      if (cls) n.className = cls;
      return n;
    };
    const entries = row.entries || [],
      c = counts(entries),
      box = make('article', '', 'bubble plan');
    const head = make('div', '', 'bubble-head');
    head.append(make('strong', 'Plan'), make('span', c.done + '/' + c.total + ' done', 'plan-count'));
    const list = make('ul', '', 'plan-list');
    for (const e of entries) {
      const li = make('li', '', 'plan-item plan-' + e.status),
        mark = make('span', '', 'plan-mark');
      if (e.status === 'completed') mark.textContent = '✓';
      else if (e.status === 'in_progress') mark.className = 'plan-mark plan-' + (row.active ? 'spin' : 'dot');
      else mark.className = 'plan-mark plan-pend';
      const label = { completed: 'done', in_progress: 'in progress', pending: 'pending' }[e.status];
      li.append(mark, make('span', label, 'sr-only'), make('span', e.content, 'plan-text'));
      if (row.running && e.status === 'in_progress' && e === entries.find((x) => x.status === 'in_progress'))
        li.append(make('span', row.running + (row.running === 1 ? ' running task' : ' running tasks'), 'plan-note'));
      list.append(li);
    }
    /* Like Claude's app: just the checklist, no raw tool-call details. */
    box.append(head, list);
    return box;
  }
  root.PlanUI = { fold, card, nextStep, nextStepCard, applyPatch, source, clean, state, checklist, isPlanTool };
  if (typeof module !== 'undefined') module.exports = root.PlanUI;
})(typeof window !== 'undefined' ? window : globalThis);
