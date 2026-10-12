import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pinnedNodePath, readPinnedNodeVersion } from "./pinned-node.support.ts";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const LAUNCHERS = ["throne", "throne-bot", "throne-cli"];
const BUMPED_VERSION = "99.0.0";

interface Scratch {
  directory: string;
  throneRoot: string;
  bumpedThroneRoot: string;
  pinnedHome: string;
  emptyHome: string;
  wrongVersionHome: string;
  decoyDirectory: string;
  pinnedVersion: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let scratch: Scratch;

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `#!/bin/sh\n${body}\n`);
  await chmod(filePath, 0o755);
}

async function installFakeNode(home: string, installedVersion: string, reportedVersion: string): Promise<void> {
  await writeExecutable(
    pinnedNodePath(home, installedVersion),
    `if [ "$1" = --version ]; then echo "v${reportedVersion}"; exit 0; fi\necho "ran=$0"\necho "path=$PATH"\necho "arguments=$*"`,
  );
}

async function buildThroneRoot(throneRoot: string, pinnedVersion: string): Promise<void> {
  await mkdir(path.join(throneRoot, "bin"), { recursive: true });
  for (const name of [...LAUNCHERS, "pinned-node-lib.sh"]) {
    await copyFile(path.join(REPO_ROOT, "bin", name), path.join(throneRoot, "bin", name));
    await chmod(path.join(throneRoot, "bin", name), 0o755);
  }
  await mkdir(path.join(throneRoot, "dist", "src"), { recursive: true });
  await writeFile(path.join(throneRoot, "dist", "src", "tools.js"), "");
  await writeFile(path.join(throneRoot, "mise.toml"), `[tools]\nnode = "${pinnedVersion}"\n`);
}

before(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pinned-node-"));
  const pinnedVersion = await readPinnedNodeVersion();
  scratch = {
    directory,
    throneRoot: path.join(directory, "throne"),
    bumpedThroneRoot: path.join(directory, "bumped-throne"),
    pinnedHome: path.join(directory, "pinned-home"),
    emptyHome: path.join(directory, "empty-home"),
    wrongVersionHome: path.join(directory, "wrong-version-home"),
    decoyDirectory: path.join(directory, "decoy"),
    pinnedVersion,
  };
  await buildThroneRoot(scratch.throneRoot, pinnedVersion);
  await buildThroneRoot(scratch.bumpedThroneRoot, BUMPED_VERSION);
  await installFakeNode(scratch.pinnedHome, pinnedVersion, pinnedVersion);
  await installFakeNode(scratch.pinnedHome, BUMPED_VERSION, BUMPED_VERSION);
  await mkdir(scratch.emptyHome, { recursive: true });
  await installFakeNode(scratch.wrongVersionHome, pinnedVersion, "25.8.1");
  await writeExecutable(path.join(scratch.decoyDirectory, "node"), 'echo "ran=decoy"');
});

after(async () => {
  await rm(scratch.directory, { recursive: true, force: true });
});

async function runCommand(command: string, commandArguments: string[], home: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await run(command, commandArguments, {
      env: { HOME: home, PATH: `${scratch.decoyDirectory}:/usr/bin:/bin` },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function runLauncher(launcher: string, home: string, throneRoot = scratch.throneRoot): Promise<RunResult> {
  return runCommand(path.join(throneRoot, "bin", launcher), ["agent-statuses"], home);
}

function runInstallGate(home: string): Promise<RunResult> {
  return runCommand(
    "bash",
    ["-c", 'source "$1/bin/pinned-node-lib.sh" && pinned_node_reports_pinned_version "$1"', "install-gate", scratch.throneRoot],
    home,
  );
}

function outputLine(stdout: string, key: string): string {
  return stdout.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
}

for (const launcher of LAUNCHERS) {
  test(`${launcher} runs the node version pinned in mise.toml`, async () => {
    const result = await runLauncher(launcher, scratch.pinnedHome);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(outputLine(result.stdout, "ran"), pinnedNodePath(scratch.pinnedHome, scratch.pinnedVersion));
  });

  test(`${launcher} refuses and names mise install when the pinned node is not installed`, async () => {
    const result = await runLauncher(launcher, scratch.emptyHome);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /mise install/);
    assert.ok(result.stderr.includes(scratch.throneRoot), result.stderr);
  });

  test(`${launcher} never falls back to the node on PATH`, async () => {
    const result = await runLauncher(launcher, scratch.emptyHome);

    assert.doesNotMatch(result.stdout, /ran=decoy/);
  });
}

test("a throne command puts the pinned node first on PATH for every child process", async () => {
  const result = await runLauncher("throne", scratch.pinnedHome);

  const firstPathEntry = outputLine(result.stdout, "path").split(":")[0];
  assert.equal(firstPathEntry, path.dirname(pinnedNodePath(scratch.pinnedHome, scratch.pinnedVersion)));
});

test("bumping the version in mise.toml moves the launcher to that version", async () => {
  const result = await runLauncher("throne", scratch.pinnedHome, scratch.bumpedThroneRoot);

  assert.equal(outputLine(result.stdout, "ran"), pinnedNodePath(scratch.pinnedHome, BUMPED_VERSION));
});

test("install.sh accepts the pinned node when it reports exactly the pinned version", async () => {
  const result = await runInstallGate(scratch.pinnedHome);

  assert.equal(result.code, 0, result.stderr);
});

test("install.sh refuses a pinned node that reports a different version", async () => {
  const result = await runInstallGate(scratch.wrongVersionHome);

  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(`reports v25.8.1, not v${scratch.pinnedVersion}`), result.stderr);
});
