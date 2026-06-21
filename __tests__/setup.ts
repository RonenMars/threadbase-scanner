import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach } from "vitest";

// Isolate the now-default persistent SQLite index per test: each test gets a
// fresh DB under a temp dir via TB_SCANNER_DB, so a ConversationScanner built
// with no args never touches the real ~/.config DB and never leaks state into
// the next test. Tests that explicitly pass `persistent: false` or their own
// dbPath are unaffected.
let dbDir: string | undefined;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "tb-scanner-db-"));
  process.env.TB_SCANNER_DB = join(dbDir, "index.db");
});

afterEach(() => {
  delete process.env.TB_SCANNER_DB;
  if (dbDir) {
    rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  }
});
