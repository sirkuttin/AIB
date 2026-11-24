/**
 * Attachments from the phone (owner: "we need to allow sending attachments from the phone app"), server side, in an AIB in this
 * process with a fake agent host and forged Tailscale Serve headers:
 *  - phoneAttachments (remote/actions.ts): bytes only (never a path, a link or another field), the PC composer's limits (4 pictures
 *    of PNG, JPEG, GIF or WebP up to 5 MiB, 15 MiB of pictures; 8 files, text up to 2 MiB, others up to 10 MiB; 20 MiB in all) and
 *    what the chat's agent can take (pictures need image input; PDFs and other binary files need embedded context; text always);
 *  - prompt, steer and queue carry a picture and a file to the agent host exactly (text may be empty); one activity line each with
 *    how many, never names or bytes;
 *  - refused with a clear message, nothing sent, each refusal logged: too many, too big, wrong type, a path, a picture to an agent
 *    without image input, a PDF to one without embedded context, a body over 30 MB (413);
 *  - the Send switch off refuses a message with attachments before its body is read (logged "switched off"); back on, it goes;
 *  - New chat: the first message carries its attachments once the chat is ready; an agent that can't take pictures holds it with
 *    the reason; /new/first sends it again.
 * The page side (📎, chips, the photo scaled, the e2e path to a real agent) is in remote_attach_e2e_test.ts and test_phone_attach.js.
 */
import { assert, assertEquals } from './_assert.ts';
import { ATTACH_ROUTES, DEVICE_HEADER, MAX_ATTACH_BODY, MAX_BODY } from '../../app/server/remote/server.ts';
import { attachedWords, phoneAttachments, Refusal, type Takes } from '../../app/server/remote/actions.ts';
import { firstText, setAgentRows } from '../../app/server/remote/newchat.ts';
import { readRemotePort } from '../../app/server/remote/port.ts';
import {
  type FakeChat,
  fakeTailscale,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteAib,
  remoteAib,
  serveStatus,
} from './_remote_fixture.ts';
import { phoneCall, v2Aib } from './_remote_v2b.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const MiB = 1048576;

const b64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A picture of `size` bytes with the type's signature (the server checks the signature, not the pixels). */
function picture(size: number, mime = 'image/png'): Json {
  const bytes = new Uint8Array(size);
  bytes.set(mime === 'image/jpeg' ? [0xff, 0xd8, 0xff] : PNG_HEAD);
  return { type: 'image', mimeType: mime, data: b64(bytes) };
}
const PNG = picture(64);
const text = (name: string, body: string, mime = 'text/plain'): Json => ({
  type: 'file',
  name,
  mimeType: mime,
  data: b64(new TextEncoder().encode(body)),
});
function binary(name: string, size: number, mime = 'application/pdf'): Json {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.4\n'));
  bytes[20] = 0; // not text
  return { type: 'file', name, mimeType: mime, data: b64(bytes) };
}
const NOTES = text('notes.txt', 'Steps to reproduce:\n1. open checkout\n');
const ALL: Takes = { pictures: true, binary: true, audio: false };

function refused(fn: () => unknown): [number, string, string] {
  try {
    fn();
  } catch (error) {
    if (error instanceof Refusal) return [error.status, error.code, error.message];
    throw error;
  }
  throw new Error('not refused');
}

Deno.test('phoneAttachments: bytes only, the PC composer limits and types, and what the agent can take', () => {
  // fine: exactly the fields the agent host takes, fresh objects
  const ok = phoneAttachments({ attachments: [PNG, NOTES, picture(100, 'image/jpeg')] }, ALL);
  assertEquals(ok.map((x) => Object.keys(x).sort().join(',')), ['data,mimeType,type', 'data,mimeType,name,type', 'data,mimeType,type']);
  assertEquals(phoneAttachments({}, ALL), []);
  assertEquals(phoneAttachments({ attachments: [] }, ALL), []);
  assertEquals(attachedWords(ok), 'with 2 pictures and 1 file');
  assertEquals(attachedWords([NOTES]), 'with 1 file');

  // bytes only: never a path, a link, a file reference or another field
  for (
    const body of [
      { attachments: [{ ...NOTES, path: 'C:\\Users\\me\\notes.txt' }] },
      { attachments: [{ type: 'file', name: 'notes.txt', uri: 'file:///C:/notes.txt' }] },
      { attachments: [{ type: 'image', mimeType: 'image/png', url: 'https://example.com/a.png' }] },
      { attachments: [{ type: 'file', name: 'notes.txt', mimeType: 'text/plain' }] },
      { attachments: [{}] },
      { path: 'C:\\secret.txt' },
      { files: [NOTES] },
      { images: [PNG] },
    ]
  ) assertEquals(refused(() => phoneAttachments(body, ALL)).slice(0, 2), [400, 'bytes_only'], JSON.stringify(body).slice(0, 80));
  assertEquals(refused(() => phoneAttachments({ attachments: [{ ...NOTES, name: '..\\..\\x.txt' }] }, ALL))[1], 'bad_file');

  // counts: 4 pictures, 8 files
  assertEquals(refused(() => phoneAttachments({ attachments: Array(5).fill(PNG) }, ALL)).slice(0, 2), [413, 'too_many']);
  assertEquals(refused(() => phoneAttachments({ attachments: Array(9).fill(NOTES) }, ALL)).slice(0, 2), [413, 'too_many']);
  assertEquals(phoneAttachments({ attachments: [...Array(4).fill(PNG), ...Array(8).fill(NOTES)] }, ALL).length, 12);
  assert(refused(() => phoneAttachments({ attachments: Array(5).fill(PNG) }, ALL))[2].includes('up to 4 pictures and 8 files'));

  // sizes: a picture 5 MiB, pictures 15 MiB, text 2 MiB, other files 10 MiB, 20 MiB in all
  assertEquals(refused(() => phoneAttachments({ attachments: [picture(5 * MiB + 1)] }, ALL)).slice(0, 2), [413, 'too_big']);
  assertEquals(phoneAttachments({ attachments: [picture(5 * MiB)] }, ALL).length, 1);
  const pics = refused(() => phoneAttachments({ attachments: Array(4).fill(picture(4 * MiB)) }, ALL));
  assertEquals(pics.slice(0, 2), [413, 'too_big']);
  assert(pics[2].includes('15 MiB'), pics[2]);
  assertEquals(refused(() => phoneAttachments({ attachments: [text('big.txt', 'x'.repeat(2 * MiB + 1))] }, ALL)).slice(0, 2), [
    413,
    'too_big',
  ]);
  assertEquals(refused(() => phoneAttachments({ attachments: [binary('big.pdf', 10 * MiB + 1)] }, ALL)).slice(0, 2), [413, 'too_big']);
  const total = refused(() =>
    phoneAttachments({ attachments: [binary('a.pdf', 9 * MiB), binary('b.pdf', 9 * MiB), binary('c.pdf', 3 * MiB)] }, ALL)
  );
  assertEquals(total.slice(0, 2), [413, 'too_big']);
  assert(total[2].includes('20 MiB'), total[2]);
  const mixed = refused(() =>
    phoneAttachments({ attachments: [picture(4 * MiB), picture(4 * MiB), binary('a.pdf', 9 * MiB), binary('b.pdf', 4 * MiB)] }, ALL)
  );
  assertEquals(mixed.slice(0, 2), [413, 'too_big'], 'pictures and files count together');

  // types: pictures are PNG, JPEG, GIF or WebP whose bytes match; a picture is not sent as a file; an empty file is refused
  const bmp = refused(() => phoneAttachments({ attachments: [{ type: 'image', mimeType: 'image/bmp', data: 'Qk0=' }] }, ALL));
  assertEquals(bmp, [415, 'wrong_type', 'Pictures must be PNG, JPEG, GIF or WebP.']);
  assertEquals(refused(() => phoneAttachments({ attachments: [{ ...PNG, mimeType: 'image/jpeg' }] }, ALL)).slice(0, 2), [
    415,
    'wrong_type',
  ]);
  assertEquals(refused(() => phoneAttachments({ attachments: [{ ...PNG, type: 'file', name: 'a.png' }] }, ALL)).slice(0, 2), [
    415,
    'wrong_type',
  ]);
  assertEquals(refused(() => phoneAttachments({ attachments: [{ ...PNG, data: '***' }] }, ALL))[1], 'bad_file');

  // what the agent can take: no image input -> no pictures; no embedded context -> text files only (as the PC composer)
  const textOnly: Takes = { pictures: false, binary: false, audio: false };
  const pic = refused(() => phoneAttachments({ attachments: [PNG] }, textOnly, 'Codex'));
  assertEquals(pic, [403, 'no_pictures', "Codex can't take pictures. Remove the picture and send again."]);
  const pdf = refused(() => phoneAttachments({ attachments: [NOTES, binary('spec.pdf', 100)] }, textOnly, 'Codex'));
  assertEquals(pdf, [403, 'text_files_only', 'Codex can take text files only, not spec.pdf. Remove it and send again.']);
  assertEquals(phoneAttachments({ attachments: [NOTES] }, textOnly).length, 1, 'text files always go');
  assertEquals(phoneAttachments({ attachments: [PNG, binary('spec.pdf', 100)] }, null).length, 2, 'not known yet: New chat checks later');

  // New chat's first message: the same checks; text may be empty with attachments
  assertEquals(firstText({ text: '', clientMessageId: 'm', attachments: [PNG] }).attachments.length, 1);
  assertEquals(refused(() => firstText({ text: '', clientMessageId: 'm' }))[1], 'empty');
  assertEquals(refused(() => firstText({ text: 'x', clientMessageId: 'm', attachments: [{ ...NOTES, path: 'x' }] }))[1], 'bytes_only');
  assert(ATTACH_ROUTES.has('/api/remote/steer') && !ATTACH_ROUTES.has('/api/remote/queue-edit'));
  assertEquals(MAX_ATTACH_BODY, 30 * MiB);
});

async function phoneOn(): Promise<RemoteAib> {
  const fake = fakeTailscale();
  const s = await remoteAib({ runner: fake.runner });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
  return s;
}

function chat(id: string, caps: Json, over: Partial<FakeChat> = {}): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd: 'C:\\code\\shop',
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [{ seq: 1, kind: 'user', data: { text: 'first prompt' } }],
    permissions: [],
    elicitations: [],
    ...({ promptCapabilities: caps } as Json),
    ...over,
  };
}

const post = (s: RemoteAib, token: string, path: string, body: Json | string) =>
  raw(
    s.phonePort(),
    'POST',
    path,
    phoneHeaders({ [DEVICE_HEADER]: token }, 'POST'),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
const auditLines = (s: RemoteAib) =>
  (s.ctx.phone.audit.tail(500) as unknown as Json[]).slice().reverse().filter((l) => ['send', 'queue'].includes(String(l.action))).map((
    l,
  ) => [l.action, l.chat, l.result]);

Deno.test({
  ...OPTS,
  name:
    'prompt, steer and queue carry a picture and a file to the agent host exactly; the chat says what its agent takes; one log line each',
  async fn() {
    const s = await phoneOn();
    try {
      s.chats.push(
        chat('c1', { image: true, embeddedContext: true }),
        chat('t1', { image: false, embeddedContext: false }, { provider: 'codex' }),
      );
      const phone = await pairPhone(s);
      // the chat payload says what the agent can take (the phone's 📎 follows it)
      const c1 = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=c1', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(c1.json.takes, { pictures: true, binary: true });
      const t1 = await raw(s.phonePort(), 'GET', '/api/remote/chat?id=t1', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(t1.json.takes, { pictures: false, binary: false });

      s.answerLive((_name, body) => [200, { ok: true, accepted: true, clientMessageId: body.clientMessageId }]);
      const spec = binary('spec.pdf', 2000);
      const r1 = await post(s, phone.token, '/api/remote/prompt', {
        id: 'c1',
        text: 'Look at this',
        clientMessageId: 'a1',
        attachments: [PNG, NOTES],
      });
      assertEquals(r1.status, 200, r1.text);
      const r2 = await post(s, phone.token, '/api/remote/steer', { id: 'c1', text: '', clientMessageId: 'a2', attachments: [spec] });
      assertEquals(r2.status, 200, r2.text);
      const r3 = await post(s, phone.token, '/api/remote/queue', { id: 'c1', text: 'later', clientMessageId: 'a3', attachments: [PNG] });
      assertEquals(r3.status, 200, r3.text);
      // a text file to an agent that takes text only goes too
      const r4 = await post(s, phone.token, '/api/remote/prompt', { id: 't1', text: 'read', clientMessageId: 'a4', attachments: [NOTES] });
      assertEquals(r4.status, 200, r4.text);
      assertEquals(s.liveCalls, [
        ['prompt', { id: 'c1', text: 'Look at this', clientMessageId: 'a1', attachments: [PNG, NOTES] }],
        ['steer', { id: 'c1', text: '', clientMessageId: 'a2', attachments: [spec] }],
        ['queue', { id: 'c1', text: 'later', clientMessageId: 'a3', attachments: [PNG] }],
        ['prompt', { id: 't1', text: 'read', clientMessageId: 'a4', attachments: [NOTES] }],
      ]);
      assertEquals(auditLines(s), [
        ['send', 'c1', 'done, with 1 picture and 1 file'],
        ['send', 'c1', 'done, with 1 file'],
        ['queue', 'c1', 'done, with 1 picture'],
        ['send', 't1', 'done, with 1 file'],
      ]);
      const file = Deno.readTextFileSync(s.state + (Deno.build.os === 'windows' ? '\\' : '/') + 'remote-audit.jsonl');
      for (const secret of ['notes.txt', 'spec.pdf', 'Look at this', String(PNG.data).slice(0, 12)]) assert(!file.includes(secret), secret);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'refused with a clear message, nothing sent, each refusal logged: too many, too big, wrong type, a path, what the agent cannot take, a body over 30 MB',
  async fn() {
    const s = await phoneOn();
    try {
      s.chats.push(
        chat('c1', { image: true, embeddedContext: true }),
        chat('t1', { image: false, embeddedContext: false }, { provider: 'codex' }),
      );
      const phone = await pairPhone(s);
      const send = (id: string, attachments: unknown, path = '/api/remote/prompt') =>
        post(s, phone.token, path, { id, text: 'x', clientMessageId: 'r', attachments });
      const cases: [string, unknown, number, string, RegExp][] = [
        ['c1', Array(5).fill(PNG), 413, 'too_many', /up to 4 pictures and 8 files/],
        ['c1', [picture(5 * MiB + 10)], 413, 'too_big', /5 MiB/],
        ['c1', [{ type: 'image', mimeType: 'image/heic', data: 'AAAA' }], 415, 'wrong_type', /PNG, JPEG, GIF or WebP/],
        ['c1', [{ type: 'file', name: 'notes.txt', path: 'C:\\notes.txt' }], 400, 'bytes_only', /file itself/],
        ['t1', [PNG], 403, 'no_pictures', /Codex can't take pictures/],
        ['t1', [binary('spec.pdf', 100)], 403, 'text_files_only', /Codex can take text files only, not spec\.pdf/],
      ];
      for (const [id, attachments, status, code, words] of cases) {
        for (const path of ['/api/remote/prompt', '/api/remote/steer', '/api/remote/queue']) {
          const r = await send(id, attachments, path);
          assertEquals([r.status, r.json.code], [status, code], `${code} ${path}`);
          assert(words.test(String(r.json.error)), String(r.json.error));
        }
      }
      // a body over 30 MB: refused without reading the rest
      const huge = JSON.stringify({
        id: 'c1',
        text: 'x',
        clientMessageId: 'h',
        attachments: [{ type: 'file', name: 'a.bin', data: 'A'.repeat(31 * MiB) }],
      });
      const big = await post(s, phone.token, '/api/remote/prompt', huge);
      assertEquals([big.status, big.json.code], [413, 'too_big']);
      assert(String(big.json.error).includes('20 MiB'), String(big.json.error));
      assertEquals(s.liveCalls.length, 0, 'nothing reached the agent');
      const results = auditLines(s).map((l) => l[2]);
      assertEquals(results.filter((r) => r === 'refused: too_many').length, 3);
      for (const code of ['too_big', 'wrong_type', 'bytes_only', 'no_pictures', 'text_files_only']) {
        assert(results.includes(`refused: ${code}`), code);
      }
      assertEquals(results.length, cases.length * 3 + 1);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'the Send switch off refuses a message with attachments before its body is read (logged); back on, it goes',
  async fn() {
    const s = await phoneOn();
    try {
      s.chats.push(chat('c1', { image: true, embeddedContext: true }));
      const phone = await pairPhone(s);
      const set = async (scopes: string[]) =>
        assertEquals((await pc(s, 'POST', '/api/live/devices/scopes', { id: phone.id, scopes }))[0], 200);
      await set(['phone.read']);
      const body = { id: 'c1', text: 'see', clientMessageId: 'o1', attachments: [picture(200 * 1024), NOTES] };
      assert(JSON.stringify(body).length > MAX_BODY, 'bigger than a text message');
      for (const path of ['/api/remote/prompt', '/api/remote/steer', '/api/remote/queue']) {
        const r = await post(s, phone.token, path, body);
        assertEquals([r.status, r.json.code], [403, 'scope'], path);
        assert(String(r.json.error).includes('may not send messages'), String(r.json.error));
      }
      // New chat with attachments needs Start new chats (a child of Send): refused too
      const n = await post(s, phone.token, '/api/remote/new', {
        project: 'x',
        agent: 'claude',
        text: 'hi',
        clientMessageId: 'n1',
        attachments: [PNG],
      });
      assertEquals(n.status, 403);
      assertEquals(s.liveCalls.length, 0);
      const lines = auditLines(s);
      assertEquals(lines.map((l) => l[2]), ['refused: switched off', 'refused: switched off', 'refused: switched off']);
      await set(['phone.read', 'phone.prompt']);
      s.answerLive(() => [200, { ok: true, accepted: true }]);
      const on = await post(s, phone.token, '/api/remote/prompt', body);
      assertEquals(on.status, 200, on.text);
      assertEquals(s.liveCalls.length, 1);
      assertEquals((s.liveCalls[0][1].attachments as Json[]).length, 2);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'New chat: the first message carries its attachments once ready; an agent that cannot take pictures holds it with the reason; /new/first sends it',
  async fn() {
    const s = await v2Aib();
    try {
      const phone = await pairPhone(s);
      const until = async (fn: () => Promise<boolean> | boolean, what: string) => {
        const end = Date.now() + 8000;
        while (Date.now() < end) {
          if (await fn()) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('timed out: ' + what);
      };
      s.pick.caps = { image: true, embeddedContext: true };
      let r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        text: '',
        clientMessageId: 'nf1',
        attachments: [PNG, NOTES],
      });
      assertEquals(r.status, 200, r.text);
      const id = r.json.id as string;
      await until(() => s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === id), 'the first message');
      assertEquals(s.liveCalls.find(([n, b]) => n === 'prompt' && b.id === id)![1], {
        id,
        text: '',
        clientMessageId: 'nf1',
        attachments: [PNG, NOTES],
      });

      // the agent can't take pictures: held with the reason (the phone keeps the text and the files)
      s.pick.caps = { image: false, embeddedContext: false };
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new', {
        project: s.projectId,
        agent: 'claude',
        text: 'what is this?',
        clientMessageId: 'nf2',
        attachments: [PNG],
      });
      const held = r.json.id as string;
      await until(async () => (await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${held}`)).json.state === 'held', 'held');
      r = await phoneCall(s, phone.token, 'GET', `/api/remote/new?id=${held}`);
      assertEquals(
        r.json.error,
        "Claude Code can't take pictures. Remove the picture and send again. Your message was not sent: it is in the box below.",
      );
      assert(!s.liveCalls.some(([n, b]) => n === 'prompt' && b.id === held), 'not sent');
      // sent again with the picture: refused in the same words; without it (a text file instead): it goes
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new/first', {
        id: held,
        text: 'what is this?',
        clientMessageId: 'nf2',
        attachments: [PNG],
      });
      assertEquals([r.status, r.json.code], [403, 'no_pictures']);
      r = await phoneCall(s, phone.token, 'POST', '/api/remote/new/first', {
        id: held,
        text: 'what is this?',
        clientMessageId: 'nf2',
        attachments: [NOTES],
      });
      assertEquals(r.status, 200, r.text);
      assertEquals(s.liveCalls.find(([n, b]) => n === 'prompt' && b.id === held)![1].attachments, [NOTES]);
      const log = (s.ctx.phone.audit.tail(500) as unknown as Json[]).map((l) => String(l.result));
      assert(log.some((l) => l.includes('first message with 1 picture and 1 file')), log.join('\n'));
      assert(log.includes('first message sent, with 1 file'), log.join('\n'));
    } finally {
      setAgentRows(null);
      await s.close();
    }
  },
});
