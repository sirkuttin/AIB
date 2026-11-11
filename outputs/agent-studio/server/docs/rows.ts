/**
 * Changed files as doc rows, for Changes and Merge: every changed path under docs/<doc>/ of a doc (a folder with doc.aibdoc, or a
 * doc.aibdoc that was deleted) becomes part of one row {doc, dir, title, pages (how many pages' Markdown copies changed), paths}.
 * The page lists those paths under the row and not as files. No imports beyond Deno, so the worktree code can use it.
 */
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const COPY = /^\d{2,}-[^/]*\.md$/;

export interface DocRow {
  doc: string;
  /** docs/<doc> (forward slashes, relative to the same root as the paths). */
  dir: string;
  title: string;
  /** Pages whose Markdown copy changed (at least 1 when only doc.aibdoc changed). */
  pages: number;
  paths: string[];
}

/** Rows for the changed `paths` (relative to `root`, forward or back slashes); paths of no doc are left out. */
export function docRows(root: string, paths: string[], folder = 'docs'): DocRow[] {
  const rows = new Map<string, DocRow>();
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/');
    const m = new RegExp(`^${folder}/([^/]+)/(.+)$`).exec(path);
    if (!m) continue;
    const [, name, rest] = m;
    let row = rows.get(name);
    if (!row) {
      const aib = `${root}${sep}${folder}${sep}${name}${sep}doc.aibdoc`;
      let title = name, isDoc = rest === 'doc.aibdoc';
      try {
        const parsed = JSON.parse(Deno.readTextFileSync(aib));
        isDoc = true;
        if (typeof parsed?.title === 'string' && parsed.title) title = parsed.title;
      } catch { /* deleted, or not a doc */ }
      if (!isDoc) continue;
      rows.set(name, row = { doc: name, dir: `${folder}/${name}`, title, pages: 0, paths: [] });
    }
    row.paths.push(path);
    if (COPY.test(rest)) row.pages++;
  }
  for (const row of rows.values()) if (!row.pages) row.pages = 1;
  return [...rows.values()];
}
