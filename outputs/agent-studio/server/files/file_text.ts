/**
 * The file editor's view of a file's bytes (aib-shared/designs/file-editor, design v2 3.1; architect review must-fix 8).
 *
 * decodeDisk(bytes) says what the bytes are and whether AIB can edit them:
 *   sha          SHA-256 of the raw bytes (the save's hash check compares raw bytes, never decoded text)
 *   encoding     'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'unknown' (a fatal UTF-8 decoder failed) | 'binary'
 *   eol          'lf' | 'crlf' | 'mixed' (both LF and CRLF) | 'none' (one line)
 *   loneCr       a CR that is not followed by LF (CodeMirror and the old spike turned it into a line break: a save would change the file)
 *   finalNewline the text ends with a line break
 *   text         the text with line breaks as '\n' (editable files only), else null
 *   editable     false for binary, UTF-16, non-UTF-8, over 5 MB and lone CR; `reason` says which
 * encodeText(text, eol, bom) builds the bytes a save writes: '\n' becomes the file's line ending (a mixed file takes its more common
 * one, `majority`), and the BOM goes back when the file had one. The line ending and BOM always follow the disk version the live text
 * last took in (review must-fix 8: Claude's Write often turns CRLF into LF, and a save must not quietly put CRLF back).
 */
import { createHash } from 'node:crypto';

/** The editable size limit (the read-only view keeps its own 1 MB limit, worktrees/files.ts LIMITS.readBytes). */
export const EDIT_LIMIT = 5 * 1024 * 1024;
/** A NUL in the first 8 KB means binary (the same probe as the Files view). */
const PROBE = 8192;

export type Encoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'unknown' | 'binary';
export type Eol = 'lf' | 'crlf' | 'mixed' | 'none';
export type ReadOnlyReason = '' | 'binary' | 'utf16' | 'not_utf8' | 'too_big' | 'lone_cr';

export interface DiskText {
  sha: string;
  size: number;
  encoding: Encoding;
  bom: boolean;
  eol: Eol;
  /** The ending a save writes: the file's own, or the more common one of a mixed file ('lf' for a one-line file). */
  majority: 'lf' | 'crlf';
  loneCr: boolean;
  finalNewline: boolean;
  text: string | null;
  editable: boolean;
  reason: ReadOnlyReason;
}

/** The words a footer shows for each reason (also the tab's "Read-only · …" line). */
export const REASON_TEXT: Record<Exclude<ReadOnlyReason, ''>, string> = {
  binary: 'Binary file',
  utf16: 'UTF-16: editing comes later',
  not_utf8: 'Not UTF-8 text',
  too_big: 'Over 5 MB',
  lone_cr: 'Has a lone CR line break',
};

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const BOM8 = [0xef, 0xbb, 0xbf];

/** What `bytes` are, and their text when AIB can edit them. `size` defaults to the bytes' length (a too-big file passes a probe). */
export function decodeDisk(bytes: Uint8Array, size = bytes.length): DiskText {
  const out: DiskText = {
    sha: sha256(bytes),
    size,
    encoding: 'utf-8',
    bom: false,
    eol: 'none',
    majority: 'lf',
    loneCr: false,
    finalNewline: false,
    text: null,
    editable: false,
    reason: '',
  };
  // UTF-16 by its BOM, before the NUL probe (its ASCII is full of NULs)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { ...out, encoding: 'utf-16le', reason: 'utf16' };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { ...out, encoding: 'utf-16be', reason: 'utf16' };
  if (bytes.subarray(0, PROBE).includes(0)) return { ...out, encoding: 'binary', reason: 'binary' };
  const bom = bytes.length >= 3 && bytes[0] === BOM8[0] && bytes[1] === BOM8[1] && bytes[2] === BOM8[2];
  out.bom = bom;
  out.encoding = bom ? 'utf-8-bom' : 'utf-8';
  if (size > EDIT_LIMIT) return { ...out, reason: 'too_big' };
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return { ...out, encoding: 'unknown', reason: 'not_utf8' };
  }
  let crlf = 0, lf = 0, lone = 0;
  for (let i = raw.indexOf('\r'), j = raw.indexOf('\n');;) {
    // count CRLF / lone CR / bare LF in one pass over the break characters only
    if (i < 0 && j < 0) break;
    if (i >= 0 && (j < 0 || i < j)) {
      if (raw.charCodeAt(i + 1) === 10) {
        crlf++;
        j = raw.indexOf('\n', i + 2);
        i = raw.indexOf('\r', i + 2);
      } else {
        lone++;
        i = raw.indexOf('\r', i + 1);
      }
    } else {
      lf++;
      j = raw.indexOf('\n', j + 1);
    }
  }
  out.eol = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
  out.majority = crlf > lf ? 'crlf' : 'lf';
  out.finalNewline = raw.endsWith('\n');
  if (lone) return { ...out, loneCr: true, eol: 'mixed', reason: 'lone_cr' };
  out.text = crlf ? raw.replaceAll('\r\n', '\n') : raw;
  out.editable = true;
  return out;
}

/** The bytes a save writes for `text` ('\n' line breaks) with this file's line ending and BOM. */
export function encodeText(text: string, eol: 'lf' | 'crlf', bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(eol === 'crlf' ? text.replaceAll('\n', '\r\n') : text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set(BOM8, 0);
  out.set(body, 3);
  return out;
}

/** Read a file for the editor: its stat and bytes (a too-big file: only the probe). Throws Deno's errors (NotFound...). */
export function readDisk(abs: string): { disk: DiskText; mtime: number; bytes: Uint8Array | null } {
  const st = Deno.statSync(abs);
  if (!st.isFile) throw new Deno.errors.NotFound('not a file');
  const mtime = st.mtime ? st.mtime.getTime() : 0;
  if (st.size > EDIT_LIMIT) {
    const f = Deno.openSync(abs, { read: true });
    try {
      const buf = new Uint8Array(PROBE);
      const n = f.readSync(buf) ?? 0;
      const disk = decodeDisk(buf.subarray(0, n), st.size);
      // the hash of a too-big file is of its whole bytes (a save is refused anyway; the poll only needs "did it change")
      return { disk: { ...disk, sha: `size:${st.size}:${mtime}`, reason: disk.reason || 'too_big', editable: false, text: null }, mtime, bytes: null };
    } finally {
      f.close();
    }
  }
  const bytes = Deno.readFileSync(abs);
  return { disk: decodeDisk(bytes), mtime, bytes };
}
