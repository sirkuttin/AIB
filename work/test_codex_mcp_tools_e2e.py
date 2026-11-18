"""AIB's MCP tools reach Codex. The real codex-acp (AIB_CODEX_ACP) gets a stdio `studio_artifact` MCP server in session/new
(what AIB sends, acp/connection.ts), a throwaway CODEX_HOME and the stub model API (work/stub_model_api.js, script mode).

What a capture of a Codex chat showed: the model request has no studio_artifact tools in its tool list. That is not a failure to pass
the server: Codex (code mode) offers one `exec` tool and keeps MCP tools as deferred nested tools of it, listed only in the script
global ALL_TOOLS and called as `await tools.mcp__studio_artifact__<tool>(...)`. So the model must be told how to find them
(acp/connection.ts TOOLS_LOADING). The test asserts:
  - the server starts and its tools are in ALL_TOOLS (the stub model runs `exec` with a script that lists them and the result,
    sent back to the model in the next request, names all three),
  - the model request itself does not list them (so a change in Codex that lists them is noticed here), and
  - the text AIB gives the chat says where to look (the ALL_TOOLS recipe).

Targeted: run this file alone. Skipped without node or codex-acp. Project and CODEX_HOME are in agent_mkdtemp's folder (outside home).
"""
import _isolation  # noqa: F401  (test isolation: temp state folder, real per-user folder blocked)
from _isolation import agent_mkdtemp
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import unittest

sys.path.insert(0, str(_isolation.TESTS / 'contract'))
from test_subagent_codex_e2e import CODEX_ACP  # noqa: E402
from test_folder_chat_listing_e2e import NODE  # noqa: E402

WORK = pathlib.Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
LIST_SCRIPT = 'text(JSON.stringify(ALL_TOOLS.map((t) => t.name).filter((n) => n.startsWith("mcp__studio_artifact__")).sort()))'


def outputs_of(request):
    """The text of every custom_tool_call_output (an `exec` result) in a model request."""
    out = []
    for item in request.get('input', []):
        if isinstance(item, dict) and item.get('type') == 'custom_tool_call_output':
            out.append(json.dumps(item.get('output')))
    return out


@unittest.skipUnless(NODE and CODEX_ACP, 'needs node and codex-acp (AIB_CODEX_ACP)')
class CodexMcpToolsTest(unittest.TestCase):

    def run_chat(self):
        temp = pathlib.Path(agent_mkdtemp(prefix='aib-cxmcp-'))
        self.addCleanup(shutil.rmtree, temp, True)
        self.assertFalse(_isolation.inside_home(temp), temp)
        project, home, dump = temp / 'proj', temp / 'codex-home', temp / 'dump'
        for folder in (project, home, dump, temp / 'tmp'):
            folder.mkdir()
        script = temp / 'script.json'
        script.write_text(json.dumps({'rules': [{'when': 'hello', 'in': 'last', 'reply': {'tools': [
            {'id': 'call_list', 'name': 'functions.exec', 'custom': True, 'input': LIST_SCRIPT}]}}]}), encoding='utf-8')
        stub = subprocess.Popen([NODE, str(WORK / 'stub_model_api.js'), '--port', '0', '--stdin', '--dump', str(dump), '--script', str(script)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, creationflags=NO_WINDOW)
        self.addCleanup(lambda: (stub.stdin.close(), stub.wait(10)))
        port = int(stub.stdout.readline().strip().split('=')[1])
        config = {'model_provider': 'stub', 'model_providers': {'stub': {
            'name': 'stub', 'base_url': f'http://127.0.0.1:{port}/v1', 'wire_api': 'responses', 'requires_openai_auth': False,
            'supports_websockets': False}}, 'analytics': {'enabled': False}, 'check_for_update_on_startup': False}
        env = {k: v for k, v in os.environ.items() if not k.startswith(('OPENAI_', 'ANTHROPIC_', 'CODEX_'))}
        env.update(CODEX_HOME=str(home), CODEX_CONFIG=json.dumps(config), TEMP=str(temp / 'tmp'), TMP=str(temp / 'tmp'))
        agent = subprocess.Popen([NODE, str(CODEX_ACP)], env=env, cwd=str(project), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True, creationflags=NO_WINDOW)
        self.addCleanup(lambda: (agent.kill(), agent.wait(10)))
        answers, ids = {}, iter(range(1, 1000))
        cond = threading.Condition()

        def reader():
            for line in agent.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if 'id' in message and 'method' not in message:
                    with cond:
                        answers[message['id']] = message
                        cond.notify_all()
                elif 'id' in message:  # a permission request: refuse (nothing here needs one)
                    agent.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': {'outcome': {'outcome': 'cancelled'}}}) + '\n')
                    agent.stdin.flush()
        threading.Thread(target=reader, daemon=True).start()

        def request(method, params, seconds=90):
            number = next(ids)
            agent.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params}) + '\n')
            agent.stdin.flush()
            with cond:
                self.assertTrue(cond.wait_for(lambda: number in answers, seconds), f'no answer to {method}')
            return answers[number]

        request('initialize', {'protocolVersion': 1, 'clientCapabilities': {}})
        entry = {'name': 'studio_artifact', 'command': NODE, 'args': [str(WORK / 'stub_mcp_server.js')], 'env': []}
        session = request('session/new', {'cwd': str(project), 'mcpServers': [entry]})
        self.assertIn('result', session, session)
        done = request('session/prompt', {'sessionId': session['result']['sessionId'], 'prompt': [{'type': 'text', 'text': 'hello'}]})
        self.assertIn('result', done, done)
        requests = []
        for path in sorted(dump.glob('*.json'), key=lambda p: int(p.stem)):
            dumped = json.loads(path.read_text(encoding='utf-8'))
            body = dumped.get('body', dumped) if isinstance(dumped, dict) else None
            if isinstance(body, dict) and 'input' in body:
                requests.append(body)
        return requests

    def test_studio_artifact_tools_are_deferred_nested_tools_of_exec(self):
        requests = self.run_chat()
        self.assertTrue(requests, 'the stub saw no model request')
        first = json.dumps(requests[0])
        self.assertNotIn('mcp__studio_artifact__', first, 'Codex now lists MCP tools up front: update TOOLS_LOADING in acp/connection.ts')
        listed = [text for request in requests for text in outputs_of(request) if 'mcp__studio_artifact__' in text]
        self.assertTrue(listed, 'ALL_TOOLS does not list the studio_artifact tools: Codex did not start or accept the MCP server')
        names = set(re.findall(r'mcp__studio_artifact__\w+', listed[0]))
        self.assertEqual(names, {'mcp__studio_artifact__publish', 'mcp__studio_artifact__doc_create', 'mcp__studio_artifact__doc_read'})


class PromptNamesTheRecipeTest(unittest.TestCase):
    """What AIB tells the chat (same text for every agent) says how Codex finds the tools."""

    def test_artifact_prompt_has_the_all_tools_recipe(self):
        text = (_isolation.APP / 'server' / 'acp' / 'connection.ts').read_text(encoding='utf-8')
        match = re.search(r"export const TOOLS_LOADING = (.*?);\n", text, re.S)
        self.assertTrue(match)
        self.assertIn('ALL_TOOLS', match.group(1))
        self.assertIn('await tools.mcp__studio_artifact__publish', match.group(1))


if __name__ == '__main__':
    unittest.main()
