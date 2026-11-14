/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a program in the distro that opens a page through BROWSER (the aib-open shim)
 * reaches AIB's URL gate (design section 7, wsl_browser_shim_e2e): asked first outside a sign-in, opened at once within 5 minutes of
 * one, and a file: URL is refused. A recorder stands in for the browser: nothing opens on the screen.
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, recordUrls, ROOT, T } from './_wsl_e2e.ts';
import { urlGate } from '../../outputs/agent-studio/server/wsl/open_urls.ts';

Deno.test({
  name: 'wsl e2e: the BROWSER shim reaches the gate: asked first, opened in a sign-in window, file: refused',
  ...T,
  async fn() {
    await prepareRoot();
    const opened = recordUrls();
    try {
      const host = await readyHost();
      const env = await host.env();
      const browser = env.BROWSER;
      assert(browser && browser.startsWith('/'), `BROWSER is the shim: ${browser}`);
      assert(env.AIB_OPEN_FIFO?.startsWith('/'), `the shim's FIFO is in the agents' environment: ${env.AIB_OPEN_FIFO}`);
      // as an agent runs it: with the environment AIB gives agents in the distro (BROWSER, AIB_OPEN_FIFO)
      const run = (url: string) => inDistro('AIB_OPEN_FIFO="$3" "$1" "$2"', [browser, url, env.AIB_OPEN_FIFO]);
      await run('https://example.com/asked');
      await until(() => urlGate.waiting().some((w) => w.url === 'https://example.com/asked'), 'the question', 30);
      assertEquals(opened, []);
      urlGate.signInStarted(KEY);
      await run('https://example.com/signin');
      await until(() => opened.includes('https://example.com/signin'), 'opened in the sign-in window', 30);
      await run('file:///etc/passwd');
      await new Promise((r) => setTimeout(r, 2000));
      assert(!opened.some((u) => u.startsWith('file:')) && !urlGate.waiting().some((w) => w.url.startsWith('file:')));
      void ROOT;
    } finally {
      urlGate.setForTests(null);
      await cleanRoot();
    }
  },
});
