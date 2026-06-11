import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const cliPath = join(root, "dist", "cli.js");

describe("cli", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  }, 120_000);

  it("reports the package.json version for --version", async () => {
    expect(existsSync(cliPath)).toBe(true);
    const { version } = await import(join(root, "package.json"));
    const output = execFileSync("node", [cliPath, "--version"], {
      encoding: "utf8",
    });
    expect(output.trim()).toBe(version);
  });
});
