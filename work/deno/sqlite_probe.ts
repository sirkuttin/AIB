/**
 * Phase 0A probe (history loading): proves node:sqlite (DatabaseSync, WAL, FTS5) works in this runtime, on the main thread and in
 * a Worker. `AIB sqlite-probe <dir>` in a compiled build, or `deno run -A sqlite_probe.ts <dir>` from source. Prints one JSON line.
 */
import { DatabaseSync } from 'node:sqlite';

export function probeDb(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path);
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    db.exec('PRAGMA synchronous=NORMAL');
    const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const opts = (db.prepare('PRAGMA compile_options').all() as { compile_options: string }[]).map((r) => r.compile_options);
    db.exec('CREATE TABLE IF NOT EXISTS messages(row_start INTEGER PRIMARY KEY, text TEXT)');
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='row_start')");
    const ins = db.prepare('INSERT OR REPLACE INTO messages(row_start, text) VALUES (?, ?)');
    const fts = db.prepare('INSERT INTO messages_fts(rowid, text) VALUES (?, ?)');
    db.exec('BEGIN');
    for (let i = 1; i <= 100; i++) {
      const text = i === 42 ? 'the gettysburg address was short' : `message number ${i}`;
      ins.run(i, text);
      fts.run(i, text);
    }
    db.exec('COMMIT');
    const hit = db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('gettysburg') as { rowid: number }[];
    const ckpt = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return {
      journal_mode: mode,
      sqlite: version,
      fts5: opts.includes('ENABLE_FTS5'),
      threadsafe: opts.find((o) => o.startsWith('THREADSAFE')) ?? null,
      fts_hit: hit.map((r) => Number(r.rowid)),
      checkpoint: ckpt,
    };
  } finally {
    db.close();
  }
}

export async function main(args: string[]): Promise<number> {
  const dir = args[0] ?? Deno.makeTempDirSync({ prefix: 'aib-sqlite-probe-' });
  Deno.mkdirSync(dir, { recursive: true });
  const result: Record<string, unknown> = { os: Deno.build.os, arch: Deno.build.arch, deno: Deno.version.deno };
  try {
    result.main = probeDb(`${dir}/main.sqlite`);
  } catch (error) {
    result.main = { error: String(error) };
  }
  try {
    const worker = new Worker(new URL('./sqlite_probe_worker.ts', import.meta.url).href, { type: 'module' });
    result.worker = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'worker timeout' }), 15000);
      worker.onmessage = (e) => (clearTimeout(timer), resolve(e.data));
      worker.onerror = (e) => (clearTimeout(timer), e.preventDefault(), resolve({ error: String(e.message) }));
      worker.postMessage(`${dir}/worker.sqlite`);
    });
    worker.terminate();
  } catch (error) {
    result.worker = { error: String(error) };
  }
  const ok = (r: unknown) => {
    const x = r as Record<string, unknown>;
    return x?.journal_mode === 'wal' && x?.fts5 === true && Array.isArray(x?.fts_hit) && (x.fts_hit as number[])[0] === 42;
  };
  result.ok = ok(result.main) && ok(result.worker);
  const line = JSON.stringify(result);
  console.log('SQLITE_PROBE ' + line);
  try {
    Deno.writeTextFileSync(`${dir}/probe.json`, line + '\n'); // the GUI-subsystem exe may have no stdout
  } catch { /* read-only */ }
  return result.ok ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
