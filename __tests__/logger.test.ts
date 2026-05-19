import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, getLogger, setLogger } from "../src/logger";

describe("logger", () => {
  const original = getLogger();
  afterEach(() => setLogger(original));

  it("returns the default silent logger initially", () => {
    expect(getLogger().level).toBe("silent");
  });

  it("setLogger swaps the current logger", () => {
    const custom = pino({ level: "debug" });
    setLogger(custom);
    expect(getLogger()).toBe(custom);
    expect(getLogger().level).toBe("debug");
  });

  it("createLogger builds a pino instance with options", () => {
    const log = createLogger({ level: "warn" });
    expect(log.level).toBe("warn");
  });

  it("createLogger passes through an existing logger", () => {
    const existing = pino({ level: "info" });
    expect(createLogger(existing)).toBe(existing);
  });
});
