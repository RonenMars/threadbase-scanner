// getConversationPage as a host would call it for paged detail reads: every
// page is in the same index space as the FILTERED full read (leading injected
// context dropped, exactly like a host's servable filter), reads the file as it
// is on disk now rather than a stale cached parse, and carries the
// conversation's meta + turn durations so one call can build a response.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/persistent/db";
import * as pagedReaderModule from "../src/persistent/paged-reader";
import { pageOfConversation } from "../src/persistent/paged-reader";
import { ConversationScanner } from "../src/scanner";
import { isCodexInjectedContext } from "../src/session-name";
import type { Conversation, ConversationMessage, GetConversationPageOptions } from "../src/types";

const AGENTS_DUMP =
  "# AGENTS.md instructions for /home/proj\n\n<INSTRUCTIONS>\nBe terse.\n</INSTRUCTIONS>";
const PERMISSIONS =
  "<permissions instructions>\nFilesystem sandboxing defines which files can be read.";
const HOST_PROMPT = "You are working within the project boundary: /home/proj";
const PASTED_MID = "Here is what my AGENTS.md says: <INSTRUCTIONS>keep it</INSTRUCTIONS>";

function ts(i: number): string {
  const s = 1_000 + i;
  return `2026-01-01T${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(
    Math.floor(s / 60) % 60,
  ).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z`;
}

// ─── Claude fixture ────────────────────────────────────────────────────────
// One page message per message line; non-message lines (isMeta caveat, system,
// turn_duration, file-history-snapshot) are interleaved so the full read has
// something to drop besides the leading injected turn.
function claudeLine(i: number): string {
  const base = { uuid: `c${i}`, timestamp: ts(i), sessionId: "sess-claude", cwd: "/home/proj" };
  if (i === 150) {
    return JSON.stringify({
      ...base,
      type: "user",
      message: { role: "user", content: PASTED_MID },
    });
  }
  if (i % 7 === 0) {
    return JSON.stringify({
      ...base,
      type: "assistant",
      message: {
        role: "assistant",
        model: "m",
        content: [{ type: "tool_use", id: `tu${i}`, name: "Edit", input: { i } }],
      },
    });
  }
  if (i % 7 === 1) {
    return JSON.stringify({
      ...base,
      type: "user",
      toolUseResult: { ok: true },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `tu${i - 1}`, content: "done" }],
      },
    });
  }
  if (i % 5 === 2) {
    return JSON.stringify({
      ...base,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: `pondering ${i}`, signature: `sig${i}` }],
      },
    });
  }
  const role = i % 2 === 0 ? "assistant" : "user";
  return JSON.stringify({
    ...base,
    type: role,
    message: { role, content: [{ type: "text", text: `message ${i}` }] },
  });
}

function claudeNoise(i: number): string[] {
  const out: string[] = [];
  if (i % 10 === 9) {
    out.push(
      JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        durationMs: 1000 + i,
        messageCount: 10,
        uuid: `td${i}`,
        timestamp: ts(i),
      }),
    );
  }
  if (i % 25 === 4) {
    out.push(JSON.stringify({ type: "file-history-snapshot", messageId: `c${i}`, snapshot: {} }));
    out.push(
      JSON.stringify({
        type: "user",
        isMeta: true,
        uuid: `meta${i}`,
        timestamp: ts(i),
        message: {
          role: "user",
          content: "<local-command-caveat>Caveat: generated</local-command-caveat>",
        },
      }),
    );
  }
  return out;
}

function claudeLines(start: number, count: number, withHead: boolean, hostPrompt = false): string {
  const lines: string[] = [];
  if (withHead) {
    lines.push(
      JSON.stringify({
        type: "user",
        isMeta: true,
        uuid: "meta-head",
        timestamp: ts(0),
        sessionId: "sess-claude",
        cwd: "/home/proj",
        message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" },
      }),
      JSON.stringify({
        type: "user",
        uuid: "inj-head",
        timestamp: ts(0),
        sessionId: "sess-claude",
        cwd: "/home/proj",
        message: { role: "user", content: AGENTS_DUMP },
      }),
    );
    if (hostPrompt) {
      lines.push(
        JSON.stringify({
          type: "user",
          uuid: "host-head",
          timestamp: ts(0),
          sessionId: "sess-claude",
          cwd: "/home/proj",
          message: { role: "user", content: HOST_PROMPT },
        }),
      );
    }
  }
  for (let i = start; i < start + count; i++) lines.push(claudeLine(i), ...claudeNoise(i));
  return `${lines.join("\n")}\n`;
}

// ─── Codex fixture ─────────────────────────────────────────────────────────
function codexMsg(i: number, role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    timestamp: ts(i),
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
}

function codexLine(i: number): string {
  if (i === 150) return codexMsg(i, "user", PASTED_MID);
  if (i % 6 === 2) {
    return JSON.stringify({
      timestamp: ts(i),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: `{"cmd":"ls ${i}"}`,
        call_id: `call${i}`,
      },
    });
  }
  if (i % 6 === 3) {
    return JSON.stringify({
      timestamp: ts(i),
      type: "response_item",
      payload: { type: "function_call_output", call_id: `call${i - 1}`, output: `out ${i}` },
    });
  }
  return codexMsg(i, i % 2 === 0 ? "user" : "assistant", `codex message ${i}`);
}

function codexLines(start: number, count: number, withHead: boolean, hostPrompt = false): string {
  const lines: string[] = [];
  if (withHead) {
    lines.push(
      JSON.stringify({
        timestamp: ts(0),
        type: "session_meta",
        payload: { id: "sess-codex", timestamp: ts(0), cwd: "/home/proj" },
      }),
      JSON.stringify({ timestamp: ts(0), type: "turn_context", payload: { model: "gpt-5.5" } }),
      JSON.stringify({
        timestamp: ts(0),
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: PERMISSIONS }],
        },
      }),
      codexMsg(0, "user", AGENTS_DUMP),
      codexMsg(0, "user", PERMISSIONS),
    );
    if (hostPrompt) lines.push(codexMsg(0, "user", HOST_PROMPT));
  }
  for (let i = start; i < start + count; i++) lines.push(codexLine(i));
  return `${lines.join("\n")}\n`;
}

// A host's servable filter: drop the LEADING run of injected user turns only.
function servable(
  messages: ConversationMessage[],
  isInjected: (text: string) => boolean = isCodexInjectedContext,
): ConversationMessage[] {
  let kept = 0;
  return messages.filter((m) => {
    if (kept === 0 && m.role === "user" && isInjected(m.text ?? "")) return false;
    kept++;
    return true;
  });
}

async function readAllPages(
  scanner: ConversationScanner,
  id: string,
  limit: number,
  extra: Partial<GetConversationPageOptions> = {},
) {
  const messages: ConversationMessage[] = [];
  let beforeIndex: number | undefined;
  let newest: Awaited<ReturnType<ConversationScanner["getConversationPage"]>> = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await scanner.getConversationPage(id, { ...extra, limit, beforeIndex });
    if (!page) throw new Error("page returned null");
    newest ??= page;
    messages.unshift(...page.messages);
    if (page.fromIndex === 0) break;
    beforeIndex = page.fromIndex;
  }
  return { messages, newest };
}

type Mode = "persistent" | "in-memory";
type Provider = "claude" | "codex";

describe.each<Mode>(["persistent", "in-memory"])("getConversationPage (%s)", (mode) => {
  let dir: string;
  let claudeFile: string;
  let codexRoot: string;
  let codexFile: string;
  const scanners: ConversationScanner[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "page-filtered-"));
    mkdirSync(join(dir, "projects", "p"), { recursive: true });
    claudeFile = join(dir, "projects", "p", "sess-claude.jsonl");
    codexRoot = join(dir, "codex");
    mkdirSync(join(codexRoot, "2026", "01", "01"), { recursive: true });
    codexFile = join(codexRoot, "2026", "01", "01", "rollout-2026-01-01T00-00-00-sess-codex.jsonl");
  });
  afterEach(async () => {
    for (const s of scanners.splice(0)) await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function scanned(provider: Provider): Promise<ConversationScanner> {
    const scanner = new ConversationScanner(
      mode === "persistent" ? { persistent: { dbPath: join(dir, "i.db") } } : { persistent: false },
    );
    scanners.push(scanner);
    if (provider === "claude") {
      await scanner.scan({
        profiles: [{ id: "default", label: "T", configDir: dir, enabled: true }],
      });
    } else {
      await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });
    }
    return scanner;
  }

  const write = (provider: Provider, count: number, hostPrompt = false) => {
    if (provider === "claude") writeFileSync(claudeFile, claudeLines(0, count, true, hostPrompt));
    else writeFileSync(codexFile, codexLines(0, count, true, hostPrompt));
    return provider === "claude" ? claudeFile : codexFile;
  };

  describe.each<[Provider, number]>([
    ["claude", 300],
    ["codex", 300],
    // Spans two checkpoint intervals, so the persistent path seeks from a floor.
    ["claude", 1200],
  ])("%s, %i messages", (provider, count) => {
    it("concatenated pages equal the filtered full read, with meta and turn durations", async () => {
      const file = write(provider, count);
      const scanner = await scanned(provider);
      const full = await scanner.getConversation(file);
      expect(full).toBeTruthy();
      const expected = servable(full?.messages ?? []);
      // The fixture really has something to filter, and keeps the mid-conversation paste.
      expect(expected.length).toBe((full?.messages.length ?? 0) - (provider === "codex" ? 2 : 1));
      expect(expected.some((m) => m.text === PASTED_MID)).toBe(true);

      const { messages, newest } = await readAllPages(scanner, file, 37);
      expect(messages).toEqual(expected);
      expect(newest?.total).toBe(expected.length);
      expect(newest?.fromIndex).toBe(expected.length - 37);
      expect(newest?.turnDurations).toEqual(full?.turnDurations);
      if (provider === "claude") expect(newest?.turnDurations?.length).toBeGreaterThan(0);
      expect(newest?.meta).toMatchObject({
        filePath: full?.filePath,
        sessionId: full?.sessionId,
        sessionName: full?.sessionName,
        projectPath: full?.projectPath,
        timestamp: full?.timestamp,
      });
    });
  });

  it("an explicit beforeIndex window is the same slice of the filtered read", async () => {
    const file = write("codex", 300);
    const scanner = await scanned("codex");
    const expected = servable((await scanner.getConversation(file))?.messages ?? []);
    const page = await scanner.getConversationPage(file, { beforeIndex: 10, limit: 25 });
    expect(page?.fromIndex).toBe(0);
    expect(page?.messages).toEqual(expected.slice(0, 10));
    expect(page?.total).toBe(expected.length);
  });

  describe.each<Provider>(["claude", "codex"])("%s filter predicate", (provider) => {
    it("a host predicate extends the leading-run filter to the host's own injected prompts", async () => {
      const file = write(provider, 300, true);
      const scanner = await scanned(provider);
      const isInjected = (text: string) =>
        isCodexInjectedContext(text) || text.startsWith(HOST_PROMPT);
      const full = await scanner.getConversation(file);
      const expected = servable(full?.messages ?? [], isInjected);
      expect(expected.length).toBe((full?.messages.length ?? 0) - (provider === "codex" ? 3 : 2));

      const { messages, newest } = await readAllPages(scanner, file, 40, {
        isInjectedContext: isInjected,
      });
      expect(messages).toEqual(expected);
      expect(newest?.total).toBe(expected.length);

      // Default predicate: the host prompt is not the scanner's to recognise.
      const dflt = await scanner.getConversationPage(file, { beforeIndex: 1, limit: 1 });
      expect(dflt?.messages[0]?.text).toBe(HOST_PROMPT);
    });

    it("the filter only ever drops user turns", async () => {
      const file = write(provider, 300);
      const scanner = await scanned(provider);
      const all = () => true;
      const expected = servable((await scanner.getConversation(file))?.messages ?? [], all);
      expect(expected.length).toBeGreaterThan(0);
      const { messages } = await readAllPages(scanner, file, 40, { isInjectedContext: all });
      expect(messages).toEqual(expected);
    });
  });

  it("a short conversation has no turn durations and carries its git branch", async () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat-x\n");
    writeFileSync(
      claudeFile,
      claudeLines(0, 5, true).replaceAll('"/home/proj"', JSON.stringify(repo)),
    );
    const scanner = await scanned("claude");
    const full = await scanner.getConversation(claudeFile);
    expect(full?.turnDurations).toBeUndefined();
    const page = await scanner.getConversationPage(claudeFile, { limit: 20 });
    expect(page?.turnDurations).toBeUndefined();
    expect(page?.meta.gitBranch).toBe("feat-x");
  });

  describe.each<Provider>(["claude", "codex"])("%s freshness", (provider) => {
    it("a page call after an append sees the appended messages without a refresh", async () => {
      const file = write(provider, 300);
      const scanner = await scanned(provider);
      // Warm every cache a stale read could come from.
      await scanner.getConversation(file);
      const before = await scanner.getConversationPage(file, { limit: 20 });
      expect(before).toBeTruthy();

      appendFileSync(
        file,
        provider === "claude" ? claudeLines(300, 2, false) : codexLines(300, 2, false),
      );

      const after = await scanner.getConversationPage(file, { limit: 20 });
      expect(after?.total).toBe((before?.total ?? 0) + 2);
      const lastTwo = after?.messages.slice(-2).map((m) => m.timestamp);
      expect(lastTwo).toEqual([ts(300), ts(301)]);
      expect(after?.meta.timestamp).toBe(ts(301));
      expect(after?.meta.messageCount).toBeGreaterThan(before?.meta.messageCount ?? 0);
    });
  });
});

describe("getConversationPage (persistent) on an index written before turn durations", () => {
  it.each(["unchanged", "appended"])(
    "refolds a(n) %s file once so the page carries its turn durations",
    async (change) => {
      const dir = mkdtempSync(join(tmpdir(), "page-legacy-"));
      mkdirSync(join(dir, "projects", "p"), { recursive: true });
      const file = join(dir, "projects", "p", "sess-claude.jsonl");
      const dbPath = join(dir, "i.db");
      const profiles = [{ id: "default", label: "T", configDir: dir, enabled: true }];
      writeFileSync(file, claudeLines(0, 300, true));
      try {
        const first = new ConversationScanner({ persistent: { dbPath } });
        await first.scan({ profiles });
        await first.close();
        // What an older scanner persisted: the same fold, without the field.
        const db = openDatabase(dbPath);
        db.prepare(
          "UPDATE conversation_files SET reducer_state = json_remove(reducer_state, '$.turnDurations')",
        ).run();
        db.close();
        if (change === "appended") appendFileSync(file, claudeLines(300, 10, false));

        const scanner = new ConversationScanner({ persistent: { dbPath } });
        await scanner.scan({ profiles });
        // The scan itself refolds, so the page call has nothing left to redo.
        const check = openDatabase(dbPath);
        const row = check.prepare("SELECT reducer_state FROM conversation_files").get() as {
          reducer_state: string;
        };
        check.close();
        expect(row.reducer_state).toContain('"turnDurations"');
        const page = await scanner.getConversationPage(file, { limit: 20 });
        expect(page?.turnDurations).toEqual((await scanner.getConversation(file))?.turnDurations);
        expect(page?.turnDurations?.length).toBeGreaterThan(0);
        await scanner.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("getConversationPage (in-memory) bounded reads", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "page-bounded-"));
    mkdirSync(join(dir, "projects", "p"), { recursive: true });
    file = join(dir, "projects", "p", "sess-claude.jsonl");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes an unchanged file once and serves later pages from its checkpoints", async () => {
    writeFileSync(file, claudeLines(0, 1200, true));
    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({
      profiles: [{ id: "default", label: "T", configDir: dir, enabled: true }],
    });

    const build = vi.spyOn(pagedReaderModule, "buildCheckpoints");
    const read = vi.spyOn(pagedReaderModule, "readPage");
    await scanner.getConversationPage(file, { limit: 20 });
    await scanner.getConversationPage(file, { beforeIndex: 900, limit: 20 });
    expect(build).toHaveBeenCalledTimes(1);
    // The scroll-back read seeks from the 500-message checkpoint, not byte 0.
    expect(read.mock.calls[1][3]?.messageIndex).toBe(500);

    appendFileSync(file, claudeLines(1200, 1, false));
    await scanner.getConversationPage(file, { limit: 20 });
    expect(build).toHaveBeenCalledTimes(2);
    await scanner.close();
  });
});

describe("pageOfConversation", () => {
  it("pages an all-injected conversation as empty and keeps its turn durations", () => {
    const injected = { role: "user", text: AGENTS_DUMP, timestamp: ts(0) } as ConversationMessage;
    const turnDurations = [{ durationMs: 5, messageCount: 1 }];
    const page = pageOfConversation(
      { messages: [injected, injected], turnDurations } as unknown as Conversation,
      { limit: 10 },
    );
    expect(page).toEqual({ messages: [], total: 0, fromIndex: 0, turnDurations });
  });
});
