'use strict';
/* Worktree per chat, stage E2: one amber line under the chat header while the user's own edits, re-applied after a Merge,
   still clash ("<file> has unresolved edits. Ask the chat to fix it."), or while live sync of the project is paused after a storm of
   changed files ("Lots of files changed in <project>; live sync paused. Resume?", with a small Resume button). The server decides (GET /api/live/worktree/clash); it clears
   by itself once no conflict marker remains and git has no unmerged entries. Only a worktree chat asks, so with the feature off nothing
   is requested and nothing shows. Reuses the ownership bar's amber style. */
(function (root) {
  /* The line to show from the server's answer. Pure. */
  function plan(info) {
    const i = info || {};
    if (i.unresolved && typeof i.line === 'string' && i.line) return { show: true, line: i.line };
    if (i.syncPaused && typeof i.syncLine === 'string' && i.syncLine)
      return { show: true, line: i.syncLine, resume: true };
    return { show: false, line: '' };
  }

  function init(opts) {
    const win = opts.win,
      doc = win.document;
    const bar = doc.createElement('div');
    bar.className = 'ownership-bar clash-bar';
    bar.hidden = true;
    const line = doc.createElement('p');
    line.className = 'ownership-hint ownership-possibly_active clash-line';
    line.setAttribute('role', 'status');
    const resumeBtn = doc.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'clash-resume';
    resumeBtn.textContent = 'Resume';
    resumeBtn.hidden = true;
    bar.append(line, resumeBtn);
    const anchor = opts.after || doc.getElementById('ownershipBar');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    let project = '',
      seq = 0,
      timer = 0,
      token = '';
    function paint(info) {
      const p = plan(info);
      bar.hidden = !p.show;
      line.textContent = p.line;
      resumeBtn.hidden = !p.resume;
    }
    async function refresh() {
      const mine = ++seq;
      if (!project) return paint(null);
      try {
        if (!token) token = (await (await win.fetch('/api/live/bootstrap')).json()).token || '';
        let r = await win.fetch('/api/live/worktree/clash?project=' + encodeURIComponent(project), {
          headers: { 'X-Studio-Token': token },
        });
        if (r.status === 403) {
          token = (await (await win.fetch('/api/live/bootstrap')).json()).token || '';
          r = await win.fetch('/api/live/worktree/clash?project=' + encodeURIComponent(project), {
            headers: { 'X-Studio-Token': token },
          });
        }
        if (mine !== seq) return;
        paint(r.ok ? await r.json() : null);
      } catch (e) {
        if (mine === seq) paint(null);
      }
    }
    resumeBtn.addEventListener('click', async () => {
      if (!project) return;
      resumeBtn.disabled = true;
      try {
        if (!token) token = (await (await win.fetch('/api/live/bootstrap')).json()).token || '';
        await win.fetch('/api/live/worktree/clash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
          body: JSON.stringify({ action: 'resume-sync', project }),
        });
      } catch (e) {
        /* the next refresh shows what is true */
      }
      resumeBtn.disabled = false;
      refresh();
    });
    return {
      /* project: the selected chat's project folder, only for a chat that works in its own worktree; '' otherwise. */
      sync(next) {
        const value = typeof next === 'string' ? next : '';
        if (value === project) return;
        project = value;
        win.clearInterval(timer);
        timer = 0;
        paint(null);
        if (project) {
          refresh();
          timer = win.setInterval(refresh, 6000);
        }
      },
      refresh,
    };
  }

  const api = { plan, init };
  root.AgentClashUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
