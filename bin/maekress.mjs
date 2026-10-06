#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const child = spawn(process.execPath, ["--experimental-ffi", "--experimental-strip-types", entrypoint, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start maekress: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
