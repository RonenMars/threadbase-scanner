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
});
