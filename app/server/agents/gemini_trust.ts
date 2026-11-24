/**
 * Gemini CLI folder trust for AIB's chats (0.15; owner decision 2026-11-24).
 *
 * Gemini starts no MCP server (so AIB's tools never reach the model) in a folder it does not trust, and by default it trusts none.
 * AIB gives every Gemini process its OWN trust file through Gemini's supported variable GEMINI_CLI_TRUSTED_FOLDERS_PATH, so the
 * owner's ~/.gemini/trustedFolders.json is never read or written. The file lists only folders AIB opened a Gemini chat in: the
 * chat's project folder and the AIB worktree copy it works in (one TRUST_FOLDER entry each; never a parent folder, never a home
 * folder, never a wildcard). Gemini treats a TRUST_FOLDER entry as covering the folder and everything under it.
 *
 * File format (Gemini 0.70): { "<absolute folder>": "TRUST_FOLDER" }. Matching is by normalised real path (case-insensitive on
 * Windows). The variable also redirects Gemini's own writes, so a folder the person trusts inside an AIB chat is kept in AIB's file.
 */
import { readJsonFile, saveJson } from '../state/json.ts';
import { isDict } from '../core/py.ts';

export const GEMINI_TRUST_ENV = 'GEMINI_CLI_TRUSTED_FOLDERS_PATH';
export const GEMINI_TRUST_FILE = 'gemini-trusted-folders.json';
const MAX_ENTRIES = 2000;

/** Add `folders` to the trust file (created if missing); entries already there stay (including a DO_NOT_TRUST the person set). */
export function trustFolders(file: string, folders: readonly string[]): Record<string, string> {
  let all: Record<string, string> = {};
  try {
    const [status, raw] = readJsonFile(file);
    if (status === 'ok' && isDict(raw)) {
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') all[k] = v;
    }
  } catch { /* unreadable: start clean */ }
  const before = JSON.stringify(all);
  for (const folder of folders) {
    const path = folder.trim();
    if (!path || path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) continue; // never a drive or filesystem root
    if (Object.keys(all).some((k) => k.toLowerCase() === path.toLowerCase())) continue; // already listed (any value)
    if (Object.keys(all).length >= MAX_ENTRIES) {
      all = Object.fromEntries(Object.entries(all).slice(-MAX_ENTRIES + folders.length)); // the oldest go
    }
    all[path] = 'TRUST_FOLDER';
  }
  if (JSON.stringify(all) !== before) saveJson(file, all, '.gemini-trust-');
  return all;
}
