#!/usr/bin/env node
// Run after `tsc -p tsconfig.build.json`. The package is `"type": "module"`, so under
// `moduleResolution: node16/nodenext` a relative import in `dist/**/*.d.ts` needs an explicit
// file extension. tsc preserves the extensionless specifiers from `src/`, which leaves a
// nodenext consumer with every re-export typed `any` or missing. Rewrite each one to the `.js`
// path the `.d.ts` sits next to (`./x` -> `./x.js`, `./dir` -> `./dir/index.js`).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']*|\.{1,2})\2/g;
const HAS_EXTENSION = /\.(?:[cm]?js|json)$/;

function declarationFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? declarationFiles(join(dir, e.name))
      : e.name.endsWith(".d.ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/** Rewrites every relative specifier under `dir`; returns the specifiers it could not resolve. */
export function fixDeclarationSpecifiers(dir) {
  const unresolved = [];
  for (const file of declarationFiles(dir)) {
    const source = readFileSync(file, "utf-8");
    const fixed = source.replace(SPECIFIER, (match, lead, quote, spec) => {
      if (HAS_EXTENSION.test(spec)) return match;
      const target = resolve(dirname(file), spec);
      let rewritten;
      if (existsSync(`${target}.d.ts`)) rewritten = `${spec}.js`;
      else if (existsSync(join(target, "index.d.ts"))) rewritten = `${spec.replace(/\/$/, "")}/index.js`;
      else {
        unresolved.push(`${file}: ${spec}`);
        return match;
      }
      return `${lead}${quote}${rewritten}${quote}`;
    });
    if (fixed !== source) writeFileSync(file, fixed);
  }
  return unresolved;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const unresolved = fixDeclarationSpecifiers(dist);
  if (unresolved.length > 0) {
    console.error(`fix-dts-specifiers: ${unresolved.length} unresolved\n  ${unresolved.join("\n  ")}`);
    process.exit(1);
  }
  console.log("fix-dts-specifiers: ok");
}
