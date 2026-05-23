# Plan: Ship `@ronenmars/threadbase-scanner` as bytenode-compiled npm package

## Context

`tb-streamer` is moving to a public open-source repo (MIT). The scanner code at `tb-scanner` (currently a git submodule at `vendor/scanner`) contains logic the project owner considers proprietary — the JSONL parsing, agent-conversation detection, indexing, and search internals. Today scanner is bundled directly into streamer's `cli.cjs` via tsup's `noExternal` rule, so its TypeScript source is effectively shipped to every user as readable JavaScript.

Goal: protect scanner's implementation while keeping the streamer a genuine open-source project that outsiders can clone, install, build, and contribute to. The chosen approach is:

1. **Externalize scanner from the streamer bundle.**
2. **Ship scanner as a public npm package** (`@ronenmars/threadbase-scanner`), with its source repo remaining private.
3. **Compile scanner to V8 bytecode (`.jsc`) via bytenode** for 5 Node majors (22, 23, 24, 25, 26), shipped together inside the npm tarball.
4. **Hard-error fallback** when a user runs an unsupported Node version — no plain-JS escape hatch.

The streamer's public API to `tb-mobile` is unaffected (scanner is internal). Scanner's existing env-var configuration (`THREADBASE_FILTER_AGENT_CONVERSATIONS`, `THREADBASE_AGENT_ENTRYPOINTS`) and function signatures stay identical — bytecode protects the implementation, not the interface.

## Architecture decisions

- **Distribution channel**: public npm under the `@threadbase` org. Public scope → free, anyone can `npm install`. Source repo stays private on GitHub.
- **Node version matrix**: 22, 23, 24, 25, 26 (2 LTS + 1 EOL non-LTS + 2 current). Drops Node 20 (EOL April 2026) and earlier.
- **Fallback**: hard error at module load. The loader inspects `process.versions.node`, finds no matching `.jsc`, throws with a clear message listing supported majors. No silent plain-JS fallback.
- **Build pipeline**: scanner's own GitHub Actions matrix produces all `.jsc` variants. Publish job assembles them into one tarball and runs `npm publish`. Streamer consumes from npm like any other dep.
- **CLI**: scanner ships a `threadbase-scanner` binary (`bin` field in `package.json`). It needs the same bytenode treatment — the CLI's entrypoint will be a tiny plain-JS bootstrap that delegates to the per-Node `.jsc`.

## Files to modify

### In `tb-scanner` (private repo)

1. **`package.json`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-scanner/package.json`
   - Add `bytenode` to `dependencies`
   - Drop `engines.node` floor from `>=18` to `>=22` (the matrix's lowest)
   - Keep `files: ["dist"]` — what's inside `dist/` is what changes, not what's published
   - `main` / `module` / `exports` continue pointing at `dist/index.cjs` / `dist/index.js` — those become loader files, not bundled source

2. **`tsup.config.ts`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-scanner/tsup.config.ts`
   - Unchanged for the build step itself. tsup still produces `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/cli.js` (CLI), and `dist/index.d.ts`.
   - Output of tsup becomes the **input to the bytenode step**, not the final shipped artifact.

3. **`scripts/build-bytenode.mjs`** (new file) — runs after `tsup`:
   - Reads the current `process.versions.node` major
   - Runs `bytenode --compile dist/index.cjs --out dist/node-<major>/index.jsc`
   - Same for `dist/cli.js` → `dist/node-<major>/cli.jsc`
   - Leaves `dist/index.d.ts` and `dist/index.d.cts` alone — types ship plain

4. **`src/loader/index.cjs.tmpl`** + **`src/loader/index.js.tmpl`** + **`src/loader/cli.tmpl`** (new files) — small loader templates:
   - Reads `process.versions.node` major
   - Checks `node-<major>/index.jsc` exists
   - On miss: throws with message listing supported majors discovered from `fs.readdirSync(__dirname)` (filter to `node-*` directories)
   - On hit: `require('bytenode'); module.exports = require('./node-<major>/index.jsc')`
   - These templates get copied into `dist/` by the build script, replacing tsup's bundled output

5. **`scripts/assemble-dist.mjs`** (new file) — runs once at the publish step (after all matrix artifacts are collected):
   - Combines per-Node `dist/node-<major>/*.jsc` artifacts from all 5 jobs
   - Copies loader files into place as `dist/index.js`, `dist/index.cjs`, `dist/cli.js`
   - Preserves `dist/index.d.ts` and `dist/index.d.cts` (types)
   - Writes `dist/supported-nodes.json` with `{"majors": [22, 23, 24, 25, 26]}` for runtime introspection and tests

6. **`.github/workflows/release.yml`** (new file) — replaces or augments existing `ci.yml`:
   - Trigger: `push: tags: ['v*']` and `workflow_dispatch`
   - **`compile` job**: matrix over `node: [22, 23, 24, 25, 26]`. Each runs `npm ci`, `npm run build`, `node scripts/build-bytenode.mjs`, then `actions/upload-artifact` with name `jsc-node-${{ matrix.node }}`.
   - **`publish` job**: needs `compile`. Downloads all matrix artifacts with `merge-multiple: true`, runs `node scripts/assemble-dist.mjs`, then `npm publish --access public` with `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`.

7. **`.github/workflows/ci.yml`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-scanner/.github/workflows/ci.yml`
   - Update test matrix from `[18, 20, 22]` to `[22, 23, 24, 25, 26]` to match shipped support
   - Lint and build jobs: bump from `node-version: 20` to `22` (lowest supported)

8. **`README.md`** + **`CLAUDE.md`** — document the supported Node versions and the bytenode build pipeline at a high level. Note that the published npm package contains bytecode, not source.

### In `tb-streamer` (going public)

1. **`package.json`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/package.json`
   - Change `"@ronenmars/threadbase-scanner": "file:./vendor/scanner"` → `"@ronenmars/threadbase-scanner": "^0.2.0"` (or whatever version the first npm-published scanner is)
   - Bump `engines.node` from `>=18` to `>=22` to match scanner's matrix (otherwise users on Node 18-20 get cryptic load-time errors)

2. **`tsup.config.ts`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/tsup.config.ts` (line 38-39)
   - Add `"@ronenmars/threadbase-scanner"` to the CLI `external` array
   - Add `"bytenode"` to the same `external` array (scanner's loader requires it at runtime; it must not be bundled)
   - The `noExternal: [/^(?!node-pty|better-sqlite3).*/]` regex needs updating to also exclude scanner and bytenode: `noExternal: [/^(?!node-pty|better-sqlite3|@threadbase\/scanner|bytenode).*/]`

3. **`scripts/deploy.sh`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/scripts/deploy.sh`
   - Remove the entire `ensure_scanner_built()` function (lines 224-260) and the `--update-scanner` CLI flag plumbing
   - Update the `node_modules` copy loop at line 718 from `for mod in node-pty better-sqlite3 bindings file-uri-to-path` to also include `@ronenmars/threadbase-scanner` and `bytenode` — note the scoped-package path needs a `mkdir -p node_modules/@threadbase` first
   - Drop the submodule-init logic for `vendor/scanner` (keep it for `vendor/menubar`)

4. **`scripts/deploy.ps1`** (Windows) and **`scripts/deploy-linux.sh`** — same `node_modules` copy logic adjustments. Verify scoped-package directory creation works on Windows.

5. **`.gitmodules`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/.gitmodules`
   - Remove the `[submodule "vendor/scanner"]` block (keep `vendor/menubar`)

6. **`vendor/scanner/`** directory — delete entirely (`git rm -r vendor/scanner` + `git submodule deinit vendor/scanner`)

7. **`CLAUDE.md`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/CLAUDE.md`
   - Update the "Dependencies" section: `@ronenmars/threadbase-scanner` is now an npm dep, not a submodule
   - Update the "Build notes" section: scanner is no longer in `vendor/`, no longer needs `ensure_scanner_built`
   - Add a note in "Environment variables" section that `THREADBASE_FILTER_AGENT_CONVERSATIONS` and `THREADBASE_AGENT_ENTRYPOINTS` are consumed by the scanner package
   - New section "Node version support" listing the supported majors (22-26) and explaining that the streamer hard-errors on unsupported runtimes due to scanner's bytecode format

8. **`README.md`** (public-facing) — new or updated section explaining: Node 22+ required, the streamer is open source but uses a closed-source scanner library distributed via npm, link to npm package page.

9. **`src/server.ts`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/server.ts`
   - No code change needed. Imports of `ConversationScanner`, `applyIncludeFilter`, `applyPagination`, `applyProjectFilter`, `applySort`, `search` continue to work — they resolve through the loader to the `.jsc`.
   - Optional: add scanner version to `/api/info` response: `const scannerVersion = require('@ronenmars/threadbase-scanner/package.json').version` — surface in startup log and health endpoint. Useful for bug reports.

10. **`src/services/projectChats/listProjectChats.ts`** — at `/Users/ronenmars/Desktop/dev/ai-tools/tb-streamer/src/services/projectChats/listProjectChats.ts`
    - No code change. `import type { ConversationScanner }` resolves through `.d.ts`, which ships unobfuscated alongside the `.jsc`.

## Existing utilities to reuse

- **Scanner's tsup build** (`tb-scanner/tsup.config.ts`) — keep producing `dist/index.cjs` and `dist/cli.js`. These are the inputs to bytenode, not changes to the build itself.
- **Streamer's deploy `node_modules` copy loop** (`scripts/deploy.sh` line 718) — extend the existing pattern; don't invent a new one. The loop already handles "external modules that need to be alongside `cli.cjs` at runtime."
- **Existing `engines.node` check** in scanner's `package.json` — `npm install` already refuses to install scanner if Node is too old; the bytecode hard-error is the second line of defense.
- **`actions/setup-node@v4`** in scanner's CI — supports explicit major-version numbers (`22`, `23`, `24`, `25`, `26`), no special syntax needed. Note: at the time of writing, Node 26 won't exist until April 2026; the matrix will need to fall back gracefully for not-yet-released versions until then (covered in verification below).

## Out of scope (intentional)

- **Code obfuscation** of the loader or `.d.ts` files. Both ship as plain text by design — the loader is uninteresting dispatch code, and `.d.ts` is the public interface that IDE tooling needs.
- **Encrypted `.jsc` files**. Bytecode is the protection; further wrapping (e.g., AES-encrypting the `.jsc` and decrypting at load) adds key-management problems without meaningful additional protection.
- **Subprocess-based architecture** (Node SEA / pkg / nexe). Considered and rejected — would require rewriting every scanner call site as async IPC.
- **Auto-discovery of supported Node majors**. The supported list is hardcoded in CI; we deliberately don't try to ship every Node version ever. New majors get added by editing the workflow matrix and re-releasing.
- **Migration path for users on Node 18-21**. They'll hit the hard-error and need to upgrade Node. Documented in README, not engineered around.

## Verification

After implementation, verify in this order:

1. **Scanner builds locally on each target Node**:
   ```bash
   cd tb-scanner
   for v in 22 23 24 25 26; do
     nvm use $v && npm ci && npm run build && node -e "require('./dist/index.cjs')"
   done
   ```
   Expect: each invocation loads without error. (Node 26 may need to be skipped until released — note the workflow may need to handle that gracefully.)

2. **Scanner publishes to npm (dry run)**:
   ```bash
   cd tb-scanner
   npm publish --dry-run --access public
   ```
   Expect: tarball contents include only `dist/`, with loader files + `node-*/` subdirectories + `.d.ts` files. No `src/`, no `.jsc` outside `node-*/`.

3. **Tarball contains no source**:
   ```bash
   npm pack
   tar -tzf threadbase-scanner-*.tgz | grep -E '\.(ts|js)$'
   ```
   Expect: only `dist/index.js`, `dist/index.cjs`, `dist/cli.js` (the loaders, plain) — no `.ts` files, no other `.js` files outside loaders.

4. **Streamer builds with externalized scanner**:
   ```bash
   cd tb-streamer
   npm install
   npm run build
   grep -c 'class ConversationScanner' dist/cli.cjs || echo "OK - scanner not bundled"
   ```
   Expect: zero matches. Scanner is no longer inlined into `cli.cjs`.

5. **Streamer runs end-to-end with `.jsc` scanner**:
   ```bash
   cd tb-streamer
   npm test
   npm run deploy  # local deploy
   curl http://localhost:8766/healthz
   curl -H "Authorization: Bearer $(yq .api_key ~/.threadbase/server.yaml)" http://localhost:8766/api/info
   ```
   Expect: tests pass; deploy succeeds; `/healthz` returns `{ok, version}`; `/api/info` includes a `scannerVersion` field matching the installed `@ronenmars/threadbase-scanner` version.

6. **Hard-error fallback fires on unsupported Node**:
   ```bash
   nvm use 20
   cd tb-streamer && node dist/cli.cjs
   ```
   Expect: clear error message "`@ronenmars/threadbase-scanner does not support Node 20.x.y. Supported majors: 22, 23, 24, 25, 26.`" — and the streamer process exits non-zero, doesn't start.

7. **tb-mobile compatibility check** — connect a mobile client to the freshly-deployed streamer:
   - Pair via QR
   - Open the conversation list (exercises `/api/conversations`, the agent-conversation filter)
   - Resume an existing conversation (exercises scanner's `getConversation`)
   - Search (exercises scanner's search index)

   Expect: identical behavior to pre-bytenode build. Same filter behavior, same search results, same conversation list.

8. **Auto-updater swap test**:
   ```bash
   # On a machine running an old (pre-bytenode) streamer:
   threadbase-streamer update --force --version v<new>
   ```
   Expect: updater downloads new tarball (now slightly bigger due to 5× `.jsc` files), swaps current symlink, restarts service, `/healthz` recovers within ~10s, menubar reconnects.

9. **Public-repo contributor flow** — simulate from a clean account:
   ```bash
   git clone https://github.com/<you>/tb-streamer.git
   cd tb-streamer && npm install && npm run build && npm test
   ```
   Expect: completes without needing access to private scanner repo. Confirms the open-source promise is honest.

If all nine pass, the migration is complete. The protected scanner ships as bytecode to all users worldwide on Node 22-26; the streamer source is genuinely cloneable, buildable, and contributable on the public repo.

---

## What we learned (2026-05-23 attempt)

This plan was executed once and **failed** during real-world distribution testing. We published `@ronenmars/threadbase-scanner@0.2.2` to public npm with a 5-Node-major matrix of `.jsc` files, then unpublished it within the 72h window after discovering it could not load on the target user platforms.

Pinning these findings so the next attempt doesn't repeat the discovery loop.

### Finding 1: bytenode `.jsc` is NOT cross-platform — period

The bytenode README claims `.jsc` files are "CPU-agnostic." This is misleading. In practice:

- A `.jsc` compiled on **Linux x86_64 (GitHub Actions `ubuntu-latest`)** crashes with `# Fatal error in , line 0 / # Check failed: index < size().` when loaded on **macOS ARM64 (Apple Silicon)** — even with **identical Node version `v24.15.0` on both sides**.
- The crash happens deep in `v8::internal::DescriptorArray::Sort()` during heap deserialization (`Rehash`). It is **not** the source-hash check (bytenode's `generateScript` already neutralizes that via the `​`-padding trick); it's a different V8 invariant that depends on CPU feature flags.
- Confirmed by the bytenode maintainer in [bytenode#244](https://github.com/bytenode/bytenode/issues/244): *"That way you described it [Windows-build → Linux-run], isn't possible and will never be possible unless v8 itself supports such a thing."*
- The README itself walks this back with: *"V8 sanity checks include some checks related to CPU supported features, so this may cause errors in some rare cases."* The cases are not rare — they're every cross-OS, cross-CPU-arch boundary.

**Implication for any future attempt**: a 5-Node matrix is not sufficient. Real coverage requires `{node-major} × {OS-arch}` = e.g. `[22,23,24,25,26] × [linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64]` = **25 build jobs and 25 `.jsc` directories** in the published tarball. Roughly 1.9 MB of bytecode per release. The loader must dispatch on `process.versions.node` + `process.platform` + `process.arch`. Workflow needs runner matrix with `runs-on: ${{ matrix.os }}`.

### Finding 2: `--provenance` requires a public source repo

`npm publish --provenance` rejects publishes from private GitHub repos:

```
422 Unprocessable Entity - Error verifying sigstore provenance bundle:
Unsupported GitHub Actions source repository visibility: "private".
Only public source repositories are supported when publishing with provenance.
```

The sigstore transparency log assumes anyone can audit the build by reading the public repo. Since the whole point of bytenode is to keep source private, **provenance is incompatible with our threat model**. Don't add `id-token: write` and `--provenance` in the publish workflow.

### Finding 3: `prepublishOnly` blows away matrix-assembled `dist/`

`npm publish` triggers `prepublishOnly`, which our package had set to `npm run build`. In the CI publish job — which had already downloaded all 5 per-Node artifacts into `dist/` — this rebuilt the whole thing for only the publish runner's Node version, deleting `node-22/`, `node-23/`, `node-25/`, `node-26/` and leaving only `node-24/`. The shipped tarball had `.jsc` for one Node major instead of five.

**Fix**: drop `prepublishOnly` entirely. CI's workflow already enforces the build → assemble → publish ordering; the lifecycle script is redundant and actively harmful here. Removed in commit `192ddd6`.

### Finding 4: tsup output is path-sensitive

Even on identical Node versions and identical platforms, two tsup runs from different working-directory paths produce different bytecode bytes (verified by `cmp` on the `.jsc` files — first 16 bytes identical, byte 17 onwards differ). The tsup-bundled JS contains module IDs/paths that vary between machines. This *alone* wouldn't break loading (bytenode's source-hash trick handles it), but it's a useful signal that "byte-identical output across machines" isn't a property tsup gives you.

### Finding 5: package-name and org availability

- `@threadbase` org creation was denied by npm's anti-abuse system (likely due to the existing unscoped `threadbase` package by another publisher — see [`threadbase` on npm](https://www.npmjs.com/package/threadbase)).
- `@ronenmars/threadbase-scanner` was used as the personal-scope fallback. Available, free to publish, no org needed.
- Version `0.2.2` is now permanently tombstoned on npm (unpublished, cannot be re-used as a version number).

### Finding 6: order-of-operations for unpublish

`npm unpublish` requires 2FA. The auth URL displayed in the terminal is hidden from non-interactive sessions (e.g., from a tool harness) — the human running `npm` needs to copy the URL from their own terminal and complete auth in the browser. The npm web UI may show a `diagnostics id: …` error *after* the backend has already completed the unpublish — verify via `npm view <pkg>` or `curl https://registry.npmjs.org/<pkg>` rather than trusting the UI.

### What's still useful from this attempt

Even though we won't ship bytenode as-is, the work isn't all wasted:

- **The loader pattern** (small `.cjs`/`.js` dispatchers that pick the right artifact at runtime) generalizes: any per-platform protection strategy will need the same dispatch shape, just keyed on different axes.
- **The two-stage build separation** (tsup → post-processing) is the right shape for any "obfuscate / encode / wrap the JS bundle" pipeline. `scripts/build-bytenode.mjs` would just be renamed and its bytenode call swapped for an obfuscator call.
- **The CI matrix + artifact-merge workflow** is correct for any per-axis matrix build; only the matrix dimensions change.
- **`scripts/assemble-dist.mjs`** is the right place to validate per-artifact completeness before publish.
- **The tarball-content validator** caught a real shipping bug (we had `.d.ts` in our forbidden list). The shape of the check (validate tarball contents pre-publish) is worth keeping in any future pipeline.

### Open questions for the next attempt

1. **Threat model precision**: how much friction is "enough"? Bytenode adds hours-of-effort friction; obfuscation adds minutes. If the answer is "anything that stops casual copy-paste," obfuscation is sufficient and the matrix complexity isn't worth it.
2. **Are we OK with bigger tarballs?** A 25-platform matrix means ~1.9 MB of bytecode vs ~75 KB of obfuscated JS — a 25× size difference shipped to every user.
3. **Should we ship two flavors?** User chose this direction (publish obfuscated + plain side-by-side) but we paused before implementing. Decide on packaging (one package with subpaths vs two packages vs dist-tag variants) before next attempt.
4. **Does the private repo + public package model still make sense?** If we keep the source repo private and `npm publish` the artifact, we're already in a "bytecode optional" zone — the source isn't on GitHub for anyone to clone. Obfuscation may be marginal protection on top of "source repo is private."

