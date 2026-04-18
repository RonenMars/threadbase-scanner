import type { Command } from "commander";
import { loadProfiles } from "../../src/profiles";
import { ConversationScanner } from "../../src/scanner";

export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .description("Scan all conversations (refresh)")
    .option("--tier <name>", "Content tier", "standard")
    .option("--json", "JSON output", false)
    .action(async (opts) => {
      try {
        const profiles = await loadProfiles("~/.config/threadbase-scanner");
        const scanner = new ConversationScanner();

        const start = Date.now();
        const result = await scanner.scan({
          profiles,
          tier: opts.tier,
          limit: undefined,
          onProgress: (scanned, total) => {
            if (!opts.json) {
              process.stdout.write(`\rScanning... ${scanned}/${total} files`);
            }
          },
        });

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const projects = scanner.getProjects();
          console.log(`\nScanned ${result.scanned} files in ${elapsed}s`);
          console.log(`Found ${result.total} conversations across ${projects.length} projects`);
        }
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }
    });
}
