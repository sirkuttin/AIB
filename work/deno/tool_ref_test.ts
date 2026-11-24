/**
 * Tool consolidation slice 3 (architect review M7): AIB names its tools to a running chat the way that chat knows them (toolRef,
 * tellChat), and the prompt texts name only tools that exist.
 */
import { assert, assertEquals } from './_assert.ts';
import { newNames, setServedNames, tellChat, toolRef } from '../../app/server/artifacts/tool_ref.ts';
import { commentMessage } from '../../app/server/docs/comments.ts';
import { clashGuidance } from '../../app/server/worktrees/merge.ts';
import { ARTIFACT_PROMPT, WORKTREE_PROMPT, WSL_ARTIFACT_PROMPT } from '../../app/server/acp/connection.ts';
import { DOC_INSTRUCTIONS, DOCS_RULE } from '../../app/server/docs/tool_defs.ts';
import { INSTRUCTIONS } from '../../app/server/artifacts/mcp.ts';
import { consolidatedTools } from '../../app/server/artifacts/mcp_tools.ts';

const NEW = ['publish', 'artifacts:archive,list', 'doc:list,read', 'drawing:create', 'helper:work_land,work_list', 'merge_into_project:merge'];
const OLD = ['publish', 'update', 'list', 'doc_create', 'doc_edit', 'unlanded_work', 'merge_into_project'];
const served: Record<string, string[]> = { newchat: NEW, oldchat: OLD };

function withServed(fn: () => void): void {
  setServedNames((id) => served[id] ?? null);
  try {
    fn();
  } finally {
    setServedNames(null);
  }
}

Deno.test('toolRef: an old-record chat gets the old name, a new one the new words, a record-less chat the old name', () => {
  withServed(() => {
    assertEquals(toolRef('oldchat', 'unlanded_work'), 'unlanded_work');
    assertEquals(toolRef('newchat', 'unlanded_work', 'land'), '`helper` action "work_land"');
    assertEquals(toolRef('oldchat', 'unlanded_work', 'land'), 'unlanded_work with action "land"');
    assertEquals(toolRef('nobody', 'doc_reply'), 'doc_reply');
    assertEquals(toolRef(undefined, 'doc_reply'), 'doc_reply');
    assertEquals(toolRef('newchat', 'doc_reply'), '`doc` action "reply"');
    assertEquals(toolRef('newchat', 'resolve_edit_clash', 'keep_mine'), '`merge_into_project` action "keep_mine"');
    assertEquals(toolRef('newchat', 'merge_into_project'), '`merge_into_project`');
    assertEquals(toolRef('newchat', 'start_helper'), '`helper` action "start"');
    assertEquals(toolRef('newchat', 'update'), '`publish` with `id`');
  });
});

Deno.test('the mid-chat texts name the tools the chat knows: comment notice, merge clash, tellChat', () => {
  withServed(() => {
    const view = { on: 'quote', quote: 'x', detached: false, thread: 't1', replies: [{ by: 'user', text: 'fix' }] } as never;
    const old = commentMessage('plan', 'aib-docs/plan/doc.aibdoc', view, 'oldchat');
    assert(old.includes('doc_edit') && old.includes('doc_reply'));
    const fresh = commentMessage('plan', 'aib-docs/plan/doc.aibdoc', view, 'newchat');
    assert(fresh.includes('`doc` action "edit"') && fresh.includes('`doc` action "reply"') && !fresh.includes('doc_reply'));

    const chat = { base: 'main', project: 'C:/p' };
    assert(clashGuidance({ ...chat, id: 'oldchat' }, ['a.txt'], 's', true).includes('resolve_edit_clash with action "keep_mine"'));
    const g = clashGuidance({ ...chat, id: 'newchat' }, ['a.txt'], 's', true);
    assert(g.includes('`merge_into_project` action "keep_mine"') && g.includes('action "check"') && !g.includes('resolve_edit_clash'));

    const text = 'Call unlanded_work with action discard and a reason; doc_history lists them; do not poll helper_status.';
    assertEquals(tellChat('oldchat', text), text);
    assertEquals(tellChat('nobody', text), text);
    assertEquals(
      tellChat('newchat', text),
      'Call `helper` action "work_discard" and a reason; `doc` action "history" lists them; do not poll `helper` action "status".',
    );
    assertEquals(newNames('plain words, doc_read_me stays'), 'plain words, doc_read_me stays');
  });
});

Deno.test('prompt texts name only tools that exist (the six), never an old per-action name', () => {
  const names = new Set(consolidatedTools({ main: true, worktree: true }, { artifacts: true, merge: true, swarm: true, docs: true }).map((t) => String(t.name)));
  const gone = /\b(?:doc|drawing)_(?:list|create|read|changes|edit|claim|page|undo|comments|comment|reply|resolve|history|restore|from_mermaid)\b|\bunlanded_work\b|\bresolve_edit_clash\b|\b(?:start|stop|merge)_helper\b|\bhelper_(?:status|providers)\b|studio_artifact (?:publish|update)\b|\bupdate tool\b/;
  for (const [label, text] of Object.entries({ ARTIFACT_PROMPT, WSL_ARTIFACT_PROMPT, WORKTREE_PROMPT, DOCS_RULE, INSTRUCTIONS, DOC_INSTRUCTIONS })) {
    assert(!gone.test(text), `${label} names an old tool: ${gone.exec(text)?.[0]}`);
    for (const m of text.matchAll(/mcp__studio_artifact__(\w+)/g)) assert(names.has(m[1]), `${label} names a tool that does not exist: ${m[1]}`);
  }
  assert(ARTIFACT_PROMPT.includes('`publish`'));
});
