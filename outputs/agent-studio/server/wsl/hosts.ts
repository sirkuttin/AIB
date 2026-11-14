// stub: replaced by Track B on merge
/**
 * The WSL hosts of this process, one per distro (docs/wsl/design.md sections 1 and 3). Track C's thin stand-in with the names Track B
 * exports: `wslHosts.get(distro)` returns that distro's WslHost. The stub knows no distro, so every WSL project reads as unavailable
 * until Track B's registry replaces it.
 */
import type { WslHost } from './contract.ts';

export const wslHosts = {
  get(_distro: string): WslHost | null {
    return null;
  },
};
