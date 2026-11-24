/**
 * The file editor's 3-way merge (architect review 2026-11-16, must-fixes 2 and 3): base = the disk text the live text last took in,
 * mine = the live text (the user's unsaved edits), theirs = the new disk text.
 *
 * By line, like `git merge-file`: a Myers diff of whole lines (each line keeps its '\n'), never a character diff of the file. It runs
 * on the web server's one event loop, which also streams every chat, so it has a time limit (and a size limit): past either it gives
 * up and the merge "degrades": a clean text takes the new disk text as one replace, a dirty text is left alone and the whole file is
 * one overlap. Nothing is ever merged half way.
 *
 * Overlap granularity (must-fix 3): a disk hunk is split into one change per base line (a changed line, a deleted line) plus one block
 * of added lines. Only the parts that touch a line the user changed are left out; the rest of that hunk is applied. So a Save while
 * an overlap is open ("keep mine") keeps the user's lines only, and never quietly reverts the agent's neighbouring lines.
 *
 * Code points (must-fix 2): every edit is a whole-line replace narrowed to its common prefix and suffix, and both boundaries are
 * moved off the middle of a surrogate pair. So 😀 → 😃 is one replace of the whole emoji, never a split pair (Yjs turns a split pair
 * into U+FFFD, yjs#248, and the next save would write it to disk).
 */

export interface Hunk {
  /** Lines [a0, a1) of the old text became lines [b0, b1) of the new one. */
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** One edit of `mine` in UTF-16 offsets (what Y.Text and CodeMirror use), never inside a surrogate pair. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface Overlap {
  /** The user's lines in the merged text (0-based, [line0, line1); an empty range marks the line before which the user inserted). */
  line0: number;
  line1: number;
  /** The same as UTF-16 offsets in the merged text. */
  from: number;
  to: number;
  /** What the disk has for those lines, and what the base had. */
  theirs: string;
  base: string;
}

export interface MergeResult {
  /** The edits that turn mine into merged, ascending and not overlapping (apply them from the last one back). */
  edits: TextEdit[];
  merged: string;
  overlaps: Overlap[];
  /** How many disk changes went in. */
  applied: number;
  /** '' normally; 'size' or 'time' when the merge gave up (see above). */
  fallback: '' | 'size' | 'time';
  /** The disk change looks like a whole-file rewrite (a formatter): more than 3 overlaps, or more than 30% of the lines changed. */
  rewrite: boolean;
  /** The user's changed lines in mine before the merge, 1-based inclusive [first, last] ranges (for the notes to agents). */
  userRanges: [number, number][];
}

export const MERGE_LIMITS = {
  /** Past this many UTF-16 units in any of the three texts, a dirty text is not merged at all. */
  maxChars: 2 * 1024 * 1024,
  /** The whole merge's time budget on the server thread. */
  budgetMs: 150,
  /** Myers stops past this edit distance (in lines): its trace grows with the square of it. */
  maxD: 4000,
};

/** The lines of `text`, each with its '\n' (the last one may have none). '' has no lines. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/** The line diff of a → b, or null when it would take longer than `deadline` (performance.now()) or more than maxD steps. */
export function diffLines(a: string[], b: string[], deadline = performance.now() + MERGE_LIMITS.budgetMs, maxD = MERGE_LIMITS.maxD): Hunk[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf, m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ a0: pre, a1: pre + n, b0: pre, b1: pre + m }];
  // lines as numbers, so the inner loop compares integers
  const ids = new Map<string, number>();
  const idOf = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, v = ids.size);
    return v;
  };
  const A = new Int32Array(n), B = new Int32Array(m);
  for (let i = 0; i < n; i++) A[i] = idOf(a[pre + i]);
  for (let j = 0; j < m; j++) B[j] = idOf(b[pre + j]);
  const max = n + m, off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let D = -1;
  outer: for (let d = 0; d <= max; d++) {
    if (d > maxD || (d & 15) === 0 && performance.now() > deadline) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(V.slice(off - d, off + d + 1));
        D = d;
        break outer;
      }
    }
    trace.push(V.slice(off - d, off + d + 1));
  }
  if (D < 0) return null;
  // walk back: the matched line pairs, last first
  const pairs: number[] = [];
  let x = n, y = m;
  for (let d = D; d > 0; d--) {
    const prev = trace[d - 1];
    const get = (k: number) => prev[k + d - 1];
    const k = x - y;
    const pk = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const px = get(pk), py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
      pairs.push(x, y);
    }
    if (x === px) y--; // a line of b was added
    else x--; // a line of a was removed
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push(x, y);
  }
  const hunks: Hunk[] = [];
  let i = 0, j = 0;
  for (let p = pairs.length - 2; p >= 0; p -= 2) {
    const pi = pairs[p], pj = pairs[p + 1];
    if (pi > i || pj > j) hunks.push({ a0: pre + i, a1: pre + pi, b0: pre + j, b1: pre + pj });
    i = pi + 1;
    j = pj + 1;
  }
  if (i < n || j < m) hunks.push({ a0: pre + i, a1: pre + n, b0: pre + j, b1: pre + m });
  return hunks;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The smallest replace that turns `old` (at offset `at`) into `next`, with both ends on code point boundaries. */
export function narrowEdit(old: string, next: string, at = 0): TextEdit {
  let p = 0;
  const lim = Math.min(old.length, next.length);
  while (p < lim && old.charCodeAt(p) === next.charCodeAt(p)) p++;
  if (p > 0 && (isHigh(old.charCodeAt(p - 1)) || isLow(old.charCodeAt(p)) || isLow(next.charCodeAt(p)))) p--;
  let s = 0;
  while (s < lim - p && old.charCodeAt(old.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  // the suffix starts at old.length - s: not on the low half of a pair
  if (s > 0 && (isLow(old.charCodeAt(old.length - s)) || isHigh(old.charCodeAt(old.length - s - 1)) || isHigh(next.charCodeAt(next.length - s - 1)))) s--;
  return { from: at + p, to: at + old.length - s, insert: next.slice(p, next.length - s) };
}

/** A user hunk and a disk change touch: their base line ranges intersect, or two insertions at the same place. */
function touches(s: number, e: number, us: number, ue: number): boolean {
  if (s < e && us < ue) return s < ue && us < e;
  if (s === e && us === ue) return s === us;
  if (s === e) return us < s && s < ue; // a disk insertion strictly inside the user's changed lines
  return s < us && us < e; // the user's insertion strictly inside the disk's changed lines
}

const lineStarts = (lines: string[]) => {
  const out = new Array<number>(lines.length + 1);
  out[0] = 0;
  for (let i = 0; i < lines.length; i++) out[i + 1] = out[i] + lines[i].length;
  return out;
};

const rangesOf = (hunks: Hunk[]): [number, number][] => hunks.map((h) => [h.b0 + 1, Math.max(h.b0 + 1, h.b1)]);

/** Merge `theirs` into `mine` against `base` (see the file comment). */
export function merge3(base: string, mine: string, theirs: string, budgetMs = MERGE_LIMITS.budgetMs): MergeResult {
  const clean = base === mine;
  const giveUp = (why: 'size' | 'time', userRanges: [number, number][] = []): MergeResult => {
    if (clean) {
      // a clean text simply becomes the disk text: one replace, narrowed (the cursor stays where the text did not change)
      const edit = narrowEdit(mine, theirs);
      const edits = edit.from === edit.to && !edit.insert ? [] : [edit];
      return { edits, merged: theirs, overlaps: [], applied: edits.length, fallback: why, rewrite: false, userRanges };
    }
    const lines = splitLines(mine).length;
    return {
      edits: [],
      merged: mine,
      overlaps: [{ line0: 0, line1: lines, from: 0, to: mine.length, theirs, base }],
      applied: 0,
      fallback: why,
      rewrite: true,
      userRanges,
    };
  };
  if (theirs === base) return { edits: [], merged: mine, overlaps: [], applied: 0, fallback: '', rewrite: false, userRanges: [] };
  if (Math.max(base.length, mine.length, theirs.length) > MERGE_LIMITS.maxChars) return giveUp('size');
  const deadline = performance.now() + budgetMs;
  const B = splitLines(base), M = splitLines(mine), T = splitLines(theirs);
  const mh = clean ? [] : diffLines(B, M, deadline);
  if (!mh) return giveUp('time');
  const th = diffLines(B, T, deadline);
  if (!th) return giveUp('time', rangesOf(mh));
  // the disk hunks, one change per base line plus one block of added lines
  type Op = { s: number; e: number; ins: string[] };
  const ops: Op[] = [];
  let changedLines = 0;
  for (const h of th) {
    const la = h.a1 - h.a0, lb = h.b1 - h.b0, p = Math.min(la, lb);
    changedLines += Math.max(la, lb);
    for (let i = 0; i < p; i++) ops.push({ s: h.a0 + i, e: h.a0 + i + 1, ins: [T[h.b0 + i]] });
    for (let i = p; i < la; i++) ops.push({ s: h.a0 + i, e: h.a0 + i + 1, ins: [] });
    if (lb > la) ops.push({ s: h.a1, e: h.a1, ins: T.slice(h.b0 + p, h.b1) });
  }
  const mStart = lineStarts(M);
  const edits: TextEdit[] = [];
  const hit = new Map<Hunk, Op[]>();
  let applied = 0;
  let ui = 0, shift = 0;
  for (const op of ops) {
    // the user's hunks that end at or before this change move it in mine
    while (ui < mh.length && mh[ui].a1 <= op.s && !(mh[ui].a0 === mh[ui].a1 && mh[ui].a0 === op.s && op.s === op.e)) {
      shift += (mh[ui].b1 - mh[ui].b0) - (mh[ui].a1 - mh[ui].a0);
      ui++;
    }
    const against = mh.filter((u) => touches(op.s, op.e, u.a0, u.a1));
    if (against.length) {
      for (const u of against) hit.set(u, [...(hit.get(u) ?? []), op]);
      continue;
    }
    const ms = op.s + shift, me = ms + (op.e - op.s);
    const from = mStart[ms], to = mStart[me];
    const edit = narrowEdit(mine.slice(from, to), op.ins.join(''), from);
    if (edit.from !== edit.to || edit.insert) edits.push(edit);
    applied++;
  }
  // join edits that touch (two neighbouring changed lines), keep them ascending
  edits.sort((x, y) => x.from - y.from);
  let merged = '';
  let at = 0;
  for (const e of edits) {
    merged += mine.slice(at, e.from) + e.insert;
    at = e.to;
  }
  merged += mine.slice(at);
  // offsets in mine -> offsets in merged (no edit is inside an overlap, so this is exact)
  const moved = (pos: number) => {
    let d = 0;
    for (const e of edits) if (e.to <= pos) d += e.insert.length - (e.to - e.from);
    return pos + d;
  };
  const mergedStarts = lineStarts(splitLines(merged));
  const lineAt = (pos: number) => {
    let lo = 0, hi = mergedStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (mergedStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const overlaps: Overlap[] = [];
  for (const u of mh) {
    const got = hit.get(u);
    if (!got) continue;
    const from = moved(mStart[u.b0]), to = moved(mStart[u.b1]);
    const line0 = lineAt(from);
    const theirsText = got.map((o) => o.ins.join('')).join('');
    const s = Math.min(u.a0, ...got.map((o) => o.s)), e = Math.max(u.a1, ...got.map((o) => o.e));
    overlaps.push({ line0, line1: line0 + (u.b1 - u.b0), from, to, theirs: theirsText, base: B.slice(s, e).join('') });
  }
  const rewrite = overlaps.length > 3 || (B.length > 0 && changedLines / B.length > 0.3 && overlaps.length > 0);
  return { edits, merged, overlaps, applied, fallback: '', rewrite, userRanges: rangesOf(mh) };
}

/** The changed line ranges of `next` against `old` (1-based, inclusive), for the notes to agents; [] when unknown in time. */
export function changedRanges(old: string, next: string, budgetMs = MERGE_LIMITS.budgetMs): [number, number][] {
  if (Math.max(old.length, next.length) > MERGE_LIMITS.maxChars) return [];
  const h = diffLines(splitLines(old), splitLines(next), performance.now() + budgetMs);
  return h ? rangesOf(h) : [];
}

/** "12-18" / "3" / "3, 9-11" (at most `max` ranges, then "…"). */
export function rangesText(ranges: [number, number][], max = 4): string {
  const parts = ranges.slice(0, max).map(([a, b]) => (a === b ? String(a) : `${a}-${b}`));
  return parts.join(', ') + (ranges.length > max ? ', …' : '');
}
