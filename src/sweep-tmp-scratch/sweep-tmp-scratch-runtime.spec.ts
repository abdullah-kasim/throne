import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { throneCacheDirectory } from "../shared-policy/throne-home.ts";
import { runSweepTmpScratch } from "./sweep-tmp-scratch-runtime.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;
const HUNDRED_GB = 100_000_000_000;
const dayAgo = new Date(Date.now() - DAY_MS);

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

async function homeWithStaleScratchDirectory() {
  const home = await mkdtemp(path.join(os.tmpdir(), "sweep-home-"));
  const staleDirectory = path.join(home, "tmp", "kept-for-the-lord");
  await mkdir(staleDirectory, { recursive: true });
  await utimes(staleDirectory, dayAgo, dayAgo);
  return { home, staleDirectory };
}

async function withCacheRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sweep-cache-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function agedFile(root: string, name: string, days: number): Promise<string> {
  const filePath = path.join(root, name);
  await writeFile(filePath, name);
  await utimes(filePath, daysAgo(days), daysAgo(days));
  return filePath;
}

async function agedFolder(root: string, name: string, days: number): Promise<string> {
  const folderPath = path.join(root, name);
  await mkdir(folderPath);
  await writeFile(path.join(folderPath, "inside.txt"), name);
  await utimes(folderPath, daysAgo(days), daysAgo(days));
  return folderPath;
}

async function exists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath);
    return true;
  } catch {
    return false;
  }
}

function freeSpaceReadings(readings: number[]) {
  const reader = async () => {
    reader.calls += 1;
    return readings[Math.min(reader.calls - 1, readings.length - 1)]!;
  };
  reader.calls = 0;
  return reader;
}

function cacheArgs(root: string, ...extra: string[]): string[] {
  return [
    "--tmp-root",
    root,
    "--min-age-ms",
    String(THIRTY_DAYS_MS),
    "--min-free-bytes",
    String(HUNDRED_GB),
    ...extra,
  ];
}

async function captureStdout(run: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    return { exitCode: await run(), output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("sweeping the home scratch folder without cache mode is refused and deletes nothing", async () => {
  const { home, staleDirectory } = await homeWithStaleScratchDirectory();
  try {
    const exitCode = await runSweepTmpScratch(
      ["--apply", "--tmp-root", path.join(home, "tmp")],
      home,
    );
    assert.equal(exitCode, 2);
    assert.ok((await stat(staleDirectory)).isDirectory());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a link that leads to the home scratch folder is refused too", async () => {
  const { home, staleDirectory } = await homeWithStaleScratchDirectory();
  const link = path.join(home, "scratch-link");
  await symlink(path.join(home, "tmp"), link);
  try {
    const exitCode = await runSweepTmpScratch(["--apply", "--tmp-root", link], home);
    assert.equal(exitCode, 2);
    assert.ok((await stat(staleDirectory)).isDirectory());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a cache sweep of the home scratch folder is allowed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "sweep-home-"));
  try {
    const homeScratch = path.join(home, "tmp");
    await mkdir(homeScratch);
    const oldFolder = await agedFolder(homeScratch, "old-capture", 45);
    const exitCode = await runSweepTmpScratch(
      cacheArgs(homeScratch, "--apply"),
      home,
      freeSpaceReadings([1, 1]),
    );
    assert.equal(exitCode, 0);
    assert.equal(await exists(oldFolder), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("below the free-space threshold the cache sweep deletes the oldest old entries first and stops once enough space is free", async () => {
  await withCacheRoot(async (root) => {
    const oldest = await agedFolder(root, "oldest", 90);
    const older = await agedFile(root, "older.log", 60);
    const oldButYoungest = await agedFolder(root, "old-but-youngest", 40);
    const readFreeBytes = freeSpaceReadings([50e9, 70e9, HUNDRED_GB]);
    const exitCode = await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), readFreeBytes);
    assert.equal(exitCode, 0);
    assert.equal(await exists(oldest), false);
    assert.equal(await exists(older), false);
    assert.equal(await exists(oldButYoungest), true);
    assert.equal(readFreeBytes.calls, 3);
  });
});

test("loose files and folders are both deleted when they are old enough", async () => {
  await withCacheRoot(async (root) => {
    const looseFile = await agedFile(root, "loose.pdf", 31);
    const folder = await agedFolder(root, "build", 31);
    await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
    assert.equal(await exists(looseFile), false);
    assert.equal(await exists(folder), false);
  });
});

test("an entry younger than thirty days is kept even when the disk is nearly full", async () => {
  await withCacheRoot(async (root) => {
    const youngFile = await agedFile(root, "young.pdf", 29);
    const youngFolder = await agedFolder(root, "young-build", 29);
    await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
    assert.equal(await exists(youngFile), true);
    assert.equal(await exists(youngFolder), true);
  });
});

test("a folder is judged by its own modified time, not by the files inside it", async () => {
  await withCacheRoot(async (root) => {
    const oldFolderWithFreshFile = path.join(root, "old-outside");
    await mkdir(oldFolderWithFreshFile);
    await writeFile(path.join(oldFolderWithFreshFile, "fresh.txt"), "fresh");
    await utimes(oldFolderWithFreshFile, daysAgo(60), daysAgo(60));

    const freshFolderWithOldFiles = path.join(root, "fresh-outside");
    await mkdir(freshFolderWithOldFiles);
    await agedFile(freshFolderWithOldFiles, "ancient.txt", 365);

    await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
    assert.equal(await exists(oldFolderWithFreshFile), false);
    assert.equal(await exists(freshFolderWithOldFiles), true);
  });
});

test("a link is judged by its own modified time and removed without touching what it points at", async () => {
  await withCacheRoot(async (root) => {
    const target = await mkdtemp(path.join(os.tmpdir(), "sweep-link-target-"));
    try {
      const link = path.join(root, "old-link");
      await symlink(target, link);
      await lutimes(link, daysAgo(60), daysAgo(60));
      await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
      assert.equal(await exists(link), false);
      assert.ok((await stat(target)).isDirectory());
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

test("at or above the free-space threshold the cache sweep deletes nothing", async () => {
  await withCacheRoot(async (root) => {
    const oldFolder = await agedFolder(root, "old-capture", 90);
    const readFreeBytes = freeSpaceReadings([HUNDRED_GB]);
    const { exitCode, output } = await captureStdout(() =>
      runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), readFreeBytes),
    );
    assert.equal(exitCode, 0);
    assert.equal(await exists(oldFolder), true);
    assert.equal(readFreeBytes.calls, 1);
    assert.doesNotMatch(output, /removed|would-remove/);
    assert.match(output, /nothing to do/);
  });
});

test("the cache notice is never deleted however old it is", async () => {
  await withCacheRoot(async (root) => {
    const notice = await agedFile(root, "AGENTS.md", 60);
    await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
    assert.equal(await exists(notice), true);
  });
});

test("every cache sweep writes the cache notice when it is missing, dry-run included", async () => {
  await withCacheRoot(async (root) => {
    await runSweepTmpScratch(cacheArgs(root), os.homedir(), freeSpaceReadings([HUNDRED_GB]));
    assert.equal(await exists(path.join(root, "AGENTS.md")), true);
  });
});

test("an existing cache notice is left exactly as it is", async () => {
  await withCacheRoot(async (root) => {
    const notice = path.join(root, "AGENTS.md");
    await writeFile(notice, "the Lord's own words\n");
    await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
    assert.equal(await readFile(notice, "utf8"), "the Lord's own words\n");
  });
});

test("the cache notice tells agents the folder is a cache, the age and space rule, where lasting caches go, and not to delete it", async () => {
  await withCacheRoot(async (root) => {
    await runSweepTmpScratch(cacheArgs(root), os.homedir(), freeSpaceReadings([HUNDRED_GB]));
    const notice = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.match(notice, /is a cache/);
    assert.match(notice, /less than 100 GB free, entries older than 30 days are deleted/);
    assert.ok(notice.includes(`${path.join(throneCacheDirectory(), "<tool>")}/`));
    assert.match(notice, /Never delete this file/);
    assert.match(notice, /sweep-tmp-scratch-home/);
    assert.match(notice, /its own\s+modified time/);
  });
});

test("a dry-run cache sweep deletes nothing and lists what it would delete oldest first", async () => {
  await withCacheRoot(async (root) => {
    const newerOld = await agedFile(root, "newer-old.log", 40);
    const oldest = await agedFolder(root, "oldest", 90);
    const { exitCode, output } = await captureStdout(() =>
      runSweepTmpScratch(cacheArgs(root), os.homedir(), freeSpaceReadings([1])),
    );
    assert.equal(exitCode, 0);
    assert.equal(await exists(newerOld), true);
    assert.equal(await exists(oldest), true);
    const wouldRemove = output
      .split("\n")
      .filter((line) => line.endsWith(": would-remove"))
      .map((line) => line.replace(": would-remove", ""));
    assert.deepEqual(wouldRemove, [oldest, newerOld]);
  });
});

test("an entry a live process holds is skipped by the cache sweep", async () => {
  await withCacheRoot(async (root) => {
    const heldFile = await agedFile(root, "held.log", 60);
    const handle = await open(heldFile, "r");
    try {
      await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
      assert.equal(await exists(heldFile), true);
    } finally {
      await handle.close();
    }
  });
});

async function withCacheRootThroughLink(
  run: (linkedRoot: string) => Promise<void>,
): Promise<void> {
  await withCacheRoot(async (root) => {
    const linkHome = await mkdtemp(path.join(os.tmpdir(), "sweep-cache-link-"));
    try {
      const linkedRoot = path.join(linkHome, "cache");
      await symlink(root, linkedRoot);
      await run(linkedRoot);
    } finally {
      await rm(linkHome, { recursive: true, force: true });
    }
  });
}

function reportedOutcome(output: string, entryPath: string): string | undefined {
  const line = output.split("\n").find((reportLine) => reportLine.startsWith(`${entryPath}: `));
  return line?.slice(entryPath.length + 2);
}

test("an entry a live process holds is skipped even when the root is reached through a symlink", async () => {
  await withCacheRootThroughLink(async (linkedRoot) => {
    const heldFolder = await agedFolder(linkedRoot, "held-build", 60);
    const heldFile = await agedFile(linkedRoot, "held.log", 60);
    const folderHolder = spawn("sleep", ["120"], { cwd: heldFolder, stdio: "ignore" });
    await once(folderHolder, "spawn");
    const handle = await open(heldFile, "r");
    try {
      const { output } = await captureStdout(() =>
        runSweepTmpScratch(cacheArgs(linkedRoot, "--apply"), os.homedir(), freeSpaceReadings([1])),
      );
      assert.equal(reportedOutcome(output, heldFolder), "skipped-live");
      assert.equal(reportedOutcome(output, heldFile), "skipped-live");
      assert.equal(await exists(heldFolder), true);
      assert.equal(await exists(heldFile), true);
    } finally {
      await handle.close();
      folderHolder.kill();
    }
  });
});

test("an entry exactly thirty days old is kept and one a moment older is deleted", async () => {
  await withCacheRoot(async (root) => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const exactlyThirtyDays = new Date(now - THIRTY_DAYS_MS);
    const aMomentOlder = new Date(now - THIRTY_DAYS_MS - 1000);
    const exactFile = path.join(root, "exactly-thirty-days.log");
    const olderFile = path.join(root, "a-moment-older.log");
    await writeFile(exactFile, "exact");
    await writeFile(olderFile, "older");
    await utimes(exactFile, exactlyThirtyDays, exactlyThirtyDays);
    await utimes(olderFile, aMomentOlder, aMomentOlder);
    mock.method(Date, "now", () => now);
    try {
      await runSweepTmpScratch(cacheArgs(root, "--apply"), os.homedir(), freeSpaceReadings([1]));
    } finally {
      mock.restoreAll();
    }
    assert.equal(await exists(exactFile), true);
    assert.equal(await exists(olderFile), false);
  });
});

test("a free-space threshold that is not a whole number of bytes is refused", async () => {
  await withCacheRoot(async (root) => {
    const oldFolder = await agedFolder(root, "old-capture", 90);
    for (const threshold of ["plenty", "1.5", "1e11", "100GB"]) {
      const exitCode = await runSweepTmpScratch(
        ["--apply", "--tmp-root", root, "--min-free-bytes", threshold],
        os.homedir(),
        freeSpaceReadings([1]),
      );
      assert.equal(exitCode, 2, threshold);
      assert.equal(await exists(oldFolder), true, threshold);
    }
  });
});
