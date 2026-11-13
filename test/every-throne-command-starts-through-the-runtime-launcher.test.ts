import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pinnedBunPath, readPinnedBunVersion } from "./pinned-bun.support.ts";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const COMMANDS = ["throne", "throne-bot", "throne-cli"];

let scratch: string;
let throneRoot: string;
let pinnedHome: string;
let emptyHome: string;
let decoyDirectory: string;
let pinnedVersion: string;

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `#!/bin/sh\n${body}\n`);
  await chmod(filePath, 0o755);
}

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "throne-commands-"));
  throneRoot = path.join(scratch, "throne");
  pinnedHome = path.join(scratch, "pinned-home");
  emptyHome = path.join(scratch, "empty-home");
  decoyDirectory = path.join(scratch, "decoy");
  pinnedVersion = await readPinnedBunVersion();
  await mkdir(path.join(throneRoot, "bin"), { recursive: true });
  for (const name of [...COMMANDS, "throne-runtime"]) {
    await copyFile(path.join(REPO_ROOT, "bin", name), path.join(throneRoot, "bin", name));
    await chmod(path.join(throneRoot, "bin", name), 0o755);
  }
  await copyFile(path.join(REPO_ROOT, "mise.toml"), path.join(throneRoot, "mise.toml"));
  await mkdir(path.join(throneRoot, "dist", "src"), { recursive: true });
  await writeFile(path.join(throneRoot, "dist", "src", "tools.js"), "");
  await writeExecutable(pinnedBunPath(pinnedHome, pinnedVersion), 'echo "ran=$0"\necho "arguments=$*"');
  await mkdir(emptyHome, { recursive: true });
  for (const runtime of ["node", "bun"]) {
    await writeExecutable(path.join(decoyDirectory, runtime), 'echo "ran=decoy"');
  }
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runCommand(command: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(path.join(throneRoot, "bin", command), ["agent-statuses"], {
      env: { HOME: home, PATH: `${decoyDirectory}:/usr/bin:/bin` },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

for (const command of COMMANDS) {
  test(`${command} starts the compiled entrypoint on the Bun pinned in mise.toml`, async () => {
    const result = await runCommand(command, pinnedHome);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^ran=${pinnedBunPath(pinnedHome, pinnedVersion).replaceAll(".", "\\.")}$`, "m"));
    assert.match(result.stdout, new RegExp(`^arguments=${path.join(throneRoot, "dist", "src", "tools.js").replaceAll(".", "\\.")} `, "m"));
  });

  test(`${command} refuses without the pinned Bun and never runs a runtime from PATH`, async () => {
    const result = await runCommand(command, emptyHome);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /is not installed .*run `mise install`/);
    assert.doesNotMatch(result.stdout, /ran=decoy/);
  });
}
