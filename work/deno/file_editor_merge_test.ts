/**
 * The file editor's pure parts (aib-shared/designs/file-editor; architect review 2026-11-16 must-fixes 2, 3 and 8):
 * files/line_merge.ts (the line 3-way merge: time limit, per-line overlaps, code points) and files/file_text.ts (sha, encoding, line
 * endings, BOM, what AIB can't edit, and the bytes a save writes).
 */
import { assert, assertEquals } from './_assert.ts';
import { changedRanges, diffLines, merge3, narrowEdit, rangesText, splitLines } from '../../app/server/files/line_merge.ts';
import { decodeDisk, EDIT_LIMIT, encodeText, sha256 } from '../../app/server/files/file_text.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const apply = (text: string, edits: { from: number; to: number; insert: string }[]) => {
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) out = out.slice(0, edits[i].from) + edits[i].insert + out.slice(edits[i].to);
  return out;
};
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1) + '\n').join('');

Deno.test('splitLines keeps each line break; diffLines finds the changed lines', () => {
  assertEquals(splitLines(''), []);
  assertEquals(splitLines('a\nb'), ['a\n', 'b']);
  assertEquals(splitLines('a\n\n'), ['a\n', '\n']);
  assertEquals(diffLines(['a\n', 'b\n', 'c\n'], ['a\n', 'B\n', 'c\n']), [{ a0: 1, a1: 2, b0: 1, b1: 2 }]);
  assertEquals(diffLines(['a\n'], ['a\n', 'b\n']), [{ a0: 1, a1: 1, b0: 1, b1: 2 }]);
  assertEquals(diffLines(['a\n', 'x\n', 'b\n', 'y\n', 'c\n'], ['a\n', 'b\n', 'c\n', 'z\n']), [
    { a0: 1, a1: 2, b0: 1, b1: 1 },
    { a0: 3, a1: 4, b0: 2, b1: 2 },
    { a0: 5, a1: 5, b0: 3, b1: 4 },
  ]);
});

Deno.test('merge3: a clean text takes the disk change as small edits', () => {
  const base = lines(10);
  const theirs = base.replace('line 3\n', 'line three\n').replace('line 9\n', '');
  const r = merge3(base, base, theirs);
  assertEquals(r.merged, theirs);
  assertEquals(apply(base, r.edits), theirs);
  assertEquals(r.overlaps, []);
  assertEquals(r.edits.length, 2, 'one edit per changed place, not one whole-file replace');
  assert(r.edits[0].to - r.edits[0].from < 8, `narrowed to the changed word: ${JSON.stringify(r.edits[0])}`);
});

Deno.test('merge3: disk changes away from the user\'s lines go in; the user\'s lines stay', () => {
  const base = lines(10);
  const mine = base.replace('line 2\n', 'line 2 // mine\n');
  const theirs = base.replace('line 8\n', 'line 8 // theirs\n');
  const r = merge3(base, mine, theirs);
  assertEquals(r.merged, base.replace('line 2\n', 'line 2 // mine\n').replace('line 8\n', 'line 8 // theirs\n'));
  assertEquals(apply(mine, r.edits), r.merged);
  assertEquals(r.overlaps, []);
  assertEquals(r.applied, 1);
  assertEquals(r.userRanges, [[2, 2]]);
});

Deno.test('merge3: an overlap keeps the user\'s line and applies the rest of that disk hunk (keep mine = the user\'s lines only)', () => {
  const base = lines(6);
  const mine = base.replace('line 3\n', 'line 3 USER\n');
  // the agent rewrote lines 2-4 as one hunk
  const theirs = base.replace('line 2\nline 3\nline 4\n', 'line 2 A\nline 3 A\nline 4 A\n');
  const r = merge3(base, mine, theirs);
  assertEquals(r.merged, 'line 1\nline 2 A\nline 3 USER\nline 4 A\nline 5\nline 6\n', 'lines 2 and 4 of the hunk went in');
  assertEquals(r.overlaps.length, 1);
  const o = r.overlaps[0];
  assertEquals([o.line0, o.line1, o.theirs, o.base], [2, 3, 'line 3 A\n', 'line 3\n']);
  assertEquals(r.merged.slice(o.from, o.to), 'line 3 USER\n', 'the overlap points at the user\'s line in the merged text');
  // a save now ("keep mine") writes exactly this: the agent's neighbouring lines are not reverted
});

Deno.test('merge3: insertions next to the user\'s lines go in on the right side; same-place insertions overlap', () => {
  const base = lines(4);
  const mine = base.replace('line 2\n', 'line 2\nmine\n');
  const after = merge3(base, mine, base.replace('line 3\n', 'line 3\ntheirs\n'));
  assertEquals(after.merged, 'line 1\nline 2\nmine\nline 3\ntheirs\nline 4\n');
  const same = merge3(base, mine, base.replace('line 2\n', 'line 2\ntheirs\n'));
  assertEquals(same.merged, mine, 'two insertions at the same place: the user\'s stays');
  assertEquals(same.overlaps.length, 1);
  const before = merge3(base, base.replace('line 3\n', 'LINE 3\n'), base.replace('line 3\n', 'new\nline 3\n'));
  assertEquals(before.merged, 'line 1\nline 2\nnew\nLINE 3\nline 4\n', 'an insertion just before the user\'s changed line goes in');
});

Deno.test('merge3 and narrowEdit never split a surrogate pair (emoji round trip)', () => {
  const base = 'const face = "😀";\nconst x = 1;\n';
  const theirs = 'const face = "😃";\nconst x = 1;\n';
  const r = merge3(base, base, theirs);
  assertEquals(r.merged, theirs);
  for (const e of r.edits) {
    const hi = (c: number) => c >= 0xd800 && c <= 0xdbff;
    assert(!hi(base.charCodeAt(e.from - 1)), `edit starts inside a pair: ${JSON.stringify(e)}`);
    assert(!hi(base.charCodeAt(e.to - 1)) || e.to === base.length, `edit ends inside a pair: ${JSON.stringify(e)}`);
  }
  assertEquals(r.edits, [{ from: 14, to: 16, insert: '😃' }], 'the whole emoji is replaced');
  // the bytes a save would write are exactly the agent's bytes
  assertEquals(sha256(encodeText(apply(base, r.edits), 'lf', false)), sha256(enc(theirs)));
  // shared low halves too: U+1F600 vs U+1F680 (same high half, different low half) and a pair next to plain text
  assertEquals(narrowEdit('a😀b', 'a🚀b'), { from: 1, to: 3, insert: '🚀' });
  assertEquals(narrowEdit('😀x', '😀y'), { from: 2, to: 3, insert: 'y' });
  assertEquals(narrowEdit('x😀', 'y😀'), { from: 0, to: 1, insert: 'y' });
  // a dirty text with an emoji line changed on disk elsewhere
  const mine = base.replace('x = 1', 'x = 2');
  const m = merge3(base, mine, theirs);
  assertEquals(m.merged, 'const face = "😃";\nconst x = 2;\n');
  assert(!m.merged.includes('�'));
});

Deno.test('merge3 gives up past its time or size limit: a dirty text is left alone as one overlap, a clean one takes the disk', () => {
  // a formatter-style rewrite of every line with a tiny budget
  const base = lines(30000, (i) => `value_${i} = compute(${i})`);
  const theirs = lines(30000, (i) => `value_${i} = compute( ${i} )`);
  const mine = base.replace('value_10 =', 'value_10 /*mine*/ =');
  const t0 = performance.now();
  const r = merge3(base, mine, theirs, 5);
  const took = performance.now() - t0;
  assert(took < 1500, `the merge stopped near its budget: ${took} ms`);
  assertEquals(r.fallback, 'time');
  assertEquals(r.merged, mine, 'nothing merged half way');
  assertEquals(r.edits, []);
  assertEquals(r.overlaps.length, 1);
  assert(r.rewrite);
  const clean = merge3(base, base, theirs, 5);
  assertEquals(clean.merged, theirs);
  assertEquals(apply(base, clean.edits), theirs);
  const huge = 'x'.repeat(2 * 1024 * 1024 + 10);
  assertEquals(merge3(huge, huge + 'y', 'z' + huge).fallback, 'size');
});

Deno.test('merge3 marks a formatter rewrite (more than 3 overlaps) as one rewrite', () => {
  const base = lines(40, (i) => `x${i}=1`);
  const theirs = lines(40, (i) => `x${i} = 1`);
  let mine = base;
  for (const i of [3, 10, 17, 24, 31]) mine = mine.replace(`x${i}=1\n`, `x${i}=2\n`);
  const r = merge3(base, mine, theirs);
  assertEquals(r.overlaps.length, 5);
  assert(r.rewrite);
  assertEquals(r.merged.split('\n').filter((l) => l.includes(' = 1')).length, 35, 'the other 35 lines still went in');
});

Deno.test('changedRanges and rangesText name the user\'s lines', () => {
  const old = lines(20);
  const next = old.replace('line 12\n', 'twelve\n').replace('line 13\n', 'thirteen\n').replace('line 3\n', '');
  assertEquals(changedRanges(old, next), [[3, 3], [11, 12]]);
  assertEquals(rangesText([[12, 18]]), '12-18');
  assertEquals(rangesText([[3, 3], [9, 11]]), '3, 9-11');
});

Deno.test('decodeDisk: sha, encoding, line endings, BOM, final newline', () => {
  const lf = decodeDisk(enc('a\nb\n'));
  assertEquals([lf.encoding, lf.eol, lf.bom, lf.finalNewline, lf.editable, lf.text], ['utf-8', 'lf', false, true, true, 'a\nb\n']);
  assertEquals(lf.sha, sha256(enc('a\nb\n')));
  const crlf = decodeDisk(enc('﻿a\r\nb'));
  assertEquals([crlf.encoding, crlf.eol, crlf.bom, crlf.finalNewline, crlf.text, crlf.majority], ['utf-8-bom', 'crlf', true, false, 'a\nb', 'crlf']);
  const mixed = decodeDisk(enc('a\r\nb\r\nc\n'));
  assertEquals([mixed.eol, mixed.majority, mixed.editable], ['mixed', 'crlf', true]);
  assertEquals(decodeDisk(enc('one line')).eol, 'none');
});

Deno.test('decodeDisk: what AIB can\'t edit (binary, UTF-16, not UTF-8, over 5 MB, lone CR)', () => {
  const r = (b: Uint8Array, size?: number) => {
    const d = decodeDisk(b, size);
    return [d.editable, d.reason, d.text];
  };
  assertEquals(r(new Uint8Array([0x61, 0, 0x62])), [false, 'binary', null]);
  assertEquals(r(new Uint8Array([0xff, 0xfe, 0x61, 0])), [false, 'utf16', null], 'UTF-16 by its BOM, before the NUL probe');
  assertEquals(r(new Uint8Array([0xfe, 0xff, 0, 0x61])), [false, 'utf16', null]);
  assertEquals(r(new Uint8Array([0x61, 0xe9, 0x62])), [false, 'not_utf8', null], 'Latin-1 bytes are not turned into U+FFFD');
  assertEquals(r(enc('a'), EDIT_LIMIT + 1), [false, 'too_big', null]);
  assertEquals(r(enc('a\rb\r\nc')), [false, 'lone_cr', null], 'a stray CR would change on save');
});

Deno.test('encodeText writes the file\'s own line ending and BOM back, byte for byte', () => {
  for (const raw of ['a\r\nb\r\n', '﻿x\ny\n', '﻿p\r\nq', 'plain', '']) {
    const d = decodeDisk(enc(raw));
    assertEquals(sha256(encodeText(d.text!, d.majority, d.bom)), d.sha, JSON.stringify(raw));
  }
});
