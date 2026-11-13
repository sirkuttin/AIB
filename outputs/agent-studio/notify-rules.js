(function (root) {
  'use strict';
  // The rules for "a chat needs you" and "a chat finished" notifications, in ONE place for the page and the server. The page
  // (notify-ui.js, workspace-ui.js, sidebar-ui.js, workspace-state.js) loads this file as a script; the server imports it
  // (server/attention/rules.ts) and its AttentionWatcher applies the same rules to the agent host's chat list, so desktop
  // notifications and phone pushes fire with the AIB window closed. work/deno/attention_rules_test.ts checks that the page's
  // and the server's way of reading a chat give the same answers.
  //
  //   * Which chats may notify at all: not archived, not deleted, not in a hidden project, not in a git worktree folder or a
  //     Claude desktop scratch folder. Muted projects never notify (the inbox still lists them).
  //   * "Finished" (your turn) also not for chats on hold: parked chats wait on nobody.
  //   * The desktop app's own choices (studio-notifications-app): desktop notifications on or off, and for Needs you only or
  //     for Needs you + Your turn.
  //   * Notifications within about a minute fold into one (one desktop notification replaces the older; phone pushes share a
  //     tag, so the phone shows only the newest).
  //   * Phone pushes say only "A chat needs you" or "Chat finished" and the chat's title: never the question, a command or code.
  //   * Where the owner is looking (route): a chat on a phone's screen gets no desktop notification and no push; while a phone is
  //     in hand at all, news goes to its page as a banner, not as a push; the PC's focus and input rules stay as they were.
  const GROUP_MS = 60000;
  const TAG = 'studio-attention';
  const PUSH_TAG = 'aib-attention';

  // ---- folders ----------------------------------------------------------------------------------------------------------------
  // "C:\Repos\App\", "c:/repos/app" and "C:\\Repos\\\\App" are the same folder on Windows; POSIX paths keep their case.
  function splitPath(cwd) {
    let p = String(cwd == null ? '' : cwd).trim();
    const raw = p;
    p = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
    const unc = p.startsWith('//');
    p = p.replace(/\/{2,}/g, '/');
    const segments = p.split('/').filter(Boolean);
    const windows = /^[a-zA-Z]:/.test(p) || unc || raw.indexOf('\\') >= 0;
    return { segments, windows };
  }
  // The key a project's preferences (name, colour, hidden, muted) are saved under.
  function pathKey(cwd) {
    const { segments, windows } = splitPath(cwd);
    if (!segments.length) return '';
    const joined = segments.join('/');
    return windows ? 'w:' + joined.toLowerCase() : 'p:' + joined;
  }
  // Git worktree folders and Claude desktop scratch folders are not projects you switch to. The text rules work at once; the
  // server adds the one it can only know from disk (a `.git` FILE pointing into a worktrees folder), /api/live/folders/kinds.
  const pathSegments = (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
  const isScratchPath = (p) => pathSegments(p).some((seg) => /^scratch-/i.test(seg));
  const isWorktreePath = (p) => {
    const t = '/' + pathSegments(p).join('/').toLowerCase() + '/';
    return t.includes('/.claude/worktrees/') || t.includes('/.git/worktrees/');
  };

  // ---- which chats notify ---------------------------------------------------------------------------------------------------------
  const projectPref = (prefs, key) => {
    const p = (prefs && prefs.projects && key && prefs.projects[key]) || {};
    return { hidden: p.hidden === true, muted: p.muted === true };
  };
  // f: {archived, deleted, held, projectKey, worktree, scratch} (the page's normalized chat, or the server's reading of the same
  // stores); prefs: the project preferences ({projects: {key: {hidden, muted}}}). Returns {eligible, muted, held}.
  function flags(f, prefs) {
    const x = f || {};
    const pref = projectPref(prefs, x.projectKey);
    return {
      eligible: !x.archived && !x.deleted && !pref.hidden && !x.worktree && !x.scratch,
      muted: pref.muted,
      held: !!x.held,
    };
  }
  // May this kind ('needs' | 'turn') of news about a chat with these flags notify anywhere at all?
  function notifies(kind, fl) {
    if (!fl || !fl.eligible || fl.muted) return false;
    return kind !== 'turn' || !fl.held;
  }

  // ---- the desktop app's choices ------------------------------------------------------------------------------------------------
  const SOUND_MODES = ['needs', 'both', 'off'],
    NOTIFY_FOR = ['both', 'needs'];
  // app: the desktop app's defaults (notifications on, Needs you only); a browser's stay off until allowed, for both kinds.
  function cleanPrefs(v, app) {
    v = v && typeof v === 'object' ? v : {};
    // The old checkbox ("Play a sound") was a boolean: on becomes "Needs you only", off stays off.
    const sound = SOUND_MODES.includes(v.sound) ? v.sound : v.sound === false ? 'off' : 'needs';
    return {
      desktop: app ? v.desktop !== false : v.desktop === true,
      sound,
      notifyFor: NOTIFY_FOR.includes(v.notifyFor) ? v.notifyFor : app ? 'needs' : 'both',
    };
  }
  // The saved text of studio-notifications-app (view preferences) as the desktop app's choices.
  function appPrefs(text) {
    try {
      return cleanPrefs(typeof text === 'string' && text ? JSON.parse(text) : null, true);
    } catch {
      return cleanPrefs(null, true);
    }
  }
  // Does a desktop notification go out for this kind under these choices?
  const desktopWants = (kind, prefs) => !!(prefs && prefs.desktop) && (kind === 'needs' || prefs.notifyFor === 'both');

  // ---- grouping (~60 s) -----------------------------------------------------------------------------------------------------------
  const SOUND_RANK = { turn: 1, needs: 2 };
  // Coalesce events into one group per ~60 s. group: null or {startedAt, entries:[{key, kind, title}], sounded}.
  // Returns {group, sound} where sound is the sound to play now (a louder kind than already played in this group) or null.
  function addToGroup(group, items, now, windowMs) {
    const win = windowMs || GROUP_MS;
    const g =
      group && now - group.startedAt <= win
        ? { startedAt: group.startedAt, entries: group.entries.map((x) => ({ ...x })), sounded: group.sounded }
        : { startedAt: now, entries: [], sounded: null };
    let best = null;
    for (const it of items) {
      const at = g.entries.findIndex((x) => x.key === it.key);
      // An entry is {key, title, kind} (+ chat: the live chat's id, which the server's pushes open).
      const entry = (old) => {
        const e = {
          key: it.key,
          title: it.title || (old ? old.title : ''),
          kind: (old && old.kind === 'needs') || it.kind === 'needs' ? 'needs' : 'turn',
        };
        const chat = it.chat || (old && old.chat);
        if (chat) e.chat = chat;
        return e;
      };
      if (at >= 0) g.entries[at] = entry(g.entries[at]);
      else g.entries.push(entry(null));
      if (it.sound && (!best || SOUND_RANK[it.sound] > SOUND_RANK[best])) best = it.sound;
    }
    let sound = null;
    if (best && (!g.sounded || SOUND_RANK[best] > SOUND_RANK[g.sounded])) {
      sound = best;
      g.sounded = best;
    }
    return { group: g, sound };
  }

  // The desktop notification for a group. One entry names the chat; several say how many are waiting (titles, up to 3).
  function describe(group) {
    const list = (group && group.entries) || [];
    if (list.length === 1)
      return {
        tag: TAG,
        title: list[0].title || 'AIB',
        body: list[0].kind === 'needs' ? 'Needs you' : 'Your turn',
        target: { type: 'chat', key: list[0].key },
      };
    const names = list.slice(0, 3).map((x) => x.title || 'Conversation');
    if (list.length > 3) names.push('and ' + (list.length - 3) + ' more');
    return {
      tag: TAG,
      title: list.length + ' agents are waiting for you',
      body: names.join('\n'),
      target: { type: 'inbox' },
    };
  }

  // The phone push for a group: generic words and chat titles only (never a question, a command or code). The same tag on every
  // push, so a newer one replaces the older on the phone. chat/sheet: what a tap opens (the chat, with its sheet up for Needs you).
  function pushText(group) {
    const list = (group && group.entries) || [];
    const needs = list.filter((x) => x.kind === 'needs');
    const title = (x) => String(x.title || 'A chat').slice(0, 120);
    if (list.length === 1) {
      const e = list[0];
      return {
        title: e.kind === 'needs' ? 'A chat needs you' : 'Chat finished',
        body: title(e),
        tag: PUSH_TAG,
        chat: e.chat || '',
        sheet: e.kind === 'needs',
      };
    }
    const names = list.slice(0, 3).map(title);
    if (list.length > 3) names.push('and ' + (list.length - 3) + ' more');
    const first = needs[0] || list[0] || {};
    return {
      title: needs.length === list.length ? list.length + ' chats need you' : needs.length ? list.length + ' chats are waiting for you' : list.length + ' chats finished',
      body: names.join('\n'),
      tag: PUSH_TAG,
      chat: needs.length === 1 ? first.chat || '' : '',
      sheet: needs.length === 1,
    };
  }

  // ---- where news goes (the server's Notifier, attention/watcher.ts) -------------------------------------------------------
  // kind: 'needs' | 'turn'; chat: the live chat's id; view: {pcFocused, pcActive, phones: [the chat id each visible phone shows,
  // or null for its home]} (attention/presence.ts). Returns:
  //   desktop  a desktop notification may go (the app's own choices still apply): no AIB window has focus and no phone shows
  //            this chat.
  //   push     a phone push goes: the owner is not working at the PC and no phone is on screen (a phone in hand gets a banner).
  //   banner   the phones on screen get it in their page (the one showing this chat already sees it there).
  //   read     the chat is marked read on the PC: its turn ended while a phone showed it.
  function route(kind, chat, view) {
    const v = view || {};
    const phones = Array.isArray(v.phones) ? v.phones : [];
    const onPhone = !!chat && phones.some((c) => c === chat);
    return {
      desktop: !v.pcFocused && !onPhone,
      push: !v.pcActive && !phones.length,
      banner: phones.length > 0,
      read: kind === 'turn' && onPhone,
    };
  }

  const api = {
    GROUP_MS,
    TAG,
    PUSH_TAG,
    splitPath,
    pathKey,
    isScratchPath,
    isWorktreePath,
    projectPref,
    flags,
    notifies,
    cleanPrefs,
    appPrefs,
    desktopWants,
    addToGroup,
    describe,
    pushText,
    route,
  };
  root.AgentNotifyRules = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
