import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const JSCPD_LAUNCHER = path.join(REPO_ROOT, "bin", "jscpd");

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const scratchDirectories: string[] = [];

after(async () => {
  await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeThroneCopy(): Promise<string> {
  const throneRoot = await mkdtemp(path.join(tmpdir(), "jscpd-launcher-test-"));
  scratchDirectories.push(throneRoot);
  await mkdir(path.join(throneRoot, "bin"));
  await copyFile(JSCPD_LAUNCHER, path.join(throneRoot, "bin", "jscpd"));
  await chmod(path.join(throneRoot, "bin", "jscpd"), 0o755);
  return throneRoot;
}

async function writeVendoredJscpd(throneRoot: string, argumentLog: string): Promise<void> {
  const vendorBin = path.join(throneRoot, "vendor", "node_modules", ".bin");
  await mkdir(vendorBin, { recursive: true });
  const vendored = path.join(vendorBin, "jscpd");
  await writeFile(vendored, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentLog)}\necho 'vendored jscpd ran'\nexit 42\n`);
  await chmod(vendored, 0o755);
}

async function runLauncher(launcher: string, args: string[], cwd: string, searchPath = "/usr/bin:/bin"): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await runFile(launcher, args, { cwd, env: { PATH: searchPath } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof failed.code !== "number") throw error;
    return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("the jscpd launcher runs the vendored jscpd and forwards every argument untouched", async () => {
  const throneRoot = await makeThroneCopy();
  const argumentLog = path.join(throneRoot, "arguments.log");
  await writeVendoredJscpd(throneRoot, argumentLog);
  const args = ["--min-tokens", "50", "a path with spaces", "--reporters=json"];

  const result = await runLauncher(path.join(throneRoot, "bin", "jscpd"), args, throneRoot);

  assert.equal(result.code, 42, result.stderr);
  assert.equal(result.stdout, "vendored jscpd ran\n");
  assert.deepEqual((await readFile(argumentLog, "utf8")).split("\n").filter(Boolean), args);
});

test("the jscpd launcher reached through a symlink from another repository runs the throne's vendored jscpd", async () => {
  const throneRoot = await makeThroneCopy();
  const argumentLog = path.join(throneRoot, "arguments.log");
  await writeVendoredJscpd(throneRoot, argumentLog);
  const otherRepository = await mkdtemp(path.join(tmpdir(), "jscpd-launcher-other-repository-"));
  scratchDirectories.push(otherRepository);
  const linkedLauncher = path.join(otherRepository, "jscpd");
  await symlink(path.join(throneRoot, "bin", "jscpd"), linkedLauncher);

  const result = await runLauncher(linkedLauncher, ["--version"], otherRepository);

  assert.equal(result.code, 42, result.stderr);
  assert.equal(result.stdout, "vendored jscpd ran\n");
});

test("the jscpd launcher fails with one line naming the installer step when the vendored jscpd is absent", async () => {
  const throneRoot = await makeThroneCopy();
  const fakeGlobal = path.join(throneRoot, "global-bin");
  await mkdir(fakeGlobal);
  await writeFile(path.join(fakeGlobal, "jscpd"), "#!/bin/sh\necho global\n");
  await chmod(path.join(fakeGlobal, "jscpd"), 0o755);

  const result = await runLauncher(path.join(throneRoot, "bin", "jscpd"), ["--version"], throneRoot, `${fakeGlobal}:/usr/bin:/bin`);

  assert.equal(result.code, 127);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
  assert.match(result.stderr, /no vendored jscpd at .*vendor\/node_modules\/\.bin\/jscpd; run: .*\.\/install\.sh --harnesses-only/);
});
