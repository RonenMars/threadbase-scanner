import { Command } from "commander";
import { registerListCommand } from "./commands/list";
import { registerProfilesCommand } from "./commands/profiles";
import { registerScanCommand } from "./commands/scan";
import { registerSearchCommand } from "./commands/search";
import { registerShowCommand } from "./commands/show";

const program = new Command()
  .name("threadbase-scanner")
  .description("Unified Claude Code conversation history scanner")
  .version("0.1.0");

registerListCommand(program);
registerSearchCommand(program);
registerShowCommand(program);
registerScanCommand(program);
registerProfilesCommand(program);

program.parse();
