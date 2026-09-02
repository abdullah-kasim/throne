// Requirement: the omp launcher passes arguments through to the real omp
// binary unmodified. `bin/ompy` mirrors `bin/claudey`/`bin/opencodey`'s
// contract — resolve the real binary (honoring `$OMP_BIN`), set up the repo
// checkpoint backup, then `exec` straight through with no interception — so
// this drives the real script against a stub `omp` binary and asserts the
// stub observed exactly the argv it was given, nothing added or dropped.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OMPY_PATH = path.join(REPO_ROOT, "bin", "ompy");

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runOmpy(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OMPY_PATH, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const scratchDirs: string[] = [];

async function makeScratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ompy-launcher-test-"));
  scratchDirs.push(dir);
  return dir;
}

// A stub `omp` that records the exact argv it received (one per line, so
// arguments containing spaces are distinguishable from being split) and
// exits with a distinctive code, proving the real binary — not some other
// fallback — ran.
async function writeStubOmp(dir: string, argvLogPath: string): Promise<string> {
  const stubPath = path.join(dir, "omp");
  await writeFile(
    stubPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLogPath)}\nexit 42\n`,
    "utf8",
  );
  await chmod(stubPath, 0o755);
  return stubPath;
}

after(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("the omp launcher passes arguments through to the real omp binary unmodified", async () => {
  const scratch = await makeScratch();
  const pathDir = path.join(scratch, "path-bin");
  await mkdir(pathDir, { recursive: true });
  const argvLog = path.join(scratch, "argv.log");
  await writeStubOmp(pathDir, argvLog);

  const args = ["--flag", "value with spaces", "--another=1"];
  const result = await runOmpy(args, {
    PATH: `${pathDir}:/usr/bin:/bin`,
    HOME: scratch,
  }, scratch);

  assert.equal(result.code, 42, `expected the stub omp's exit code, got stderr: ${result.stderr}`);
  const observedArgv = (await readFile(argvLog, "utf8")).split("\n").filter((line) => line.length > 0);
  assert.deepEqual(observedArgv, args);
});

test("OMP_BIN overrides which real omp binary the launcher resolves", async () => {
  const scratch = await makeScratch();
  const overrideDir = path.join(scratch, "override-bin");
  await mkdir(overrideDir, { recursive: true });
  const argvLog = path.join(scratch, "argv.log");
  const overrideBin = await writeStubOmp(overrideDir, argvLog);

  // No real 'omp' anywhere on PATH, so a successful run proves OMP_BIN was
  // actually used to resolve the binary rather than a PATH scan.
  const result = await runOmpy(["--version"], {
    PATH: "/usr/bin:/bin",
    HOME: scratch,
    OMP_BIN: overrideBin,
  }, scratch);

  assert.equal(result.code, 42, `expected the override stub's exit code, got stderr: ${result.stderr}`);
  const observedArgv = (await readFile(argvLog, "utf8")).split("\n").filter((line) => line.length > 0);
  assert.deepEqual(observedArgv, ["--version"]);
});

test("the omp launcher exits 127 with a diagnostic when no real omp binary is found", async () => {
  const scratch = await makeScratch();
  const result = await runOmpy(["--version"], {
    PATH: "/usr/bin:/bin",
    HOME: scratch,
  }, scratch);

  assert.equal(result.code, 127);
  assert.match(result.stderr, /ompy: no real 'omp' binary found/);
});
