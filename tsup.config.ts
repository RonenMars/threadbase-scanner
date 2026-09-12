import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    // TypeScript 7's native compiler no longer exposes the JS Compiler API
    // (`ts.sys`), which tsup 8.5's bundled rollup-plugin-dts@6.1.1 reads.
    // Declarations come from `tsc -p tsconfig.build.json` in the build script.
    dts: false,
    sourcemap: true,
    clean: true,
    outDir: "dist",
    // Native module — never bundle; resolve from node_modules at runtime.
    external: ["better-sqlite3"],
  },
  {
    entry: { cli: "cli/index.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    outDir: "dist",
    external: ["better-sqlite3"],
  },
]);
