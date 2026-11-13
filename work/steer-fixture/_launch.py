"""Launcher of the steer e2e tests' fake agents (work/deno/_steer_lab.ts): work/fake_acp.py with the flags the lab wrote.
The lab's folder (env AIB_STEER_LAB) holds <who>.json = {"flags": [...], "log": "<path>"}."""
import json, os, pathlib, runpy, sys


def launch(who):
    config = json.loads(pathlib.Path(os.environ['AIB_STEER_LAB'], who + '.json').read_text(encoding='utf-8'))
    if config.get('log'):
        os.environ['FAKE_ACP_LOG'] = config['log']
    fixture = pathlib.Path(__file__).resolve().parents[1] / 'fake_acp.py'
    sys.argv = [str(fixture), *config['flags']]
    runpy.run_path(str(fixture), run_name='__main__')
