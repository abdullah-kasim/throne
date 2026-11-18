import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { findNodeLaunches } from "../scripts/pi-evidence/lines/runtime.mjs";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME_LINE = "scripts/pi-evidence/lines/runtime.mjs";

test("the node launch grep catches a node launch in throne source but not the evidence tool's own pattern", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "pi-node-launch-grep-"));
  try {
    await mkdir(path.join(repository, "scripts/pi-evidence/lines"), { recursive: true });
    await mkdir(path.join(repository, "src"), { recursive: true });
    await cp(path.join(REPO_ROOT, RUNTIME_LINE), path.join(repository, RUNTIME_LINE));
    await writeFile(path.join(repository, "src/launcher.ts"), 'spawn("node", ["cli.js"]);\n');
    await runFile("git", ["-C", repository, "init", "-q"]);
    await runFile("git", ["-C", repository, "add", "."]);
    const grep = await findNodeLaunches(repository);
    assert.equal(grep.stdout.trim(), 'src/launcher.ts:1:spawn("node", ["cli.js"]);');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
