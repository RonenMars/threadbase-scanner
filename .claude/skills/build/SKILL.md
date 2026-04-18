---
name: build
description: Build the package and verify outputs exist. Use before publishing or testing the CLI end-to-end.
---

1. Run `npm run build`
2. Verify these files exist in `dist/`:
   - `index.js` (ESM library)
   - `index.cjs` (CJS library)
   - `index.d.ts` (TypeScript declarations)
   - `cli.js` (CLI entry point with shebang)
3. Quick smoke test: `node dist/cli.js --version`

Report build success/failure and file sizes.
