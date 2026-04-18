# Unified Scanner Design: `@threadbase/scanner`

> **Date:** 2026-04-18
> **Status:** Approved
> **Scope:** Single npm package replacing all four scanner implementations

---

## Problem

Four independent scanner implementations (Electron, VS Code, IntelliJ, CLI) scan Claude Code conversation history files. They share the same purpose but diverge in capabilities, limits, and coverage:

- **VS Code** finds 497 conversations (most complete — includes subagents/teammates)
- **CLI** finds 351 (flat single-level scan misses nested files)
- **IntelliJ** finds 297 (excludes subagents/, tool-results/)
- **Electron** finds 293 (excludes subagents/, tool-results/)

Each scanner has unique strengths the others lack. No single scanner captures the full superset of metadata or features.

## Solution

A single TypeScript npm package (`@threadbase/scanner`) that combines the best parts of all four scanners into one library with a CLI wrapper. All apps import it as a dependency.

---

## Architecture

```
+-------------------------------------------+
|  CLI Wrapper (commander)                  |  npx @threadbase/scanner list --since 7d
+-------------------------------------------+
|  API Layer                                |  scan(), search(), filter(), getConversation()
+-------------------------------------------+
|  Core Engine                              |
|  +----------+ +--------+ +-----------+   |
|  | Discovery | | Parser | | Indexer   |   |
|  | (glob)   | | (JSONL)| |(FlexSearch)|   |
|  +----------+ +--------+ +-----------+   |
|  +----------+ +--------+ +-----------+   |
|  | Cache    | | Git    | | Profiles  |   |
|  | (LRU)   | | Branch | |           |   |
|  +----------+ +--------+ +-----------+   |
+-------------------------------------------+
```

### Three Layers

1. **Core Engine** — discovery, JSONL parsing, indexing, caching, git detection, profile management
2. **API Layer** — `scan()`, `search()`, `getConversation()` with options objects
3. **CLI Wrapper** — thin commander-based CLI exposing the API via flags

---

## Discovery Engine

**Best of VS Code + IntelliJ:**

- Uses `fast-glob` with `**/*.jsonl` (VS Code's approach — finds everything including subagents)
- Skips: dot-prefixed dirs, `memory/`, `tool-results/` (IntelliJ's defensive exclusions)
- Does **not** skip `subagents/` — this is why VS Code finds 497 vs 293
- Checks `stat.size > 0` to skip empty files
- Supports multiple profile config dirs
- Batch processing with configurable batch size (default: 12)

---

## Unified ConversationMeta

Full superset of all four scanners:

```typescript
interface ConversationMeta {
  // Identity
  id: string                          // file path (unique key)
  filePath: string
  sessionId: string
  sessionName: string

  // Project
  projectPath: string
  projectName: string
  account: string

  // Timestamps & counts
  timestamp: string                   // ISO-8601, latest message
  messageCount: number
  lastMessageSender: 'user' | 'assistant'

  // Content (tier-dependent)
  preview: string
  contentSnippet: string

  // Git (from IntelliJ/CLI)
  gitBranch: string | null

  // Model (from IntelliJ)
  model: string | null

  // Subagent detection (from VS Code)
  isSubagent: boolean
  parentSessionId: string | null

  // Teammate detection (from VS Code)
  isTeammate: boolean
  teamName: string | null

  // Tool tracking (from CLI)
  toolNames: string[]
}
```

---

## Content Tiers

```typescript
interface ContentTier {
  name: string
  previewMax: number
  snippetMax: number
}

// Built-in defaults, overridable
const TIERS = {
  standard: { name: 'standard', previewMax: 200,   snippetMax: 5_000  },
  full:     { name: 'full',     previewMax: 1_200,  snippetMax: 50_000 },
}
```

Consumers can add/modify/remove tiers via configuration.

---

## Subagent/Teammate Representation

All three representation modes available via options:

- **`view: 'flat'`** (default) — all entries as flat list with `isSubagent`, `isTeammate` flags
- **`view: 'tree'`** — parent conversations contain `subagents: ConversationMeta[]`
- **`view: 'grouped'`** — grouped by `teamName`

Filtering via `include`:
- `'all'` (default) — all 497 results
- `'conversations'` — primary conversations only (~351)
- `'subagents'` — subagent conversations only
- `'teammates'` — teammate conversations only

---

## Public API

```typescript
// Scanning
scan(options?: ScanOptions): Promise<ScanResult>

// Full-text search
search(query: string, options?: SearchOptions): Promise<SearchResult[]>

// Load single conversation with full messages
getConversation(id: string, options?: GetOptions): Promise<Conversation | null>
```

### ScanOptions

```typescript
interface ScanOptions {
  profiles?: Profile[]
  tier?: string                  // 'standard' | 'full' | custom
  include?: 'all' | 'conversations' | 'subagents' | 'teammates'
  view?: 'flat' | 'tree' | 'grouped'
  sort?: 'recent' | 'oldest' | 'messages-desc' | 'messages-asc' | 'alpha'
  since?: string                 // '7d' | '2w' | '24h' | '2024-01-15'
  project?: string
  account?: string
  limit?: number                 // default: 50
  offset?: number                // default: 0
  onProgress?: (scanned: number, total: number) => void
  onBatch?: (metas: ConversationMeta[]) => void
}
```

### ScanResult

```typescript
interface ScanResult {
  conversations: ConversationMeta[]
  total: number                  // total before pagination
  scanned: number                // files processed
}
```

### SearchOptions & SearchResult

```typescript
interface SearchOptions extends ScanOptions {
  fields?: string[]              // which fields to search (default: all)
}

interface SearchResult {
  meta: ConversationMeta
  score: number
  matches: { field: string, snippet: string }[]
}
```

---

## Search Index

FlexSearch document index with forward tokenization, searching all fields:
- `contentSnippet`, `projectName`, `projectPath`
- `sessionId`, `sessionName`, `account`
- `model`, `gitBranch`, `toolNames` (joined as string)

Context-aware snippets: 80 chars before match + 120 chars after.

---

## Caching

- **Metadata LRU cache**: configurable capacity (default 500)
- **Conversation LRU cache**: max 5 full conversations
- **Session ID index**: unbounded map for O(1) lookups (from IntelliJ)
- Cache auto-clears on `scan()` calls

---

## System Tag Cleaning

Pre-compiled regex (IntelliJ's approach) covering full superset:

`system-reminder`, `thinking`, `command-name`, `command-message`, `command-args`, `ide_selection`, `ide_opened_file`, `fast_mode_info`, `task-id`, `task-notification`, `task_id`, `task_type`, `ask_user`, `user-prompt-submit-hook`, `local-command-stdout`, `local-command-caveat`, `retrieval_status`, `persisted-output`, `tool_use_error`

---

## CLI Wrapper

```bash
threadbase-scanner list [--limit 20] [--offset 0] [--sort recent] [--since 7d] [--json] [--tier standard]
threadbase-scanner search "query" [--limit 20] [--json] [--fields content,project]
threadbase-scanner show <session-id-prefix> [--json]
threadbase-scanner profiles list|add|remove
threadbase-scanner scan [--tier full]
```

---

## App Integration

| App | Integration |
|---|---|
| **VS Code** | `import { scan, search } from '@threadbase/scanner'` — replaces `src/core/scanner.ts` + `indexer.ts` |
| **Electron** | `import { scan, search } from '@threadbase/scanner'` — replaces `src/main/services/scanner.ts` + `indexer.ts` |
| **Mobile** | `import { scan, search } from '@threadbase/scanner'` — new capability |
| **IntelliJ** | Adds to `webview/package.json` — replaces `ConversationScanner.kt` |
| **CLI** | The package IS the CLI — `npx @threadbase/scanner` or global install |

---

## Feature Origin Map

| Feature | Origin | Notes |
|---|---|---|
| `**/*.jsonl` glob discovery | VS Code | Finds all files including nested subagents |
| Directory exclusions (`memory/`, `tool-results/`) | IntelliJ | Prevents false matches |
| Subagent/teammate detection | VS Code | Path-based + first-message XML tag |
| Git branch detection | IntelliJ/CLI | Walks up to `.git/HEAD` |
| Model extraction | IntelliJ | From first assistant message metadata |
| Tool name collection | CLI | Deduplicated set from all messages |
| 5 sort modes | CLI | recent, oldest, messages-desc, messages-asc, alpha |
| Since filter (duration + ISO date) | CLI | `7d`, `2w`, `24h`, `2024-01-15` |
| FlexSearch indexing | VS Code/Electron | Forward tokenization, context-aware snippets |
| LRU metadata cache | IntelliJ | Configurable capacity |
| Batch streaming (`onBatch`) | VS Code | Incremental UI updates |
| Progress callback | Electron/VS Code | Accurate progress with total count |
| Content tiers | All (unified) | Configurable preview/snippet limits |
| Pagination (limit/offset) | New | First-class across all operations |
| Immutable sort/filter | CLI | Returns new arrays, never mutates input |
| Pre-compiled tag regex | IntelliJ | Most maintainable approach |
| Profile `scanHistory` toggle | Electron | Per-profile opt-out |
