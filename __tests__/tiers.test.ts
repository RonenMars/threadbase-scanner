import { describe, expect, it } from "vitest";
import { DEFAULT_TIERS, resolveTier } from "../src/tiers";

describe("DEFAULT_TIERS", () => {
  it("has standard tier", () => {
    expect(DEFAULT_TIERS.standard).toEqual({
      name: "standard",
      previewMax: 200,
      snippetMax: 5_000,
    });
  });

  it("has full tier", () => {
    expect(DEFAULT_TIERS.full).toEqual({
      name: "full",
      previewMax: 1_200,
      snippetMax: 50_000,
    });
  });
});

describe("resolveTier", () => {
  it("resolves built-in tier by name", () => {
    expect(resolveTier("standard")).toEqual(DEFAULT_TIERS.standard);
  });

  it("resolves custom tier over built-in", () => {
    const custom = { compact: { name: "compact", previewMax: 50, snippetMax: 500 } };
    expect(resolveTier("compact", custom)).toEqual(custom.compact);
  });

  it("falls back to built-in if not in custom", () => {
    expect(resolveTier("full", {})).toEqual(DEFAULT_TIERS.full);
  });

  it("throws for unknown tier", () => {
    expect(() => resolveTier("nonexistent")).toThrow("Unknown tier");
  });
});
