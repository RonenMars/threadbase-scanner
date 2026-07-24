/** Step logger shared by scripts/*.mjs / *.ts. Writes to stderr. */
export function createLogger(name) {
  const prefix = `[${name}]`;
  return {
    step(step, detail = "") {
      const extra = detail ? ` ${detail}` : "";
      console.error(`${prefix} step=${step}${extra}`);
    },
    info(message) {
      console.error(`${prefix} ${message}`);
    },
    fail(step, detail = "") {
      console.error(`${prefix} FAIL step=${step}`);
      if (detail) {
        for (const line of String(detail).split("\n")) {
          console.error(`${prefix}   | ${line}`);
        }
      }
    },
  };
}
