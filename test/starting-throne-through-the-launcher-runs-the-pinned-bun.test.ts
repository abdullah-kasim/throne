import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");

let scratch: string;
let throneRoot: string;
let pinnedVersion: string;

function pinnedBunPath(home: string, version: string): string {
  return path.join(home, ".local", "share", "mise", "installs", "bun", version, "bin", "bun");
}

async function installFakeBun(home: string, version: string): Promise<void> {
  const bunPath = pinnedBunPath(home, version);
  await mkdir(path.dirname(bunPath), { recursive: true });
  await writeFile(bunPath, `#!/bin/sh\necho "ran=$0"\necho "arguments=$*"\n`);
  await chmod(bunPath, 0o755);
}

async function launch(home: string, root = throneRoot): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(path.join(root, "bin", "throne-runtime"), ["dist/src/tools.js", "where-i-stand"], {
      env: { PATH: "/usr/bin:/bin", HOME: home },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "throne-runtime-"));
  throneRoot = path.join(scratch, "throne");
  await mkdir(path.join(throneRoot, "bin"), { recursive: true });
  await copyFile(path.join(REPO_ROOT, "bin", "throne-runtime"), path.join(throneRoot, "bin", "throne-runtime"));
  await chmod(path.join(throneRoot, "bin", "throne-runtime"), 0o755);
  await copyFile(path.join(REPO_ROOT, "mise.toml"), path.join(throneRoot, "mise.toml"));
  pinnedVersion = /bun = "([^"]+)"/.exec(await readFile(path.join(REPO_ROOT, "mise.toml"), "utf8"))![1];
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("starting throne through the launcher runs it on the pinned Bun with its arguments", async () => {
  const home = path.join(scratch, "pinned-home");
  await installFakeBun(home, pinnedVersion);
  await installFakeBun(home, "0.0.1");
  const result = await launch(home);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^ran=${pinnedBunPath(home, pinnedVersion).replaceAll(".", "\\.")}$`, "m"));
  assert.match(result.stdout, /^arguments=dist\/src\/tools\.js where-i-stand$/m);
});

test("the launcher refuses loudly when the pinned Bun is not installed", async () => {
  const home = path.join(scratch, "empty-home");
  await mkdir(home, { recursive: true });
  const result = await launch(home);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`bun ${pinnedVersion.replaceAll(".", "\\.")}, pinned in .*mise\\.toml, is not installed`));
});

test("the launcher refuses loudly when mise.toml pins no Bun", async () => {
  const unpinnedRoot = path.join(scratch, "unpinned");
  await mkdir(path.join(unpinnedRoot, "bin"), { recursive: true });
  await copyFile(path.join(throneRoot, "bin", "throne-runtime"), path.join(unpinnedRoot, "bin", "throne-runtime"));
  await chmod(path.join(unpinnedRoot, "bin", "throne-runtime"), 0o755);
  await writeFile(path.join(unpinnedRoot, "mise.toml"), '[tools]\nnode = "24.19.0"\n');
  const home = path.join(scratch, "pinned-home");
  const result = await launch(home, unpinnedRoot);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not pin bun under \[tools\]/);
});
