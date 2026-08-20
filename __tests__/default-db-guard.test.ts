/**
 * A test process that opens the default index writes its fixtures into the
 * developer's real ~/.config/threadbase-scanner/index.db, where they are
 * indistinguishable from real conversations and corrupt every coverage
 * measurement taken of the store.
 *
 * Measured on one live machine: 579 of 1,144 rows were fixtures, 357 of them
 * from tb-streamer's suite — a consumer that builds scanners with no dbPath and
 * had no TB_SCANNER_DB of its own. The env var existed for this and failed open.
 */
import { ConversationScanner } from "../src/scanner";

describe("default index path under a test runner", () => {
  const saved = process.env.TB_SCANNER_DB;

  afterEach(() => {
    if (saved === undefined) delete process.env.TB_SCANNER_DB;
    else process.env.TB_SCANNER_DB = saved;
  });

  it("refuses to open the real index when TB_SCANNER_DB is unset", () => {
    delete process.env.TB_SCANNER_DB;
    // The throw must reach the caller rather than degrading to the real path.
    expect(() => new ConversationScanner()).toThrow(/TB_SCANNER_DB must be set/);
  });

  it("names the reason, so the failure is actionable rather than cryptic", () => {
    delete process.env.TB_SCANNER_DB;
    expect(() => new ConversationScanner()).toThrow(/corrupt every measurement/);
  });

  it("stays out of the way once TB_SCANNER_DB points somewhere safe", () => {
    process.env.TB_SCANNER_DB = saved ?? "/tmp/tb-scanner-guard-test/index.db";
    expect(() => new ConversationScanner()).not.toThrow();
  });

  it("does not fire for an explicitly supplied dbPath", () => {
    delete process.env.TB_SCANNER_DB;
    expect(() => new ConversationScanner({ persistent: { dbPath: ":memory:" } })).not.toThrow();
  });
});
