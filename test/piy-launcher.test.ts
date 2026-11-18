import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PIY_PATH = path.join(REPO_ROOT, "bin", "piy");

interface CommandResult {
  code: number | null;
  stderr: string;
}

function runPiy(argumentsList: string[], environment: NodeJS.ProcessEnv, cwd: string, launcher = PIY_PATH): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, argumentsList, { cwd, env: environment, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part) => (stderr += part));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

const scratchFolders: string[] = [];

after(async () => {
  await Promise.all(scratchFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function scratchFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "piy-launcher-test-"));
  scratchFolders.push(folder);
  return folder;
}

async function recordedLines(filePath: string): Promise<string[]> {
  return (await readFile(filePath, "utf8")).split("\n").filter((line) => line.length > 0);
}

test("the pi launcher runs a JavaScript PI_BIN on the pinned bun with every argument passed through, never on node", async () => {
  const scratch = await scratchFolder();
  const recordPath = path.join(scratch, "record.txt");
  const entry = path.join(scratch, "cli.js");
  await writeFile(
    entry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(recordPath)}, [String(typeof Bun), ...process.argv.slice(2)].join("\\n") + "\\n");\nprocess.exit(42);\n`,
  );
  const argumentsList = ["--provider", "deepseek", "--model", "value with spaces"];
  const result = await runPiy(argumentsList, { PATH: "/usr/bin:/bin", HOME: process.env.HOME, PI_BIN: entry }, scratch);
  assert.equal(result.code, 42, result.stderr);
  assert.deepEqual(await recordedLines(recordPath), ["object", ...argumentsList]);
});

test("the pi launcher puts pi's agent folder beside the session folder when none is set", async () => {
  const scratch = await scratchFolder();
  const recordPath = path.join(scratch, "record.txt");
  const stub = path.join(scratch, "pi");
  await writeFile(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$PI_CODING_AGENT_DIR" > ${JSON.stringify(recordPath)}\nexit 42\n`);
  await chmod(stub, 0o755);
  const sessionFolder = path.join(scratch, "ledger", "pi-sessions");
  await mkdir(sessionFolder, { recursive: true });
  const result = await runPiy(["--session-dir", sessionFolder], { PATH: "/usr/bin:/bin", HOME: scratch, PI_BIN: stub }, scratch);
  assert.equal(result.code, 42, result.stderr);
  assert.deepEqual(await recordedLines(recordPath), [path.join(scratch, "ledger", "pi-agent")]);
});

test("the pi launcher exits 127 naming PI_BIN when no pi is found", async () => {
  const scratch = await scratchFolder();
  const launcherFolder = path.join(scratch, "bin");
  await mkdir(launcherFolder);
  for (const name of ["piy", "agent-launcher-lib.sh", "launcher-bash-guard.sh", "throne-runtime"]) {
    await copyFile(path.join(REPO_ROOT, "bin", name), path.join(launcherFolder, name));
  }
  await chmod(path.join(launcherFolder, "piy"), 0o755);
  const result = await runPiy(["--version"], { PATH: "/usr/bin:/bin", HOME: scratch }, scratch, path.join(launcherFolder, "piy"));
  assert.equal(result.code, 127);
  assert.match(result.stderr, /piy: no pi found: set PI_BIN/);
});
