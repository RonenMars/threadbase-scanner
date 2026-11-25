import { describe, expect, it } from "vitest";
import { extractTextContent } from "../src/parse-helpers";

const cmd = (name: string, args: string) =>
  `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`;

describe("extractTextContent: slash-command user lines", () => {
  it("keeps the typed command and its args as the message text", () => {
    expect(extractTextContent(cmd("plan", "/task-folder write a plan\nline two"))).toBe(
      "/plan /task-folder write a plan\nline two",
    );
  });

  it("keeps hiding a bare command with no args", () => {
    const raw =
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>";
    expect(extractTextContent(raw)).toBe("");
  });

  it("works for a text block inside an array", () => {
    expect(extractTextContent([{ type: "text", text: cmd("model", "claude-opus-5-5") }])).toBe(
      "/model claude-opus-5-5",
    );
  });

  it("still strips command output and the caveat", () => {
    expect(extractTextContent("<local-command-stdout>Set model</local-command-stdout>")).toBe("");
    expect(extractTextContent("<local-command-caveat>x</local-command-caveat>")).toBe("");
  });

  // Claude Code 2.1.332 writes a skill command with <command-message> first.
  const skill = (name: string, args?: string) =>
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` +
    (args === undefined ? "" : `\n<command-args>${args}</command-args>`);

  it("keeps a skill command that leads with <command-message>", () => {
    expect(extractTextContent(skill("later", "at 21:15 run tests"))).toBe(
      "/later at 21:15 run tests",
    );
  });

  it("keeps a bare skill command as the typed prompt", () => {
    expect(extractTextContent(skill("inbox"))).toBe("/inbox");
  });

  it("does not rebuild a command quoted in the middle of prose", () => {
    expect(extractTextContent("see <command-name>/x</command-name> here")).toBe("see here");
  });
});
