// stub: replaced by Track B on merge
/**
 * The WSL distros of this PC (docs/wsl/design.md section 2: Lxss in the registry, no console, never boots the VM). Track C's thin
 * stand-in: `detectDistros()` with the shape Track C's routes read. The stub finds none.
 */
export interface DistroInfo {
  /** As the user named it (Lxss DistributionName), e.g. "Ubuntu". */
  name: string;
  /** 1 or 2; only WSL2 distros are offered in phase 1. */
  version: number;
  /** Lxss State. */
  state: number;
}

export function detectDistros(): Promise<DistroInfo[]> {
  return Promise.resolve([]);
}
