/**
 * The background phrases of a saved transcript (server/transcripts/transcript.ts, BACKGROUNDED and BACKGROUND_LEAD; B6/T21 on the
 * history side): a Claude Code Bash result that says the command moved to the background (a steer, its timeout, Ctrl+B) makes the
 * command a running background job with that id in the Processes list and the plan context, like run_in_background always did.
 * Only the result's own first line counts: a command that printed the words is a finished command.
 */
import { assertEquals } from './_assert.ts';
import { Transcript } from '../../outputs/agent-studio/server/transcripts/transcript.ts';

type Row = Record<string, unknown>;

/** A Bash call (no run_in_background) and its result, as Claude Code saves them; `details` is the row's toolUseResult. */
function commandWith(output: string, details: Row = {}): Record<string, unknown> {
  const t = new Transcript('steer-transcript.jsonl');
  const call: Row = {
    type: 'assistant',
    timestamp: '2026-11-12T10:00:00Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  };
  const result: Row = {
    type: 'user',
    timestamp: '2026-11-12T10:00:05Z',
    toolUseResult: details,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: output }] },
  };
  t.trackCommands(call);
  t.trackCommands(result);
  const task = [...t.commands.values()][0];
  return { status: task.status, background: task.background, jobId: task.jobId };
}

const running = (jobId: string) => ({ status: 'running', background: true, jobId });

Deno.test('T21 history: each of Claude Code\'s "moved to the background" results makes a running background job with its id', () => {
  assertEquals(
    commandWith(
      'Command was moved to the background (ID: b8) so that a message that arrived while it was running can reach you; it was not ' +
        'interrupted. Output is being written to: C:\\tmp\\tasks\\b8.output',
    ),
    running('b8'),
    'a steer moved it (recording C1)',
  );
  assertEquals(
    commandWith('Command exceeded the 2m timeout and was moved to the background (ID: b9). Output is being written to: x'),
    running('b9'),
    'its timeout moved it',
  );
  assertEquals(
    commandWith('Command was manually backgrounded by user with ID: b10. Output is being written to: x'),
    running('b10'),
    'Ctrl+B moved it',
  );
  assertEquals(commandWith('  \nCommand running in background with ID: b7. Output is being written to: x'), running('b7'), 'the old phrase');
  assertEquals(commandWith('', { backgroundTaskId: 'b12', backgroundedToDeliverMessage: true }), running('b12'), 'the meta field alone');
});

Deno.test('T21 history: the words printed by a command (not its first line) leave it a finished foreground command', () => {
  for (
    const output of [
      'tick 1\nCommand was moved to the background (ID: b11) so that a message can reach you',
      'ok\nCommand exceeded the 2m timeout and was moved to the background (ID: b13).',
      'done\nCommand was manually backgrounded by user with ID: b14.',
      'all 212 tests passed',
    ]
  ) {
    assertEquals(commandWith(output), { status: 'completed', background: false, jobId: null }, output);
  }
});
