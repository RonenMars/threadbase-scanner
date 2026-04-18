import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectDefaultProfile,
  getProjectsDir,
  loadProfiles,
  resolveConfigDir,
  saveProfiles,
} from "../src/profiles";

describe("resolveConfigDir", () => {
  it("expands ~ to home directory", () => {
    expect(resolveConfigDir("~/.claude")).toBe(join(homedir(), ".claude"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolveConfigDir("/etc/claude")).toBe("/etc/claude");
  });
});

describe("getProjectsDir", () => {
  it("returns configDir/projects", () => {
    const profile = { id: "test", label: "Test", configDir: "~/.claude", enabled: true };
    expect(getProjectsDir(profile)).toBe(join(homedir(), ".claude", "projects"));
  });
});

describe("detectDefaultProfile", () => {
  it("returns a profile pointing to ~/.claude", async () => {
    const profile = await detectDefaultProfile();
    expect(profile.id).toBe("default");
    expect(profile.configDir).toContain(".claude");
    expect(profile.enabled).toBe(true);
  });
});

describe("loadProfiles / saveProfiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "profiles-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("saves and loads profiles", async () => {
    const profiles = [{ id: "work", label: "Work", configDir: "~/.claude-work", enabled: true }];
    await saveProfiles(profiles, tempDir);
    const loaded = await loadProfiles(tempDir);
    expect(loaded).toEqual(profiles);
  });

  it("returns default profile when no config exists", async () => {
    const loaded = await loadProfiles(tempDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("default");
  });
});
