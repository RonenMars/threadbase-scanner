# Claude Code Conversation JSONL Format

> Derived from direct inspection of `~/.claude/projects/` on a live installation (Claude Code v2.1.83–v2.1.116) and the `@threadbase/scanner` parser that reads these files. No third-party sources consulted — all observations are from the actual binary artefacts written by Claude Code on macOS.

---

## 1. Storage Layout

Claude Code stores every conversation as a single JSONL file (one JSON object per line, `\n`-delimited) under:

```
~/.claude/projects/<project-dir>/<session-uuid>.jsonl
```

### Project directory naming

The directory name is the absolute `cwd` path with every `/` replaced by `-`, then the leading `-` stripped:

| cwd | directory name |
|-----|---------------|
| `/Users/alice/Desktop/dev` | `-Users-alice-Desktop-dev` |
| `/tmp` | `-private-tmp` (macOS symlink resolved) |

Each unique `cwd` value gets its own directory. Running Claude Code from `/Users/alice` and from `/Users/alice/Desktop/dev` produces **two separate directories**.

### File naming

The JSONL filename is a UUID v4 that Claude Code generates when the session starts. It is the canonical session identifier and matches the `sessionId` field inside every entry.

### Special subdirectories

| Path | Contents |
|------|----------|
| `<project-dir>/subagents/` | JSONL files for subagents spawned during a conversation (flat list; also appears under `<project-dir>/<session-uuid>/subagents/` for worktree-scoped sessions) |
| `<project-dir>/tool-results/` | Opaque result artefacts (binary blobs, persisted stdout) — **not** JSONL; excluded from scanning |
| `<project-dir>/memory/` | Markdown memory files written by the claude-mem plugin — **not** JSONL; excluded from scanning |
| `<project-dir>/<session-uuid>/subagents/` | Per-session subagent JSONL files, each paired with a `<name>.meta.json` describing agent type and description |

---

## 2. Entry Types (top-level `type` field)

Every line is a JSON object. The `type` field determines the schema. Claude Code writes six distinct types:

| `type` | Description |
|--------|-------------|
| `user` | A message turn originating from the user side (human prompt or tool result) |
| `assistant` | A message turn from the model (text, tool calls, thinking blocks, streamed) |
| `system` | Internal Claude Code housekeeping events |
| `file-history-snapshot` | Snapshot of file backups tracked by the file-history feature |
| `last-prompt` | One-liner written at session end containing the final user prompt text |

### Common fields on `user` and `assistant` entries

| Field | Type | Present on | Notes |
|-------|------|-----------|-------|
| `type` | `"user"` \| `"assistant"` | always | |
| `uuid` | UUID string | always | Unique ID for this entry |
| `parentUuid` | UUID string \| `null` | always | UUID of the preceding entry; `null` for the first entry in a session |
| `isSidechain` | boolean | always | `true` when this entry belongs to a subagent conversation |
| `sessionId` | UUID string | always | Matches the filename (minus `.jsonl`) |
| `timestamp` | ISO 8601 string | always | Wall-clock time the entry was written |
| `cwd` | string | always | Absolute working directory of the Claude Code process |
| `version` | string | always | Claude Code CLI version string, e.g. `"2.1.116"` |
| `entrypoint` | string | always | How Claude Code was launched: `"cli"`, `"claude-vscode"`, `"sdk-cli"` |
| `userType` | string | always | Always `"external"` in observed data |
| `gitBranch` | string | most | Current git branch or `"HEAD"` when detached |
| `slug` | string | appears after first full turn | Human-readable session name (`"jiggly-questing-shannon"`); absent on early entries, added retroactively once generated |
| `message` | object | always | The Anthropic API message object (see §3) |

### Additional fields on `user` entries only

| Field | Type | Notes |
|-------|------|-------|
| `promptId` | UUID string | Groups the logical user prompt that triggered this turn; shared by the triggering user message and any subsequent tool-result user messages in the same prompt/response cycle |
| `permissionMode` | string | Active permission mode: `"auto"`, `"default"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`, `"plan"` |
| `isMeta` | boolean | `true` on synthetic user messages injected by Claude Code (local-command caveats, system-reminder injections) — these are **not** actual user prompts |
| `toolUseResult` | object \| true | Present when this user entry is a tool result; contains `{ stdout, stderr, interrupted, isImage, noOutputExpected }` for Bash-style results, or just `true` for other tools |
| `sourceToolAssistantUUID` | UUID string | UUID of the assistant entry whose tool call this entry is responding to |

### Additional fields on `assistant` entries only

| Field | Type | Notes |
|-------|------|-------|
| `requestId` | string | Anthropic API request ID (`req_0…`). Multiple consecutive assistant entries share the same `requestId` when a single API call produces multiple streamed output chunks (thinking block + text block + tool call blocks each become their own entry). |
| `agentId` | hex string | Present in subagent files only; identifies the subagent instance |

---

## 3. The `message` Object

For `user` and `assistant` entries, `message` mirrors the Anthropic Messages API message format.

### User message (human prompt)

```json
{
  "role": "user",
  "content": "Is cloudflared tunnel running now?"
}
```

Content is a bare string for simple text prompts.

### User message (structured / multi-part)

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Here is the screenshot:" },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/jpeg",
        "data": "<base64 string>"
      }
    }
  ]
}
```

An alternative image form using a `file` wrapper (observed when Claude Code uses its own file-history/cache artefact):

```json
{
  "type": "image",
  "file": {
    "base64": "<base64 string>",
    "type": "image/jpeg",
    "originalSize": 123456
  }
}
```

### User message (tool result)

When Claude Code returns a tool result to the model, it writes a `user` entry containing `tool_result` blocks:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01X52imu23YsuD1TnbKBzMcm",
      "content": "not running",
      "is_error": false
    }
  ]
}
```

The corresponding top-level `toolUseResult` field holds the raw stdout/stderr detail:

```json
"toolUseResult": {
  "stdout": "not running",
  "stderr": "",
  "interrupted": false,
  "isImage": false,
  "noOutputExpected": false
}
```

### Assistant message

```json
{
  "model": "claude-sonnet-4-6",
  "id": "msg_01UXk3meXwNhjmJtdpsY1DEx",
  "type": "message",
  "role": "assistant",
  "content": [ ... ],
  "stop_reason": "end_turn" | "tool_use" | "stop_sequence" | null,
  "stop_sequence": null,
  "stop_details": null,
  "usage": {
    "input_tokens": 1,
    "cache_creation_input_tokens": 210,
    "cache_read_input_tokens": 54731,
    "output_tokens": 374,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 210,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "iterations": [],
    "speed": "standard"
  }
}
```

`stop_reason` is `null` on intermediate streamed chunks and `"end_turn"` / `"tool_use"` / `"stop_sequence"` on the final chunk for that API request.

---

## 4. Content Block Types (inside `message.content`)

### Text block

```json
{ "type": "text", "text": "Of course! How can I help?" }
```

### Thinking block (extended thinking / interleaved thinking)

```json
{
  "type": "thinking",
  "thinking": "",
  "signature": "EoMCClsIDBgC..."
}
```

The `thinking` field contains the model's internal reasoning text. When extended thinking is enabled but redacted, `thinking` is an empty string and `signature` carries a cryptographic proof-of-thinking token. Each thinking block becomes its own separate `assistant` entry in the JSONL (same `requestId` as the text/tool-use entries that follow it).

### Tool use block (assistant requesting a tool call)

```json
{
  "type": "tool_use",
  "id": "toolu_01X52imu23YsuD1TnbKBzMcm",
  "name": "Bash",
  "input": {
    "command": "pgrep -x cloudflared && echo running || echo not running",
    "description": "Check if cloudflared process is running"
  },
  "caller": { "type": "direct" }
}
```

`caller.type` distinguishes between `"direct"` (first-class Claude Code tools like Bash, Read, Edit) and MCP-proxied tools.

### Tool result block (user side, see §3 above)

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01X52imu23YsuD1TnbKBzMcm",
  "content": "not running",
  "is_error": false
}
```

---

## 5. Streaming — How One API Response Becomes Multiple Entries

Claude Code does **not** buffer the complete API response before writing. Each chunk of the stream creates a new `assistant` entry in the JSONL. A single API call with thinking + text + tool use produces at minimum three entries, all sharing the same `requestId`:

```
assistant  uuid=A  requestId=req_X  content=[{thinking block}]  stop_reason=null
assistant  uuid=B  requestId=req_X  content=[{text block}]       stop_reason=null
assistant  uuid=C  requestId=req_X  content=[{tool_use block}]   stop_reason="tool_use"
```

Each entry's `parentUuid` points to the previous entry, forming a singly-linked list. The final entry in the chain carries the terminal `stop_reason`.

---

## 6. Parent-UUID Chain (Message Graph)

Every entry has a `parentUuid` that points to the UUID of the entry immediately before it. This forms a linked list that represents the conversation history in order, not the flat line order of the file. The first entry in a session always has `parentUuid: null`.

```
system(uuid=S0, parentUuid=null)
  └─ user(uuid=U1, parentUuid=S0)
       └─ assistant(uuid=A1, parentUuid=U1)         ← thinking chunk
            └─ assistant(uuid=A2, parentUuid=A1)    ← tool_use chunk
                 └─ user(uuid=U2, parentUuid=A2)    ← tool_result
                      └─ assistant(uuid=A3, parentUuid=U2)
                           └─ system(uuid=SH, parentUuid=A3)   ← stop_hook_summary
                                └─ system(uuid=ST, parentUuid=SH)  ← turn_duration
                                     └─ user(uuid=U3, parentUuid=ST)
```

`promptId` is a separate grouping key: all entries belonging to one logical user-initiated prompt share the same `promptId` (the initial user message and all tool-result messages in its response cycle).

---

## 7. `system` Entry Subtypes

System entries (`"type": "system"`) carry a `subtype` field:

### `bridge_status`

Written as the very first entry of a session when Claude Code's remote-control bridge is active. Contains `content` (a human-readable status line) and `url` (the session URL). Has `isMeta: false`.

```json
{
  "type": "system",
  "subtype": "bridge_status",
  "content": "/remote-control is active. Code in CLI or at https://claude.ai/code/session_...",
  "url": "https://claude.ai/code/session_...",
  "isMeta": false,
  ...
}
```

### `stop_hook_summary`

Written after each assistant turn completes and the Stop hooks have run. Records which hooks ran, their durations, any errors, and whether a hook prevented Claude from continuing.

```json
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 4,
  "hookInfos": [
    { "command": "~/.claude/hooks/...", "durationMs": 6160 }
  ],
  "hookErrors": [],
  "preventedContinuation": false,
  "stopReason": "",
  "hasOutput": false,
  "level": "suggestion",
  "toolUseID": "277aab6d-..."
}
```

### `turn_duration`

Written at the end of a turn, records the total wall-clock time and message count for that turn.

```json
{
  "type": "system",
  "subtype": "turn_duration",
  "durationMs": 37985,
  "messageCount": 15,
  "isMeta": false
}
```

---

## 8. `file-history-snapshot` Entries

Claude Code tracks file edits for undo purposes. Before a user prompt is processed, it writes a snapshot entry:

```json
{
  "type": "file-history-snapshot",
  "messageId": "<uuid of the user message>",
  "snapshot": {
    "messageId": "<uuid>",
    "trackedFileBackups": {
      ".cloudflared/config.yml": {
        "backupFileName": "a8a4fd74752758d6@v1",
        "version": 1,
        "backupTime": "2026-04-08T05:08:36.917Z"
      }
    },
    "timestamp": "2026-04-08T05:06:03.636Z"
  },
  "isSnapshotUpdate": false
}
```

`isSnapshotUpdate: true` means this line updates an existing snapshot (e.g. a new file version was created mid-turn). The actual backup files live in the `tool-results/` subdirectory.

---

## 9. `last-prompt` Entry

Written at session end (when Claude Code exits or the session is terminated). Contains only the text of the last user prompt:

```json
{
  "type": "last-prompt",
  "lastPrompt": "Start it in the background",
  "sessionId": "00f1ac94-7d7c-4063-9a1a-db3208e9301a"
}
```

This entry has no `uuid`, `timestamp`, `cwd`, or `parentUuid` — it is purely a convenience index for surfacing recent sessions.

---

## 10. Subagent Conversations

When Claude Code spawns an agent (via the `Agent` tool), the subagent's conversation is written to a separate JSONL file:

**Path**: `<project-dir>/subagents/agent-<hex-id>.jsonl`  
(or `<project-dir>/<session-uuid>/subagents/agent-<hex-id>.jsonl` for per-session isolation)

A companion `.meta.json` file records the agent configuration:

```json
{ "agentType": "general-purpose", "description": "Re-scan all git repos…" }
```

Entries inside a subagent JSONL are identical in schema to normal entries, with two differences:

- `isSidechain: true` on every entry
- `agentId: "<hex-id>"` on every entry (matches the hex suffix in the filename)
- The `sessionId` is the **parent** session's UUID (not a new one)
- `cwd` is the parent session's working directory

The first entry always has `parentUuid: null` and its `message.content` is the task prompt passed to the agent.

---

## 11. Team/Teammate Conversations

When running in an Agent Teams configuration, the `teamName` field appears on entries:

```json
{
  "type": "user",
  "teamName": "backend-team",
  "message": {
    "role": "user",
    "content": "<teammate-message teammate_id=\"agent-1\" summary=\"Fix auth\" color=\"blue\">Please fix the auth module</teammate-message>"
  }
}
```

Teammate messages are wrapped in a `<teammate-message>` XML tag with attributes:

| Attribute | Meaning |
|-----------|---------|
| `teammate_id` | Identifier of the sending teammate |
| `summary` | Short description shown in the UI |
| `color` | Display color for the teammate's bubble |

The scanner strips `<teammate-message>` (and other system XML tags) when building preview/search text. The full list of stripped tag names is: `system-reminder`, `command-name`, `command-message`, `command-args`, `ide_selection`, `ide_opened_file`, `local-command-stdout`, `local-command-caveat`, `retrieval_status`, `task_id`, `task_type`, `task-id`, `task-notification`, `fast_mode_info`, `persisted-output`, `tool_use_error`, `user-prompt-submit-hook`, `thinking`, `ask_user`, `teammate-message`.

---

## 12. `isMeta` Flag

When Claude Code injects a synthetic user message (not typed by the user), it marks the entry `isMeta: true`. Examples:

- The local-command caveat injected before local-command output
- System-reminder messages injected by hooks

Both the `@threadbase/scanner` parser and Claude Code's own conversation reconstruction skip `isMeta: true` entries when rebuilding the message history to send to the model.

---

## 13. Attachment Sidecar Field

Some entries carry an `attachment` object at the top level (parallel to `message`, not inside it). This is used by Claude Code plugins that need to ship structured data alongside the message without polluting the Anthropic API payload. Observed subtype:

```json
"attachment": {
  "type": "deferred_tools_delta",
  "addedNames": ["AskUserQuestion", "CronCreate", ...],
  "addedLines": [...],
  "removedNames": []
}
```

This records which deferred tools were added or removed at this point in the conversation (the `ToolSearch`/deferred-tool mechanism).

---

## 14. Discovery and Exclusion Rules

When the scanner walks `~/.claude/projects/`, it applies these rules:

1. Recursively glob `**/*.jsonl` from the `projects/` root.
2. **Exclude** any path containing `/memory/` — these are markdown files, not conversations.
3. **Exclude** any path containing `/tool-results/` — these are binary/text artefacts.
4. **Exclude** empty files (0 bytes).
5. Subagent files (paths containing `/subagents/`) are included but classified separately: `isSubagent: true` and `parentSessionId` is set to the parent JSONL path.

---

## 15. Entry Ordering Guarantee

Entries are appended to the file in the order they are written. The file is **append-only** — Claude Code never rewrites existing lines. Because streaming produces multiple entries per API call, the file-line order is effectively the temporal order of events. The `parentUuid` chain is the authoritative conversation order and may differ from file-line order only if the OS reorders concurrent writes (not observed in practice).

---

## 16. Encoding and Format Rules

- Encoding: UTF-8, no BOM.
- Line separator: `\n` (LF). The readline interface is opened with `crlfDelay: Infinity` to handle `\r\n` on Windows.
- Each line is a complete, self-contained JSON object. Lines that fail `JSON.parse` are silently skipped.
- Blank lines (whitespace only) are silently skipped.
- No trailing comma between lines (JSONL is not JSON array syntax).
- Unicode characters (emoji, CJK, etc.) appear as raw UTF-8 in the JSON string values — no escaping beyond what JSON requires.

---

## 17. Schema Quick Reference

```
<session>.jsonl
│
├─ [system]              type, subtype, uuid, parentUuid, isSidechain, isMeta, ...
├─ [file-history-snapshot]  type, messageId, snapshot{messageId, trackedFileBackups{}, timestamp}, isSnapshotUpdate
├─ [user]                type, uuid, parentUuid, isSidechain, promptId, permissionMode,
│                        isMeta?, toolUseResult?, sourceToolAssistantUUID?,
│                        message{role, content: string | ContentBlock[]},
│                        sessionId, timestamp, cwd, version, entrypoint, userType, gitBranch, slug?
├─ [assistant]           type, uuid, parentUuid, isSidechain, requestId, agentId?,
│                        message{model, id, type, role, content: ContentBlock[],
│                               stop_reason, stop_sequence, stop_details, usage{...}},
│                        sessionId, timestamp, cwd, version, entrypoint, userType, gitBranch, slug?
└─ [last-prompt]         type, lastPrompt, sessionId

ContentBlock (user side):
  { type: "text", text: string }
  { type: "image", source: { type: "base64", media_type: string, data: string } }
  { type: "image", file: { base64: string, type: string, originalSize: number } }
  { type: "tool_result", tool_use_id: string, content: string, is_error: boolean }

ContentBlock (assistant side):
  { type: "text", text: string }
  { type: "thinking", thinking: string, signature: string }
  { type: "tool_use", id: string, name: string, input: object, caller: { type: string } }
```
