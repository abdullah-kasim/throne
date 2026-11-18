import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const pinnedClaude = path.join(repositoryRoot, "node_modules", ".bin", "claude");
const modFolder = path.join(repositoryRoot, "extensions", "claude");

test("the throne delivery mod passes claude plugin validate on the pinned Claude Code", async () => {
  const { stdout } = await run(pinnedClaude, ["plugin", "validate", modFolder]);
  assert.match(stdout, /Validation passed/);
});

test("the throne delivery mod passes its own claude plugin test", async () => {
  const { stdout, stderr } = await run(pinnedClaude, ["plugin", "test", modFolder]);
  assert.match(`${stdout}${stderr}`, / 0 fail/);
});
