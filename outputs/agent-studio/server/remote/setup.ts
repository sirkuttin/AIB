/**
 * Settings > Remote control's setup buttons (approved design aib-remote-setup.html, 2026-11-12; architect review
 * remote-setup-review.md): Install Tailscale, Start Tailscale, Sign in to Tailscale, Turn Tailscale on, Turn on HTTPS, Share AIB,
 * Stop sharing and Turn off Funnel. Each click is one fixed action name (never a command from the page); long work runs as a job the
 * page reads back (GET /api/live/devices/tailscale/job). Every command that changes something goes into "What AIB changed on this
 * PC" (<state>/remote-changes.json) and one Phone activity line.
 *
 * Rules: AIB changes Tailscale only on a click that says so. It never turns Funnel on and never runs serve reset, funnel reset,
 * down, logout, an uninstaller, or any `tailscale set` except the Linux operator line (in the setup terminal). `--yes` is passed
 * only after a "Replace and share" click. Stop sharing and switching off switch a port off only when it points at AIB's port.
 *
 * The sign-in link (login.tailscale.com/a/...) is a secret: it is opened in the browser by the server, kept in memory for the job
 * (the page's "Open the sign-in page again" link), never logged, never saved and never sent to the phone routes.
 *
 * Owner answers (2026-11-12):
 *  1. At AIB start with the switch on, a share that went missing is never added again silently: the PC page shows an in-app notice
 *     (missingAtStart) whose Share again button runs the same Share AIB click (so replacing anything still asks first).
 *  2. When the artifact share (8443) fails, the phone share stays and the page says "Artifacts open on your PC only" with the
 *     reason. No rollback.
 */
import { inDir } from "../state/base.ts";
import { readJsonFile, saveJson } from "../state/json.ts";
import { hasWinget as betaHasWinget } from "../agents/beta_setup.ts";
import {
  APP_STORE_URL,
  DOWNLOAD_PAGE,
  hex,
  LINUX_INSTALL,
  LINUX_OPERATOR,
  LINUX_START,
  msiOutcome,
  pickMsi,
  pickPkg,
  PKGS_BASE,
  pkgutilOk,
  publishedSha,
  sha256File,
  SIGNATURE_SCRIPT,
  signatureOk,
  spctlOk,
  windowsArch,
  WINGET_ARGS,
  wingetOutcome,
} from "./install.ts";
import {
  defaultSpawner,
  hookArgv,
  type Proc,
  RefusedInTest,
  setupOs,
  shown,
  type Spawner,
  testMode,
  type Tool,
} from "./setup_cli.ts";
import {
  artifactServeCommand,
  serveCommand,
  type TailscaleState,
} from "./tailscale.ts";

export const CHANGES_FILE = "remote-changes.json";

export const ADMIN_DNS = "https://login.tailscale.com/admin/dns";
export const ADMIN_MACHINES = "https://login.tailscale.com/admin/machines";
const LOGIN_LINK = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9_-]+/;
const HTTPS_LINK = /https:\/\/login\.tailscale\.com\/f\/serve\?[^\s"'<>]+/;
const MAX_CHANGES = 50;
const DETAIL_LINES = 20;

/** A Tailscale link AIB may open: https, login.tailscale.com, the sign-in (/a/) or Serve (/f/serve) page. '' otherwise. */
export function safeLink(text: string, kind: "login" | "https"): string {
  const m = text.match(kind === "login" ? LOGIN_LINK : HTTPS_LINK);
  if (!m) return "";
  try {
    const url = new URL(m[0]);
    if (url.protocol !== "https:" || url.hostname !== "login.tailscale.com") {
      return "";
    }
    if (
      kind === "login"
        ? !url.pathname.startsWith("/a/")
        : url.pathname !== "/f/serve"
    ) return "";
    return url.href;
  } catch {
    return "";
  }
}

/** A line with every sign-in link taken out (for Show details and logs). */
export function scrub(line: string): string {
  return line.replace(new RegExp(LOGIN_LINK.source, "g"), "<sign-in link>");
}

export interface Change {
  time: number;
  /** What happened, as the page says it ("Shared AIB"). */
  label: string;
  /** The command as it ran, with the program's plain name (never a sign-in link). */
  command: string;
  ok: boolean;
  /** One short line: what came of it, or how to undo it. */
  note: string;
}

/** <state>/remote-changes.json: the newest MAX_CHANGES changes, oldest first. */
export class Changes {
  readonly path: string | null;
  constructor(stateDir: string | null) {
    this.path = stateDir ? inDir(stateDir, CHANGES_FILE) : null;
  }
  list(): Change[] {
    if (!this.path) return [];
    const [status, data] = readJsonFile(this.path);
    if (status !== "ok" || !data || typeof data !== "object") return [];
    const rows = (data as { changes?: unknown }).changes;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is Change =>
      !!r && typeof r === "object" && typeof (r as Change).label === "string" &&
      typeof (r as Change).command === "string"
    );
  }
  add(change: Change): void {
    if (!this.path) return;
    const all = [...this.list(), change].slice(-MAX_CHANGES);
    saveJson(this.path, { version: 1, changes: all }, "remote-changes-");
  }
}

export interface SetupEnv {
  spawn: Spawner;
  fetch: typeof fetch;
  /** Open a Tailscale page in the browser (the URL was checked by safeLink or is a fixed admin page). */
  openUrl: (url: string) => void;
  os: () => "windows" | "darwin" | "linux";
  env: (name: string) => string | undefined;
  hasWinget: () => boolean;
  pkgsBase: () => string;
  tempDir: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Re-read every this many ms while a job waits (3 s). */
  waitMs: number;
  /** Sign-in: no link after this many ms -> "Open Tailscale and sign in there" (15 s). */
  noLinkMs: number;
  /** macOS: the downloaded .pkg is kept at most this long (1 h). */
  pkgKeepMs: number;
}

const HOSTS_AIB_OPENS = new Set([
  "login.tailscale.com",
  "tailscale.com",
  "apps.apple.com",
]);

/** The browser opener: the system's own (rundll32 / open / xdg-open), or under AGENT_STUDIO_TEST=1 only the AIB_OPEN_CLI fake. */
export function defaultOpenUrl(url: string): void {
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return;
    host = u.hostname;
  } catch {
    return;
  }
  if (!HOSTS_AIB_OPENS.has(host)) return;
  const fake = hookArgv("AIB_OPEN_CLI");
  if (!fake && testMode()) return; // a test never opens the real browser
  const [cmd, args] = fake
    ? [fake[0], [...fake.slice(1), "url", url]]
    : Deno.build.os === "windows"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : Deno.build.os === "darwin"
    ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = new Deno.Command(cmd as string, {
      args: args as string[],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    child.status.catch(() => {});
  } catch { /* no browser */ }
}

export function defaultEnv(): SetupEnv {
  let winget: [number, boolean] | null = null;
  return {
    spawn: defaultSpawner,
    fetch: (input, init) => fetch(input, init),
    openUrl: defaultOpenUrl,
    os: setupOs,
    env: (name) => Deno.env.get(name),
    hasWinget: () => {
      if (testMode()) return hookArgv("AIB_WINGET_CLI") !== null;
      if (!winget || Date.now() - winget[0] > 30_000) {
        winget = [Date.now(), betaHasWinget(Deno.env.toObject(), "windows")];
      }
      return winget[1];
    },
    pkgsBase: () => {
      if (!testMode()) return PKGS_BASE;
      const base = Deno.env.get("AIB_PKGS_BASE");
      if (!base) throw new RefusedInTest("shell");
      return base.replace(/\/+$/, "");
    },
    tempDir: () => Deno.makeTempDir({ prefix: "aib-tailscale-" }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    waitMs: Number(testMode() && Deno.env.get("AIB_TEST_SETUP_WAIT_MS")) ||
      3000,
    noLinkMs: Number(testMode() && Deno.env.get("AIB_TEST_SETUP_NOLINK_MS")) ||
      15_000,
    pkgKeepMs: 3_600_000,
  };
}

export type JobAction =
  | "install"
  | "login"
  | "up"
  | "https"
  | "share"
  | "unshare"
  | "funnel-off";
export type JobState = "running" | "waiting" | "done" | "failed" | "cancelled";
export interface ProgressItem {
  text: string;
  state: "done" | "now" | "todo";
}

let jobCounter = 0;

/** One click's work: what the page shows while it runs and after it ends. */
export class Job {
  readonly id = String(++jobCounter);
  state: JobState = "running";
  /** A finer point the page uses: 'browser' (sign-in page open), 'no_link', 'https' (waiting for HTTPS), 'installer' (macOS). */
  phase = "";
  progress: ProgressItem[] = [];
  message = "";
  /** Why it failed, for the page: declined, busy, checksum, signature, no_checksum, flags, operator, failed, refused, ... */
  code = "";
  /** A command the owner can copy and run instead when this failed. */
  fallback = "";
  /** The sign-in link (secret: memory only, the PC page's fallback link). */
  link = "";
  /** "ask your admin" and other lines from Tailscale worth showing as they are. */
  notice = "";
  reboot = false;
  cancellable = true;
  cancelled = false;
  readonly lines: string[] = [];
  readonly startedAt: number;
  endedAt = 0;
  #procs = new Set<Proc>();
  #abort = new AbortController();
  constructor(readonly action: JobAction, now: number) {
    this.startedAt = now;
  }
  get active(): boolean {
    return this.state === "running" || this.state === "waiting";
  }
  get signal(): AbortSignal {
    return this.#abort.signal;
  }
  line(text: string): void {
    const clean = scrub(text).trimEnd();
    if (!clean.trim()) return;
    this.lines.push(clean.slice(0, 400));
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
  }
  track(proc: Proc): Proc {
    this.#procs.add(proc);
    proc.done.finally(() => this.#procs.delete(proc));
    return proc;
  }
  cancel(): void {
    this.cancelled = true;
    this.#abort.abort();
    for (const p of this.#procs) p.kill();
  }
  end(state: JobState, message = this.message, now = Date.now()): void {
    if (!this.active) return;
    this.state = state;
    this.message = message;
    this.endedAt = now;
  }
  view(): Record<string, unknown> {
    return {
      id: this.id,
      action: this.action,
      state: this.state,
      phase: this.phase,
      progress: this.progress.map((p) => ({ ...p })),
      message: this.message,
      code: this.code,
      fallback: this.fallback,
      link: this.link,
      notice: this.notice,
      reboot: this.reboot,
      cancellable: this.cancellable && this.active,
      details: this.lines.slice(-DETAIL_LINES),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }
}

/** What setup needs from phone access (remote/access.ts PhoneAccess). */
export interface SetupHost {
  readonly on: boolean;
  readonly port: number | null;
  readonly artifactPort: number | null;
  readonly listening: boolean;
  readonly artifactListening: boolean;
  readonly artifactProblemMessage: string;
  readonly portProblemMessage: string;
  readonly shared: boolean;
  readonly pendingUnshare: boolean;
  /** The last Tailscale read, or null. */
  readonly tailscale: TailscaleState | null;
  readFresh(): Promise<TailscaleState>;
  readCached(): Promise<TailscaleState>;
  markShared(shared: boolean): void;
  setPendingUnshare(pending: boolean): void;
  /** Read again and bring the phone port up when it now can (after Funnel was turned off). */
  check(): Promise<void>;
  /** A fresh read and the phone port up when it now can, without the 20 s wait for a busy port (after every job). */
  settle(): Promise<void>;
  /** One Phone activity line. */
  note(action: string, result: string): void;
}

type Reply = [number, Record<string, unknown>];

export class TailscaleSetup {
  job: Job | null = null;
  readonly changes: Changes;
  /** The one-click HTTPS link Tailscale printed (login.tailscale.com/f/serve?node=...), '' until a serve command printed it. */
  httpsLink = "";
  /** The owner opened Tailscale's HTTPS page: step 2 waits until this PC is in CertDomains. */
  httpsWaiting = false;
  /** Why artifacts open on the PC only after the last Share AIB ('' when 8443 is shared). */
  artifactNote = "";
  /** Owner answer 1: AIB started with the switch on, it had shared itself before, and the share was gone. The PC page shows a
   * notice with Share again until it is shared again or dismissed. */
  missingAtStart = false;
  #pkgDir = "";
  #pkgTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #closed = false;

  constructor(
    readonly host: SetupHost,
    stateDir: string | null,
    readonly env: SetupEnv = defaultEnv(),
  ) {
    this.changes = new Changes(stateDir);
  }

  installMode(): "winget" | "msi" | "pkg" | "terminal" {
    const os = this.env.os();
    if (os === "windows") return this.env.hasWinget() ? "winget" : "msi";
    return os === "darwin" ? "pkg" : "terminal";
  }

  view(ts: TailscaleState | null): Record<string, unknown> {
    const jobActive = !!this.job?.active;
    return {
      os: this.env.os(),
      installMode: this.installMode(),
      job: this.job ? this.job.view() : null,
      changes: this.changes.list().slice().reverse(),
      httpsLink: this.httpsLink,
      httpsWaiting: this.httpsWaiting && !ts?.https,
      artifactNote: this.artifactNote,
      shared: this.host.shared,
      pendingUnshare: this.host.pendingUnshare,
      missingAtStart: this.missingAtStart && !ts?.serving,
      // shared before, the switch is on, but Tailscale does not send the address to AIB now
      shareAgain: this.host.on && this.host.shared && this.host.listening &&
        !!ts?.signedIn && !!ts.https &&
        !ts.serving && !ts.funnel && !jobActive,
      commands: {
        share: this.host.port ? serveCommand(this.host.port) : "",
        artifacts: this.host.artifactPort
          ? artifactServeCommand(this.host.artifactPort)
          : "",
        login: "tailscale login",
        up: "tailscale up",
        linuxInstall: LINUX_INSTALL,
        linuxOperator: LINUX_OPERATOR,
        linuxStart: LINUX_START,
      },
      links: {
        download: DOWNLOAD_PAGE,
        appStore: APP_STORE_URL,
        adminDns: ADMIN_DNS,
        adminMachines: ADMIN_MACHINES,
      },
    };
  }

  /** After every Tailscale read: HTTPS came on (step 2 stops waiting); a share AIB owes the owner's "off" is removed now. */
  onRead(ts: TailscaleState): void {
    if (ts.https) this.httpsWaiting = false;
    if (ts.serving) this.missingAtStart = false;
    if (
      this.host.pendingUnshare && ts.signedIn && !this.job?.active &&
      !this.#closed
    ) this.#start("unshare", (job) => this.#unshare(job));
  }

  /** A click. `body` carries only flags (replace, confirm); everything run is built here. */
  async run(
    action: unknown,
    body: Record<string, unknown> = {},
  ): Promise<Reply> {
    if (typeof action !== "string") {
      return [400, { error: "action must be text", code: "bad_action" }];
    }
    const quick = ["open-login", "open-https", "start", "dismiss-missing"];
    if (this.job?.active && !quick.includes(action)) {
      return [409, {
        error:
          "AIB is still working on the last step. Wait for it, or click Cancel.",
        code: "busy",
      }];
    }
    try {
      switch (action) {
        case "install":
          if (this.installMode() === "terminal") {
            return [400, {
              error: "On Linux, Install Tailscale runs in the setup terminal.",
              code: "terminal",
            }];
          }
          return this.#started(
            this.#start("install", (job) => this.#install(job)),
          );
        case "start":
          return this.#startApp();
        case "login":
          return this.#started(
            this.#start("login", (job) => this.#login(job, ["login"])),
          );
        case "up":
          return this.#started(
            this.#start("up", (job) => this.#login(job, ["up"])),
          );
        case "https":
          return await this.#https();
        case "share":
          return await this.#shareChecked(body.replace === true);
        case "unshare":
          return this.#started(
            this.#start("unshare", (job) => this.#unshare(job)),
          );
        case "funnel-off":
          if (body.confirm !== true) {
            return [400, {
              error: "Turning off Funnel needs the confirm click.",
              code: "confirm",
            }];
          }
          return this.#started(
            this.#start("funnel-off", (job) => this.#funnelOff(job)),
          );
        case "open-login":
          if (this.job?.action === "login" || this.job?.action === "up") {
            if (this.job.link) this.env.openUrl(this.job.link);
          }
          return [200, { ok: true }];
        case "dismiss-missing":
          this.missingAtStart = false;
          return [200, { ok: true }];
        case "open-https":
          this.env.openUrl(this.httpsLink || ADMIN_DNS);
          this.httpsWaiting = true;
          return [200, { ok: true }];
        default:
          return [400, {
            error: "AIB does not know that action.",
            code: "bad_action",
          }];
      }
    } catch (error) {
      if (error instanceof RefusedInTest) {
        return [409, { error: error.message, code: "refused" }];
      }
      throw error;
    }
  }

  cancel(): boolean {
    const job = this.job;
    if (!job?.active || !job.cancellable) return false;
    job.cancel();
    job.end(
      "cancelled",
      job.action === "install"
        ? "Install cancelled. Nothing was installed."
        : "Cancelled.",
      this.env.now(),
    );
    return true;
  }

  /** Switching remote control off: AIB's own shares go too (decision 5). Runs after the phone port closed; never throws. */
  afterOff(): void {
    if (this.#closed) return;
    const last = this.host.tailscale;
    if (
      !this.host.shared && !this.host.pendingUnshare && !last?.serving &&
      !last?.artifactServing
    ) return; // nothing of AIB's is shared
    if (this.job?.active) {
      this.job.cancel();
      this.job.end(
        "cancelled",
        "Cancelled: remote control was switched off.",
        this.env.now(),
      );
    }
    this.#start("unshare", (job) => this.#unshare(job));
  }

  close(): Promise<void> {
    this.#closed = true;
    if (this.job?.active) {
      this.job.cancel();
      this.job.end("cancelled", "AIB is closing.", this.env.now());
    }
    this.#dropPkg();
    return Promise.resolve();
  }

  // ---- jobs ------------------------------------------------------------------------------------------------------------------

  #started(job: Job): Reply {
    return [202, { ok: true, job: job.view() }];
  }

  #start(action: JobAction, work: (job: Job) => Promise<void>): Job {
    const job = new Job(action, this.env.now());
    this.job = job;
    work(job).finally(() =>
      this.#closed ? undefined : this.host.settle().catch(() => {})
    ).then(
      () => job.end("done", job.message, this.env.now()),
      (error) => {
        if (job.cancelled) {
          return job.end(
            "cancelled",
            job.message || "Cancelled.",
            this.env.now(),
          );
        }
        job.code ||= error instanceof RefusedInTest ? "refused" : "failed";
        job.end(
          "failed",
          job.message ||
            `Something went wrong: ${
              error instanceof Error ? error.message : String(error)
            }`,
          this.env.now(),
        );
      },
    );
    return job;
  }

  /** Run a program for a job, its lines into the job (sign-in links scrubbed). Throws when the program is not on this PC. */
  async #exec(
    job: Job,
    tool: Tool,
    args: string[],
    timeoutMs: number,
    onLine?: (line: string, proc: Proc) => void,
    env?: Record<string, string>,
  ) {
    if (job.cancelled) throw new Error("cancelled");
    let proc: Proc | null = null;
    const p = this.env.spawn(tool, args, {
      timeoutMs,
      env,
      onLine: (line) => {
        job.line(line);
        if (onLine && proc) onLine(line, proc);
      },
    });
    if (!p) throw new NotFound(tool);
    proc = job.track(p);
    const code = await proc.done;
    return { code, text: job.lines.join("\n") };
  }

  #change(label: string, command: string, ok: boolean, note: string): void {
    this.changes.add({
      time: Math.round(this.env.now() / 1000),
      label,
      command,
      ok,
      note,
    });
    this.host.note("tailscale", `${label}: ${ok ? "done" : "failed"}`);
  }

  async #wait(job: Job, ms = this.env.waitMs): Promise<void> {
    if (job.cancelled) throw new Error("cancelled");
    await this.env.sleep(ms);
    if (job.cancelled) throw new Error("cancelled");
  }

  #fail(job: Job, code: string, message: string, fallback = ""): never {
    job.code = code;
    job.message = message;
    job.fallback = fallback;
    throw new JobFailed(message);
  }

  // ---- Install ---------------------------------------------------------------------------------------------------------------

  async #install(job: Job): Promise<void> {
    const mode = this.installMode();
    if (mode === "winget") await this.#winget(job);
    else if (mode === "msi") await this.#msi(job);
    else await this.#pkg(job);
  }

  async #afterInstall(job: Job, last: number): Promise<void> {
    if (last >= 0) job.progress[last].state = "now";
    const ts = await this.host.readFresh();
    if (!ts.installed) {
      job.message =
        "Tailscale was installed, but AIB can't find it yet. Click Check again.";
      return;
    }
    if (!ts.backend || ts.problem === "not_running") {
      const proc = this.env.os() === "windows"
        ? this.env.spawn("ipn", [], { timeoutMs: 10_000, detached: true })
        : null;
      if (proc) await proc.done;
    }
    if (last >= 0) job.progress[last].state = "done";
  }

  #declinedText(): string {
    const os = this.env.os();
    return os === "windows"
      ? "You chose No on the Windows prompt. Nothing was installed."
      : os === "darwin"
      ? "The macOS installer was closed before it finished. Nothing was installed."
      : "sudo didn't get a password. Nothing was installed.";
  }

  async #winget(job: Job): Promise<void> {
    job.cancellable = false; // winget's install can't be stopped halfway safely
    job.progress = [
      { text: "Found winget", state: "done" },
      {
        text:
          "Windows is asking for permission. Click Yes on the prompt. If no prompt shows, click the flashing shield in the taskbar.",
        state: "now",
      },
      { text: "Installing Tailscale", state: "todo" },
      { text: "Starting Tailscale", state: "todo" },
    ];
    const r = await this.#exec(
      job,
      "winget",
      WINGET_ARGS,
      15 * 60_000,
      (line) => {
        if (/install|download/i.test(line)) {
          job.progress[1].state = "done";
          job.progress[2].state = "now";
        }
      },
    );
    const outcome = wingetOutcome(r.code, r.text);
    const command = shown("winget", WINGET_ARGS);
    if (outcome === "declined") {
      this.#change(
        "Installed Tailscale",
        command,
        false,
        "Cancelled on the Windows prompt.",
      );
      this.#fail(job, "declined", this.#declinedText());
    }
    if (outcome !== "ok") {
      const why = r.code === 0x8A15000F
        ? "the package source could not be reached. Check your internet connection and try again, or download it yourself."
        : outcome === "busy"
        ? "another install is running. Wait for it to finish, then try again."
        : "Try again, or download it yourself.";
      this.#change(
        "Installed Tailscale",
        command,
        false,
        `winget stopped with error ${hex(r.code)}.`,
      );
      this.#fail(
        job,
        outcome === "busy" ? "busy" : "failed",
        `winget stopped with error ${hex(r.code)}: ${why}`,
      );
    }
    job.progress[1].state = "done";
    job.progress[2].state = "done";
    this.#change(
      "Installed Tailscale",
      command,
      true,
      "Tailscale stays installed. Remove it in Windows Settings → Apps if you want.",
    );
    await this.#afterInstall(job, 3);
  }

  /** Download pkgs.tailscale.com's newest file for this PC and its .sha256 into a fresh temp folder; check the digest. */
  async #download(
    job: Job,
    pick: (index: unknown) => string,
  ): Promise<{ dir: string; file: string; name: string; version: string }> {
    const base = this.env.pkgsBase();
    const signal = job.signal;
    const get = async (url: string) => {
      const r = await this.env.fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      });
      return r;
    };
    let index: unknown;
    try {
      const r = await get(`${base}/?mode=json`);
      index = r.ok ? await r.json() : null;
    } catch (error) {
      if (job.cancelled) throw error;
      this.#fail(
        job,
        "network",
        "AIB couldn't reach pkgs.tailscale.com. Check your internet connection and try again, or download it yourself.",
      );
    }
    const name = pick(index);
    if (!name) {
      this.#fail(
        job,
        "no_file",
        "pkgs.tailscale.com doesn't list a Tailscale installer for this PC. Download it yourself.",
      );
    }
    const version = name.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "";
    const dir = await this.env.tempDir();
    const file = inDir(dir, name);
    const drop = () => Deno.remove(dir, { recursive: true }).catch(() => {});
    try {
      const shaResponse = await get(`${base}/${name}.sha256`);
      const published = shaResponse.ok
        ? publishedSha(await shaResponse.text())
        : "";
      if (!published) {
        this.#fail(
          job,
          "no_checksum",
          "Tailscale's site has no checksum for this file, so AIB ran nothing. Download Tailscale yourself.",
        );
      }
      const r = await get(`${base}/${name}`);
      if (!r.ok || !r.body) {
        this.#fail(
          job,
          "network",
          "The download from pkgs.tailscale.com didn't finish. Try again, or download it yourself.",
        );
      }
      const out = await Deno.open(file, {
        write: true,
        create: true,
        truncate: true,
      });
      await r.body.pipeTo(out.writable);
      if (await sha256File(file) !== published) {
        this.#fail(
          job,
          "checksum",
          "The download didn't match Tailscale's published checksum, so AIB deleted it and ran nothing. Try again, or download it yourself.",
        );
      }
      return { dir, file, name, version };
    } catch (error) {
      await drop();
      if (job.cancelled) throw error;
      if (error instanceof JobFailed) throw error;
      this.#fail(
        job,
        "network",
        "The download from pkgs.tailscale.com didn't finish. Try again, or download it yourself.",
      );
    }
  }

  async #msi(job: Job): Promise<void> {
    job.progress = [
      { text: "Downloading Tailscale from pkgs.tailscale.com", state: "now" },
      { text: "Checking the checksum and the signature", state: "todo" },
      {
        text: "Windows will ask for Tailscale Inc. Click Yes on the prompt.",
        state: "todo",
      },
      { text: "Starting Tailscale", state: "todo" },
    ];
    const arch = windowsArch(this.env.env);
    const got = await this.#download(job, (index) => pickMsi(index, arch));
    const drop = () =>
      Deno.remove(got.dir, { recursive: true }).catch(() => {});
    try {
      job.progress[0] = {
        text: `Downloaded Tailscale ${got.version} from pkgs.tailscale.com`,
        state: "done",
      };
      job.progress[1].state = "now";
      // the path goes in an environment variable, never into the PowerShell text (a ' or a space in the path can't break it)
      const sig = await this.#exec(
        job,
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", SIGNATURE_SCRIPT],
        60_000,
        undefined,
        {
          AIB_MSI: got.file,
        },
      );
      if (!signatureOk(sig.text)) {
        this.#fail(
          job,
          "signature",
          "The download isn't signed by Tailscale Inc., so AIB deleted it and ran nothing. Download Tailscale yourself.",
        );
      }
      job.progress[1] = {
        text: "Checked: signed by Tailscale Inc., checksum matches",
        state: "done",
      };
      job.progress[2] = {
        text:
          "Windows will ask for Tailscale Inc. Click Yes on the prompt. If no prompt shows, click the flashing shield in the taskbar.",
        state: "now",
      };
      job.cancellable = false; // msiexec has started: stopping it halfway could leave a broken install
      const log = inDir(got.dir, "install.log");
      const args = ["/i", got.file, "/passive", "/norestart", "/l*v", log];
      const r = await this.#exec(job, "msiexec", args, 15 * 60_000);
      const outcome = msiOutcome(r.code);
      await this.#logTail(job, log);
      const command = shown("msiexec", [
        "/i",
        got.name,
        "/passive",
        "/norestart",
      ]);
      if (outcome === "declined") {
        this.#change(
          "Installed Tailscale",
          command,
          false,
          "Cancelled on the Windows prompt.",
        );
        this.#fail(job, "declined", this.#declinedText());
      }
      if (outcome === "busy") {
        this.#change(
          "Installed Tailscale",
          command,
          false,
          "Another install was running.",
        );
        this.#fail(
          job,
          "busy",
          "Another install is running on this PC. Wait for it to finish, then click Install Tailscale again.",
        );
      }
      if (outcome === "failed") {
        this.#change(
          "Installed Tailscale",
          command,
          false,
          `msiexec stopped with code ${r.code}.`,
        );
        this.#fail(
          job,
          "failed",
          `The Tailscale installer stopped with code ${r.code}. Try again, or download it yourself.`,
        );
      }
      job.reboot = outcome === "reboot";
      job.progress[2] = { text: "Installed Tailscale", state: "done" };
      this.#change(
        "Installed Tailscale",
        command,
        true,
        outcome === "newer"
          ? "A newer Tailscale was already installed."
          : "Tailscale stays installed. Remove it in Windows Settings → Apps if you want.",
      );
      if (job.reboot) {
        job.message =
          "Tailscale is installed. Windows wants a restart to finish; AIB works before that.";
      }
      await this.#afterInstall(job, 3);
    } finally {
      await drop();
    }
  }

  async #logTail(job: Job, log: string): Promise<void> {
    try {
      const bytes = await Deno.readFile(log);
      const text = bytes[0] === 0xff && bytes[1] === 0xfe
        ? new TextDecoder("utf-16le").decode(bytes)
        : new TextDecoder().decode(bytes);
      for (
        const line of text.split(/\r?\n/).filter((l) => l.trim()).slice(
          -DETAIL_LINES,
        )
      ) job.line(line);
    } catch { /* no log */ }
  }

  async #pkg(job: Job): Promise<void> {
    job.progress = [
      { text: "Downloading Tailscale from pkgs.tailscale.com", state: "now" },
      { text: "Checking the checksum and the signature", state: "todo" },
      {
        text:
          "The macOS installer opens. Enter your password there, then allow the network extension when macOS asks.",
        state: "todo",
      },
      { text: "Starting Tailscale", state: "todo" },
    ];
    const got = await this.#download(job, pickPkg);
    let handedOver = false;
    try {
      job.progress[0] = {
        text: `Downloaded Tailscale ${got.version} from pkgs.tailscale.com`,
        state: "done",
      };
      job.progress[1].state = "now";
      const sig = await this.#exec(job, "pkgutil", [
        "--check-signature",
        got.file,
      ], 60_000);
      const gate = sig.code === 0 && pkgutilOk(sig.text)
        ? await this.#exec(job, "spctl", [
          "-a",
          "-vv",
          "-t",
          "install",
          got.file,
        ], 60_000)
        : null;
      if (!gate || !spctlOk(gate.text)) {
        this.#fail(
          job,
          "signature",
          "The download isn't signed by Tailscale Inc., so AIB deleted it and ran nothing. Download Tailscale yourself.",
        );
      }
      job.progress[1] = {
        text: "Checked: signed by Tailscale Inc., checksum matches",
        state: "done",
      };
      job.progress[2].state = "now";
      job.progress[2].text =
        "The macOS installer is open. Enter your password there, then allow the network extension when macOS asks.";
      const opened = await this.#exec(job, "open", [got.file], 60_000);
      if (opened.code !== 0) {
        this.#fail(
          job,
          "failed",
          "macOS didn't open the installer. Try again, or download it yourself.",
        );
      }
      this.#change(
        "Opened the Tailscale installer",
        shown("open", [got.name]),
        true,
        "Tailscale stays installed. Remove it in Finder: drag Tailscale.app to the Bin.",
      );
      // the Installer still reads the file after `open` returns: keep it until Tailscale is found, an hour, or AIB exits
      handedOver = true;
      this.#keepPkg(got.dir);
      job.state = "waiting";
      job.phase = "installer";
      const until = this.env.now() + this.env.pkgKeepMs;
      for (;;) {
        await this.#wait(job);
        const ts = await this.host.readCached();
        if (ts.installed) break;
        if (this.env.now() > until) {
          this.#fail(
            job,
            "failed",
            "AIB doesn't see Tailscale yet. If the installer finished, open Tailscale once, then click Check again.",
          );
        }
      }
      job.state = "running";
      job.progress[2].state = "done";
      this.#dropPkg();
      await this.#afterInstall(job, 3);
    } finally {
      if (!handedOver) {
        await Deno.remove(got.dir, { recursive: true }).catch(() => {});
      }
    }
  }

  #keepPkg(dir: string): void {
    this.#dropPkg();
    this.#pkgDir = dir;
    this.#pkgTimer = setTimeout(() => this.#dropPkg(), this.env.pkgKeepMs);
    try {
      Deno.unrefTimer(this.#pkgTimer as unknown as number);
    } catch { /* fine */ }
  }

  #dropPkg(): void {
    clearTimeout(this.#pkgTimer);
    if (this.#pkgDir) {
      try {
        Deno.removeSync(this.#pkgDir, { recursive: true });
      } catch { /* gone */ }
    }
    this.#pkgDir = "";
  }

  /** Whether the downloaded .pkg is still kept (tests). */
  get pkgKept(): string {
    return this.#pkgDir;
  }

  // ---- Start Tailscale, sign in, turn on ------------------------------------------------------------------------------------

  #startApp(): Reply {
    const os = this.env.os();
    if (os === "linux") {
      return [400, {
        error: "On Linux, Start Tailscale runs in the setup terminal.",
        code: "terminal",
      }];
    }
    const proc = os === "windows"
      ? this.env.spawn("ipn", [], { timeoutMs: 10_000, detached: true })
      : this.env.spawn("open", ["-a", "Tailscale"], {
        timeoutMs: 10_000,
        detached: true,
      });
    if (!proc) {
      return [404, {
        error: "AIB can't find the Tailscale app on this PC.",
        code: "not_found",
      }];
    }
    return [200, { ok: true }];
  }

  /** `tailscale login` (Sign in) or `tailscale up` (Turn Tailscale on): the sign-in link Tailscale prints is opened in the browser;
   * done when Tailscale reports Running (the process is stopped then), on Cancel, or after 10 minutes. */
  async #login(job: Job, args: string[]): Promise<void> {
    const first = await this.host.readFresh();
    if (first.signedIn) return;
    if (!first.installed) {
      this.#fail(job, "not_installed", "Tailscale is not installed yet.");
    }
    job.phase = "starting";
    let signedIn = false;
    let finished = false;
    const command = shown("tailscale", args);
    const started = this.env.now();
    const watch = (async () => {
      while (!finished) {
        await this.env.sleep(this.env.waitMs);
        if (finished || job.cancelled) return;
        const ts = await this.host.readCached();
        if (ts.signedIn) {
          signedIn = true;
          job.cancel(); // stops `tailscale login`, which would otherwise wait
          return;
        }
        if (
          !job.link && job.phase !== "no_link" &&
          this.env.now() - started >= this.env.noLinkMs
        ) {
          job.phase = "no_link";
          job.message =
            "No sign-in page came from Tailscale. Open Tailscale and sign in there.";
        }
      }
    })();
    let r: { code: number; text: string };
    try {
      r = await this.#exec(job, "tailscale", args, 10 * 60_000, (line) => {
        const link = safeLink(line, "login");
        if (link && !job.link) {
          job.link = link;
          job.phase = "browser";
          job.message = "";
          this.env.openUrl(link);
        }
        if (/requires mentioning all non-default flags/i.test(line)) {
          job.code = "flags";
        }
        const said = job.lines.join(" ");
        if (/access denied/i.test(said) && /operator/i.test(said)) {
          job.code = "operator";
        }
        if (
          /\badmin/i.test(line) && /\b(ask|approv|contact)/i.test(line) &&
          !LOGIN_LINK.test(line)
        ) job.notice = line.trim().slice(0, 200);
      });
    } finally {
      finished = true;
    }
    await watch.catch(() => {});
    if (signedIn) {
      job.cancelled = false;
      job.link = "";
      this.#change(
        args[0] === "up" ? "Turned Tailscale on" : "Started the sign-in",
        command,
        true,
        "AIB never signs you out.",
      );
      return;
    }
    if (job.cancelled) throw new Error("cancelled");
    const ts = await this.host.readFresh();
    if (ts.signedIn) {
      job.link = "";
      this.#change(
        args[0] === "up" ? "Turned Tailscale on" : "Started the sign-in",
        command,
        true,
        "AIB never signs you out.",
      );
      return;
    }
    job.link = "";
    if (job.code === "flags") {
      this.#fail(
        job,
        "flags",
        "Tailscale wants to be started from its own app. Click Open Tailscale, then click Connect there.",
      );
    }
    if (job.code === "operator") {
      this.#fail(
        job,
        "operator",
        "Tailscale needs your permission to let AIB manage it without sudo. Click Allow AIB to manage Tailscale, then type your password in the terminal.",
        LINUX_OPERATOR,
      );
    }
    if (ts.problem === "needs_machine_auth") {
      job.message =
        "Signed in. Your tailnet admin needs to approve this PC in Tailscale before it can connect.";
      return;
    }
    this.#fail(
      job,
      "failed",
      `Sign-in didn't finish${
        r.code > 0 ? ` (tailscale exited with code ${r.code})` : ""
      }. Try again, or sign in from the Tailscale app.`,
      command,
    );
  }

  // ---- HTTPS -----------------------------------------------------------------------------------------------------------------

  /** Turn on HTTPS: open Tailscale's one-click link. Without one yet, run the phone share command once: on a tailnet without HTTPS
   * it prints the link (AIB stops it there and opens the link); with no link, the DNS admin page opens. */
  async #https(): Promise<Reply> {
    if (this.httpsLink) {
      this.env.openUrl(this.httpsLink);
      this.httpsWaiting = true;
      return [200, { ok: true, opened: "link" }];
    }
    const ts = await this.host.readFresh();
    if (ts.https) return [200, { ok: true }];
    if (
      !ts.signedIn || !this.host.listening || !this.host.port ||
      ts.servingOther || ts.funnel
    ) {
      this.env.openUrl(ADMIN_DNS);
      this.httpsWaiting = true;
      return [200, { ok: true, opened: "admin" }];
    }
    const job = this.#start("https", async (job) => {
      job.progress = [{
        text: "Asking Tailscale for its HTTPS page",
        state: "now",
      }];
      const r = await this.#serve(job, 443, this.host.port!, false);
      if (r.result === "https") {
        this.env.openUrl(this.httpsLink);
      } else if (r.result === "ok") {
        this.#change(
          "Shared AIB",
          shown("tailscale", r.args),
          true,
          "Undo: Stop sharing.",
        );
        this.host.markShared(true);
      } else this.env.openUrl(ADMIN_DNS);
      this.httpsWaiting = true;
      job.progress[0].state = "done";
    });
    return this.#started(job);
  }

  /** One `tailscale serve --bg` command. A tailnet without HTTPS makes it print the one-click link and wait: AIB keeps the link
   * and stops the command (result 'https'). */
  async #serve(job: Job, httpsPort: number, localPort: number, yes: boolean) {
    const args = [
      "serve",
      "--bg",
      ...(yes ? ["--yes"] : []),
      `--https=${httpsPort}`,
      `http://127.0.0.1:${localPort}`,
    ];
    let link = "";
    const r = await this.#exec(job, "tailscale", args, 60_000, (line, proc) => {
      const found = safeLink(line, "https");
      if (found && !link) {
        link = found;
        proc.kill();
      }
    });
    if (link) {
      this.httpsLink = link;
      return { result: "https" as const, args, code: r.code, last: "" };
    }
    const last = job.lines.at(-1) ?? "";
    return {
      result: r.code === 0 ? "ok" as const : "failed" as const,
      args,
      code: r.code,
      last,
    };
  }

  // ---- Share AIB, Stop sharing, Turn off Funnel -------------------------------------------------------------------------------

  /** Share AIB: the checks run before any command (Funnel, phone port, both ports' current shares); one confirm names both. */
  async #shareChecked(replace: boolean): Promise<Reply> {
    const ts = await this.host.readFresh();
    if (!ts.signedIn) {
      return [409, {
        error: "Tailscale is not signed in on this PC yet.",
        code: "not_ready",
      }];
    }
    if (ts.funnel) return [409, { error: funnelText(ts), code: "funnel" }];
    if (!this.host.listening) await this.host.settle();
    if (!this.host.listening || !this.host.port) {
      return [409, {
        error: this.host.portProblemMessage ||
          "AIB's phone port isn't open yet.",
        code: "port_busy",
      }];
    }
    const others: { port: number; to: string }[] = [];
    if (ts.servingOther) others.push({ port: 443, to: ts.servingOther });
    if (this.host.artifactListening && ts.artifactServingOther) {
      others.push({ port: 8443, to: ts.artifactServingOther });
    }
    if (others.length && !replace) {
      return [409, {
        error: "Something else is shared at that address now.",
        code: "replace_needed",
        others,
      }];
    }
    return this.#started(
      this.#start("share", (job) => this.#share(job, replace)),
    );
  }

  async #share(job: Job, replace: boolean): Promise<void> {
    for (;;) {
      const ts = await this.host.readFresh();
      const name = ts.name;
      job.phase = "";
      job.state = "running";
      job.progress = [
        {
          text: `Artifacts: https://${name}:8443`,
          state: ts.artifactServing ? "done" : "now",
        },
        {
          text: `Phone address: https://${name}`,
          state: ts.serving ? "done" : "todo",
        },
      ];
      if (ts.funnel) this.#fail(job, "funnel", funnelText(ts));
      this.artifactNote = "";
      // 8443 first; when it fails the phone share still goes ahead (owner answer 2: no rollback)
      if (
        this.host.artifactListening && this.host.artifactPort &&
        !ts.artifactServing
      ) {
        const r = await this.#serve(
          job,
          8443,
          this.host.artifactPort,
          replace && !!ts.artifactServingOther,
        );
        if (r.result === "https") {
          if (await this.#waitHttps(job)) continue;
          return;
        }
        const command = shown("tailscale", r.args);
        if (r.result === "ok") {
          this.#change(
            "Shared artifacts",
            command,
            true,
            "Undo: Stop sharing.",
          );
        } else {
          this.#change(
            "Shared artifacts",
            command,
            false,
            r.last.slice(0, 120),
          );
          this.artifactNote = `Tailscale didn't share port 8443${
            r.last ? `: ${r.last.slice(0, 160)}` : "."
          }`;
        }
      } else if (!this.host.artifactListening) {
        this.artifactNote = this.host.artifactProblemMessage ||
          "AIB's artifact port isn't open.";
      }
      job.progress[0].state = "done";
      job.progress[1].state = "now";
      if (!ts.serving) {
        const r = await this.#serve(
          job,
          443,
          this.host.port!,
          replace && !!ts.servingOther,
        );
        if (r.result === "https") {
          if (await this.#waitHttps(job)) continue;
          return;
        }
        const command = shown("tailscale", r.args);
        if (r.result !== "ok") {
          this.#change("Shared AIB", command, false, r.last.slice(0, 120));
          this.#fail(
            job,
            "failed",
            `Tailscale didn't share AIB${
              r.last ? `: ${r.last.slice(0, 200)}` : "."
            }`,
            command,
          );
        }
        this.#change("Shared AIB", command, true, "Undo: Stop sharing.");
      }
      job.progress[1].state = "done";
      this.host.markShared(true);
      this.host.setPendingUnshare(false);
      await this.host.readFresh();
      return;
    }
  }

  /** HTTPS is off: step 2 waits (Turn on HTTPS opens the link Tailscale printed); when this PC is in CertDomains, Share AIB runs
   * again by itself. False when it stopped waiting (cancel, or 30 minutes). */
  async #waitHttps(job: Job): Promise<boolean> {
    job.state = "waiting";
    job.phase = "https";
    job.message = "";
    const until = this.env.now() + 30 * 60_000;
    while (this.env.now() < until) {
      await this.#wait(job);
      const ts = await this.host.readCached();
      if (ts.https) {
        this.httpsWaiting = false;
        return true;
      }
    }
    this.#fail(
      job,
      "https",
      "HTTPS isn't on for your tailnet yet. Click Turn on HTTPS, then Share AIB again.",
    );
  }

  /** Stop sharing (also what switching off runs): `serve --https=N off` only for a port that points at AIB's port now. Tailscale
   * not running: remembered, and done once it runs again. */
  async #unshare(job: Job): Promise<void> {
    const ts = await this.host.readFresh();
    if (!ts.signedIn) {
      if (this.host.shared || this.host.pendingUnshare) {
        this.host.setPendingUnshare(true);
        job.message =
          "AIB stops sharing on Tailscale as soon as Tailscale runs again.";
      }
      return;
    }
    job.progress = [];
    const ports: [number, boolean, string][] = [[
      443,
      ts.serving,
      "Stopped sharing AIB",
    ], [
      8443,
      ts.artifactServing,
      "Stopped sharing artifacts",
    ]];
    let failed = "";
    for (const [port, ours, label] of ports) {
      if (!ours) continue;
      const args = ["serve", `--https=${port}`, "off"];
      job.progress.push({ text: label, state: "now" });
      const r = await this.#exec(job, "tailscale", args, 30_000);
      job.progress.at(-1)!.state = "done";
      this.#change(
        label,
        shown("tailscale", args),
        r.code === 0,
        r.code === 0
          ? "Share AIB adds it again."
          : (job.lines.at(-1) ?? "").slice(0, 120),
      );
      if (r.code !== 0) failed ||= shown("tailscale", args);
    }
    this.host.setPendingUnshare(false);
    this.artifactNote = "";
    if (failed) {
      this.#fail(
        job,
        "failed",
        "Tailscale didn't stop sharing. Try again, or run the command below.",
        failed,
      );
    }
    // switched off: AIB remembers it was shared, so switching on shares again (decision 5); Stop sharing forgets it
    if (this.host.on) this.host.markShared(false);
    await this.host.readFresh();
  }

  /** Turn off Funnel (after the confirm): `tailscale funnel --https=N off` for each port Funnel makes public for this name. */
  async #funnelOff(job: Job): Promise<void> {
    const ts = await this.host.readFresh();
    for (const f of ts.funnelPorts) {
      const args = ["funnel", `--https=${f.port}`, "off"];
      const r = await this.#exec(job, "tailscale", args, 30_000);
      this.#change(
        "Turned off Funnel",
        shown("tailscale", args),
        r.code === 0,
        `https://${ts.name}:${f.port} is no longer public.`,
      );
      if (r.code !== 0) {
        this.#fail(
          job,
          "failed",
          "Tailscale didn't turn Funnel off. Try again, or run the command below.",
          shown("tailscale", args),
        );
      }
    }
    await this.host.check();
  }
}

class NotFound extends Error {
  constructor(tool: string) {
    super(`${tool} was not found on this PC`);
  }
}
class JobFailed extends Error {}

/** The Funnel message: what is public, and why AIB won't share. Never a command to type. */
export function funnelText(
  ts: Pick<TailscaleState, "name" | "funnelPorts">,
): string {
  const what =
    ts.funnelPorts.map((f) => `https://${ts.name}:${f.port} → ${f.to}`).join(
      ", ",
    ) || `https://${ts.name}`;
  return `Funnel is on for this PC. ${what} is on the public internet. AIB won't share while Funnel is on, because anyone could reach the pairing page.`;
}
