import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../../scripts/lib/log.mjs";
import {
  baselinePaths,
  fixturesDirFromScript,
  isMainModule,
  repoRootFromScript,
  scriptDir,
} from "../../scripts/lib/module.mjs";

describe("scripts/lib", () => {
  it("createLogger emits step / fail lines on stderr", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const log = createLogger("demo");
    log.step("init", "root=/tmp");
    log.info("hello");
    log.fail("boom", "line1\nline2");
    spy.mockRestore();
    expect(lines).toEqual([
      "[demo] step=init root=/tmp",
      "[demo] hello",
      "[demo] FAIL step=boom",
      "[demo]   | line1",
      "[demo]   | line2",
    ]);
  });

  it("module path helpers resolve scripts/ to repo root and fixtures", () => {
    const fakeScript = pathToFileURL(join(process.cwd(), "scripts/validate-live.ts")).href;
    expect(scriptDir(fakeScript)).toMatch(/scripts$/);
    expect(repoRootFromScript(fakeScript)).toBe(process.cwd());
    expect(fixturesDirFromScript(fakeScript)).toBe(join(process.cwd(), "__fixtures__"));
    const paths = baselinePaths(fakeScript);
    expect(paths.baselineLive).toContain("baseline-live.jsonl");
    expect(paths.baselinePrev).toContain("baseline-live.prev.jsonl");
  });

  it("module path helpers resolve scripts/lib to repo root", () => {
    const fakeLib = pathToFileURL(join(process.cwd(), "scripts/lib/module.mjs")).href;
    expect(repoRootFromScript(fakeLib)).toBe(process.cwd());
  });

  it("isMainModule is false for a non-entry path", () => {
    const dir = mkdtempSync(join(tmpdir(), "lib-main-"));
    const file = join(dir, "not-entry.mjs");
    writeFileSync(file, "export {};\n");
    expect(isMainModule(pathToFileURL(file).href)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
