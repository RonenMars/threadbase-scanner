"use strict";

const fs = require("node:fs");
const path = require("node:path");

const major = parseInt(process.versions.node.split(".")[0], 10);
const jscPath = path.join(__dirname, `node-${major}`, "index.jsc");

if (!fs.existsSync(jscPath)) {
  const available = fs
    .readdirSync(__dirname)
    .filter((d) => /^node-\d+$/.test(d))
    .map((d) => d.slice(5))
    .sort((a, b) => Number(a) - Number(b))
    .join(", ");
  throw new Error(
    `@ronenmars/threadbase-scanner does not support Node ${process.versions.node}. ` +
      `Supported majors: ${available || "(none found — broken install)"}.`,
  );
}

require("bytenode");
module.exports = require(jscPath);
