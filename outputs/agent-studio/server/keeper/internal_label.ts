// stub: replaced by Track B on merge (Track B exports isAibInternalLabel from keeper/link.ts; drop this file and import it from there)
/**
 * Channels AIB itself keeps in a keeper for WSL (contract.ts WSL_HOLD_LABEL, WSL_HELPER_LABEL): the hold and the helper. They have no
 * chat note and no terminal label, and must never be stopped as orphans or rebuilt as chats (design section 11, item 1).
 */
import { WSL_HELPER_LABEL, WSL_HOLD_LABEL } from '../wsl/contract.ts';

export function isAibInternalLabel(label: unknown): boolean {
  if (typeof label !== 'string' || !label) return false;
  try {
    const value = JSON.parse(label);
    return !!value && typeof value === 'object' && (value.aib === WSL_HOLD_LABEL.aib || value.aib === WSL_HELPER_LABEL.aib);
  } catch {
    return false;
  }
}
