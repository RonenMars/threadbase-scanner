# Threadbase Scanner Persistent Index — Technical Specification

## 1. Overview

This document specifies a next-generation replacement design for the current `RonenMars/threadbase-scanner` project.

The existing project is a TypeScript package/CLI named `@threadbase-sh/scanner`. It scans Claude Code JSONL conversation history, extracts metadata, supports filtering/grouping/search, and exposes a library API plus CLI. Today it is primarily an in-memory scanner: it discovers JSONL files, parses each file line-by-line, stores metadata in memory, builds a FlexSearch index in memory, and uses LRU caches for repeated conversation reads.

This spec adjusts the previous “backend service” design so it can realistically replace the current scanner package instead of becoming an unrelated server.

The recommended replacement should remain:

- A TypeScript library package
- A CLI package
- Usable by an external server/streamer/mobile bridge
- Persistent internally via SQLite
- Incremental via byte-offset JSONL cursors
- API-compatible where practical with the existing `ConversationScanner`

Each folder represents part of a project/file-structure hierarchy, and each JSONL file represents one conversation or one conversation stream. File sizes may range from very small files to very large files, around 200MB or more.

The scanner builds a persistent index that can power a UI similar to a “Recents / Popular / Favorites” conversation browser.

The index should include:

- Conversation message count
- First sent message datetime
- First sent message text
- Last sent message datetime
- Last sent message text
- Conversation branch
- Project path / workspace path
- Source JSONL file path
- Per-file indexing cursor
- Optional sidecar summary file
- Optional full-text search index later

The primary design goal is efficient incremental indexing: after the initial scan, file updates should process only newly appended JSONL lines instead of reparsing the entire file.

---

## 1.1 Findings from the Current `threadbase-scanner` Project

The current repository already has several useful parts that should be preserved:

- `src/scanner.ts` — `ConversationScanner` orchestrator
- `src/discovery.ts` — deep `**/*.jsonl` discovery with exclusions
- `src/parser.ts` — streaming JSONL parsing for metadata and full conversations
- `src/indexer.ts` — FlexSearch-based in-memory search
- `src/filters.ts` — sorting, filtering, pagination
- `src/profiles.ts` — multi-profile support under Claude config directories
- `src/git.ts` — git branch lookup
- `src/types.ts` — public API types
- CLI commands through `commander`

Current strengths:

- Good TypeScript library API
- Good CLI shape
- Multi-profile support
- Subagent/teammate metadata support
- Content tiers
- Full-text search through FlexSearch
- Existing `refreshFile(filePath)` hook for single-file refresh
- Existing `getConversationPage()` API, though currently implemented as parse-full-then-slice

Current limitations this spec should solve:

- No durable/persistent metadata index
- No persistent per-file cursor
- `scan()` clears and rebuilds in-memory state
- `refreshFile()` reparses the entire file
- Search index is in-memory and must be rebuilt
- `getConversationPage()` still parses the whole JSONL before slicing
- `statCache` can skip unchanged files only when the caller provides it; it is not durable
- Recent/project/branch fetches are array operations after parsing, not indexed DB queries

Therefore, the adjusted goal is not “build a Fastify backend instead of scanner.” The better goal is:

```txt
Replace the internals of @threadbase-sh/scanner with a persistent SQLite-backed scanner engine,
while preserving the scanner library/CLI API and letting external apps wrap it with HTTP/WebSocket/SSE if needed.
```

---

## 2. Recommended Architecture

Recommended stack:

- Runtime: Node.js
- Language: TypeScript
- Database: SQLite with WAL mode
- SQLite library: `better-sqlite3`
- Optional query builder: Kysely or Drizzle
- File watcher: `chokidar` or `@parcel/watcher`
- Background processing: Node `worker_threads` or a separate child process
- Existing CLI: `commander`
- Existing logging seam: `pino`

Do not put Fastify inside `@threadbase-sh/scanner` itself.

Fastify is still a good choice for a separate host service, such as a streamer/server that exposes scanner data over HTTP, but the scanner package should remain a framework-agnostic library.

High-level structure:

```txt
JSONL conversation files
        ↓
File watcher + periodic scanner, optional
        ↓
Persistent scanner engine
        ↓
SQLite metadata/search/cursor index
        ↓
ConversationScanner public API + CLI
        ↓
External app/server/mobile bridge
```

Recommended hybrid approach:

1. SQLite is the canonical query index.
2. JSONL files remain the source of truth.
3. The service persists a per-file cursor in SQLite.
4. Optional sidecar `.idx.json` files can be written next to JSONL files for portability/debugging.
5. Public list/search APIs read from SQLite, never directly from large JSONL files for list screens.
6. Full conversation reads may still parse JSONL on demand in V1, but should later use checkpoints/pages.

---

## 2.1 Recommended Package Shape

The replacement should keep the current package identity and public role:

```txt
@threadbase-sh/scanner
  library API
  CLI API
  SQLite-backed persistent engine
```

Recommended source layout:

```txt
src/
  index.ts
  types.ts

  scanner.ts                    Existing public orchestrator, adapted

  discovery.ts                  Keep/adapt existing fast-glob discovery
  parser.ts                     Keep existing parser logic, refactor into reusable reducer
  filters.ts                    Keep for compatibility/fallback
  profiles.ts                   Keep existing profile loading
  git.ts                        Keep, but prefer JSONL branch metadata when available
  tiers.ts                      Keep existing tier model
  logger.ts                     Keep existing pino seam

  persistent/
    db.ts                       SQLite connection + pragmas
    schema.sql                  Tables/indexes
    migrations.ts
    repositories/
      files.repo.ts
      conversations.repo.ts
      messages.repo.ts
    cursor.ts                   Byte offset cursor logic
    index-engine.ts             Main persistent indexing engine
    jsonl-tail-reader.ts        Read from byte offset to EOF
    sidecar.ts                  Optional .idx.json support

  watcher/
    file-watcher.ts             Optional chokidar/@parcel/watcher integration
    index-queue.ts              Debounced per-file jobs

cli/
  index.ts
  commands/
```

The important conceptual change:

```txt
Current scanner:
  scan() → discover all files → parse many files → keep arrays/maps in memory

New scanner:
  scan()/refresh() → update SQLite index incrementally
  list/search/project APIs → query SQLite
```

---

## 2.2 Compatibility with Existing Public API

The replacement should preserve these APIs as much as possible:

```ts
scan(options?: ScanOptions): Promise<ScanResult>
search(query: string, options?: SearchOptions): Promise<SearchResult[]>
getConversation(id: string, options?: GetConversationOptions): Promise<Conversation | null>
getConversationPage(id: string, options: GetConversationPageOptions): Promise<ConversationPage | null>
refreshFile(filePath: string, account?: string): Promise<ConversationMeta | null>
getProjects(): string[]
```

But their implementation should change:

| Current behavior | Replacement behavior |
|---|---|
| `scan()` rebuilds memory state | `scan()` updates persistent SQLite index, then returns queried results |
| `search()` uses in-memory FlexSearch | `search()` uses SQLite FTS5 or a persisted search table |
| `refreshFile()` reparses full file | `refreshFile()` processes only new bytes when safe |
| `getConversationPage()` parse-full-then-slice | V1 may keep this; V2 should use checkpoints/window parsing |
| `getProjects()` reads in-memory `Set` | `getProjects()` queries SQLite |

For a safe migration, keep the existing return types and CLI output stable first. Optimize internals second.

---

## 3. Main Responsibilities

The scanner package is responsible for:

1. Discovering JSONL conversation files inside configured root directories.
2. Parsing each JSONL file line-by-line.
3. Extracting conversation metadata.
4. Maintaining a persistent per-file cursor.
5. Updating the SQLite index incrementally.
6. Detecting file append, truncate, replace, move, and delete events.
7. Serving indexed data through the existing library and CLI APIs.
8. Optionally exposing watcher callbacks/events that a host server can forward to clients.

---

## 4. Non-goals for Version 1

The first version should not try to solve everything.

Avoid these initially:

- HTTP server built into the scanner package
- WebSocket/SSE built into the scanner package
- Semantic search / embeddings
- Complex ranking
- Multi-user permissions
- Cloud sync
- Compression-aware partial reading
- Reconstructing arbitrary conversation branches from every possible event type
- True bounded page parsing if it risks message-index drift

These can be added later once the basic metadata index is stable.

---

## 5. Data Model

### 5.1 SQLite Tables

#### `conversation_files`

Tracks each JSONL source file and its indexing cursor.

```sql
CREATE TABLE conversation_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  absolute_path TEXT NOT NULL UNIQUE,
  parent_dir TEXT NOT NULL,
  file_name TEXT NOT NULL,

  account TEXT NOT NULL DEFAULT 'default',

  device_id TEXT,
  inode TEXT,

  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,

  last_indexed_offset INTEGER NOT NULL DEFAULT 0,
  last_indexed_line INTEGER NOT NULL DEFAULT 0,

  content_fingerprint TEXT,

  status TEXT NOT NULL DEFAULT 'active',
  -- active | deleted | needs_reindex | error

  last_indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
```

Recommended indexes:

```sql
CREATE INDEX idx_conversation_files_status
ON conversation_files(status);

CREATE INDEX idx_conversation_files_parent_dir
ON conversation_files(parent_dir);

CREATE INDEX idx_conversation_files_account
ON conversation_files(account);
```

---

#### `conversations`

Stores one row per indexed conversation.

For the common case where one JSONL file equals one conversation, `file_id` maps directly to one conversation. If a file may contain multiple conversations, then `conversation_id` should come from the JSONL event metadata.

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  conversation_id TEXT NOT NULL UNIQUE,
  file_id INTEGER NOT NULL,

  source_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_name TEXT,

  project_path TEXT,
  project_name TEXT,
  account TEXT NOT NULL DEFAULT 'default',
  branch TEXT,

  title TEXT,
  preview TEXT,
  content_snippet TEXT,

  message_count INTEGER NOT NULL DEFAULT 0,

  first_sent_at TEXT,
  first_sent_text TEXT,
  first_message_role TEXT,

  last_sent_at TEXT,
  last_sent_text TEXT,
  last_message_role TEXT,

  model TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  is_teammate INTEGER NOT NULL DEFAULT 0,
  team_name TEXT,
  tool_names_json TEXT,
  last_prompt TEXT,

  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'active',
  -- active | deleted | error

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (file_id) REFERENCES conversation_files(id)
);
```

Recommended indexes:

```sql
CREATE INDEX idx_conversations_recent
ON conversations(last_sent_at DESC);

CREATE UNIQUE INDEX idx_conversations_session_id
ON conversations(session_id);

CREATE INDEX idx_conversations_project_recent
ON conversations(project_path, last_sent_at DESC);

CREATE INDEX idx_conversations_project_branch_recent
ON conversations(project_path, branch, last_sent_at DESC);

CREATE INDEX idx_conversations_favorites_recent
ON conversations(favorite, last_sent_at DESC);

CREATE INDEX idx_conversations_account_recent
ON conversations(account, last_sent_at DESC);

CREATE INDEX idx_conversations_subagent_recent
ON conversations(is_subagent, last_sent_at DESC);

CREATE INDEX idx_conversations_team_recent
ON conversations(team_name, last_sent_at DESC);
```

Field mapping to the current `ConversationMeta`:

| Existing `ConversationMeta` field | SQLite field |
|---|---|
| `id` | `conversation_id`, usually same as `filePath` initially |
| `filePath` | `source_path` and `conversation_files.absolute_path` |
| `sessionId` | `session_id` |
| `sessionName` | `session_name` |
| `projectPath` | `project_path` |
| `projectName` | `project_name` |
| `account` | `account` |
| `timestamp` | `last_sent_at` |
| `messageCount` | `message_count` |
| `lastMessageSender` | `last_message_role` |
| `preview` | `preview` |
| `contentSnippet` | `content_snippet` |
| `gitBranch` | `branch` |
| `model` | `model` |
| `isSubagent` | `is_subagent` |
| `parentSessionId` | `parent_session_id` |
| `isTeammate` | `is_teammate` |
| `teamName` | `team_name` |
| `toolNames` | `tool_names_json` |
| `firstMessage` | `first_sent_at`, `first_sent_text` |
| `lastMessage` | `last_sent_at`, `last_sent_text` |
| `lastPrompt` | `last_prompt` |

---

#### `index_events`

Optional but recommended for debugging and observability.

```sql
CREATE TABLE index_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  file_id INTEGER,
  source_path TEXT,

  event_type TEXT NOT NULL,
  -- discovered | appended | reindexed | truncated | deleted | moved | parse_error

  message TEXT,
  previous_offset INTEGER,
  new_offset INTEGER,
  previous_size_bytes INTEGER,
  new_size_bytes INTEGER,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

#### `message_checkpoints`

Optional table for jumping into large files by approximate message number.

Useful when a UI later needs to fetch the content of very large conversations without scanning from the start every time.

```sql
CREATE TABLE message_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  conversation_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,

  line_number INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  message_index INTEGER NOT NULL,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (file_id) REFERENCES conversation_files(id)
);
```

Recommended index:

```sql
CREATE INDEX idx_message_checkpoints_lookup
ON message_checkpoints(conversation_id, message_index);
```

Recommended checkpoint interval:

```txt
Every 500–2,000 messages
```

For most list-screen metadata, this table is not required.

---

## 6. Sidecar Index Files

Sidecar files are optional, but useful.

For a file:

```txt
conversation.jsonl
```

The service may create:

```txt
conversation.jsonl.idx.json
```

Example:

```json
{
  "version": 1,
  "sourcePath": "/Users/example/project/.history/conversation.jsonl",
  "sizeBytes": 123456789,
  "mtimeMs": 1790000000000,
  "lastIndexedOffset": 123456789,
  "lastIndexedLine": 12482,
  "messageCount": 490,
  "projectPath": "/Users/example/project",
  "projectName": "example-project",
  "branch": "main",
  "firstSentAt": "2026-06-19T08:12:00.000Z",
  "firstSentText": "Please inspect this repo and explain the architecture.",
  "lastSentAt": "2026-06-19T09:43:00.000Z",
  "lastSentText": "Great, now implement the fix.",
  "updatedAt": "2026-06-19T09:43:02.000Z"
}
```

Sidecar files are not the primary query mechanism. They are for:

- Debugging
- Portability
- Faster global index reconstruction
- Disaster recovery if SQLite is deleted/corrupted

SQLite should remain the canonical runtime index.

---

## 7. JSONL Reading Strategy

### 7.1 Why Byte Offsets

For JSONL, the most efficient cursor is a byte offset.

Each line is a standalone JSON object. Therefore, after parsing a complete line, the service can store the byte offset immediately after that line.

On the next update, it can seek directly to that offset and read only newly appended data.

This avoids loading or parsing the whole file.

---

### 7.2 Partial Read Algorithm

Given:

```ts
lastIndexedOffset: number
```

The service opens a stream from that offset:

```ts
fs.createReadStream(filePath, {
  start: lastIndexedOffset,
  encoding: "utf8"
});
```

Algorithm:

```txt
1. Load cursor from SQLite.
2. Stat the file.
3. If file size is smaller than cursor offset:
   - file was truncated or replaced
   - mark as needs_reindex
   - reindex from offset 0
4. If file size equals cursor size and mtime unchanged:
   - skip
5. If file size is larger:
   - stream from lastIndexedOffset
   - parse complete JSONL lines only
   - update summary fields
   - advance offset only after successful complete-line parse
6. Save new cursor and conversation summary in one transaction.
```

---

### 7.3 Handling Partial Lines

If the writer is currently appending to a JSONL file, the last line may be incomplete.

The indexer must not store an offset after an incomplete line.

Correct behavior:

```txt
If the trailing buffer does not end with a newline:
  keep it uncommitted
  do not parse it
  do not advance lastIndexedOffset past it
  retry on the next scan
```

This makes the indexer safe during active writes.

---

### 7.4 TypeScript Pseudocode

```ts
import fs from "node:fs";

type ParsedLineResult = {
  newOffset: number;
  newLineNumber: number;
  parsedMessages: number;
  hasPartialLine: boolean;
};

export async function processJsonlFromOffset(params: {
  filePath: string;
  startOffset: number;
  startLine: number;
  onEvent: (event: unknown, context: {
    lineNumber: number;
    byteOffset: number;
  }) => Promise<void> | void;
}): Promise<ParsedLineResult> {
  const { filePath, startOffset, startLine, onEvent } = params;

  const stream = fs.createReadStream(filePath, {
    start: startOffset,
    encoding: "utf8"
  });

  let buffer = "";
  let offset = startOffset;
  let lineNumber = startLine;
  let parsedMessages = 0;

  for await (const chunk of stream) {
    buffer += chunk;

    let newlineIndex: number;

    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const lineWithNewline = buffer.slice(0, newlineIndex + 1);
      const line = lineWithNewline.trimEnd();

      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        const event = JSON.parse(line);

        await onEvent(event, {
          lineNumber: lineNumber + 1,
          byteOffset: offset
        });

        parsedMessages += 1;
      }

      offset += Buffer.byteLength(lineWithNewline, "utf8");
      lineNumber += 1;
    }
  }

  return {
    newOffset: offset,
    newLineNumber: lineNumber,
    parsedMessages,
    hasPartialLine: buffer.length > 0
  };
}
```

Important:

- Offset advancement should correspond to raw byte length.
- Avoid relying on JavaScript string `.length` for byte offsets.
- Use `Buffer.byteLength(value, "utf8")`.
- Commit the new cursor only after the DB transaction succeeds.

---

## 8. File Change Detection

Use two mechanisms together:

1. Filesystem watcher for fast updates.
2. Periodic scanner for correctness.

Filesystem watchers can miss events under load, across network filesystems, during sleep/wake, or after application restarts.

Therefore, the system should periodically rescan configured roots.

Recommended timing:

```txt
File watcher debounce: 250–1000ms
Periodic scan: every 30–120s
Startup scan: always
```

---

## 9. File State Handling

### 9.1 Unchanged File

Condition:

```txt
current size == stored size
and current mtime == stored mtime
```

Action:

```txt
skip
```

---

### 9.2 Appended File

Condition:

```txt
current size > stored lastIndexedOffset
```

Action:

```txt
stream from lastIndexedOffset to EOF
parse new complete lines
update cursor and summary
```

Complexity:

```txt
O(new bytes)
```

---

### 9.3 Truncated File

Condition:

```txt
current size < stored lastIndexedOffset
```

Action:

```txt
mark file as needs_reindex
reset conversation summary
reindex from offset 0
```

Complexity:

```txt
O(file bytes)
```

---

### 9.4 Replaced File

Possible signs:

```txt
inode changed
device id changed
mtime changed unexpectedly
size same but fingerprint changed
```

Action:

```txt
reindex from offset 0
```

For safety, the service may store a small fingerprint from the first and last N bytes of the file.

Example:

```txt
fingerprint = hash(first 4KB + last 4KB + size)
```

This avoids hashing an entire 200MB file on every scan.

---

### 9.5 Deleted File

Condition:

```txt
file exists in SQLite but no longer exists on disk
```

Action:

```txt
mark conversation_files.status = deleted
mark conversations.status = deleted
set deleted_at
```

Do not immediately hard-delete unless the user explicitly requests cleanup.

---

### 9.6 Moved File

Detecting moves reliably is platform-dependent.

Possible strategy:

```txt
If old path is missing and new path has same inode/device:
  update absolute_path
else:
  treat old as deleted and new as discovered
```

For most first versions, treating move as delete + new discovery is acceptable.

---

## 10. Conversation Metadata Extraction

The exact extractor depends on the JSONL schema.

The indexer should support a small adapter layer:

```ts
type ConversationEvent = unknown;

type ExtractedMessage = {
  conversationId?: string;
  projectPath?: string;
  branch?: string;
  role?: string;
  sentAt?: string;
  text?: string;
};

type JsonlAdapter = {
  canHandle(event: ConversationEvent): boolean;
  extract(event: ConversationEvent): ExtractedMessage | null;
};
```

This allows supporting multiple conversation-history formats later.

---

### 10.1 Summary Update Rules

For every extracted message:

```txt
message_count += 1

if first_sent_at is empty:
  first_sent_at = message.sentAt
  first_sent_text = message.text
  first_message_role = message.role

if message.sentAt is newer than current last_sent_at:
  last_sent_at = message.sentAt
  last_sent_text = message.text
  last_message_role = message.role

branch = most recent known branch value
project_path = most recent known project path value
```

If `sentAt` is missing:

```txt
use file mtime as fallback only for sorting
but keep a flag or avoid pretending it is an exact message timestamp
```

---

### 10.2 Text Normalization

For list display, store a compact preview:

```txt
trim whitespace
collapse repeated whitespace
remove ANSI escape codes
limit to 300–500 chars
```

Recommended:

```ts
function normalizePreviewText(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
```

---

## 11. Indexer Worker Design

The indexer should be separated from read/query operations, but it does not need to be a Fastify/server worker inside this package.

Recommended:

```txt
ConversationScanner facade:
  - exposes the current public library API
  - reads SQLite for list/search/project queries
  - delegates refresh/index work to the persistent engine

Persistent index engine:
  - watches files
  - scans directories
  - streams JSONL
  - writes SQLite
  - emits optional callbacks/events
```

Why:

- Prevents a large scan from blocking list/search calls.
- Keeps synchronous SQLite writes isolated from read-heavy paths.
- Allows host applications to subscribe to scanner events and forward them however they want.
- Keeps `@threadbase-sh/scanner` framework-agnostic.

---

### 11.1 Job Queue

Use an in-process queue for V1.

Job types:

```ts
type IndexJob =
  | { type: "scan-root"; rootPath: string }
  | { type: "index-file"; filePath: string; reason: "startup" | "watcher" | "periodic" | "manual" }
  | { type: "reindex-file"; filePath: string; reason: string }
  | { type: "mark-deleted"; filePath: string };
```

Recommended behavior:

- Deduplicate jobs by file path.
- Debounce rapid repeated events.
- Limit concurrency.
- For SQLite with a single writer, start with concurrency `1`.

---

### 11.2 Transaction Strategy

Each file update should be committed in a single transaction:

```txt
BEGIN
  update conversation_files cursor
  upsert conversation summary
  insert index_events row
COMMIT
```

If parsing fails:

```txt
ROLLBACK
mark file status = error if needed
do not advance cursor past failed line
```

---

## 12. Scanner API Specification

This section describes the scanner library API, not an HTTP API.

An external host service may expose these operations through Fastify, Express, Hono, WebSocket, or SSE later, but that should live outside the scanner package. The scanner itself should remain framework-agnostic.

### 12.1 Scan/List Conversations

Keep the existing API:

```ts
scanner.scan({
  sort: "recent",
  limit: 50,
  offset: 0,
  project: "my-project",
  account: "default",
  include: "all",
  view: "flat",
});
```

Current behavior:

```txt
discover all JSONL files
parse metadata into memory
sort/filter/paginate arrays
return ScanResult
```

Replacement behavior:

```txt
discover/update changed JSONL files
persist metadata/cursors in SQLite
query SQLite for requested sort/filter/page
return the same ScanResult shape
```

The existing public type uses `limit`/`offset`. Keep that for compatibility. Cursor pagination can be added later as an additional API, but should not replace the current contract.

---

### 12.2 Search

Keep the existing API:

```ts
scanner.search("authentication bug", {
  limit: 10,
  project: "backend",
});
```

Current behavior:

```txt
in-memory FlexSearch index
rebuilt after scan()
```

Replacement behavior:

```txt
SQLite FTS5 or persisted search table
incrementally updated per changed file
```

---

### 12.3 Get Projects

Keep:

```ts
scanner.getProjects(): string[]
```

Current behavior:

```txt
read this.projects Set
```

Replacement behavior:

```sql
SELECT DISTINCT project_path
FROM conversations
WHERE status = 'active'
ORDER BY project_path ASC;
```

---

### 12.4 Refresh One File

Keep:

```ts
scanner.refreshFile(filePath, account)
```

Current behavior:

```txt
parseMeta(filePath) from the start of the file
update in-memory metadata/search maps
evict parsed conversation LRU entries
```

Replacement behavior:

```txt
stat file
compare with conversation_files cursor
stream from last_indexed_offset when append-only
reindex from zero only when replaced/truncated/corrupt
update SQLite metadata/search rows
evict any full-conversation/page cache
```

---

### 12.5 Get Full Conversation

Keep:

```ts
scanner.getConversation(id)
```

V1 replacement may continue parsing JSONL on demand.

V2 should add a persisted message index or byte-offset checkpoints so large conversations can be read without parsing the entire file every time.

---

### 12.6 Get Conversation Page

Keep:

```ts
scanner.getConversationPage(id, {
  beforeIndex,
  limit,
});
```

Current repo behavior:

```txt
parse full conversation
slice messages array
return requested window
```

Recommended replacement path:

1. Keep current behavior initially for correctness.
2. Add `message_checkpoints` while indexing.
3. Refactor `parser.ts` line-to-message reduction into reusable logic.
4. Add true bounded page parsing only after equivalence tests prove message indices match `parseConversation().messages`.

This matters because Claude JSONL lines do not map 1:1 to UI messages. Tool use, tool results, thinking blocks, sidechain metadata, and system records affect message identity.

---

### 12.7 Optional Host HTTP API

If a separate server wraps this package, these are reasonable endpoints:

```http
GET /conversations
GET /conversations/:id
GET /projects
POST /index/refresh
GET /index/status
GET /events
```

But these should not be part of `@threadbase-sh/scanner` itself.

---

## 13. Fetch Complexity

### 13.1 Recent Conversations

SQL:

```sql
SELECT *
FROM conversations
WHERE status = 'active'
ORDER BY last_sent_at DESC
LIMIT 50;
```

With index:

```sql
CREATE INDEX idx_conversations_recent
ON conversations(last_sent_at DESC);
```

Complexity:

```txt
O(log N + page size)
```

---

### 13.2 Project + Branch Conversations

SQL:

```sql
SELECT *
FROM conversations
WHERE project_path = ?
  AND branch = ?
  AND status = 'active'
ORDER BY last_sent_at DESC
LIMIT 50;
```

With index:

```sql
CREATE INDEX idx_conversations_project_branch_recent
ON conversations(project_path, branch, last_sent_at DESC);
```

Complexity:

```txt
O(log N + page size)
```

---

## 14. Indexing Complexity

Let:

```txt
T = total bytes across all JSONL files
F = number of files
Δ = newly appended bytes since last index
N = number of indexed conversations
P = requested page size
```

### Initial Index

```txt
O(T)
```

Every byte must be read once.

---

### Incremental Append Update

```txt
O(Δ)
```

Only new bytes after the last stored offset are read.

---

### File Truncation/Reindex

```txt
O(file bytes)
```

Only the affected file needs a full reindex.

---

### Startup Scan

If only statting files:

```txt
O(F)
```

If files changed and need indexing:

```txt
O(F + changed bytes)
```

---

### Recent List Fetch

```txt
O(log N + P)
```

---

## 15. Performance Recommendations

### 15.1 Use SQLite WAL Mode

On startup:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
```

Benefits:

- Better read/write concurrency
- API can read while indexer writes
- Good performance for local apps

---

### 15.2 Batch DB Writes

Do not write after every parsed message if avoidable.

Instead:

```txt
parse file stream
maintain summary in memory
commit one transaction per file or per chunk
```

For very large files, commit every N messages or every N MB.

Recommended:

```txt
Commit every 5,000–20,000 lines
or every 10–50MB
```

But make sure cursor advancement remains consistent.

---

### 15.3 Keep UI Queries Separate

The UI should only query SQLite summaries for list screens.

Avoid this:

```txt
UI request → parse JSONL
```

Prefer this:

```txt
UI request → SQLite summary query
```

---

### 15.4 Use Backpressure

If file changes happen faster than indexing:

```txt
deduplicate file jobs
keep latest file path job
avoid processing same file repeatedly
```

---

## 16. Error Handling

### 16.1 Invalid JSON Line

Possible causes:

- Partial write
- Corrupted file
- Non-JSON log line

Behavior:

```txt
If line is the final trailing line without newline:
  treat as partial and retry later

If line is complete but invalid JSON:
  record parse_error
  mark file status = error
  do not advance cursor past failed line
```

Optional future behavior:

```txt
support skip-corrupt-line mode
```

But default should be conservative.

---

### 16.2 Database Write Failure

Behavior:

```txt
rollback transaction
do not advance cursor
emit index:file-error
retry later
```

---

### 16.3 Permission Error

Behavior:

```txt
record error
mark file status = error
continue indexing other files
```

The service should never stop the entire indexing process because one file fails.

---

## 17. Branch Detection

There are two likely sources for branch:

1. Branch is explicitly stored in JSONL events.
2. Branch must be inferred from file path or project metadata.

Recommended priority:

```txt
1. JSONL event metadata branch
2. Sidecar/index metadata
3. Git branch lookup at project path
4. Unknown/null
```

Be careful with live Git lookup:

- The current Git branch may not match the branch at the time the conversation happened.
- Worktrees may point to different branches.
- Detached HEAD is possible.

Therefore, if JSONL contains branch metadata, prefer it.

---

## 18. Project Detection

Recommended priority:

```txt
1. JSONL event metadata project path
2. Known root mapping
3. Nearest parent containing .git
4. Parent directory name fallback
```

Store both:

```txt
project_path
project_name
```

Example:

```txt
project_path = /Users/ronen/dev/ai-tools/tb-mobile
project_name = tb-mobile
```

---

## 19. Full-text Search Future Extension

The current project already has full-text search through in-memory FlexSearch.

For a persistent replacement, there are two reasonable options:

1. SQLite FTS5
2. Keep FlexSearch as an optional in-memory acceleration layer built from SQLite

Recommended V1 replacement:

```txt
SQLite FTS5 as the canonical persisted search index
```

Suggested table:

```sql
CREATE VIRTUAL TABLE conversation_messages_fts
USING fts5(
  conversation_id,
  role,
  text,
  sent_at,
  project_path,
  branch
);
```

This should be separate from the list-screen metadata index.

Why:

- Metadata index remains small and fast.
- Search can be rebuilt or optimized without disrupting basic browsing.
- Search indexing may have different performance characteristics.
- The scanner can start instantly from persisted metadata even before warming an optional in-memory search cache.

If exact current FlexSearch behavior is important, add an adapter:

```ts
interface SearchBackend {
  addOrUpdate(meta: ConversationMeta): void | Promise<void>;
  remove(id: string): void | Promise<void>;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}
```

Then support:

```txt
SQLiteFtsSearchBackend
FlexSearchMemoryBackend
```

---

## 20. Suggested Code Structure

```txt
src/
  index.ts
  types.ts
  scanner.ts

  discovery.ts
  parser.ts
  filters.ts
  profiles.ts
  git.ts
  tiers.ts
  logger.ts
  tags.ts
  cache.ts

  persistent/
    db.ts
    schema.sql
    migrations.ts
    index-engine.ts
    cursor.ts
    jsonl-tail-reader.ts
    metadata-reducer.ts
    sidecar.ts
    repositories/
      conversation-files.repo.ts
      conversations.repo.ts
      fts.repo.ts

  watcher/
    file-watcher.ts
    index-queue.ts

cli/
  index.ts
  commands/
```

---

## 21. Recommended V1 Implementation Plan

### Phase 1 — Add SQLite Without Changing Public API

Build:

- SQLite schema
- SQLite connection/migrations
- Repositories for `conversation_files` and `conversations`
- Mapping between `ConversationMeta` and SQLite rows
- A feature flag or constructor option for persistent mode

Keep current parser/discovery behavior initially.

---

### Phase 2 — Persist Scan Results

Change `scan()` so it can:

- discover JSONL files using existing `discoverJsonlFiles`
- parse changed files
- upsert metadata into SQLite
- return the same `ScanResult` shape from SQLite queries
- preserve `view`, `include`, `sort`, `project`, `account`, `since`, `limit`, and `offset`

---

### Phase 3 — Incremental Indexing

Add:

- `last_indexed_offset`
- `last_indexed_line`
- append-only partial reads
- truncate/rewrite detection
- persistent replacement for `statCache`
- incremental implementation of `refreshFile(filePath)`

---

### Phase 4 — Search Persistence

Replace or supplement FlexSearch:

- add SQLite FTS5
- populate FTS from `content_snippet`, metadata fields, and optionally message-level text
- make `search()` query the persistent backend
- optionally keep FlexSearch as an in-memory cache warmed from SQLite

---

### Phase 5 — File Watching

Add:

- watcher
- debounce
- job queue
- periodic scan fallback
- callback/event emitter API for host apps

Do not add SSE/WebSocket directly to the scanner package.

---

### Phase 6 — Sidecar Files

Add:

- optional `.idx.json` output
- sidecar versioning
- sidecar recovery/debug mode

---

### Phase 7 — Paged Conversation Optimization

Add only after correctness tests:

- message checkpoints
- parser reducer refactor
- true bounded `getConversationPage`
- equivalence tests against `parseConversation().messages.slice(...)`

---

## 22. Final Recommendation

For `RonenMars/threadbase-scanner`, the best practical design is:

```txt
Keep @threadbase-sh/scanner as a TypeScript library + CLI
SQLite with WAL
better-sqlite3
dedicated persistent indexing engine
byte-offset JSONL cursor
optional filesystem watcher + periodic scan
optional sidecar .idx.json
optional host events/callbacks
```

This gives a strong balance between:

- Performance
- Simplicity
- TypeScript developer experience
- Local-first reliability
- Efficient incremental updates
- Future extensibility
- Compatibility with the existing scanner package and CLI

Most importantly, the system should treat large JSONL files as append-oriented streams and persist byte offsets after successful parsing. That makes normal updates proportional to newly appended bytes rather than total file size.

Fastify remains a good choice for a separate app/server that consumes this scanner, but it should not be the scanner's internal framework.
