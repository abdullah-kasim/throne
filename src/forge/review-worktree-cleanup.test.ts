import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { git } from "../../test/git-repo-test-fixture.ts";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { openGithubPullRequestToStage, stagingDependencies } from "../../test/forge-staging-test-support.ts";
import { removeWorktreesBesideCheckout, startOpenHost, type OpenHost } from "../../test/forge-open-test-support.ts";
import { runForgeCapturing } from "../../test/forge-test-support.ts";
import { PULL_REQUEST_STAGE } from "./pull-request-status.ts";

let host: OpenHost;

before(async () => {
  await import("./forge.command.ts");
  host = await startOpenHost("forge-cleanup-");
});

afterEach(async () => {
  await removeWorktreesBesideCheckout(host);
});

after(async () => {
  await host.remove();
});

function besideCheckout(suffix: string): string {
  return path.join(path.dirname(host.checkout), `${path.basename(host.checkout)}-${suffix}`);
}

async function cleanUp(repo = host.checkout): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runForgeCapturing(["open", "--cleanup", "--repo", repo], stagingDependencies, host.scratch);
}

async function bareCloneWithLinkedTrunk(): Promise<{ readonly bare: string; readonly trunk: string }> {
  const layout = path.join(host.scratch, `bare-layout-${Date.now()}`);
  const bare = path.join(layout, ".bare");
  const trunk = path.join(layout, "project__trunk");
  await git(host.scratch, ["clone", "-q", "--bare", host.checkout, bare]);
  await git(bare, ["worktree", "add", "-q", trunk, "main"]);
  return { bare, trunk };
}

async function worktreePathsOf(repo: string): Promise<string[]> {
  const listing = await git(repo, ["worktree", "list", "--porcelain"]);
  return listing.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

test("cleanup removes only review worktrees whose pull request is merged or closed", async () => {
  const closed = host.addForgejoPullRequest("closed");
  const open = host.addForgejoPullRequest("open");
  const closedButDirty = host.addForgejoPullRequest("closed");
  const mergedUrl = await openGithubPullRequestToStage(host.staging, { state: "MERGED", head: "merged/on-github", headSha: host.featureSha });
  const mergedNumber = Number(mergedUrl.split("/").pop());
  const closedTree = await host.addReviewWorktree(besideCheckout(`pr-${closed.number}`), closed.url);
  const openTree = await host.addReviewWorktree(besideCheckout(`pr-${open.number}`), open.url);
  const dirtyTree = await host.addReviewWorktree(besideCheckout(`pr-${closedButDirty.number}`), closedButDirty.url);
  const mergedTree = await host.addReviewWorktree(besideCheckout(`pr-${mergedNumber}`), mergedUrl);
  await writeFile(path.join(dirtyTree, "unsaved.txt"), "work in progress\n");

  const cleaned = await cleanUp();

  assert.equal(cleaned.exitCode, 0, cleaned.stderr);
  const lines = cleaned.stdout.trimEnd().split("\n");
  assert.ok(lines.includes(`removed ${closedTree}: its pull request is closed`), cleaned.stdout);
  assert.ok(lines.includes(`removed ${mergedTree}: its pull request is merged-on-github`), cleaned.stdout);
  assert.ok(lines.includes(`kept ${openTree}: its pull request is forgejo-only`), cleaned.stdout);
  assert.ok(lines.some((line) => line.startsWith(`kept ${dirtyTree}: its pull request is closed, but git refused to remove it: `)), cleaned.stdout);
  assert.equal(lines.length, 4);
  assert.deepEqual(
    await Promise.all([closedTree, mergedTree, openTree, dirtyTree].map(pathExists)),
    [false, false, true, true],
  );
});

test("cleanup never removes a worktree that is not a review worktree", async () => {
  const closed = host.addForgejoPullRequest("closed");
  await git(host.checkout, ["branch", "review-on-a-branch", host.featureSha]);
  const branchTree = besideCheckout("on-a-branch");
  await git(host.checkout, ["worktree", "add", "-q", branchTree, "review-on-a-branch"]);
  const unrecordedTree = await host.addDetachedWorktree(besideCheckout(`pr-${closed.number}`));
  const agentTree = await host.addDetachedWorktree(path.join(host.scratch, "finished-alpha"));

  const cleaned = await cleanUp();

  assert.equal(cleaned.exitCode, 0, cleaned.stderr);
  assert.equal(cleaned.stdout, `no review worktrees recorded by forge open in ${host.checkout}\n`);
  assert.deepEqual(await Promise.all([branchTree, unrecordedTree, agentTree].map(pathExists)), [true, true, true]);
});

test("cleanup removes a merged pull request's review worktree when the clone is a bare repository with linked worktrees", async () => {
  const mergedUrl = await openGithubPullRequestToStage(host.staging, { state: "MERGED", head: "merged/on-github", headSha: host.featureSha });
  const { bare, trunk } = await bareCloneWithLinkedTrunk();
  const opened = await runForgeCapturing(["open", mergedUrl, "--repo", trunk, "--print"], stagingDependencies, host.checkout);
  const reviewTree = opened.stdout.trim();
  assert.equal(opened.exitCode, 0, opened.stderr);
  assert.equal(reviewTree, `${trunk}-pr-${mergedUrl.split("/").pop()}`);

  const cleaned = await cleanUp(trunk);

  assert.equal(cleaned.exitCode, 0, cleaned.stderr);
  assert.equal(cleaned.stdout, `removed ${reviewTree}: its pull request is merged-on-github\n`);
  assert.deepEqual(await worktreePathsOf(bare), [bare, trunk]);
});

test("cleanup judges a review worktree by the pull request it was opened for, not by a same-numbered pull request on the other forge", async () => {
  const githubUrl = await openGithubPullRequestToStage(host.staging, { state: "OPEN", headSha: host.featureSha });
  const githubNumber = Number(githubUrl.split("/").pop());
  let forgejoNumber = 0;
  while (forgejoNumber < githubNumber) forgejoNumber = host.addForgejoPullRequest("closed").number;
  assert.equal(forgejoNumber, githubNumber);
  const reviewTree = await host.addReviewWorktree(besideCheckout(`pr-${githubNumber}`), githubUrl);

  const cleaned = await cleanUp();

  assert.equal(cleaned.exitCode, 0, cleaned.stderr);
  assert.equal(cleaned.stdout, `kept ${reviewTree}: its pull request is ${PULL_REQUEST_STAGE.githubOnly}\n`);
  assert.equal(await pathExists(reviewTree), true);
});
