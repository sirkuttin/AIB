# Cross-client ownership reporting

Status: **partly implemented (2026-11-07)**. Studio now gathers read-only evidence before continuing a saved conversation, writes and reads cooperative "owner announcements", and shows what it found. It still cannot prove a conversation is free, and no UI text says it can. The sections below separate what shipped from what is still design only.

## Problem

Studio prevents two Studio processes from running the same conversation (OS-backed per-session leases in the shared state directory) and refuses to continue a conversation when a native agent process names that session in its command line. Before this work that was all it could see. It cannot see:

- a generic `omp acp` or `claude-agent-acp` process whose session is chosen later by an ACP request (`session/load`, `session/new`) and so never appears in process arguments;
- clients on other machines or other user accounts;
- an idle session held open by a client that is not writing anything.

Absence of evidence is therefore not safety.

## What shipped

Code: `ownership_probe.py` (evidence, announcements), wiring in `studio.py` (`Studio.check_ownership`, heartbeat), UI in `ownership-ui.js`. Tests: `work/test_ownership_probe.py` (41 Python tests), `work/test_ownership_ui.js` (8 Node tests). Command line: `python ownership_probe.py --provider claude --session ID --cwd DIR` prints the evidence for one conversation and changes nothing.

### Verdicts

| Verdict | Meaning | Evidence that produces it | Studio behaviour |
| --- | --- | --- | --- |
| `owned_by_studio` | This Studio runs it | an open connection in this process | "Live in Studio" (as before) |
| `owned_elsewhere` | **Strong** evidence another client runs it | a live owner announcement (fresh heartbeat, PID alive and start time matches); a `claude`/`omp` process whose command line has `--resume`/`--session-id` equal to this session | Continue is refused (HTTP 409 `session_in_use`) with the evidence listed. "Continue anyway" is not offered. |
| `possibly_active` | **Weak** evidence only | transcript (or a subagent transcript) written within 120 s by someone other than Studio; an agent process of the right kind running in this project folder; another process holds the transcript open; an announcement that expired but whose process still runs; a fresh announcement from another computer | Continue is refused (HTTP 409 `possibly_active`) until the user presses **Continue anyway** on a card that lists the evidence ("Transcript was written 40 seconds ago, and Studio is not the app writing it"). The retry carries `continueAnyway: true`. The server enforces this, not only the browser. |
| `no_evidence` | Nothing found | none of the above | Continue proceeds. The header keeps saying "No other app was detected using this conversation, but Studio cannot prove it is free." |

A conversation Studio itself just released is not blamed on "another app": transcript writes up to 3 s after Studio's release are attributed to Studio.

### Signals implemented

1. **Command-line match (strong, kept).** Same rule as before, but it now reads one cached process snapshot instead of spawning PowerShell on every probe. The snapshot comes from `CreateToolhelp32Snapshot` plus each candidate process's PEB (command line and current directory) through `ctypes`: read-only, about 15 ms for ~500 processes, same-user processes only. Studio's own agent processes and their descendants are excluded. If the snapshot cannot be taken, the old PowerShell probe is the fallback.
2. **Transcript activity (weak).** Claude: `<projects>/<project>/<session>.jsonl`; OMP: `<sessions>/<folder>/<timestamp>_<session>.jsonl` (the session ID is the part after the last `_`). Modified within 120 s and not by Studio gives `possibly_active` with the age. Growth since Studio last looked is reported. Subagent transcripts in the sibling folder count (full check only). An older write is listed only as a note, because an idle session open elsewhere writes nothing.
3. **Open file handle (weak), Windows only.** The Restart Manager API (`rstrtmgr.dll`: `RmRegisterResources` + `RmGetList`) lists the processes that currently hold the transcript open. It takes no handle on the file, so it cannot make a writer fail. Verified on this machine with a child process holding a file. **Limit, observed:** Claude Code and OMP open, append and close, so a live conversation that is mid-write shows no holder at most instants (a real transcript written 2 s earlier showed none). A holder is useful when present; an empty result proves nothing. Only the full check at continue time asks; list polls never do.
4. **Agent process in the same folder (weak).** The cwd of candidate processes (`omp.exe`, `node` running `claude-agent-acp`, the Claude engine `claude.exe`, `devin.exe acp` without `--agent-type`) is read from the PEB and compared with the conversation's folder. Reported with the parent client where known ("started by Devin"). The text says plainly that the process does not reveal which conversation it holds. Electron helper processes (`--type=`) and Devin's internal summarizer/codemap agents are ignored; a process whose command line names a different session is excluded; adapter-to-engine chains are shown once. Not used for the sidebar hints, because it would flag every row in the folder.
5. **Cooperative announcements (strong when live).** See the format below. Studio writes one while it owns a conversation (state `opening` before `session/load`, then `ready`/`working`, heartbeat every 10 s, removed on close and at exit) and reads everyone's before continuing.

### Owner announcement format, version 1

Folder: `%LOCALAPPDATA%\agent-sessions\owners\` on Windows, `$XDG_STATE_HOME/agent-sessions/owners/` (default `~/.local/state/agent-sessions/owners/`) elsewhere. Override with `--owners-dir`; `--no-owner-announcements` turns writing and reading off.

One file per (session, client instance): `<sha256(provider + "\0" + sessionId)[:32]>--<instanceId>.json`. Because each client writes only its own file, two clients that claim the same session never overwrite each other and both claims stay visible. (The original design used one exclusive-create file per session; per-instance files replace it, since a tie is better shown than decided by a race nobody can see.)

```json
{
  "format": "agent-session-owner",
  "version": 1,
  "provider": "claude",
  "sessionId": "6669ca47-5544-49ab-8c7c-83f84e48a06c",
  "client": {"name": "agent-studio", "version": "0.1.0", "instanceId": "a18c5bc6e18e427c9276201fcfb2b1e9"},
  "pid": 12345,
  "pidStart": "2026-11-07T23:29:15Z",
  "hostname": "SOMEPC",
  "cwd": "C:\\REPOS\\project",
  "state": "ready",
  "announcedAt": "2026-11-07T23:30:08Z",
  "heartbeatAt": "2026-11-07T23:30:18Z",
  "ttlSeconds": 30
}
```

Writer rules: write to `<name>.<pid>.tmp` in the same folder, then atomic rename over `<name>`; refresh `heartbeatAt` at least every `ttlSeconds / 3`; delete the file when the session is released. `provider` is `omp` or `claude` (lower-case `[a-z0-9_-]`, up to 32); `sessionId` is the agent's native session ID. `pidStart` (UTC) is optional but lets readers detect PID reuse. `ttlSeconds` must be 5 to 300.

Reader rules (what Studio does): ignore a file over 4 KiB, not valid JSON, with another `format`/`version`, with a bad field, whose name prefix does not match its provider/session, or with a heartbeat more than 5 minutes in the future. Then classify:

| Status | Rule | Effect |
| --- | --- | --- |
| live | same host, heartbeat within `ttl + 5 s`, PID alive and start time matches | strong, blocks |
| stale | same host, heartbeat older than that, PID still alive | weak, needs confirmation |
| remote | other `hostname`, heartbeat fresh | weak (Studio cannot check a process on another machine) |
| dead / expired | PID gone or start time differs; or other host and heartbeat old | listed as a note, does not block |

Foreign files are never deleted or modified by Studio. A reader must treat every field as untrusted text (Studio flattens control characters, caps length and renders with `textContent`). Announcements hold no prompts, transcript text or secrets.

### Integrating another client

Any client that runs a session can announce it with about thirty lines: compute the file name as above, write the JSON atomically when it loads or creates the session (before `session/load`), refresh it on a timer, delete it on close. The Agent Watch VS Code extension (`outputs/agent-watch-vscode/`) was **not** changed: it only reads transcripts and does not run or hold any session, so an announcement from it would claim ownership it does not have. The extension that actually runs the agent (Devin's ACP integration, a CLI wrapper) is the one that can write truthfully. Until one does, announcements exist only for Studio, and Studio-to-Studio detection across different state directories is the only cooperative detection that works today.

### Cost

One process snapshot is shared by every probe for 4 s. The list endpoint (`GET /api/live/ownership`, polled with the conversation list every 5 s) never starts a snapshot; it uses the cached one if present and otherwise warms it in a background thread, and everything else it does is a directory listing of recently modified transcripts, cached for 3 s. The open-file check and the folder check run only when the user presses Continue (or the single-conversation endpoint is called). A full check measured about 55 ms on this machine, including the process snapshot.

### Certainty ("unknown")

`assess()` returns `certainty` next to the verdict: `evidence` (something was found), `checked` (nothing found and every check could run) or `unknown` (nothing found, but the process list or the open-file check could not run on this system). The verdict names do not change. The list endpoint returns the list-wide counterpart, `{hints, certainty}`: `unknown` when a check the probe relies on cannot run here (no open-file check off Windows, process list off or unreadable), else `checked`. A row with no hint then shows "Can't tell if this chat is open elsewhere on this system" instead of the no-evidence text, which would overstate what was looked at. On Windows the checks normally all run, so the page is unchanged there.

## What was investigated and rejected

- **Exclusive-open or share-mode probing of the transcript** (`CreateFile` with share mode 0, `msvcrt.locking`): it would take a real handle on a file another client may be about to append to, and a writer that hits the sharing violation can fail or drop a record. Not side-effect free, so not used; the Restart Manager query replaces it.
- **PowerShell `Get-CimInstance`** for the process list: works (about 0.3 s per call here) but is slower and spawns a process on every probe; replaced by `ctypes`, kept as a fallback.
- **Network ports, window titles, lock files of other products:** no stable, documented source and no way to tie them to a session.
- **Treating "known agent client running" as per-conversation evidence in the sidebar:** it would mark every conversation in a folder.

## Not implemented (design only)

- **Protocol-level ownership** (`_meta.owner` in `session/list`, a defined rejection of a second `session/load`). ACP v1 has none and no adapter ships one. It remains the preferred long-term home because it would work across machines and enforce server-side. Studio should read it when an adapter advertises it.
- **Writers other than Studio** (Devin, VS Code extensions, CLI wrappers): the format is published here but nobody else writes it yet.
- **Take-over flow for stale announcements** with a `replaced` log entry. A stale claim currently produces the ordinary "Continue anyway" confirmation and is left in place.
- **Cross-machine and cross-user detection**; non-Windows process inspection is a best-effort `/proc` reader and is untested.
- **Detecting an idle session** held open by a client that never writes or announces. Nothing on this machine exposes it. This is the main remaining gap, and why `no_evidence` is worded as it is.

## Security and privacy

- Evidence is advisory input to a UI decision. Nothing here reads or writes session transcripts, kills processes, or takes a lock on another client's files.
- Reading another process's command line and working directory uses `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` on same-user processes. Security software may log that access; elevated or other-user processes are reported as "could not be inspected".
- The owners folder holds no prompt or transcript text. Its contents are untrusted input.
- Studio's own announcement files use the default per-user folder permissions.

## Open questions

- Whether the Devin integration can be changed to publish announcements.
- Whether a shared network drive is ever used for the home directory (the hostname check makes such announcements informational).
