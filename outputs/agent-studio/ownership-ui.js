/* Ownership evidence UI: sidebar hints, header hint and the "Continue anyway" confirmation.
   Every string from the server (process names, client names, paths) is set with textContent only. */
(() => {
  'use strict';
  const doc = () => window.document || document;
  const make = (tag, content, className) => {
    const node = doc().createElement(tag);
    if (content !== undefined && content !== null && content !== '') node.textContent = String(content);
    if (className) node.className = className;
    return node;
  };
  const NO_PROOF = 'No other app was detected using this conversation, but Studio cannot prove it is free.';
  // Shown instead of NO_PROOF when part of the check cannot run on this system, so "nothing found" is never implied.
  const UNKNOWN = "Can't tell if this chat is open elsewhere on this system.";
  const BADGE = { owned_elsewhere: 'In use elsewhere', possibly_active: 'May be active elsewhere' };

  function reasonTexts(ownership) {
    return (ownership && Array.isArray(ownership.reasons) ? ownership.reasons : [])
      .map((r) => (r && typeof r.text === 'string' ? r.text : ''))
      .filter(Boolean);
  }

  // Small badge appended to a sidebar row status line. Rows without evidence get nothing.
  function decorateRow(box, hint) {
    if (!box || !hint || !BADGE[hint.verdict]) return;
    const badge = make('span', BADGE[hint.verdict], 'badge badge-ownership badge-ownership-' + hint.verdict);
    const detail = reasonTexts(hint)[0];
    if (detail) badge.title = detail;
    box.append(make('span', ' ', ''), badge);
  }

  // One line under the conversation title. Hidden while the conversation is live in this Studio.
  const dismissed = new Set();
  const hintKey = (conversation, verdict) =>
    (conversation && conversation.provider + ':' + conversation.id) + '|' + verdict;
  // The user closed the bar for this conversation and verdict; a different verdict shows it again.
  function dismissHint(conversation, box) {
    const verdict = box && box.getAttribute ? box.getAttribute('data-verdict') : '';
    if (conversation && verdict) dismissed.add(hintKey(conversation, verdict));
    if (box) box.hidden = true;
  }

  // certainty: the server's list-wide answer to "what does no hint mean here" ('unknown' | 'checked'); a hint that is itself an
  // assessment (verdict no_evidence + certainty) carries its own and wins. With evidence the verdict is shown, whatever the certainty.
  function renderHint(box, conversation, connected, hint, certainty) {
    if (!box) return;
    if (!conversation || connected) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    let verdict = hint && BADGE[hint.verdict] ? hint.verdict : 'no_evidence';
    if (verdict === 'no_evidence' && ((hint && hint.certainty) || certainty) === 'unknown') verdict = 'unknown';
    box.hidden = dismissed.has(hintKey(conversation, verdict));
    box.setAttribute('data-verdict', verdict);
    box.className = 'ownership-hint ownership-' + verdict;
    box.title = '';
    if (verdict === 'unknown') {
      box.textContent = UNKNOWN;
      return;
    }
    if (verdict === 'no_evidence') {
      box.textContent = NO_PROOF;
      return;
    }
    const first = reasonTexts(hint)[0] || '';
    box.textContent = (verdict === 'owned_elsewhere' ? 'In use elsewhere. ' : 'May be active in another app. ') + first;
    box.title = box.textContent;
  }

  let dismissCurrent = null;
  // Closes any open evidence card (declining it). Used when the user selects another conversation.
  function clear(box) {
    if (dismissCurrent) dismissCurrent(false);
    if (box) {
      box.hidden = true;
      box.textContent = '';
    }
  }

  // Evidence card. mode 'confirm' resolves true (Continue anyway) / false (Cancel); 'blocked' resolves false on Dismiss.
  function showPrompt(box, ownership, mode) {
    return new Promise((resolve) => {
      const blocked = mode === 'blocked';
      const finish = (value) => {
        dismissCurrent = null;
        box.hidden = true;
        box.textContent = '';
        resolve(value);
      };
      if (dismissCurrent) dismissCurrent(false);
      dismissCurrent = finish;
      box.textContent = '';
      box.className = 'ownership-prompt ownership-prompt-' + (blocked ? 'blocked' : 'confirm');
      box.append(
        make('h3', blocked ? 'This conversation is in use elsewhere' : 'Another app may be using this conversation'),
      );
      if (ownership && typeof ownership.summary === 'string') box.append(make('p', ownership.summary));
      const list = make('ul', '', 'ownership-evidence');
      for (const reason of reasonTexts(ownership)) list.append(make('li', reason));
      if (list.children.length) box.append(list);
      const notes =
        ownership && Array.isArray(ownership.notes) ? ownership.notes.filter((n) => typeof n === 'string') : [];
      for (const note of notes) box.append(make('p', note, 'ownership-note'));
      box.append(
        make(
          'p',
          blocked
            ? 'Stop it in that app first, then continue here. Nothing was opened or sent.'
            : 'Studio cannot prove either way. Continuing while another app is also using the conversation can interleave or lose messages. Nothing has been opened or sent yet.',
          'ownership-advice',
        ),
      );
      const actions = make('div', '', 'ownership-actions');
      if (blocked) {
        const dismiss = make('button', 'Dismiss', 'primary');
        dismiss.type = 'button';
        dismiss.onclick = () => finish(false);
        actions.append(dismiss);
        box.append(actions);
        box.hidden = false;
        if (dismiss.focus) dismiss.focus();
      } else {
        const cancel = make('button', 'Cancel', 'primary');
        const go = make('button', 'Continue anyway', 'ownership-continue');
        cancel.type = 'button';
        go.type = 'button';
        cancel.onclick = () => finish(false);
        go.onclick = () => finish(true);
        actions.append(cancel, go);
        box.append(actions);
        box.hidden = false;
        if (cancel.focus) cancel.focus();
      }
    });
  }

  // Runs connectOnce(payload). A possibly_active refusal shows the evidence and retries with
  // continueAnyway only after an explicit click; owned_elsewhere shows why and never retries.
  async function guardedConnect(connectOnce, payload, box) {
    try {
      return await connectOnce(payload);
    } catch (error) {
      if (!box || !error) throw error;
      if (error.code === 'possibly_active') {
        const proceed = await showPrompt(box, error.ownership, 'confirm');
        if (!proceed)
          throw Object.assign(Error('Not continued. Nothing was opened or sent, and your draft is kept.'), {
            code: 'ownership_declined',
          });
        return connectOnce(Object.assign({}, payload, { continueAnyway: true }));
      }
      if (error.code === 'session_in_use' && error.ownership) showPrompt(box, error.ownership, 'blocked');
      throw error;
    }
  }

  // ---- Stable labels for chats running in another app ----
  // A value (verdict, working flag) only changes after NEED consecutive checks agree; the very first check is trusted.
  // Checks closer together than MIN_GAP seconds count as one (explicit refreshes must not double-count).
  const NEED = 2,
    MIN_GAP = 2;
  function makeStabilizer(need) {
    const items = new Map();
    need = need || NEED;
    return {
      observe(key, value, initial) {
        let it = items.get(key);
        if (!it) {
          it = { shown: initial === undefined ? value : initial, pending: null, count: 0 };
          items.set(key, it);
        }
        if (value === it.shown) {
          it.pending = null;
          it.count = 0;
        } else if (value === it.pending) {
          if (++it.count >= need) {
            it.shown = value;
            it.pending = null;
            it.count = 0;
          }
        } else {
          it.pending = value;
          it.count = 1;
          if (need <= 1) {
            it.shown = value;
            it.pending = null;
            it.count = 0;
          }
        }
        return it.shown;
      },
      shown(key) {
        const it = items.get(key);
        return it ? it.shown : undefined;
      },
      drop(key) {
        items.delete(key);
      },
      keys() {
        return [...items.keys()];
      },
    };
  }
  const verdicts = makeStabilizer(),
    working = makeStabilizer();
  let lastHints = {},
    lastCheck = null,
    lastRaw = {};
  // raw: {'provider:id': {verdict, reasons}} from the server. Returns the same shape with steady verdicts: a key is present
  // only while its steady verdict is possibly_active or owned_elsewhere. now: seconds or ms, any steady clock.
  function stabilizeHints(raw, now, gap) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const first = lastCheck === null,
      minGap = gap === undefined ? MIN_GAP : gap,
      t = now > 1e11 ? now / 1000 : now;
    if (!first && t - lastCheck < minGap) return lastHints;
    lastCheck = t;
    const keys = new Set([...Object.keys(raw), ...verdicts.keys()]),
      out = {};
    for (const key of keys) {
      const hint = raw[key],
        seen = hint && BADGE[hint.verdict] ? hint.verdict : 'none';
      const steady = verdicts.observe(key, seen, first ? seen : 'none');
      if (seen !== 'none') lastRaw[key] = hint;
      if (steady === 'none') {
        if (seen === 'none') {
          verdicts.drop(key);
          delete lastRaw[key];
        }
        continue;
      }
      out[key] = Object.assign({}, lastRaw[key] || hint, { verdict: steady });
    }
    lastHints = out;
    return out;
  }
  const RECENT_SECONDS = 90;
  // Sets conversation.elsewhere = {working, confirmed, verdict} (documented in chat.js) from steady hints; removes it otherwise.
  // ctx: {now (s), key (selected conversation key), activeWork (Activity shows work for the selected chat), aliasKey}
  function annotate(conversations, hints, ctx) {
    const keyOf = ctx.aliasKey || ((c) => c.provider + ':' + c.id),
      seen = new Set();
    for (const c of conversations || []) {
      const hint = !c.live && hints ? hints[c.provider + ':' + c.id] : null;
      if (!hint || !BADGE[hint.verdict]) {
        delete c.elsewhere;
        continue;
      }
      const k = 'w:' + keyOf(c);
      seen.add(k);
      const changing = typeof c.modified === 'number' && c.modified > 0 && ctx.now - c.modified < RECENT_SECONDS;
      const active = !!(changing || (ctx.key && ctx.key === keyOf(c) && ctx.activeWork));
      c.elsewhere = {
        working: working.observe(k, active, active),
        confirmed: hint.verdict === 'owned_elsewhere',
        verdict: hint.verdict,
      };
    }
    for (const k of working.keys()) if (!seen.has(k)) working.drop(k);
  }
  function resetStability() {
    verdicts.keys().forEach((k) => verdicts.drop(k));
    working.keys().forEach((k) => working.drop(k));
    lastHints = {};
    lastCheck = null;
    lastRaw = {};
  }

  window.AgentOwnershipUI = {
    badgeLabel: (verdict) => BADGE[verdict] || '',
    reasonTexts,
    decorateRow,
    renderHint,
    dismissHint,
    showPrompt,
    guardedConnect,
    clear,
    NO_PROOF,
    UNKNOWN,
    makeStabilizer,
    stabilizeHints,
    annotate,
    resetStability,
  };
  if (typeof module === 'object' && module.exports) module.exports = window.AgentOwnershipUI;
})();
