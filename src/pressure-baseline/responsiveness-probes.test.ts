import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
  DISK_PROBE_BYTES,
  DISK_PROBE_FILE_NAME,
  ensureProbeRepository,
  probeResponsiveness,
  PROBE_REPOSITORY_FILE_COUNT,
  resolveProbeFolder,
  timeDiskProbe,
  timeGitProbe,
} from "./responsiveness-probes.ts";

const runFile = promisify(execFile);

const SHIM_FOLDER = path.resolve(import.meta.dirname, "..", "..", "bin");

let scratchRoot: string;
let dataHome: string;
let userHome: string;
let probeFolder: string;

async function gitIn(repository: string, ...gitArguments: string[]): Promise<string> {
  return (await runFile("git", ["-C", repository, ...gitArguments], { encoding: "utf8" })).stdout.trim();
}

function clockReading(...readings: number[]): () => number {
  return () => readings.shift() ?? Number.NaN;
}

before(async () => {
  scratchRoot = await mkdtemp(path.join(os.tmpdir(), "pressure-probes-"));
  userHome = path.join(scratchRoot, "home");
  dataHome = path.join(userHome, ".throne");
  await probeResponsiveness(dataHome, userHome);
  probeFolder = await resolveProbeFolder(dataHome, userHome);
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

test("the git probe times git status in a probe repository it creates on first use with about 200 committed files", async () => {
  const repository = path.join(dataHome, "pressure-probe", "repo");

  assert.equal((await gitIn(repository, "ls-files")).split("\n").length, PROBE_REPOSITORY_FILE_COUNT);
  assert.equal(await gitIn(repository, "status", "--porcelain"), "");
  assert.equal(await timeGitProbe(repository, clockReading(100, 141)), 41);
});

test("the git probe repository can be created with the throne git shim first on PATH without signing or prompting", async () => {
  const shimProbeFolder = path.join(scratchRoot, "shim-probe");
  const originalPath = process.env.PATH;
  process.env.PATH = `${SHIM_FOLDER}${path.delimiter}${originalPath ?? ""}`;
  try {
    const repository = await ensureProbeRepository(shimProbeFolder);
    assert.equal(await gitIn(repository, "log", "-1", "--format=%G?|%an|%ae|%s"), "N|pressure probe|pressure-probe@example.invalid|probe files");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("the disk probe times a 4 KiB write and fsync against an injected clock", async () => {
  assert.equal(await timeDiskProbe(probeFolder, clockReading(10, 19)), 9);
  assert.equal((await stat(path.join(probeFolder, DISK_PROBE_FILE_NAME))).size, DISK_PROBE_BYTES);
});

test("the probe folder is the data home when it shares the home directory's device and the home cache folder when it does not", async () => {
  const sameDevice = async () => 7;
  const devices = new Map([
    [dataHome, 7],
    [userHome, 8],
  ]);
  const otherDevice = async (location: string) => devices.get(location) ?? 0;

  assert.equal(await resolveProbeFolder(dataHome, userHome, sameDevice), path.join(dataHome, "pressure-probe"));
  assert.equal(
    await resolveProbeFolder(dataHome, userHome, otherDevice),
    path.join(userHome, ".cache", "throne", "pressure-probe"),
  );
});
