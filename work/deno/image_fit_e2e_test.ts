/**
 * A big picture pasted into the PC composer is shrunk, not refused (owner, 2026-11-24: pasting a screenshot gave a page-wide red
 * "image.png: larger than 5 MiB"). A real AIB with the scripted agent and a headless Chrome/Edge on chat.html (no window), as in
 * composer_focus_e2e_test.ts. The decisions are in work/test_image_fit.js; this checks the real browser.
 *
 *   F1  a PNG over 5 MiB (generated here, 3000 x 1700) pasted into the box: its chip says "resized 3000×1700 → 2576×1460"
 *       (always visible), no error shows anywhere, and the image the page SENDS is under 5 MiB and 2576 x 1460.
 *   F2  a small PNG is attached as it is: no note, the same bytes go out.
 *   F3  what cannot be shrunk (a 6 MiB GIF) is refused in the composer under the chips, not in the page-wide #error banner.
 */
import { assert, assertEquals } from './_assert.ts';
import { browserPath, clickHere, Lab, type Page, settle } from './_scroll_lab.ts';

const MiB = 1048576;

function e2e(name: string, fn: (lab: Lab) => Promise<void>) {
  Deno.test({
    name,
    ignore: !browserPath,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const lab = await Lab.open(1600, 900);
      try {
        await fn(lab);
        assert(lab.page.errors.length === 0, `console errors: ${lab.page.errors.join(' | ')}`);
      } finally {
        await lab.close();
      }
    },
  });
}

/** Paste a picture into the message box: a real paste event carrying a File. `make` is page code that returns a Blob. */
async function paste(page: Page, name: string, type: string, make: string) {
  await page.eval(`(async () => {
    const blob = await (${make})();
    const file = new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
    const data = new DataTransfer();
    data.items.add(file);
    const box = document.getElementById('prompt');
    box.focus();
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    window.__pastedBytes = file.size;
    return file.size;
  })()`);
}

/** A PNG with smooth colour plus a little noise: well over 5 MiB at this size, and it shrinks to something that fits. */
const BIG_PNG = `async () => {
  const c = document.createElement('canvas'); c.width = 3000; c.height = 1700;
  const g = c.getContext('2d'); const img = g.createImageData(3000, 1700); let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < 1700; y++) for (let x = 0; x < 3000; x++) {
    const i = (y * 3000 + x) * 4;
    img.data[i] = (x / 3000) * 200 + rnd() * 24; img.data[i + 1] = (y / 1700) * 200 + rnd() * 24; img.data[i + 2] = 90 + rnd() * 24; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return await new Promise((r) => c.toBlob(r, 'image/png'));
}`;
const SMALL_PNG = `async () => {
  const c = document.createElement('canvas'); c.width = 60; c.height = 40;
  const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 60, 40);
  return await new Promise((r) => c.toBlob(r, 'image/png'));
}`;
const GIF_6MIB = `async () => new Blob([new TextEncoder().encode('GIF89a'), new Uint8Array(6 * 1048576)], { type: 'image/gif' })`;

/** Record what the page POSTs with attachments, then reduce each image to its type, bytes and decoded size. */
const SPY = `(() => {
  window.__sent = [];
  const real = window.fetch.bind(window);
  window.fetch = (url, options) => {
    try { if (options && typeof options.body === 'string' && options.body.includes('"attachments"')) window.__sent.push(JSON.parse(options.body)); } catch {}
    return real(url, options);
  };
})()`;
const SENT = `(async () => {
  const out = [];
  for (const body of window.__sent) for (const a of body.attachments) {
    const bytes = Uint8Array.from(atob(a.data), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: a.mimeType }));
    out.push({ type: a.mimeType, bytes: bytes.length, width: bitmap.width, height: bitmap.height });
  }
  return out;
})()`;

async function openChat(lab: Lab) {
  const page = lab.page;
  const chat = await lab.chat();
  await lab.select(chat);
  await settle(800);
  await page.eval(SPY);
  return { page, chat };
}

e2e('F1 a big pasted PNG is shrunk: the chip says so and the sent image fits', async (lab) => {
  const { page, chat } = await openChat(lab);
  await paste(page, 'image.png', 'image/png', BIG_PNG);
  const pasted = await page.eval<number>('window.__pastedBytes');
  assert(pasted > 5 * MiB, `the test picture is over 5 MiB (${pasted})`);
  await page.waitFor(`!!document.querySelector('#attachmentList .attachment-resized')`, 30000, 'the resized note on the chip');
  const note = await page.eval<string>(`document.querySelector('#attachmentList .attachment-resized').textContent`);
  assertEquals(note, 'resized 3000×1700 → 2576×1460');
  assert(await page.eval<boolean>(`document.querySelector('#attachmentList .attachment-resized').getBoundingClientRect().height > 0`), 'the note is visible');
  assert(await page.eval<boolean>(`document.getElementById('error').hidden && document.getElementById('attachError').hidden`), 'no error anywhere');
  await clickHere(page, '#prompt');
  await page.type(chat.nextPrompt());
  await page.key('Enter');
  await page.waitFor('window.__sent.length > 0', 15000, 'the prompt with the picture');
  const sent = await page.eval<{ type: string; bytes: number; width: number; height: number }[]>(SENT);
  assertEquals(sent.length, 1);
  assert(sent[0].bytes <= 5 * MiB, `sent under 5 MiB (${sent[0].bytes})`);
  assert(['image/png', 'image/webp', 'image/jpeg'].includes(sent[0].type), sent[0].type);
  assertEquals([sent[0].width, sent[0].height], [2576, 1460]);
});

e2e('F2 a small picture is unchanged', async (lab) => {
  const { page, chat } = await openChat(lab);
  await paste(page, 'small.png', 'image/png', SMALL_PNG);
  const size = await page.eval<number>('window.__pastedBytes');
  await page.waitFor(`document.querySelectorAll('#attachmentList .attachment-card').length === 1`, 10000, 'the chip');
  assertEquals(await page.eval(`document.querySelectorAll('#attachmentList .attachment-resized').length`), 0);
  assert(await page.eval<boolean>(`document.getElementById('error').hidden && document.getElementById('attachError').hidden`));
  await clickHere(page, '#prompt');
  await page.type(chat.nextPrompt());
  await page.key('Enter');
  await page.waitFor('window.__sent.length > 0', 15000, 'the prompt with the picture');
  const sent = await page.eval<{ type: string; bytes: number; width: number; height: number }[]>(SENT);
  assertEquals(sent, [{ type: 'image/png', bytes: size, width: 60, height: 40 }]);
});

e2e('F3 what cannot be shrunk is refused in the composer, not in the page-wide banner', async (lab) => {
  const { page } = await openChat(lab);
  await paste(page, 'anim.gif', 'image/gif', GIF_6MIB);
  await page.waitFor(`!document.getElementById('attachError').hidden`, 15000, 'the composer error');
  const text = await page.eval<string>(`document.getElementById('attachError').textContent`);
  assert(text.startsWith('anim.gif: '), text);
  assert(await page.eval<boolean>(`document.getElementById('error').hidden`), 'the page-wide banner stays hidden');
  assertEquals(await page.eval(`document.querySelectorAll('#attachmentList .attachment-card').length`), 0);
  assert(await page.eval<boolean>(`document.getElementById('attachError').getBoundingClientRect().height > 0`), 'the error is visible in the composer');
});
