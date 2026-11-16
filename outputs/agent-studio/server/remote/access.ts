/**
 * Phone access (Settings > Remote control): the owner's switch, the connection (Tailscale for now), the Tailscale checks and setup
 * buttons (remote/setup.ts), the phone port's listener and (Phase D) the phone's artifact port next to it, pairing and the paired
 * phones. Off by default (<state>/phone-access.json, which also remembers whether AIB shared itself on Tailscale and whether a share
 * still has to be removed). While it is on, AIB reads Tailscale when it starts, on Check again and while Remote control is on
 * screen, refuses to listen when Funnel is on for this PC's name, and keeps the phone port bound.
 */
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import type { WebContext } from '../web/server.ts';
import { Audit, type AuditEntry } from './audit.ts';
import { cleanKind, cleanScopes, COMPUTER_SCOPES, DEFAULT_SCOPES, DeviceStore, type PublicDevice } from './devices.ts';
import { Pairing, PairingError } from './pairing.ts';
import { homePayload, TitleCache } from './payloads.ts';
import { SavedChats } from './saved.ts';
import { ArtifactTickets, remoteArtifactOrigin, RemoteArtifactServer } from './artifact_server.ts';
import { BIND_RETRY_MS, PortBusy, portFree, remoteArtifactPort, remotePort } from './port.ts';
import { PushSender, VapidKeys } from './push.ts';
import { qrSvg } from './qr.ts';
import { RemoteServer } from './server.ts';
import { artifactServeCommand, readTailscale, type Runner, serveCommand, type TailscaleState } from './tailscale.ts';
import { defaultEnv, funnelText, type SetupEnv, type SetupHost, TailscaleSetup } from './setup.ts';
import { hex } from './words.ts';
import { DeviceSockets, type SocketKind } from './pc_sockets.ts';
import { DeviceViewPrefs } from './pc_page.ts';

export const ACCESS_FILE = 'phone-access.json';
/** A phone's switches as Settings > Remote control names them (for the activity log). */
const SCOPE_LABELS: Record<string, string> = {
  'phone.read': 'See chats',
  'phone.answer': 'Answer',
  'phone.prompt': 'Send',
  'phone.start': 'Start chats',
  'phone.approve': 'Approve once',
  'phone.push': 'Push',
  'pc.always': 'Allow always',
  'pc.files': 'Files',
  'pc.terminal': 'Terminal',
  'pc.projects': 'Projects',
};

/** The switches a paired computer's open socket needs: the terminal needs Terminal; the live doc editor writes, so it needs Send. */
const SOCKET_NEEDS: Record<SocketKind, string[]> = {
  terminal: ['pc.terminal'],
  docs: ['phone.read', 'phone.prompt'],
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
  /** Tests: the setup buttons' programs, downloads and browser (remote/setup.ts SetupEnv), over the real ones. */
  setupEnv?: Partial<SetupEnv>;
  log?: (message: string) => void;
}

export class PhoneAccess implements SetupHost {
  readonly devices: DeviceStore;
  readonly pairing = new Pairing();
  readonly audit: Audit;
  readonly titles = new TitleCache();
  /** The chats that are not running, for the phone (remote/saved.ts). */
  readonly saved = new SavedChats();
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
  /** Signed artifact links for paired phones (in memory: a restart ends them). Each is checked against the device store on every
   * request, so a removed device's links stop working at once (artifact_server.ts). */
  readonly tickets = new ArtifactTickets();
  /** The terminal and doc sockets of paired computers, by device (phase 1c): Remove closes them at once; the rest is rechecked every
   * second and on each message (remote/pc_sockets.ts). */
  readonly sockets: DeviceSockets;
  /** The setup buttons (Install, Sign in, Turn on HTTPS, Share AIB, Stop sharing, Turn off Funnel). */
  readonly setup: TailscaleSetup;
  /** AIB shared itself on Tailscale (Share AIB worked) and the owner has not stopped sharing since. */
  shared = false;
  /** Switched off while Tailscale was not running: AIB's shares are removed once it runs again. */
  pendingUnshare = false;
  #busy: Promise<void> | null = null;
  #closed = false;
  #reading: Promise<TailscaleState> | null = null;
  #readAt = 0;

  constructor(readonly ctx: WebContext, readonly stateDir: string, readonly options: AccessOptions = {}) {
    this.devices = new DeviceStore(stateDir);
    this.audit = new Audit(stateDir);
    this.vapid = new VapidKeys(stateDir);
    this.push = new PushSender(this.devices, this.vapid, options.pushFetch);
    this.sockets = new DeviceSockets({ allowed: (id, kind) => this.socketAllowed(id, kind) });
    const [status, data] = readJsonFile(inDir(stateDir, ACCESS_FILE));
    if (status === 'ok' && data && typeof data === 'object') {
      const d = data as { on?: unknown; shared?: unknown; pendingUnshare?: unknown };
      this.on = d.on === true;
      this.shared = d.shared === true;
      this.pendingUnshare = d.pendingUnshare === true;
    }
    this.setup = new TailscaleSetup(this, stateDir, { ...defaultEnv(), ...options.setupEnv });
  }

  #saveAccess(): void {
    saveJson(
      inDir(this.stateDir, ACCESS_FILE),
      { version: 1, on: this.on, via: this.via, shared: this.shared, pendingUnshare: this.pendingUnshare },
      'phone-access-',
    );
  }

  // ---- SetupHost (remote/setup.ts) -------------------------------------------------------------------------------------------
  get listening(): boolean {
    return !!this.server?.listening;
  }
  get artifactListening(): boolean {
    return !!this.artifactServer?.listening;
  }
  get artifactProblemMessage(): string {
    return this.artifactProblem?.message ?? '';
  }
  get portProblemMessage(): string {
    return this.problem?.code === 'port_busy' ? this.problem.message : '';
  }
  markShared(shared: boolean): void {
    if (this.shared === shared) return;
    this.shared = shared;
    this.#saveAccess();
  }
  setPendingUnshare(pending: boolean): void {
    if (this.pendingUnshare === pending) return;
    this.pendingUnshare = pending;
    this.#saveAccess();
  }
  note(action: string, result: string): void {
    this.audit.write({ action, result });
  }

  /** Read Tailscale now (a read already running is joined). */
  readFresh(): Promise<TailscaleState> {
    return this.#read(0);
  }
  /** Read Tailscale unless a read finished less than 2.5 s ago (the page and a waiting job poll every 3 s; one read serves both). */
  readCached(): Promise<TailscaleState> {
    return this.#read(2500);
  }
  #read(maxAgeMs: number): Promise<TailscaleState> {
    if (this.#reading) return this.#reading;
    if (maxAgeMs && this.tailscale && Date.now() - this.#readAt < maxAgeMs) return Promise.resolve(this.tailscale);
    const reading = readTailscale(this.port ?? 0, this.options.runner, undefined, this.artifactPort ?? 0).then((ts) => {
      this.tailscale = ts;
      this.#readAt = Date.now();
      return ts;
    }).finally(() => {
      this.#reading = null;
    });
    this.#reading = reading;
    return reading.then((ts) => {
      this.setup.onRead(ts);
      return ts;
    });
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
    return this.#serialize(async () => {
      await this.#bringUp();
      // owner answer 1: a share that went missing is never added again silently; the PC page shows a notice with Share again
      const ts = this.tailscale;
      if (this.shared && ts?.signedIn && ts.https && !ts.serving && !ts.funnel && this.listening) this.setup.missingAtStart = true;
    });
  }

  #serialize(work: () => Promise<void>): Promise<void> {
    const run = (this.#busy ?? Promise.resolve()).then(work).catch((error) => {
      this.problem = { code: 'failed', message: `Phone access could not start: ${error instanceof Error ? error.message : String(error)}` };
      this.#log(this.problem.message);
    });
    this.#busy = run;
    return run;
  }

  /** `quick` (the page's 3 s / 30 s refresh): a read up to 2.5 s old is fine (unless `fresh`: a setup terminal just finished) and a
   * busy port is tried once, without the 20 s wait. */
  async #bringUp(quick = false, fresh = false): Promise<void> {
    if (this.#closed || !this.on) return;
    const before = this.problem;
    this.problem = null;
    const isFree = this.options.isFree ?? portFree;
    const port = this.port ?? remotePort(this.stateDir, isFree, this.options.avoid?.() ?? []);
    this.port = port;
    this.artifactPort ??= remoteArtifactPort(this.stateDir, port, isFree, this.options.avoid?.() ?? []);
    const ts = quick && !fresh ? await this.readCached() : await this.readFresh();
    if (!ts.signedIn) {
      await this.#down();
      this.problem = {
        code: 'tailscale',
        message: ts.problem === 'not_installed'
          ? "Tailscale isn't installed on this PC."
          : ts.problem === 'signed_out'
          ? "Tailscale isn't signed in on this PC."
          : ts.problem === 'stopped'
          ? 'Tailscale is switched off on this PC.'
          : ts.problem === 'needs_machine_auth'
          ? 'Your tailnet admin needs to approve this PC in Tailscale.'
          : ts.problem === 'starting'
          ? 'Tailscale is starting.'
          : "Tailscale isn't running on this PC.",
      };
      return;
    }
    if (ts.funnel) {
      await this.#down();
      this.problem = { code: 'funnel', message: funnelText(ts) };
      if (before?.code !== 'funnel') this.audit.write({ action: 'phone port', result: 'refused to start: Funnel is on' });
      return;
    }
    if (!this.server?.listening) {
      const server = new RemoteServer(this);
      try {
        if (quick && !(this.options.isFree ?? portFree)(port)) throw new PortBusy(port);
        await server.listen(port, quick ? 0 : this.#retryMs());
      } catch (error) {
        if (!(error instanceof PortBusy)) throw error;
        this.problem = {
          code: 'port_busy',
          message: `Port ${port} is busy. Another program on this PC uses it, so phones can't reach AIB. AIB keeps this port so ` +
            `your setup doesn't change. Close that program, and AIB opens the port by itself.`,
        };
        if (before?.code !== 'port_busy') this.#log(this.problem.message);
        return;
      }
      if (this.#closed || !this.on) {
        await server.close();
        return;
      }
      this.server = server;
      this.#log(`phone port listening on 127.0.0.1:${port} for ${ts.name}`);
    }
    await this.#artifactsUp(quick);
  }

  #retryMs(): number {
    return this.options.bindRetryMs ?? testBindRetryMs() ?? BIND_RETRY_MS;
  }

  /** The artifact port, on its own fixed port: busy is reported (artifacts stay "Open on your PC"), never another port. */
  async #artifactsUp(quick = false): Promise<void> {
    this.artifactProblem = null;
    if (this.artifactServer?.listening || this.artifactPort === null) return;
    const port = this.artifactPort;
    const server = new RemoteArtifactServer(this);
    try {
      if (quick && !(this.options.isFree ?? portFree)(port)) throw new PortBusy(port);
      await server.listen(port, quick ? 0 : this.#retryMs());
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

  /** May this device still hold a socket of this kind: paired, a computer, and the switch on. In memory only (called per message). */
  socketAllowed(id: string, kind: SocketKind): boolean {
    const d = this.devices.devices.get(id);
    if (!d || d.kind !== 'computer') return false;
    return SOCKET_NEEDS[kind].every((s) => (d.scopes as string[]).includes(s));
  }

  /** A removed computer's own layout file goes too (phase 1b's per-device view prefs), also while the phone port is down. */
  #forgetLayout(id: string): void {
    (this.server?.pcPrefs ?? new DeviceViewPrefs(this.stateDir, () => this.ctx.viewPrefs)).forget(id);
  }

  async #down(): Promise<void> {
    this.sockets.closeAll(); // the port is going away: a computer's open terminal or doc goes with it
    const server = this.server;
    const artifacts = this.artifactServer;
    this.server = null;
    this.artifactServer = null;
    this.artifactProblem = null;
    await Promise.all([server?.close(), artifacts?.close()]);
  }

  async setOn(on: boolean): Promise<void> {
    this.on = on;
    this.#saveAccess();
    this.audit.write({ action: 'phone access', result: on ? 'turned on' : 'turned off' });
    if (on) {
      await this.#serialize(() => this.#bringUp());
      // decision 5: switching on shares again with no extra click when AIB was shared before (a click on the switch)
      const ts = this.tailscale;
      if (this.shared && ts?.signedIn && ts.https && !ts.serving && !ts.funnel && this.listening) await this.setup.run('share', {});
    } else {
      await this.#serialize(async () => {
        this.pairing.cancel();
        this.problem = null;
        await this.#down();
      });
      // decision 5: switching off also stops sharing (after the port closed; runs in the background)
      this.setup.afterOff();
    }
  }

  settle(): Promise<void> {
    return this.refresh(true);
  }

  /** The page's re-check (every 3 s while a setup step waits, every 30 s otherwise): a cached read, no 20 s bind wait. */
  refresh(fresh = false): Promise<void> {
    if (!this.on) return (fresh ? this.readFresh() : this.readCached()).then(() => {});
    return this.#serialize(() => this.#bringUp(true, fresh));
  }

  /** Check again: read Tailscale once more; start the phone port if it can now, stop it if Funnel came on. */
  check(): Promise<void> {
    if (!this.on) {
      return this.#serialize(async () => {
        await this.readFresh();
      });
    }
    return this.#serialize(() => this.#bringUp());
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.setup.close();
    await (this.#busy ?? Promise.resolve()).catch(() => {});
    await this.devices.flush();
    await this.#down();
    this.sockets.closeAll();
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

  /** `kind` is the approver's choice on the PC (MF13: never the claimant's own word); a computer starts with every switch on
   * (lead call 2a) unless the approver sent its switches. */
  async approve(id: unknown, scopes: unknown, kindValue: unknown = 'phone'): Promise<PublicDevice> {
    const kind = cleanKind(kindValue);
    const claim = this.pairing.get(id);
    if (!claim || claim.state !== 'pending') {
      throw new PairingError(404, 'no_claim', 'That phone is no longer waiting. Ask it to scan the code again.');
    }
    const added = await this.devices.add({
      name: claim.name,
      login: claim.login,
      scopes: cleanScopes(scopes === undefined ? (kind === 'computer' ? COMPUTER_SCOPES : DEFAULT_SCOPES) : scopes, kind),
      kind,
    });
    this.pairing.approve(id, {
      token: added.token,
      cookie: added.cookie,
      device: { id: added.device.id, name: added.device.name, scopes: added.device.scopes },
    });
    this.audit.write({
      device: added.device.id,
      name: added.device.name,
      action: 'pair',
      result: kind === 'computer' ? 'approved on the PC as a computer' : 'approved on the PC',
    });
    return added.device;
  }

  reject(id: unknown): boolean {
    const claim = this.pairing.reject(id);
    if (claim) this.audit.write({ name: claim.name, action: 'pair', result: 'rejected on the PC' });
    return !!claim;
  }

  /**
   * Remove one device: everything is cut in this one step (design v2 section 6). The token (its next call gets 401 not_paired), its
   * push subscription (it is part of the record), its artifact links (each is checked against the store), its open terminal and doc
   * sockets (closed here, at once), its rate-limit bucket, its own layout file. Previews (phase 7) will add their forward here.
   */
  async remove(id: unknown): Promise<boolean> {
    if (typeof id !== 'string') return false;
    const device = this.devices.devices.get(id);
    const removed = await this.devices.remove(id);
    if (removed) {
      const closed = this.sockets.closeDevice(id);
      this.server?.bridge.limit.forget(id);
      this.#forgetLayout(id);
      this.audit.write({
        device: id,
        name: device?.name ?? '',
        action: 'remove',
        result: closed ? `removed on the PC; ${closed} open ${closed === 1 ? 'socket' : 'sockets'} closed` : 'removed on the PC',
      });
      this.ctx.presence.leavePhone(id, 'removed'); // no longer holds news back as "in hand"
    }
    return removed;
  }

  async setScopes(id: unknown, scopes: unknown): Promise<PublicDevice | null> {
    if (typeof id !== 'string' || !Array.isArray(scopes)) return null;
    const device = await this.devices.setScopes(id, scopes);
    if (device) {
      this.sockets.recheck(); // Terminal (or Send) turned off: its open socket closes now, not on the next tick
      const words = device.scopes.map((x) => SCOPE_LABELS[x]).join(', ');
      this.audit.write({ device: id, name: device.name, action: 'switches', result: `set on the PC: ${words}` });
    }
    return device;
  }

  /** Phone / Computer on a paired device's row. Open sockets are re-checked now; the device's page loads the other page next time. */
  async setKind(id: unknown, kindValue: unknown): Promise<PublicDevice | null> {
    if (typeof id !== 'string' || (kindValue !== 'phone' && kindValue !== 'computer')) return null;
    const device = await this.devices.setKind(id, kindValue);
    if (device) {
      this.sockets.recheck(); // a phone may not hold a terminal: the 1 s check would close it anyway
      this.audit.write({
        device: id,
        name: device.name,
        action: 'kind',
        result: `${device.name} is now a ${kindValue}`,
      });
    }
    return device;
  }

  async setRemind(id: unknown, remind: unknown): Promise<PublicDevice | null> {
    if (typeof id !== 'string' || typeof remind !== 'boolean') return null;
    const device = await this.devices.setRemind(id, remind);
    if (device) this.audit.write({ device: id, name: device.name, action: 'silent reminders', result: remind ? 'on' : 'off' });
    return device;
  }

  /** Every phone goes, and the push keys are made new: a subscription that survived anywhere can no longer be sent to. */
  async removeAll(): Promise<number> {
    const ids = [...this.devices.devices.keys()];
    const count = await this.devices.removeAll();
    this.sockets.closeAll('device removed');
    for (const id of ids) {
      this.ctx.presence.leavePhone(id, 'removed');
      this.server?.bridge.limit.forget(id);
      this.#forgetLayout(id);
    }
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

  /** Everything Settings > Remote control draws. No tokens, no pairing secret except the open code's own words, URL and QR. */
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
          funnelPorts: ts.funnelPorts,
          otherNames: ts.otherNames,
          backend: ts.backend,
          problem: ts.problem,
          checkedAt: ts.checkedAt,
        }
        : null,
      setup: this.setup.view(ts),
      // phase 2: "Active now" on the row of the device you are using (attention/presence.ts where())
      devices: (() => {
        const where = this.ctx.presence.where();
        const active = where && where.who !== 'pc' ? where.device : '';
        return this.devices.list().map((d) => (d.id === active ? { ...d, active: true } : d));
      })(),
      devicesWarning: this.devices.warning,
      pairing: {
        open: code
          ? { words: code.words, expiresAt: code.expiresAt, claimed: code.claimed, wrong: code.wrong, anotherTried: code.anotherTried }
          : null,
        anotherTried: !!used?.anotherTried,
        pending: this.pairing.pending().map((c) => ({
          id: c.id,
          name: c.name,
          checkWords: c.checkWords,
          createdAt: c.createdAt,
          hint: c.hint,
        })),
      },
    };
  }
}
