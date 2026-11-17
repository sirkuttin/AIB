"""Stop and Send now never stop a chat's background subagents (owner, 2026-11-16, beta12: Send now on a queued message interrupted
the lead, and AIB then said its background subagent "was stopped before it finished" and did not merge it).

e2e with the REAL Claude Code adapter against the stub model API (work/stub_model_api.js script mode), temp config and temp dirs
only (the Aib harness of work/test_subagent_landing_e2e.py):

  test_stop_keeps_background_subagent      the lead launches a background editing subagent (run_in_background, its own AIB worktree),
                                           then runs a long foreground command; the user presses Stop. The lead's turn ends
                                           cancelled; the subagent goes on, finishes and lands as one "AIB: subagent ..." commit.
  test_send_now_steers_and_backgrounds     same start; the user queues a message and presses Send now on it. No cancel: Claude Code
                                           moves the running command to the background (it finishes and writes its file), the lead
                                           reads the message in the same turn, and the subagent lands.

Needs node, the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install) and Go (keeper program; AIB_TEST_KEEPER_BIN names a
built one). Heavy: run it alone, with TEMP/TMP pointed at a scratch folder.
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
import json
import os
import time
import unittest
import uuid

from test_subagent_landing_e2e import SERVER_KIND, Aib, agent_call, bash, git_log, notes, records  # noqa: E402
from test_subagent_worktree_e2e import GO, approve_all, dumped, stub_text  # noqa: E402
from test_folder_chat_listing_e2e import CLAUDE_ACP, NODE  # noqa: E402
from test_worktree_e2e import wait_for  # noqa: E402


def updates(chat):
    return json.dumps([e for e in chat.state()['events'] if e.get('kind') == 'update'])


def turn_ends(chat):
    return [(e.get('data') or {}).get('stopReason') for e in chat.state()['events'] if e.get('kind') == 'turn_end']


def sub_state(fx, description):
    found = [r for r in records(fx).values() if r.get('description') == description]
    return found[0]['state'] if found else None


@unittest.skipUnless(NODE and CLAUDE_ACP, 'needs node and the Claude Code ACP adapter (AIB_CLAUDE_ACP or a global npm install)')
@unittest.skipUnless(GO or os.environ.get('AIB_TEST_KEEPER_BIN'), 'needs Go to build the keeper program (or AIB_TEST_KEEPER_BIN)')
@unittest.skipUnless(SERVER_KIND == 'deno-split', 'runs against AIB_SERVER=deno-split (the default)')
class SubagentSurvivesStopTest(unittest.TestCase):

    def start(self, aib, text, parent_tool):
        """Send `text`; wait until the background subagent runs and the lead's foreground command is running."""
        chat = aib.chat
        code, _ = aib.web.post('prompt', {'id': chat.id, 'text': text, 'clientMessageId': uuid.uuid4().hex})
        self.assertEqual(code, 200)

        def running():
            approve_all(chat)
            state = chat.state()
            seen = updates(chat)
            # its Bash call started and has not ended (a refused command ends at once)
            return state['busy'] and not state['permissions'] and parent_tool in seen and not                 any(e['data'].get('update', {}).get('toolCallId') == parent_tool and e['data']['update'].get('status') in ('completed', 'failed')
                    for e in state['events'] if e.get('kind') == 'update')
        try:
            wait_for(running, "the lead's long command to run", seconds=120)
        except AssertionError:
            state = chat.state()
            print('STATE busy', state.get('busy'), 'permissions', json.dumps(state.get('permissions'))[:2000])
            print('STUB LOG', stub_text(aib.stub)[-6000:])
            print('EVENTS', json.dumps(state['events'])[-8000:])
            raise
        time.sleep(1.5)  # the command is really running (its approval was just answered)
        approve_all(chat)

    def landed(self, aib, description):
        aib.wait(f'the background subagent {description!r} to land', lambda: f'AIB: subagent {description}' in git_log(aib.project), seconds=180)
        self.assertFalse([n for n in notes(aib.chat) if 'was stopped before it finished' in n], notes(aib.chat))

    def test_stop_keeps_background_subagent(self):
        rules = [
            {'when': 'SC-STOP', 'reply': {'tools': [agent_call('toolu_pS1', 'sc background', 'SUBTASK-S: do the work', background=True)]}},
            {'when': 'SUBTASK-S', 'reply': {'tools': [bash('toolu_sS1', 'for i in $(seq 1 10); do sleep 1; done; echo from-bg > sub-s.txt')]}},
            {'when': 'toolu_sS1', 'reply': {'text': 'SUB-S-DONE'}},
            {'when': 'toolu_pS1', 'reply': {'tools': [bash('toolu_pS2', 'for i in $(seq 1 40); do echo tick $i; sleep 1; done; echo parent-slept')]}},
        ]
        aib = Aib(self, rules)
        chat, fx = aib.chat, aib.fx
        self.start(aib, 'SC-STOP go', 'toolu_pS2')
        self.assertEqual(sub_state(fx, 'sc background'), 'running', 'the subagent must still run when the user stops the turn')
        code, _ = aib.web.post('cancel', {'id': chat.id})
        self.assertEqual(code, 200)
        try:
            aib.wait('the turn to end cancelled', lambda: 'cancelled' in turn_ends(chat))
        except AssertionError:
            state = chat.state()
            print('BUSY', state.get('busy'), 'TURN_ENDS', turn_ends(chat), 'RECORDS', json.dumps(records(fx))[:3000])
            print('STUB LOG', stub_text(aib.stub)[-5000:])
            print('EVENTS', json.dumps([e for e in state['events'] if e.get('kind') != 'update'])[-5000:])
            raise
        time.sleep(1)
        self.assertEqual(sub_state(fx, 'sc background'), 'running', 'Stop must not stop a background subagent')
        self.landed(aib, 'sc background')
        self.assertEqual((aib.project / 'sub-s.txt').read_text(encoding='utf-8').strip(), 'from-bg')
        self.assertIn('SUB-S-DONE', dumped(aib.stub), 'the subagent finished its work')

    def test_send_now_steers_and_backgrounds(self):
        rules = [
            {'when': 'SN-NOW read this', 'in': 'any', 'reply': {'text': 'LEAD-READ-IT'}},
            {'when': 'SN-GO', 'reply': {'tools': [agent_call('toolu_pN1', 'sn background', 'SUBTASK-N: do the work', background=True)]}},
            {'when': 'SUBTASK-N', 'reply': {'tools': [bash('toolu_sN1', 'for i in $(seq 1 10); do sleep 1; done; echo from-bg > sub-n.txt')]}},
            {'when': 'toolu_sN1', 'reply': {'text': 'SUB-N-DONE'}},
            {'when': 'toolu_pN1', 'reply': {'tools': [bash('toolu_pN2', 'for i in $(seq 1 12); do echo tick $i; sleep 1; done; echo fg-finished > fg.txt')]}},
        ]
        aib = Aib(self, rules)
        chat, fx, p = aib.chat, aib.fx, aib.project
        self.start(aib, 'SN-GO go', 'toolu_pN2')
        msg = uuid.uuid4().hex
        code, queued = aib.web.post('queue', {'id': chat.id, 'text': 'SN-NOW read this', 'clientMessageId': msg})
        self.assertEqual(code, 200, queued)
        code, sent = aib.web.post('queue-send-now', {'id': chat.id, 'messageId': msg})
        self.assertEqual(code, 200, sent)
        self.assertTrue(sent.get('steered'), sent)
        aib.wait('the lead to read the message mid-turn', lambda: 'LEAD-READ-IT' in updates(chat), seconds=120)
        self.assertNotIn('cancelled', turn_ends(chat), 'Send now must not stop the turn')
        sent_to_model = dumped(aib.stub)
        self.assertIn('moved to the background', sent_to_model, 'Claude Code moves the running command to the background')
        self.assertIn('it was not interrupted', sent_to_model)
        aib.wait('the backgrounded command to finish', lambda: (p / 'fg.txt').is_file(), seconds=60)
        self.assertEqual((p / 'fg.txt').read_text(encoding='utf-8').strip(), 'fg-finished')
        self.landed(aib, 'sn background')
        self.assertEqual((p / 'sub-n.txt').read_text(encoding='utf-8').strip(), 'from-bg')
        self.assertNotIn('cancelled', turn_ends(chat))


if __name__ == '__main__':
    unittest.main()
