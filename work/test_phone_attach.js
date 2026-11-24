'use strict';
/* Attachments from the phone (owner: "we need to allow sending attachments from the phone app"), the pure parts of phone.js:
   - the PC composer's limits on the phone (4 pictures, 5 MB each, 15 MB of pictures; 8 files, text 2 MB, others 10 MB; 20 MB in all)
     and what the chat's agent can take (no pictures without image input; text files only without embedded context);
   - what goes to the PC: bytes, a picture's type, a file's name and type (never a path or anything else);
   - a big photo fits 2000 px on its long edge (never made bigger); phone file names are cleaned, never refused;
   - New chat and its checks take a message with attachments and no text;
   - a sent message shows its files' names.
   The browser part (📎 sheet, chips, scaling a real photo, the agent receiving it) is in work/deno/remote_attach_e2e_test.ts. */
const { PAGE: APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));

const MB = 1048576;
const pic = (size, name = 'IMG_1.jpg') => ({ kind: 'image', name, size, mime: 'image/jpeg', data: 'AAAA' });
const file = (size, name = 'notes.txt', text = true) => ({ kind: 'file', name, size, mime: text ? 'text/plain' : 'application/pdf', text, data: 'AAAA' });
const ALL = { pictures: true, binary: true };

test('limits: the PC composer’s, in short phone words', () => {
  assert.deepEqual(
    { ...P.ATTACH, longEdge: undefined, jpegQuality: undefined },
    { images: 4, files: 8, imageBytes: 5 * MB, imageTotal: 15 * MB, textBytes: 2 * MB, binaryBytes: 10 * MB, total: 20 * MB, nameChars: 200, longEdge: undefined, jpegQuality: undefined },
  );
  assert.equal(P.attachProblem([], pic(1000), ALL, 'Claude Code'), '');
  assert.equal(P.attachProblem([pic(1), pic(1), pic(1), pic(1)], pic(1), ALL), 'Up to 4 pictures per message.');
  assert.equal(P.attachProblem([pic(1), pic(1), pic(1)], pic(1), ALL), '');
  assert.equal(P.attachProblem(Array(8).fill(file(1)), file(1), ALL), 'Up to 8 files per message.');
  assert.equal(P.attachProblem(Array(4).fill(pic(1)), file(1), ALL), '', 'pictures and files count apart');
  assert.equal(P.attachProblem([], pic(5 * MB + 1, 'big.jpg'), ALL), 'big.jpg: pictures can be at most 5 MB.');
  assert.equal(P.attachProblem([pic(5 * MB), pic(5 * MB), pic(4 * MB)], pic(2 * MB), ALL), 'Pictures can be at most 15 MB in all.');
  assert.equal(P.attachProblem([], file(2 * MB + 1, 'log.txt'), ALL), 'log.txt: text files can be at most 2 MB.');
  assert.equal(P.attachProblem([], file(10 * MB + 1, 'a.pdf', false), ALL), 'a.pdf: files can be at most 10 MB.');
  assert.equal(P.attachProblem([], file(9 * MB, 'a.pdf', false), ALL), '');
  assert.equal(P.attachProblem([file(9 * MB, 'a.pdf', false), file(9 * MB, 'b.pdf', false)], file(3 * MB, 'c.pdf', false), ALL), 'Attachments can be at most 20 MB in all.');
  assert.equal(P.attachProblem([], file(0, 'empty.txt'), ALL), 'empty.txt: the file is empty.');
});

test('what the agent can take: no pictures without image input; text files only without embedded context; unknown = the PC says later', () => {
  const textOnly = { pictures: false, binary: false };
  assert.equal(P.attachProblem([], pic(10), textOnly, 'Codex'), 'Codex can’t take pictures.');
  assert.equal(P.attachProblem([], file(10, 'spec.pdf', false), textOnly, 'Codex'), 'Codex can take text files only, not spec.pdf.');
  assert.equal(P.attachProblem([], file(10, 'notes.txt'), textOnly, 'Codex'), '');
  assert.equal(P.attachProblem([], pic(10), null), '', 'New chat: not known before the chat opens');
  assert.equal(P.attachProblem([], file(10, 'spec.pdf', false), { pictures: false, binary: true }), '');
});

test('what goes to the PC: bytes, the picture type, the file name and type; never a path or other fields', () => {
  const items = [
    { id: 'a', kind: 'image', name: 'IMG_1.jpg', mime: 'image/jpeg', size: 3, data: 'AAAA', thumb: 'data:image/jpeg;base64,xx', scaled: true },
    { id: 'b', kind: 'file', name: 'notes.txt', mime: 'text/plain', size: 3, text: true, data: 'BBBB', path: 'C:\\x' },
    { id: 'c', kind: 'file', name: 'blob', mime: '', size: 3, text: false, data: 'CCCC' },
  ];
  assert.deepEqual(P.attachBody(items), [
    { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
    { type: 'file', name: 'notes.txt', mimeType: 'text/plain', data: 'BBBB' },
    { type: 'file', name: 'blob', mimeType: '', data: 'CCCC' },
  ]);
});

test('a big photo fits 2000 px on its long edge (never larger); file names are cleaned, never refused', () => {
  assert.equal(P.ATTACH.longEdge, 2000);
  assert.deepEqual(P.fitInside(4032, 3024, 2000), { width: 2000, height: 1500, scaled: true });
  assert.deepEqual(P.fitInside(3024, 4032, 2000), { width: 1500, height: 2000, scaled: true });
  assert.deepEqual(P.fitInside(1200, 900, 2000), { width: 1200, height: 900, scaled: false });
  assert.deepEqual(P.fitInside(2000, 10, 2000), { width: 2000, height: 10, scaled: false });
  assert.equal(P.cleanFileName('IMG_2041.jpg'), 'IMG_2041.jpg');
  assert.equal(P.cleanFileName('Report: Q3/Q4 "final"?.pdf'), 'Report_ Q3_Q4 _final__.pdf');
  assert.equal(P.cleanFileName('..hidden.'), 'hidden');
  assert.equal(P.cleanFileName('a\u202ereverse\u0007.txt'), 'areverse.txt');
  assert.equal(P.cleanFileName(''), 'file');
  const long = P.cleanFileName('x'.repeat(300) + '.txt');
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.txt'));
  assert.equal(P.looksText('notes.md', ''), true);
  assert.equal(P.looksText('data', 'application/json'), true);
  assert.equal(P.looksText('spec.pdf', 'application/pdf'), false);
  assert.equal(P.sizeWords(900), '900 B');
  assert.equal(P.sizeWords(2048), '2 KB');
  assert.equal(P.sizeWords(1.5 * MB), '1.5 MB');
  assert.equal(P.sizeWords(2 * MB), '2 MB');
});

test('New chat: a message with attachments and no text can start; the checks say what is missing', () => {
  const nc = { project: 'p1', agent: 'claude', agents: [{ id: 'claude', ok: true }] };
  assert.equal(P.newChatReady(nc, '', 0), false);
  assert.equal(P.newChatReady(nc, '', 1), true);
  assert.equal(P.newChatReady(nc, 'Fix it'), true);
  assert.equal(P.firstMessageProblem('', 0), 'Type your first message.');
  assert.equal(P.firstMessageProblem('', 2), '');
  assert.equal(P.firstMessageProblem('/doc x', 1), 'Messages that start with / are commands. Type them in AIB on your PC.');
});

test('a sent message shows its pictures and its files’ names', () => {
  const rows = P.rowsFrom([
    {
      seq: 3,
      kind: 'user',
      data: {
        text: 'Look',
        attachments: [{ type: 'image', mimeType: 'image/jpeg', url: '/api/remote/image?id=c&seq=3&n=0' }],
        files: [{ name: 'notes.txt', mimeType: 'text/plain', size: 10, kind: 'text', mode: 'embedded', preview: 'x' }],
      },
    },
  ]);
  assert.equal(rows[0].kind, 'you');
  assert.deepEqual(rows[0].images, ['/api/remote/image?id=c&seq=3&n=0']);
  assert.deepEqual(rows[0].files, ['notes.txt']);
});
