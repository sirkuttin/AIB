# History loading, Phase 0 baseline (2026-11-14)

Measured on the owner's Windows 11 machine (Deno 2.9.8, AIB 0.1.0-beta.9 from integration/beta10), using a copy of the owner's keeper
journals in a temp folder (216 MB, 30 channels; studio-worktrees.json left out; deleted after). Nothing pointed at the real state
folder, and no port was fixed. Scripts (run by hand, not tests):

| Script | What it measures |
|---|---|
| `work/deno/sqlite_probe.ts` (+ `_worker.ts`) | 0A: `node:sqlite` DatabaseSync, WAL, FTS5, THREADSAFE, on the main thread and in a Worker |
| `work/deno/history_baseline.ts` | 0B: disk read, record decode, note parse, a real `Connection` rebuild (fake keeper link): feed, restore, raw replay; open bytes and time |
| `work/deno/history_keeper_read.ts` | 0B: the repo keeper on the copy: `firstNote` and `attach`-to-live; `--takeover` replays Studio's take-over loop through the real `KeeperLink.adopt` |
| `work/deno/history_loop_bench.ts` (+ `history_loop_worker.ts`) | 0B: event-loop delay while 14 synthetic chats stream, with no store, a store on the main loop, or a store in one Worker |

## 0A: node:sqlite in the compiled app

The probe went in as a temporary hidden `AIB sqlite-probe <dir>` subcommand (in the no-window set). It is not committed, and
main.ts is back as it was. I built it with `tools/build.ts --targets windows-x64,linux-x64 --no-wsl --no-smoke` into a temp folder
inside the worktree. Both targets built in about 15 s each. The build output was deleted afterwards.

| OS | How | Result |
|---|---|---|
| Windows x64 | the compiled `AIB.exe sqlite-probe` from the zip, headless | **pass**: SQLite 3.53.2, `journal_mode=wal`, FTS5 table + MATCH hit, `THREADSAFE=1`, the same results inside a Worker (the Worker module was bundled through `new URL(..., import.meta.url)`, as tray_win_worker.ts is) |
| Linux x64 | the AppImage in WSL Ubuntu (`APPIMAGE_EXTRACT_AND_RUN=1`, DISPLAY/WAYLAND unset) | **pass**: the same results, main thread and Worker. The runtime logs libEGL/ZINK warnings at start, even for a no-window subcommand (no window opens) |
| macOS arm64 / x64 | symbols in the cached `libdenort-*-apple-darwin` 2.9.8 | **pass by symbols only**: `node:sqlite`, `DatabaseSync`, `ENABLE_FTS5`, `THREADSAFE=1`, `3.53.2`, `journal_mode` are all present. Not run |

Verdict: the store can use `node:sqlite` on all three systems. It needs no FFI, no bundled library and no extra permission.

## 0B-1: where take-over time goes

The biggest chats, as medians of 3 runs. Times are in ms. "Replay" is the raw records after the newest snapshot.

| Chat (channel) | Journal | Records / replayed | Disk read | Decode | Chunk notes (MB) | Note JSON.parse | Feed (buffer + parse) | Restore | Raw replay | Keeper attach | firstNote |
|---|---|---|---|---|---|---|---|---|---|---|---|
| chat-51bfbaae (e2e88b49) | 48.7 MB | 7259 / 0 | 21 | 2 | 104 (25.4) | 37 | 60 | 2 | 0 | 239 | 26-48 |
| **this lead chat** a16e40ca (bfebcc14) | 47.3 MB | 2228 / 1028 | 19 | 0 | 26 (43.9) | 49 (+26 decode) | 84 | 1 | 57 | 200 | **177-569** |
| roguelite (35e8355f) | 40.4 MB | 7328 / 7328 (no snapshot) | 15 | 1 | 0 | 0 | 0 | 0 | 141 | 172 | 1 |
| roguelite dup (0361c025) | 40.4 MB | 7298 / 7298 (no snapshot) | 15 | 1 | 0 | 0 | 0 | 0 | 156 | 164 | 1 |
| chat-9b1538f9 (fa4d1f82) | 19.2 MB | 802 / 2 | 8 | 0 | 4 (9.6) | 3 | 6 | 3 | 0 | 81 | 1 |
| 2630fe80 | 9.4 MB | 170 / 170 | 4 | 0 | 0 | 0 | 0 | 0 | 63 | 19 | 1 |

The keeper streams at about 200-240 MB/s over its local socket.

**Take-over replica** (`history_keeper_read.ts --takeover`): Studio's loop, run one chat after another through the real keeper and
`KeeperLink.adopt`. Every copied channel had ended, so all 30 were rebuilt, against 14 live ones at a real start.

- this lead chat: firstNote 569 ms + rebuild 552 ms = **1.12 s**
- chat-51bfbaae: 48 + 374 = 0.42 s; roguelite: 0.41 s and 0.53 s (two channels for one session)
- every small chat costs a floor of about **50-60 ms** in the rebuild, even with 13 records. Not explained yet; this replica also includes the failing claim
- total for 30 channels: 4.1 s. The 14 live ones today come to about 3 s

Today's log (studio.log 21:16, beta.9.wsl14 desktop app) shows more: this chat took **4.26 s** (while its turn was running), chat-51bfbaae took
2.58 s, and all 14 chats took 10.1 s.

What the split says:

1. **JSON parsing is not the cost.** Parsing every chunk note of a 44 MB journal takes 50-85 ms. Restore takes 1-3 ms. Disk read and decode
   take about 20 ms.
2. **The journal is read twice for a truncated chat.** `firstNote` attaches from 0 and parses every 4 MB chunk note until it reaches the
   snapshot that carries the chat note. For this chat that is 177-569 ms, about half of the replica's 1.12 s. Then `adopt` reads it all again
   (200 ms keeper transfer plus 84 ms parse).
3. **Raw replay is small for an idle chat with a snapshot** (0-57 ms). It is large for chats that never reached a quiet point
   (roguelite: 7300 records, 140-160 ms). A turn that is running replays everything since its last quiet point. At 21:16 this chat was
   working, so its replay was bigger than in this copy (the copy was taken later, idle).
4. **About 7 of today's 10 s is outside the history path as measured.** The candidates are: the bigger replay of a running turn, the per-chat
   work after `rebuilt` (session lease, `liveSync.chatOpened`, the duplicate check), and contention with the rest of start-up and with the
   keeper serving 14 live agents. A copy cannot reproduce live channels. **Next step before committing targets:** log per-chat timings
   (firstNote / rebuilt / after) in `#adoptFrom` for one real restart.

Quit (14-23 s) was **not measured**. Measuring it needs the owner's running AIB to hand chats back, and that was out of bounds here.

## 0B-2: open-chat bytes and time (what /api/live/state sends for a first open)

`public(0)` JSON.stringify'd, after the rebuild (medians):

| Chat | Events in RAM | Bytes | Server stringify |
|---|---|---|---|
| roguelite (35e8355f / 0361c025) | 6000 | **31.9 MB** | 71-75 ms |
| this lead chat (bfebcc14) | 6000 | **29.5 MB** | 59-64 ms |
| chat-51bfbaae (e2e88b49) | 6000 | 18.5 MB | 40 ms |
| chat-9b1538f9 (fa4d1f82) | 664 | 9.6 MB | 13 ms |
| 2630fe80 | 19 | 9.4 MB (19 events, huge tool output) | 13 ms |

These are server-side numbers only. The page's own JSON.parse and render of 20-30 MB comes on top. 2630fe80 shows that a few clipped-less
events can weigh as much as thousands.

## 0B-3: event-loop delay, store on the main loop vs in a Worker

There are 14 synthetic chats. Each sends a ~300 B chunk every 25 ms and a 4-40 KB tool output every second (about 560 events/s in all).
Every 200 ms a writer commits per-chat transactions into 14 WAL databases (synchronous=NORMAL, the design's events table). Every 2 s it
reads one chat's newest 300 events (about 240 KB). Each run lasts 30 s. The probe is a MessageChannel ping-pong, which sees every
block; Windows timers are too coarse at about 15 ms. "time p99" is the delay that a message arriving at a random moment stays under 99%
of the time.

| Mode | time p99 | max block | blocks > 5 ms | blocks > 20 ms |
|---|---|---|---|---|
| no store (round 2) | 0.12 ms | 4.7 ms | 0 | 0 |
| store on main loop (2 runs) | 0.15-0.20 ms | 3.4-4.2 ms | 0 | 0 |
| store on main loop, checkpoint every ~400 KB (10x default) | 4.7 ms | 11.6 ms | 37 | 0 |
| store in one Worker (2 runs) | 0.09-0.12 ms | 1.6-1.8 ms | 0 | 0 |

The no-store run in round 1 had a 29 ms outlier that came from the machine, not the store.

Writes alone stay far under the 20 ms budget even on the main loop. **Checkpoints are what show up.** At 10x the default rate they
cause 37 stalls of 5-12 ms in 30 s. A Worker removes them all from the loop. This scratch folder is under Documents; on a slow disk, or
with Defender scanning `*.sqlite-wal`, stalls would be longer. The Worker in the design stays the right call, but the budget is not at
risk either way.

## What this means for the targets

- **Idle chat < 300 ms:** reachable. Even today's mechanism costs 0.4-1.1 s for the biggest idle chats in the replica. Most of that is the
  double read (firstNote plus the full attach) and the keeper transfer of 40-50 MB, which take-over from `ckpt.record + 1` removes.
  The 50-60 ms per-chat floor has to be found, or 14 chats cost 0.8 s on it alone.
- **14 idle chats < 2 s:** the history path alone is about 3 s today, so this can plausibly be met. But today's 10 s is about 70% outside
  what this replica measures. **Do not commit this target until one real restart is instrumented**; the store may not move most of it.
- **A working chat in proportion to its current turn:** consistent with the data. Raw replay runs at about 50 records/ms (7300 records
  in 140-160 ms), so a turn costs its record count, not the history.
- **Open:** 18-32 MB per open of a big chat today. A recent page of a few hundred KB is a 60-100x cut.
- **Worker vs main loop:** both are under the 20 ms budget. The Worker keeps checkpoint stalls (up to ~12 ms seen) off the loop.
