import type { Command } from "commander";
import { loadProfiles } from "../../src/profiles";
import { ConversationScanner } from "../../src/scanner";
import type { SortOrder } from "../../src/types";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search conversations")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip N results", "0")
    .option("-s, --sort <order>", "Sort order", "recent")
    .option("--since <value>", "Time filter")
    .option("-p, --project <name>", "Filter by project")
    .option("-a, --account <name>", "Filter by account")
    .option("--fields <list>", "Comma-separated field list")
    .option("--json", "JSON output", false)
    .action(async (query: string, opts) => {
      try {
        const profiles = await loadProfiles("~/.config/threadbase-scanner");
        const scanner = new ConversationScanner();
        const results = await scanner.search(query, {
          profiles,
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
          sort: opts.sort as SortOrder,
          since: opts.since,
          project: opts.project,
          account: opts.account,
          fields: opts.fields?.split(","),
        });

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.log(`Found ${results.length} results for "${query}"\n`);
          for (const r of results) {
            console.log(`  ${r.meta.sessionId.slice(0, 8)}  ${r.meta.projectName}`);
            if (r.matches.length > 0) {
              console.log(`    Match: ${r.matches[0].snippet.slice(0, 100)}`);
            }
            console.log();
          }
        }
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }
    });
}
