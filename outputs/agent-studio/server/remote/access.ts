/**
 * Phone access (Settings > Devices): the owner's switch, the connection (Tailscale for now), the Tailscale checks, the phone port's
 * listener, pairing and the paired phones. Off by default (<state>/phone-access.json). While it is on, AIB reads Tailscale when it
 * starts and on Check again, refuses to listen when Funnel is on for this PC's name, and keeps the phone port bound.
 */
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import type { WebContext } from '../web/server.ts';
import { Audit, type AuditEntry } from './audit.ts';
import { cleanScopes, DEFAULT_SCOPES, DeviceStore, type PublicDevice } from './devices.ts';
import { Pairing, PairingError } from './pairing.ts';
import { TitleCache } from './payloads.ts';
import { BIND_RETRY_MS, PortBusy, portFree, remotePort } from './port.ts';
import { qrSvg } from './qr.ts';
import { RemoteServer } from './server.ts';
import { readTailscale, type Runner, serveCommand, type TailscaleState } from './tailscale.ts';
import { hex } from './words.ts';

export const ACCESS_FILE = 'phone-access.json';

export interface AccessProblem {
  code: 'port_busy' | 'funnel' | 'tailscale' | 'failed';
  message: string;
}

export interface AccessOptions {
  runner?: Runner;
  bindRetryMs?: number;
  isFree?: (port: number) => boolean;
  /** Ports AIB itself uses (the page and artifact ports): never chosen as the phone port. */
  avoid?: () => number[];
  log?: (message: string) => void;
}

export class PhoneAccess {
  readonly devices: DeviceStore;
  readonly pairing = new Pairing();
  readonly audit: Audit;
  readonly titles = new TitleCache();
  on = false;
  via = 'tailscale';
  tailscale: TailscaleState | null = null;
  port: number | null = null;
  problem: AccessProblem | null = null;
  server: RemoteServer | null = null;
  #busy: Promise<void> | null = null;
  #closed = false;

  constructor(readonly ctx: WebContext, readonly stateDir: string, readonly options: AccessOptions = {}) {
    this.devices = new DeviceStore(stateDir);
    this.audit = new Audit(stateDir);
    const [status, data] = readJsonFile(inDir(stateDir, ACCESS_FILE));
    if (status === 'ok' && data && typeof data === 'object') this.on = (data as { on?: unknown }).on === true;
  }

  name(): string {
    return this.server?.listening && this.tailscale?.signedIn ? this.tailscale.name : '';
  }

  ownerLogin(): string {
    return this.tailscale?.login ?? '';
  }

  pcName(): string {
    return (this.tailscale?.machine || Deno.hostname()).toUpperCase();
  }

  #log(message: string): void {
    this.options.log?.(message);
  }

  /** At AIB start: bring the phone port up when Phone access is on. Runs in the background; never throws. */
  start(): Promise<void> {
    if (!this.on) return Promise.resolve();
    return this.#serialize(() => this.#bringUp());
  }

  #serialize(work: () => Promise<void>): Promise<void> {
    const run = (this.#busy ?? Promise.resolve()).then(work).catch((error) => {
      this.problem = { code: 'failed', message: `Phone access could not start: ${error instanceof Error ? error.message : String(error)}` };
      this.#log(this.problem.message);
    });
    this.#busy = run;
    return run;
  }

  async #bringUp(): Promise<void> {
    if (this.#closed || !this.on) return;
    this.problem = null;
    const port = this.port ?? remotePort(this.stateDir, this.options.isFree ?? portFree, this.options.avoid?.() ?? []);
    this.port = port;
    this.tailscale = await readTailscale(port, this.options.runner);
    const ts = this.tailscale;
    if (!ts.signedIn) {
      await this.#down();
      this.problem = {
        code: 'tailscale',
        message: ts.problem === 'not_installed'
          ? 'Tailscale was not found on this PC. Install it, sign in, then click Check again.'
          : ts.problem === 'signed_out'
          ? 'Tailscale is not signed in on this PC. Sign in to Tailscale, then click Check again.'
          : 'Tailscale is not running on this PC. Start it, then click Check again.',
      };
      return;
    }
    if (ts.funnel) {
      await this.#down();
      this.problem = {
        code: 'funnel',
        message: `Tailscale Funnel is on for ${ts.name}, which puts it on the public internet. Phone access stays off until Funnel ` +
          `is off for this name (tailscale funnel reset), then click Check again.`,
      };
      this.audit.write({ action: 'phone port', result: 'refused to start: Funnel is on' });
      return;
    }
    if (this.server?.listening) return;
    const server = new RemoteServer(this);
    try {
      await server.listen(port, this.options.bindRetryMs ?? BIND_RETRY_MS);
    } catch (error) {
      if (!(error instanceof PortBusy)) throw error;
      this.problem = {
        code: 'port_busy',
        message: `Port ${port} is busy: another program uses it, so phones cannot reach AIB. Close that program, then click ` +
          `Check again.`,
      };
      this.#log(this.problem.message);
      return;
    }
    if (this.#closed || !this.on) {
      await server.close();
      return;
    }
    this.server = server;
    this.#log(`phone port listening on 127.0.0.1:${port} for ${ts.name}`);
  }

  async #down(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  async setOn(on: boolean): Promise<void> {
    this.on = on;
    saveJson(inDir(this.stateDir, ACCESS_FILE), { version: 1, on, via: this.via }, 'phone-access-');
    this.audit.write({ action: 'phone access', result: on ? 'turned on' : 'turned off' });
    if (on) await this.#serialize(() => this.#bringUp());
    else {
      await this.#serialize(async () => {
        this.pairing.cancel();
        this.problem = null;
        await this.#down();
      });
    }
  }

  /** Check again: read Tailscale once more; start the phone port if it can now, stop it if Funnel came on. */
  check(): Promise<void> {
    if (!this.on) {
      return this.#serialize(async () => {
        this.tailscale = await readTailscale(this.port ?? 0, this.options.runner);
      });
    }
    return this.#serialize(() => this.#bringUp());
  }

  async close(): Promise<void> {
    this.#closed = true;
    await (this.#busy ?? Promise.resolve()).catch(() => {});
    await this.devices.flush();
    await this.#down();
  }

  url(): string {
    const name = this.name();
    return name ? `https://${name}/phone.html` : '';
  }

  startPairing(): { words: string[]; url: string; qr: string; expiresAt: number } {
    if (!this.on || !this.name()) throw new PairingError(409, 'not_ready', 'Phone access is not ready yet. Finish the steps above first.');
    const code = this.pairing.start();
    const url = `${this.url()}#p=${hex(code.secret)}`;
    this.audit.write({ action: 'pairing code', result: 'shown on the PC' });
    return { words: code.words, url, qr: qrSvg(url), expiresAt: code.expiresAt };
  }

  async approve(id: unknown, scopes: unknown): Promise<PublicDevice> {
    const claim = this.pairing.get(id);
    if (!claim || claim.state !== 'pending') {
      throw new PairingError(404, 'no_claim', 'That phone is no longer waiting. Ask it to scan the code again.');
    }
    const added = await this.devices.add({
      name: claim.name,
      login: claim.login,
      scopes: cleanScopes(scopes === undefined ? DEFAULT_SCOPES : scopes),
    });
    this.pairing.approve(id, {
      token: added.token,
      cookie: added.cookie,
      device: { id: added.device.id, name: added.device.name, scopes: added.device.scopes },
    });
    this.audit.write({ device: added.device.id, name: added.device.name, action: 'pair', result: 'approved on the PC' });
    return added.device;
  }

  reject(id: unknown): boolean {
    const claim = this.pairing.reject(id);
    if (claim) this.audit.write({ name: claim.name, action: 'pair', result: 'rejected on the PC' });
    return !!claim;
  }

  async remove(id: unknown): Promise<boolean> {
    if (typeof id !== 'string') return false;
    const device = this.devices.devices.get(id);
    const removed = await this.devices.remove(id);
    if (removed) this.audit.write({ device: id, name: device?.name ?? '', action: 'remove', result: 'removed on the PC' });
    return removed;
  }

  async removeAll(): Promise<number> {
    const count = await this.devices.removeAll();
    this.pairing.cancel();
    this.audit.write({ action: 'remove all phones', result: `${count} removed on the PC` });
    return count;
  }

  activity(limit = 200): AuditEntry[] {
    return this.audit.tail(limit);
  }

  /** Everything Settings > Devices draws. No tokens, no pairing secret except the open code's own words, URL and QR. */
  view(): Record<string, unknown> {
    const ts = this.tailscale;
    const code = this.pairing.open();
    const used = this.pairing.code;
    return {
      on: this.on,
      via: this.via,
      port: this.port,
      listening: !!this.server?.listening,
      url: this.url(),
      problem: this.problem,
      serveCommand: this.port ? serveCommand(this.port) : '',
      tailscale: ts
        ? {
          installed: ts.installed,
          signedIn: ts.signedIn,
          name: ts.name,
          machine: ts.machine,
          tailnet: ts.tailnet,
          login: ts.login,
          https: ts.https,
          serving: ts.serving,
          servingOther: ts.servingOther,
          funnel: ts.funnel,
          problem: ts.problem,
          checkedAt: ts.checkedAt,
        }
        : null,
      devices: this.devices.list(),
      devicesWarning: this.devices.warning,
      pairing: {
        open: code
          ? { words: code.words, expiresAt: code.expiresAt, claimed: code.claimed, wrong: code.wrong, anotherTried: code.anotherTried }
          : null,
        anotherTried: !!used?.anotherTried,
        pending: this.pairing.pending().map((c) => ({ id: c.id, name: c.name, checkWords: c.checkWords, createdAt: c.createdAt })),
      },
    };
  }
}
