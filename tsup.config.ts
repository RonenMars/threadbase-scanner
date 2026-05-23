import { defineConfig } from "tsup";

// Two-stage build:
//   1. tsup produces bundled JS in dist/ (this file)
//   2. scripts/build-bytenode.mjs compiles those bundles to V8 bytecode (.jsc)
//      and installs the per-Node-version loader files from src/loader/ in place
//      of the bundled JS — the final shipped dist/ contains loaders + .jsc files
//      under dist/node-<major>/, never the bundled source.
//
// IMPORTANT: every emitted JS file that build-bytenode.mjs compiles MUST be CJS,
// because bytenode is a CJS-only format. The cli output below is therefore
// emitted as CJS even though scanner's package.json declares "type": "module".
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: false,
    clean: true,
    outDir: "dist",
  },
  {
    entry: { cli: "cli/index.ts" },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: false,
    outDir: "dist",
  },
]);
