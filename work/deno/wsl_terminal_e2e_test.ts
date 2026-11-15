/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): a project terminal of a WSL project is the distro's login shell in the Linux
 * folder, a PTY of the distro's Linux keeper, titled "<shell> (<distro>)", and it resizes (design section 7, wsl_terminal_e2e).
 */
import { assert, assertEquals } from './_assert.ts';
import { until } from './_connection.ts';
import { cleanRoot, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { TerminalSessions } from '../../outputs/agent-studio/server/terminal/sessions.ts';
import type { WsLink } from '../../outputs/agent-studio/server/platform/websocket.ts';

class Link implements WsLink {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  get isOpen() {
    return !this.closed;
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  get messages(): Record<string, unknown>[] {
    return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s as string));
  }
  get output(): string {
    return this.sent.filter((s) => typeof s !== 'string').map((b) => new TextDecoder().decode(b as Uint8Array)).join('');
  }
}

Deno.test({
  name: 'wsl e2e: the project terminal is the distro login shell in the Linux folder, and it resizes',
  ...T,
  async fn() {
    await prepareRoot();
    const sessions = new TerminalSessions({ keeper: null });
    try {
      await readyHost();
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const link = new Link();
      sessions.attach(link, 'e2e:wsl', ref, 100, 30);
      await until(() => link.messages.some((m) => m.type === 'ready'), 'ready', 60);
      const ready = link.messages.find((m) => m.type === 'ready')!;
      assert(/ \(.+\)$/.test(String(ready.shellName)), String(ready.shellName));
      link.onmessage?.(JSON.stringify({ type: 'input', data: 'pwd; stty size\r' }));
      await until(() => link.output.includes(`${ROOT}/repo`) && link.output.includes('30 100'), 'pwd and size', 30);
      link.onmessage?.(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      link.onmessage?.(JSON.stringify({ type: 'input', data: 'stty size\r' }));
      await until(() => link.output.includes('40 120'), 'the new size', 30);
      assertEquals(sessions.list().length, 1);
    } finally {
      await sessions.endAll();
      await cleanRoot();
    }
  },
});
