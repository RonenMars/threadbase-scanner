import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
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
