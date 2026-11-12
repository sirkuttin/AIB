/**
 * "Merge into <main>" asks the agent: the fixed message the Changes tab's Merge button sends.
 *
 * AIB is chat-first: the owner says "yes, merge" in the chat and the agent calls merge_into_project. The button is only a shortcut
 * that sends the chat MERGE_REQUEST as from the user (the page shows it as a "Merge requested" chip). No permission is recorded:
 * the tool merges whenever the agent calls it, and each merge that lands posts AIB's own "Merged into ..." line in the chat.
 */

/** clientMessageId prefix of the button's message (merge.ts's own prompts use 'merge-' too). */
export const REQUEST_ID_PREFIX = 'merge-request-';

/** The fixed message the Merge button sends the chat (base: the branch it merges into). */
export function mergeRequestText(base: string): string {
  const name = base || 'main';
  return `Merge this chat's work into ${name} with AIB's merge tool (merge_into_project). If ${name} has moved and there are ` +
    'conflicts, resolve them in this worktree and call it again. Then say in one line what landed.';
}

/** The whole (trimmed) text is the button's message: the page shows it as a "Merge requested" chip (StreamUI.wholeNote). */
export const MERGE_REQUEST =
  /^Merge this chat's work into (\S+) with AIB's merge tool \(merge_into_project\)\. If \1 has moved and there are conflicts, resolve them in this worktree and call it again\. Then say in one line what landed\.$/;

export function isMergeRequest(text: unknown): boolean {
  return typeof text === 'string' && MERGE_REQUEST.test(text.trim());
}
