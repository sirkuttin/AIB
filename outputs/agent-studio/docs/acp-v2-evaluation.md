# ACP v2 evaluation for Agent Studio

Date: 2026-11-07. Studio implements **v1 only** and this document recommends keeping it that way for now. Nothing in v2 has been implemented.

## Status of v2

- v2 is published as a **Draft**. The first draft was announced 2026-07-20 ([announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)); the schema package is at `schema-v2.0.0-alpha.13` (2026-11-02, marked pre-release) while v1 continues to ship regularly (`schema-v1.29.1`, 2026-11-02). The migration guide itself says to "gate v2 support behind explicit version negotiation and feature flags until it stabilizes" and not to drop v1.
- Sources: the `agent-client-protocol` repository (`docs/protocol/v2/migration.mdx`, `docs/protocol/v2/initialization.mdx`, releases list) and agentclientprotocol.com/protocol/v2.

## What changes in v2 (breaking, from the official migration guide)

1. **Prompt lifecycle.** The `session/prompt` response only acknowledges that the prompt was accepted. Progress and completion (including stop reason and failures after acceptance) arrive as `state_update` notifications with states `running`, `idle`, `requires_action`. Cancellation completion is also reported through `state_update`; prompts not yet inserted get `-32800`.
2. **Upsert semantics for updates.** Messages and tool calls are patched by ID (omitted = unchanged, `null` = cleared, value = replaced, chunks append). `messageId` is required on message chunks; new whole-message variants (`user_message`, `agent_message`, `agent_thought`); `tool_call` is removed (first `tool_call_update` creates it); new `tool_call_content_chunk`; `plan` becomes `plan_update` with a `planId`.
3. **Removed client APIs.** `fs/read_text_file`, `fs/write_text_file`, all `terminal/*` methods, `session/set_mode` and `current_mode_update` (modes become config options). New display-only `terminal_update` / `terminal_output_chunk` for agent-owned terminals. Agents needing client-side tools use client-provided MCP servers.
4. **Session methods.** `session/load` is removed in favor of `session/resume` with `replayFrom`; `session/resume`, `session/list`, `session/close` are required baseline (no capability flags); `session/delete` stays optional.
5. **Initialize restructuring.** `capabilities` and a required `info` on both sides (replacing `clientCapabilities`/`clientInfo`/`agentCapabilities`/`agentInfo`); support markers are objects instead of booleans; session-scoped capabilities nested under `session`. New error `-32022` for unsupported versions.
6. **Auth.** `authenticate` -> `auth/login`, `logout` -> `auth/logout`, both mandatory when `authMethods` is non-empty.
7. **Forward compatibility.** Nearly all enums and tagged unions accept unknown values; `_`-prefixed values are for extensions. Request IDs can no longer be `null`; no JSON-RPC batches. `session/request_permission` params restructured (required `title`, optional `subject`); `elicitation/*` essentially unchanged.
8. **Negotiation.** The client sends the highest version it supports; an agent picks the highest it supports at or below that. A v1-only agent may answer `protocolVersion: 1`, and the client then continues on v1 or disconnects. A v1 agent reading a v2 initialize loses the v1 `clientCapabilities` (fs/terminal/terminal auth), so a client that needs them must reconnect with a v1 initialize.

## Impact on Studio

| Area | Effort | Notes |
| --- | --- | --- |
| Version negotiation / `initialize` | small | New request shape and capability reading; keep the v1 path. |
| Turn lifecycle (`Connection.prompt`, busy state, receipts, cancel) | large | Studio currently equates "prompt response" with "turn finished" (`busy`, `turn_end`, prompt receipts, stop reasons). v2 needs a state machine driven by `state_update`, including `requires_action` and agent-initiated work. This is the core change. |
| Update handling in `read()` and `chat.js` | large | Upsert/patch merging for messages, tool calls, plans; replay semantics; new terminal display. The tool and plan views are being redesigned in milestone 3 anyway. |
| Sessions | medium | `resume` with `replayFrom` replaces `load`; `session/list` becomes baseline (aligns with the planned protocol-native discovery). |
| Modes | small | Fold modes into config options. |
| fs / terminal | none | Studio has them disabled; the removal costs nothing. |
| Auth | medium | Overlaps with the pending authentication work; build that against the v1 `authenticate` first, then rename. |
| Validation (`acp_schema.py`) | medium | A second set of validators selected by the negotiated version; the v2 schema is `schema/v2/schema.json`. |
| Tests | medium | The fixture agent needs a `--v2` mode; `test_conformance.py` already has negotiation scaffolding. |

## Adapter support (as far as can be determined)

- **Claude (`@agentclientprotocol/claude-agent-acp`)**: ships an experimental, opt-in v2 server (release 0.95.0, 2026-10-23, with v2 fixes in 0.99.0 per its [releases page](https://github.com/agentclientprotocol/claude-agent-acp/releases)). A client that requests `protocolVersion >= 2` gets v2; a v1 request gets v1. Its README notes a v2-only mode that rejects v1 initialize, so a v1 client such as Studio must not be pointed at a v2-only configuration.
- **OMP**: no public statement about v2 was found. Treat as v1 only. Studio could not verify this without launching the real adapter, which was out of scope.
- General: v1 remains the default across the ecosystem; the spec authors explicitly expect v1-only peers "for some time".

## Recommendation

1. **Do not implement v2 now.** It is a Draft/alpha, the highest-impact change (prompt lifecycle) would rewrite the turn state machine that milestone 2 to 4 work is still building on, and the adapters Studio targets work on v1.
2. **Keep v1 and keep negotiating strictly.** Studio already sends `protocolVersion: 1` and rejects anything else, which is the safe behavior: adapters downgrade to v1 for v1 clients.
3. **Prepare cheaply.** (a) Keep turn-state logic behind `Connection` so a `state_update` driver can replace the prompt-response driver; (b) do not add new features that depend on removed v1 APIs (fs, terminal, set_mode) beyond what is already planned; (c) prefer `session/list` and config options for new work, since v2 makes them baseline; (d) `acp_schema.py` already tolerates unknown update kinds and unknown enum values, matching v2's forward-compatibility rule.
4. **Revisit when** v2 leaves Draft (a non-alpha `schema-v2.x` release) and at least one adapter Studio users run defaults to v2 or drops v1. Then add v2 as a per-connection negotiated mode behind a flag, with the v1 path kept.
