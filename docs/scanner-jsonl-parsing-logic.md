# Scanner JSONL Parsing Logic

This document describes exactly how `@threadbase/scanner` reads and interprets Claude Code JSONL conversation files. It covers file discovery, line-by-line parsing, field extraction, content classification, and all decisions made during the two parsing modes (`parseMeta` and `parseConversation`).

---

## 1. File Discovery (`discovery.ts`)

The scanner uses `fast-glob` to find files. It accepts an array of `{ projectsDir, account }` pairs, where `projectsDir` is the Claude Code `projects/` folder (e.g. `~/.claude/projects/`).

**Glob pattern:** `**/*.jsonl`, with `dot: false` (dotfiles ignored) and `absolute: true` paths.

**Post-glob exclusions:** Any file path that contains `/memory/` or `/tool-results/` as a substring is dropped. This eliminates Claude's project-level memory files and cached tool outputs.

**Empty file filter:** After exclusion, every remaining path is `stat()`-ed. Files with `size === 0` are dropped.

**Output:** An array of `{ filePath, account }` where `account` is the profile ID (e.g. `"default"`).

---

## 2. Profile Resolution (`profiles.ts`)

Profiles are stored in `~/.config/threadbase-scanner/profiles.json` (default path). Each profile has:
- `id` — string identifier used as the `account` tag on every parsed conversation
- `label` — human-readable name
- `configDir` — root Claude config directory (e.g. `~/.claude`)
- `enabled` — if false, profile is skipped entirely
- `scanHistory` — if explicitly `false`, profile is skipped even when enabled
- `emoji`, `color` — optional display metadata

`getProjectsDir(profile)` computes `<resolvedConfigDir>/projects`.

If no profiles file exists, a single default profile is synthesized: `{ id: "default", configDir: ~/.claude }`.

---

## 3. Content Tiers (`tiers.ts`)

Before parsing, a `ContentTier` is resolved. Tiers control how much text is extracted during `parseMeta`:

| Tier | `previewMax` | `snippetMax` |
|------|-------------|--------------|
| `standard` (default) | 200 chars | 5,000 chars |
| `full` | 1,200 chars | 50,000 chars |

Custom tiers can be passed via `ScanOptions.tiers`. The tier determines:
- `preview` — the concatenated text of all messages, joined with spaces, hard-truncated at `previewMax`
- `contentSnippet` — per-message chunks accumulated up to `snippetMax` total chars; once the budget is spent, remaining messages are skipped. The snippet feeds the FlexSearch index.

---

## 4. JSONL Entry Format

Each line in a `.jsonl` file is a JSON object. Lines that are blank or unparseable are silently skipped. Malformed JSON does not abort parsing — the loop continues with the next line.

### Common top-level fields (present on most entries)

| Field | Type | Notes |
|-------|------|-------|
| `type` | `"user"` \| `"assistant"` \| other | Entries with any other type (e.g. system entries) are skipped entirely |
| `uuid` | string | Unique ID for this entry |
| `timestamp` | ISO 8601 string | Per-entry timestamp |
| `sessionId` | string | UUID identifying the session; matches the filename |
| `slug` | string | Human-readable session name; may appear only after the first complete turn |
| `cwd` | string | Absolute path to the project directory at session start |
| `message` | object | Contains `role`, `content`, optional `model`, `usage`, `stop_reason` |
| `isMeta` | boolean | If truthy, the entry is a synthetic/caveats message — **skipped in all parsing** |
| `toolUseResult` | truthy | Present on `user` entries that are tool result responses |
| `teamName` | string | Present when the session is part of a team/teammate workflow |
| `gitBranch` | string | Present on some entries; branch at time of entry |
| `version` | string | Claude Code version string |

### The `message` object

| Field | Type | Notes |
|-------|------|-------|
| `role` | `"user"` \| `"assistant"` | Matches entry `type` |
| `content` | string \| array | See §5 below |
| `model` | string | Only on assistant entries (e.g. `"claude-sonnet-4-20250514"`) |
| `usage` | object | Token counts; only on assistant entries |
| `stop_reason` | string \| null | Why the model stopped generating |

### Token usage fields inside `message.usage`

| Field | Extracted as |
|-------|-------------|
| `input_tokens` | `metadata.inputTokens` |
| `output_tokens` | `metadata.outputTokens` |
| `cache_read_input_tokens` | `metadata.cacheReadTokens` |
| `cache_creation_input_tokens` | `metadata.cacheCreationTokens` |

---

## 5. Content Block Types

`message.content` is either a plain string or an array of typed blocks.

### When content is a string

Treated as a single text block. `cleanSystemTags()` is applied to strip embedded XML-like system tags before use.

### When content is an array

Each element is classified by its `type` field:

| Block type | Parser action |
|------------|--------------|
| `"text"` | Extract `item.text`; apply `cleanSystemTags()` |
| `"tool_use"` | Extract `{ id, name, input }` into `ToolUseBlock`; `name` added to `toolNames` set; does **not** contribute to message text |
| `"tool_result"` | If `content` is a string, that string is extracted as text; contributes to `messageCount` and `firstMessage`/`lastMessage` only when part of a tool-result-only user entry |
| `"thinking"` | Extracted separately as `thinkingContent` (only in `parseConversation`, not in `parseMeta`) |

Blocks of any other type are silently ignored and contribute no text.

---

## 6. System Tag Stripping (`tags.ts`)

`cleanSystemTags(text)` is applied to every text string extracted from content. It:
1. Removes all occurrences of tags matching a fixed list using a single regex: `<tagname ...>...</tagname>`
2. Collapses multiple inline spaces to single spaces (preserving newlines)
3. Collapses 3+ consecutive newlines to 2
4. Trims leading/trailing whitespace

The stripped tag names are: `system-reminder`, `command-name`, `command-message`, `command-args`, `ide_selection`, `ide_opened_file`, `local-command-stdout`, `local-command-caveat`, `retrieval_status`, `task_id`, `task_type`, `task-id`, `task-notification`, `fast_mode_info`, `persisted-output`, `tool_use_error`, `user-prompt-submit-hook`, `thinking`, `ask_user`, `teammate-message`.

---

## 7. `parseMeta` — Lightweight Metadata Extraction

`parseMeta(filePath, account, tier)` reads the entire file line by line and accumulates:

### Session-level fields (extracted from the first occurrence)

- `cwd` — taken from the first entry that has it; becomes `projectPath`
- `sessionId` — first entry's `sessionId`; fallback: basename of the file without `.jsonl`
- `sessionName` (slug) — first entry's `slug`
- `teamName` — first entry's `teamName`
- `model` — extracted from `message.model` on the **first assistant entry**

### Timestamp tracking

`latestTimestamp` is updated on every entry: `max(entry.timestamp)` by string comparison. Fallback: `new Date().toISOString()`.

### Message counting rules

An entry counts as a message if any of the following is true:
- `extractTextContent(message.content)` returns a non-empty string
- Entry is a `"user"` type with `toolUseResult` truthy AND `message.content` consists **entirely** of `tool_result` blocks (`isOnlyToolResultContent` check)

`messageCount` increments for each qualifying entry. `lastMessageSender` is updated to the entry's `type` ("user" or "assistant").

### firstMessage / lastMessage snapshots

For entries where text content is non-empty (tool-result-only entries are excluded):
- `firstMessage` is set once to `{ text: content.slice(0, 200), timestamp: entry.timestamp }`
- `lastMessage` is updated on every qualifying entry (last wins)

### Preview and contentSnippet accumulation

Both are built only from entries with non-empty text:
- `previewParts` accumulates until `previewLength >= tier.previewMax`
- `snippetParts` accumulates chunks up to `tier.snippetMax` total chars; each chunk is truncated if it would exceed the remaining budget

Final `preview = previewParts.join(" ").slice(0, tier.previewMax)`.

### Tool name collection

Every `tool_use` block in any entry's content has its `name` added to a `Set<string>`. The final `toolNames` array is `Array.from(toolNameSet)`.

### Teammate detection

Checked once on the first `"user"` entry. If the text content contains the literal string `<teammate-message`, `isTeammate` is set to `true`.

### Subagent detection

`isSubagent = filePath.includes("/subagents/")`.

If subagent, `parentSessionId` is computed as the file path of the parent session's JSONL:
```
parentSessionId = join(dirname(dirname(dirname(filePath))), basename(dirname(dirname(filePath))) + ".jsonl")
```

i.e., two levels up from the subagent file, then the directory name at that level + `.jsonl`.

### When parseMeta returns null

Returns `null` if `messageCount === 0` after processing all lines, or if any unhandled exception is thrown during line iteration.

### Git branch enrichment (in scanner.ts)

After `parseMeta` returns, the scanner calls `readGitBranch(meta.projectPath)` and attaches the result to `meta.gitBranch`. This is **not** done inside the parser itself.

`readGitBranch` walks up the directory tree (max 6 levels) looking for `.git/HEAD`. Reads the `ref: refs/heads/<branch>` prefix; returns `"(detached)"` for raw SHA HEAD; returns `null` if no `.git` found.

---

## 8. `parseConversation` — Full Message Extraction

`parseConversation(filePath, account)` builds a complete `Conversation` object with all messages.

It applies the same line-by-line stream approach as `parseMeta`. The same filters apply:
- Skip blank lines
- Skip malformed JSON
- Skip non-user/assistant types
- Skip `isMeta: true` entries

### What gets included as a message

An entry is pushed to `messages[]` if any of:
- `extractTextContent(message.content)` is non-empty
- `isToolResultOnly` is true (user entry, `toolUseResult` truthy, all blocks are `tool_result`)
- `extractToolUseBlocks(message.content)` returns at least one block (assistant entries with tool calls but no text)

### ConversationMessage fields

| Field | Source |
|-------|--------|
| `role` | entry `type` |
| `text` | `extractTextContent(message.content)` (empty string if tool-result-only) |
| `timestamp` | `entry.timestamp` |
| `uuid` | `entry.uuid` |
| `isToolResult` | `true` if `isToolResultOnly`, else `undefined` |
| `isThinking` | `true` if `thinkingContent` is non-empty, else `undefined` |
| `thinkingContent` | All `thinking` blocks joined with `"\n\n"` |
| `metadata` | Set only when at least one metadata field is present (see below) |

### MessageMetadata fields

| Field | Condition |
|-------|-----------|
| `model` | `message.model` is present |
| `stopReason` | `message.stop_reason` is defined (may be `null`) |
| `inputTokens` | `usage.input_tokens > 0` |
| `outputTokens` | `usage.output_tokens > 0` |
| `cacheReadTokens` | `usage.cache_read_input_tokens > 0` |
| `cacheCreationTokens` | `usage.cache_creation_input_tokens > 0` |
| `gitBranch` | `entry.gitBranch` is truthy |
| `version` | `entry.version` is truthy |
| `toolUses` | Array of tool names if any `tool_use` blocks exist |
| `toolUseBlocks` | Full `ToolUseBlock[]` if any `tool_use` blocks exist |
| `teamName` | `entry.teamName` is truthy |
| `teamInfo` | Populated in post-processing (see §9) |

If `metadata` ends up with zero fields, it is set to `undefined` (not included in the message).

### fullText

After all messages are collected: `textParts.join(" ")` where `textParts` contains the non-empty `text` value from every message that had one.

### When parseConversation returns null

Returns `null` if `messages.length === 0` or on any unhandled exception.

---

## 9. Teammate / Team Info Post-Processing

After all messages are collected in `parseConversation`, if any message has `metadata.teamName`:

1. The parser scans for entries where `metadata.teamName` is set and `text` is non-empty
2. It tries to parse `<teammate-message>` attributes from the text using this regex: `/<teammate-message\s+([^>]*)>/`
3. If found, attributes are extracted: `teammate_id`, `summary`, `color`
4. The resulting `TeamInfo` is stored in a `Map<teamName, TeamInfo>`
5. A second pass attaches the matching `TeamInfo` to `metadata.teamInfo` on every message with that `teamName`

Note: only the **first** `<teammate-message>` tag for each team name is parsed for attributes; subsequent messages from the same team reuse the same `TeamInfo`.

---

## 10. Caching in the Scanner (`scanner.ts`, `cache.ts`)

The `ConversationScanner` class maintains three in-memory caches:

| Cache | Type | Key | Value | Size |
|-------|------|-----|-------|------|
| `metadataCache` | `Map` | `filePath` | `ConversationMeta` | unbounded |
| `sessionIdIndex` | `Map` | `sessionId` | `ConversationMeta` | unbounded |
| `conversationLRU` | `LRUCache` | `filePath` | `Conversation` | 5 entries (default) |

All three caches are **cleared at the start of every `scan()` call**. There is no cross-call persistence.

`LRUCache` is a hand-rolled implementation using `Map` insertion order. On `get`, the key is deleted and re-inserted to move it to the end. When `size > capacity`, the first key (oldest) is deleted.

`getConversation(id)` checks the LRU first, then falls back to `metadataCache` or `sessionIdIndex` to find the file path, then calls `parseConversation`. Entries not in the metadata cache return `null` without attempting a file read.

---

## 11. Batching and Concurrency (`scanner.ts`)

Files are processed in batches of 12 (`BATCH_SIZE = 12`). Within each batch, all `parseMeta` calls run concurrently via `Promise.all`. Git branch resolution also happens inside the concurrent batch.

After each batch, the `onBatch` progress callback is fired with the metadata parsed in that batch. The `onProgress` callback is fired with `(scanned, total)` counts.

---

## 12. Filtering and Sorting (`filters.ts`)

Filters are applied after all files are parsed, in this order:

1. `applyIncludeFilter` — by conversation type: `"all"`, `"conversations"` (excludes subagents and teammates), `"subagents"` (only `isSubagent === true`), `"teammates"` (only `isTeammate === true`)
2. `applyProjectFilter` — case-insensitive substring match against `projectPath` or `projectName`
3. `applyAccountFilter` — exact match on `account`
4. `applySinceFilter` — `timestamp >= cutoff`; cutoff parsed from `"7d"`, `"24h"`, `"2w"` durations or `"YYYY-MM-DD"` ISO date strings

Sort orders:
- `"recent"` — `b.timestamp.localeCompare(a.timestamp)` (newest first)
- `"oldest"` — `a.timestamp.localeCompare(b.timestamp)`
- `"messages-desc"` / `"messages-asc"` — by `messageCount`
- `"alpha"` — by `projectName`, then `preview` within same project

Pagination via `applyPagination(items, limit, offset)` slices the sorted array. Default limit: 50, default offset: 0.

All filter functions return **new arrays** and do not mutate the input.

---

## 13. FlexSearch Indexing (`indexer.ts`)

After each file is parsed to `ConversationMeta`, it is added to a `FlexSearch.Document` index. Fields indexed:

- `content` — the `contentSnippet`
- `projectName`, `projectPath`
- `sessionId`, `sessionName`
- `account`
- `model`
- `gitBranch`
- `toolNames` — the `toolNames` array joined with a space

Index options: `tokenize: "forward"`, `resolution: 9`, `cache: 100`.

The indexer also keeps a parallel `Map<id, ConversationMeta>` (`documents`) for post-search metadata retrieval, since FlexSearch only stores the `id` field.

Search deduplicates results across fields (same `id` from multiple field matches appears once). Match snippets are extracted by substring search: `±80 chars` before the query, `+120 chars` after, with `...` ellipsis added at truncation points.

If `search()` is called before `scan()`, the scanner auto-scans with `limit: undefined` to build the index first.

---

## 14. Project Name Derivation

`getShortProjectName(fullPath)` splits the absolute path on `/`, removes empty parts, and takes the last 3 segments joined with `/`. Examples:
- `/home/user/project` → `"home/user/project"`
- `/Users/alice/Desktop/dev/myapp` → `"Desktop/dev/myapp"`

---

## 15. View Transforms

After filtering and before pagination, `scan()` optionally transforms the flat array:

- **`"flat"` (default):** returns the array as-is, then paginates
- **`"tree"`:** separates into parents and subagents; attaches each subagent to its `parentSessionId` parent. Subagents without a matching parent are promoted to top-level `TreeConversation` nodes with an empty `subagents: []`
- **`"grouped"`:** groups by `teamName` (key `"_default"` for conversations with no team); returns a `{ [teamName]: ConversationMeta[] }` object. Pagination is **not applied** to grouped results.

---

## Key Invariants

- **Read-only:** The scanner never writes to JSONL files. It only reads.
- **Append-only file assumption:** Lines are read in file order. The `latestTimestamp` is the max across all entries, not the last line's timestamp.
- **isMeta entries always skipped:** Synthetic entries with `isMeta: true` never affect `messageCount`, `firstMessage`, `lastMessage`, or the `messages[]` array.
- **Tool-result-only user entries count as messages** but contribute empty `text: ""` in `parseConversation` and are included in `messageCount` in `parseMeta`.
- **Tool-use-only assistant entries** (no text, only `tool_use` blocks) are included in `parseConversation` messages but do NOT increment `messageCount` in `parseMeta` (they produce no text content and `isOnlyToolResultContent` is false for assistant entries).
- **Model is extracted once** from the first assistant entry; subsequent assistant entries' model fields are ignored in `parseMeta` (but captured per-message in `parseConversation`).
- **No writing of metadata cache to disk:** all caches are in-process memory, cleared on every `scan()`.
