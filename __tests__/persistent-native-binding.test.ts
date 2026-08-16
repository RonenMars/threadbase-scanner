import { beforeEach, describe, expect, it, vi } from "vitest";

// Simulate better-sqlite3's constructor failing, which is the only point where a
// missing native binary ever surfaces — `require()` of the package succeeds
// regardless, because it only loads the JS entry point.
const state = vi.hoisted(() => ({ error: new Error("unset") }));

vi.mock("better-sqlite3", () => ({
  default: class {
    constructor() {
      throw state.error;
    }
  },
}));

async function openInMemory() {
  const { openDatabase } = await import("../src/persistent/db");
  return openDatabase(":memory:");
}

describe("openDatabase native-binding failure", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("turns the opaque bindings error into actionable guidance", async () => {
    state.error = new Error(
      "Could not locate the bindings file. Tried:\n" +
        " → /repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    );

    await expect(openInMemory()).rejects.toThrow(/npm rebuild better-sqlite3/);
  });

  it("names the persistent:false escape hatch and keeps the original error", async () => {
    state.error = new Error("Could not locate the bindings file. Tried: ...");

    await expect(openInMemory()).rejects.toThrow(/persistent: false/);
    await expect(openInMemory()).rejects.toThrow(/Original error/);
  });

  it("says the Node version is probably not the cause", async () => {
    // The stock message lists a node-vNNN path, which reads like an ABI
    // mismatch and sends people chasing Node versions instead of rebuilding.
    state.error = new Error(
      "Could not locate the bindings file. Tried: lib/binding/node-v137-darwin-arm64/better_sqlite3.node",
    );

    await expect(openInMemory()).rejects.toThrow(/not that your Node version is wrong/);
  });

  it("also catches a genuine ABI mismatch", async () => {
    state.error = new Error(
      "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.",
    );

    await expect(openInMemory()).rejects.toThrow(/npm rebuild better-sqlite3/);
  });

  it("passes unrelated failures through untouched", async () => {
    // A corrupt file or a permissions problem must not be mislabelled as a
    // missing native binary.
    state.error = new Error("SQLITE_CANTOPEN: unable to open database file");

    await expect(openInMemory()).rejects.toThrow(/SQLITE_CANTOPEN/);
    await expect(openInMemory()).rejects.not.toThrow(/npm rebuild/);
  });
});
