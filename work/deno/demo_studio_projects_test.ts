/**
 * work/demo-studio/start.py adds its demo projects (QA polish 8): Studio lists saved chats only for projects the user added, so a
 * fresh demo used to open with "No project yet" although its README promises chats. The demo writes studio-added-projects.json for
 * alpha, alpha/docs and beta (the folders its chats work in), under the keys Studio itself files them under.
 */
import { projectKey } from '../../outputs/agent-studio/server/desktop/project_delete.ts';
import { assert, assertEquals } from './_assert.ts';
import { HAVE_GIT } from './_git_repo.ts';
import { PYTHON } from './_connection.ts';
import { SEP as sep } from './_host_fixture.ts';

Deno.test({
  name: 'the demo Studio adds its demo projects, so the sidebar shows the demo chats',
  ignore: !HAVE_GIT,
  async fn() {
    const demo = Deno.makeTempDirSync({ prefix: 'aib-demo-gen-' });
    try {
      const script = `import pathlib, sys\nsys.path.insert(0, 'work/demo-studio')\nimport start\nstart.generate(pathlib.Path(sys.argv[1]))\n`;
      const out = await new Deno.Command(PYTHON, { args: ['-c', script, demo], cwd: '../..', env: { PYTHONDONTWRITEBYTECODE: '1' }, stdout: 'piped', stderr: 'piped' }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
      const file = JSON.parse(Deno.readTextFileSync(`${demo}/state/studio-added-projects.json`));
      assertEquals(file.version, 1);
      const want = ['alpha', 'alpha' + sep + 'docs', 'beta'].map((n) => `${demo}${sep}projects${sep}${n}`);
      // the keys are the server's own (project_delete.ts projectKey) and the paths are the folders the chats work in
      assertEquals(Object.keys(file.added).sort(), want.map((p) => projectKey(p)).sort());
      for (const p of want) assertEquals(file.added[projectKey(p)].path, p);
    } finally {
      Deno.removeSync(demo, { recursive: true });
    }
  },
});
