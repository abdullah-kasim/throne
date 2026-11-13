#!/usr/bin/env bun
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handOverLock, releaseLock, waitForLock } from "../src/shared-policy/lock-rows/lock-rows.ts";
import { resolveThroneHome } from "../src/shared-policy/throne-home.ts";

export function runWhileHolding(held, command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "inherit", env: process.env });
    const handedOver = child.pid === undefined ? held : handOverLock(held, child.pid);
    const finish = (exitCode) => {
      releaseLock(handedOver);
      resolve(exitCode);
    };
    child.on("error", (error) => {
      console.error(`hold-lock: could not run ${command}: ${error.message}`);
      finish(1);
    });
    child.on("exit", (code) => finish(code ?? 1));
  });
}

export async function holdLockWhileRunning(throneHome, name, command, commandArgs) {
  const held = await waitForLock(throneHome, name, Number.POSITIVE_INFINITY);
  return runWhileHolding(held, command, commandArgs);
}

async function main() {
  const [name, separator, command, ...commandArgs] = process.argv.slice(2);
  if (!name || separator !== "--" || !command) {
    console.error("usage: hold-lock.mjs <lock name> -- <command> [args...]");
    process.exit(2);
  }
  process.exit(await holdLockWhileRunning(resolveThroneHome(), name, command, commandArgs));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
