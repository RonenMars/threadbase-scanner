# Unified Scanner (`@threadbase/scanner`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single npm package that replaces all four scanner implementations (VS Code, Electron, IntelliJ, CLI) with the best parts of each, packaged as both a library and a CLI tool.

**Architecture:** TypeScript library with three layers: core engine (discovery, JSONL parser, FlexSearch indexer, LRU cache, git detection, profiles), API layer (scan/search/getConversation), and a thin CLI wrapper (commander). All apps import the library; the CLI is just another consumer.

**Tech Stack:** TypeScript, Node.js >=18, fast-glob, flexsearch, commander, vitest, tsup

---

## File Structure

```
scanner/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                  # Public API exports + standalone convenience functions
    types.ts                  # All interfaces and types
    scanner.ts                # ConversationScanner class (main orchestrator)
    discovery.ts              # File discovery (fast-glob + exclusions)
    parser.ts                 # JSONL line-by-line parsing (meta + full)
    indexer.ts                # FlexSearch-based search indexing
    filters.ts                # Sort, since-filter, include-filter, pagination
    cache.ts                  # LRU cache implementation
    git.ts                    # Git branch detection
    profiles.ts               # Profile loading and resolution
    tags.ts                   # System tag cleaning regex
    tiers.ts                  # Content tier definitions and management
  cli/
    index.ts                  # CLI entry point (commander setup)
    commands/
      list.ts
      search.ts
      show.ts
      scan.ts
      profiles.ts
  __tests__/
    tags.test.ts
    cache.test.ts
    git.test.ts
    tiers.test.ts
    filters.test.ts
    discovery.test.ts
    parser.test.ts
    indexer.test.ts
    scanner.test.ts
  __fixtures__/
    valid-conversation.jsonl
    subagent-conversation.jsonl
    teammate-conversation.jsonl
    empty.jsonl
    malformed.jsonl
    tool-use-conversation.jsonl
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `scanner/package.json`
- Create: `scanner/tsconfig.json`
- Create: `scanner/vitest.config.ts`

- [ ] **Step 1: Create package.json**

```bash
mkdir -p ~/Desktop/threadbase/scanner
```

Create `scanner/package.json`:
```json
{
  "name": "@threadbase/scanner",
  "version": "0.1.0",
  "description": "Unified Claude Code conversation history scanner",
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
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "fast-glob": "^3.3.0",
    "flexsearch": "^0.7.43"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `scanner/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "cli/**/*.ts"],
  "exclude": ["node_modules", "dist", "__tests__", "__fixtures__"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `scanner/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['__tests__/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Create tsup.config.ts**

Create `scanner/tsup.config.ts`:
```typescript
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: ['cli/index.ts'],
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
  },
])
```

- [ ] **Step 5: Install dependencies**

```bash
cd scanner && npm install
```

- [ ] **Step 6: Verify setup compiles**

Create a minimal `scanner/src/index.ts`:
```typescript
export const VERSION = '0.1.0'
```

Run:
```bash
cd scanner && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add scanner/package.json scanner/tsconfig.json scanner/vitest.config.ts scanner/tsup.config.ts scanner/src/index.ts
git commit -m "feat(scanner): scaffold @threadbase/scanner package"
```

---

### Task 2: Types

**Files:**
- Create: `scanner/src/types.ts`

- [ ] **Step 1: Write all type definitions**

Create `scanner/src/types.ts`:
```typescript
// ─── Primitives ─────────────────────────────────────────────────────

export type MessageSender = 'user' | 'assistant'
export type Include = 'all' | 'conversations' | 'subagents' | 'teammates'
export type View = 'flat' | 'tree' | 'grouped'
export type SortOrder = 'recent' | 'oldest' | 'messages-desc' | 'messages-asc' | 'alpha'

export const VALID_SORT_ORDERS: SortOrder[] = [
  'recent', 'oldest', 'messages-desc', 'messages-asc', 'alpha',
]

// ─── Profile ────────────────────────────────────────────────────────

export interface Profile {
  id: string
  label: string
  configDir: string
  enabled: boolean
  emoji?: string
  scanHistory?: boolean
}

// ─── Content Tiers ──────────────────────────────────────────────────

export interface ContentTier {
  name: string
  previewMax: number
  snippetMax: number
}

// ─── ConversationMeta (full superset) ───────────────────────────────

export interface ConversationMeta {
  id: string
  filePath: string
  sessionId: string
  sessionName: string
  projectPath: string
  projectName: string
  account: string
  timestamp: string
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

// ─── View Variants ──────────────────────────────────────────────────

export interface TreeConversation extends ConversationMeta {
  subagents: ConversationMeta[]
}

export interface GroupedConversations {
  [groupKey: string]: ConversationMeta[]
}

// ─── Options ────────────────────────────────────────────────────────

export interface ScanOptions {
  profiles?: Profile[]
  tier?: string
  tiers?: Record<string, ContentTier>
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

// ─── Full Conversation ──────────────────────────────────────────────

export interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  toolUseId: string
  type: 'edit' | 'write' | 'read' | 'bash' | 'grep' | 'glob' |
        'taskAgent' | 'taskCreate' | 'taskUpdate' | 'generic'
  content: Record<string, unknown>
  isError?: boolean
}

export interface TeamInfo {
  teammateId: string
  summary?: string
  color?: string
}

export interface MessageMetadata {
  model?: string
  stopReason?: string | null
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  gitBranch?: string
  version?: string
  toolUses?: string[]
  toolUseBlocks?: ToolUseBlock[]
  toolResults?: ToolResultBlock[]
  teamName?: string
  teamInfo?: TeamInfo
}

export interface ConversationMessage {
  role: MessageSender
  text: string
  timestamp: string
  uuid?: string
  metadata?: MessageMetadata
  isToolResult?: boolean
  isThinking?: boolean
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

- [ ] **Step 2: Verify types compile**

```bash
cd scanner && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add scanner/src/types.ts
git commit -m "feat(scanner): add unified type definitions (superset of all scanners)"
```

---

### Task 3: System Tag Cleaning + Content Tiers

**Files:**
- Create: `scanner/src/tags.ts`
- Create: `scanner/src/tiers.ts`
- Create: `scanner/__tests__/tags.test.ts`
- Create: `scanner/__tests__/tiers.test.ts`

- [ ] **Step 1: Write failing tests for tags**

Create `scanner/__tests__/tags.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { cleanSystemTags } from '../src/tags'

describe('cleanSystemTags', () => {
  it('removes system-reminder tags', () => {
    const input = 'Hello <system-reminder>some reminder</system-reminder> world'
    expect(cleanSystemTags(input)).toBe('Hello world')
  })

  it('removes thinking tags', () => {
    const input = 'Before <thinking>internal thoughts</thinking> after'
    expect(cleanSystemTags(input)).toBe('Before after')
  })

  it('removes multiple different tags', () => {
    const input = '<command-name>test</command-name> Hello <fast_mode_info>info</fast_mode_info>'
    expect(cleanSystemTags(input)).toBe('Hello')
  })

  it('handles multiline tag content', () => {
    const input = 'Start <system-reminder>\nline1\nline2\n</system-reminder> end'
    expect(cleanSystemTags(input)).toBe('Start end')
  })

  it('collapses whitespace', () => {
    const input = 'Hello    world   here'
    expect(cleanSystemTags(input)).toBe('Hello world here')
  })

  it('limits consecutive blank lines to 2', () => {
    const input = 'line1\n\n\n\n\nline2'
    expect(cleanSystemTags(input)).toBe('line1\n\nline2')
  })

  it('returns empty string for all-tag input', () => {
    const input = '<system-reminder>only tags</system-reminder>'
    expect(cleanSystemTags(input)).toBe('')
  })

  it('removes all known tag types', () => {
    const tags = [
      'system-reminder', 'command-name', 'command-message', 'command-args',
      'ide_selection', 'ide_opened_file', 'local-command-stdout',
      'local-command-caveat', 'retrieval_status', 'task_id', 'task_type',
      'task-id', 'task-notification', 'fast_mode_info', 'persisted-output',
      'tool_use_error', 'user-prompt-submit-hook', 'thinking', 'ask_user',
      'teammate-message',
    ]
    for (const tag of tags) {
      const input = `before <${tag}>content</${tag}> after`
      expect(cleanSystemTags(input)).toBe('before after')
    }
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/tags.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement tags.ts**

Create `scanner/src/tags.ts`:
```typescript
const SYSTEM_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'ide_selection',
  'ide_opened_file',
  'local-command-stdout',
  'local-command-caveat',
  'retrieval_status',
  'task_id',
  'task_type',
  'task-id',
  'task-notification',
  'fast_mode_info',
  'persisted-output',
  'tool_use_error',
  'user-prompt-submit-hook',
  'thinking',
  'ask_user',
  'teammate-message',
]

const SYSTEM_TAG_RE = new RegExp(
  `<(${SYSTEM_TAGS.join('|')})[^>]*>[\\s\\S]*?<\\/\\1>`,
  'g',
)

export function cleanSystemTags(text: string): string {
  return text
    .replace(SYSTEM_TAG_RE, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/tags.test.ts
```
Expected: PASS

- [ ] **Step 5: Write failing tests for tiers**

Create `scanner/__tests__/tiers.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { DEFAULT_TIERS, resolveTier } from '../src/tiers'

describe('DEFAULT_TIERS', () => {
  it('has standard tier', () => {
    expect(DEFAULT_TIERS.standard).toEqual({
      name: 'standard',
      previewMax: 200,
      snippetMax: 5_000,
    })
  })

  it('has full tier', () => {
    expect(DEFAULT_TIERS.full).toEqual({
      name: 'full',
      previewMax: 1_200,
      snippetMax: 50_000,
    })
  })
})

describe('resolveTier', () => {
  it('resolves built-in tier by name', () => {
    expect(resolveTier('standard')).toEqual(DEFAULT_TIERS.standard)
  })

  it('resolves custom tier over built-in', () => {
    const custom = { compact: { name: 'compact', previewMax: 50, snippetMax: 500 } }
    expect(resolveTier('compact', custom)).toEqual(custom.compact)
  })

  it('falls back to built-in if not in custom', () => {
    expect(resolveTier('full', {})).toEqual(DEFAULT_TIERS.full)
  })

  it('throws for unknown tier', () => {
    expect(() => resolveTier('nonexistent')).toThrow('Unknown tier')
  })
})
```

- [ ] **Step 6: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/tiers.test.ts
```
Expected: FAIL

- [ ] **Step 7: Implement tiers.ts**

Create `scanner/src/tiers.ts`:
```typescript
import type { ContentTier } from './types'

export const DEFAULT_TIERS: Record<string, ContentTier> = {
  standard: { name: 'standard', previewMax: 200, snippetMax: 5_000 },
  full: { name: 'full', previewMax: 1_200, snippetMax: 50_000 },
}

export function resolveTier(
  tierName: string,
  customTiers?: Record<string, ContentTier>,
): ContentTier {
  const tier = customTiers?.[tierName] ?? DEFAULT_TIERS[tierName]
  if (!tier) {
    throw new Error(`Unknown tier "${tierName}". Available: ${Object.keys({ ...DEFAULT_TIERS, ...customTiers }).join(', ')}`)
  }
  return tier
}
```

- [ ] **Step 8: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/tiers.test.ts
```
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add scanner/src/tags.ts scanner/src/tiers.ts scanner/__tests__/tags.test.ts scanner/__tests__/tiers.test.ts
git commit -m "feat(scanner): add system tag cleaning and content tier management"
```

---

### Task 4: LRU Cache

**Files:**
- Create: `scanner/src/cache.ts`
- Create: `scanner/__tests__/cache.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scanner/__tests__/cache.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { LRUCache } from '../src/cache'

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
  })

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string, number>(3)
    expect(cache.get('missing')).toBeUndefined()
  })

  it('evicts oldest entry when capacity exceeded', () => {
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3) // evicts 'a'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('accessing a key makes it recently used', () => {
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // 'a' is now most recent
    cache.set('c', 3) // evicts 'b', not 'a'
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })

  it('reports correct size', () => {
    const cache = new LRUCache<string, number>(5)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.size).toBe(2)
  })

  it('clear removes all entries', () => {
    const cache = new LRUCache<string, number>(5)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })

  it('has returns correct value', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
  })

  it('delete removes entry', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    expect(cache.delete('a')).toBe(true)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.delete('b')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/cache.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement cache.ts**

Create `scanner/src/cache.ts`:
```typescript
export class LRUCache<K, V> {
  private map = new Map<K, V>()
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // Move to end (most recently used)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value!
      this.map.delete(oldest)
    }
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/cache.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scanner/src/cache.ts scanner/__tests__/cache.test.ts
git commit -m "feat(scanner): add LRU cache implementation"
```

---

### Task 5: Git Branch Detection

**Files:**
- Create: `scanner/src/git.ts`
- Create: `scanner/__tests__/git.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scanner/__tests__/git.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readGitBranch } from '../src/git'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('readGitBranch', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'git-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns branch name from .git/HEAD', () => {
    mkdirSync(join(tempDir, '.git'), { recursive: true })
    writeFileSync(join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(readGitBranch(tempDir)).toBe('main')
  })

  it('returns feature branch name', () => {
    mkdirSync(join(tempDir, '.git'), { recursive: true })
    writeFileSync(join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/feature/my-branch\n')
    expect(readGitBranch(tempDir)).toBe('feature/my-branch')
  })

  it('returns (detached) for commit hash', () => {
    mkdirSync(join(tempDir, '.git'), { recursive: true })
    writeFileSync(join(tempDir, '.git', 'HEAD'), 'abc1234def5678901234567890abcdef12345678\n')
    expect(readGitBranch(tempDir)).toBe('(detached)')
  })

  it('walks up directories to find .git', () => {
    mkdirSync(join(tempDir, '.git'), { recursive: true })
    writeFileSync(join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/develop\n')
    const subDir = join(tempDir, 'src', 'deep')
    mkdirSync(subDir, { recursive: true })
    expect(readGitBranch(subDir)).toBe('develop')
  })

  it('returns null if no .git found', () => {
    expect(readGitBranch(tempDir)).toBeNull()
  })

  it('returns null for empty path', () => {
    expect(readGitBranch('')).toBeNull()
  })

  it('respects max depth of 6 levels', () => {
    // .git is 7 levels up — should not be found
    mkdirSync(join(tempDir, '.git'), { recursive: true })
    writeFileSync(join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const deepDir = join(tempDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g')
    mkdirSync(deepDir, { recursive: true })
    expect(readGitBranch(deepDir)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/git.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement git.ts**

Create `scanner/src/git.ts`:
```typescript
import { readFileSync } from 'fs'
import { join, dirname } from 'path'

const REF_PREFIX = 'ref: refs/heads/'
const MAX_DEPTH = 6

export function readGitBranch(projectPath: string): string | null {
  if (!projectPath) return null

  let dir = projectPath
  let depth = 0

  while (depth < MAX_DEPTH) {
    const headPath = join(dir, '.git', 'HEAD')
    try {
      const content = readFileSync(headPath, 'utf-8').trim()
      if (content.startsWith(REF_PREFIX)) {
        return content.slice(REF_PREFIX.length)
      }
      // Detached HEAD: raw commit SHA
      if (content.length >= 7) {
        return '(detached)'
      }
      return null
    } catch {
      // .git/HEAD not found at this level
    }

    const parent = dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
    depth++
  }

  return null
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/git.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scanner/src/git.ts scanner/__tests__/git.test.ts
git commit -m "feat(scanner): add git branch detection (walks up to .git/HEAD)"
```

---

### Task 6: Filters (Sort, Since, Include, Pagination)

**Files:**
- Create: `scanner/src/filters.ts`
- Create: `scanner/__tests__/filters.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scanner/__tests__/filters.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import {
  applySort,
  applySinceFilter,
  applyIncludeFilter,
  applyProjectFilter,
  applyAccountFilter,
  applyPagination,
  parseSinceCutoff,
} from '../src/filters'
import type { ConversationMeta } from '../src/types'

function makeMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'test',
    filePath: '/test.jsonl',
    sessionId: 'sess-1',
    sessionName: '',
    projectPath: '/project',
    projectName: 'project',
    account: 'default',
    timestamp: '2026-01-01T00:00:00Z',
    messageCount: 5,
    lastMessageSender: 'user',
    preview: 'test preview',
    contentSnippet: 'test snippet',
    gitBranch: null,
    model: null,
    isSubagent: false,
    parentSessionId: null,
    isTeammate: false,
    teamName: null,
    toolNames: [],
    ...overrides,
  }
}

describe('applySort', () => {
  const metas = [
    makeMeta({ id: 'a', timestamp: '2026-01-01T00:00:00Z', messageCount: 10, projectName: 'beta' }),
    makeMeta({ id: 'b', timestamp: '2026-03-01T00:00:00Z', messageCount: 2, projectName: 'alpha' }),
    makeMeta({ id: 'c', timestamp: '2026-02-01T00:00:00Z', messageCount: 5, projectName: 'gamma' }),
  ]

  it('sorts recent (newest first)', () => {
    const result = applySort(metas, 'recent')
    expect(result.map(m => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts oldest first', () => {
    const result = applySort(metas, 'oldest')
    expect(result.map(m => m.id)).toEqual(['a', 'c', 'b'])
  })

  it('sorts by messages descending', () => {
    const result = applySort(metas, 'messages-desc')
    expect(result.map(m => m.id)).toEqual(['a', 'c', 'b'])
  })

  it('sorts by messages ascending', () => {
    const result = applySort(metas, 'messages-asc')
    expect(result.map(m => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts alphabetically by projectName', () => {
    const result = applySort(metas, 'alpha')
    expect(result.map(m => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate input array', () => {
    const original = [...metas]
    applySort(metas, 'recent')
    expect(metas.map(m => m.id)).toEqual(original.map(m => m.id))
  })
})

describe('applySinceFilter', () => {
  it('filters by cutoff date', () => {
    const metas = [
      makeMeta({ id: 'old', timestamp: '2025-01-01T00:00:00Z' }),
      makeMeta({ id: 'new', timestamp: '2026-06-01T00:00:00Z' }),
    ]
    const result = applySinceFilter(metas, '2026-01-01')
    expect(result.map(m => m.id)).toEqual(['new'])
  })
})

describe('applyIncludeFilter', () => {
  const metas = [
    makeMeta({ id: 'conv', isSubagent: false, isTeammate: false }),
    makeMeta({ id: 'sub', isSubagent: true }),
    makeMeta({ id: 'team', isTeammate: true }),
  ]

  it('returns all when include is "all"', () => {
    expect(applyIncludeFilter(metas, 'all')).toHaveLength(3)
  })

  it('returns only conversations', () => {
    const result = applyIncludeFilter(metas, 'conversations')
    expect(result.map(m => m.id)).toEqual(['conv'])
  })

  it('returns only subagents', () => {
    const result = applyIncludeFilter(metas, 'subagents')
    expect(result.map(m => m.id)).toEqual(['sub'])
  })

  it('returns only teammates', () => {
    const result = applyIncludeFilter(metas, 'teammates')
    expect(result.map(m => m.id)).toEqual(['team'])
  })
})

describe('applyProjectFilter', () => {
  it('filters by project path', () => {
    const metas = [
      makeMeta({ id: 'a', projectPath: '/home/user/project-a' }),
      makeMeta({ id: 'b', projectPath: '/home/user/project-b' }),
    ]
    const result = applyProjectFilter(metas, 'project-a')
    expect(result.map(m => m.id)).toEqual(['a'])
  })
})

describe('applyAccountFilter', () => {
  it('filters by account', () => {
    const metas = [
      makeMeta({ id: 'a', account: 'work' }),
      makeMeta({ id: 'b', account: 'personal' }),
    ]
    const result = applyAccountFilter(metas, 'work')
    expect(result.map(m => m.id)).toEqual(['a'])
  })
})

describe('applyPagination', () => {
  const items = [1, 2, 3, 4, 5]

  it('returns first page', () => {
    const result = applyPagination(items, 2, 0)
    expect(result).toEqual({ items: [1, 2], total: 5 })
  })

  it('returns second page', () => {
    const result = applyPagination(items, 2, 2)
    expect(result).toEqual({ items: [3, 4], total: 5 })
  })

  it('returns partial last page', () => {
    const result = applyPagination(items, 2, 4)
    expect(result).toEqual({ items: [5], total: 5 })
  })

  it('returns empty for offset beyond length', () => {
    const result = applyPagination(items, 2, 10)
    expect(result).toEqual({ items: [], total: 5 })
  })
})

describe('parseSinceCutoff', () => {
  it('parses day duration', () => {
    const cutoff = parseSinceCutoff('7d')
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000)
  })

  it('parses hour duration', () => {
    const cutoff = parseSinceCutoff('24h')
    const expected = Date.now() - 24 * 60 * 60 * 1000
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000)
  })

  it('parses week duration', () => {
    const cutoff = parseSinceCutoff('2w')
    const expected = Date.now() - 2 * 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000)
  })

  it('parses ISO date', () => {
    const cutoff = parseSinceCutoff('2024-01-15')
    expect(cutoff.toISOString().startsWith('2024-01-15')).toBe(true)
  })

  it('throws on invalid format', () => {
    expect(() => parseSinceCutoff('abc')).toThrow()
  })

  it('throws on empty string', () => {
    expect(() => parseSinceCutoff('')).toThrow()
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/filters.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement filters.ts**

Create `scanner/src/filters.ts`:
```typescript
import type { ConversationMeta, SortOrder, Include } from './types'

export function applySort(metas: ConversationMeta[], order: SortOrder): ConversationMeta[] {
  const out = [...metas]
  switch (order) {
    case 'recent':
      out.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      break
    case 'oldest':
      out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      break
    case 'messages-desc':
      out.sort((a, b) => b.messageCount - a.messageCount)
      break
    case 'messages-asc':
      out.sort((a, b) => a.messageCount - b.messageCount)
      break
    case 'alpha':
      out.sort((a, b) => {
        const cmp = a.projectName.localeCompare(b.projectName)
        return cmp !== 0 ? cmp : a.preview.localeCompare(b.preview)
      })
      break
  }
  return out
}

export function applySinceFilter(metas: ConversationMeta[], since: string): ConversationMeta[] {
  const cutoff = parseSinceCutoff(since)
  return metas.filter(m => new Date(m.timestamp).getTime() >= cutoff.getTime())
}

export function applyIncludeFilter(metas: ConversationMeta[], include: Include): ConversationMeta[] {
  switch (include) {
    case 'all':
      return metas
    case 'conversations':
      return metas.filter(m => !m.isSubagent && !m.isTeammate)
    case 'subagents':
      return metas.filter(m => m.isSubagent)
    case 'teammates':
      return metas.filter(m => m.isTeammate)
  }
}

export function applyProjectFilter(metas: ConversationMeta[], project: string): ConversationMeta[] {
  const lower = project.toLowerCase()
  return metas.filter(m =>
    m.projectPath.toLowerCase().includes(lower) ||
    m.projectName.toLowerCase().includes(lower),
  )
}

export function applyAccountFilter(metas: ConversationMeta[], account: string): ConversationMeta[] {
  return metas.filter(m => m.account === account)
}

export function applyPagination<T>(items: T[], limit: number, offset: number): { items: T[]; total: number } {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
  }
}

export function parseSinceCutoff(value: string): Date {
  const s = value.trim()
  if (!s) throw new Error('Empty --since value')

  // Try ISO date
  const isoMatch = s.match(/^\d{4}-\d{2}-\d{2}$/)
  if (isoMatch) {
    const d = new Date(s + 'T00:00:00Z')
    if (!isNaN(d.getTime())) return d
  }

  // Try duration: digits + unit
  const durationMatch = s.match(/^(\d+)([hdw])$/)
  if (!durationMatch) {
    throw new Error(`Invalid --since value "${s}": expected duration like "7d", "24h", "2w" or ISO date "2006-01-02"`)
  }

  const n = parseInt(durationMatch[1], 10)
  const unit = durationMatch[2]
  let ms: number
  switch (unit) {
    case 'h': ms = n * 60 * 60 * 1000; break
    case 'd': ms = n * 24 * 60 * 60 * 1000; break
    case 'w': ms = n * 7 * 24 * 60 * 60 * 1000; break
    default: throw new Error(`Invalid unit "${unit}"`)
  }

  return new Date(Date.now() - ms)
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/filters.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scanner/src/filters.ts scanner/__tests__/filters.test.ts
git commit -m "feat(scanner): add sort, filter, pagination, and since-cutoff parsing"
```

---

### Task 7: File Discovery

**Files:**
- Create: `scanner/src/discovery.ts`
- Create: `scanner/__tests__/discovery.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scanner/__tests__/discovery.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { discoverJsonlFiles } from '../src/discovery'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('discoverJsonlFiles', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discovery-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function createFile(relativePath: string, content = '{"type":"user"}\n') {
    const fullPath = join(tempDir, relativePath)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content)
  }

  it('finds .jsonl files', async () => {
    createFile('project/session.jsonl')
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: 'default' }])
    expect(result).toHaveLength(1)
    expect(result[0].filePath).toContain('session.jsonl')
    expect(result[0].account).toBe('default')
  })

  it('finds nested .jsonl files (recursive)', async () => {
    createFile('project/uuid1/session.jsonl')
    createFile('project/uuid1/subagents/agent.jsonl')
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: 'default' }])
    expect(result).toHaveLength(2)
  })

  it('skips empty files', async () => {
    createFile('project/empty.jsonl', '')
    createFile('project/nonempty.jsonl', '{"type":"user"}\n')
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: 'default' }])
    expect(result).toHaveLength(1)
    expect(result[0].filePath).toContain('nonempty.jsonl')
  })

  it('skips memory/ directories', async () => {
    createFile('project/memory/notes.jsonl')
    createFile('project/session.jsonl')
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: 'default' }])
    expect(result).toHaveLength(1)
  })

  it('skips tool-results/ directories', async () => {
    createFile('project/tool-results/output.jsonl')
    createFile('project/session.jsonl')
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: 'default' }])
    expect(result).toHaveLength(1)
  })

  it('does NOT skip subagents/ directories', async () => {
    createFile('project/uuid/subagents/agent.jsonl')
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: 'default' }])
    expect(result).toHaveLength(1)
  })

  it('skips dot-prefixed directories', async () => {
    createFile('.hidden/session.jsonl')
    createFile('project/session.jsonl')
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: 'default' }])
    expect(result).toHaveLength(1)
  })

  it('handles non-existent directory gracefully', async () => {
    const result = await discoverJsonlFiles([{ projectsDir: '/nonexistent/path', account: 'default' }])
    expect(result).toEqual([])
  })

  it('scans multiple directories', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'discovery-test2-'))
    createFile('project/a.jsonl')
    mkdirSync(join(dir2, 'project'), { recursive: true })
    writeFileSync(join(dir2, 'project', 'b.jsonl'), '{"type":"user"}\n')

    const result = await discoverJsonlFiles([
      { projectsDir: tempDir, account: 'account1' },
      { projectsDir: dir2, account: 'account2' },
    ])
    expect(result).toHaveLength(2)
    expect(result.find(r => r.account === 'account1')).toBeDefined()
    expect(result.find(r => r.account === 'account2')).toBeDefined()

    rmSync(dir2, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/discovery.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement discovery.ts**

Create `scanner/src/discovery.ts`:
```typescript
import fg from 'fast-glob'
import { stat } from 'fs/promises'

export interface DiscoveredFile {
  filePath: string
  account: string
}

const EXCLUDED_SEGMENTS = ['/memory/', '/tool-results/']

export async function discoverJsonlFiles(
  dirs: { projectsDir: string; account: string }[],
  onProgress?: (found: number) => void,
): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = []

  for (const { projectsDir, account } of dirs) {
    let filePaths: string[]
    try {
      filePaths = await fg('**/*.jsonl', {
        cwd: projectsDir,
        absolute: true,
        dot: false,
      })
    } catch {
      continue
    }

    // Filter out excluded directory segments
    const filtered = filePaths.filter(fp =>
      !EXCLUDED_SEGMENTS.some(seg => fp.includes(seg)),
    )

    // Filter out empty files
    for (const filePath of filtered) {
      try {
        const s = await stat(filePath)
        if (s.size > 0) {
          results.push({ filePath, account })
        }
      } catch {
        // Skip inaccessible files
      }
    }

    onProgress?.(results.length)
  }

  return results
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/discovery.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scanner/src/discovery.ts scanner/__tests__/discovery.test.ts
git commit -m "feat(scanner): add file discovery with fast-glob and directory exclusions"
```

---

### Task 8: JSONL Parser

**Files:**
- Create: `scanner/src/parser.ts`
- Create: `scanner/__tests__/parser.test.ts`
- Create: `scanner/__fixtures__/valid-conversation.jsonl`
- Create: `scanner/__fixtures__/subagent-conversation.jsonl`
- Create: `scanner/__fixtures__/teammate-conversation.jsonl`
- Create: `scanner/__fixtures__/tool-use-conversation.jsonl`
- Create: `scanner/__fixtures__/empty.jsonl`
- Create: `scanner/__fixtures__/malformed.jsonl`

- [ ] **Step 1: Create test fixtures**

Create `scanner/__fixtures__/valid-conversation.jsonl`:
```
{"type":"user","uuid":"u1","timestamp":"2026-01-15T10:00:00.000Z","sessionId":"sess-abc","slug":"my-session","cwd":"/home/user/project","message":{"role":"user","content":[{"type":"text","text":"Hello, can you help me?"}]}}
{"type":"assistant","uuid":"u2","timestamp":"2026-01-15T10:00:05.000Z","sessionId":"sess-abc","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Of course! How can I help you today?"}]}}
{"type":"user","uuid":"u3","timestamp":"2026-01-15T10:01:00.000Z","sessionId":"sess-abc","message":{"role":"user","content":[{"type":"text","text":"Fix the bug in main.ts"}]}}
{"type":"assistant","uuid":"u4","timestamp":"2026-01-15T10:01:30.000Z","sessionId":"sess-abc","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"I'll fix that for you."},{"type":"tool_use","id":"tu1","name":"Edit","input":{"file_path":"main.ts"}}]}}
```

Create `scanner/__fixtures__/teammate-conversation.jsonl`:
```
{"type":"user","uuid":"t1","timestamp":"2026-02-01T08:00:00.000Z","sessionId":"sess-team","cwd":"/home/user/team-project","teamName":"backend-team","message":{"role":"user","content":[{"type":"text","text":"<teammate-message teammate_id=\"agent-1\" summary=\"Fix auth\" color=\"blue\">Please fix the auth module</teammate-message>"}]}}
{"type":"assistant","uuid":"t2","timestamp":"2026-02-01T08:00:10.000Z","sessionId":"sess-team","teamName":"backend-team","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"I'll fix the auth module."}]}}
```

Create `scanner/__fixtures__/tool-use-conversation.jsonl`:
```
{"type":"user","uuid":"x1","timestamp":"2026-03-01T09:00:00.000Z","sessionId":"sess-tools","cwd":"/home/user/tools-project","message":{"role":"user","content":[{"type":"text","text":"Read main.ts"}]}}
{"type":"assistant","uuid":"x2","timestamp":"2026-03-01T09:00:05.000Z","sessionId":"sess-tools","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"main.ts"}},{"type":"tool_use","id":"tu2","name":"Grep","input":{"pattern":"TODO"}}]}}
{"type":"user","uuid":"x3","timestamp":"2026-03-01T09:00:10.000Z","sessionId":"sess-tools","toolUseResult":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"file contents here"}]}}
```

Create `scanner/__fixtures__/empty.jsonl` (empty file):
```
```

Create `scanner/__fixtures__/malformed.jsonl`:
```
not valid json
{"type":"user","uuid":"m1","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"sess-mal","cwd":"/project","message":{"role":"user","content":[{"type":"text","text":"Valid line after malformed"}]}}
{broken json too
```

- [ ] **Step 2: Write failing tests**

Create `scanner/__tests__/parser.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { parseMeta, parseConversation } from '../src/parser'
import { join } from 'path'

const FIXTURES = join(__dirname, '..', '__fixtures__')

describe('parseMeta', () => {
  it('extracts all metadata fields from valid conversation', async () => {
    const meta = await parseMeta(
      join(FIXTURES, 'valid-conversation.jsonl'),
      'default',
      { name: 'standard', previewMax: 200, snippetMax: 5000 },
    )
    expect(meta).not.toBeNull()
    expect(meta!.sessionId).toBe('sess-abc')
    expect(meta!.sessionName).toBe('my-session')
    expect(meta!.projectPath).toBe('/home/user/project')
    expect(meta!.messageCount).toBe(4)
    expect(meta!.lastMessageSender).toBe('assistant')
    expect(meta!.timestamp).toBe('2026-01-15T10:01:30.000Z')
    expect(meta!.preview).toContain('Hello')
    expect(meta!.model).toBe('claude-sonnet-4-20250514')
    expect(meta!.toolNames).toContain('Edit')
    expect(meta!.isSubagent).toBe(false)
    expect(meta!.isTeammate).toBe(false)
  })

  it('detects subagent from file path', async () => {
    const subagentPath = join(FIXTURES, 'valid-conversation.jsonl')
    // Simulate subagent path by using a path that includes /subagents/
    const meta = await parseMeta(
      '/fake/projects/proj/uuid123/subagents/agent-1.jsonl',
      'default',
      { name: 'standard', previewMax: 200, snippetMax: 5000 },
    )
    // This will return null because the file doesn't exist at that path
    // We test subagent detection in the scanner integration test
    expect(meta).toBeNull()
  })

  it('detects teammate from first user message', async () => {
    const meta = await parseMeta(
      join(FIXTURES, 'teammate-conversation.jsonl'),
      'default',
      { name: 'standard', previewMax: 200, snippetMax: 5000 },
    )
    expect(meta).not.toBeNull()
    expect(meta!.isTeammate).toBe(true)
    expect(meta!.teamName).toBe('backend-team')
  })

  it('collects tool names', async () => {
    const meta = await parseMeta(
      join(FIXTURES, 'tool-use-conversation.jsonl'),
      'default',
      { name: 'standard', previewMax: 200, snippetMax: 5000 },
    )
    expect(meta).not.toBeNull()
    expect(meta!.toolNames).toContain('Read')
    expect(meta!.toolNames).toContain('Grep')
  })

  it('returns null for empty file', async () => {
    const meta = await parseMeta(
      join(FIXTURES, 'empty.jsonl'),
      'default',
      { name: 'standard', previewMax: 200, snippetMax: 5000 },
    )
    expect(meta).toBeNull()
  })

  it('skips malformed lines and parses valid ones', async () => {
    const meta = await parseMeta(
      join(FIXTURES, 'malformed.jsonl'),
      'default',
      { name: 'standard', previewMax: 200, snippetMax: 5000 },
    )
    expect(meta).not.toBeNull()
    expect(meta!.messageCount).toBe(1)
  })

  it('respects preview and snippet limits', async () => {
    const meta = await parseMeta(
      join(FIXTURES, 'valid-conversation.jsonl'),
      'default',
      { name: 'tiny', previewMax: 10, snippetMax: 20 },
    )
    expect(meta).not.toBeNull()
    expect(meta!.preview.length).toBeLessThanOrEqual(10)
    expect(meta!.contentSnippet.length).toBeLessThanOrEqual(20)
  })
})

describe('parseConversation', () => {
  it('parses full conversation with messages', async () => {
    const conv = await parseConversation(
      join(FIXTURES, 'valid-conversation.jsonl'),
      'default',
    )
    expect(conv).not.toBeNull()
    expect(conv!.messages).toHaveLength(4)
    expect(conv!.sessionId).toBe('sess-abc')
    expect(conv!.messages[0].role).toBe('user')
    expect(conv!.messages[0].text).toContain('Hello')
    expect(conv!.messages[1].role).toBe('assistant')
    expect(conv!.messages[1].metadata?.model).toBe('claude-sonnet-4-20250514')
  })

  it('returns null for empty file', async () => {
    const conv = await parseConversation(
      join(FIXTURES, 'empty.jsonl'),
      'default',
    )
    expect(conv).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/parser.test.ts
```
Expected: FAIL

- [ ] **Step 4: Implement parser.ts**

Create `scanner/src/parser.ts`:
```typescript
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { basename, dirname, join } from 'path'
import { cleanSystemTags } from './tags'
import type {
  ConversationMeta,
  ContentTier,
  MessageSender,
  Conversation,
  ConversationMessage,
  MessageMetadata,
  ToolUseBlock,
  TeamInfo,
} from './types'

export async function parseMeta(
  filePath: string,
  account: string,
  tier: ContentTier,
): Promise<ConversationMeta | null> {
  let sessionId = ''
  let sessionName = ''
  let latestTimestamp = ''
  let cwd = ''
  let teamName = ''
  let model: string | null = null
  let messageCount = 0
  let lastMessageSender: MessageSender = 'user'
  let isTeammate = false
  let firstUserSeen = false
  const toolNameSet = new Set<string>()
  const previewParts: string[] = []
  const snippetParts: string[] = []
  let snippetLength = 0
  let previewLength = 0

  const fileStream = createReadStream(filePath)
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue

      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      if (entry.cwd && !cwd) cwd = entry.cwd as string
      if (entry.sessionId && !sessionId) sessionId = entry.sessionId as string
      if (entry.slug && !sessionName) sessionName = entry.slug as string
      if (entry.teamName && !teamName) teamName = entry.teamName as string
      if (entry.timestamp) {
        const ts = entry.timestamp as string
        if (!latestTimestamp || ts > latestTimestamp) latestTimestamp = ts
      }

      const type = entry.type as string
      if (type !== 'user' && type !== 'assistant') continue
      if (entry.isMeta) continue

      // Extract model from first assistant message
      if (model === null) {
        const msg = entry.message as Record<string, unknown> | undefined
        if (msg?.model) model = msg.model as string
      }

      // Check for teammate in first user message
      if (type === 'user' && !firstUserSeen) {
        firstUserSeen = true
        if (isTeammateContent((entry.message as Record<string, unknown>)?.content)) {
          isTeammate = true
        }
      }

      // Extract content
      const msg = entry.message as Record<string, unknown> | undefined
      const content = extractTextContent(msg?.content)
      const hasToolUseResult = type === 'user' && entry.toolUseResult != null
      const isOnlyToolResult = hasToolUseResult && isOnlyToolResultContent(msg?.content)

      // Collect tool names
      collectToolNames(msg?.content, toolNameSet)

      if (content || isOnlyToolResult) {
        messageCount++
        lastMessageSender = type as MessageSender

        if (content) {
          if (previewLength < tier.previewMax) {
            previewParts.push(content)
            previewLength += content.length
          }
          if (snippetLength < tier.snippetMax) {
            const remaining = tier.snippetMax - snippetLength
            const chunk = content.length > remaining ? content.slice(0, remaining) : content
            snippetParts.push(chunk)
            snippetLength += chunk.length
          }
        }
      }
    }
  } catch {
    // File read error — return null
    return null
  }

  if (messageCount === 0) return null

  const isSubagent = filePath.includes('/subagents/')
  let parentSessionId: string | null = null
  if (isSubagent) {
    const uuidDir = dirname(dirname(filePath))
    parentSessionId = join(dirname(uuidDir), basename(uuidDir) + '.jsonl')
  }

  const projectPath = cwd
  const preview = previewParts.join(' ').slice(0, tier.previewMax)

  return {
    id: filePath,
    filePath,
    sessionId: sessionId || basename(filePath, '.jsonl'),
    sessionName,
    projectPath,
    projectName: getShortProjectName(projectPath),
    account,
    timestamp: latestTimestamp || new Date().toISOString(),
    messageCount,
    lastMessageSender,
    preview,
    contentSnippet: snippetParts.join(' '),
    gitBranch: null, // Set by caller after parsing
    model,
    isSubagent,
    parentSessionId,
    isTeammate,
    teamName: teamName || null,
    toolNames: Array.from(toolNameSet),
  }
}

export async function parseConversation(
  filePath: string,
  account: string,
): Promise<Conversation | null> {
  const messages: ConversationMessage[] = []
  let sessionId = ''
  let sessionName = ''
  let latestTimestamp = ''
  let cwd = ''
  const textParts: string[] = []
  const pendingToolUses = new Map<string, ToolUseBlock>()
  const teamInfoMap = new Map<string, TeamInfo>()

  const fileStream = createReadStream(filePath)
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue

      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      if (entry.cwd && !cwd) cwd = entry.cwd as string
      if (entry.sessionId && !sessionId) sessionId = entry.sessionId as string
      if (entry.slug && !sessionName) sessionName = entry.slug as string
      if (entry.timestamp) {
        const ts = entry.timestamp as string
        if (!latestTimestamp || ts > latestTimestamp) latestTimestamp = ts
      }

      const type = entry.type as string
      if (type !== 'user' && type !== 'assistant') continue
      if (entry.isMeta) continue

      const msg = entry.message as Record<string, unknown> | undefined

      // Track tool_use blocks from assistant messages
      const toolUseBlocks = extractToolUseBlocks(msg?.content)
      for (const block of toolUseBlocks) {
        pendingToolUses.set(block.id, block)
      }

      const hasToolUseResult = type === 'user' && entry.toolUseResult != null
      const isToolResultOnly = hasToolUseResult && isOnlyToolResultContent(msg?.content)

      const content = extractTextContent(msg?.content)

      if (content || isToolResultOnly) {
        const metadata: MessageMetadata = {}

        if (msg?.model) metadata.model = msg.model as string
        if (msg?.stop_reason !== undefined) metadata.stopReason = msg.stop_reason as string | null
        if (entry.gitBranch) metadata.gitBranch = entry.gitBranch as string
        if (entry.version) metadata.version = entry.version as string

        const usage = msg?.usage as Record<string, number> | undefined
        if (usage) {
          if (usage.input_tokens) metadata.inputTokens = usage.input_tokens
          if (usage.output_tokens) metadata.outputTokens = usage.output_tokens
          if (usage.cache_read_input_tokens) metadata.cacheReadTokens = usage.cache_read_input_tokens
          if (usage.cache_creation_input_tokens) metadata.cacheCreationTokens = usage.cache_creation_input_tokens
        }

        const toolUseNames = extractToolUseNames(msg?.content)
        if (toolUseNames.length > 0) metadata.toolUses = toolUseNames
        if (toolUseBlocks.length > 0) metadata.toolUseBlocks = toolUseBlocks

        if (entry.teamName) {
          metadata.teamName = entry.teamName as string
          if (!teamInfoMap.has(metadata.teamName) && content) {
            const info = parseTeammateMessageTag(content)
            if (info) teamInfoMap.set(metadata.teamName, info)
          }
        }

        // Extract thinking content for assistant messages
        let thinkingContent: string | undefined
        if (type === 'assistant') {
          thinkingContent = extractThinkingContent(msg?.content) || undefined
        }

        const hasMetadata = Object.keys(metadata).length > 0

        messages.push({
          role: type as MessageSender,
          text: content || '',
          timestamp: (entry.timestamp as string) || '',
          uuid: (entry.uuid as string) || undefined,
          metadata: hasMetadata ? metadata : undefined,
          isToolResult: isToolResultOnly || undefined,
          isThinking: thinkingContent ? true : undefined,
          thinkingContent,
        })
        if (content) textParts.push(content)
      }
    }
  } catch {
    return null
  }

  if (messages.length === 0) return null

  // Apply collected team info to matching messages
  if (teamInfoMap.size > 0) {
    for (const msg of messages) {
      if (msg.metadata?.teamName) {
        const info = teamInfoMap.get(msg.metadata.teamName)
        if (info) msg.metadata.teamInfo = info
      }
    }
  }

  return {
    id: filePath,
    filePath,
    projectPath: cwd,
    projectName: getShortProjectName(cwd),
    sessionId: sessionId || basename(filePath, '.jsonl'),
    sessionName,
    messages,
    fullText: textParts.join(' '),
    timestamp: latestTimestamp || new Date().toISOString(),
    messageCount: messages.length,
    account,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return cleanSystemTags(content)
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item
        if (item?.type === 'text' && item?.text) return item.text
        if (item?.type === 'tool_result' && typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .map(cleanSystemTags)
      .join(' ')
  }
  return ''
}

function extractToolUseNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(item => item?.type === 'tool_use' && item?.name)
    .map(item => item.name as string)
}

function extractToolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(item => item?.type === 'tool_use' && item?.name && item?.id)
    .map(item => ({
      id: item.id as string,
      name: item.name as string,
      input: (item.input as Record<string, unknown>) || {},
    }))
}

function collectToolNames(content: unknown, toolSet: Set<string>): void {
  if (!Array.isArray(content)) return
  for (const item of content) {
    if (item?.type === 'tool_use' && item?.name) {
      toolSet.add(item.name as string)
    }
  }
}

function isOnlyToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.length > 0 && content.every(item => item?.type === 'tool_result')
}

function isTeammateContent(content: unknown): boolean {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(item =>
          typeof item === 'string' ? item : item?.type === 'text' ? (item.text ?? '') : '',
        ).join('')
      : ''
  return raw.includes('<teammate-message')
}

function extractThinkingContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(item => item?.type === 'thinking' && item?.thinking)
    .map(item => item.thinking as string)
    .join('\n\n')
}

function parseTeammateMessageTag(content: string): TeamInfo | null {
  const match = content.match(/<teammate-message\s+([^>]*)>/)
  if (!match) return null
  const attrs = match[1]
  const id = attrs.match(/teammate_id="([^"]*)"/)?.[1]
  if (!id) return null
  const summary = attrs.match(/summary="([^"]*)"/)?.[1]
  const color = attrs.match(/color="([^"]*)"/)?.[1]
  return { teammateId: id, summary, color }
}

function getShortProjectName(fullPath: string): string {
  const parts = fullPath.split('/').filter(Boolean)
  return parts.slice(-3).join('/')
}
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/parser.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scanner/src/parser.ts scanner/__tests__/parser.test.ts scanner/__fixtures__/
git commit -m "feat(scanner): add JSONL parser with meta and full conversation parsing"
```

---

### Task 9: Search Indexer

**Files:**
- Create: `scanner/src/indexer.ts`
- Create: `scanner/__tests__/indexer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scanner/__tests__/indexer.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { SearchIndexer } from '../src/indexer'
import type { ConversationMeta } from '../src/types'

function makeMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'test',
    filePath: '/test.jsonl',
    sessionId: 'sess-1',
    sessionName: 'test-session',
    projectPath: '/project',
    projectName: 'my-project',
    account: 'default',
    timestamp: '2026-01-01T00:00:00Z',
    messageCount: 5,
    lastMessageSender: 'user',
    preview: 'test preview',
    contentSnippet: 'some content about authentication and login',
    gitBranch: 'main',
    model: 'claude-sonnet-4-20250514',
    isSubagent: false,
    parentSessionId: null,
    isTeammate: false,
    teamName: null,
    toolNames: ['Edit', 'Read'],
    ...overrides,
  }
}

describe('SearchIndexer', () => {
  let indexer: SearchIndexer

  beforeEach(() => {
    indexer = new SearchIndexer()
  })

  it('indexes and searches documents', () => {
    indexer.addDocument(makeMeta({ id: 'a', contentSnippet: 'fix the authentication bug' }))
    indexer.addDocument(makeMeta({ id: 'b', contentSnippet: 'add new feature' }))

    const results = indexer.search('authentication')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].meta.id).toBe('a')
  })

  it('searches by project name', () => {
    indexer.addDocument(makeMeta({ id: 'a', projectName: 'frontend-app' }))
    indexer.addDocument(makeMeta({ id: 'b', projectName: 'backend-api' }))

    const results = indexer.search('frontend')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].meta.projectName).toBe('frontend-app')
  })

  it('returns recent conversations for empty query', () => {
    indexer.addDocument(makeMeta({ id: 'old', timestamp: '2025-01-01T00:00:00Z' }))
    indexer.addDocument(makeMeta({ id: 'new', timestamp: '2026-06-01T00:00:00Z' }))

    const results = indexer.search('')
    expect(results[0].meta.id).toBe('new')
  })

  it('returns correct document count', () => {
    indexer.addDocument(makeMeta({ id: 'a' }))
    indexer.addDocument(makeMeta({ id: 'b' }))
    expect(indexer.getDocumentCount()).toBe(2)
  })

  it('clears index', () => {
    indexer.addDocument(makeMeta({ id: 'a' }))
    indexer.clear()
    expect(indexer.getDocumentCount()).toBe(0)
  })

  it('builds index from array', () => {
    const metas = [
      makeMeta({ id: 'a' }),
      makeMeta({ id: 'b' }),
    ]
    indexer.buildIndex(metas)
    expect(indexer.getDocumentCount()).toBe(2)
  })

  it('generates context-aware preview snippets', () => {
    const longContent = 'A'.repeat(100) + 'FINDME' + 'B'.repeat(100)
    indexer.addDocument(makeMeta({ id: 'a', contentSnippet: longContent }))

    const results = indexer.search('FINDME')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].matches.length).toBeGreaterThanOrEqual(1)
    expect(results[0].matches[0].snippet).toContain('FINDME')
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/indexer.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement indexer.ts**

Create `scanner/src/indexer.ts`:
```typescript
import FlexSearch from 'flexsearch'
import type { ConversationMeta, SearchResult, SearchMatch } from './types'

interface IndexedDocument {
  [key: string]: FlexSearch.DocumentValue | FlexSearch.DocumentValue[]
  id: string
  content: string
  projectName: string
  projectPath: string
  sessionId: string
  sessionName: string
  account: string
  model: string
  gitBranch: string
  toolNames: string
}

export class SearchIndexer {
  private index: FlexSearch.Document<IndexedDocument>
  private documents = new Map<string, ConversationMeta>()

  constructor() {
    this.index = new FlexSearch.Document<IndexedDocument>({
      document: {
        id: 'id',
        index: [
          'content', 'projectName', 'projectPath',
          'sessionId', 'sessionName', 'account',
          'model', 'gitBranch', 'toolNames',
        ],
        store: ['id'],
      },
      tokenize: 'forward',
      resolution: 9,
      cache: 100,
    })
  }

  addDocument(meta: ConversationMeta): void {
    this.documents.set(meta.id, meta)
    this.index.add({
      id: meta.id,
      content: meta.contentSnippet,
      projectName: meta.projectName,
      projectPath: meta.projectPath,
      sessionId: meta.sessionId,
      sessionName: meta.sessionName,
      account: meta.account,
      model: meta.model || '',
      gitBranch: meta.gitBranch || '',
      toolNames: meta.toolNames.join(' '),
    })
  }

  buildIndex(metas: ConversationMeta[]): void {
    this.clear()
    for (const meta of metas) {
      this.addDocument(meta)
    }
  }

  search(query: string, options?: { fields?: string[]; limit?: number }): SearchResult[] {
    const limit = options?.limit ?? 50

    if (!query.trim()) {
      return this.getRecent(limit)
    }

    const results = this.index.search(query, { limit: limit * 2, enrich: true })

    const seen = new Set<string>()
    const searchResults: SearchResult[] = []

    for (const fieldResult of results) {
      if (!fieldResult.result) continue
      for (const item of fieldResult.result) {
        const id = typeof item === 'object' ? (item as { id: string }).id : String(item)
        if (seen.has(id)) continue
        seen.add(id)

        const meta = this.documents.get(id)
        if (!meta) continue

        const matches = this.generateMatches(meta, query)

        searchResults.push({ meta, score: 1, matches })
        if (searchResults.length >= limit) break
      }
      if (searchResults.length >= limit) break
    }

    return searchResults
  }

  private getRecent(limit: number): SearchResult[] {
    return Array.from(this.documents.values())
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map(meta => ({
        meta,
        score: 1,
        matches: [{ field: 'timestamp', snippet: meta.preview }],
      }))
  }

  private generateMatches(meta: ConversationMeta, query: string): SearchMatch[] {
    const matches: SearchMatch[] = []
    const lowerQuery = query.toLowerCase()

    const fields: [string, string][] = [
      ['contentSnippet', meta.contentSnippet],
      ['projectName', meta.projectName],
      ['sessionId', meta.sessionId],
      ['sessionName', meta.sessionName],
      ['account', meta.account],
      ['model', meta.model || ''],
      ['gitBranch', meta.gitBranch || ''],
      ['toolNames', meta.toolNames.join(' ')],
    ]

    for (const [field, value] of fields) {
      const idx = value.toLowerCase().indexOf(lowerQuery)
      if (idx !== -1) {
        const start = Math.max(0, idx - 80)
        const end = Math.min(value.length, idx + query.length + 120)
        let snippet = value.slice(start, end)
        if (start > 0) snippet = '...' + snippet
        if (end < value.length) snippet = snippet + '...'
        matches.push({ field, snippet })
      }
    }

    return matches.length > 0 ? matches : [{ field: 'preview', snippet: meta.preview }]
  }

  getDocumentCount(): number {
    return this.documents.size
  }

  clear(): void {
    this.documents.clear()
    this.index = new FlexSearch.Document<IndexedDocument>({
      document: {
        id: 'id',
        index: [
          'content', 'projectName', 'projectPath',
          'sessionId', 'sessionName', 'account',
          'model', 'gitBranch', 'toolNames',
        ],
        store: ['id'],
      },
      tokenize: 'forward',
      resolution: 9,
      cache: 100,
    })
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/indexer.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scanner/src/indexer.ts scanner/__tests__/indexer.test.ts
git commit -m "feat(scanner): add FlexSearch-based indexer with all-field search"
```

---

### Task 10: Profiles

**Files:**
- Create: `scanner/src/profiles.ts`
- Create: `scanner/__tests__/profiles.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scanner/__tests__/profiles.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadProfiles, saveProfiles, detectDefaultProfile, resolveConfigDir, getProjectsDir } from '../src/profiles'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

describe('resolveConfigDir', () => {
  it('expands ~ to home directory', () => {
    expect(resolveConfigDir('~/.claude')).toBe(join(homedir(), '.claude'))
  })

  it('leaves absolute paths unchanged', () => {
    expect(resolveConfigDir('/etc/claude')).toBe('/etc/claude')
  })
})

describe('getProjectsDir', () => {
  it('returns configDir/projects', () => {
    const profile = { id: 'test', label: 'Test', configDir: '/home/user/.claude', enabled: true }
    expect(getProjectsDir(profile)).toBe(join(homedir(), '.claude', 'projects'))
  })
})

describe('detectDefaultProfile', () => {
  it('returns a profile pointing to ~/.claude', async () => {
    const profile = await detectDefaultProfile()
    expect(profile.id).toBe('default')
    expect(profile.configDir).toContain('.claude')
    expect(profile.enabled).toBe(true)
  })
})

describe('loadProfiles / saveProfiles', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'profiles-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('saves and loads profiles', async () => {
    const profiles = [
      { id: 'work', label: 'Work', configDir: '~/.claude-work', enabled: true },
    ]
    await saveProfiles(profiles, tempDir)
    const loaded = await loadProfiles(tempDir)
    expect(loaded).toEqual(profiles)
  })

  it('returns default profile when no config exists', async () => {
    const loaded = await loadProfiles(tempDir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('default')
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/profiles.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement profiles.ts**

Create `scanner/src/profiles.ts`:
```typescript
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { Profile } from './types'

const PROFILES_FILE = 'profiles.json'

export function resolveConfigDir(configDir: string): string {
  return configDir.replace(/^~/, homedir())
}

export function getProjectsDir(profile: Profile): string {
  return join(resolveConfigDir(profile.configDir), 'projects')
}

export async function detectDefaultProfile(): Promise<Profile> {
  return {
    id: 'default',
    label: 'Default',
    configDir: join(homedir(), '.claude'),
    enabled: true,
    emoji: '🤖',
  }
}

export async function loadProfiles(configPath: string): Promise<Profile[]> {
  try {
    const data = await readFile(join(configPath, PROFILES_FILE), 'utf-8')
    return JSON.parse(data) as Profile[]
  } catch {
    // No config file — return default profile
    const defaultProfile = await detectDefaultProfile()
    return [defaultProfile]
  }
}

export async function saveProfiles(profiles: Profile[], configPath: string): Promise<void> {
  await mkdir(configPath, { recursive: true })
  await writeFile(join(configPath, PROFILES_FILE), JSON.stringify(profiles, null, 2))
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/profiles.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scanner/src/profiles.ts scanner/__tests__/profiles.test.ts
git commit -m "feat(scanner): add profile management with load/save/detect"
```

---

### Task 11: ConversationScanner (Main Orchestrator)

**Files:**
- Create: `scanner/src/scanner.ts`
- Create: `scanner/__tests__/scanner.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scanner/__tests__/scanner.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ConversationScanner } from '../src/scanner'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Profile } from '../src/types'

const VALID_LINE = (uuid: string, ts: string, text: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    sessionId: 'sess-1',
    slug: 'test-session',
    cwd: '/home/user/project',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })

const ASSISTANT_LINE = (uuid: string, ts: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    sessionId: 'sess-1',
    message: { role: 'assistant', model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text }] },
  })

describe('ConversationScanner', () => {
  let tempDir: string
  let profile: Profile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scanner-test-'))
    const projectsDir = join(tempDir, 'projects')
    mkdirSync(join(projectsDir, 'my-project'), { recursive: true })
    writeFileSync(
      join(projectsDir, 'my-project', 'session1.jsonl'),
      [
        VALID_LINE('u1', '2026-01-15T10:00:00.000Z', 'Hello'),
        ASSISTANT_LINE('u2', '2026-01-15T10:00:05.000Z', 'Hi there'),
      ].join('\n') + '\n',
    )
    writeFileSync(
      join(projectsDir, 'my-project', 'session2.jsonl'),
      [
        VALID_LINE('u3', '2026-02-01T08:00:00.000Z', 'Fix the bug'),
        ASSISTANT_LINE('u4', '2026-02-01T08:00:10.000Z', 'Done'),
      ].join('\n') + '\n',
    )
    profile = { id: 'test', label: 'Test', configDir: tempDir, enabled: true }
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('scans all conversations', async () => {
    const scanner = new ConversationScanner()
    const result = await scanner.scan({ profiles: [profile] })
    expect(result.conversations).toHaveLength(2)
    expect(result.scanned).toBe(2)
    expect(result.total).toBe(2)
  })

  it('returns conversations sorted by timestamp descending', async () => {
    const scanner = new ConversationScanner()
    const result = await scanner.scan({ profiles: [profile] })
    const convs = result.conversations as import('../src/types').ConversationMeta[]
    expect(convs[0].timestamp > convs[1].timestamp).toBe(true)
  })

  it('applies sort option', async () => {
    const scanner = new ConversationScanner()
    const result = await scanner.scan({ profiles: [profile], sort: 'oldest' })
    const convs = result.conversations as import('../src/types').ConversationMeta[]
    expect(convs[0].timestamp < convs[1].timestamp).toBe(true)
  })

  it('applies pagination', async () => {
    const scanner = new ConversationScanner()
    const result = await scanner.scan({ profiles: [profile], limit: 1, offset: 0 })
    expect(result.conversations).toHaveLength(1)
    expect(result.total).toBe(2)
  })

  it('calls onProgress callback', async () => {
    const scanner = new ConversationScanner()
    const progressCalls: [number, number][] = []
    await scanner.scan({
      profiles: [profile],
      onProgress: (scanned, total) => progressCalls.push([scanned, total]),
    })
    expect(progressCalls.length).toBeGreaterThan(0)
  })

  it('calls onBatch callback', async () => {
    const scanner = new ConversationScanner()
    let batchCount = 0
    await scanner.scan({
      profiles: [profile],
      onBatch: () => { batchCount++ },
    })
    expect(batchCount).toBeGreaterThan(0)
  })

  it('loads a full conversation by id', async () => {
    const scanner = new ConversationScanner()
    await scanner.scan({ profiles: [profile] })

    const metas = scanner.getMetadataCache()
    const firstId = Array.from(metas.keys())[0]
    const conv = await scanner.getConversation(firstId)

    expect(conv).not.toBeNull()
    expect(conv!.messages.length).toBeGreaterThan(0)
  })

  it('searches indexed conversations', async () => {
    const scanner = new ConversationScanner()
    const results = await scanner.search('Hello', { profiles: [profile] })
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('skips disabled profiles', async () => {
    const disabledProfile = { ...profile, enabled: false }
    const scanner = new ConversationScanner()
    const result = await scanner.scan({ profiles: [disabledProfile] })
    expect(result.conversations).toHaveLength(0)
  })

  it('skips profiles with scanHistory=false', async () => {
    const noScanProfile = { ...profile, scanHistory: false }
    const scanner = new ConversationScanner()
    const result = await scanner.scan({ profiles: [noScanProfile] })
    expect(result.conversations).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd scanner && npx vitest run __tests__/scanner.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement scanner.ts**

Create `scanner/src/scanner.ts`:
```typescript
import { LRUCache } from './cache'
import { discoverJsonlFiles } from './discovery'
import { parseMeta, parseConversation } from './parser'
import { SearchIndexer } from './indexer'
import { readGitBranch } from './git'
import { resolveTier, DEFAULT_TIERS } from './tiers'
import { getProjectsDir, loadProfiles, detectDefaultProfile } from './profiles'
import {
  applySort,
  applySinceFilter,
  applyIncludeFilter,
  applyProjectFilter,
  applyAccountFilter,
  applyPagination,
} from './filters'
import type {
  ScanOptions,
  ScanResult,
  SearchOptions,
  SearchResult,
  GetConversationOptions,
  Conversation,
  ConversationMeta,
  Profile,
  TreeConversation,
  GroupedConversations,
} from './types'

const BATCH_SIZE = 12
const DEFAULT_CONFIG_PATH = '~/.config/threadbase-scanner'

export class ConversationScanner {
  private metadataCache: Map<string, ConversationMeta> = new Map()
  private conversationLRU: LRUCache<string, Conversation>
  private sessionIdIndex: Map<string, ConversationMeta> = new Map()
  private projects: Set<string> = new Set()
  private indexer: SearchIndexer = new SearchIndexer()

  constructor(options?: { metadataCacheSize?: number; conversationCacheSize?: number }) {
    this.conversationLRU = new LRUCache<string, Conversation>(options?.conversationCacheSize ?? 5)
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    // Resolve profiles
    const profiles = await this.resolveProfiles(options.profiles)
    const activeProfiles = profiles.filter(p => p.enabled && p.scanHistory !== false)

    // Resolve tier
    const tier = resolveTier(options.tier ?? 'standard', options.tiers)

    // Clear caches
    this.metadataCache.clear()
    this.conversationLRU.clear()
    this.sessionIdIndex.clear()
    this.projects.clear()
    this.indexer.clear()

    // Build config dirs
    const configDirs = activeProfiles.map(p => ({
      projectsDir: getProjectsDir(p),
      account: p.id,
    }))

    // Discover files
    const files = await discoverJsonlFiles(configDirs)
    const totalFiles = files.length
    let scanned = 0

    // Process in batches
    const allMetas: ConversationMeta[] = []
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map(async ({ filePath, account }) => {
          try {
            const meta = await parseMeta(filePath, account, tier)
            if (meta) {
              meta.gitBranch = readGitBranch(meta.projectPath)
            }
            return meta
          } catch {
            return null
          }
        }),
      )

      const batchMetas: ConversationMeta[] = []
      for (const meta of results) {
        if (meta && meta.messageCount > 0) {
          this.metadataCache.set(meta.id, meta)
          this.sessionIdIndex.set(meta.sessionId, meta)
          this.projects.add(meta.projectPath)
          allMetas.push(meta)
          batchMetas.push(meta)
          this.indexer.addDocument(meta)
        }
      }

      if (batchMetas.length > 0) {
        options.onBatch?.(batchMetas)
      }

      scanned += batch.length
      options.onProgress?.(scanned, totalFiles)
    }

    // Apply filters
    let filtered = allMetas
    if (options.include && options.include !== 'all') {
      filtered = applyIncludeFilter(filtered, options.include)
    }
    if (options.project) {
      filtered = applyProjectFilter(filtered, options.project)
    }
    if (options.account) {
      filtered = applyAccountFilter(filtered, options.account)
    }
    if (options.since) {
      filtered = applySinceFilter(filtered, options.since)
    }

    // Sort
    filtered = applySort(filtered, options.sort ?? 'recent')

    // Transform view
    const total = filtered.length
    const conversations = this.transformView(filtered, options)

    // Paginate
    if (Array.isArray(conversations)) {
      const paginated = applyPagination(conversations, options.limit ?? 50, options.offset ?? 0)
      return { conversations: paginated.items, total, scanned }
    }

    // Grouped view — no pagination
    return { conversations, total, scanned }
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    // If index is empty, scan first
    if (this.indexer.getDocumentCount() === 0) {
      await this.scan({ ...options, limit: undefined, offset: undefined })
    }

    let results = this.indexer.search(query, {
      fields: options.fields,
      limit: (options.limit ?? 50) * 2,
    })

    // Apply filters on results
    if (options.include && options.include !== 'all') {
      results = results.filter(r => {
        switch (options.include) {
          case 'conversations': return !r.meta.isSubagent && !r.meta.isTeammate
          case 'subagents': return r.meta.isSubagent
          case 'teammates': return r.meta.isTeammate
          default: return true
        }
      })
    }
    if (options.project) {
      const lower = options.project.toLowerCase()
      results = results.filter(r =>
        r.meta.projectPath.toLowerCase().includes(lower) ||
        r.meta.projectName.toLowerCase().includes(lower),
      )
    }
    if (options.account) {
      results = results.filter(r => r.meta.account === options.account)
    }
    if (options.since) {
      const { parseSinceCutoff } = await import('./filters')
      const cutoff = parseSinceCutoff(options.since)
      results = results.filter(r => new Date(r.meta.timestamp).getTime() >= cutoff.getTime())
    }

    // Paginate
    const limit = options.limit ?? 50
    const offset = options.offset ?? 0
    return results.slice(offset, offset + limit)
  }

  async getConversation(id: string, options?: GetConversationOptions): Promise<Conversation | null> {
    // Check LRU cache
    const cached = this.conversationLRU.get(id)
    if (cached) return cached

    // Find metadata
    const meta = this.metadataCache.get(id) ?? this.sessionIdIndex.get(id)
    if (!meta) return null

    try {
      const conversation = await parseConversation(meta.filePath, meta.account)
      if (conversation) {
        this.conversationLRU.set(id, conversation)
      }
      return conversation
    } catch {
      return null
    }
  }

  getMetadataCache(): Map<string, ConversationMeta> {
    return this.metadataCache
  }

  getProjects(): string[] {
    const normalized = new Set<string>()
    for (const p of this.projects) {
      normalized.add(p.replace(/\/+$/, ''))
    }
    return Array.from(normalized).sort()
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  private async resolveProfiles(profiles?: Profile[]): Promise<Profile[]> {
    if (profiles && profiles.length > 0) return profiles
    return loadProfiles(DEFAULT_CONFIG_PATH)
  }

  private transformView(
    metas: ConversationMeta[],
    options: ScanOptions,
  ): ConversationMeta[] | TreeConversation[] | GroupedConversations {
    switch (options.view) {
      case 'tree':
        return this.toTree(metas)
      case 'grouped':
        return this.toGrouped(metas)
      default:
        return metas
    }
  }

  private toTree(metas: ConversationMeta[]): TreeConversation[] {
    const parents: TreeConversation[] = []
    const subagents: ConversationMeta[] = []

    for (const meta of metas) {
      if (meta.isSubagent) {
        subagents.push(meta)
      } else {
        parents.push({ ...meta, subagents: [] })
      }
    }

    // Attach subagents to their parents
    const parentById = new Map(parents.map(p => [p.id, p]))
    for (const sub of subagents) {
      const parent = sub.parentSessionId ? parentById.get(sub.parentSessionId) : undefined
      if (parent) {
        parent.subagents.push(sub)
      } else {
        // Orphan subagent — promote to top level
        parents.push({ ...sub, subagents: [] })
      }
    }

    return parents
  }

  private toGrouped(metas: ConversationMeta[]): GroupedConversations {
    const groups: GroupedConversations = {}
    for (const meta of metas) {
      const key = meta.teamName || '_default'
      if (!groups[key]) groups[key] = []
      groups[key].push(meta)
    }
    return groups
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd scanner && npx vitest run __tests__/scanner.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scanner/src/scanner.ts scanner/__tests__/scanner.test.ts
git commit -m "feat(scanner): add ConversationScanner orchestrator with scan/search/getConversation"
```

---

### Task 12: Public API Exports + Standalone Functions

**Files:**
- Modify: `scanner/src/index.ts`

- [ ] **Step 1: Write the public API**

Replace `scanner/src/index.ts` with:
```typescript
export { ConversationScanner } from './scanner'
export { SearchIndexer } from './indexer'
export { DEFAULT_TIERS, resolveTier } from './tiers'
export { loadProfiles, saveProfiles, detectDefaultProfile, resolveConfigDir, getProjectsDir } from './profiles'
export { readGitBranch } from './git'
export { cleanSystemTags } from './tags'
export * from './types'

// ─── Standalone Convenience Functions ───────────────────────────────

import { ConversationScanner } from './scanner'
import type { ScanOptions, ScanResult, SearchOptions, SearchResult, GetConversationOptions, Conversation } from './types'

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

- [ ] **Step 2: Verify it compiles**

```bash
cd scanner && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Run all tests**

```bash
cd scanner && npx vitest run
```
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add scanner/src/index.ts
git commit -m "feat(scanner): add public API exports and standalone convenience functions"
```

---

### Task 13: CLI Commands

**Files:**
- Create: `scanner/cli/index.ts`
- Create: `scanner/cli/commands/list.ts`
- Create: `scanner/cli/commands/search.ts`
- Create: `scanner/cli/commands/show.ts`
- Create: `scanner/cli/commands/scan.ts`
- Create: `scanner/cli/commands/profiles.ts`

- [ ] **Step 1: Create CLI entry point**

Create `scanner/cli/index.ts`:
```typescript
import { Command } from 'commander'
import { registerListCommand } from './commands/list'
import { registerSearchCommand } from './commands/search'
import { registerShowCommand } from './commands/show'
import { registerScanCommand } from './commands/scan'
import { registerProfilesCommand } from './commands/profiles'

const program = new Command()
  .name('threadbase-scanner')
  .description('Unified Claude Code conversation history scanner')
  .version('0.1.0')

registerListCommand(program)
registerSearchCommand(program)
registerShowCommand(program)
registerScanCommand(program)
registerProfilesCommand(program)

program.parse()
```

- [ ] **Step 2: Create list command**

Create `scanner/cli/commands/list.ts`:
```typescript
import type { Command } from 'commander'
import { ConversationScanner } from '../../src/scanner'
import { loadProfiles } from '../../src/profiles'
import type { ConversationMeta, SortOrder } from '../../src/types'

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List conversations')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('--offset <n>', 'Skip N results', '0')
    .option('-s, --sort <order>', 'Sort order', 'recent')
    .option('--since <value>', 'Time filter (7d, 2w, 2024-01-15)')
    .option('-p, --project <name>', 'Filter by project')
    .option('-a, --account <name>', 'Filter by account')
    .option('--include <type>', 'all|conversations|subagents|teammates', 'all')
    .option('--tier <name>', 'Content tier', 'standard')
    .option('--json', 'JSON output', false)
    .action(async (opts) => {
      try {
        const profiles = await loadProfiles('~/.config/threadbase-scanner')
        const scanner = new ConversationScanner()
        const result = await scanner.scan({
          profiles,
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
          sort: opts.sort as SortOrder,
          since: opts.since,
          project: opts.project,
          account: opts.account,
          include: opts.include,
          tier: opts.tier,
        })

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          const convs = result.conversations as ConversationMeta[]
          console.log(`Showing ${convs.length} of ${result.total} conversations (${result.scanned} files scanned)\n`)
          for (const c of convs) {
            const branch = c.gitBranch ? ` [${c.gitBranch}]` : ''
            const sub = c.isSubagent ? ' (subagent)' : ''
            const team = c.isTeammate ? ` (team: ${c.teamName})` : ''
            console.log(`  ${c.sessionId.slice(0, 8)}  ${c.projectName}${branch}${sub}${team}`)
            console.log(`    ${c.messageCount} msgs · ${c.timestamp.slice(0, 16)} · ${c.preview.slice(0, 80)}`)
            console.log()
          }
        }
      } catch (err) {
        console.error('Error:', (err as Error).message)
        process.exit(1)
      }
    })
}
```

- [ ] **Step 3: Create search command**

Create `scanner/cli/commands/search.ts`:
```typescript
import type { Command } from 'commander'
import { ConversationScanner } from '../../src/scanner'
import { loadProfiles } from '../../src/profiles'
import type { SortOrder } from '../../src/types'

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Search conversations')
    .option('-l, --limit <n>', 'Max results', '20')
    .option('--offset <n>', 'Skip N results', '0')
    .option('-s, --sort <order>', 'Sort order', 'recent')
    .option('--since <value>', 'Time filter')
    .option('-p, --project <name>', 'Filter by project')
    .option('-a, --account <name>', 'Filter by account')
    .option('--fields <list>', 'Comma-separated field list')
    .option('--json', 'JSON output', false)
    .action(async (query: string, opts) => {
      try {
        const profiles = await loadProfiles('~/.config/threadbase-scanner')
        const scanner = new ConversationScanner()
        const results = await scanner.search(query, {
          profiles,
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
          sort: opts.sort as SortOrder,
          since: opts.since,
          project: opts.project,
          account: opts.account,
          fields: opts.fields?.split(','),
        })

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2))
        } else {
          console.log(`Found ${results.length} results for "${query}"\n`)
          for (const r of results) {
            console.log(`  ${r.meta.sessionId.slice(0, 8)}  ${r.meta.projectName}`)
            if (r.matches.length > 0) {
              console.log(`    Match: ${r.matches[0].snippet.slice(0, 100)}`)
            }
            console.log()
          }
        }
      } catch (err) {
        console.error('Error:', (err as Error).message)
        process.exit(1)
      }
    })
}
```

- [ ] **Step 4: Create show command**

Create `scanner/cli/commands/show.ts`:
```typescript
import type { Command } from 'commander'
import { ConversationScanner } from '../../src/scanner'
import { loadProfiles } from '../../src/profiles'

export function registerShowCommand(program: Command): void {
  program
    .command('show <session-id>')
    .description('Show a full conversation')
    .option('--json', 'JSON output', false)
    .action(async (sessionIdPrefix: string, opts) => {
      try {
        const profiles = await loadProfiles('~/.config/threadbase-scanner')
        const scanner = new ConversationScanner()
        await scanner.scan({ profiles })

        // Prefix-match
        const cache = scanner.getMetadataCache()
        const matches = Array.from(cache.values()).filter(m =>
          m.sessionId.startsWith(sessionIdPrefix),
        )

        if (matches.length === 0) {
          console.error(`No session found matching "${sessionIdPrefix}"`)
          process.exit(1)
        }
        if (matches.length > 1) {
          console.error(`Ambiguous prefix "${sessionIdPrefix}" — matches ${matches.length} sessions:`)
          for (const m of matches.slice(0, 5)) {
            console.error(`  ${m.sessionId}  ${m.projectName}`)
          }
          process.exit(1)
        }

        const conv = await scanner.getConversation(matches[0].id)
        if (!conv) {
          console.error('Failed to load conversation')
          process.exit(1)
        }

        if (opts.json) {
          console.log(JSON.stringify(conv, null, 2))
        } else {
          console.log(`Session: ${conv.sessionId}`)
          console.log(`Project: ${conv.projectName} (${conv.projectPath})`)
          console.log(`Messages: ${conv.messageCount}\n`)
          for (const msg of conv.messages) {
            const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant'
            console.log(`[${msg.timestamp.slice(0, 19)}] ${role}:`)
            console.log(msg.text.slice(0, 500))
            console.log()
          }
        }
      } catch (err) {
        console.error('Error:', (err as Error).message)
        process.exit(1)
      }
    })
}
```

- [ ] **Step 5: Create scan command**

Create `scanner/cli/commands/scan.ts`:
```typescript
import type { Command } from 'commander'
import { ConversationScanner } from '../../src/scanner'
import { loadProfiles } from '../../src/profiles'

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Scan all conversations (refresh)')
    .option('--tier <name>', 'Content tier', 'standard')
    .option('--json', 'JSON output', false)
    .action(async (opts) => {
      try {
        const profiles = await loadProfiles('~/.config/threadbase-scanner')
        const scanner = new ConversationScanner()

        const start = Date.now()
        const result = await scanner.scan({
          profiles,
          tier: opts.tier,
          limit: undefined,
          onProgress: (scanned, total) => {
            if (!opts.json) {
              process.stdout.write(`\rScanning... ${scanned}/${total} files`)
            }
          },
        })

        const elapsed = ((Date.now() - start) / 1000).toFixed(1)

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          const projects = scanner.getProjects()
          console.log(`\nScanned ${result.scanned} files in ${elapsed}s`)
          console.log(`Found ${result.total} conversations across ${projects.length} projects`)
        }
      } catch (err) {
        console.error('Error:', (err as Error).message)
        process.exit(1)
      }
    })
}
```

- [ ] **Step 6: Create profiles command**

Create `scanner/cli/commands/profiles.ts`:
```typescript
import type { Command } from 'commander'
import { loadProfiles, saveProfiles } from '../../src/profiles'

const CONFIG_PATH = '~/.config/threadbase-scanner'

export function registerProfilesCommand(program: Command): void {
  const profiles = program
    .command('profiles')
    .description('Manage profiles')

  profiles
    .command('list')
    .description('List all profiles')
    .action(async () => {
      const all = await loadProfiles(CONFIG_PATH)
      console.log(`${all.length} profile(s):\n`)
      for (const p of all) {
        const status = p.enabled ? '✓' : '✗'
        const emoji = p.emoji || ''
        console.log(`  ${status} ${emoji} ${p.label} (${p.id})`)
        console.log(`    ${p.configDir}`)
        console.log()
      }
    })

  profiles
    .command('add <name> <config-dir>')
    .description('Add a profile')
    .action(async (name: string, configDir: string) => {
      const all = await loadProfiles(CONFIG_PATH)
      const id = name.toLowerCase().replace(/\s+/g, '-')
      if (all.find(p => p.id === id)) {
        console.error(`Profile "${id}" already exists`)
        process.exit(1)
      }
      all.push({ id, label: name, configDir, enabled: true })
      await saveProfiles(all, CONFIG_PATH)
      console.log(`Added profile "${name}" → ${configDir}`)
    })

  profiles
    .command('remove <name>')
    .description('Remove a profile')
    .action(async (name: string) => {
      const all = await loadProfiles(CONFIG_PATH)
      const filtered = all.filter(p => p.id !== name)
      if (filtered.length === all.length) {
        console.error(`Profile "${name}" not found`)
        process.exit(1)
      }
      await saveProfiles(filtered, CONFIG_PATH)
      console.log(`Removed profile "${name}"`)
    })
}
```

- [ ] **Step 7: Verify CLI compiles**

```bash
cd scanner && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add scanner/cli/
git commit -m "feat(scanner): add CLI commands (list, search, show, scan, profiles)"
```

---

### Task 14: Build and Verify End-to-End

**Files:**
- No new files — verification only

- [ ] **Step 1: Run all tests**

```bash
cd scanner && npx vitest run
```
Expected: all PASS

- [ ] **Step 2: Build the package**

```bash
cd scanner && npm run build
```
Expected: `dist/` directory created with `index.js`, `index.cjs`, `index.d.ts`, `cli/index.js`

- [ ] **Step 3: Test the CLI locally**

```bash
cd scanner && node dist/cli/index.js scan
```
Expected: scans and prints summary of conversations found

- [ ] **Step 4: Test the CLI list command**

```bash
cd scanner && node dist/cli/index.js list --limit 5 --json
```
Expected: JSON output of up to 5 conversations

- [ ] **Step 5: Test the CLI search command**

```bash
cd scanner && node dist/cli/index.js search "test" --limit 3
```
Expected: search results displayed

- [ ] **Step 6: Commit build config if needed**

```bash
git add scanner/tsup.config.ts
git commit -m "chore(scanner): finalize build configuration"
```

---

### Task 15: Final Verification

- [ ] **Step 1: Run full test suite one more time**

```bash
cd scanner && npx vitest run
```
Expected: all tests PASS

- [ ] **Step 2: Verify type exports**

```bash
cd scanner && node -e "const s = require('./dist/index.cjs'); console.log(Object.keys(s))"
```
Expected: lists all exports (`ConversationScanner`, `scan`, `search`, `getConversation`, etc.)

- [ ] **Step 3: Verify ESM import**

```bash
cd scanner && node --input-type=module -e "import { scan } from './dist/index.js'; console.log(typeof scan)"
```
Expected: `function`

- [ ] **Step 4: Commit everything and tag**

```bash
git add -A scanner/
git commit -m "feat(scanner): complete @threadbase/scanner v0.1.0"
```
