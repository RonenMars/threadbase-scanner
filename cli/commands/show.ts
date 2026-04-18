import type { Command } from "commander";
import { loadProfiles } from "../../src/profiles";
import { ConversationScanner } from "../../src/scanner";

export function registerShowCommand(program: Command): void {
  program
    .command("show <session-id>")
    .description("Show a full conversation")
    .option("--json", "JSON output", false)
    .action(async (sessionIdPrefix: string, opts) => {
      try {
        const profiles = await loadProfiles("~/.config/threadbase-scanner");
        const scanner = new ConversationScanner();
        await scanner.scan({ profiles });

        const cache = scanner.getMetadataCache();
        const matches = Array.from(cache.values()).filter((m) =>
          m.sessionId.startsWith(sessionIdPrefix),
        );

        if (matches.length === 0) {
          console.error(`No session found matching "${sessionIdPrefix}"`);
          process.exit(1);
        }
        if (matches.length > 1) {
          console.error(
            `Ambiguous prefix "${sessionIdPrefix}" — matches ${matches.length} sessions:`,
          );
          for (const m of matches.slice(0, 5)) {
            console.error(`  ${m.sessionId}  ${m.projectName}`);
          }
          process.exit(1);
        }

        const conv = await scanner.getConversation(matches[0].id);
        if (!conv) {
          console.error("Failed to load conversation");
          process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(conv, null, 2));
        } else {
          console.log(`Session: ${conv.sessionId}`);
          console.log(`Project: ${conv.projectName} (${conv.projectPath})`);
          console.log(`Messages: ${conv.messageCount}\n`);
          for (const msg of conv.messages) {
            const role = msg.role === "user" ? "User" : "Assistant";
            console.log(`[${msg.timestamp.slice(0, 19)}] ${role}:`);
            console.log(msg.text.slice(0, 500));
            console.log();
          }
        }
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }
    });
}
