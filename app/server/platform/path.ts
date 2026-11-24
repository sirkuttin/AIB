/** Minimal path helpers (both separators on Windows), so the server needs no remote std import. */
const SEP = /[\\/]+/;

export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return '.';
  if (index === 0) return trimmed[0];
  if (index === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, index);
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(SEP);
  return parts[parts.length - 1] ?? '';
}

export function join(...parts: string[]): string {
  const sep = Deno.build.os === 'windows' ? '\\' : '/';
  return parts.filter((p) => p !== '').map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
}
