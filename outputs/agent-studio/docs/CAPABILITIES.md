# Agent Studio: ACP v1 capability matrix

Studio speaks **ACP protocol version 1** only (`initialize` sends `protocolVersion: 1`; any other negotiated version is rejected). Reference: [agentclientprotocol.com](https://agentclientprotocol.com) and `schema.json` from the `agent-client-protocol` repository (schema-v1.29.x checked 2026-11-07). Source of truth for Studio's behavior is `studio.py` (`Connection`); incoming messages are checked by `acp_schema.py`.

Status values: **supported**, **partial**, **not supported**, **deliberately disabled** (advertised as off so agents do not call it), **in progress** (another work package is adding it; see `TRACKER.md`).

## Capabilities Studio advertises (`initialize` -> `clientCapabilities`)

| Capability | Sent | Status | Notes |
| --- | --- | --- | --- |
| `fs.readTextFile` / `fs.writeTextFile` | `false` / `false` | deliberately disabled | Studio does not expose the workspace to agents through the client; agents use their own file access. See TRACKER milestone 5 (optional filesystem with access boundaries). |
| `terminal` | `false` | deliberately disabled | No ACP terminal lifecycle yet (TRACKER milestone 4). |
| `elicitation.form` | `{}` | supported | Form mode, request- and session-scoped; schema and typed answers validated by `elicitation.py`. |
| `elicitation.url` | not sent | in progress - see tracker | URL elicitation is rejected with -32602 until implemented. |
| `subagents` | `{}` | partial | Non-standard extension some adapters use; Studio tracks subagent session IDs and reads `subagent_update` / `session_message` updates. Not part of ACP v1. |
| `auth.*` / `positionEncoding` etc. | not sent | not supported | Authentication capabilities in progress - see tracker. |

## Agent methods (Studio is the caller)

| Method | Status | Notes |
| --- | --- | --- |
| `initialize` | supported | Version must equal 1 (otherwise setup fails with a clear error). Result is schema-checked; `agentCapabilities.loadSession` and `promptCapabilities.image` are honored. `authMethods`, `agentInfo`, other capability groups are read but unused. |
| `authenticate` / `logout` | in progress - see tracker | Authentication discovery and sign-in flows are a milestone 2 item. |
| `session/new` | supported | `cwd` and empty `mcpServers`. Result must carry a non-empty `sessionId`; `modes` and `configOptions` are stored as settings. |
| `session/load` | supported | Used to continue saved conversations; requires `agentCapabilities.loadSession`, otherwise refused. History replay arrives as normal `session/update` notifications. |
| `session/resume`, `session/close`, `session/delete` | not supported | Not gated on `sessionCapabilities`; Studio never sends them. |
| `session/list` | in progress - see tracker | Protocol-native session discovery; today Studio discovers saved sessions from local transcripts (`monitor.py`). |
| `session/prompt` | supported | Text plus attachments: up to 4 images (PNG/JPEG/GIF/WebP, `promptCapabilities.image`) and up to 8 files, mapped as in "Prompt content blocks" below (20 MiB total). One turn at a time; duplicate client message IDs are deduplicated. Result `stopReason` is validated (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`; unknown strings are tolerated with a logged warning). |
| `session/cancel` (notification) | supported | Pending permission requests are answered with outcome `cancelled` first, then `session/cancel` is sent; pending session-scoped elicitations are answered `cancel`. The agent is expected to end the turn with `stopReason: cancelled` (verified against the conformance fixture). A permission request that arrives after the cancel is not auto-cancelled (gap). |
| `session/set_mode` | supported | Mode picker from `modes.availableModes`; `current_mode_update` keeps it in sync. |
| `session/set_config_option` | partial | Select-style options from `configOptions` are settable; result `configOptions` replaces the stored list. Boolean/other option types: more configuration types are on the TRACKER. |
| `$/cancel_request` (notification) | partial | Received from the agent: withdraws the matching pending permission/elicitation UI. Studio never sends it. |

## Client methods (the agent calls Studio)

| Method | Status | Notes |
| --- | --- | --- |
| `session/request_permission` | supported | Shape validated (`sessionId`, `toolCall.toolCallId`, `options[]` with `optionId`/`name`/`kind`); malformed requests get JSON-RPC -32602. Answers: `selected` + optionId, or `cancelled` (turn cancel, `$/cancel_request`, close). Connection loss clears pending approvals. |
| `elicitation/create` | partial | Form mode only (see above). URL mode and unknown modes get -32602. |
| `elicitation/complete` (notification) | in progress - see tracker | Logged as a notice; tied to URL elicitation. |
| `fs/read_text_file`, `fs/write_text_file` | deliberately disabled | Agent receives -32601 "Client capability not advertised". |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | deliberately disabled | Same -32601 reply. |
| Unknown methods with an `id` | supported | Answered with -32601; unknown notifications are logged as `notice` events. |

## `session/update` variants (agent -> Studio)

All variants are schema-checked for their required fields and types; wrong-typed or session-less updates are dropped and reported as a `protocol` error event. Unknown `sessionUpdate` values are kept in history and reported once per kind.

| `sessionUpdate` | Status | Notes |
| --- | --- | --- |
| `user_message_chunk` | supported | Replay of history on `session/load`; shown as user text (and images). |
| `agent_message_chunk` | supported | Streamed assistant text and images. Audio, resource links, and embedded resources are stored but not rendered (rich content: in progress - see tracker). |
| `agent_thought_chunk` | supported | Shown as "Thinking" (toggle). |
| `tool_call`, `tool_call_update` | partial | Merged by `toolCallId` and shown as raw JSON. Purpose-built tool, diff, and terminal-content views are on the TRACKER. |
| `plan` | supported | Rendered as a status list. |
| `available_commands_update` | in progress - see tracker | Stored in history; slash-command discovery/completion UI is being added. |
| `current_mode_update` | supported | Updates the stored mode. |
| `config_option_update` | supported | Replaces stored `configOptions`. |
| `session_info_update` | not supported | Stored in history only (session metadata is on the TRACKER). |
| `usage_update` | not supported | Stored in history only. |
| `notice` | not supported | Stored in history only. |
| `compaction_update`, `compaction_summary_chunk` | not supported | Stored in history only. |
| `subagent_update`, `session_message` (non-standard) | partial | Vendor extensions used to discover subagent sessions and delegation messages; tolerated as unknown kinds by the validator. |
| any other kind | tolerated | Logged once per kind; never rejected. |

## Prompt content blocks

| Block | Sent by Studio | Received and rendered |
| --- | --- | --- |
| `text` | yes | yes |
| `image` | yes (capability-gated) | yes (safe MIME types only) |
| `audio` | yes, for `audio/*` files only when `promptCapabilities.audio` is true | no |
| `resource` (embedded) | yes, for attached files only when `promptCapabilities.embeddedContext` is true | yes (collapsible) |
| `resource_link` | no | yes |

### File (non-image) attachments

Chosen with ＋ Attach, pasted, or dropped on the composer. Names are display-only labels: Studio never opens, reads or writes a path from them, and refuses names with path separators, `:`, `< > " | ? *`, control/invisible/direction characters, dot-only names or more than 200 characters. A file is **text** when its bytes are valid UTF-8 with no NUL bytes and its MIME type is text-like (`text/*`, JSON, XML, JavaScript, YAML, SQL, `+json`/`+xml`...), unknown (`''`/`application/octet-stream`) or its extension is a known text extension; a text MIME type with binary content is treated as binary, and `application/pdf`/archives are always binary. Everything else is **binary**; `audio/*` is **audio**. PNG/JPEG/GIF/WebP must be attached as images.

| Kind | `embeddedContext` advertised | not advertised |
| --- | --- | --- |
| text | `{type:"resource", resource:{uri, mimeType, text}}` | text block: `Attached file: NAME (TYPE, SIZE)` then the content in a code fence (fence longer than any backtick run in the file) |
| binary (PDF, ...) | `{type:"resource", resource:{uri, mimeType, blob}}` (base64) | refused in the composer and by the server, naming the file and `promptCapabilities.embeddedContext` |
| audio | `{type:"audio", mimeType, data}` if `audio` is advertised, otherwise an embedded `blob` resource | refused, naming `audio` and `embeddedContext` |

`uri` is `attachment:///N/NAME` (N = 1-based position among the files, NAME percent-encoded). It is an opaque identifier, not a file on disk, so agents are not invited to read a path. Block order in the prompt is typed text, files, images. Nothing is dropped silently: if any file cannot be sent the whole prompt is refused with every reason.

Limits (server-validated, mirrored in the browser): 8 files, 2 MiB per text file, 10 MiB per binary file, 20 MiB across images and files together (images keep 4 x 5 MiB, 15 MiB). The prompt request body cap is 30 MiB. The retry fingerprint covers typed text, each image, and each file's name, type, size and SHA-256, so a retry with any changed attachment cannot reuse a message ID. The `user` event keeps only a summary per file (name, type, size, how it was sent and the first 4,000 characters of text) so history stays bounded; sent files render as cards in the message, with text content expandable as plain text.

## Protocol robustness (all agent output)

| Behavior | Status |
| --- | --- |
| JSON-RPC envelope checks (`jsonrpc: "2.0"`, id types, exactly one of `result`/`error`, params object) | supported; violations logged as `error` events with `data.protocol = true` (capped at 25 per connection) |
| Non-JSON stdout lines | supported; logged and skipped |
| Malformed agent requests | supported; answered with -32600/-32602, never dispatched |
| Malformed responses to Studio requests (`initialize`, `session/new|load|prompt|set_mode|set_config_option`) | supported; the waiting call fails immediately with "Malformed ... response" instead of hanging or accepting bad data |
| Unknown or duplicate response IDs | supported; ignored and logged |
| Out-of-order responses | supported; matched by request ID |
| Agent exit mid-turn | supported; waiters released, approvals/elicitations cleared, lease released, `disconnected` event |
| Unknown future update kinds, content-block types, extra fields, `_meta` | tolerated |
| Optional fields with wrong types | tolerated (the spec marks them default-on-error) |

Tests: `work/test_conformance.py` (27 tests) against `work/fake_acp.py` flags `--cancel-aware`, `--malformed`, `--protocol-version`, `--bad-initialize`, `--bad-session`.
