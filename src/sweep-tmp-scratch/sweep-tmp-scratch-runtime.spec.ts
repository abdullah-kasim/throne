import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSweepTmpScratch } from "./sweep-tmp-scratch-runtime.ts";

const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

async function homeWithStaleScratchDirectory() {
  const home = await mkdtemp(path.join(os.tmpdir(), "sweep-home-"));
  const staleDirectory = path.join(home, "tmp", "kept-for-the-lord");
  await mkdir(staleDirectory, { recursive: true });
  await utimes(staleDirectory, dayAgo, dayAgo);
  return { home, staleDirectory };
}

test("sweeping the home scratch folder is refused and deletes nothing", async () => {
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
