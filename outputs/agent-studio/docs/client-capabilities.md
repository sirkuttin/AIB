# Client capabilities (terminal and files)

Agent Studio normally tells every agent: "I offer no terminal and no file access; use your own tools." That is still the default. Two opt-in switches let agents ask Studio to do these things instead. Both are **off** unless you start Studio with the flag.

| Flag | What it allows |
| --- | --- |
| `--enable-client-terminal` | Agents may start, read, wait for, kill and release commands (`terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`). |
| `--enable-client-fs` or `--enable-client-fs=readwrite` | Agents may read and write text files (`fs/read_text_file`, `fs/write_text_file`). |
| `--enable-client-fs=read` | Read-only. Studio advertises `writeTextFile: false`; write requests get the normal "capability not advertised" error. |

Without a flag, the matching requests receive the same JSON-RPC error as before ("Client capability not advertised") and the capability stays `false` in the initialize request. The flags apply to every conversation that server opens. Restart Studio (on a spare port first) to change them.

## What is enforced

**Files**
- Paths must be absolute. Studio resolves them with `os.path.realpath`, which follows symlinks and Windows junctions, and then requires the result to be inside the conversation's workspace folder. `..` tricks, other drives, symlinks or junctions that point out of the workspace all fail.
- Rejected outright: UNC paths (`\\server\share`), `\\?\` and `\\.\` prefixes, alternate data streams (`file.txt:stream`), Windows device names (`NUL`, `CON`, `COM1` ...) and names ending in a dot or space.
- Reads: at most 2 MiB come back. Larger files need `line` and `limit`. Binary files (NUL bytes) are refused.
- Writes: at most 8 MiB. Studio writes to a temporary file in the same folder and then replaces the target, so a failed write never leaves half a file. Missing parent folders are created, but only inside the workspace. Writing anywhere inside a `.git` folder is refused (it would allow planting hooks).
- Every write is recorded as a `client_fs` event and shown in the Activity pane ("Client access" box) with its path and byte count.

**Terminals**
- Commands run as an argument list with `shell=False`. Nothing is passed through a shell, so `;`, `&`, `$()` and quotes in arguments are plain text. `.bat` and `.cmd` files are refused because Windows would hand them to `cmd.exe`.
- The working directory must resolve inside the workspace (default: the workspace itself).
- The process gets a minimal environment (PATH, system folders, temp folders and similar) plus only the variables the agent lists in `env`. Studio's own environment, including any tokens, is not passed on.
- Output is kept up to `outputByteLimit` (the oldest bytes are dropped first, `truncated` is reported), and never more than 4 MiB regardless of the request. Up to 8 terminals per conversation.
- Processes are killed (with their child processes) on `terminal/release`, when the conversation closes or its agent disconnects, and when Studio shuts down. When the conversation's agent runs in the keeper, its terminals run there too and keep running through an AIB restart or update; the next AIB answers `terminal/output`, `wait_for_exit`, `kill` and `release` from the same process (agent-host.md, "Client terminals in the keeper"). The Activity pane lists each live terminal: command, folder, status, exit code and the last part of its output.

## Risks, in plain language

- **The workspace boundary is not a sandbox for commands.** A terminal command runs as you. The folder check controls where it starts, not what the program does: `python script.py` can read or delete anything you can. Enable the terminal only for agents and tasks you would trust to run commands on your machine. Studio's own permission prompts do not cover these client requests, because the agent is asking Studio, not its own tool system.
- **File writes need no per-write approval.** Within the workspace, a write replaces the file silently (you only see it afterwards in the Activity pane). Use `=read` if you only want the agent to read. Keep important work in git or backed up.
- **Paths can change between the check and the use** (for example if another program swaps a folder for a link at that exact moment). That is a narrow race, not a normal attack path.
- **Output and file contents are untrusted.** The UI shows them as plain text only.
- Enabling these makes some agents prefer Studio's terminal and file tools over their own, which can change how they behave compared with running them in other clients.

## Trying it safely

Use a spare port and a throwaway state folder, for example:

```
python outputs/agent-studio/studio.py --port 8796 --state-dir work/caps-fixture/state --enable-client-fs=read
```

Do not restart a server you are using for a live conversation just to try this.

## Tests

`python -m unittest work/test_client_caps.py` covers disabled-by-default behaviour, path escapes (including a junction), output limits, kill/release and close cleanup, and read-only mode, using the deterministic fake agent (`work/fake_acp.py --client-caps`). `node --test work/test_terminals_ui.js` checks the UI renders untrusted text safely. `work/test_real_adapters.py` is a separate opt-in suite against the real OMP and Claude adapters (it uses real model usage; see its docstring).
