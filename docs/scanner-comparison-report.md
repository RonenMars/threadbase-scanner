# Threadbase Scanner Comparison Report

> **Generated:** 2026-04-18
> **Scope:** All scanner implementations across threadbase-electron, threadbase-vscode, threadbase-intellij, threadbase-cli, and threadbase-mobile

---

## Executive Summary

All four implemented scanners (Electron, VS Code, IntelliJ, CLI) serve the same purpose: **scanning Claude Code conversation history files (JSONL format) from the local filesystem**. They share a common architecture pattern but differ meaningfully in implementation details, capabilities, and limits. The mobile app has no scanner implementation yet — only camera permissions configured for future QR code scanning (a completely different concept).

---

## 1. Platform Overview

| Dimension | Electron | VS Code | IntelliJ | CLI | Mobile |
|---|---|---|---|---|---|
| **Language** | TypeScript | TypeScript | Kotlin | Go | TypeScript (React Native) |
| **Runtime** | Node.js | Node.js | JVM (Coroutines) | Go stdlib | Expo/React Native |
| **Scanner Type** | Conversation file scanner | Conversation file scanner | Conversation file scanner | Session file scanner | QR code scanner (planned, not implemented) |
| **File** | `src/main/services/scanner.ts` | `src/core/scanner.ts` | `core/scanner/ConversationScanner.kt` | `internal/scan/scan.go` | N/A |
| **Lines of Code** | ~627 | ~650+ | ~400+ | ~163 | 0 |
| **Test File** | `scanner.test.ts` (~909 lines) | `scanner.test.ts` | `ConversationScannerTest.kt` | `scan_test.go` | N/A |

---

## 2. File Discovery Strategy

| Dimension | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| **Discovery Method** | `readdir` + manual directory walk | `fast-glob` (`fg("**/*.jsonl")`) | `listDirectoryEntries` + recursive walk | `os.ReadDir` (flat, single-level) |
| **External Deps** | None (Node.js built-ins only) | `fast-glob` | None (Kotlin/Java NIO) | None (Go stdlib only) |
| **Recursion Depth** | Finds `.jsonl` files in project subdirs | Unlimited (`**/*.jsonl` glob) | Recursive with exclusions | Single level only (project dir → jsonl files) |
| **Skip Patterns** | Dot-prefixed dirs | None (glob handles it) | Dot-prefixed, `memory/`, `subagents/`, `tool-results/` | Non-dirs, non-`.jsonl` files |
| **Empty File Handling** | Checks `stat.size === 0`, skips | Checks `stat.size > 0`, skips empty | Checks `fileSize() > 0`, skips | Delegates to parser |

### Key Differences

- **VS Code uses `fast-glob`** — the only scanner with an external dependency for file discovery. This gives it the most flexible file-finding capability (`**/*.jsonl` matches any nesting depth).
- **IntelliJ is the most defensive** — explicitly skips `memory/`, `subagents/`, and `tool-results/` directories during recursion, preventing false matches.
- **CLI is the simplest** — flat single-level directory scan with no recursion, meaning it will miss JSONL files nested deeper than `projects/<project>/<file>.jsonl`.
- **Electron manually walks** directories but does find nested JSONL files via a helper `findJsonlFiles` method.

---

## 3. Batch Processing & Concurrency

| Dimension | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| **Batch Size** | 10 | 12 | Sequential (no batching) | Sequential (no batching) |
| **Concurrency Model** | `Promise.all` per batch | `Promise.all` per batch | `withContext(Dispatchers.IO)` (sequential within) | Sequential for-loop |
| **Progress Callback** | `onProgress(scanned, total)` — knows total upfront | `onProgress(scanned, scanned)` — total = scanned (incremental) | `onProgress(scanned, scanned)` — same as VS Code | None |
| **Batch Callback** | None | `onBatch(metas[])` — emits each batch of results | None | None |

### Key Differences

- **Electron collects all file tasks first**, then processes in batches — this means it knows the total file count upfront and can report accurate progress percentages.
- **VS Code streams results** via `onBatch` callback, allowing the UI to incrementally display conversations as they're scanned. It also uses a slightly larger batch size (12 vs 10).
- **IntelliJ and CLI process sequentially** — no parallel file parsing. IntelliJ runs on `Dispatchers.IO` but processes files one at a time within that context.

---

## 4. Content Limits

| Dimension | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| **Preview Max** | **1,200 chars** | **200 chars** | **200 chars** | Delegated to `parse.ParseMeta` |
| **Content Snippet Max** | **50,000 chars** | **5,000 chars** | **5,000 chars** | Delegated to `parse.ParseMeta` |

### Key Differences

- **Electron stores 10x more snippet content** (50K vs 5K) and 6x more preview text (1,200 vs 200). This is likely because the Electron app has more screen real estate and can display richer conversation previews.
- **VS Code and IntelliJ use identical limits** (200 preview, 5,000 snippet), suggesting they were aligned at some point.
- **CLI delegates** content extraction to a separate `parse.ParseMeta` function in the `internal/parse` package, separating scanning from parsing concerns.

---

## 5. Caching Strategy

| Dimension | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| **Metadata Cache** | `Map<string, ConversationMeta>` (unlimited) | `Map<string, ConversationMeta>` (unlimited) | `lruMap(100)` — LRU, max 100 | None |
| **Conversation Cache** | LRU Map, max **5** | LRU Map, max **5** | LRU Map, max **5** | None |
| **Session ID Index** | None | None | `MutableMap` (unlimited) | None |
| **Projects Set** | `Set<string>` tracks unique projects | `Set<string>` tracks unique projects | None | None |
| **Cache Clearing** | On `scanAllMeta()` — clears all caches | On `scanAllMeta()` — clears all caches | On `scanAllMeta()` — clears all caches | N/A |

### Key Differences

- **IntelliJ caps metadata cache at 100** entries via a custom LRU `LinkedHashMap`. Electron and VS Code keep all metadata in an unbounded `Map`.
- **IntelliJ maintains a separate `sessionIdIndex`** — a non-LRU map mapping session IDs to metadata, allowing O(1) lookups by session ID. Other scanners don't have this.
- **CLI has no caching at all** — appropriate for a stateless CLI tool where each invocation is independent.
- All three desktop scanners share the same conversation LRU size of 5.

---

## 6. Metadata Extraction

| Field | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| `id` / file path | ✅ | ✅ | ✅ | ✅ |
| `sessionId` | ✅ | ✅ | ✅ | ✅ |
| `sessionName` / `slug` | ✅ | ✅ | ✅ | ❌ |
| `timestamp` | ✅ | ✅ | ✅ | ✅ (`LastUpdatedAt`) |
| `messageCount` | ✅ | ✅ | ✅ | ✅ |
| `preview` | ✅ (1,200 chars) | ✅ (200 chars) | ✅ (200 chars) | ✅ |
| `contentSnippet` | ✅ (50K chars) | ✅ (5K chars) | ✅ (5K chars) | ❌ |
| `lastMessageSender` | ✅ | ✅ | ✅ | ❌ |
| `projectPath` / `cwd` | ✅ | ✅ | ✅ | ✅ |
| `projectName` | ✅ (decoded from dir) | ✅ (from path) | ✅ (decoded from dir) | ✅ |
| `account` / profile ID | ✅ | ✅ | ✅ | ✅ |
| **`gitBranch`** | ❌ | ❌ | ✅ | ✅ |
| **`model`** | ❌ | ❌ | ✅ | ❌ |
| **`isTeammate`** | ❌ | ✅ | ❌ | ❌ |
| **`teamName`** | ❌ | ✅ | ❌ | ❌ |
| **`toolNames[]`** | ❌ | ❌ | ❌ | ✅ |

### Key Differences

- **Git branch detection**: Only IntelliJ and CLI extract the git branch. IntelliJ reads `.git/HEAD` by walking up the directory tree (up to 6 levels). CLI does the same via `ReadGitBranch()`. Electron and VS Code don't capture this at the scanner level.
- **Model extraction**: Only IntelliJ extracts the model name (e.g., `claude-sonnet-4-20250514`) from message metadata during scanning.
- **Teammate/subagent detection**: Only VS Code detects whether a conversation belongs to a teammate or subagent (via `isTeammate` and `teamName` fields parsed from `<teammate-message>` XML tags).
- **Tool name collection**: Only CLI tracks which tool names were used in a session (`toolNames[]`).

---

## 7. Profile Handling

| Dimension | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| **Filter Criteria** | `p.enabled && p.scanHistory !== false` | `p.enabled` | Takes `configDirs` as parameter (caller filters) | `p.Enabled` |
| **Config Dir Resolution** | `~` expansion in constructor | `~` expansion in constructor | Caller provides `Path` objects | Raw `ConfigDir` string |
| **Multi-Profile Merge** | Yes, in single `scanAllMeta` call | Yes, in single `scanAllMeta` call | Yes, in single `scanAllMeta` call | Yes, via `ScanProfiles()` wrapper |

### Key Differences

- **Electron has a `scanHistory` toggle** — profiles can opt out of history scanning even when enabled. This is the only scanner with this capability.
- **IntelliJ decouples profile filtering** from the scanner — `configDirs` are passed in as parameters, so the caller (HistoryService) handles profile resolution.
- **CLI separates single vs multi-profile scanning** into `ScanProfile()` and `ScanProfiles()` functions.

---

## 8. Sorting & Filtering

| Dimension | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| **Default Sort** | Newest first (by timestamp) | Newest first (by timestamp) | Newest first (by timestamp) | Newest first (by `LastUpdatedAt`) |
| **Sort Options** | 1 (newest first only) | 1 (newest first only) | 1 (newest first only) | **5 modes**: Recent, Oldest, MessagesDesc, MessagesAsc, Alpha |
| **Time Filtering** | None | None | None | `ApplySinceFilter(cutoff)` |
| **Immutable Sort** | No (sorts in-place) | No (sorts in-place) | No (sorts in-place via `sortByDescending`) | **Yes** — returns new slice, input unchanged |

### Key Differences

- **CLI is the only scanner with multiple sort modes** (5 options) and time-based filtering. This makes sense for a CLI tool where users pass flags like `--sort=oldest` or `--since=1h`.
- **CLI preserves immutability** — `ApplySort` creates a new slice rather than mutating the input. The desktop scanners all sort in-place.

---

## 9. System Tag Cleaning

| Tag | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| `system-reminder` | ✅ | ✅ | ✅ | N/A (in `parse` pkg) |
| `thinking` | ✅ | ✅ | ✅ | N/A |
| `command-name` | ✅ | ✅ | ✅ | N/A |
| `ide_selection` | ✅ | ✅ | ✅ | N/A |
| `fast_mode_info` | ✅ | ✅ | ✅ | N/A |
| `task-id` / `task-notification` | ✅ | ✅ | ✅ | N/A |
| `ask_user` | ✅ | ✅ | ✅ | N/A |
| `user-prompt-submit-hook` | ❓ | ✅ | ✅ | N/A |
| **Approach** | Regex-based strip | Regex-based strip | Pre-compiled `Regex` with tag list | Delegated to parser |

All three desktop scanners strip the same core set of Claude Code system tags. IntelliJ uses a pre-compiled regex built from a tag list, which is the most maintainable approach.

---

## 10. Tool Result Classification

| Tool Type | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| Edit | ✅ | ✅ | ✅ | ❌ (metadata only) |
| Write | ✅ | ✅ | ✅ | ❌ |
| Read | ✅ | ✅ | ✅ | ❌ |
| Bash | ✅ | ✅ (typed `BashToolResult`) | ✅ | ❌ |
| Grep | ✅ | ✅ | ✅ | ❌ |
| Glob | ✅ | ✅ | ✅ | ❌ |
| TaskAgent | ✅ | ✅ | ✅ | ❌ |
| TaskCreate / TaskUpdate | ✅ | ✅ | ✅ | ❌ |
| Generic (fallback) | ✅ | ✅ | ✅ | ❌ |

### Key Differences

- **VS Code has a typed `BashToolResult`** with explicit `stdout` and `stderr` fields — more structured than the other scanners.
- **CLI doesn't classify tool results** — it only collects tool names in `toolNames[]` for filtering purposes, leaving full conversation parsing out of scope.

---

## 11. Error Handling Philosophy

| Dimension | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| Malformed JSON lines | Skips silently | Skips silently | Skips silently | Skips (in parser) |
| Missing directories | `ENOENT` check, continues | `ENOENT` check, continues | `exists()` check, continues | `os.IsNotExist`, returns nil |
| File parse failures | `catch` → logs, returns null | `catch` → logs, returns null | `catch` → skips entirely | `continue` |
| Empty conversations | Filtered (messageCount > 0) | Filtered (messageCount > 0) | Filtered (messageCount > 0) | Filtered in parser |
| Error propagation | Errors logged, never thrown | Errors logged, never thrown | Errors swallowed (no logging) | Returns `error` to caller |

### Key Differences

- **CLI is the only scanner that propagates errors** to the caller via Go's `error` return value. All others swallow errors internally.
- **IntelliJ silently swallows all exceptions** with empty `catch` blocks — the least observable error handling.
- **Electron and VS Code** log errors to console before continuing.

---

## 12. External Dependencies

| Scanner | External Dependencies |
|---|---|
| **Electron** | None — Node.js built-ins only (`fs`, `readline`, `path`, `os`) |
| **VS Code** | `fast-glob` for file discovery |
| **IntelliJ** | `kotlinx-serialization-json` for JSON parsing |
| **CLI** | None — Go stdlib only (`os`, `path/filepath`, `bufio`, `sort`) |
| **Mobile** | `expo-camera` (installed but unused) |

---

## 13. Architecture Patterns

| Pattern | Electron | VS Code | IntelliJ | CLI |
|---|---|---|---|---|
| **Class-based** | ✅ `ConversationScanner` | ✅ `ConversationScanner` | ✅ `ConversationScanner` | ❌ Package-level functions |
| **Stateful** | ✅ (caches in instance) | ✅ (caches in instance) | ✅ (caches in instance) | ❌ Stateless |
| **Provider Abstraction** | `ClaudeProvider` wraps scanner | `HistoryService` wraps scanner | `HistoryService` wraps scanner | Direct usage from `cmd/scan.go` |
| **Parsing Separated** | Inline in scanner | Inline in scanner | Inline in scanner | ✅ Separate `internal/parse` package |

### Key Differences

- **CLI separates scanning from parsing** — `scan.go` handles file discovery and orchestration, while `parse.ParseMeta` handles JSONL parsing. The desktop scanners combine both in a single class.
- **CLI is stateless** with package-level functions — no class, no caching. Each invocation starts fresh.
- All desktop scanners follow the same `ConversationScanner` class pattern with internal caching.

---

## 14. Notable Unique Features

### Electron Only
- Largest content limits (50K snippet, 1.2K preview)
- `scanHistory` profile toggle
- `decodeProjectName()` for encoded directory names
- Pre-counts total files for accurate progress reporting

### VS Code Only
- `fast-glob` for flexible file discovery
- `onBatch` streaming callback for incremental UI updates
- Teammate/subagent detection (`isTeammate`, `teamName`)
- Typed `BashToolResult` with stdout/stderr

### IntelliJ Only
- LRU-capped metadata cache (100 entries)
- Separate `sessionIdIndex` for O(1) session lookups
- Git branch detection in scanner
- Model name extraction during scanning
- Pre-compiled regex for system tag cleaning
- Skips `memory/`, `subagents/`, `tool-results/` directories

### CLI Only
- 5 sort modes (Recent, Oldest, MessagesDesc, MessagesAsc, Alpha)
- `ApplySinceFilter` time-based filtering
- Immutable sort (returns new slice)
- Tool name collection (`toolNames[]`)
- Clean separation of scan and parse packages
- Proper Go error propagation

---

## 15. Potential Alignment Opportunities

| Issue | Details |
|---|---|
| **Git branch detection** | IntelliJ and CLI have it; Electron and VS Code don't. Consider adding to all. |
| **Teammate detection** | Only VS Code detects teammates/subagents. Others should likely support this as Claude Code's team features grow. |
| **Content snippet limits** | Electron uses 50K vs 5K elsewhere — is this intentional or drift? |
| **Preview limits** | Electron uses 1,200 vs 200 — same question. |
| **Recursive file discovery** | CLI only scans one level deep — will miss nested JSONL files that IntelliJ explicitly handles. |
| **Directory exclusions** | IntelliJ skips `memory/`, `subagents/`, `tool-results/` — others don't. This could cause false matches. |
| **Model extraction** | Only IntelliJ does this — useful metadata that other scanners could capture cheaply. |
| **Error observability** | IntelliJ swallows all errors silently — hardest to debug. |
| **`scanHistory` toggle** | Electron-only feature — could be useful in other platforms. |
| **Sort/filter capabilities** | CLI has rich sorting — desktop scanners sort newest-first only (sorting is presumably done in the UI layer). |

---

## 16. Mobile Scanner (Planned, Not Implemented)

The mobile app is the outlier — it's configured for **QR code scanning**, not conversation file scanning:

- **Dependency**: `expo-camera` v17.0.10 (installed)
- **Permissions**: iOS `NSCameraUsageDescription` and Android `CAMERA` permission configured
- **Purpose**: "QR code scanning during server setup" (per permission strings)
- **Status**: No scanner component, no scan result handling, no camera UI exists
- **Onboarding reference**: `app/onboarding.tsx` mentions generating a "QR-scannable URL" but doesn't implement the scanner side

This is fundamentally different from the other four scanners and shares no code or architecture with them.
