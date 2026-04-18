# Implementation Spec: `@threadbase/scanner`

> **Date:** 2026-04-18
> **Design Doc:** [2026-04-18-unified-scanner-design.md](./2026-04-18-unified-scanner-design.md)
> **Package Name:** `@threadbase/scanner`
> **Language:** TypeScript
> **Runtime:** Node.js (>=18)

---

## 1. Package Structure

```
scanner/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                  # Public API exports
    types.ts                  # All interfaces and types
    scanner.ts                # ConversationScanner class (main orchestrator)
    discovery.ts              # File discovery (fast-glob)
    parser.ts                 # JSONL line-by-line parsing
    indexer.ts                # FlexSearch-based search indexing
    filters.ts                # Sort, since-filter, include-filter, pagination
    cache.ts                  # LRU cache implementation
    git.ts                    # Git branch detection
    profiles.ts               # Profile loading and resolution
    tags.ts                   # System tag cleaning regex
    tiers.ts                  # Content tier definitions and management
    utils.ts                  # Shared helpers (path decoding, timestamp parsing)
  cli/
    index.ts                  # CLI entry point
    commands/
      list.ts                 # list command
      search.ts               # search command
      show.ts                 # show command
      scan.ts                 # scan (refresh) command
      profiles.ts             # profiles subcommands
  __tests__/
    scanner.test.ts
    discovery.test.ts
    parser.test.ts
    indexer.test.ts
    filters.test.ts
    cache.test.ts
    git.test.ts
    profiles.test.ts
    tags.test.ts
    tiers.test.ts
    integration.test.ts       # End-to-end scan + search
```

---

## 2. Dependencies

### Runtime
- `fast-glob` — file discovery (`**/*.jsonl`)
- `flexsearch` — full-text search indexing
- `commander` — CLI framework

### Dev
- `vitest` — test runner
- `typescript` — compiler
- `tsup` — bundler (ESM + CJS dual output)
- `@types/node` — Node.js type definitions

---

## 3. Module Specifications

### 3.1 `types.ts` — All Interfaces

```typescript
// --- Core Types ---

export type MessageSender = 'user' | 'assistant'
export type Include = 'all' | 'conversations' | 'subagents' | 'teammates'
export type View = 'flat' | 'tree' | 'grouped'
export type SortOrder = 'recent' | 'oldest' | 'messages-desc' | 'messages-asc' | 'alpha'

export interface Profile {
  id: string
  label: string
  configDir: string            // absolute or ~-prefixed
  enabled: boolean
  emoji?: string
  scanHistory?: boolean        // false = exclude from scanning (Electron feature)
}

export interface ContentTier {
  name: string
  previewMax: number
  snippetMax: number
}

export interface ConversationMeta {
  id: string                   // filePath as unique key
  filePath: string
  sessionId: string
  sessionName: string
  projectPath: string
  projectName: string
  account: string
  timestamp: string            // ISO-8601
  messageCount: number
  lastMessageSender: MessageSender
  preview: string
  contentSnippet: string
  gitBranch: string | null
  model: string | null
  isSubagent: boolean
  parentSessionId: string | null
  isTeammate: boolean
  teamName: string | null
  toolNames: string[]
}

export interface TreeConversation extends ConversationMeta {
  subagents: ConversationMeta[]
}

export interface GroupedConversations {
  [teamName: string]: ConversationMeta[]
}

// --- Options ---

export interface ScanOptions {
  profiles?: Profile[]
  tier?: string
  tiers?: Record<string, ContentTier>   // custom tier definitions
  include?: Include
  view?: View
  sort?: SortOrder
  since?: string
  project?: string
  account?: string
  limit?: number
  offset?: number
  onProgress?: (scanned: number, total: number) => void
  onBatch?: (metas: ConversationMeta[]) => void
}

export interface ScanResult {
  conversations: ConversationMeta[] | TreeConversation[] | GroupedConversations
  total: number
  scanned: number
}

export interface SearchOptions extends ScanOptions {
  fields?: string[]
}

export interface SearchMatch {
  field: string
  snippet: string
}

export interface SearchResult {
  meta: ConversationMeta
  score: number
  matches: SearchMatch[]
}

export interface GetConversationOptions {
  profiles?: Profile[]
}

// --- Full Conversation ---

export interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolUseId: string
  type: 'edit' | 'write' | 'read' | 'bash' | 'grep' | 'glob' |
        'taskAgent' | 'taskCreate' | 'taskUpdate' | 'generic'
  content: Record<string, unknown>
  isError?: boolean
}

export interface MessageMetadata {
  model?: string
  stopReason?: string | null
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  toolUses?: string[]
  toolUseBlocks?: ToolUseBlock[]
  toolResults?: ToolResult[]
  teamName?: string
  teamInfo?: TeamInfo
}

export interface TeamInfo {
  teammateId: string
  summary: string
  color?: string
}

export interface ConversationMessage {
  role: MessageSender
  text: string
  timestamp: string
  uuid?: string
  metadata?: MessageMetadata
  thinkingContent?: string
}

export interface Conversation {
  id: string
  filePath: string
  projectPath: string
  projectName: string
  sessionId: string
  sessionName: string
  messages: ConversationMessage[]
  fullText: string
  timestamp: string
  messageCount: number
  account: string
}
```

### 3.2 `discovery.ts` — File Discovery

```typescript
export async function discoverJsonlFiles(
  projectsDirs: { projectsDir: string; account: string }[],
  onProgress?: (found: number) => void
): Promise<{ filePath: string; account: string }[]>
```

**Implementation:**
- For each `projectsDir`, run `fast-glob("**/*.jsonl", { cwd: projectsDir, absolute: true })`
- Filter results: exclude paths containing `/memory/` or `/tool-results/` segments
- Skip dot-prefixed directories (handled by fast-glob `dot: false` default)
- Stat each file, skip where `size === 0`
- Return `{ filePath, account }` pairs
- Call `onProgress` after each directory is globbed

### 3.3 `parser.ts` — JSONL Parsing

Two functions, mirroring CLI's clean separation:

```typescript
export async function parseMeta(
  filePath: string,
  account: string,
  tier: ContentTier
): Promise<ConversationMeta | null>

export async function parseConversation(
  filePath: string,
  account: string
): Promise<Conversation | null>
```

**`parseMeta` logic:**
1. Open file with `readline.createInterface`
2. For each line, `JSON.parse` (skip malformed lines silently)
3. Skip entries where `isMeta === true`
4. Only process `type === 'user'` or `type === 'assistant'`
5. Extract on first occurrence: `cwd`, `sessionId`, `slug`, `teamName`
6. Track `timestamp` — always keep latest
7. Count messages (entries with content or tool results)
8. Build `preview` (up to `tier.previewMax` chars) from cleaned content
9. Build `contentSnippet` (up to `tier.snippetMax` chars) from cleaned content
10. Detect subagent: `filePath.includes('/subagents/')`
11. Derive `parentSessionId` from path structure if subagent
12. Detect teammate: check first user message for `<teammate-message` tag
13. Extract `model` from first assistant message's `message.model` field
14. Collect `toolNames` — deduplicated set of all `tool_use.name` values
15. Track `lastMessageSender`
16. Return null if `messageCount === 0`

**`parseConversation` logic:**
1. Full file parse — builds `ConversationMessage[]` array
2. Match `tool_use` blocks with `tool_result` blocks via `tool_use_id`
3. Classify tool results into typed categories
4. Extract thinking content separately
5. Build `fullText` from all message content
6. Collect `TeamInfo` and propagate to matching messages

### 3.4 `tags.ts` — System Tag Cleaning

```typescript
export function cleanSystemTags(text: string): string
```

**Implementation:**
- Pre-compiled regex built from tag list (IntelliJ pattern)
- Tags: `system-reminder`, `thinking`, `command-name`, `command-message`, `command-args`, `ide_selection`, `ide_opened_file`, `fast_mode_info`, `task-id`, `task-notification`, `task_id`, `task_type`, `ask_user`, `user-prompt-submit-hook`, `local-command-stdout`, `local-command-caveat`, `retrieval_status`, `persisted-output`, `tool_use_error`
- Regex: `<(tag1|tag2|...)[\s\S]*?<\/\1>` plus self-closing `<(tag1|tag2|...)\s*\/>`
- After tag removal: collapse whitespace, limit consecutive blank lines to 2, trim

### 3.5 `git.ts` — Git Branch Detection

```typescript
export function readGitBranch(projectPath: string): string | null
```

**Implementation (from IntelliJ/CLI):**
- Walk up directory tree from `projectPath` looking for `.git/HEAD`
- Max 6 levels up (IntelliJ's limit)
- Parse: `ref: refs/heads/<branch>` -> return `<branch>`
- Detached HEAD (raw SHA) -> return `"(detached)"`
- Not found -> return `null`
- Synchronous (`readFileSync`) — called per-file during meta parsing

### 3.6 `cache.ts` — LRU Cache

```typescript
export class LRUCache<K, V> {
  constructor(capacity: number)
  get(key: K): V | undefined
  set(key: K, value: V): void
  has(key: K): boolean
  delete(key: K): boolean
  clear(): void
  get size(): number
}
```

**Implementation:**
- Based on `Map` with access-order tracking (delete + re-set on access)
- Evicts oldest entry when capacity exceeded
- Used for metadata cache (default 500) and conversation cache (default 5)

### 3.7 `filters.ts` — Sorting, Filtering, Pagination

```typescript
export function applySinceFilter(
  metas: ConversationMeta[],
  since: string
): ConversationMeta[]

export function applySort(
  metas: ConversationMeta[],
  order: SortOrder
): ConversationMeta[]

export function applyIncludeFilter(
  metas: ConversationMeta[],
  include: Include
): ConversationMeta[]

export function applyProjectFilter(
  metas: ConversationMeta[],
  project: string
): ConversationMeta[]

export function applyAccountFilter(
  metas: ConversationMeta[],
  account: string
): ConversationMeta[]

export function applyPagination<T>(
  items: T[],
  limit: number,
  offset: number
): { items: T[]; total: number }

export function parseSinceCutoff(value: string): Date
```

**All filter/sort functions are immutable** — return new arrays (CLI pattern).

**`parseSinceCutoff`** supports:
- Duration: `7d`, `24h`, `2w` (hours, days, weeks)
- ISO date: `2024-01-15`

**Sort modes:**
- `recent`: newest first by `timestamp`
- `oldest`: oldest first by `timestamp`
- `messages-desc`: highest `messageCount` first
- `messages-asc`: lowest `messageCount` first
- `alpha`: alphabetical by `projectName`, then `preview`

### 3.8 `indexer.ts` — Search Index

```typescript
export class SearchIndexer {
  constructor()
  addDocument(meta: ConversationMeta): void
  buildIndex(metas: ConversationMeta[]): void
  search(query: string, options?: { fields?: string[]; limit?: number }): SearchResult[]
  getDocumentCount(): number
  clear(): void
}
```

**Implementation:**
- FlexSearch `Document` index with forward tokenization
- Indexed fields: `contentSnippet`, `projectName`, `projectPath`, `sessionId`, `sessionName`, `account`, `model`, `gitBranch`, `toolNamesJoined` (toolNames joined with space)
- Stored fields: all `ConversationMeta` fields (for retrieval without re-scanning)
- Resolution: 9, cache: 100
- `search()` returns results with context-aware snippets (80 chars before + 120 after match)
- Empty query returns most recent conversations (sorted by timestamp)
- Deduplicates results across field matches

### 3.9 `profiles.ts` — Profile Management

```typescript
export async function loadProfiles(configPath?: string): Promise<Profile[]>
export async function saveProfiles(profiles: Profile[], configPath?: string): Promise<void>
export async function detectDefaultProfile(): Promise<Profile>
export function resolveConfigDir(configDir: string): string  // ~ expansion
export function getProjectsDir(profile: Profile): string
```

**Default config path:** `~/.config/threadbase-scanner/profiles.json`

**`detectDefaultProfile`:** Creates a profile pointing to `~/.claude` if no config exists.

**Profile filtering for scanning:**
- `enabled === true`
- `scanHistory !== false` (Electron's per-profile opt-out)

### 3.10 `tiers.ts` — Content Tier Management

```typescript
export const DEFAULT_TIERS: Record<string, ContentTier> = {
  standard: { name: 'standard', previewMax: 200, snippetMax: 5_000 },
  full: { name: 'full', previewMax: 1_200, snippetMax: 50_000 },
}

export function resolveTier(
  tierName: string,
  customTiers?: Record<string, ContentTier>
): ContentTier
```

**`resolveTier`:** Looks up tier by name in custom tiers first, then defaults. Throws if not found.

### 3.11 `scanner.ts` — Main Orchestrator

```typescript
export class ConversationScanner {
  constructor(options?: { metadataCacheSize?: number; conversationCacheSize?: number })

  async scan(options?: ScanOptions): Promise<ScanResult>
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  async getConversation(id: string, options?: GetConversationOptions): Promise<Conversation | null>

  // For apps that need raw access
  getMetadataCache(): Map<string, ConversationMeta>
  getProjects(): string[]
}
```

**`scan()` flow:**
1. Resolve profiles (from options or auto-detect)
2. Filter profiles (`enabled`, `scanHistory`)
3. Resolve tier
4. Discover JSONL files via `discoverJsonlFiles()`
5. Process in batches of 12 (`Promise.all` per batch)
6. For each file: `parseMeta()` + `readGitBranch()`
7. Populate metadata cache and session ID index
8. Call `onBatch` after each batch
9. Call `onProgress` after each file
10. Apply filters: `include` -> `project` -> `account` -> `since`
11. Apply sort
12. Transform to requested `view` (flat/tree/grouped)
13. Apply pagination
14. Return `ScanResult`

**`search()` flow:**
1. If index is empty, run `scan()` first (without pagination)
2. Build/refresh FlexSearch index
3. Run search query
4. Apply same filters as `scan()`
5. Apply pagination
6. Return `SearchResult[]`

**`getConversation()` flow:**
1. Check conversation LRU cache
2. If miss, check metadata cache for file path
3. If miss, check session ID index
4. If found, call `parseConversation(filePath, account)`
5. Cache result in conversation LRU
6. Return `Conversation | null`

### 3.12 `index.ts` — Public Exports

```typescript
export { ConversationScanner } from './scanner'
export { scan, search, getConversation } from './standalone'
export * from './types'
export { DEFAULT_TIERS } from './tiers'
export { loadProfiles, saveProfiles, detectDefaultProfile } from './profiles'
```

**Standalone functions** (convenience wrappers that create a scanner instance):

```typescript
export async function scan(options?: ScanOptions): Promise<ScanResult> {
  const scanner = new ConversationScanner()
  return scanner.scan(options)
}

export async function search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
  const scanner = new ConversationScanner()
  return scanner.search(query, options)
}

export async function getConversation(id: string, options?: GetConversationOptions): Promise<Conversation | null> {
  const scanner = new ConversationScanner()
  return scanner.getConversation(id, options)
}
```

---

## 4. CLI Commands

### 4.1 `list`

```bash
threadbase-scanner list [options]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `--limit`, `-l` | number | 20 | Max results |
| `--offset` | number | 0 | Skip N results |
| `--sort`, `-s` | string | `recent` | Sort order |
| `--since` | string | — | Time filter (`7d`, `2w`, `2024-01-15`) |
| `--project`, `-p` | string | — | Filter by project |
| `--account`, `-a` | string | — | Filter by profile |
| `--include` | string | `all` | `all\|conversations\|subagents\|teammates` |
| `--tier` | string | `standard` | Content tier |
| `--json` | boolean | false | JSON output |

### 4.2 `search`

```bash
threadbase-scanner search <query> [options]
```

Same flags as `list`, plus:

| Flag | Type | Default | Description |
|---|---|---|---|
| `--fields` | string | — | Comma-separated field list |

### 4.3 `show`

```bash
threadbase-scanner show <session-id-prefix> [--json]
```

- Prefix-matches session ID
- Errors on no match or ambiguous match
- Displays full conversation with messages

### 4.4 `scan`

```bash
threadbase-scanner scan [--tier full] [--json]
```

- Force re-scan, displays summary
- Optionally outputs JSON of all metadata

### 4.5 `profiles`

```bash
threadbase-scanner profiles list
threadbase-scanner profiles add <name> <config-dir>
threadbase-scanner profiles remove <name>
```

---

## 5. View Transformations

### Flat (default)

Returns `ConversationMeta[]` as-is after filtering/sorting.

### Tree

```typescript
function toTree(metas: ConversationMeta[]): TreeConversation[] {
  // 1. Separate parents from subagents
  // 2. For each subagent, find parent by parentSessionId
  // 3. Attach to parent's subagents[] array
  // 4. Return parents only (with subagents nested)
  // 5. Orphan subagents (no parent found) become top-level
}
```

### Grouped

```typescript
function toGrouped(metas: ConversationMeta[]): GroupedConversations {
  // 1. Group by teamName
  // 2. Non-teammate conversations go under key "_default"
  // 3. Each group sorted by timestamp descending
}
```

---

## 6. Error Handling

Following existing patterns across all scanners:

- **Malformed JSON lines**: skip silently, continue
- **Missing directories**: log warning, continue (don't throw)
- **File parse failures**: log warning, return null (skip conversation)
- **Empty conversations**: filter out (messageCount === 0)
- **All public methods**: never throw — return empty results or null
- **CLI**: catches errors at command level, prints to stderr, exits with code 1

---

## 7. Testing Strategy

### Unit Tests (per module)
- `discovery.test.ts`: mock filesystem, verify glob patterns, exclusions
- `parser.test.ts`: fixture JSONL files, verify all field extraction
- `indexer.test.ts`: build index, verify search results and snippets
- `filters.test.ts`: verify each filter/sort mode, immutability
- `cache.test.ts`: verify LRU eviction behavior
- `git.test.ts`: mock `.git/HEAD` files, verify branch extraction
- `profiles.test.ts`: load/save/detect profiles
- `tags.test.ts`: verify all system tags are stripped
- `tiers.test.ts`: resolve built-in and custom tiers

### Integration Tests
- `scanner.test.ts`: full scan with fixture directory structure
- `integration.test.ts`: scan -> search -> getConversation flow

### Test Fixtures
- `__fixtures__/` directory with sample JSONL files covering:
  - Normal conversation (user + assistant messages)
  - Subagent conversation (in `subagents/` path)
  - Teammate conversation (with `<teammate-message>` tag)
  - Conversation with tool uses (all tool types)
  - Empty file
  - Malformed JSON lines
  - Multi-profile structure

---

## 8. Build & Publish

### `package.json` key fields:

```json
{
  "name": "@threadbase/scanner",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "threadbase-scanner": "dist/cli/index.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "engines": { "node": ">=18" }
}
```

### Build with `tsup`:
- Dual output: ESM (`dist/index.js`) + CJS (`dist/index.cjs`)
- Type declarations: `dist/index.d.ts`
- CLI bundled separately: `dist/cli/index.js`

---

## 9. Migration Path for Apps

### Phase 1: Publish `@threadbase/scanner` v0.1.0
- Standalone package with full API and CLI

### Phase 2: Migrate each app (one at a time)
1. **VS Code**: Replace `src/core/scanner.ts` + `src/core/indexer.ts` with imports from `@threadbase/scanner`. Adapt `HistoryService` to use new API.
2. **Electron**: Replace `src/main/services/scanner.ts` + `src/main/services/indexer.ts`. Adapt `ClaudeProvider` to wrap new scanner.
3. **Mobile**: Add `@threadbase/scanner` as dependency. Build conversation history UI using scan/search API.
4. **IntelliJ**: Add to `webview/package.json`. Replace `ConversationScanner.kt` with calls through webview bridge.

### Phase 3: Remove old scanner code from each app
