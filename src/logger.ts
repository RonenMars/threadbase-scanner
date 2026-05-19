import pino, { type Logger, type LoggerOptions } from "pino";

let currentLogger: Logger = pino({ level: "silent" });

export function createLogger(options?: LoggerOptions | Logger): Logger {
  if (options && typeof (options as Logger).child === "function") {
    return options as Logger;
  }
  return pino((options as LoggerOptions) ?? { level: "silent" });
}

export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

export function getLogger(): Logger {
  return currentLogger;
}

export type { Logger, LoggerOptions };
