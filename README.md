# @threadbase/scanner

Unified Claude Code conversation history scanner.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Combines the best parts of four independent scanner implementations (VS Code, Electron, IntelliJ, CLI) into a single TypeScript package.

## Features

- **Persistent SQLite index** (default) — durable metadata/search index with incremental byte-offset updates: after the first scan, a grown conversation file is re-read for only its appended bytes. Opt out with `persistent: false` for a pure in-memory scan.
- **Deep discovery** — `**/*.jsonl` glob finds all conversations including subagents (1,472 conversations vs 351-497 from individual scanners)
- **Full metadata extraction** — session ID, project, git branch, model, tool names, teammate/subagent detection
- **Full-text search** — SQLite FTS5 (persistent) or FlexSearch (in-memory) across content and metadata
- **File watching** — optional chokidar watcher with a periodic-rescan correctness backstop, emitting change events
- **Bounded conversation paging** — read a message window without parsing the whole file, via byte-offset checkpoints
- **Configurable content tiers** — `standard` (200/5K) and `full` (1,200/50K) preview/snippet limits, extensible
- **Multiple views** — flat, tree (parent + subagents), grouped (by team)
- **Filtering** — by project, account, time range, conversation type (conversations/subagents/teammates)
- **5 sort modes** — recent, oldest, messages-desc, messages-asc, alphabetical
- **Pagination** — limit/offset on all operations
- **Multi-profile** — scan multiple Claude config directories
- **LRU caching** — metadata and conversation caches for fast repeated access
- **Git branch detection** — reads `.git/HEAD` with parent directory walking

## Installation

```bash
npm install @threadbase-sh/scanner
```

**Requires Node.js 18 or later.** The package uses `better-sqlite3` (a native module) for its persistent index; prebuilt binaries are downloaded for common platforms, with a node-gyp fallback otherwise.

### Persistent vs. in-memory

By default the scanner maintains a durable SQLite index at `~/.config/threadbase-scanner/index.db`, so repeated scans only re-read files that changed and search/list queries are indexed. To opt out of the native dependency and use the legacy in-memory path, construct with `persistent: false` (or pass `--no-persist` to the CLI):

```typescript
const scanner = new ConversationScanner({ persistent: false }) // in-memory, no DB
const scanner2 = new ConversationScanner({ persistent: { dbPath: '/tmp/tb.db' } }) // custom DB
```

## Library Usage

```typescript
import { scan, search, getConversation, ConversationScanner } from '@threadbase/scanner'

// Quick scan with defaults
const result = await scan()
console.log(`Found ${result.total} conversations`)

// Scan with options
const filtered = await scan({
  sort: 'recent',
  since: '7d',
  project: 'my-app',
  include: 'conversations', // exclude subagents/teammates
  tier: 'full',             // larger previews
  limit: 20,
  offset: 0,
})

// Full-text search
const results = await search('authentication bug', {
  limit: 10,
  project: 'backend',
})

for (const r of results) {
  console.log(r.meta.projectName, r.matches[0]?.snippet)
}

// Load full conversation
const conv = await getConversation(results[0].meta.id)
for (const msg of conv.messages) {
  console.log(`[${msg.role}] ${msg.text.slice(0, 100)}`)
}
```

### Using the class directly

```typescript
import { ConversationScanner } from '@threadbase/scanner'

const scanner = new ConversationScanner({ conversationCacheSize: 10 })

// Scan with progress and batch callbacks
const result = await scanner.scan({
  onProgress: (scanned, total) => console.log(`${scanned}/${total}`),
  onBatch: (metas) => {
    // Incrementally update UI as batches complete
    for (const meta of metas) {
      addToList(meta)
    }
  },
})

// Reuse the scanner instance for cached lookups
const conv = await scanner.getConversation(someId)

// Bounded page — reads only the requested window (persistent mode seeks from a
// checkpoint instead of parsing the whole file)
const page = await scanner.getConversationPage(someId, { limit: 50 })

// Collision-safe sessionId lookup (session ids are not unique)
const all = scanner.getConversationsBySessionId('sess-123')

// Release the SQLite connection when done
scanner.close()
```

### Watching for changes (persistent mode)

```typescript
const scanner = new ConversationScanner() // persistent by default

scanner.on('change', ({ filePath, meta }) => {
  // meta is the fresh ConversationMeta, or null if the file was removed
  refreshUI(meta)
})

await scanner.watch() // filesystem watcher + periodic rescan backstop
// ... later
await scanner.unwatch()
```

### View modes

```typescript
// Flat (default) — all conversations in a single list
await scan({ view: 'flat' })

// Tree — parent conversations with nested subagents
await scan({ view: 'tree' })
// Returns TreeConversation[] with .subagents array

// Grouped — conversations grouped by team name
await scan({ view: 'grouped' })
// Returns { [teamName: string]: ConversationMeta[] }
```

### Custom content tiers

```typescript
await scan({
  tier: 'compact',
  tiers: {
    compact: { name: 'compact', previewMax: 50, snippetMax: 500 },
  },
})
```

### Shared default scanner

The convenience functions `scan`, `search`, and `getConversation` share a lazy module-level `ConversationScanner` so the FlexSearch index and conversation LRU survive across calls. A first `scan()` warms state; a subsequent `search()` reuses the already-built index instead of re-walking the filesystem.

```typescript
import { scan, search, getConversation, resetDefaultScanner } from '@threadbase/scanner'

await scan({ profiles })          // warms the shared scanner
await search('auth', { profiles }) // hits the in-memory index — no re-scan
await getConversation(id)         // LRU hit on subsequent calls for the same id

// Drop shared state (e.g. between tests, or to force a fresh scan)
resetDefaultScanner()
```

To run isolated state (parallel scans with different options, multi-tenant hosts, etc.) pass an explicit scanner as the optional third parameter:

```typescript
import { ConversationScanner, scan, search } from '@threadbase/scanner'

const work = new ConversationScanner()
const personal = new ConversationScanner()

await scan({ profiles: workProfiles }, work)
await scan({ profiles: personalProfiles }, personal)

const results = await search('query', { limit: 20 }, work)
```

The shared scanner does **not** auto-refresh: it reflects the filesystem at the time of the first scan. Call `resetDefaultScanner()` (or `scan()` again) when you need to pick up newly-created `.jsonl` files.

### Logging

The library uses [pino](https://getpino.io) internally and ships with a default **silent** logger, so embedding it produces no console output unless you opt in.

```typescript
import pino from 'pino'
import { setLogger, createLogger } from '@threadbase/scanner'

// Use your own pino instance
setLogger(pino({ level: 'info' }))

// Or build one from options
setLogger(createLogger({ level: 'debug' }))
```

The CLI installs a `pino-pretty` transport on stderr at level `info` by default. Override with the `LOG_LEVEL` env var:

```bash
LOG_LEVEL=debug threadbase-scanner scan
LOG_LEVEL=silent threadbase-scanner list --json
```

Log events the scanner emits include `scan: start` / `scan: complete` (with timings + counts), `search: start` / `search: complete`, batched discovery summaries, parse-failure warnings, and `getConversation` cache-hit traces. Previously-swallowed errors (broken JSONL, inaccessible files, missing config dirs) now surface as `warn`-level events with structured context — useful for diagnosing why a particular conversation didn't show up.

### Profiles

```typescript
import { loadProfiles, saveProfiles } from '@threadbase/scanner'

// Load from ~/.config/threadbase-scanner/profiles.json
const profiles = await loadProfiles('~/.config/threadbase-scanner')

// Scan specific profiles
await scan({
  profiles: [
    { id: 'work', label: 'Work', configDir: '~/.claude-work', enabled: true },
    { id: 'personal', label: 'Personal', configDir: '~/.claude', enabled: true },
  ],
})
```

## CLI Usage

```bash
# Install globally
npm install -g @threadbase/scanner

# Scan all conversations
threadbase-scanner scan

# List recent conversations
threadbase-scanner list --limit 20 --sort recent

# List with filters
threadbase-scanner list --since 7d --project my-app --include conversations

# Full-text search
threadbase-scanner search "fix bug" --limit 10

# Show a full conversation (prefix match on session ID)
threadbase-scanner show 879dd66c

# JSON output (for piping)
threadbase-scanner list --json | jq '.conversations[].projectName'

# Profile management
threadbase-scanner profiles list
threadbase-scanner profiles add work ~/.claude-work
threadbase-scanner profiles remove work
```

### CLI Flags

| Flag | Commands | Description |
|---|---|---|
| `--limit, -l` | list, search | Max results (default: 20) |
| `--offset` | list, search | Skip N results (default: 0) |
| `--sort, -s` | list, search | `recent\|oldest\|messages-desc\|messages-asc\|alpha` |
| `--since` | list, search | Time filter: `7d`, `2w`, `24h`, `2024-01-15` |
| `--project, -p` | list, search | Filter by project name/path |
| `--account, -a` | list, search | Filter by profile account |
| `--include` | list | `all\|conversations\|subagents\|teammates` |
| `--tier` | list, scan | Content tier: `standard\|full` |
| `--json` | all | JSON output |

## ConversationMeta Fields

Every scanned conversation produces a `ConversationMeta` with the full superset of fields from all four original scanners:

| Field | Type | Origin |
|---|---|---|
| `id` | string | All |
| `filePath` | string | All |
| `sessionId` | string | All |
| `sessionName` | string | All |
| `projectPath` | string | All |
| `projectName` | string | All |
| `account` | string | All |
| `timestamp` | string (ISO-8601) | All |
| `messageCount` | number | All |
| `lastMessageSender` | `'user' \| 'assistant'` | Electron/VS Code/IntelliJ |
| `preview` | string | All (tier-dependent) |
| `contentSnippet` | string | Electron/VS Code/IntelliJ (tier-dependent) |
| `gitBranch` | string \| null | IntelliJ/CLI |
| `model` | string \| null | IntelliJ |
| `isSubagent` | boolean | VS Code |
| `parentSessionId` | string \| null | VS Code |
| `isTeammate` | boolean | VS Code |
| `teamName` | string \| null | VS Code |
| `toolNames` | string[] | CLI |

## Development

```bash
npm install
npm test          # run tests
npm run build     # build ESM + CJS + types
npm run lint      # type check
```

## Contributing

Small bugfixes and parser improvements are welcome. For design changes, please open an issue first to discuss the shape before opening a PR.

- Use conventional commits (`feat:`, `fix:`, `chore:`, etc.) — see [`CLAUDE.md`](./CLAUDE.md) for project conventions.
- Run `npm run lint && npm test` before opening a PR.
- New features need an integration or e2e test in `__tests__/`; new parser cases need a fixture in `__fixtures__/`.

## Architecture

```
src/
  index.ts        Public API exports + standalone functions
  types.ts        All interfaces (ConversationMeta, ScanOptions, etc.)
  scanner.ts      ConversationScanner class (main orchestrator)
  discovery.ts    File discovery (fast-glob + exclusions)
  parser.ts       JSONL parsing (meta + full conversation)
  indexer.ts      FlexSearch-based search indexing
  filters.ts      Sort, since-filter, include, pagination
  cache.ts        LRU cache
  git.ts          Git branch detection
  profiles.ts     Profile management
  tags.ts         System tag cleaning
  tiers.ts        Content tier definitions
  logger.ts       Pino-based logger seam (silent by default)
cli/
  index.ts        CLI entry point (commander)
  commands/       list, search, show, scan, profiles
```
