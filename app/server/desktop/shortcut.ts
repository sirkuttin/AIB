/**
 * Windows first run: a Start menu shortcut to the running AIB.exe (the app is a per-user zip extracted anywhere). Made when
 * %APPDATA%\Microsoft\Windows\Start Menu\Programs\AIB.lnk is missing or points elsewhere, through WScript.Shell in a PowerShell
 * child. The child shares this process's hidden console (platform/console.ts ensureHiddenConsole, called by main.ts first), so
 * no window shows. Never on macOS or Linux.
 */
export const SHORTCUT_NAME = 'AIB.lnk';

/** %APPDATA%\Microsoft\Windows\Start Menu\Programs, or null when APPDATA is unset. */
export function startMenuDir(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): string | null {
  const appData = env('APPDATA');
  return appData ? `${appData}\\Microsoft\\Windows\\Start Menu\\Programs` : null;
}

const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The PowerShell that makes (or keeps) the shortcut. Prints 'same' or 'made'. */
export function shortcutScript(lnkPath: string, exe: string): string {
  return [
    `$p = ${psQuote(lnkPath)}; $t = ${psQuote(exe)}`,
    `$s = New-Object -ComObject WScript.Shell`,
    `if ((Test-Path -LiteralPath $p) -and ($s.CreateShortcut($p).TargetPath -ieq $t)) { 'same'; exit 0 }`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $p) | Out-Null`,
    `$l = $s.CreateShortcut($p); $l.TargetPath = $t; $l.WorkingDirectory = (Split-Path -LiteralPath $t)`,
    `$l.IconLocation = "$t,0"; $l.Description = 'AIB'; $l.Save(); 'made'`,
  ].join('\n');
}

/** powershell.exe's arguments: the script as -EncodedCommand (UTF-16LE base64), so no quoting reaches the command line. No
 * -WindowStyle Hidden: that hides whatever console the child shares (a developer's terminal when run from tests). */
export function shortcutArgs(lnkPath: string, exe: string): string[] {
  const script = shortcutScript(lnkPath, exe);
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes[2 * i] = c & 0xff;
    bytes[2 * i + 1] = c >> 8;
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', btoa(bin)];
}

/** A quick check without PowerShell: the .lnk file holds the exe's full path (ANSI LinkInfo or UTF-16 string data). */
export function lnkMentions(bytes: Uint8Array, exe: string): boolean {
  const want = exe.toLowerCase();
  const ansi = new TextDecoder('latin1').decode(bytes).toLowerCase();
  if (ansi.includes(want)) return true;
  const utf16 = new TextDecoder('utf-16le').decode(bytes.length % 2 ? bytes.subarray(0, bytes.length - 1) : bytes).toLowerCase();
  return utf16.includes(want);
}

export type ShortcutResult = 'same' | 'made' | 'skipped' | 'failed';

/** Makes the shortcut if needed. `dir` is injectable for tests; the default is the real Start menu folder. */
export async function ensureStartMenuShortcut(
  exe: string,
  dir: string | null = startMenuDir(),
  os: string = Deno.build.os,
): Promise<ShortcutResult> {
  if (os !== 'windows' || !dir || !/\.exe$/i.test(exe) || /(^|[\\/])deno\.exe$/i.test(exe)) return 'skipped';
  const lnk = `${dir}\\${SHORTCUT_NAME}`;
  try {
    if (lnkMentions(await Deno.readFile(lnk), exe)) return 'same';
  } catch { /* missing: make it */ }
  try {
    const out = await new Deno.Command('powershell.exe', { args: shortcutArgs(lnk, exe), stdin: 'null', stdout: 'piped', stderr: 'null' })
      .output();
    const text = new TextDecoder().decode(out.stdout).trim();
    return out.success && (text === 'same' || text === 'made') ? text : 'failed';
  } catch {
    return 'failed';
  }
}
