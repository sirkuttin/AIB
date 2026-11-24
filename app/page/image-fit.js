'use strict';
/* Fitting a picture before it is attached (the PC composer, chat.js, and the phone, phone.js: one rule for both).
   Claude's API refuses an image over 5 MiB and scales anything over about 1568 px on its long edge itself, so a big screenshot is
   shrunk here instead of refused: when a picture is over the 5 MiB cap, over what is left of the 15 MiB total, or longer than
   LONG_EDGE (2576 px) on its long edge, the browser re-encodes it (createImageBitmap + canvas; OffscreenCanvas when it has one).
   - the long edge shrinks to at most LONG_EDGE (never bigger than it is);
   - a PNG stays PNG while that fits; then WebP, then JPEG at quality 0.9, 0.8, 0.7 (a JPEG stays JPEG, a WebP stays WebP);
   - a picture that is already small enough is kept as it is; a GIF is never touched (scaling stops it moving): over the cap it is refused;
   - what is left over the cap after all that is refused with a clear message.
   Pure decisions (plan, candidates, note) are separate from the browser part (shrink) so they can be tested with a fake canvas. */
(function (root) {
  const MiB = 1048576;
  const LIMITS = { imageBytes: 5 * MiB, imageTotal: 15 * MiB, inputBytes: 50 * MiB, longEdge: 2576, qualities: [0.9, 0.8, 0.7] };
  const KNOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const EXT = { 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg' };

  /* The size of a picture that fits inside `max` on its long edge (never larger than it is). */
  function fitInside(width, height, max) {
    const w = Math.max(1, Math.round(width) || 1);
    const h = Math.max(1, Math.round(height) || 1);
    const s = Math.min(1, max / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scaled: s < 1 };
  }
  const mb = (n) => (n / MiB).toFixed(1).replace(/\.0$/, '') + ' MiB';

  /* What to do with a picture: {action: 'keep'} | {action: 'shrink', width, height, budget} | {action: 'refuse', reason}.
     info: {type, size, width, height, others} (others: bytes of the pictures already attached). */
  function plan(info, limits = LIMITS) {
    const type = String(info.type || '').toLowerCase();
    if (info.size > limits.inputBytes) return { action: 'refuse', reason: 'larger than ' + mb(limits.inputBytes) + ' (too big to shrink)' };
    const left = limits.imageTotal - (Number(info.others) || 0);
    const budget = Math.min(limits.imageBytes, left);
    if (budget < 1) return { action: 'refuse', reason: 'total image size would exceed ' + mb(limits.imageTotal) };
    const fit = fitInside(info.width, info.height, limits.longEdge);
    if (type === 'image/gif') {
      if (info.size <= budget) return { action: 'keep' };
      return {
        action: 'refuse',
        reason: info.size > limits.imageBytes
          ? 'GIF is larger than ' + mb(limits.imageBytes) + ' (animations are not resized)'
          : 'total image size would exceed ' + mb(limits.imageTotal),
      };
    }
    if (!fit.scaled && info.size <= budget && KNOWN.has(type)) return { action: 'keep' }; // another type (HEIC) is always written again as JPEG
    return { action: 'shrink', width: fit.width, height: fit.height, budget };
  }
  /* The types to try, best first: [type, quality|undefined]. */
  function candidates(type, limits = LIMITS) {
    const t = String(type || '').toLowerCase();
    const out = [];
    if (t === 'image/png') out.push(['image/png', undefined]);
    const lossy = t === 'image/jpeg' ? ['image/jpeg'] : t === 'image/webp' ? ['image/webp', 'image/jpeg'] : t === 'image/png' ? ['image/webp', 'image/jpeg'] : ['image/jpeg'];
    for (const l of lossy) for (const q of limits.qualities) out.push([l, q]);
    return out;
  }
  /* The note shown on the chip: what changed. */
  function noteOf(from, to, bytesFrom, bytesTo) {
    if (from.width !== to.width || from.height !== to.height)
      return 'resized ' + from.width + '×' + from.height + ' → ' + to.width + '×' + to.height;
    return 'compressed ' + mb(bytesFrom) + ' → ' + mb(bytesTo);
  }
  function renamed(name, type) {
    const ext = EXT[type];
    const n = String(name || 'image');
    return ext ? n.replace(/\.[^.\\/]{1,8}$/, '') + ext : n;
  }

  /* The default canvas: OffscreenCanvas when the browser has one, else a page canvas. -> {draw(bitmap, w, h, opaque), blob(type, q)} */
  function makeCanvas(width, height) {
    const off = typeof root.OffscreenCanvas === 'function';
    let canvas;
    if (off) canvas = new root.OffscreenCanvas(width, height);
    else {
      canvas = root.document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    }
    const g = canvas.getContext('2d');
    return {
      draw(bitmap, w, h, opaque) {
        g.clearRect(0, 0, w, h);
        if (opaque) {
          g.fillStyle = '#fff'; // a see-through picture sent as JPEG gets white, not black
          g.fillRect(0, 0, w, h);
        }
        g.drawImage(bitmap, 0, 0, w, h);
      },
      blob: (type, q) =>
        off
          ? canvas.convertToBlob({ type, quality: q })
          : new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, q)),
    };
  }

  /* Fit `file` (a File or Blob with a picture type). Options: others (bytes already attached), limits, bitmap (an already decoded
     bitmap: it stays open for the caller), createBitmap(file), canvas(w, h) (a fake, in tests), name.
     -> {file, note: '', changed: false} (kept) | {file: the smaller File, note, changed: true, width, height, from: {width, height}} |
        {error: 'why it is refused'} (without the picture's name: the caller puts it in front). */
  async function shrink(file, opts = {}) {
    const limits = opts.limits || LIMITS;
    const type = String(file.type || '').toLowerCase();
    const others = opts.others || 0;
    const name = opts.name || file.name || 'image';
    let bitmap = opts.bitmap || null;
    const own = !bitmap;
    if (!bitmap) {
      try {
        bitmap = await (opts.createBitmap || ((f) => root.createImageBitmap(f)))(file);
      } catch {
        bitmap = null;
      }
    }
    if (!bitmap) {
      // not readable here: it goes as it is while it fits (the server checks the bytes), else it is refused
      const budget = Math.min(limits.imageBytes, limits.imageTotal - others);
      return file.size <= budget && budget > 0
        ? { file, note: '', changed: false }
        : { error: 'larger than ' + mb(limits.imageBytes) + ' and this browser cannot shrink it' };
    }
    try {
      const from = { width: bitmap.width, height: bitmap.height };
      const p = plan({ type, size: file.size, width: from.width, height: from.height, others }, limits);
      if (p.action === 'keep') return { file, note: '', changed: false };
      if (p.action === 'refuse') return { error: p.reason };
      const canvas = (opts.canvas || makeCanvas)(p.width, p.height);
      let painted = '';
      for (const [t, q] of candidates(type, limits)) {
        const key = t === 'image/jpeg' ? 'opaque' : 'clear';
        if (painted !== key) {
          canvas.draw(bitmap, p.width, p.height, t === 'image/jpeg');
          painted = key;
        }
        let blob = null;
        try {
          blob = await canvas.blob(t, q);
        } catch {
          blob = null;
        }
        if (!blob || blob.type !== t) continue; // the browser cannot write this type (WebP in Safari): it gives a PNG instead
        if (blob.size <= p.budget) {
          const out = new File([blob], renamed(name, t), { type: t, lastModified: Date.now() });
          const to = { width: p.width, height: p.height };
          return { file: out, note: noteOf(from, to, file.size, blob.size), changed: true, width: p.width, height: p.height, from };
        }
      }
      return { error: 'larger than ' + mb(p.budget) + ' even after shrinking it (' + p.width + '×' + p.height + ')' };
    } finally {
      if (own && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  const api = { LIMITS, fitInside, plan, candidates, noteOf, renamed, shrink, makeCanvas };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageFit = api;
})(typeof window !== 'undefined' ? window : globalThis);
