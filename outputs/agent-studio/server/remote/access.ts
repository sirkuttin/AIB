/**
 * Phone access (Settings > Devices): the owner's switch, the connection (Tailscale for now), the Tailscale checks, the phone port's
 * listener and (Phase D) the phone's artifact port next to it, pairing and the paired phones. Off by default (<state>/phone-access.json). While it is on, AIB reads Tailscale when it
 * starts and on Check again, refuses to listen when Funnel is on for this PC's name, and keeps the phone port bound.
 */
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import type { WebContext } from '../web/server.ts';
import { Audit, type AuditEntry } from './audit.ts';
import { cleanScopes, DEFAULT_SCOPES, DeviceStore, type PublicDevice } from './devices.ts';
import { Pairing, PairingError } from './pairing.ts';
import { homePayload, TitleCache } from './payloads.ts';
import { ArtifactTickets, remoteArtifactOrigin, RemoteArtifactServer } from './artifact_server.ts';
import { BIND_RETRY_MS, PortBusy, portFree, remoteArtifactPort, remotePort } from './port.ts';
import { PushSender, VapidKeys } from './push.ts';
import { qrSvg } from './qr.ts';
import { RemoteServer } from './server.ts';
import { artifactServeCommand, readTailscale, type Runner, serveCommand, type TailscaleState } from './tailscale.ts';
import { hex } from './words.ts';

export const ACCESS_FILE = 'phone-access.json';
/** A phone's switches as Settings > Devices names them (for the activity log). */
const SCOPE_LABELS: Record<string, string> = {
  'phone.read': 'See chats',
  'phone.answer': 'Answer',
  'phone.prompt': 'Send',
  'phone.approve': 'Approve once',
  'phone.push': 'Push',
};

/** Tests only (AGENT_STUDIO_TEST=1): a shorter wait for a busy phone port (AIB_TEST_REMOTE_BIND_MS). */
function testBindRetryMs(): number | undefined {
  if (Deno.env.get('AGENT_STUDIO_TEST') !== '1') return undefined;
  const ms = Number(Deno.env.get('AIB_TEST_REMOTE_BIND_MS'));
  return ms > 0 ? ms : undefined;
}

export interface AccessProblem {
  code: 'port_busy' | 'artifact_port_busy' | 'funnel' | 'tailscale' | 'failed';
  message: string;
}

export interface AccessOptions {
  runner?: Runner;
  bindRetryMs?: number;
  isFree?: (port: number) => boolean;
  /** Ports AIB itself uses (the page and artifact ports): never chosen as the phone port. */
  avoid?: () => number[];
  /** Tests: the fetch pushes go out with (a fake push service). */
  pushFetch?: typeof fetch;
  log?: (message: string) => void;
}

export class PhoneAccess {
  readonly devices: DeviceStore;
  readonly pairing = new Pairing();
  readonly audit: Audit;
  readonly titles = new TitleCache();
  /** The VAPID keys (push-keys.json) and the sender of phone pushes (remote/push.ts). */
  readonly vapid: VapidKeys;
  readonly push: PushSender;
  on = false;
  via = 'tailscale';
  tailscale: TailscaleState | null = null;
  port: number | null = null;
  problem: AccessProblem | null = null;
  server: RemoteServer | null = null;
  /** Phase D: the artifact port (Serve's https 8443), its listener and why it is not up (the phone page works without it). */
  artifactPort: number | null = null;
  artifactServer: RemoteArtifactServer | null = null;
  artifactProblem: AccessProblem | null = null;
  /** Signed artifact links for paired phones (in memory: a restart ends them). */
  readonly tickets = new ArtifactTickets();
  #busy: Promise<void> | null = null;
  #closed = false;

  constructor(readonly ctx: WebContext, readonly stateDir: string, readonly options: AccessOptions = {}) {
    this.devices = new DeviceStore(stateDir);
    this.audit = new Audit(stateDir);
    this.vapid = new VapidKeys(stateDir);
    this.push = new PushSender(this.devices, this.vapid, options.pushFetch);
    const [status, data] = readJsonFile(inDir(stateDir, ACCESS_FILE));
    if (status === 'ok' && data && typeof data === 'object') this.on = (data as { on?: unknown }).on === true;
  }

  name(): string {
    return this.server?.listening && this.tailscale?.signedIn ? this.tailscale.name : '';
  }

  /** https://<name>:8443 while the artifact port listens, else '' (artifacts then stay "Open on your PC"). */
  artifactOrigin(): string {
    return this.artifactServer?.listening ? remoteArtifactOrigin(this.name()) : '';
  }

  /** The artifact store folder the artifact port serves ('' before the web server made it). */
  root(): string {
    return this.ctx.artifacts?.store.root ?? '';
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
    const isFree = this.options.isFree ?? portFree;
    const port = this.port ?? remotePort(this.stateDir, isFree, this.options.avoid?.() ?? []);
    this.port = port;
    this.artifactPort ??= remoteArtifactPort(this.stateDir, port, isFree, this.options.avoid?.() ?? []);
    this.tailscale = await readTailscale(port, this.options.runner, undefined, this.artifactPort);
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
    if (!this.server?.listening) {
      const server = new RemoteServer(this);
      try {
        await server.listen(port, this.#retryMs());
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
    await this.#artifactsUp();
  }

  #retryMs(): number {
    return this.options.bindRetryMs ?? testBindRetryMs() ?? BIND_RETRY_MS;
  }

  /** The artifact port, on its own fixed port: busy is reported (artifacts stay "Open on your PC"), never another port. */
  async #artifactsUp(): Promise<void> {
    this.artifactProblem = null;
    if (this.artifactServer?.listening || this.artifactPort === null) return;
    const port = this.artifactPort;
    const server = new RemoteArtifactServer(this);
    try {
      await server.listen(port, this.#retryMs());
    } catch (error) {
      if (!(error instanceof PortBusy)) throw error;
      this.artifactProblem = {
        code: 'artifact_port_busy',
        message: `Port ${port} is busy: another program uses it, so artifacts open on your PC only. Close that program, then ` +
          `click Check again.`,
      };
      this.#log(this.artifactProblem.message);
      return;
    }
    if (this.#closed || !this.on || !this.server) {
      await server.close();
      return;
    }
    this.artifactServer = server;
    this.#log(`phone artifact port listening on 127.0.0.1:${port}`);
  }

  async #down(): Promise<void> {
    const server = this.server;
    const artifacts = this.artifactServer;
    this.server = null;
    this.artifactServer = null;
    this.artifactProblem = null;
    await Promise.all([server?.close(), artifacts?.close()]);
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
        this.tailscale = await readTailscale(this.port ?? 0, this.options.runner, undefined, this.artifactPort ?? 0);
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

  async setScopes(id: unknown, scopes: unknown): Promise<PublicDevice | null> {
    if (typeof id !== 'string' || !Array.isArray(scopes)) return null;
    const device = await this.devices.setScopes(id, scopes);
    if (device) {
      const words = device.scopes.map((x) => SCOPE_LABELS[x]).join(', ');
      this.audit.write({ device: id, name: device.name, action: 'switches', result: `set on the PC: ${words}` });
    }
    return device;
  }

  /** Every phone goes, and the push keys are made new: a subscription that survived anywhere can no longer be sent to. */
  async removeAll(): Promise<number> {
    const count = await this.devices.removeAll();
    this.pairing.cancel();
    await this.vapid.rotate();
    this.audit.write({ action: 'remove all phones', result: `${count} removed on the PC; new push keys` });
    return count;
  }

  /** The newest log lines, each phone action with the title of its chat when that chat still runs (looked up now, never stored). */
  async activity(limit = 200): Promise<(AuditEntry & { chatTitle: string })[]> {
    const entries = this.audit.tail(limit);
    const titles = new Map<string, string>();
    if (entries.some((e) => e.chat)) {
      try {
        for (const c of (await homePayload(this.ctx, this.pcName(), this.titles)).chats) titles.set(c.id, c.title);
      } catch { /* the agent host is starting: ids only */ }
    }
    return entries.map((e) => ({ ...e, chat: e.chat ?? '', chatTitle: e.chat ? titles.get(e.chat) ?? '' : '' }));
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
      artifactPort: this.artifactPort,
      artifactListening: !!this.artifactServer?.listening,
      artifactCommand: this.artifactPort ? artifactServeCommand(this.artifactPort) : '',
      artifactProblem: this.artifactProblem,
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
          artifactServing: ts.artifactServing,
          artifactServingOther: ts.artifactServingOther,
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
