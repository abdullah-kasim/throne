import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { manifestFingerprint, writeHydrationMarker } from "../git-lifecycle/dependency-hydration-fingerprint.ts";
import { startBackgroundHydration } from "./background-hydration.ts";

const scratch = await mkdtemp(path.join(os.tmpdir(), "forge-open-hydration-"));
const stateHome = path.join(scratch, "state");
const stateHomeBefore = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = stateHome;
after(async () => {
  if (stateHomeBefore === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = stateHomeBefore;
  await rm(scratch, { recursive: true, force: true });
});

const PACKAGE_MANIFEST = '{"name":"review-me","version":"1.0.0"}\n';

async function projectWithManifest(name: string): Promise<string> {
  const project = path.join(scratch, name);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "package.json"), PACKAGE_MANIFEST);
  return project;
}

const runFile = promisify(execFile);

async function git(directory: string, ...gitArguments: string[]): Promise<void> {
  await runFile("git", ["-C", directory, "-c", "commit.gpgsign=false", "-c", "user.name=Reviewer", "-c", "user.email=reviewer@example.com", ...gitArguments]);
}

async function mainCheckoutWithReviewWorktree(name: string): Promise<{ mainCheckout: string; worktree: string }> {
  const mainCheckout = await projectWithManifest(name);
  await git(mainCheckout, "init", "--quiet");
  await git(mainCheckout, "add", "package.json");
  await git(mainCheckout, "commit", "--quiet", "-m", "Add the manifest");
  const worktree = path.join(scratch, `${name}-pr-12`);
  await git(mainCheckout, "worktree", "add", "--quiet", "--detach", worktree);
  return { mainCheckout, worktree };
}

async function isPresent(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function waitForLogLine(logPath: string): Promise<string> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    if (log.includes("dependency hydration")) return log;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${logPath} never recorded the hydration`);
}

test("background hydration is started and the command does not wait for it", async () => {
  const { mainCheckout, worktree } = await mainCheckoutWithReviewWorktree("throne");
  await mkdir(path.join(mainCheckout, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(mainCheckout, "node_modules", "left-pad", "index.js"), "export default 1;\n");
  const copiedDependency = path.join(worktree, "node_modules", "left-pad", "index.js");

  const hydration = await startBackgroundHydration(mainCheckout, worktree);

  assert.deepEqual(hydration, {
    outcome: "started",
    logPath: path.join(stateHome, "throne", "forge-open", "throne-pr-12.log"),
  });
  assert.equal(await isPresent(copiedDependency), false, "the call returned before the hydration ran");
  const log = await waitForLogLine(hydration.logPath);
  assert.match(log, /dependency hydration finished \(reflink\): node_modules/);
  assert.equal(await isPresent(copiedDependency), true);
});

test("hydration is skipped when the worktree's dependencies are already current", async () => {
  const mainCheckout = await projectWithManifest("current-main");
  const worktree = await projectWithManifest("current-main-pr-3");
  const dependencies = path.join(worktree, "node_modules");
  await mkdir(dependencies);
  await writeHydrationMarker(dependencies, (await manifestFingerprint(worktree)) ?? "");

  const hydration = await startBackgroundHydration(mainCheckout, worktree);

  assert.deepEqual(hydration, { outcome: "already current" });
  assert.equal(await isPresent(path.join(stateHome, "throne", "forge-open", "current-main-pr-3.log")), false);
});
