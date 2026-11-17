import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(__dirname, "..", "..");
const tsc = join(root, "node_modules", ".bin", "tsc");

// A module-typed package whose declarations use extensionless relative imports, the way tsc
// emits them from `src/`: a sibling file, a directory index, and a type-only `import()`.
function makePackage(dir: string) {
  const pkg = join(dir, "node_modules", "pkg");
  mkdirSync(join(pkg, "dist", "sub"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "pkg", type: "module", types: "dist/index.d.ts" }),
  );
  writeFileSync(
    join(pkg, "dist", "index.d.ts"),
    [
      'export * from "./types";',
      'export { Thing } from "./sub";',
      'export type Lazy = import("./types").Meta;',
      "",
    ].join("\n"),
  );
  writeFileSync(join(pkg, "dist", "types.d.ts"), "export interface Meta { id: string }\n");
  writeFileSync(join(pkg, "dist", "sub", "index.d.ts"), "export declare class Thing {}\n");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: ["probe.mts"],
    }),
  );
  // `Meta` must resolve and `Thing` must keep its class type instead of collapsing to `any`.
  writeFileSync(
    join(dir, "probe.mts"),
    'import { Thing, type Meta, type Lazy } from "pkg";\nexport const m: Meta = { id: "a" };\nexport const l: Lazy = m;\nexport const bad: symbol = Thing;\n',
  );
  return join(pkg, "dist");
}

function compile(dir: string): string {
  try {
    execFileSync(tsc, ["-p", dir], { encoding: "utf-8", stdio: "pipe" });
    return "";
  } catch (err: any) {
    return String(err.stdout ?? err.message);
  }
}

describe("fix-dts-specifiers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-dts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reproduces the nodenext failure before the rewrite", () => {
    makePackage(dir);
    const out = compile(dir);
    expect(out).toMatch(/has no exported member 'Meta'/);
  });

  it("makes the declarations resolve under nodenext", async () => {
    const dist = makePackage(dir);
    const { fixDeclarationSpecifiers } = await import("../../scripts/fix-dts-specifiers.mjs");
    expect(fixDeclarationSpecifiers(dist)).toEqual([]);
    const index = readFileSync(join(dist, "index.d.ts"), "utf-8");
    expect(index).toContain('from "./types.js"');
    expect(index).toContain('from "./sub/index.js"');
    expect(index).toContain('import("./types.js")');
    // Only the deliberate `symbol = Thing` assignment may still error, which proves `Thing`
    // resolves to its class type rather than `any`.
    const out = compile(dir);
    expect(out).toMatch(/Type 'typeof Thing' is not assignable to type 'symbol'/);
    expect(out).not.toMatch(/TS2305|TS2834/);
  });

  it("is idempotent and reports a specifier it cannot resolve", async () => {
    const dist = makePackage(dir);
    writeFileSync(join(dist, "broken.d.ts"), 'export * from "./missing";\n');
    const { fixDeclarationSpecifiers } = await import("../../scripts/fix-dts-specifiers.mjs");
    expect(fixDeclarationSpecifiers(dist)).toHaveLength(1);
    const before = readFileSync(join(dist, "index.d.ts"), "utf-8");
    fixDeclarationSpecifiers(dist);
    expect(readFileSync(join(dist, "index.d.ts"), "utf-8")).toBe(before);
  });
});
