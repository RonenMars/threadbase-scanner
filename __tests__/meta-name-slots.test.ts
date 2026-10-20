// ConversationMeta carries the slots its sessionName was resolved from, so a host
// holding a live session can merge them through applyNameCandidate instead of
// guessing which slot a bare name came from.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";
import { resolveSessionName } from "../src/session-name";
import type { ConversationMeta } from "../src/types";

const FIXTURES = join(__dirname, "..", "__fixtures__", "session-name");
const jsonl = (...rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meta-name-slots-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function claudeProfile(fixture: string) {
  const projects = join(dir, "projects", "-tmp-app");
  mkdirSync(projects, { recursive: true });
  cpSync(join(FIXTURES, `${fixture}.jsonl`), join(projects, "s.jsonl"));
  return [{ id: "p", label: "p", configDir: dir, enabled: true }];
}

describe.each([
  ["persistent", true],
  ["legacy in-memory", false],
])("meta.nameSlots (%s)", (_label, persistent) => {
  const scan = async (options: Parameters<ConversationScanner["scan"]>[0]) => {
    const scanner = new ConversationScanner(
      persistent ? { persistent: { dbPath: join(dir, "i.db") } } : { persistent: false },
    );
    try {
      return (await scanner.scan(options)).conversations as ConversationMeta[];
    } finally {
      scanner.close();
    }
  };

  it("exposes every slot a Claude session set, and they resolve to sessionName", async () => {
    const [meta] = await scan({ profiles: claudeProfile("03-ai-custom-ai") });
    expect(meta.nameSlots?.userTitle).toBe("My custom title");
    expect(meta.nameSlots?.toolTitle).toBeTruthy();
    expect(resolveSessionName(meta.nameSlots ?? {}).name).toBe(meta.sessionName);
  });

  it("holds the side-store title next to the transcript's first message for Codex", async () => {
    const ID = "01a14abc-0000-7000-8000-000000000009";
    const home = join(dir, ".codex");
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(
      join(home, "sessions", `rollout-${ID}.jsonl`),
      jsonl(
        { type: "session_meta", timestamp: "2026-02-01T10:00:00.000Z", payload: { id: ID } },
        {
          type: "response_item",
          timestamp: "2026-02-01T10:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the login bug" }],
          },
        },
      ),
    );
    writeFileSync(
      join(home, "session_index.jsonl"),
      jsonl({ id: ID, thread_name: "Login investigation" }),
    );
    const [meta] = await scan({
      profiles: [],
      providers: ["codex-cli"],
      codexRoots: [join(home, "sessions")],
    });
    expect(meta.nameSlots).toEqual({
      firstUserMessage: "Fix the login bug",
      toolTitle: "Login investigation",
    });
    expect(meta.sessionName).toBe("Login investigation");
  });
});

it("a persisted row served unchanged keeps its slots", async () => {
  const profiles = claudeProfile("02-two-ai-titles");
  const dbPath = join(dir, "i.db");
  const first = new ConversationScanner({ persistent: { dbPath } });
  const fresh = (await first.scan({ profiles })).conversations as ConversationMeta[];
  first.close();
  const second = new ConversationScanner({ persistent: { dbPath } });
  const reread = (await second.scan({ profiles })).conversations as ConversationMeta[];
  second.close();
  expect(fresh[0].nameSlots).toBeTruthy();
  expect(reread[0].nameSlots).toEqual(fresh[0].nameSlots);
});
