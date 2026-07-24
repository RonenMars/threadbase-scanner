import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compare,
  extractFieldTypes,
  validateLiveBaselines,
  walkObject,
} from "../../scripts/validate-live.ts";

describe("scripts/validate-live", () => {
  it("walkObject records nested field types", () => {
    const result = new Map<string, Set<string>>();
    walkObject({ a: { b: 1 }, c: [{ d: true }] }, "", result);
    expect([...(result.get("a") ?? [])]).toEqual(["object"]);
    expect([...(result.get("a.b") ?? [])]).toEqual(["number"]);
    expect([...(result.get("c") ?? [])]).toEqual(["array"]);
    expect([...(result.get("c[].d") ?? [])]).toEqual(["boolean"]);
  });

  it("extractFieldTypes skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-live-"));
    const path = join(dir, "sample.jsonl");
    writeFileSync(path, '{"type":"user"}\nnot-json\n{"type":"assistant","x":null}\n');
    const types = extractFieldTypes(path);
    expect(types.has("type")).toBe(true);
    expect([...(types.get("x") ?? [])]).toEqual(["null"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("compare reports added, removed, and type changes", () => {
    const prev = new Map<string, Set<string>>([
      ["a", new Set(["string"])],
      ["b", new Set(["number"])],
    ]);
    const curr = new Map<string, Set<string>>([
      ["a", new Set(["number"])],
      ["c", new Set(["boolean"])],
    ]);
    const { added, removed, typeChanged } = compare(prev, curr);
    expect(added.some((x) => x.includes("c"))).toBe(true);
    expect(removed.some((x) => x.includes("b"))).toBe(true);
    expect(typeChanged.some((x) => x.includes("a"))).toBe(true);
  });

  it("validateLiveBaselines exits 0 with no baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-live-"));
    const logs: string[] = [];
    const code = validateLiveBaselines(dir, (...args) => logs.push(args.join(" ")));
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/No baseline found/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("validateLiveBaselines exits 1 on breaking drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-live-"));
    writeFileSync(join(dir, "baseline-live.prev.jsonl"), '{"type":"user","old":1}\n');
    writeFileSync(join(dir, "baseline-live.jsonl"), '{"type":"user","new":true}\n');
    const code = validateLiveBaselines(dir, () => {});
    expect(code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("validateLiveBaselines exits 0 on additive-only drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-live-"));
    writeFileSync(join(dir, "baseline-live.prev.jsonl"), '{"type":"user"}\n');
    writeFileSync(join(dir, "baseline-live.jsonl"), '{"type":"user","extra":1}\n');
    const code = validateLiveBaselines(dir, () => {});
    expect(code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
