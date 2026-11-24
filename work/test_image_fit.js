'use strict';
/* image-fit.js, the rule for fitting a picture before it is attached (the PC composer and the phone share it): when a picture is
   over 5 MiB, over what is left of the 15 MiB, or over 2576 px on its long edge it is re-encoded: long edge at most 2576, PNG while
   that fits, then WebP / JPEG at quality 0.9, 0.8, 0.7; small pictures and GIFs are kept; what still does not fit is refused.
   Decisions run here with a fake canvas; the real browser (paste a big PNG, the chip, the sent bytes) is work/deno/image_fit_e2e_test.ts. */
const { PAGE: APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const F = require(path.join(APP, 'image-fit.js'));

const MiB = 1048576;
const pic = (type, size, name = 'image.png') => Object.assign(new Blob([new Uint8Array(size)], { type }), { name });
const bitmap = (width, height) => ({
  width,
  height,
  closed: false,
  close() {
    this.closed = true;
  },
});
/* A fake canvas: `sizes` maps 'type@quality' to the bytes that encoding would have; a type not in it gives a PNG (as Safari does for WebP). */
function fakeCanvas(sizes, log) {
  return (width, height) => ({
    draw: (b, w, h, opaque) => log.push(['draw', w, h, opaque]),
    blob: async (type, q) => {
      const key = type + (q === undefined ? '' : '@' + q);
      log.push(['blob', width, height, key]);
      if (!(key in sizes)) return new Blob([new Uint8Array(sizes['image/png'] || 1)], { type: 'image/png' });
      return new Blob([new Uint8Array(sizes[key])], { type });
    },
  });
}
const run = async (file, dims, sizes, opts = {}) => {
  const log = [];
  const b = bitmap(...dims);
  const r = await F.shrink(file, { bitmap: b, canvas: fakeCanvas(sizes, log), ...opts });
  return { r, log, b };
};

test('limits are the cap, the total and 2576 px', () => {
  assert.equal(F.LIMITS.imageBytes, 5 * MiB);
  assert.equal(F.LIMITS.imageTotal, 15 * MiB);
  assert.equal(F.LIMITS.longEdge, 2576);
  assert.deepEqual(F.LIMITS.qualities, [0.9, 0.8, 0.7]);
});

test('plan: small stays, big shrinks, GIF is never touched', () => {
  const p = (type, size, width, height, others = 0) => F.plan({ type, size, width, height, others });
  assert.deepEqual(p('image/png', 1000, 800, 600), { action: 'keep' });
  assert.deepEqual(p('image/png', 1000, 2576, 100), { action: 'keep' }, 'exactly 2576 stays');
  assert.deepEqual(p('image/png', 1000, 3840, 2160), { action: 'shrink', width: 2576, height: 1449, budget: 5 * MiB });
  assert.deepEqual(p('image/png', 1000, 2160, 3840), { action: 'shrink', width: 1449, height: 2576, budget: 5 * MiB });
  assert.equal(p('image/png', 6 * MiB, 1000, 1000).action, 'shrink', 'over 5 MiB shrinks even when the edge is fine');
  assert.deepEqual(p('image/jpeg', 4 * MiB, 800, 600, 12 * MiB), { action: 'shrink', width: 800, height: 600, budget: 3 * MiB }, 'the budget is what is left of 15 MiB');
  assert.equal(p('image/png', 10, 10, 10, 15 * MiB).action, 'refuse', 'no room at all');
  assert.equal(p('image/heic', 10, 10, 10).action, 'shrink', 'another type is written again');
  assert.deepEqual(p('image/gif', 3 * MiB, 4000, 4000), { action: 'keep' }, 'a GIF is kept even when big on screen');
  const gif = p('image/gif', 6 * MiB, 100, 100);
  assert.equal(gif.action, 'refuse');
  assert.match(gif.reason, /GIF is larger than 5 MiB/);
  assert.equal(p('image/png', 60 * MiB, 100, 100).action, 'refuse', 'absurd input');
});

test('candidates: PNG first for a PNG, then WebP and JPEG at 0.9, 0.8, 0.7', () => {
  assert.deepEqual(F.candidates('image/png'), [
    ['image/png', undefined],
    ['image/webp', 0.9],
    ['image/webp', 0.8],
    ['image/webp', 0.7],
    ['image/jpeg', 0.9],
    ['image/jpeg', 0.8],
    ['image/jpeg', 0.7],
  ]);
  assert.deepEqual(F.candidates('image/jpeg').map((c) => c[0]), ['image/jpeg', 'image/jpeg', 'image/jpeg']);
  assert.deepEqual(F.candidates('image/heic').map((c) => c[0]), ['image/jpeg', 'image/jpeg', 'image/jpeg']);
});

test('a small picture is unchanged (same file, no note, no canvas)', async () => {
  const file = pic('image/png', 2000);
  const { r, log, b } = await run(file, [1280, 720], { 'image/png': 1 });
  assert.equal(r.file, file);
  assert.equal(r.changed, false);
  assert.equal(r.note, '');
  assert.deepEqual(log, []);
  assert.equal(b.closed, false, 'a bitmap the caller passed stays open');
});

test('a big PNG: shrunk to 2576, stays PNG when that fits, the note says what changed', async () => {
  const { r, log } = await run(pic('image/png', 9 * MiB), [3840, 2160], { 'image/png': 3 * MiB });
  assert.equal(r.changed, true);
  assert.equal(r.file.type, 'image/png');
  assert.equal(r.file.name, 'image.png');
  assert.equal(r.file.size, 3 * MiB);
  assert.deepEqual([r.width, r.height], [2576, 1449]);
  assert.equal(r.note, 'resized 3840×2160 → 2576×1449');
  assert.deepEqual(log.filter((x) => x[0] === 'blob').map((x) => x.slice(1)), [[2576, 1449, 'image/png']]);
});

test('PNG that does not fit goes to WebP 0.9, 0.8, 0.7, then JPEG', async () => {
  let { r, log } = await run(pic('image/png', 9 * MiB), [3000, 2000], {
    'image/png': 8 * MiB,
    'image/webp@0.9': 6 * MiB,
    'image/webp@0.8': 4 * MiB,
  });
  assert.equal(r.file.type, 'image/webp');
  assert.equal(r.file.name, 'image.webp');
  assert.deepEqual(log.filter((x) => x[0] === 'blob').map((x) => x[3]), ['image/png', 'image/webp@0.9', 'image/webp@0.8']);
  // the browser cannot write WebP (it answers with a PNG): JPEG, on a white background
  ({ r, log } = await run(pic('image/png', 9 * MiB), [3000, 2000], {
    'image/png': 8 * MiB,
    'image/jpeg@0.9': 6 * MiB,
    'image/jpeg@0.8': 5 * MiB + 1,
    'image/jpeg@0.7': 2 * MiB,
  }));
  assert.equal(r.file.type, 'image/jpeg');
  assert.equal(r.file.name, 'image.jpg');
  assert.equal(r.file.size, 2 * MiB);
  assert.ok(log.some((x) => x[0] === 'draw' && x[3] === true), 'JPEG is drawn on white');
  assert.equal(r.note, 'resized 3000×2000 → 2576×1717');
});

test('only over the cap (edge is fine): compressed, with that note', async () => {
  const { r } = await run(pic('image/jpeg', 7 * MiB, 'photo.jpg'), [2000, 1500], { 'image/jpeg@0.9': 3 * MiB });
  assert.equal(r.changed, true);
  assert.deepEqual([r.width, r.height], [2000, 1500]);
  assert.equal(r.note, 'compressed 7 MiB → 3 MiB');
  assert.equal(r.file.name, 'photo.jpg');
});

test('room left in the 15 MiB is the target', async () => {
  const { r } = await run(pic('image/jpeg', 4 * MiB, 'a.jpg'), [800, 600], { 'image/jpeg@0.9': 3.5 * MiB, 'image/jpeg@0.8': 2 * MiB }, { others: 12 * MiB });
  assert.equal(r.file.size, 2 * MiB);
});

test('still too big after every step: refused with a message; a GIF over the cap is refused, not touched', async () => {
  let { r } = await run(pic('image/png', 40 * MiB), [8000, 6000], {
    'image/png': 30 * MiB,
    'image/webp@0.9': 20 * MiB,
    'image/webp@0.8': 20 * MiB,
    'image/webp@0.7': 20 * MiB,
    'image/jpeg@0.9': 9 * MiB,
    'image/jpeg@0.8': 8 * MiB,
    'image/jpeg@0.7': 7 * MiB,
  });
  assert.match(r.error, /larger than 5 MiB even after shrinking it \(2576×1932\)/);
  ({ r } = await run(pic('image/gif', 8 * MiB, 'a.gif'), [100, 100], {}));
  assert.match(r.error, /GIF is larger than 5 MiB/);
  ({ r } = await run(pic('image/gif', 2 * MiB, 'a.gif'), [4000, 3000], {}));
  assert.equal(r.changed, false, 'a small-bytes GIF is kept');
});

test('an unreadable picture: kept while it fits, refused when it does not; an own bitmap is closed', async () => {
  const bad = {
    createBitmap: async () => {
      throw Error('no');
    },
  };
  let r = await F.shrink(pic('image/png', 1000), bad);
  assert.equal(r.changed, false);
  r = await F.shrink(pic('image/png', 6 * MiB), bad);
  assert.match(r.error, /cannot shrink/);
  const b = bitmap(100, 100);
  r = await F.shrink(pic('image/png', 1000), { createBitmap: async () => b });
  assert.equal(b.closed, true);
});

test('names: the extension follows the type', () => {
  assert.equal(F.renamed('Screenshot 1.png', 'image/jpeg'), 'Screenshot 1.jpg');
  assert.equal(F.renamed('a.b.png', 'image/webp'), 'a.b.webp');
  assert.equal(F.renamed('noext', 'image/png'), 'noext.png');
});

test('the PC page and the phone load the same helper', () => {
  assert.match(fs.readFileSync(path.join(APP, 'chat.html'), 'utf8'), /<script src="\/image-fit\.js" defer>/);
  assert.match(fs.readFileSync(path.join(APP, 'phone.html'), 'utf8'), /<script src="\/image-fit\.js" defer>/);
  assert.match(fs.readFileSync(path.join(APP, 'chat.js'), 'utf8'), /window\.ImageFit\.shrink\(/);
  assert.match(fs.readFileSync(path.join(APP, 'phone.js'), 'utf8'), /Fit\.shrink\(/);
  const phone = require(path.join(APP, 'phone.js'));
  assert.equal(phone.fitInside, F.fitInside);
  assert.equal(phone.ATTACH.longEdge, F.LIMITS.longEdge);
});
