# AIB keeper protocol, version 1

The keeper (`AIB-keeper`) holds agent processes and terminals, records everything they say and everything written to them,
and serves that record to AIB. This file is the contract; AIB's keeper client is built from it.

**Rules that never change** (the keeper's "constitution", also at the top of `protocol.go`):

1. Operations, header fields, event types, error codes and record kinds are only ever **added**. Nothing is renamed, removed
   or given a new meaning. Unknown header fields are ignored by both sides. An unknown op is answered with
   `{"ok":false,"error":"unknown_op"}`; the connection stays open.
2. A feature is listed in hello's `features`. AIB checks the list before using it.
3. The protocol number is 1 and stays 1. A keeper that must break it is a new program next to this one.
4. AIB carries the compatibility burden: every AIB version must drive every released keeper.
5. Limits are fixed: header at most 64 KiB, body at most 16 MiB. A bad frame closes only that connection.

Clients must also ignore unknown events, unknown response fields and unknown record kinds.

---

## 1. Starting the keeper and finding it

```
AIB-keeper serve --data <AIB data folder> [--orphan-command <json>] [--port N]
AIB-keeper version
```

| Flag | Default | Meaning |
|---|---|---|
| `--data` | (required) | AIB's data folder. The keeper keeps everything in `<data>/keeper/`. |
| `--orphan-command` | none | JSON `{"command":"…","args":[…],"cwd":"…","env":{…}}`: what to run when no client is attached (section 6). Can also be set later with `setOrphanCommand`. |
| `--port` | 0 (any free port) | Loopback TCP port, where TCP is used (section 2). |
| `--orphan-after` | `5s` | No client this long while a channel is live: run the orphan command. |
| `--orphan-retry` | `10s` | Time between orphan command attempts. |
| `--orphan-tries` | `3` | Attempts before the keeper stops its channels and exits. |
| `--exit-after` | `10s` | No live channel and no client this long: exit. |
| `--flush` | `200ms` | Journal flush and fsync interval. |
| `--segment-bytes` | 16 MiB | Journal segment size. |
| `--max-channel-bytes` | 2 GiB | Per-channel journal cap; past it the oldest segment is deleted (a runaway agent cannot fill the disk). |

Exit codes: `0` normal exit, `1` start-up error, `2` bad arguments, `3` another keeper already holds this data folder.

AIB starts it detached and hidden. On Windows the release binary is a GUI-subsystem program (it can never get a console
window); start it with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB` (retry
without breakaway if the job refuses). On macOS/Linux start it with `setsid`. Its stdout/stderr are not used; it logs to
`<data>/keeper/keeper.log` (rotated at 1 MiB to `keeper.log.1`).

### Files in `<data>/keeper/`

The folder is user-only: on Windows a protected DACL with one entry (this user, full control, inherited by everything
inside); elsewhere mode 0700, files 0600.

| File | Content |
|---|---|
| `keeper.lock` | OS lock (LockFileEx / flock). One keeper per data folder. |
| `keeper.json` | Written **after** the socket listens, so its presence means "ready". Removed on a clean exit. |
| `keeper.sock` | The unix socket (macOS/Linux). |
| `channels.json` | Channel index: one entry per channel (the `list` entry without `epoch`, `first`, `last`, `owner`). |
| `channels/<id>/<firstSeq>.journal` | A channel's journal segments (section 5). |
| `keeper.log` | The keeper's log. |

`keeper.json`:

```json
{
 "pid": 4242,
 "protocol": 1,
 "keeper": "1.0.0",
 "transport": "tcp",
 "address": "127.0.0.1:53017",
 "token": "9c1f…64 hex chars…",
 "started": 1794312000000,
 "orphanCommand": null
}
```

To connect: read `keeper.json`; check that `pid` is alive; dial `transport`/`address`; send hello with `token`. If the file is
missing, or the dial fails, start a keeper and poll for the file (it normally appears within ~100 ms). If the new keeper exits
with code 3, another one won the race: read the file again.

## 2. Transport

- **Windows:** loopback TCP on `127.0.0.1` (`transport: "tcp"`). Non-loopback peers are closed at once.
- **macOS/Linux:** unix socket `<data>/keeper/keeper.sock` (`transport: "unix"`), mode 0600 in a 0700 folder. If that path
  would be longer than 99 bytes (the unix socket limit), loopback TCP is used instead, exactly as on Windows.

Either way the token is required. Anything that is not this protocol (for example a browser's HTTP request) fails the length
check on its first four bytes and is closed.

## 3. Framing

Every message in both directions is one frame:

```
[u32 little-endian headerLength][header: UTF-8 JSON object][u32 little-endian bodyLength][body: raw bytes]
```

- `headerLength` is 1..65536. `bodyLength` is 0..16777216. Anything else closes the connection (after a best-effort
  `{"ok":false,"error":"bad_request"}`).
- The header is a JSON object. A header that is not one closes the connection.
- The body is raw bytes: agent traffic and notes are never re-encoded.

Three kinds of frames:

| Kind | Header has | Example |
|---|---|---|
| Request (client → keeper) | `op`, optional `id` | `{"op":"write","id":7,"channel":"c1","epoch":2,"once":"prompt:r9"}` + body |
| Response (keeper → client) | `ok`, `re` (the request's `id`, if it had one) | `{"ok":true,"re":7,"seq":118}` |
| Event (keeper → client) | `ev` | `{"ev":"record","channel":"c1","seq":118,"kind":"in","time":1794312000123}` + body |

`id` is any JSON number or string up to 256 bytes; it is echoed as `re`. Responses come in request order on a connection,
but events can come between them.

An error response: `{"ok":false,"re":7,"error":"fenced","message":"…","epoch":3}`. `message` is for logs only; code on
`error`.

## 4. Operations

All ops except `hello` need an authenticated connection. "Owner" below means: the connection that made the channel's
current claim (or spawned it), sending the channel's current `epoch`. Both must match; knowing the number is not enough.

### hello

Must be the first frame, within 10 s.

```json
→ {"op":"hello","id":1,"token":"9c1f…","min":1,"max":1,"client":"AIB 0.2.3"}
← {"ok":true,"re":1,"protocol":1,"keeper":"1.0.0","pid":4242,
   "features":["pty","notes","truncate","orphan","signal","once","channel-ids","scrollback","labels"]}
```

`min`/`max` is the protocol range the client speaks (`max` 0 = same as `min`). Errors (each closes the connection):
`bad_token` (after a 200 ms delay), `unsupported_protocol` (with `"protocol":1`), `not_authenticated` (any other op first),
`shutting_down`.

### list

```json
→ {"op":"list","id":2}
← {"ok":true,"re":2,"channels":[
   {"channel":"c1","kind":"pipe","pid":5120,"command":"C:\\…\\claude-code-acp.exe","args":["--x"],"cwd":"C:\\proj",
    "created":1794312000000,"live":true,"exitCode":null,"epoch":2,"first":1,"last":118,"owner":false},
   {"channel":"pty-1f…","kind":"pty","pid":6100,"command":"pwsh.exe","label":"{…}","created":1794312000200,"live":true,
    "exitCode":null,"epoch":1,"first":3301,"last":5210,"owner":false},
   {"channel":"t7","kind":"pty","pid":6000,"command":"pwsh.exe","created":1794312000500,"live":false,
    "ended":1794312009000,"exitCode":0,"reason":"exit","epoch":1,"first":1,"last":40,"owner":true}]}
```

Ordered by `created`. `label` is there only when the spawn gave one (keeper 1.2.0). `first`/`last` are the oldest and newest stored seq (`last` is 0 and `first` 1 for an empty journal).
`reason` (ended channels): `exit` (it ended by itself), `killed` (kill op), `shutdown` (keeper shut down), `orphaned` (no
client came back, section 6), `keeper_lost` (the previous keeper died while it ran; written by the next keeper at start).
Channels from earlier keepers stay listed (ended) until removed with `truncate`.

### status

```json
→ {"op":"status","id":3}
← {"ok":true,"re":3,"keeper":"1.0.0","protocol":1,"pid":4242,"started":1794312000000,"dir":"C:\\…\\keeper",
   "address":"127.0.0.1:53017","live":2,"channels":5,"clients":["AIB 0.2.3"],"orphanCommand":{"command":"…"}}
```

### spawn

Starts a process. The spawning connection becomes the owner with `epoch` 1.

```json
→ {"op":"spawn","id":4,"channel":"term-r17","command":"C:\\Program Files\\Git\\bin\\bash.exe","args":["-l"],
   "cwd":"C:\\proj","env":{"PATH":"…","TERM":"xterm-256color"},"pty":{"cols":120,"rows":30}}
← {"ok":true,"re":4,"channel":"term-r17","pid":7311,"epoch":1,"kind":"pty"}
```

| Field | Meaning |
|---|---|
| `channel` | Optional id, 1-64 of `[A-Za-z0-9._-]`. Lets AIB write its note (for example `clientTerminal`) **before** spawning; a repeat gets `exists` (with `"info":{…list entry…}`), never a second process. Omitted: the keeper makes `ch-<16 hex>`. |
| `command` | The program. Should be an absolute path; a bare name is looked up in the **keeper's** PATH (Windows: with PATHEXT). |
| `args` | Arguments. The keeper never builds or interprets a command line beyond the platform's standard quoting. |
| `windowsCommandLine` | Windows only, optional: the exact command line given to CreateProcess (`command` is still the program). |
| `cwd` | Working folder; empty = the keeper's. |
| `env` | The **complete** environment as an object. Omitted: the keeper's own environment (which is from when the keeper started, so AIB should normally send it). |
| `pty` | Omitted: pipes (stdin, stdout, stderr). Given: a terminal of `cols` × `rows` (1..32767): Windows ConPTY, POSIX openpty with the child as session leader. |
| `scrollback` | Optional (feature `scrollback`, keeper 1.2.0), bytes 65536..268435456: a **bounded journal**. The keeper keeps at least the newest `scrollback` bytes of this channel's records (record overhead included) and at most about a quarter more; older records go a whole segment (a quarter of `scrollback`) at a time, and a reader from an older seq gets a `gap`. Meant for terminals, whose old output is not needed. Omitted: the normal journal (only `truncate` and `--max-channel-bytes` remove anything). Out of range: `bad_request`. |
| `label` | Optional (feature `labels`, keeper 1.2.0), at most 16 KiB, no NUL: opaque text the keeper stores and shows in `list` (and `channels.json`), never reads. Unlike a note it is never dropped from the journal, so it suits what a client needs to find a bounded channel again. |

Every child is hidden: Windows pipes children get `CREATE_NO_WINDOW` (a console without a window, inherited by the console
programs it starts); pty children run on a headless pseudo console. Every child is in its own Windows Job Object with
`KILL_ON_JOB_CLOSE`, or leads its own POSIX process group. If the keeper dies, every Windows child tree dies with it; on Linux
the direct child gets SIGKILL and the rest get EOF on stdin.

Errors: `bad_request` (bad id, empty command, NUL in a string, bad pty size), `exists`, `spawn_failed` (with `message`),
`shutting_down`.

### attach

Sends the channel's records from `from` on, then follows it live, until `detach`, a new `attach` of the same channel on this
connection, or the connection closes.

```json
→ {"op":"attach","id":5,"channel":"c1","from":0}
← {"ok":true,"re":5,"channel":"c1","first":1,"last":118,"live":true}
← {"ev":"record","channel":"c1","seq":1,"kind":"in","time":1794312000010}      body: {"jsonrpc":"2.0","id":0,"method":"initialize",…}\n
← {"ev":"record","channel":"c1","seq":2,"kind":"out","time":1794312000400}     body: {"jsonrpc":"2.0","id":0,"result":{…}}\n
   … up to seq 118 …
← {"ev":"live","channel":"c1","seq":118}
← {"ev":"record","channel":"c1","seq":119,"kind":"out","time":…}               (live from here)
```

- `from` 0 or 1 = from the start. Older than the oldest stored record: a `gap` event first, then from the oldest.
  Past the end: just `live`, then new records as they come.
- `live` is sent once per attach, when the replay has caught up; its `seq` is the last record sent so far.
- Attaching does not claim. Any number of connections can attach to a channel.
- A client that stops reading for 30 s is disconnected (it can attach again from its last seq). A slow reader never slows the
  agent: the keeper reads the agent's output at all times and the reader catches up from the journal.

### detach

```json
→ {"op":"detach","id":6,"channel":"c1"}
← {"ok":true,"re":6}
```

### claim

Makes this connection the only writer of the channel. Works on live and ended channels.

```json
→ {"op":"claim","id":7,"channel":"c1"}
← {"ok":true,"re":7,"epoch":3}
```

The previous owner's connection (if still open) gets `{"ev":"fenced","channel":"c1","epoch":3}` and from then on every
owner-only op it sends is refused with `fenced` and nothing is written. When the owner's connection closes, nobody owns the
channel until the next claim (the epoch stays).

### write (owner)

Writes the body to the child's stdin (or the terminal's input). Recorded as an `in` record at the moment it is accepted, in
the same order as it reaches the child.

```json
→ {"op":"write","id":8,"channel":"c1","epoch":3,"once":"prompt:r9"}   body: {"jsonrpc":"2.0","id":12,"method":"session/prompt",…}\n
← {"ok":true,"re":8,"seq":120}
```

`once` (optional, any string up to the header limit): if this key was already used on this channel by **any** client (an
accepted `write` or `note`), the write is refused with `duplicate` and nothing is written. Treat `duplicate` as "already
done". Keys live as long as the keeper; they are not stored in the journal.

The keeper never blocks on the child: the bytes are queued. Errors: `fenced` (with the current `epoch`), `duplicate`,
`ended` (child gone or stdin closed), `busy` (more than 32 MiB or 4096 writes queued), `bad_request` (empty body).

### closeStdin (owner, pipes only)

Closes the child's stdin after the queued writes. ACP adapters exit on it.

```json
→ {"op":"closeStdin","id":9,"channel":"c1","epoch":3}
← {"ok":true,"re":9}
```

Errors: `fenced`, `ended`, `unsupported` (a pty), `busy`.

### resize (owner, ptys only)

```json
→ {"op":"resize","id":10,"channel":"term-r17","epoch":1,"cols":100,"rows":40}
← {"ok":true,"re":10,"seq":57}
```

`once` (keeper 1.2.0) works as for `write`: a key already used on the channel is refused with `duplicate` and the size is not changed.

Recorded as a `resize` record with body `{"cols":100,"rows":40}`. Errors: `fenced`, `ended`, `unsupported` (pipes),
`bad_request`, `failed`.

### signal (owner, macOS/Linux)

Sends a signal to the channel's whole process group: `interrupt`, `terminate`, `hangup`, `quit`, `kill`, `user1`, `user2`.

```json
→ {"op":"signal","id":11,"channel":"c1","epoch":3,"signal":"interrupt"}
← {"ok":true,"re":11}
```

Windows answers `unsupported` (children have their own consoles; use `write` of `\x03` on a pty, or `kill`).

### kill (owner)

Kills the whole tree (Windows: TerminateJobObject; POSIX: SIGKILL to the process group), also processes the child started
and left behind. The `exit` record follows with reason `killed`. Answered at once; on an ended channel it does nothing.

```json
→ {"op":"kill","id":12,"channel":"c1","epoch":3}
← {"ok":true,"re":12}
```

### note (owner)

Stores an opaque blob in the journal as a `note` record. The keeper never reads it. Allowed on ended channels. `once` works as
for `write`.

```json
→ {"op":"note","id":13,"channel":"c1","epoch":3,"once":"note:receipt:r9"}   body: {"v":1,"t":"receipt","receipt":"r9","rpc":12}
← {"ok":true,"re":13,"seq":121}
```

### truncate (owner)

Deletes whole journal segments whose records are all older than `before`. The newest segment is never deleted, so some
records older than `before` may remain. On an **ended** channel with `before` greater than its last seq, the channel is
removed entirely (journal and index entry); attached connections get `{"ev":"removed","channel":…}`.

```json
→ {"op":"truncate","id":14,"channel":"c1","epoch":3,"before":5000}
← {"ok":true,"re":14,"first":4113}
→ {"op":"truncate","id":15,"channel":"old","epoch":1,"before":999999}
← {"ok":true,"re":15,"removed":true}
```

### setOrphanCommand

Sets (or with `null` clears) the orphan command. It is shown in `keeper.json` and `status`.

```json
→ {"op":"setOrphanCommand","id":16,"orphan":{"command":"C:\\…\\AIB.exe","args":["--tray","--headless"],"cwd":"C:\\…"}}
← {"ok":true,"re":16}
```

`env` in it is the complete environment; omitted = the keeper's.

### shutdown

```json
→ {"op":"shutdown","id":17}
← {"ok":false,"re":17,"error":"busy","live":2}
→ {"op":"shutdown","id":18,"force":true}
← {"ok":true,"re":18}
```

With `force` (or no live channel) the keeper kills every tree (exit records with reason `shutdown`), flushes the journals,
removes `keeper.json` and exits. Connections are closed.

## 5. Records and the journal

| Kind | Written when | Body |
|---|---|---|
| `out` | the child wrote to stdout (pty: all terminal output) | raw bytes, as read (any chunking) |
| `err` | the child wrote to stderr (pipes only) | raw bytes |
| `in` | a `write` was accepted | the written bytes |
| `note` | a `note` was accepted | the client's blob |
| `exit` | the child ended (the last record a process ever adds) | `{"code":0,"reason":"exit"}`; `code` is null for `keeper_lost`. POSIX: a child killed by signal N has code 128+N. |
| `resize` | a `resize` was accepted | `{"cols":100,"rows":40}` |

Sequence numbers start at 1 per channel and have no holes. `time` is Unix milliseconds. Notes may follow `exit`.

On disk (for tools and tests; clients read through `attach`): `channels/<id>/<firstSeq, 20 digits>.journal`, each a series of

```
[u32le dataLength][u8 kind: 1 out, 2 err, 3 in, 4 note, 5 exit, 6 resize][u64le seq][u64le timeMs][data][u32le CRC-32 (IEEE) of kind..data]
```

Records are flushed and fsynced every 200 ms and at exit; a power loss can lose the last 200 ms. At start the keeper cuts a
torn or corrupt tail and drops anything after it. The newest ~4 MiB of each channel are also kept in memory for live readers.

## 6. Lifetime rules

- **Exit (V2):** with no live channel and no client attached for 10 s, the keeper exits (also right after start, if nobody
  connects).
- **Orphan restart (V1):** with a live channel and no client attached for 5 s, the keeper runs the orphan command (detached,
  hidden, outside the keeper's jobs). If still no client 10 s later, again; at most 3 times. If no client has come 10 s after
  the third attempt (or there is no orphan command), it kills every channel (reason `orphaned`) and exits. Any authenticated
  connection counts as a client; one connecting resets the count.
- **Keeper crash:** the children die (Windows Job Objects). The next keeper adds an `exit` record with reason `keeper_lost`
  to every channel that was live. Nothing is ever resent.

## 7. Error codes

`unknown_op`, `bad_request`, `not_authenticated`, `bad_token`, `unsupported_protocol`, `no_channel`, `exists`, `ended`,
`fenced`, `duplicate`, `busy`, `spawn_failed`, `unsupported`, `failed`, `shutting_down`.

## 8. Events

| Event | Fields | Meaning |
|---|---|---|
| `record` | `channel`, `seq`, `kind`, `time` + body | one journal record |
| `live` | `channel`, `seq` | replay has caught up to `seq` |
| `gap` | `channel`, `from`, `next` | records `from`..`next-1` are no longer stored; continuing at `next` |
| `fenced` | `channel`, `epoch` | another connection claimed the channel; stop writing to it |
| `removed` | `channel` | the channel was removed (truncate of an ended channel) |

## 9. Change log

- **1** (keeper 1.0.0): everything above.
- keeper 1.1.0 (protocol still 1): the separate `AIB-keeper mcp-forward <address file>` subcommand, a generic stdio-to-HTTP MCP
  forwarder agents run as their MCP server (`mcpforward.go`; `mcp-forward --check` prints `mcp-forward 1`). It never runs inside a
  serving keeper and adds nothing to the wire protocol.
- keeper 1.2.0 (protocol still 1): spawn's `scrollback` (feature `scrollback`) and `label` (feature `labels`, shown in `list`), and
  `once` on `resize`. AIB runs its chat terminals and agents' client terminals in the keeper only when both features are there; with
  an older keeper they run inside AIB as before.
