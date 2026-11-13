/**
 * Attachments from the phone, end to end (owner: "we need to allow sending attachments from the phone app"): a real Studio (web
 * server and a separate agent host), phone access on with a fake Tailscale CLI, a phone paired through the HTTP routes, the fake
 * agents of work/fake_acp.py (Claude Code with steering, image input and embedded context; Codex without either), and the phone
 * page in a headless Chrome at 375 px (no window) where this test plays Tailscale Serve. Files are picked through the page's own
 * 📎 sheet: the browser's file chooser is intercepted (Page.setInterceptFileChooserDialog) and given files from the test folder.
 *  PA1 a photo (3000 x 2000, scaled to 2000 on its long edge, JPEG) and a text file reach the agent with the message as an image
 *      block and an embedded resource; a removed chip does not go; the sent message shows the picture and the file's name; while
 *      the agent works, Send steers the message with its file in.
 *  PA2 refused with a clear message: a fifth picture, a file over 10 MB, a PDF to an agent that takes text files only (its photo
 *      items are off, with the reason), and the server's own refusal of a wrong picture type shown above the box; nothing reaches
 *      the agent. With the Send switch off on the PC, 📎 and the box go away and the server refuses a message with attachments.
 * AIB_DOCPAGE_SHOTS=<folder> keeps screenshots (the box with chips and the 📎 sheet, light and dark).
 */
import { assert, assertEquals } from './_assert.ts';
import { DENO, httpJson, type Json, nativePath, SEP, until } from './_host_fixture.ts';
import { WORK } from './_parity.ts';
import { pickPort } from './_ports.ts';
import { Browser, browserPath, type Page } from './_doc_browser.ts';
import { nonce, phoneHeaders, raw, type RemoteStudio, serveStatus, tailscaleStatus } from './_remote_fixture.ts';
import { phonePage } from './_remote_phone_page.ts';
import { type LabOptions, type SteerChat, SteerLab, TEST_OPTIONS } from './_steer_lab.ts';
import { DEVICE_HEADER } from '../../outputs/agent-studio/server/remote/server.ts';

const LONG = 45;
const FAKE_TAILSCALE = nativePath(new URL('deno/_fake_tailscale.ts', WORK));

class PhoneAttachLab extends SteerLab {
  readonly phonePort = pickPort();
  readonly artifactPort = pickPort();
  readonly answers: string;
  constructor(options: LabOptions = {}) {
    super(options);
    this.answers = this.root + SEP + 'tailscale.json';
    Deno.writeTextFileSync(
      this.state + SEP + 'remote-port.json',
      JSON.stringify({ version: 1, port: this.phonePort, artifactPort: this.artifactPort }),
    );
    Deno.writeTextFileSync(this.state + SEP + 'phone-access.json', JSON.stringify({ version: 1, on: true, via: 'tailscale' }));
    Deno.writeTextFileSync(this.answers, JSON.stringify({ status: tailscaleStatus(), serve: serveStatus(this.phonePort, false) }));
  }
  override get env(): Record<string, string> {
    return {
      ...super.env,
      AIB_TAILSCALE_CLI: JSON.stringify([DENO, 'run', '-A', '--quiet', FAKE_TAILSCALE, this.answers]),
      AIB_TEST_REMOTE_BIND_MS: '1500',
    };
  }
}

/** A lab with the phone paired (all switches the PC gives by default), and its device. */
async function started(options: LabOptions) {
  const lab = new PhoneAttachLab(options);
  try {
    await lab.start();
    const web = lab.web;
    const port = lab.phonePort;
    await until(async () => (await raw(port, 'GET', '/api/remote/bootstrap', phoneHeaders())).status === 200, 'the phone port', 30);
    const [, code] = await httpJson('POST', web.port, '/api/live/devices/pair', web.token, {});
    const claim = await raw(
      port,
      'POST',
      '/api/remote/pair/claim',
      phoneHeaders({}, 'POST'),
      JSON.stringify({ code: (code.words as string[]).join(' '), name: 'Pixel 9', nonce: nonce() }),
    );
    assertEquals(claim.status, 200, claim.text);
    const [, view] = await httpJson('GET', web.port, '/api/live/devices', web.token);
    const pending = ((view.pairing as Json).pending as Json[])[0];
    await httpJson('POST', web.port, '/api/live/devices/approve', web.token, { claim: pending.id });
    const done = await raw(
      port,
      'POST',
      '/api/remote/pair/status',
      phoneHeaders({}, 'POST'),
      JSON.stringify({ claim: claim.json.claim, claimSecret: claim.json.claimSecret }),
    );
    const phone = { token: done.json.token as string, id: (done.json.device as Json).id as string };
    return { lab, phone };
  } catch (error) {
    await lab[Symbol.asyncDispose]();
    throw error;
  }
}

/** The phone page, with the browser's file chooser handed to the test: `choose` sets what the next chooser gets. */
async function openPhone(browser: Browser, lab: PhoneAttachLab, phone: { token: string; id: string }) {
  const page = await phonePage(browser, { phonePort: () => lab.phonePort } as unknown as RemoteStudio, phone, undefined, 375, false);
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  let next: string[] = [];
  let opened = 0;
  page.listeners.set('Page.fileChooserOpened', (p) => {
    opened++;
    void page.send('DOM.setFileInputFiles', { files: next, backendNodeId: p.backendNodeId }).catch(() => {});
  });
  return {
    page,
    opened: () => opened,
    /** 📎, then the sheet's item (a real tap: the chooser opens only from one), with these files. */
    async pick(which: 'camera' | 'photos' | 'files', files: string[], shot = '') {
      next = files;
      const before = opened;
      await page.click('#phAttach');
      await page.waitFor(`!!document.querySelector('#phMenu [data-mi="${which}"]')`, 5000, 'the attach sheet');
      if (shot) await page.shot(shot);
      await page.click(`#phMenu [data-mi="${which}"]`);
      await page.waitFor(`!document.getElementById('phMenu')`, 5000, 'the sheet closed');
      await until(() => opened > before, 'the file chooser', 10);
      await page.waitFor('!window.__aibPhone.attachBusy.chat', 15000, 'the picks read');
    },
  };
}

async function openChat(page: Page, id: string): Promise<void> {
  await page.eval(`location.hash = "#chat=${id}"`);
  await page.waitFor(
    `window.__aibPhone.chat && window.__aibPhone.chat.id === ${JSON.stringify(id)} && !!document.getElementById('phPrompt')`,
    15000,
    'the chat',
  );
}
const chips = (page: Page) =>
  page.eval<string[]>(`[...document.querySelectorAll('#phChips .ph-chip')].map((c) => c.querySelector('.ph-chip-name').textContent)`);
const note = (page: Page) => page.eval<string>(`document.getElementById('phAttachNote')?.textContent ?? ''`);
async function send(page: Page, text: string): Promise<void> {
  await page.click('#phPrompt');
  if (text) await page.type(text);
  await page.click('#phSend');
}

/** Width and height of a JPEG from its SOF marker. */
function jpegSize(bytes: Uint8Array): [number, number] {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return [0, 0];
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [(bytes[i + 7] << 8) | bytes[i + 8], (bytes[i + 5] << 8) | bytes[i + 6]];
    }
    i += 2 + len;
  }
  return [0, 0];
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Test files: a 3000 x 2000 camera-like JPEG (drawn by the browser), small PNGs, text files, a PDF and an 11 MB file. */
async function files(lab: PhoneAttachLab, page: Page): Promise<Record<string, string>> {
  const dir = lab.root + SEP + 'phone-files';
  Deno.mkdirSync(dir, { recursive: true });
  const at = (name: string) => dir + SEP + name;
  const photo = await page.eval<string>(`(() => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const g = c.getContext('2d'); const grad = g.createLinearGradient(0, 0, 3000, 2000);
    grad.addColorStop(0, '#1d6f6a'); grad.addColorStop(1, '#f2c14e'); g.fillStyle = grad; g.fillRect(0, 0, 3000, 2000);
    for (let i = 0; i < 4000; i++) { g.fillStyle = 'hsl(' + (i * 37 % 360) + ',60%,50%)'; g.fillRect((i * 7919) % 3000, (i * 104729) % 2000, 30, 30); }
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  })()`);
  Deno.writeFileSync(at('photo.jpg'), unb64(photo));
  const png = await page.eval<string>(`(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 30;
    const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 40, 30); return c.toDataURL('image/png').split(',')[1]; })()`);
  for (let n = 1; n <= 5; n++) Deno.writeFileSync(at(`shot-${n}.png`), unb64(png));
  Deno.writeTextFileSync(at('notes.txt'), 'Steps to reproduce:\n1. open checkout\n2. pay\n');
  Deno.writeTextFileSync(at('extra.txt'), 'this one is removed before sending\n');
  Deno.writeTextFileSync(at('log.txt'), 'TypeError at checkout.ts:42\n');
  const pdf = new Uint8Array(4000);
  pdf.set(new TextEncoder().encode('%PDF-1.4\n'));
  Deno.writeFileSync(at('spec.pdf'), pdf);
  Deno.writeFileSync(at('big.bin'), new Uint8Array(11 * 1048576));
  return Object.fromEntries(
    ['photo.jpg', 'notes.txt', 'extra.txt', 'log.txt', 'spec.pdf', 'big.bin', ...[1, 2, 3, 4, 5].map((n) => `shot-${n}.png`)]
      .map((n) => [n, at(n)]),
  );
}

const promptsOf = (chat: SteerChat) =>
  chat.received().filter((m) => m.method === 'session/prompt').map((m) => (m.params as Json).prompt as Json[]);

Deno.test({
  name:
    'PA1 phone attach: a photo (scaled) and a file reach the agent with the message; a removed chip does not go; Send steers a file in while working',
  ignore: !browserPath,
  ...TEST_OPTIONS,
  async fn() {
    const { lab, phone } = await started({ extra: { claude: ['--images', '--embedded-context'] } });
    await using _lab = lab;
    const browser = await Browser.launch();
    try {
      const chat = await lab.chat('claude');
      const { page, pick } = await openPhone(browser, lab, phone);
      const f = await files(lab, page);
      await openChat(page, chat.id);
      assertEquals(await page.eval('window.__aibPhone.chat.takes'), { pictures: true, binary: true });

      await pick('photos', [f['photo.jpg']], 'phone-attach-sheet-light');
      await pick('files', [f['notes.txt'], f['extra.txt']]);
      assertEquals(await chips(page), ['photo.jpg', 'notes.txt', 'extra.txt']);
      assert(
        await page.eval(`document.querySelector('#phChips .ph-chip.pic img.ph-chip-thumb').src.startsWith('data:image/jpeg')`),
        'the photo chip has a thumbnail',
      );
      const scaled = await page.eval<Json>(
        `(() => { const x = window.__aibPhone.attach.chat[0]; return { mime: x.mime, scaled: x.scaled, size: x.size }; })()`,
      );
      assertEquals([scaled.mime, scaled.scaled], ['image/jpeg', true]);
      assert(Number(scaled.size) < Deno.statSync(f['photo.jpg']).size, 'smaller than the original');
      await page.shot('phone-attach-chips-light');
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await page.waitFor(`document.documentElement.dataset.theme.endsWith('dark')`, 5000, 'dark');
      await page.shot('phone-attach-chips-dark');
      await page.click('#phAttach');
      await page.waitFor(`!!document.querySelector('#phMenu [data-mi="photos"]')`, 5000, 'the sheet');
      await page.shot('phone-attach-sheet-dark');
      await page.click('#phMenu [data-mi="cancel"]');
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

      // a chip removed: it is not sent
      await page.click('#phChips .ph-chip:nth-child(3) .ph-chip-x');
      await page.waitFor(`document.querySelectorAll('#phChips .ph-chip').length === 2`, 5000, 'the chip removed');
      assertEquals(await chips(page), ['photo.jpg', 'notes.txt']);

      // idle: Send is a prompt with the picture and the file
      await send(page, 'What is wrong here?');
      const blocks = await until(() => promptsOf(chat).find((b) => b.some((x) => x.type === 'image')), 'the prompt with the photo', LONG);
      const image = blocks.find((b) => b.type === 'image')!;
      assertEquals(image.mimeType, 'image/jpeg');
      assertEquals(jpegSize(unb64(String(image.data))), [2000, 1333], 'scaled to 2000 px on its long edge');
      const resource = blocks.find((b) => b.type === 'resource')!.resource as Json;
      assert(String(resource.uri).endsWith('/notes.txt'), String(resource.uri));
      assertEquals(resource.text, 'Steps to reproduce:\n1. open checkout\n2. pay\n');
      assert(blocks.some((b) => b.type === 'text' && b.text === 'What is wrong here?'));
      assert(
        !JSON.stringify(blocks).includes('extra.txt') && !JSON.stringify(blocks).includes('this one is removed'),
        'the removed chip did not go',
      );
      await page.waitFor(
        `!document.querySelector('#phChips .ph-chip') && document.getElementById('phPrompt').value === ''`,
        10000,
        'the box emptied',
      );
      // the sent message on the phone: the picture and the file's name
      await page.waitFor(
        `[...document.querySelectorAll('.ph-msg.you')].some((m) => m.querySelector('img.ph-img') && m.querySelector('.ph-sent-files')?.textContent === 'notes.txt')`,
        15000,
        'the sent message with its picture and file',
      );

      // working: Send steers the message and its file in now
      const gate = lab.gate();
      await chat.prompt(`steer-wait:${gate}`, 'busy');
      await page.waitFor(`window.__aibPhone.chat.busy && window.__aibPhone.chat.steerable`, 20000, 'working, steerable');
      await pick('files', [f['log.txt']]);
      await send(page, 'and this log');
      const steer = await until(() => lab.steersReceived(chat).find((s) => s.text === 'and this log'), 'the steered message', LONG);
      const steered = steer.blocks.find((b) => b.type === 'resource');
      assert(steered && String((steered.resource as Json).uri).endsWith('/log.txt'), JSON.stringify(steer.blocks).slice(0, 400));
      assertEquals((steered!.resource as Json).text, 'TypeError at checkout.ts:42\n');
      chat.open(gate);
      assertEquals(await page.violations(), [], 'no CSP violations (thumbnails are data: URLs)');
    } finally {
      await browser.close();
    }
  },
});

Deno.test({
  name:
    'PA2 phone attach refused with a clear message: over the limit, a type the agent cannot take, the server refusal shown; Send off refuses too',
  ignore: !browserPath,
  ...TEST_OPTIONS,
  async fn() {
    const { lab, phone } = await started({ extra: { claude: ['--images', '--embedded-context'] }, plain: ['codex'] });
    await using _lab = lab;
    const browser = await Browser.launch();
    try {
      const claude = await lab.chat('claude');
      const codex = await lab.chat('codex');
      const { page, pick } = await openPhone(browser, lab, phone);
      const f = await files(lab, page);
      await openChat(page, claude.id);

      // a fifth picture: four are added, the fifth is refused
      await pick('photos', [1, 2, 3, 4, 5].map((n) => f[`shot-${n}.png`]));
      assertEquals((await chips(page)).length, 4);
      assertEquals(await note(page), 'Up to 4 pictures per message.');
      // a file over 10 MB
      await pick('files', [f['big.bin']]);
      assertEquals(await note(page), 'big.bin: files can be at most 10 MB.');
      assertEquals((await chips(page)).length, 4);
      for (let i = 0; i < 4; i++) await page.click('#phChips .ph-chip .ph-chip-x');
      await page.waitFor(`!document.querySelector('#phChips .ph-chip')`, 5000, 'all removed');

      // the server's own check: a picture type the PC does not take is refused, its words above the box, nothing sent
      const before = promptsOf(claude).length;
      await page.eval(`(() => { const S = window.__aibPhone;
        S.attach.chat = [{ id: 'x', kind: 'image', name: 'scan.bmp', mime: 'image/bmp', size: 4, data: 'Qk0AAA==', thumb: '' }]; })()`);
      await send(page, 'see');
      await page.waitFor(
        `document.getElementById('phActError').textContent === 'Pictures must be PNG, JPEG, GIF or WebP.'`,
        10000,
        'the refusal',
      );
      assertEquals(await chips(page), ['scan.bmp'], 'kept in the box');
      assertEquals(promptsOf(claude).length, before, 'nothing reached the agent');

      // Codex takes text files only: photo items off with the reason, a PDF refused
      await openChat(page, codex.id);
      assertEquals(await page.eval('window.__aibPhone.chat.takes'), { pictures: false, binary: false });
      await page.click('#phAttach');
      await page.waitFor(`!!document.querySelector('#phMenu [data-mi="photos"]')`, 5000, 'the sheet');
      assertEquals(
        await page.eval(
          `['camera', 'photos'].map((k) => [document.querySelector('#phMenu [data-mi="' + k + '"]').disabled, document.querySelector('#phMenu [data-mi="' + k + '"] small').textContent])`,
        ),
        [[true, 'Codex can’t take pictures'], [true, 'Codex can’t take pictures']],
      );
      await page.click('#phMenu [data-mi="cancel"]');
      await pick('files', [f['spec.pdf']]);
      assertEquals(await note(page), 'Codex can take text files only, not spec.pdf.');
      assertEquals(await chips(page), []);

      // the Send switch off on the PC: 📎 and the box go away; the server refuses a message with attachments; nothing goes
      const web = lab.web;
      const [s1] = await httpJson('POST', web.port, '/api/live/devices/scopes', web.token, { id: phone.id, scopes: ['phone.read'] });
      assertEquals(s1, 200);
      await page.waitFor(`!document.getElementById('phAttach') && !document.getElementById('phPrompt')`, 15000, 'the box gone');
      const off = await raw(
        lab.phonePort,
        'POST',
        '/api/remote/prompt',
        phoneHeaders({ [DEVICE_HEADER]: phone.token }, 'POST'),
        JSON.stringify({
          id: claude.id,
          text: 'x',
          clientMessageId: 'off-1',
          attachments: [{ type: 'file', name: 'notes.txt', mimeType: 'text/plain', data: btoa('hi') }],
        }),
      );
      assertEquals([off.status, off.json.code], [403, 'scope']);
      await new Promise((r) => setTimeout(r, 800));
      assertEquals(promptsOf(claude).length, before, 'nothing reached the agent');
    } finally {
      await browser.close();
    }
  },
});
