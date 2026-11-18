"""Guard: a test that runs a REAL agent (Claude Code, Codex, Gemini, Maki) keeps its project folders outside the user's home folder.

Claude Code walks the parent folders of its working folder for CLAUDE.md, so a project under the user's %TEMP% (inside C:\\Users\\<me>)
loads the owner's ~/.claude/CLAUDE.md as project instructions even with CLAUDE_CONFIG_DIR set. Real-agent tests use
_isolation.agent_mkdtemp / agent_tempdir (Python) and work/deno/_agent_tmp.ts (Deno): C:/aib-test-tmp on Windows, /tmp on Linux.

  test_helper_folders_are_outside_home      the helper's root and the folders it makes (and the e2e Fixture's) are not in the home folder
  test_inside_home_sees_a_folder_in_home    the check itself works (a folder in the temp folder or home is "inside")
  test_real_agent_python_tests_use_helper   every work/test_*.py that references a real adapter / the stub model API makes its folders
                                            with the helper, never tempfile.mkdtemp / TemporaryDirectory (gettempdir only to look)
  test_real_agent_deno_tests_use_helper     the same for work/deno/*_test.ts that use the stub model API (Deno.makeTempDir*)
"""
import _isolation
import os
import pathlib
import re
import shutil
import unittest

WORK = pathlib.Path(__file__).resolve().parent
REAL_PY = re.compile(r'CLAUDE_ACP|CODEX_ACP|RealClaudeFixture|AIB_CODEX_ACP|AIB_CLAUDE_ACP|AIB_CLAUDE_CLI|stub_model_api|codex-launcher')
REAL_TS = re.compile(r'stub_model_api')


class AgentTestIsolationGuard(unittest.TestCase):

    def test_helper_folders_are_outside_home(self):
        self.assertFalse(_isolation.inside_home(_isolation.agent_temp_root()), _isolation.agent_temp_root())
        folder = _isolation.agent_mkdtemp(prefix='aib-guard-')
        self.addCleanup(shutil.rmtree, folder, True)
        self.assertFalse(_isolation.inside_home(folder), folder)
        import _e2e_support
        fixture = _e2e_support.Fixture(self)
        self.assertFalse(_isolation.inside_home(fixture.root), fixture.root)
        self.assertFalse(_isolation.inside_home(fixture.workspace), fixture.workspace)

    def test_inside_home_sees_a_folder_in_home(self):
        home = os.path.expanduser('~')
        self.assertTrue(_isolation.inside_home(home))
        self.assertTrue(_isolation.inside_home(os.path.join(home, 'AppData', 'Local', 'Temp', 'x')))
        self.assertFalse(_isolation.inside_home(_isolation.agent_temp_root()))

    def test_real_agent_python_tests_use_helper(self):
        offenders, checked = [], []
        for path in sorted(WORK.glob('test_*.py')):
            if path.name == pathlib.Path(__file__).name:
                continue
            text = path.read_text(encoding='utf-8')
            if not REAL_PY.search(text):
                continue
            checked.append(path.name)
            if re.search(r'tempfile\.(?:mkdtemp|TemporaryDirectory)\(', text):
                offenders.append(path.name)
        self.assertTrue(checked, 'found no real-agent tests: the pattern is stale')
        self.assertEqual(offenders, [], 'use _isolation.agent_mkdtemp / agent_tempdir (outside the home folder) in real-agent tests')

    def test_real_agent_deno_tests_use_helper(self):
        offenders, checked = [], []
        for path in sorted((WORK / 'deno').glob('*_test.ts')):
            text = path.read_text(encoding='utf-8')
            if not REAL_TS.search(text):
                continue
            checked.append(path.name)
            if re.search(r'Deno\.makeTempDir(?:Sync)?\(', text):
                offenders.append(path.name)
        self.assertTrue(checked, 'found no real-agent Deno tests: the pattern is stale')
        self.assertEqual(offenders, [], 'use agentTempDirSync from work/deno/_agent_tmp.ts in real-agent Deno tests')


if __name__ == '__main__':
    unittest.main()
