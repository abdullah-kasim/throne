import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileIsMissing } from "../where-i-stand/file-presence.ts";

const runFile = promisify(execFile);

function currentMilliseconds(): number {
  return performance.now();
}

export const PROBE_FOLDER_NAME = "pressure-probe";
export const PROBE_REPOSITORY_NAME = "repo";
export const PROBE_REPOSITORY_FILE_COUNT = 200;
export const DISK_PROBE_FILE_NAME = "disk-probe";
export const DISK_PROBE_BYTES = 4096;

const HOME_CACHE_PROBE_FOLDER = path.join(".cache", "throne", PROBE_FOLDER_NAME);
const PROBE_COMMIT_MESSAGE = "probe files";
const PROBE_IDENTITY = { name: "pressure probe", email: "pressure-probe@example.invalid" };

export interface ProbeTimes {
  readonly gitMs: number;
  readonly diskMs: number;
}

export type DeviceOf = (location: string) => Promise<number>;

export async function deviceOf(location: string): Promise<number> {
  return (await stat(location)).dev;
}

export async function resolveProbeFolder(
  dataHome: string,
  userHome: string,
  deviceOfLocation: DeviceOf = deviceOf,
): Promise<string> {
  if ((await deviceOfLocation(dataHome)) === (await deviceOfLocation(userHome))) return path.join(dataHome, PROBE_FOLDER_NAME);
  return path.join(userHome, HOME_CACHE_PROBE_FOLDER);
}

function probeCommitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: PROBE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: PROBE_IDENTITY.email,
    GIT_COMMITTER_NAME: PROBE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: PROBE_IDENTITY.email,
  };
}

async function git(repository: string, ...gitArguments: string[]): Promise<string> {
  const { stdout } = await runFile("git", ["-C", repository, ...gitArguments], { env: probeCommitEnvironment() });
  return stdout.trim();
}

async function writeProbeFiles(repository: string): Promise<void> {
  for (let fileNumber = 1; fileNumber <= PROBE_REPOSITORY_FILE_COUNT; fileNumber += 1) {
    await writeFile(path.join(repository, `file-${fileNumber}.txt`), `probe file ${fileNumber}\n`, "utf8");
  }
}

async function commitEveryFile(repository: string): Promise<void> {
  await git(repository, "add", "--all");
  const tree = await git(repository, "write-tree");
  const commit = await git(repository, "commit-tree", "--no-gpg-sign", "-m", PROBE_COMMIT_MESSAGE, tree);
  await git(repository, "update-ref", "HEAD", commit);
}

async function probeRepositoryExists(repository: string): Promise<boolean> {
  try {
    await stat(repository);
    return true;
  } catch (error) {
    if (fileIsMissing(error)) return false;
    throw error;
  }
}

async function moveIntoPlace(builtRepository: string, repository: string): Promise<void> {
  try {
    await rename(builtRepository, repository);
  } catch (error) {
    await rm(builtRepository, { recursive: true, force: true });
    if (!(await probeRepositoryExists(repository))) throw error;
  }
}

export async function ensureProbeRepository(probeFolder: string): Promise<string> {
  const repository = path.join(probeFolder, PROBE_REPOSITORY_NAME);
  if (await probeRepositoryExists(repository)) return repository;
  const builtRepository = `${repository}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(builtRepository, { recursive: true });
  await git(builtRepository, "init", "--quiet");
  await writeProbeFiles(builtRepository);
  await commitEveryFile(builtRepository);
  await moveIntoPlace(builtRepository, repository);
  return repository;
}

export async function timeGitProbe(repository: string, now: () => number = currentMilliseconds): Promise<number> {
  const startedAt = now();
  await runFile("git", ["-C", repository, "status", "--porcelain"]);
  return now() - startedAt;
}

export async function timeDiskProbe(probeFolder: string, now: () => number = currentMilliseconds): Promise<number> {
  const startedAt = now();
  const file = await open(path.join(probeFolder, DISK_PROBE_FILE_NAME), "w");
  try {
    await file.write(Buffer.alloc(DISK_PROBE_BYTES));
    await file.sync();
  } finally {
    await file.close();
  }
  return now() - startedAt;
}

export async function probeResponsiveness(
  dataHome: string,
  userHome: string,
  now: () => number = currentMilliseconds,
): Promise<ProbeTimes> {
  await mkdir(dataHome, { recursive: true });
  const probeFolder = await resolveProbeFolder(dataHome, userHome);
  await mkdir(probeFolder, { recursive: true });
  const repository = await ensureProbeRepository(probeFolder);
  return { gitMs: await timeGitProbe(repository, now), diskMs: await timeDiskProbe(probeFolder, now) };
}
