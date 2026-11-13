/**
 * Install Tailscale from Settings > Remote control (owner decisions 2026-11-12): Windows runs winget's Tailscale.Tailscale, or
 * without winget downloads Tailscale's official MSI from pkgs.tailscale.com, checks its published SHA-256 and its Authenticode
 * signature (Valid, signed by Tailscale Inc.) and runs msiexec; macOS downloads the standalone .pkg, checks the SHA-256, pkgutil's
 * signature and Gatekeeper (spctl), then opens it in the macOS Installer; Linux runs Tailscale's install script in AIB's setup
 * terminal (terminal_routes.ts, setup=remote), where the owner types their own sudo password.
 *
 * AIB itself is never elevated: msiexec raises the Windows prompt (UAC) itself, the macOS Installer asks for the password. Nothing
 * downloaded runs before both checks pass; the file is deleted afterwards (macOS: once Tailscale is found, after an hour, or when
 * AIB exits, because the Installer still reads it after `open` returns).
 *
 * The pure parts (code tables, file pickers, signature checks) are exported for tests.
 */

import { hookArgv, setupOs, testMode } from "./setup_cli.ts";

export const PKGS_BASE = "https://pkgs.tailscale.com/stable";
export const DOWNLOAD_PAGE = "https://tailscale.com/download";
export const APP_STORE_URL = "https://apps.apple.com/app/id1475387142";
/** Tailscale Inc.'s Apple team ID (its Developer ID Installer certificate). Phase 0: confirm on a Mac. */
export const TAILSCALE_TEAM_ID = "W5364U7YZB";

export const WINGET_ARGS = [
  "install",
  "--id",
  "Tailscale.Tailscale",
  "--exact",
  "--silent",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
  "--source",
  "winget",
];
/** The Linux install: Tailscale's script, then the operator line so Share AIB works without sudo. */
export const LINUX_INSTALL =
  'curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale set --operator="$(id -un)"';
/** Linux, Tailscale installed before AIB: only the operator line (tailscale login said "Access denied ... --operator"). */
export const LINUX_OPERATOR = 'sudo tailscale set --operator="$(id -un)"';
/** Linux, tailscaled stopped. */
export const LINUX_START = "sudo systemctl start tailscaled";

/** winget's own codes AIB knows (winget prints them unsigned, e.g. 0x8A15002B). */
export const WINGET_OK = new Set([0, 0x8A15002B]); // 0x8A15002B: no newer version to install (Tailscale is already there)
export type InstallOutcome =
  | "ok"
  | "reboot"
  | "declined"
  | "busy"
  | "newer"
  | "failed";

/** What a winget exit code and its output mean. Cancelling the Windows prompt shows only in the output text. */
export function wingetOutcome(code: number, text: string): InstallOutcome {
  const c = code >>> 0;
  if (/\b(1602|1223)\b|cancel+ed|declined|operation was canceled/i.test(text)) {
    return "declined";
  }
  if (WINGET_OK.has(c)) return "ok";
  if (/\b1618\b/.test(text)) return "busy";
  return "failed";
}

/** msiexec's exit codes: 0 ok; 3010 / 1641 ok but Windows wants a restart; 1602 / 1625 / 1223 the prompt was declined or blocked;
 * 1618 another install runs; 1638 a newer Tailscale is already installed (fine). */
export function msiOutcome(code: number): InstallOutcome {
  switch (code >>> 0) {
    case 0:
      return "ok";
    case 3010:
    case 1641:
      return "reboot";
    case 1602:
    case 1625:
    case 1223:
      return "declined";
    case 1618:
      return "busy";
    case 1638:
      return "newer";
    default:
      return "failed";
  }
}

export function hex(code: number): string {
  const c = code >>> 0;
  return c > 0xffff
    ? "0x" + c.toString(16).toUpperCase().padStart(8, "0")
    : String(c);
}

/** This PC's CPU as Tailscale's MSI names it. PROCESSOR_ARCHITEW6432 is the real one when AIB runs as a 32-bit process. */
export function windowsArch(
  env: (name: string) => string | undefined,
): "amd64" | "arm64" | "x86" {
  const raw =
    (env("PROCESSOR_ARCHITEW6432") || env("PROCESSOR_ARCHITECTURE") || "")
      .toUpperCase();
  if (raw === "ARM64") return "arm64";
  if (raw === "X86") return "x86";
  return "amd64";
}

type Json = Record<string, unknown>;
const obj = (
  v: unknown,
): Json => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});

/** The MSI for this CPU from pkgs.tailscale.com's ?mode=json, or '' when it lists none that looks right. */
export function pickMsi(index: unknown, arch: string): string {
  const name = obj(obj(index).MSIs)[arch];
  return typeof name === "string" &&
      /^tailscale-setup-[\d.]+-(amd64|arm64|x86)\.msi$/.test(name)
    ? name
    : "";
}

/** The standalone macOS package (MacZips["universal-package"]), or ''. */
export function pickPkg(index: unknown): string {
  const name = obj(obj(index).MacZips)["universal-package"];
  return typeof name === "string" && /^Tailscale-[\d.]+-macos\.pkg$/.test(name)
    ? name
    : "";
}

/** Tailscale's .sha256 file: the hex digest, maybe followed by the file name. '' when it is not one. */
export function publishedSha(text: string): string {
  const m = text.trim().match(/^([0-9a-f]{64})\b/i);
  return m ? m[1].toLowerCase() : "";
}

/** The PowerShell that reads the MSI's signature: the path comes in $env:AIB_MSI (never pasted into the command), JSON out. */
export const SIGNATURE_SCRIPT =
  "$s = Get-AuthenticodeSignature -LiteralPath $env:AIB_MSI; " +
  "[pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress";

/** The signature is Valid and the signer's organisation is Tailscale Inc. */
export function signatureOk(output: string): boolean {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return false;
  try {
    const data = obj(JSON.parse(output.slice(start, end + 1)));
    const subject = typeof data.subject === "string" ? data.subject : "";
    return data.status === "Valid" &&
      /(^|,\s*)O="?Tailscale Inc\.?"?\s*(,|$)/.test(subject);
  } catch {
    return false;
  }
}

/** pkgutil --check-signature: signed with Tailscale Inc.'s Developer ID Installer certificate. */
export function pkgutilOk(output: string): boolean {
  return /Status:\s*signed by a developer certificate issued by Apple/i.test(
    output,
  ) &&
    new RegExp(
      `Developer ID Installer: Tailscale Inc\\. \\(${TAILSCALE_TEAM_ID}\\)`,
    ).test(output);
}

/** spctl -a -vv -t install: Gatekeeper accepts it, from Tailscale Inc.'s Developer ID. */
export function spctlOk(output: string): boolean {
  return /:\s*accepted\b/.test(output) &&
    new RegExp(
      `origin=Developer ID Installer: Tailscale Inc\\. \\(${TAILSCALE_TEAM_ID}\\)`,
    ).test(output);
}

export async function sha256File(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The Linux setup terminal's program for a Remote control step (terminal_routes.ts setup=remote): the command is always one of the
 * three above, never the page's. A string is the one-line reason it can't run. Tests: AIB_REMOTE_SETUP_SHELL (a JSON array) gets
 * the command line as its last argument; under AGENT_STUDIO_TEST=1 without it, nothing runs. */
export function remoteSetupCommand(
  step: string,
): { file: string; args: string[] } | string {
  const command = step === "tailscale-install"
    ? LINUX_INSTALL
    : step === "tailscale-operator"
    ? LINUX_OPERATOR
    : step === "tailscale-start"
    ? LINUX_START
    : "";
  if (!command) return "AIB does not know that setup step.";
  const fake = hookArgv("AIB_REMOTE_SETUP_SHELL");
  if (fake) return { file: fake[0], args: [...fake.slice(1), command] };
  if (testMode()) {
    return "AGENT_STUDIO_TEST=1 without a fake shell: AIB refuses to run it.";
  }
  if (setupOs() !== "linux") {
    return "This step runs in the setup terminal on Linux only.";
  }
  return { file: "/bin/sh", args: ["-c", command] };
}
