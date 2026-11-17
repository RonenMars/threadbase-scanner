import { execFileSync, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { hostname, tmpdir, userInfo } from "os";
import { dirname, join } from "path";
import {
  captureFile,
  formatReport,
  KNOWN_PERMISSION_KINDS,
  main,
  parseEvents,
  reportFacts,
  resolveInput,
  resolveOut,
  sanitizeEvents,
} from "../../scripts/capture-copilot-events.mjs";

// Everything here is hand-written. Token-shaped strings are assembled at runtime so that no
// literal in this file looks like a credential to a secret scanner.
const GHP = ["ghp", "_", "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78"].join("");
const PAT = ["github", "_pat_", "11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ0123456789abcdef"].join("");
const SK = ["sk", "-", "ant-api03-AbCdEfGhIjKlMnOpQrStUv"].join("");
const BEARER = "Bearer abcDEF123456.ghi789-jklMNO";
const HEX40 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
const B64 = "dGhpc0lzQUZha2VCYXNlNjRTZWNyZXRWYWx1ZTEyMzQ1";

const U1 = "3f2b8c1e-9d4a-4e7b-a1c5-0b6d7e8f9a10";
const U2 = "c0ffee00-1234-4abc-8def-abcdefabcdef";

let seq = 0;
function ev(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  seq++;
  return {
    type,
    data,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    timestamp: `2026-01-01T12:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    parentId: null,
    ...extra,
  };
}

function sanitizeOne(data: Record<string, unknown>, opts = {}) {
  const { events, counts } = sanitizeEvents([ev("user.message", data)], opts);
  return { data: events[0].data as Record<string, any>, counts };
}

describe("sanitizeEvents: ids", () => {
  it("maps each uuid to one stable placeholder, everywhere it appears", () => {
    const events = [
      ev("session.start", { sessionId: U1, context: { cwd: `/work/${U1}/x` } }),
      ev("permission.completed", { requestId: U2, toolCallId: U1, result: { kind: "approved" } }),
      ev("tool.execution_complete", { toolCallId: U1, success: true }),
    ];
    const { events: out } = sanitizeEvents(events);
    const text = JSON.stringify(out);
    expect(text).not.toContain(U1);
    expect(text).not.toContain(U2);
    const sid = (out[0].data as any).sessionId;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect((out[0].data as any).context.cwd).toBe(`/work/${sid}/x`);
    expect((out[1].data as any).toolCallId).toBe(sid);
    expect((out[2].data as any).toolCallId).toBe(sid);
    expect((out[1].data as any).requestId).not.toBe(sid);
  });

  it("keeps non-uuid tool call ids paired instead of redacting them as secrets", () => {
    const A = "call_AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const B = "call_ZyXwVuTsRqPoNmLkJiHgFeDcBa987654";
    const events = [
      ev("tool.execution_start", { toolCallId: A, toolName: "bash" }),
      ev("tool.execution_start", { toolCallId: B, toolName: "bash" }),
      ev("tool.execution_complete", { toolCallId: A, success: true }),
    ];
    const { events: out } = sanitizeEvents(events);
    const [a1, b1, a2] = out.map((e: any) => e.data.toolCallId);
    expect(a1).not.toContain("<redacted>");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(a1).not.toBe(A);
  });

  it("does not touch model names stored under an id-like key", () => {
    const { data } = sanitizeOne({
      modelInfo: { id: "gpt-5.1" },
      modelId: "claude-sonnet-4-5-20250929",
    });
    expect(data.modelInfo.id).toBe("gpt-5.1");
    expect(data.modelId).toBe("claude-sonnet-4-5-20250929");
  });

  it("leaves short ids alone", () => {
    expect(sanitizeOne({ turnId: "7" }).data.turnId).toBe("7");
  });
});

describe("sanitizeEvents: paths and names", () => {
  it("rewrites home directories on macOS, Linux and Windows to /home/user", () => {
    const { data } = sanitizeOne({
      a: "/Users/someone/dev/app/src/x.ts",
      b: "cd /home/alice/proj && ls",
      c: "C:\\Users\\Bob\\code\\app",
      d: "/root/.config",
    });
    expect(data.a).toBe("/home/user/dev/app/src/x.ts");
    expect(data.b).toBe("cd /home/user/proj && ls");
    expect(data.c).toBe("/home/user\\code\\app");
    expect(data.d).toBe("/root/.config");
  });

  it("replaces a username found in a path wherever else it appears as a word", () => {
    const { events } = sanitizeEvents([
      ev("user.message", { content: "my name is zorblax and I work in /Users/zorblax/x" }),
      ev("assistant.message", { content: "hi zorblax, zorblaxian is a different word" }),
    ]);
    const text = JSON.stringify(events);
    expect(text).toContain("my name is user and I work in /home/user/x");
    expect(text).toContain("hi user, zorblaxian is a different word");
  });

  it("replaces usernames and hostnames supplied by the caller", () => {
    const { data } = sanitizeOne(
      { a: "logged in as quentin on macbook-pro-7", b: "ssh build01.corp" },
      { usernames: ["quentin"], hostnames: ["macbook-pro-7"] },
    );
    expect(data.a).toBe("logged in as user on <redacted>");
    expect(data.b).toBe("ssh <redacted>");
  });

  it("ignores caller terms that are too short to replace safely", () => {
    const { data } = sanitizeOne({ a: "go to the store" }, { usernames: ["go"] });
    expect(data.a).toBe("go to the store");
  });

  it("sanitizes object keys too", () => {
    const { data } = sanitizeOne({ locations: { "/Users/someone/p": { x: 1 } } });
    expect(Object.keys(data.locations)).toEqual(["/home/user/p"]);
  });
});

describe("sanitizeEvents: secrets", () => {
  it.each([
    ["email", "mail jane.doe+x@example.org now", "mail <redacted> now"],
    ["github token", `token ${GHP} end`, "token <redacted> end"],
    ["fine-grained github token", `t=${PAT};`, "t=<redacted>;"],
    ["sk key", `key ${SK}`, "key <redacted>"],
    ["bearer header", `Authorization: ${BEARER}`, "Authorization: Bearer <redacted>"],
    ["long hex", `hash ${HEX40} ok`, "hash <redacted> ok"],
    ["long base64", `blob ${B64} ok`, "blob <redacted> ok"],
    ["private-host suffix", "curl http://db01.corp/x", "curl http://<redacted>/x"],
    ["env assignment", "export API_TOKEN=hunter2value", "export API_TOKEN=<redacted>"],
  ])("redacts %s", (_name, input, expected) => {
    expect(sanitizeOne({ content: input }).data.content).toBe(expected);
  });

  it("does not redact a long path, a sentence or a short word", () => {
    const keep = [
      "/home/user/projects/some-very-long-directory-name/src/components/button.ts",
      "List the files in this directory and explain what each one does for the build",
      "README.md",
      "mix of Upper and lower 123456789012345678901234567890 with spaces",
    ];
    for (const k of keep) expect(sanitizeOne({ content: k }).data.content).toBe(k);
  });

  it("scrubs a secret inside deeply nested arrays", () => {
    const { data } = sanitizeOne({ a: [{ b: [`x ${GHP}`] }] });
    expect(data.a[0].b[0]).toBe("x <redacted>");
  });
});

describe("sanitizeEvents: structure and counts", () => {
  it("keeps event order, types, kinds, decisionSource, success and key order", () => {
    const events = [
      ev("permission.completed", {
        requestId: U2,
        toolCallId: U1,
        result: { kind: "denied-interactively-by-user", feedback: "use mkdir instead" },
        decisionSource: "human_response",
      }),
      ev("tool.execution_complete", {
        toolCallId: U1,
        success: false,
        result: { content: "List the files", detailedContent: "line1\nline2" },
      }),
    ];
    const { events: out } = sanitizeEvents(events);
    expect(out.map((e: any) => e.type)).toEqual([
      "permission.completed",
      "tool.execution_complete",
    ]);
    const p = out[0].data as any;
    expect(p.result).toEqual({
      kind: "denied-interactively-by-user",
      feedback: "use mkdir instead",
    });
    expect(p.decisionSource).toBe("human_response");
    expect(Object.keys(p)).toEqual(["requestId", "toolCallId", "result", "decisionSource"]);
    const c = out[1].data as any;
    expect(c.success).toBe(false);
    expect(c.result).toEqual({ content: "List the files", detailedContent: "line1\nline2" });
    expect(Object.keys(out[0])).toEqual(["type", "data", "id", "timestamp", "parentId"]);
  });

  it("counts replacements per class and the free text it kept", () => {
    const { counts } = sanitizeEvents([
      ev("session.start", { sessionId: U1 }),
      ev("user.message", { content: `from a@b.io at /Users/zed/x with ${GHP}` }),
      ev("assistant.message", { content: "all good" }),
      ev("tool.execution_complete", { toolCallId: U1, result: { content: "output" } }),
    ]);
    // four event ids from ev() plus the one session/tool id that repeats
    expect(counts.ids).toBe(5);
    expect(counts.emails).toBe(1);
    expect(counts.paths).toBe(1);
    expect(counts.tokens).toBe(1);
    expect(counts.hostnames).toBe(0);
    expect(counts.freeText).toBe(3);
  });

  it("is a pure function of its input", () => {
    const events = [ev("user.message", { content: `x ${GHP} /Users/zed/y`, sessionId: U1 })];
    const snapshot = JSON.stringify(events);
    sanitizeEvents(events);
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});

describe("parseEvents", () => {
  it("reports every malformed line by number and skips blank lines", () => {
    const text = `${JSON.stringify(ev("a", {}))}\n\nnot json\n{"x":1}\n{broken\n`;
    const { events, errors } = parseEvents(text);
    expect(events).toHaveLength(2);
    expect(errors.map((e: any) => e.lineNo)).toEqual([3, 5]);
  });

  it("rejects a line that is valid JSON but not an object", () => {
    const { errors } = parseEvents("[1,2]\n42\n");
    expect(errors.map((e: any) => e.lineNo)).toEqual([1, 2]);
  });
});

describe("resolveOut", () => {
  const root = join(tmpdir(), "fake-repo-root");
  const live = join(root, "__fixtures__", "copilot", "live");

  it("accepts a name inside the live fixtures dir", () => {
    expect(resolveOut("__fixtures__/copilot/live/a.jsonl", root)).toBe(join(live, "a.jsonl"));
  });

  it("builds a default name from the clock, never from the session", () => {
    const out = resolveOut(undefined, root, new Date(Date.UTC(2026, 10, 16, 9, 8, 7)));
    expect(out).toBe(join(live, "capture-20261116-090807.jsonl"));
  });

  it.each([
    ["a path outside the repo", join(tmpdir(), "elsewhere.jsonl")],
    ["a parent escape", "__fixtures__/copilot/live/../x.jsonl"],
    ["the fixtures root", "__fixtures__/copilot/x.jsonl"],
    ["a sibling dir with the same prefix", "__fixtures__/copilot/live-evil/x.jsonl"],
    ["the live dir itself", "__fixtures__/copilot/live"],
    ["a non-jsonl name", "__fixtures__/copilot/live/x.txt"],
    ["a dotfile", "__fixtures__/copilot/live/.jsonl"],
  ])("refuses %s", (_n, out) => {
    expect(() => resolveOut(out, root)).toThrow(/__fixtures__\/copilot\/live/);
  });
});

describe("resolveInput and captureFile", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capture-copilot-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "__fixtures__", "copilot", "live"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function session(name: string, body: string, mtimeSec: number) {
    const d = join(dir, "session-state", name);
    mkdirSync(d, { recursive: true });
    const f = join(d, "events.jsonl");
    writeFileSync(f, body);
    utimesSync(f, mtimeSec, mtimeSec);
    return f;
  }

  it("takes a file as is", () => {
    const f = session("s1", "{}\n", 1000);
    expect(resolveInput(f)).toBe(f);
  });

  it("takes a session directory", () => {
    const f = session("s1", "{}\n", 1000);
    expect(resolveInput(dirname(f))).toBe(f);
  });

  it("picks the newest events.jsonl under a session-state directory", () => {
    session("old", "{}\n", 1000);
    const newest = session("new", "{}\n", 3000);
    session("mid", "{}\n", 2000);
    expect(resolveInput(join(dir, "session-state"))).toBe(newest);
  });

  it("fails clearly on a missing path or an empty directory", () => {
    expect(() => resolveInput(join(dir, "nope"))).toThrow(/does not exist/);
    mkdirSync(join(dir, "empty"));
    expect(() => resolveInput(join(dir, "empty"))).toThrow(/no events\.jsonl/);
  });

  it("writes a sanitized copy and returns counts", () => {
    const f = session(
      "s1",
      `${JSON.stringify(ev("user.message", { content: `hi /Users/zed/x ${GHP}`, sessionId: U1 }))}\n`,
      1000,
    );
    const r = captureFile({ input: f, out: "__fixtures__/copilot/live/t.jsonl", repoRoot: repo });
    const written = readFileSync(r.outPath, "utf8");
    expect(r.outPath).toBe(join(repo, "__fixtures__", "copilot", "live", "t.jsonl"));
    expect(written.endsWith("\n")).toBe(true);
    expect(written).not.toContain("zed");
    expect(written).not.toContain(GHP);
    expect(written).not.toContain(U1);
    expect(r.counts.tokens).toBe(1);
    expect(r.notice).toContain("REVIEW BEFORE COMMIT");
    expect(r.notice).toContain(r.outPath);
    expect(r.notice).toMatch(/tokens: 1/);
  });

  it("writes nothing and names the lines when the input is malformed", () => {
    const f = session("s1", `${JSON.stringify(ev("a", {}))}\nbroken\n{"also":\n`, 1000);
    const out = join(repo, "__fixtures__", "copilot", "live", "t.jsonl");
    expect(() =>
      captureFile({ input: f, out: "__fixtures__/copilot/live/t.jsonl", repoRoot: repo }),
    ).toThrow(/line 2[\s\S]*line 3/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses an out path outside the live dir without reading or writing", () => {
    const f = session("s1", "{}\n", 1000);
    const bad = join(dir, "leak.jsonl");
    expect(() => captureFile({ input: f, out: bad, repoRoot: repo })).toThrow(/live/);
    expect(existsSync(bad)).toBe(false);
  });

  it("refuses an empty capture", () => {
    const f = session("s1", "\n\n", 1000);
    expect(() =>
      captureFile({ input: f, out: "__fixtures__/copilot/live/t.jsonl", repoRoot: repo }),
    ).toThrow(/no events/);
  });
});

describe("report", () => {
  const A = "call_A";
  const B = "call_B";
  const C = "call_C";
  const D = "call_D";
  const E = "call_E";
  const F = "call_F";
  const req = (toolCallId: string, requestId: string) =>
    ev("permission.requested", {
      requestId,
      permissionRequest: { kind: "shell", toolCallId },
      promptRequest: { kind: "commands", toolCallId },
    });
  const events = [
    ev("user.message", { content: "go" }),
    ev("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: A, name: "bash" },
        { toolCallId: B, name: "bash" },
        { toolCallId: C, name: "ask_user" },
        { toolCallId: D, name: "bash" },
        { toolCallId: E, name: "bash" },
      ],
    }),
    ev("tool.execution_start", { toolCallId: A, toolName: "bash" }),
    req(A, "r1"),
    ev("permission.completed", {
      requestId: "r1",
      toolCallId: A,
      result: { kind: "approved" },
      decisionSource: "human_response",
    }),
    ev("tool.execution_complete", { toolCallId: A, success: true, result: { content: "ok" } }),
    ev("tool.execution_start", { toolCallId: B, toolName: "bash" }),
    req(B, "r2"),
    ev("permission.completed", {
      requestId: "r2",
      toolCallId: B,
      result: { kind: "denied-interactively-by-user", feedback: "no" },
      decisionSource: "human_response",
    }),
    ev("tool.execution_start", { toolCallId: C, toolName: "ask_user" }),
    ev("tool.execution_complete", {
      toolCallId: C,
      success: true,
      result: { content: "User responded: x", detailedContent: "x=1" },
    }),
    req(D, "r3"),
    ev("permission.completed", {
      requestId: "r3",
      toolCallId: D,
      result: { kind: "cancelled", reason: "Session aborted" },
      decisionSource: "human_response",
    }),
    ev("tool.execution_complete", { toolCallId: D, success: false, result: { content: "" } }),
    ev("tool.execution_start", { toolCallId: E, toolName: "bash" }),
    ev("permission.completed", {
      requestId: "r4",
      toolCallId: E,
      result: { kind: "approved-for-location" },
    }),
    ev("tool.execution_complete", {
      toolCallId: E,
      success: true,
      result: { detailedContent: "d" },
    }),
    // no toolCallId on the event, but the request names it
    req(F, "r5"),
    ev("permission.completed", { requestId: "r5", result: { kind: "approved" } }),
    // no toolCallId anywhere
    ev("permission.completed", { requestId: "r6", result: { kind: "approved" } }),
    ev("permission.completed", {
      requestId: "r7",
      toolCallId: "call_G",
      result: { kind: "weird" },
    }),
  ];
  const text = formatReport(reportFacts(events));

  it("lists the permission kinds seen and flags an unmapped one", () => {
    expect(text).toContain("permission.completed: 7");
    expect(text).toContain(
      "kinds: approved=3, approved-for-location=1, cancelled=1, denied-interactively-by-user=1, weird=1",
    );
    expect(text).toContain("UNKNOWN KINDS (not mapped by the scanner): weird");
    expect(text).toContain("decisionSource: (none)=4, human_response=3");
  });

  it("counts permission.completed without a toolCallId, and those a request can resolve", () => {
    expect(text).toContain("without toolCallId: 2 (resolved through requestId: 1)");
  });

  it("says whether a tool.execution_complete follows each kind, with its success", () => {
    expect(text).toContain(
      "approved: 3 total, 1 followed by tool.execution_complete (success=true:1)",
    );
    expect(text).toContain(
      "denied-interactively-by-user: 1 total, 0 followed by tool.execution_complete",
    );
    expect(text).toContain(
      "cancelled: 1 total, 1 followed by tool.execution_complete (success=false:1)",
    );
    expect(text).toContain(
      "approved-for-location: 1 total, 1 followed by tool.execution_complete (success=true:1)",
    );
  });

  it("does not count a tool.execution_complete that came before the decision", () => {
    const early = formatReport(
      reportFacts([
        ev("tool.execution_complete", { toolCallId: A, success: true, result: { content: "x" } }),
        ev("permission.completed", { requestId: "r", toolCallId: A, result: { kind: "approved" } }),
      ]),
    );
    expect(early).toContain("approved: 1 total, 0 followed by tool.execution_complete");
  });

  it("reports the events tied to an ask_user tool call", () => {
    expect(text).toContain("ask_user (tool calls: 1)");
    expect(text).toContain("tool.execution_start: 1");
    expect(text).toContain("tool.execution_complete: 1 (success=true:1)");
    expect(text).toMatch(/permission\.requested: 0\s+permission\.completed: 0/);
    expect(text).toContain("other permission.* and tool.execution_* events tied to ask_user: none");
  });

  it("reports a permission event paired with ask_user when one exists", () => {
    const withPermission = formatReport(
      reportFacts([
        ev("assistant.message", { toolRequests: [{ toolCallId: "q", name: "ask_user" }] }),
        ev("permission.requested", { requestId: "rq", permissionRequest: { toolCallId: "q" } }),
        ev("permission.completed", { requestId: "rq", result: { kind: "approved" } }),
        ev("tool.execution_partial_result", { toolCallId: "q" }),
      ]),
    );
    expect(withPermission).toMatch(/permission\.requested: 1\s+permission\.completed: 1/);
    expect(withPermission).toContain("tool.execution_partial_result=1");
  });

  it("reports content versus detailedContent per tool name", () => {
    expect(text).toContain("ask_user: 1 total; content=1 detailedContent=1 both=1 neither=0");
    expect(text).toContain("bash: 3 total; content=2 detailedContent=1 both=0 neither=0");
  });

  it("prints no ids, no content and no feedback", () => {
    for (const leak of ["call_", "User responded", "Session aborted", "x=1"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("reports an empty session without throwing", () => {
    const empty = formatReport(reportFacts([]));
    expect(empty).toContain("events: 0");
    expect(empty).toContain("permission.completed: 0");
  });

  it("reports a tool result whose request was never seen as an unknown tool", () => {
    const t = formatReport(
      reportFacts([ev("tool.execution_complete", { toolCallId: "z", result: { content: "c" } })]),
    );
    expect(t).toContain("(unknown tool): 1 total; content=1");
  });
});

describe("known permission kinds", () => {
  it("is the set the scanner maps", () => {
    expect([...KNOWN_PERMISSION_KINDS].sort()).toEqual([
      "approved",
      "approved-for-location",
      "cancelled",
      "denied-interactively-by-user",
    ]);
  });
});

describe("command line", () => {
  const script = join(__dirname, "..", "..", "scripts", "capture-copilot-events.mjs");
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capture-copilot-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("--report prints the report for a file and writes nothing", () => {
    const f = join(dir, "events.jsonl");
    writeFileSync(
      f,
      `${[
        ev("permission.completed", {
          requestId: "r",
          toolCallId: "t",
          result: { kind: "approved" },
        }),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    const out = execFileSync("node", [script, f, "--report"], { encoding: "utf8" });
    expect(out).toContain("permission.completed: 1");
    expect(out).toContain("kinds: approved=1");
  });

  it("refuses an --out outside the live fixtures dir with a non-zero exit", () => {
    const f = join(dir, "events.jsonl");
    writeFileSync(f, `${JSON.stringify(ev("a", {}))}\n`);
    const bad = join(dir, "x.jsonl");
    const r = spawnSync("node", [script, f, "--out", bad], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("__fixtures__/copilot/live");
    expect(existsSync(bad)).toBe(false);
  });

  it("reports malformed lines on stderr with a non-zero exit", () => {
    const f = join(dir, "events.jsonl");
    writeFileSync(f, "oops\n");
    const r = spawnSync("node", [script, f, "--report"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("line 1");
  });

  it("prints usage when no path is given", () => {
    const r = spawnSync("node", [script], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });
});

// Added after a mutation pass: each case below pins a rule that a one-line mutation of the script
// used to get past the suite above. Secret-shaped strings are built at runtime, and kept lower-case
// or short so that the generic hex and base64 rules cannot be what catches them.
const tok = (...parts: string[]) => parts.join("");

describe("sanitizeEvents: rules the first pass left unpinned", () => {
  it("maps an upper-case and a lower-case spelling of one uuid to the same placeholder", () => {
    const { data } = sanitizeOne({ a: U1, b: U1.toUpperCase() });
    expect(data.a).toBe(data.b);
    expect(data.a).not.toBe(U1);
  });

  it("rewrites /Users/user and a lower-case Windows home as well", () => {
    const { data } = sanitizeOne({ a: "/Users/user/x", b: "c:\\users\\bob\\x" });
    expect(data.a).toBe("/home/user/x");
    expect(data.b).toBe("/home/user\\x");
  });

  it("learns a username from a Windows path alone", () => {
    const { data } = sanitizeOne({ a: "C:\\Users\\Zorblax\\x and zorblax said hi" });
    expect(data.a).toBe("/home/user\\x and user said hi");
  });

  it("replaces a three-letter caller name and matches whole words, any case, literally", () => {
    const { data } = sanitizeOne(
      { a: "hi bob", b: "unzorblax and ZORBLAX", c: "axb a.b" },
      { usernames: ["bob", "zorblax", "a.b"] },
    );
    expect(data.a).toBe("hi user");
    expect(data.b).toBe("unzorblax and user");
    expect(data.c).toBe("axb user");
  });

  it("never turns a placeholder-like word into a name", () => {
    const { data } = sanitizeOne(
      { a: "/root/.config and the home users <redacted>" },
      { usernames: ["root", "home", "users", "redacted"] },
    );
    expect(data.a).toBe("/root/.config and the home users <redacted>");
  });

  it("redacts a private host after a word character", () => {
    expect(sanitizeOne({ a: "my_db01.corp" }).data.a).toBe("my_<redacted>");
  });

  it.each([
    ["GITHUB_TOKEN"],
    ["CLIENT_SECRET"],
    ["DB_PASSWORD"],
    ["DB_PASSWD"],
    ["STRIPE_API_KEY"],
    ["STRIPEAPIKEY"],
    ["SSH_PRIVATE_KEY"],
    ["AWS_ACCESS_KEY"],
  ])("redacts the value of %s", (name) => {
    expect(sanitizeOne({ a: `${name}=abc` }).data.a).toBe(`${name}=<redacted>`);
  });

  it("is idempotent on an assignment it already redacted", () => {
    const once = sanitizeOne({ a: "API_TOKEN=abc" }).data.a;
    const twice = sanitizeOne({ a: once });
    expect(twice.data.a).toBe(once);
    expect(twice.counts.tokens).toBe(0);
  });

  it("keeps a bare word after Bearer", () => {
    expect(sanitizeOne({ a: "Bearer abc" }).data.a).toBe("Bearer abc");
  });

  it.each([
    ["github token", tok("gh", "p_", "abcdefghijklmnopqrst")],
    ["fine-grained token", tok("github", "_pat_", "abcdefghijklmnopqrst")],
    ["sk key", tok("sk", "-", "abcdefghijklmnop")],
    ["slack token", tok("xox", "b-", "abcdefghij")],
    ["aws key id", tok("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["google key", tok("AI", "za", "abcdefghijklmnopqrstuvwxyzabcd")],
    ["jwt", tok("ey", "J", "abcdefghij", ".", "abcdefghij", ".", "abcde")],
  ])("redacts a %s by its prefix alone", (_name, secret) => {
    expect(sanitizeOne({ a: `x ${secret} y` }).data.a).toBe("x <redacted> y");
  });

  it("keeps identifiers that are only upper-case and digits, or camel case with no digit", () => {
    const keep = [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "ThisIsALongCamelCaseIdentifierNameWithoutAnyDigits",
      "Version2Final",
    ];
    for (const k of keep) expect(sanitizeOne({ a: k }).data.a).toBe(k);
  });

  it("counts opaque ids, detailedContent-only output, and ignores empty text", () => {
    const { counts } = sanitizeEvents([
      { type: "x", id: "plain", data: { toolCallId: "call_ABCDEFGHIJKLMNOP" } },
      { type: "x", id: "plain", data: { toolCallId: "call_ABCDEFGHIJKLMNOP" } },
      {
        type: "tool.execution_complete",
        id: "plain",
        data: { result: { detailedContent: "out" } },
      },
      { type: "user.message", id: "plain", data: { content: "" } },
    ]);
    expect(counts.ids).toBe(1);
    expect(counts.freeText).toBe(1);
  });
});

describe("resolveInput, captureFile and parseEvents: rules the first pass left unpinned", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capture-copilot-more-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "__fixtures__", "copilot", "live"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("skips a session directory that has no events.jsonl", () => {
    mkdirSync(join(dir, "ss", "empty"), { recursive: true });
    mkdirSync(join(dir, "ss", "real"), { recursive: true });
    writeFileSync(join(dir, "ss", "real", "events.jsonl"), "{}\n");
    expect(resolveInput(join(dir, "ss"))).toBe(join(dir, "ss", "real", "events.jsonl"));
  });

  it("lists at most 20 malformed lines and says how many more there are", () => {
    const text = `${Array.from({ length: 25 }, () => "oops").join("\n")}\n`;
    const f = join(dir, "events.jsonl");
    writeFileSync(f, text);
    let message = "";
    try {
      captureFile({ input: f, out: "__fixtures__/copilot/live/x.jsonl", repoRoot: repo });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("25 malformed line(s)");
    expect(message).toContain("line 20:");
    expect(message).not.toContain("line 21:");
    expect(message).toContain("and 5 more");
  });

  it("numbers lines from one", () => {
    expect(parseEvents('{"a":1}\noops\n').errors).toEqual([
      { lineNo: 2, reason: "not valid JSON" },
    ]);
  });

  it("uses the caller's usernames and hostnames over the machine's", () => {
    const f = join(dir, "events.jsonl");
    writeFileSync(
      f,
      `${JSON.stringify(ev("user.message", { content: "quentin on buildbox7" }))}\n`,
    );
    const { outPath } = captureFile({
      input: f,
      out: "__fixtures__/copilot/live/x.jsonl",
      repoRoot: repo,
      usernames: ["quentin"],
      hostnames: ["buildbox7"],
    });
    expect(readFileSync(outPath, "utf8")).toContain("user on <redacted>");
  });

  it("falls back to this machine's username and short hostname", () => {
    const name = userInfo().username;
    const short = hostname().split(".")[0];
    const f = join(dir, "events.jsonl");
    writeFileSync(f, `${JSON.stringify(ev("user.message", { content: `${name} at ${short}` }))}\n`);
    const { outPath } = captureFile({
      input: f,
      out: "__fixtures__/copilot/live/x.jsonl",
      repoRoot: repo,
    });
    const written = JSON.parse(readFileSync(outPath, "utf8")).data.content as string;
    if (
      name.length >= 3 &&
      !["user", "users", "home", "root", "redacted"].includes(name.toLowerCase())
    ) {
      expect(written).not.toContain(name);
    }
    if (short.length >= 3) expect(written).not.toContain(short);
  });
});

describe("report: rules the first pass left unpinned", () => {
  const text = (events: unknown[]) => formatReport(reportFacts(events as never[]));

  it("learns a tool's name from tool.execution_start alone", () => {
    const out = text([
      ev("tool.execution_start", { toolCallId: "t1", toolName: "bash" }),
      ev("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: "x" } }),
    ]);
    expect(out).toContain("  bash: 1 total");
  });

  it("counts feedback and reason on permission.completed", () => {
    const out = text([
      ev("permission.completed", {
        toolCallId: "t",
        result: { kind: "denied-interactively-by-user", feedback: "no", reason: "r" },
      }),
    ]);
    expect(out).toContain("with feedback: 1, with reason: 1");
  });

  it("flags a permission.completed with no kind as unknown", () => {
    const out = text([ev("permission.completed", { toolCallId: "t", result: {} })]);
    expect(out).toContain("(missing)=1");
    expect(out).toContain("UNKNOWN KINDS (not mapped by the scanner): (missing)");
  });

  it("counts a result with neither field and a result with an empty string", () => {
    const out = text([
      ev("tool.execution_complete", { toolCallId: "a", result: {} }),
      ev("tool.execution_complete", { toolCallId: "a", result: { content: "" } }),
    ]);
    expect(out).toContain(
      "(unknown tool): 2 total; content=1 detailedContent=0 both=0 neither=1 (empty strings: 1)",
    );
  });
});

describe("command line arguments", () => {
  const run = (argv: string[]) => {
    let err = "";
    let outText = "";
    const code = main(argv, {
      stdout: {
        write: (s: string) => {
          outText += s;
          return true;
        },
      },
      stderr: {
        write: (s: string) => {
          err += s;
          return true;
        },
      },
    } as never);
    return { code, err, out: outText };
  };

  it("answers 2 and prints usage for an unknown flag, a second path, or --out with no value", () => {
    for (const argv of [
      ["a.jsonl", "--bogus"],
      ["a.jsonl", "b.jsonl"],
      ["a.jsonl", "--out"],
    ]) {
      const r = run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toContain("Usage:");
    }
  });

  it("accepts --out=<path>", () => {
    const r = run(["a.jsonl", "--out=/elsewhere/x.jsonl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--out must be");
  });
});
