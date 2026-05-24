# Scanner Goes Public Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release `RonenMars/threadbase-scanner` as a public MIT-licensed GitHub repo, switch `tb-streamer` to consume it via npm git URL dep, and remove the now-unused bytenode pipeline + `vendor/scanner` submodule machinery.

**Architecture:** Two-repo change. Scanner side: revert bytenode artifacts to pre-bytenode shape, add a `prepare` script (so git URL dep consumers auto-build), add MIT LICENSE, flip repo to public, tag `v0.3.0`. Streamer side: swap `file:./vendor/scanner` for `github:RonenMars/threadbase-scanner#v0.3.0`, delete the submodule, strip scanner-build logic from the three deploy scripts. End state: scanner is plain MIT TypeScript, streamer consumes it via standard npm git URL semantics, no protection layer, no per-Node-version dispatch.

**Tech Stack:** TypeScript, tsup (build), Node.js >= 18, npm git URL deps, GitHub Actions CI, Bash/PowerShell deploy scripts.

**Reference spec:** [docs/superpowers/specs/2026-05-24-scanner-goes-public-design.md](../specs/2026-05-24-scanner-goes-public-design.md)

---

## Repo locations

- **Scanner repo:** `/Users/ronenmars/Desktop/dev/ai-tools/tb-scanner` — origin: `git@github.com:RonenMars/threadbase-scanner.git`
- **Streamer repo:** `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer` — origin: `git@github.com:RonenMars/tb-streamer.git`

**State at plan start:**
- Scanner `main` is at `df517fb docs: capture bytenode lessons + scanner-goes-public design`. Bytenode commits (`1fef563`, `51157cb`, `192ddd6`) sit on `main` below the docs commit. Tags `v0.2.0` and `v0.2.2` exist on GitHub pointing at failed-build commits and stay where they are (honest history).
- Scanner working tree is clean (last we checked).
- Streamer `main` is at `8b78d73`. Working tree has `docs/research/` untracked (the background-research dossier from this session — not part of this plan, can be cleaned up or committed separately).

---

## Phase A — Scanner-side changes

All Phase A tasks run with cwd = `/Users/ronenmars/Desktop/dev/ai-tools/tb-scanner`.

---

### Task A1: Pre-flip secret-scan sanity check

**Files:** none modified — read-only verification.

- [ ] **Step 1: Scan recent commit history for accidentally-committed secrets**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git log --all --pretty=format:"%H %s" | head -100
```

Read the output. Look for commit messages that mention secrets, keys, passwords, tokens, or any suspicious environment-variable-like patterns. Expected: only ordinary `feat:`/`fix:`/`chore:`/`docs:` commits. If anything looks suspicious, STOP and consult the owner before proceeding.

- [ ] **Step 2: Grep the working tree for secret-shaped strings**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git grep -iE 'secret|password|api[_-]?key|access[_-]?token|client[_-]?secret|bearer' -- ':!docs/' ':!*.md' 2>&1 | head -40
```

Expected: a handful of matches in code that handles authentication (e.g., `bearer` in HTTP header parsing) but **no literal values** — no `secret = "sk-..."`, no `password = "..."`. Read each match. If you find an actual literal credential value, STOP and consult the owner.

- [ ] **Step 3: Grep history for high-entropy strings that look like tokens**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git log --all -p | grep -E '(sk-[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{36}|ghp_[A-Za-z0-9]{36}|AKIA[A-Z0-9]{16})' | head -5
```

Expected: empty output. If any matches, STOP and consult the owner — those are real-looking tokens (OpenAI, npm, GitHub, AWS) and need rotation + history scrub before the repo can go public.

- [ ] **Step 4: Acknowledge the scan passed**

No file change. The intent of this task is a documented checkpoint. If all three greps came back clean, proceed to A2.

---

### Task A2: Restore `package.json` to pre-bytenode shape + add `prepare` script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Show the current state of the file**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
cat package.json
```

Expected: bytenode is in `dependencies`, `engines.node` is `>=22`, `bin.threadbase-scanner` points to `dist/cli.cjs`, `build` script chains tsup + bytenode, `version` is `0.2.2`.

- [ ] **Step 2: Rewrite `package.json` with the target shape**

Replace the entire file contents with:

```json
{
  "name": "@ronenmars/threadbase-scanner",
  "version": "0.3.0",
  "description": "Unified Claude Code conversation history scanner",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "threadbase-scanner": "dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "build": "tsup",
    "prepare": "npm run build",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit && npx biome check .",
    "format": "npx biome format --write .",
    "check": "npx biome check --write .",
    "capture-live": "bash scripts/capture-live.sh",
    "update-baseline": "bash scripts/update-baseline.sh"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "fast-glob": "^3.3.0",
    "flexsearch": "^0.7.43",
    "pino": "^10.3.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.12",
    "@types/node": "^20.0.0",
    "pino-pretty": "^13.1.3",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Changes vs the current file:
- `version`: `0.2.2` → `0.3.0`
- `bin.threadbase-scanner`: `dist/cli.cjs` → `dist/cli.js`
- `engines.node`: `>=22` → `>=18`
- `scripts.build`: `tsup && node scripts/build-bytenode.mjs` → `tsup`
- `scripts.build:tsup` and `scripts.build:bytenode`: removed
- **`scripts.prepare`: `"npm run build"` — NEW.** Critical for git URL dep consumers; npm runs this automatically after cloning so `dist/` exists in `node_modules/@threadbase/scanner/` even though `dist/` is gitignored.
- `dependencies.bytenode`: removed

- [ ] **Step 3: Refresh the lockfile**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
npm install
```

Expected: completes without errors. `bytenode` is removed from `node_modules/`. `package-lock.json` is updated.

- [ ] **Step 4: Verify the lockfile no longer references bytenode**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
grep -c bytenode package-lock.json || echo "OK — no bytenode in lockfile"
```

Expected: prints `OK — no bytenode in lockfile`.

---

### Task A3: Revert `tsup.config.ts` to pre-bytenode shape

**Files:**
- Modify: `tsup.config.ts`

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `tsup.config.ts` with:

```typescript
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: "dist",
  },
  {
    entry: { cli: "cli/index.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    outDir: "dist",
  },
]);
```

Changes vs current:
- Long comment block about "Two-stage build" removed (no longer accurate — bytenode is gone)
- `sourcemap: false` → `sourcemap: true` (restored)
- CLI entry's `format`: `["cjs"]` → `["esm"]` (restored — original was ESM with shebang)

---

### Task A4: Delete bytenode pipeline files

**Files:**
- Delete: `src/loader/index.cjs`
- Delete: `src/loader/index.js`
- Delete: `src/loader/cli.cjs`
- Delete: `src/loader/` (now-empty directory)
- Delete: `scripts/build-bytenode.mjs`
- Delete: `scripts/assemble-dist.mjs`
- Delete: `.github/workflows/release.yml`

- [ ] **Step 1: Delete the loader source directory**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
rm -rf src/loader
```

Expected: silent success. Verify with `ls src/` — should no longer list `loader/`.

- [ ] **Step 2: Delete the bytenode build scripts**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
rm scripts/build-bytenode.mjs scripts/assemble-dist.mjs
```

Expected: silent success. Verify with `ls scripts/` — should only show `capture-live.sh`, `update-baseline.sh`, `validate-live.ts`.

- [ ] **Step 3: Delete the release workflow**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
rm .github/workflows/release.yml
```

Expected: silent success. Verify with `ls .github/workflows/` — should only show `ci.yml`.

---

### Task A5: Restore CI workflow to pre-bytenode matrix

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run lint

  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/

  test:
    name: Test (Node ${{ matrix.node-version }})
    runs-on: ubuntu-latest
    needs: lint
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm install
      - run: npm test
```

Changes vs current:
- `lint.node-version`: `22` → `20`
- `build.node-version`: `22` → `20`
- Removed the comment about full bytenode build verification in CI
- `test.strategy.matrix.node-version`: `[22, 23, 24, 25, 26]` → `[18, 20, 22]`
- Removed `fail-fast: false` (default behavior restored)

---

### Task A6: Update `README.md` — remove bytenode section, refresh installation guidance

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Show current README**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
head -60 README.md
```

Expected: under `## Installation` there's a `### Supported Node versions` subsection (added during bytenode work) explaining the matrix.

- [ ] **Step 2: Find and remove the bytenode-specific subsection**

Open `README.md`. Locate the `### Supported Node versions` subsection that sits under `## Installation`. It begins with text like "`@ronenmars/threadbase-scanner` ships as V8 bytecode (`.jsc`) compiled for specific Node majors." and ends right before the next top-level `##` section.

Delete that entire subsection (header + body). Also delete the `npm install @ronenmars/threadbase-scanner` line if it appears in the install section — since we're no longer publishing to npm, we don't want to instruct users to `npm install` a package that won't be there.

Replace `## Installation` body with this content:

```markdown
## Installation

This package is consumed from a public GitHub repo, not published to npm.

To use it in your project, add it as a git URL dependency in your `package.json`:

```json
"dependencies": {
  "@threadbase/scanner": "github:RonenMars/threadbase-scanner#v0.3.0"
}
```

Then run `npm install`. npm will clone this repo at tag `v0.3.0`, run its `prepare` script to build `dist/`, and make the package available under `node_modules/@threadbase/scanner/`.

**Requires Node.js 18 or later.**
```

- [ ] **Step 3: Verify the result**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
grep -ic 'bytecode\|\.jsc\|node-22\|node-23\|node-24\|node-25\|node-26' README.md || echo "OK — no bytenode references"
```

Expected: prints `OK — no bytenode references` (or a `0` from the grep — both indicate success).

---

### Task A7: Update `CLAUDE.md` — restore pre-bytenode architecture description

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Show current CLAUDE.md**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
head -100 CLAUDE.md
```

Expected: contains a `### Build pipeline — two stages` subsection and a `### Supported Node versions` subsection under `## Architecture`. The Commands section mentions `build:tsup` and `build:bytenode` scripts.

- [ ] **Step 2: Rewrite the `## Commands` section**

Find the `## Commands` section. Replace its body (the lines between `## Commands` and the next `##` header) with:

```markdown
- `npm test` — run all tests (vitest, 124 tests across 12 files)
- `npm run lint` — type-check + Biome lint (`tsc --noEmit && npx biome check .`)
- `npm run format` — auto-format all files (`npx biome format --write .`)
- `npm run check` — lint + format with auto-fix (`npx biome check --write .`)
- `npm run build` — produces `dist/` via tsup (ESM + CJS + types). Also runs automatically as `prepare` when this repo is installed as a git URL dependency.
- Single test: `npx vitest run __tests__/parser.test.ts`
```

- [ ] **Step 3: Rewrite the `## Architecture` section**

Find the `## Architecture` section. Delete everything between `## Architecture` and the next top-level `##` heading (likely `## Code Conventions` or similar). Replace with:

```markdown
Three layers: **core engine** (src/*.ts) → **API layer** (src/index.ts exports) → **CLI wrapper** (cli/).

The library and CLI are built as separate tsup entries — `src/index.ts` produces `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types, while `cli/index.ts` produces `dist/cli.js` with a shebang.

Key modules and their responsibilities:
- `discovery.ts` — fast-glob `**/*.jsonl` with `/memory/` and `/tool-results/` exclusions
- `parser.ts` — JSONL line-by-line streaming with `parseMeta()` (lightweight) and `parseConversation()` (full)
- `indexer.ts` — FlexSearch document index across all metadata fields
- `filters.ts` — immutable sort/filter/pagination (returns new arrays, never mutates)
- `scanner.ts` — orchestrator that wires discovery → parser → indexer with batching and caching

### Distribution model

This package is consumed via **npm's git URL dependency** mechanism, not via npm publish. Consumers declare `"@threadbase/scanner": "github:RonenMars/threadbase-scanner#<tag>"` in their `package.json`. On install, npm clones this repo at the specified tag, runs `prepare` (which runs `npm run build` → `tsup`), and the resulting `dist/` is what consumers `require`/`import`.

`dist/` is gitignored — it's only ever produced by the `prepare` script during install (or by hand during local development). The `prepare` script is what makes this distribution model work.

A previous attempt at publishing to npm with V8 bytecode (`bytenode`) protection was abandoned after discovering bytenode `.jsc` files are not cross-platform. See `docs/plans/bytenode-npm-package.md` for the full lessons-learned record.
```

---

### Task A8: Add MIT `LICENSE` file

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create the LICENSE file**

Create a new file `LICENSE` at the scanner repo root with this exact contents:

```
MIT License

Copyright (c) 2026 Ronen Mars

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Add a `license` field to `package.json`**

Open `package.json`. After the `"description"` line, add a `"license"` field. The updated section should read:

```json
  "version": "0.3.0",
  "description": "Unified Claude Code conversation history scanner",
  "license": "MIT",
  "type": "module",
```

Save the file.

- [ ] **Step 3: Verify the license is in place**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
ls LICENSE && grep '"license"' package.json
```

Expected: file exists and `package.json` shows `"license": "MIT",`.

---

### Task A9: Run scanner test suite to confirm cleanup didn't break anything

**Files:** none modified — verification only.

- [ ] **Step 1: Run lint**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
npm run lint
```

Expected: `Checked N files in Yms. No fixes applied.` No TypeScript errors.

If lint fails, the most likely cause is a `package.json` typo in Task A2 or a `tsup.config.ts` typo in Task A3. Re-check those files against the templates above.

- [ ] **Step 2: Run the full test suite**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
npm test
```

Expected: `Test Files  12 passed (12)` and `Tests  124 passed (124)`. Tests run against `src/*.ts` directly via vitest, not against `dist/` — so the test outcomes don't depend on the bytenode pipeline being gone or present.

If tests fail, STOP and read the failure carefully. The bytenode cleanup should be invisible to tests, so any failure is likely unrelated to this plan and should be triaged before proceeding.

- [ ] **Step 3: Run the build to confirm `dist/` produces the right shape**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
npm run build
ls dist/
```

Expected output from `ls dist/`:

```
cli.js
cli.js.map
index.cjs
index.cjs.map
index.d.cts
index.d.ts
index.js
index.js.map
```

That's the pre-bytenode dist shape: ESM + CJS + CLI + types + sourcemaps. No `node-XX/` directories. No `.jsc` files. No `supported-nodes.json`.

- [ ] **Step 4: Smoke-test the loader from a Node REPL**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
node -e "const m = require('./dist/index.cjs'); console.log('exports:', Object.keys(m).length); console.log('ConversationScanner:', typeof m.ConversationScanner);"
```

Expected output (line breaks may vary):

```
exports: 25
ConversationScanner: function
```

If any of these checks fail, STOP and consult the spec to identify what went wrong.

---

### Task A10: Commit the scanner cleanup

**Files:** all changes from A2-A8.

- [ ] **Step 1: Stage all changes**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git add -A
git status --short
```

Expected output includes (order may vary):

```
M  .github/workflows/ci.yml
D  .github/workflows/release.yml
M  CLAUDE.md
A  LICENSE
M  README.md
M  package-lock.json
M  package.json
D  scripts/assemble-dist.mjs
D  scripts/build-bytenode.mjs
D  src/loader/cli.cjs
D  src/loader/index.cjs
D  src/loader/index.js
M  tsup.config.ts
```

If any unexpected files appear (e.g., `node_modules/`, `dist/`), check `.gitignore` and exclude them with `git restore --staged <file>` before committing.

- [ ] **Step 2: Show the diff one more time before committing**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git diff --staged --stat
```

Expected: ~13 files changed, with the LICENSE addition + the bytenode deletions. Confirm with the owner before proceeding to commit. (The owner's global CLAUDE.md requires showing the diff and getting explicit approval before `git commit`.)

- [ ] **Step 3: Create the commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git commit -m "chore: remove bytenode pipeline, restore plain JS build, add MIT license"
```

Expected: `[main <sha>] chore: remove bytenode pipeline, restore plain JS build, add MIT license` followed by the file change summary.

If the commit-message-format hook rejects this title, the rule is "conventional commit, single line for non-Briya repos." Scanner is not a Briya repo, so this should pass. If it does fail, check the hook output and adjust accordingly.

- [ ] **Step 4: Verify the commit landed**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git log --oneline -3
```

Expected: top entry is the new chore commit, second is `df517fb docs: capture bytenode lessons + scanner-goes-public design`, third is `192ddd6 fix(release): drop prepublishOnly and --provenance for private repo`.

---

### Task A11: Push scanner main to origin

**Files:** none modified — git remote operation.

- [ ] **Step 1: Push**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git push origin main
```

Expected: `<old-sha>..<new-sha>  main -> main` and no errors. If the hook flags the push for any reason, STOP and report to the owner.

- [ ] **Step 2: Verify CI is happy on the pushed commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
gh run list --workflow=ci.yml --limit 1
```

Expected: a run in `in_progress` or `queued` state for the just-pushed commit.

- [ ] **Step 3: Watch CI to completion**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
RUN_ID=$(gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

Expected: all three jobs (`lint`, `build`, `test (Node 18/20/22)`) succeed. If anything fails, fix forward (or revert and start over) — do not flip the repo to public with broken CI.

---

### Task A12: Flip scanner repo to public

**Files:** none modified — GitHub setting change.

- [ ] **Step 1: Flip visibility via `gh`**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
gh repo edit RonenMars/threadbase-scanner --visibility public --accept-visibility-change-consequences
```

Expected: silent success. If the command isn't available in your `gh` version, do it via the web UI: Settings → Danger Zone → Change visibility → Make public.

- [ ] **Step 2: Verify visibility flipped**

```bash
gh repo view RonenMars/threadbase-scanner --json visibility --jq '.visibility'
```

Expected: `PUBLIC`.

- [ ] **Step 3: Confirm anonymous read works**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://github.com/RonenMars/threadbase-scanner
```

Expected: `HTTP 200`. Anyone on the internet can now read the repo.

---

### Task A13: Tag `v0.3.0` on scanner

**Files:** none modified — git tag.

- [ ] **Step 1: Create the annotated tag**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git tag -a v0.3.0 -m "v0.3.0: first public release. MIT license. Consumed via npm git URL dep (no npm publish)."
```

Expected: silent success.

- [ ] **Step 2: Push the tag to origin**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git push origin v0.3.0
```

Expected: `* [new tag]  v0.3.0 -> v0.3.0`.

- [ ] **Step 3: Verify the tag points at the cleanup commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git show --stat v0.3.0 | head -5
```

Expected: shows the chore commit from Task A10.

**Phase A complete.** Scanner is now a public MIT-licensed GitHub repo at tag `v0.3.0`, with a `prepare` script that builds `dist/` automatically when consumed via git URL dep. Phase B switches the streamer over.

---

## Phase B — Streamer-side changes

All Phase B tasks run with cwd = `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer`.

---

### Task B1: Smoke-test the new consumption path before changing anything else

**Files:** none modified — read-only verification that the git URL dep actually works end-to-end.

This is a "fail fast" check before we delete the submodule. We install scanner from GitHub into a temp directory and confirm it loads — proving the `prepare` script works for outside consumers.

- [ ] **Step 1: Create a clean test directory**

```bash
cd /tmp && rm -rf scanner-git-url-test && mkdir scanner-git-url-test && cd scanner-git-url-test
npm init -y >/dev/null
```

- [ ] **Step 2: Install scanner from GitHub by tag**

```bash
cd /tmp/scanner-git-url-test
npm install "github:RonenMars/threadbase-scanner#v0.3.0"
```

Expected: completes successfully. Takes 5-15 seconds (clones + builds). The output will mention "prepare" running.

- [ ] **Step 3: Verify the package is present and built**

```bash
cd /tmp/scanner-git-url-test
ls node_modules/@threadbase/scanner/dist/ 2>&1 || ls node_modules/@ronenmars/threadbase-scanner/dist/ 2>&1
```

Expected: shows `cli.js`, `index.cjs`, `index.d.cts`, `index.d.ts`, `index.js` (plus `.map` files). The package installs under whichever name resolution npm picks — both should resolve correctly because the package's `name` is `@ronenmars/threadbase-scanner`.

**Important note:** the streamer's `package.json` currently imports as `@threadbase/scanner` (bare specifier). With a git URL dep, npm uses the package's `name` field — `@ronenmars/threadbase-scanner`. This means we need to either:
- (a) **Change scanner's `package.json` `name`** to `@threadbase/scanner` (drops the personal scope but matches streamer's existing imports), OR
- (b) **Keep scanner's `name` as `@ronenmars/threadbase-scanner` and update every import in the streamer** from `@threadbase/scanner` to `@ronenmars/threadbase-scanner`.

The brainstorm assumed (b) implicitly. The simpler path is (a) — but it conflicts with the npm package namespace where `@ronenmars/threadbase-scanner@0.2.2` is tombstoned (the `@ronenmars` scope makes that conflict moot when not publishing, but we'd also have to rename the npm `name` even though we never publish, since git URL dep uses it for the install path). Continue to Step 4 to make the decision concrete.

- [ ] **Step 4: Decide which package name path to use**

Pause and decide with the owner:

**Option A — Rename scanner's `package.json` `name` to `@threadbase/scanner`**. Pros: zero changes to streamer's `import` statements. Cons: drops the personal-scope prefix; the name `@threadbase/scanner` exists as a private-scope reference that isn't taken on npm under your account but the `@threadbase` org doesn't exist (creation was denied earlier per the brainstorm).

**Option B — Keep `@ronenmars/threadbase-scanner` and update streamer imports.** Pros: name is consistent with what we already verified worked. Cons: every `import { ... } from "@threadbase/scanner"` in streamer source becomes `import { ... } from "@ronenmars/threadbase-scanner"`.

**Recommendation:** Option A. Reasoning: (1) the name `@threadbase/scanner` is not used on npm (we never published under that scope — only under `@ronenmars/`), so there's no conflict; (2) it preserves streamer's existing import statements, reducing the diff size in streamer dramatically; (3) the package is consumed only via git URL, so npm-scope ownership doesn't matter for security or squatting.

If owner approves Option A: go back to scanner repo and execute Task A2.5 (below). If Option B: skip Task A2.5 and proceed with import-statement updates in Task B5.

- [ ] **Step 5: Cleanup the test directory**

```bash
rm -rf /tmp/scanner-git-url-test
```

---

### Task A2.5: (Conditional, only if Option A picked in B1.Step 4) Rename scanner's package `name`

**Files:**
- Modify: `package.json` (scanner repo)

Run with cwd = `/Users/ronenmars/Desktop/dev/ai-tools/tb-scanner`.

- [ ] **Step 1: Update the `name` field**

In `/Users/ronenmars/Desktop/dev/ai-tools/tb-scanner/package.json`, change:

```json
"name": "@ronenmars/threadbase-scanner",
```

to:

```json
"name": "@threadbase/scanner",
```

- [ ] **Step 2: Refresh lockfile**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
npm install
```

- [ ] **Step 3: Verify**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
grep '"name"' package.json | head -1
```

Expected: `"name": "@threadbase/scanner",`.

- [ ] **Step 4: Update README and CLAUDE.md to reflect the new name**

In both files, replace any remaining occurrences of `@ronenmars/threadbase-scanner` with `@threadbase/scanner`.

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
grep -l '@ronenmars/threadbase-scanner' README.md CLAUDE.md
```

For each file listed, manually edit to replace the references. Verify after:

```bash
grep -c '@ronenmars/threadbase-scanner' README.md CLAUDE.md
```

Expected: `0` for both (or no output if files have no matches).

- [ ] **Step 5: Re-run smoke checks**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
npm run lint && npm test
```

Expected: all green, as before.

- [ ] **Step 6: Create a follow-up commit with the rename**

Since the previous commit (Task A10) has already been pushed to origin in Task A11, we **must not** amend it. Create a new commit instead:

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git add -A
git commit -m "chore: rename package to @threadbase/scanner for git URL dep consumers"
```

- [ ] **Step 7: Push and re-tag**

If the tag `v0.3.0` was already pushed (Task A13), we need to move it because Option A changes the package contents that downstream consumers will fetch by that tag.

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git push origin main
git tag -fa v0.3.0 -m "v0.3.0: first public release. MIT. @threadbase/scanner via git URL dep."
git push origin v0.3.0 --force
```

**Note:** force-pushing a tag is normally a "destructive operation requiring confirmation." It's acceptable here because (a) the tag is brand new — we just created it minutes ago in Task A13, (b) nobody outside is depending on it yet, and (c) we're moving it forward to the correct commit. Confirm with the owner before running `--force`.

- [ ] **Step 8: Re-run the git URL dep smoke test from B1**

Run B1.Steps 1-3 again to confirm `npm install "github:RonenMars/threadbase-scanner#v0.3.0"` now installs as `@threadbase/scanner`.

---

### Task B2: Update streamer's `package.json` to use git URL dep

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Show the current dep line**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep '@threadbase/scanner' package.json
```

Expected: `"@threadbase/scanner": "file:./vendor/scanner",`.

- [ ] **Step 2: Replace the dep line**

In `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/package.json`, change:

```json
"@threadbase/scanner": "file:./vendor/scanner",
```

to:

```json
"@threadbase/scanner": "github:RonenMars/threadbase-scanner#v0.3.0",
```

Save the file.

- [ ] **Step 3: Verify**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep '@threadbase/scanner' package.json
```

Expected: `"@threadbase/scanner": "github:RonenMars/threadbase-scanner#v0.3.0",`.

---

### Task B3: Reinstall and verify scanner resolves from GitHub

**Files:** none modified — verification.

- [ ] **Step 1: Remove old node_modules and vendored scanner build outputs**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
rm -rf node_modules
```

- [ ] **Step 2: Reinstall**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
npm install
```

Expected: completes successfully. Notice that during install, npm clones scanner from GitHub (you'll see git-related output). Takes a bit longer than usual.

- [ ] **Step 3: Verify scanner landed under node_modules**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
ls node_modules/@threadbase/scanner/dist/
```

Expected: shows `cli.js`, `index.cjs`, `index.d.cts`, `index.d.ts`, `index.js` (plus `.map`).

- [ ] **Step 4: Verify scanner's imports resolve**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
node -e "const m = require('@threadbase/scanner'); console.log('OK:', Object.keys(m).length, 'exports'); console.log('ConversationScanner:', typeof m.ConversationScanner);"
```

Expected:

```
OK: 25 exports
ConversationScanner: function
```

- [ ] **Step 5: Run streamer lint + build + test**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
npm run lint
npm run build
npm test
```

Expected: all green. Build produces `dist/cli.cjs` with scanner bundled inline (same as before). Tests pass at the same count as the current state.

If anything fails here, STOP. The git URL dep is the load-bearing change of this whole plan — if streamer can't build/test with scanner from GitHub, do not continue with submodule removal until the failure is resolved.

---

### Task B4: Remove the `vendor/scanner` submodule

**Files:**
- Modify: `.gitmodules`
- Delete: `vendor/scanner/` (entire directory, tracked as submodule)

- [ ] **Step 1: Deinitialize the submodule**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git submodule deinit -f vendor/scanner
```

Expected: `Cleared directory 'vendor/scanner'` or similar success message.

- [ ] **Step 2: Remove the submodule from git tracking**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git rm -f vendor/scanner
```

Expected: `rm 'vendor/scanner'`.

- [ ] **Step 3: Clean up the residual `.git/modules/vendor/scanner` directory**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
rm -rf .git/modules/vendor/scanner
```

Expected: silent success. This is git's local-only cache for the submodule; deleting it ensures `git status` is clean.

- [ ] **Step 4: Verify .gitmodules now only has menubar**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
cat .gitmodules
```

Expected output:

```
[submodule "vendor/menubar"]
	path = vendor/menubar
	url = git@github.com:RonenMars/threadbase-menubar.git
```

If the file still contains a `[submodule "vendor/scanner"]` block, the `git rm -f vendor/scanner` step didn't remove it automatically. Open `.gitmodules` and remove the scanner block manually.

- [ ] **Step 5: Confirm the working tree state**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git status --short | head -10
ls vendor/ 2>&1
```

Expected: `git status` shows `.gitmodules` modified, `vendor/scanner` deleted, `package.json` modified, `package-lock.json` modified. The `ls vendor/` should show only `menubar/`.

---

### Task B5: Strip scanner-build logic from `scripts/deploy.sh` (macOS)

**Files:**
- Modify: `scripts/deploy.sh`

- [ ] **Step 1: Remove the usage-comment line at line 7**

Open `scripts/deploy.sh`. Find this block near the top:

```bash
#   scripts/deploy.sh                       # build + deploy current HEAD (uses pinned scanner submodule)
#   scripts/deploy.sh --force               # rebuild even if release dir already exists
#   scripts/deploy.sh --update-scanner      # bump vendor/scanner to its remote main, then deploy
```

Delete the `--update-scanner` line (line 7 as of writing). Update the comment on line 5 from "(uses pinned scanner submodule)" to remove that parenthetical — the new comment should read:

```bash
#   scripts/deploy.sh                       # build + deploy current HEAD
```

- [ ] **Step 2: Remove the `SCANNER_DIR` variable on line 37**

Find:

```bash
SCANNER_DIR="$REPO_ROOT/vendor/scanner"
```

Delete this entire line.

- [ ] **Step 3: Remove the `ensure_scanner_built` function (lines 224-260)**

Find the comment block + function definition:

```bash
# Ensure the scanner submodule is checked out and built. Idempotent — skips
# `npm install`/`npm run build` if scanner's dist/ is already up-to-date with
# the newest src/ file.
ensure_scanner_built() {
  local update_scanner="$1"

  if [[ ! -f "$SCANNER_DIR/package.json" ]]; then
    log "initializing vendor/scanner submodule"
    git submodule update --init --recursive vendor/scanner
  fi
  ...
}
```

Delete the entire function — the comment block (3 lines starting with `# Ensure the scanner submodule...`) plus the `ensure_scanner_built()` function body plus its closing `}`. As of writing, this spans lines 224-260.

- [ ] **Step 4: Remove the `--update-scanner` flag handling around line 650-654**

Find:

```bash
  local force="" update_scanner=0 publish_menubar_flag=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force)            force="--force" ;;
      --update-scanner)   update_scanner=1 ;;
      --publish-menubar)  publish_menubar_flag=1 ;;
```

Remove the `--update-scanner)` line. Also remove `update_scanner=0` from the local declaration:

```bash
  local force="" publish_menubar_flag=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force)            force="--force" ;;
      --publish-menubar)  publish_menubar_flag=1 ;;
```

- [ ] **Step 5: Remove the `ensure_scanner_built` call around line 681**

Find:

```bash
  ensure_scanner_built "$update_scanner"
```

Delete this entire line.

- [ ] **Step 6: Update the case-arm filter around line 757**

Find:

```bash
  --force|--update-scanner|--publish-menubar)
```

Change to:

```bash
  --force|--publish-menubar)
```

- [ ] **Step 7: Update the usage string around line 778**

Find:

```bash
    echo "usage: $0 [deploy [--force] [--update-scanner] [--publish-menubar] | menubar [--publish] | rollback | status | healthcheck]" >&2
```

Change to:

```bash
    echo "usage: $0 [deploy [--force] [--publish-menubar] | menubar [--publish] | rollback | status | healthcheck]" >&2
```

- [ ] **Step 8: Final sanity check**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep -nE 'scanner|SCANNER|--update-scanner' scripts/deploy.sh
```

Expected: a small handful of legitimate matches (e.g., function docstrings mentioning "scanner" historically, or no matches at all). NO references to `SCANNER_DIR`, `ensure_scanner_built`, `--update-scanner`, or `vendor/scanner`.

---

### Task B6: Strip scanner-build logic from `scripts/deploy.ps1` (Windows)

**Files:**
- Modify: `scripts/deploy.ps1`

The PowerShell script mirrors the bash one. Apply the same shape of removals, line numbers will differ slightly.

- [ ] **Step 1: Remove the usage-comment line about `-UpdateScanner`**

Find around line 9:

```powershell
#   pwsh scripts/deploy.ps1 -UpdateScanner     # bump vendor/scanner pin first
```

Delete this line.

- [ ] **Step 2: Remove the `$scannerDir` variable on line 42**

Find:

```powershell
$scannerDir  = Join-Path $repoRoot 'vendor\scanner'
```

Delete this line.

- [ ] **Step 3: Remove the entire scanner-build block (lines ~131-170)**

Find the section that handles the scanner submodule init, bump, and build. It will start with something like:

```powershell
if (-not (Test-Path (Join-Path $scannerDir 'package.json'))) {
  Write-Log "initializing vendor/scanner submodule"
  ...
}
```

And continues through the build logic (`Push-Location $scannerDir`, `npm install`, `npm run build`, `Pop-Location`). Delete the entire block — every line that references `$scannerDir` or `vendor/scanner` or "scanner submodule".

- [ ] **Step 4: Remove the `-UpdateScanner` parameter declaration**

Find the `param(...)` block near the top of the script. Locate the line declaring the `-UpdateScanner` switch parameter, e.g.:

```powershell
[switch]$UpdateScanner,
```

Delete this line.

- [ ] **Step 5: Remove the `Ensure-ScannerBuilt -UpdateScanner:$UpdateScanner` call**

Find any line that calls the scanner-build function or passes the `$UpdateScanner` flag. Delete those lines.

- [ ] **Step 6: Final sanity check**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep -niE 'scanner|UpdateScanner' scripts/deploy.ps1
```

Expected: no matches related to `vendor/scanner`, `scannerDir`, or `UpdateScanner` flag. Some incidental matches in comments are fine if they're descriptive.

---

### Task B7: Strip scanner-build logic from `scripts/deploy-linux.sh`

**Files:**
- Modify: `scripts/deploy-linux.sh`

Mirror of B5 for Linux/systemd. Same shape of removals.

- [ ] **Step 1: Remove usage-comment line about `--update-scanner`**

Find around line 9:

```bash
#   scripts/deploy-linux.sh --update-scanner  # bump vendor/scanner pin first
```

Delete this line.

- [ ] **Step 2: Remove the `SCANNER_DIR` variable on line 39**

Find:

```bash
SCANNER_DIR="$REPO_ROOT/vendor/scanner"
```

Delete this line.

- [ ] **Step 3: Remove the `ensure_scanner_built()` function (lines 87-120)**

Find and delete the entire `ensure_scanner_built()` function definition, just as in B5.Step 3.

- [ ] **Step 4: Remove the `--update-scanner` flag handling around line 326**

Find:

```bash
  local force="" update_scanner=0
  ...
      --update-scanner) update_scanner=1 ;;
```

Remove the `--update-scanner)` case-arm and remove `update_scanner=0` from the local declaration.

- [ ] **Step 5: Remove the `ensure_scanner_built` call**

Search for `ensure_scanner_built` in the file:

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep -n ensure_scanner_built scripts/deploy-linux.sh
```

Delete every line that calls or references it.

- [ ] **Step 6: Final sanity check**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep -niE 'scanner|SCANNER|--update-scanner' scripts/deploy-linux.sh
```

Expected: no matches related to the scanner submodule.

---

### Task B8: Update streamer's `package.json` to remove the `deploy:update-scanner` script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Find the script**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep -n 'deploy:update-scanner' package.json
```

Expected: shows one match, e.g.:

```
46:    "deploy:update-scanner": "scripts/deploy.sh deploy --update-scanner",
```

- [ ] **Step 2: Remove the line**

Open `package.json`, find the line above, delete it. Be careful not to break the JSON (the line above and below this entry should still join with the correct comma — check the resulting JSON is valid).

- [ ] **Step 3: Validate JSON**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))" && echo "OK valid JSON"
```

Expected: `OK valid JSON`.

---

### Task B9: Update streamer's `CLAUDE.md` to reflect the new scanner consumption model

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the scanner reference**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep -n '@threadbase/scanner' CLAUDE.md
```

Expected: one or two matches, including a line in the "Dependencies" section.

- [ ] **Step 2: Update the Dependencies section**

Find the line that reads:

```markdown
- `@threadbase/scanner` — scan, parse, search, filter conversation history (used for REST endpoints)
```

Change it to:

```markdown
- `@threadbase/scanner` — scan, parse, search, filter conversation history. Consumed from public GitHub repo via npm git URL dep (`github:RonenMars/threadbase-scanner#<tag>`). Used for REST endpoints. See [scanner repo](https://github.com/RonenMars/threadbase-scanner) for source.
```

- [ ] **Step 3: Find and remove any other references to the submodule**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
grep -niE 'vendor/scanner|--update-scanner|deploy:update-scanner|ensure_scanner_built|update-scanner' CLAUDE.md
```

For each match, edit `CLAUDE.md` to either remove the line or rewrite it to reflect the new model (no submodule, scanner consumed via npm git URL).

After edits, re-run the grep:

```bash
grep -niE 'vendor/scanner|--update-scanner|deploy:update-scanner|ensure_scanner_built' CLAUDE.md
```

Expected: no matches (or only matches in unrelated context like "see history for the bytenode attempt").

---

### Task B10: Run streamer end-to-end verification

**Files:** none modified — verification.

- [ ] **Step 1: Clean and reinstall**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
rm -rf node_modules dist
npm install
```

Expected: clean install, scanner fetched from GitHub, no errors.

- [ ] **Step 2: Run lint**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
npm run lint
```

Expected: clean.

- [ ] **Step 3: Run build**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
npm run build
```

Expected: produces `dist/cli.cjs`. Verify scanner is bundled in:

```bash
grep -c 'ConversationScanner' dist/cli.cjs
```

Expected: a number greater than 0 (scanner's class is referenced inside the bundle).

- [ ] **Step 4: Run tests**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
npm test
```

Expected: all tests pass at the same count as before this plan started. If any tests fail, read the failure carefully — most likely cause is a path-related issue from the submodule removal that didn't manifest in lint/build.

- [ ] **Step 5: Local deploy (macOS only — skip on other platforms)**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
npm run deploy
```

Expected: deploy completes successfully, healthcheck passes, the service is running.

- [ ] **Step 6: Confirm `/healthz` responds**

```bash
curl -s http://localhost:8766/healthz
```

Expected: JSON output containing `"ok":true` and a `"version"` field.

- [ ] **Step 7: Smoke-test scanner-backed endpoint**

```bash
API_KEY=$(yq .api_key ~/.threadbase/server.yaml 2>/dev/null || awk '/api_key:/{print $2}' ~/.threadbase/server.yaml | tr -d '"')
curl -s -H "Authorization: Bearer $API_KEY" "http://localhost:8766/api/conversations?limit=5" | head -c 300
```

Expected: JSON list of conversations returned. This exercises the scanner via the streamer's REST API end-to-end.

If any of B10's steps fail, STOP. The deployed streamer is the integration point — failures here indicate the change broke something important and we should troubleshoot before committing.

---

### Task B11: Commit the streamer changes

**Files:** all changes from B2-B9.

- [ ] **Step 1: Stage all changes**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git add -A
git status --short
```

Expected output includes:

```
M  .gitmodules
M  CLAUDE.md
M  package.json
M  package-lock.json
M  scripts/deploy-linux.sh
M  scripts/deploy.ps1
M  scripts/deploy.sh
D  vendor/scanner
```

If `docs/research/` (the research dossier from the background agent) is also showing as untracked, decide with the owner whether to include it in this commit or commit it separately. Default: include it as a separate follow-up commit so the scanner-switch commit stays focused.

- [ ] **Step 2: Show the staged diff**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git diff --staged --stat
```

Show the owner. Confirm before committing.

- [ ] **Step 3: Create the commit**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git commit -m "feat: consume @threadbase/scanner from public GitHub instead of submodule"
```

Expected: clean commit. If the hook flags it for any reason, STOP and report.

- [ ] **Step 4: Verify the commit landed**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git log --oneline -3
```

Expected: top entry is the new feat commit.

---

### Task B12: Push streamer main to origin

**Files:** none modified — git remote operation.

- [ ] **Step 1: Push**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git push origin main
```

Expected: clean push.

- [ ] **Step 2: Confirm streamer is healthy after the push**

A previous local deploy in Task B10 already verified the running service. No need to redeploy unless the push triggers any CI.

```bash
curl -s http://localhost:8766/healthz
```

Expected: `{"ok":true,...}`.

**Phase B complete.** Streamer now consumes scanner from public GitHub via npm git URL dep. The `vendor/scanner` submodule is gone. The three deploy scripts no longer touch scanner at all.

---

## Final verification

- [ ] **Step 1: From an outsider's perspective — anonymous clone + install**

```bash
cd /tmp && rm -rf outside-contributor-test && mkdir outside-contributor-test && cd outside-contributor-test
git clone https://github.com/RonenMars/threadbase-scanner.git
cd threadbase-scanner
npm install
npm run build
node -e "console.log(Object.keys(require('./dist/index.cjs')).length, 'exports')"
```

Expected: clone succeeds (proves public), `npm install` succeeds (proves package.json has no private deps), `npm run build` succeeds (proves tsup config is correct), `node -e` prints `25 exports` (proves the build output is functional).

- [ ] **Step 2: Verify the failed bytenode tags are still on GitHub (kept as honest history)**

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git ls-remote --tags origin | grep -E 'v0\.[0-9]' | head -5
```

Expected: shows `v0.2.0`, `v0.2.2`, `v0.3.0` (and possibly others). The pre-v0.3 tags stay where they are.

- [ ] **Step 3: Cleanup test directories**

```bash
rm -rf /tmp/outside-contributor-test /tmp/scanner-git-url-test 2>/dev/null
```

- [ ] **Step 4: Mark this plan complete**

In a follow-up commit (or just verbally to the owner), note that the scanner-goes-public migration is complete and Sub-project B (streamer-on-npm) is the next planned work.

---

## Rollback procedures

If any phase needs to be undone:

### Roll back Phase B (streamer changes)

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
git revert HEAD
git push origin main
```

This restores the submodule reference, the deploy script logic, and the `vendor/scanner` directory. Run `git submodule update --init vendor/scanner` after the revert to repopulate the submodule on disk.

### Roll back Phase A (scanner changes)

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-scanner
git revert HEAD~1  # the rename commit, if Option A was picked
git revert HEAD    # the cleanup commit
git push origin main
```

For visibility flip back to private:

```bash
gh repo edit RonenMars/threadbase-scanner --visibility private --accept-visibility-change-consequences
```

Tag `v0.3.0` can be deleted from GitHub:

```bash
git push origin --delete v0.3.0
git tag -d v0.3.0
```

---

## Out of scope (for clarity)

- Streamer's install model (npm-first refactor). Sub-project B, separate brainstorm/plan.
- Publishing scanner to npm. Trivially reversible one-line change in streamer's `package.json` later if needed.
- Minifying scanner's output. Small future polish, not part of this plan.
- Anything in `vendor/menubar` or its deploy path.

