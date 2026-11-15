/**
 * GET /api/live/files/outside must not hold the server: the owner's log shows it at 1.1-1.8 s per request, every second or two, because
 * the "did this chat name that file" guard read the chat's transcripts (up to 64 MB) synchronously on every request. chatTexts now
 * reads without blocking and remembers each transcript's text by size and mtime. Synthetic 30 MB transcript under
 * work/slowreq-fixture/state/ (git-ignored).
 */
import { assert, assertEquals } from './_assert.ts';
import * as outside from '../../outputs/agent-studio/server/worktrees/outside_files.ts';

const ROOT = new URL('../slowreq-fixture/state/', import.meta.url);
const rootPath = () => decodeURIComponent(ROOT.pathname).replace(/^\/([A-Za-z]:)/, '$1');

Deno.test({
  name: 'chatTexts: a repeat check of a big chat reads nothing again, and a changed transcript is read again',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await Deno.mkdir(rootPath(), { recursive: true });
    const dir = await Deno.makeTempDir({ dir: rootPath(), prefix: 'outside-' });
    try {
      const file = `${dir}/chat.jsonl`;
      const line = JSON.stringify({ type: 'assistant', message: { content: 'y'.repeat(1 << 20) } }) + '\n';
      await Deno.writeTextFile(file, line.repeat(30) + JSON.stringify({ text: 'see C:/work/notes.md' }) + '\n');
      await Deno.mkdir(`${dir}/chat/subagents`, { recursive: true });
      await Deno.writeTextFile(`${dir}/chat/subagents/agent-1.jsonl`, '{"text":"hello"}\n');
      const source = { sessionFile: () => Promise.resolve(file) };
      const original = Deno.readFile;
      const originalSync = Deno.readFileSync;
      let reads = 0, syncReads = 0;
      Object.defineProperty(Deno, 'readFile', { value: (p: string) => (reads++, original(p)), configurable: true, writable: true });
      Object.defineProperty(Deno, 'readFileSync', { value: (p: string) => (syncReads++, originalSync(p)), configurable: true, writable: true });
      try {
        let t = performance.now();
        const first = await outside.chatTexts(source, 'claude:abc');
        const firstMs = performance.now() - t;
        assertEquals(first.length, 2);
        assert(first[0].includes('notes.md'), 'the transcript text is there');
        assertEquals(reads, 2);
        t = performance.now();
        const again = await outside.chatTexts(source, 'claude:abc');
        const againMs = performance.now() - t;
        console.log(`chatTexts 30 MB: first ${firstMs.toFixed(0)} ms, repeat ${againMs.toFixed(0)} ms`);
        assertEquals(reads, 2, 'the repeat read no file');
        assertEquals(syncReads, 0, 'nothing read synchronously');
        assert(againMs < 300, `repeat took ${againMs.toFixed(0)} ms`);
        assertEquals(again.length, 2);
        await new Promise((r) => setTimeout(r, 20));
        await Deno.writeTextFile(`${dir}/chat/subagents/agent-1.jsonl`, '{"text":"now D:\\x.txt"}\n', { append: true });
        const changed = await outside.chatTexts(source, 'claude:abc');
        assertEquals(reads, 3, 'only the changed transcript is read again');
        assert(changed.join('\n').includes('x.txt'));
      } finally {
        Object.defineProperty(Deno, 'readFile', { value: original, configurable: true, writable: true });
        Object.defineProperty(Deno, 'readFileSync', { value: originalSync, configurable: true, writable: true });
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
