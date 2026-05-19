import { Command } from "commander";
import pino from "pino";
import { setLogger } from "../src/logger";
import { registerListCommand } from "./commands/list";
import { registerProfilesCommand } from "./commands/profiles";
import { registerScanCommand } from "./commands/scan";
import { registerSearchCommand } from "./commands/search";
import { registerShowCommand } from "./commands/show";

setLogger(
  pino({
    level: process.env.LOG_LEVEL ?? "info",
    transport: {
      target: "pino-pretty",
      options: {
        destination: 2,
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  }),
);

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
