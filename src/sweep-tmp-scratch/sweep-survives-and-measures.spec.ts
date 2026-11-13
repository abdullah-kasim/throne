import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES } from "../tmp-scratch-lifecycle/remove-scratch-dir.ts";
import type { ScratchDirRemovalDependencies } from "../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts";
import { runSweepTmpScratch } from "./sweep-tmp-scratch-runtime.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_FOLDER_NAMES = [
  ".X11-unix",
  ".ICE-unix",
  ".font-unix",
  ".XIM-unix",
  "systemd-private-0123abcd-chronyd.service-Xy12Zq",
];

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sweep-survives-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function oldFolder(root: string, name: string): Promise<string> {
  const folderPath = path.join(root, name);
  await mkdir(folderPath);
  const dayAgo = new Date(Date.now() - DAY_MS);
  await utimes(folderPath, dayAgo, dayAgo);
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

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function dependenciesWith(overrides: Partial<ScratchDirRemovalDependencies>): ScratchDirRemovalDependencies {
  return { ...REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES, ...overrides };
}

function refusingToRemove(blockedPath: string): ScratchDirRemovalDependencies {
  return dependenciesWith({
    removeDirectory: async (dirPath) => {
      if (dirPath === blockedPath) throw codedError("EPERM");
      await REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES.removeDirectory(dirPath);
    },
  });
}

function changingStatusOf(
  targetPath: string,
  change: (status: Awaited<ReturnType<ScratchDirRemovalDependencies["readEntryStatus"]>>) => object,
): ScratchDirRemovalDependencies {
  return dependenciesWith({
    readEntryStatus: async (entryPath) => {
      const status = await REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES.readEntryStatus(entryPath);
      return entryPath === targetPath ? { ...status, ...change(status) } : status;
    },
  });
}

function failingStatusOf(targetPath: string, code: string): ScratchDirRemovalDependencies {
  return dependenciesWith({
    readEntryStatus: async (entryPath) => {
      if (entryPath === targetPath) throw codedError(code);
      return REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES.readEntryStatus(entryPath);
    },
  });
}

async function sweep(
  root: string,
  dependencies: ScratchDirRemovalDependencies,
  apply = true,
): Promise<{ exitCode: number; output: string }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const args = ["--tmp-root", root, ...(apply ? ["--apply"] : [])];
    const exitCode = await runSweepTmpScratch(args, os.homedir(), undefined, dependencies);
    return { exitCode, output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function lineFor(output: string, entryPath: string): string | undefined {
  return output.split("\n").find((line) => line.startsWith(`${entryPath}: `));
}

test("a root holding one undeletable entry between two deletable ones removes both and reports the failure", async () => {
  await withRoot(async (root) => {
    const first = await oldFolder(root, "a-first");
    const undeletable = await oldFolder(root, "b-undeletable");
    const last = await oldFolder(root, "c-last");
    const { output } = await sweep(root, refusingToRemove(undeletable));
    assert.equal(await exists(first), false);
    assert.equal(await exists(last), false);
    assert.equal(await exists(undeletable), true);
    assert.equal(lineFor(output, undeletable), `${undeletable}: failed (EPERM)`);
  });
});

test("an entry owned by another user is skipped", async () => {
  await withRoot(async (root) => {
    const foreign = await oldFolder(root, "someone-else");
    const { output } = await sweep(root, changingStatusOf(foreign, (status) => ({ ownerId: status.ownerId + 1 })));
    assert.equal(await exists(foreign), true);
    assert.equal(lineFor(output, foreign), `${foreign}: skipped-not-ours`);
  });
});

test("a mount point is skipped", async () => {
  await withRoot(async (root) => {
    const mounted = await oldFolder(root, "mounted");
    const { output } = await sweep(root, changingStatusOf(mounted, (status) => ({ deviceId: status.deviceId + 1 })));
    assert.equal(await exists(mounted), true);
    assert.equal(lineFor(output, mounted), `${mounted}: skipped-mount-point`);
  });
});

test("an entry whose lstat fails with ENOTCONN is skipped as a mount point", async () => {
  await withRoot(async (root) => {
    const deadMount = await oldFolder(root, "com.freerdp.client.cliprdr.4242");
    const { output } = await sweep(root, failingStatusOf(deadMount, "ENOTCONN"));
    assert.equal(await exists(deadMount), true);
    assert.equal(lineFor(output, deadMount), `${deadMount}: skipped-mount-point`);
  });
});

for (const name of SYSTEM_FOLDER_NAMES) {
  test(`the system folder ${name} is skipped`, async () => {
    await withRoot(async (root) => {
      const systemFolder = await oldFolder(root, name);
      const { output } = await sweep(root, REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES);
      assert.equal(await exists(systemFolder), true);
      assert.equal(lineFor(output, systemFolder), `${systemFolder}: skipped-system-name`);
    });
  });
}

test("the dry run skips the same entries the applying run skips", async () => {
  await withRoot(async (root) => {
    const foreign = await oldFolder(root, "someone-else");
    const systemFolder = await oldFolder(root, ".X11-unix");
    const ours = await oldFolder(root, "ours-AbC123");
    const dependencies = changingStatusOf(foreign, (status) => ({ ownerId: status.ownerId + 1 }));
    const dryRun = await sweep(root, dependencies, false);
    assert.equal(lineFor(dryRun.output, foreign), `${foreign}: skipped-not-ours`);
    assert.equal(lineFor(dryRun.output, systemFolder), `${systemFolder}: skipped-system-name`);
    assert.equal(lineFor(dryRun.output, ours), `${ours}: would-remove`);
    assert.equal(await exists(ours), true);
    const applied = await sweep(root, dependencies);
    assert.equal(lineFor(applied.output, foreign), `${foreign}: skipped-not-ours`);
    assert.equal(lineFor(applied.output, systemFolder), `${systemFolder}: skipped-system-name`);
    assert.equal(lineFor(applied.output, ours), `${ours}: removed`);
  });
});

test("the measure's counts match the entries", async () => {
  await withRoot(async (root) => {
    await oldFolder(root, "fake-npm-pack-AbC123");
    await oldFolder(root, "fake-npm-pack-DeF456");
    await oldFolder(root, "fake-npm-pack-GhI789");
    const undeletable = await oldFolder(root, "fake-npm-pack-JkL012");
    await oldFolder(root, "org.chromium.Chromium.XjzOcE");
    await mkdir(path.join(root, "org.chromium.Chromium.5AvjxK"));
    const { output } = await sweep(root, refusingToRemove(undeletable));
    const lines = output.trimEnd().split("\n");
    assert.ok(lines.includes("measure fake-npm-pack: removed 3, failed 1"));
    assert.ok(lines.includes("measure org.chromium.Chromium: removed 1, skipped-too-young 1"));
    assert.match(lines.at(-2)!, new RegExp(`^measure ${root} before: \\d+ inodes, \\d+ bytes in use$`));
    assert.match(lines.at(-1)!, new RegExp(`^measure ${root} after: \\d+ inodes, \\d+ bytes in use$`));
  });
});

test("the sweep exits 0 with a failure present", async () => {
  await withRoot(async (root) => {
    const undeletable = await oldFolder(root, "undeletable");
    const { exitCode, output } = await sweep(root, refusingToRemove(undeletable));
    assert.equal(lineFor(output, undeletable), `${undeletable}: failed (EPERM)`);
    assert.equal(exitCode, 0);
  });
});

test("an unreadable root exits non-zero", async () => {
  await withRoot(async (root) => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const { exitCode } = await sweep(path.join(root, "missing"), REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES);
      assert.notEqual(exitCode, 0);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test("the dry run's measure counts eligible entries as would-remove", async () => {
  await withRoot(async (root) => {
    const eligible = await oldFolder(root, "dry-family-AbC123");
    const { output } = await sweep(root, REAL_SCRATCH_DIR_REMOVAL_DEPENDENCIES, false);
    const lines = output.trimEnd().split("\n");
    assert.ok(lines.includes("measure dry-family: would-remove 1"), output);
    assert.equal(await exists(eligible), true);
  });
});

test("a root that cannot be read after the sweep still exits 0 and says so", async () => {
  await withRoot(async (parent) => {
    const root = path.join(parent, "vanishing-root");
    await mkdir(root);
    const entry = await oldFolder(root, "takes-the-root-with-it");
    const dependencies = dependenciesWith({
      removeDirectory: async () => {
        await rm(root, { recursive: true, force: true });
      },
    });
    const { exitCode, output } = await sweep(root, dependencies);
    assert.equal(exitCode, 0);
    assert.equal(lineFor(output, entry), `${entry}: removed`);
    assert.match(output.trimEnd().split("\n").at(-1)!, new RegExp(`^measure ${root} after: unreadable \\(ENOENT\\)$`));
  });
});
