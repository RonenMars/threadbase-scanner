import type { Command } from "commander";
import { loadProfiles } from "../../src/profiles";
import { ConversationScanner } from "../../src/scanner";
import type { ConversationMeta, Include, SortOrder } from "../../src/types";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List conversations")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip N results", "0")
    .option("-s, --sort <order>", "Sort order", "recent")
    .option("--since <value>", "Time filter (7d, 2w, 2024-01-15)")
    .option("-p, --project <name>", "Filter by project")
    .option("-a, --account <name>", "Filter by account")
    .option("--include <type>", "all|conversations|subagents|teammates", "all")
    .option("--tier <name>", "Content tier", "standard")
    .option("--json", "JSON output", false)
    .action(async (opts) => {
      try {
        const profiles = await loadProfiles("~/.config/threadbase-scanner");
        const scanner = new ConversationScanner();
        const result = await scanner.scan({
          profiles,
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
          sort: opts.sort as SortOrder,
          since: opts.since,
          project: opts.project,
          account: opts.account,
          include: opts.include as Include,
          tier: opts.tier,
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const convs = result.conversations as ConversationMeta[];
          console.log(
            `Showing ${convs.length} of ${result.total} conversations (${result.scanned} files scanned)\n`,
          );
          for (const c of convs) {
            const branch = c.gitBranch ? ` [${c.gitBranch}]` : "";
            const sub = c.isSubagent ? " (subagent)" : "";
            const team = c.isTeammate ? ` (team: ${c.teamName})` : "";
            console.log(`  ${c.sessionId.slice(0, 8)}  ${c.projectName}${branch}${sub}${team}`);
            console.log(
              `    ${c.messageCount} msgs · ${c.timestamp.slice(0, 16)} · ${c.preview.slice(0, 80)}`,
            );
            console.log();
          }
        }
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }
    });
}
