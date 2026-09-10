// Issue #73: a consumer holding only a conversation id must be able to ask the
// scanner for the transcript path instead of walking Claude Code's
// `<project>/<uuid>.jsonl` layout — which never matches a Codex rollout. The
// consumer's real situation is a cold scanner: a fresh instance over an index.db
// an earlier process wrote, with no scan() in this process.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationScanner } from "../src/index";

const FIXTURE = join(__dirname, "..", "__fixtures__", "codex-cli", "session-with-tools.jsonl");
const UUID = "01a089b0-c903-70b2-8f8a-a7bef1a61ea5";

describe("resolve a Codex conversation by session id on a cold persistent scanner", () => {
  let dir: string;
  let dbPath: string;
  let rolloutPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "resolve-by-id-"));
    dbPath = join(dir, "index.db");
    const codexRoot = join(dir, "codex");
    const day = join(codexRoot, "2026", "09", "10");
    mkdirSync(day, { recursive: true });
    // Real rollouts name the file after the session_meta payload id.
    rolloutPath = join(day, `rollout-2026-09-10T08-00-59-${UUID}.jsonl`);
    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf8").replaceAll("sess-tools-0002", UUID));

    const writer = new ConversationScanner({ persistent: { dbPath } });
    await writer.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });
    await writer.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the rollout path for the uuid without scanning", async () => {
    const cold = new ConversationScanner({ persistent: { dbPath } });

    const metas = cold.getConversationsBySessionId(UUID);
    expect(metas).toHaveLength(1);
    expect(metas[0].provider).toBe("codex-cli");
    expect(metas[0].filePath).toBe(rolloutPath);
    // The session's cwd never existed on this machine; the path is the
    // transcript file, so resolution doesn't depend on the project folder.
    expect(existsSync(metas[0].projectPath)).toBe(false);

    const page = await cold.getConversationPage(UUID, { limit: 2 });
    expect(page?.total).toBeGreaterThan(0);
    expect(page?.messages.length).toBeGreaterThan(0);

    expect(cold.getConversationsBySessionId("no-such-id")).toEqual([]);
    await cold.close();
  });
});
