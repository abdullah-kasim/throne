import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { BranchSyncReport } from "../src/forge/branch-sync.ts";
import { forgejoCopiesWithCheckouts } from "../src/forge/forgejo-copies.ts";
import { openForgejoApiOnThisHost } from "../src/forge/pull-request-operations.ts";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_FORGEJO_ADMIN } from "./forge-fake-forgejo.ts";
import {
  commitInBareByHand,
  forgeDependenciesWithFakeGithub,
  recordingGitCalls,
  runForgeCapturing,
  startForgejoWithCheckoutForEachTest,
} from "./forge-test-support.ts";

const forgejoWithCheckout = startForgejoWithCheckoutForEachTest("forge-sync-branches-");
const dependencies = forgeDependenciesWithFakeGithub();
const checkout = () => forgejoWithCheckout().checkout;
const forgejo = () => forgejoWithCheckout().forgejo;

function forgejoCopy(): string {
  return forgejo().bareRepositoryPath(`${FAKE_FORGEJO_ADMIN}/staging-demo`);
}

async function syncBranches(forgeDependencies = dependencies): Promise<{ report: BranchSyncReport; stderr: string }> {
  const synced = await runForgeCapturing(["sync-branches"], forgeDependencies, checkout().repo);
  assert.equal(synced.exitCode, 0, synced.stderr);
  return { report: JSON.parse(synced.stdout) as BranchSyncReport, stderr: synced.stderr };
}

async function branchOnGithub(branch: string): Promise<string> {
  await git(checkout().origin, ["branch", branch, "main"]);
  return commitInBareByHand(checkout().origin, branch, `work on ${branch}`);
}

async function divergeMainBetweenGithubAndForgejo(): Promise<string> {
  await syncBranches();
  await commitInBareByHand(checkout().origin, "main", "merged on GitHub");
  return commitInBareByHand(forgejoCopy(), "main", "edited in Forgejo");
}

async function openPullRequest(head: string, base: string): Promise<number> {
  const bodyFile = path.join(checkout().repo, "body.md");
  await writeFile(bodyFile, "Body\n");
  const created = await runForgeCapturing(
    ["pr", "create", "--base", base, "--head", head, "--title", head, "--body-file", bodyFile],
    dependencies,
    checkout().repo,
  );
  assert.equal(created.exitCode, 0, created.stderr);
  return Number(created.stdout.trim().split("/").pop());
}

function pushedBranches(gitCalls: readonly string[][]): string[] {
  return gitCalls.filter((args) => args[0] === "push" && args[1] === "forgejo").map((args) => args[2]!.split(":refs/heads/")[1]!);
}

async function assertSyncCreatesTheGithubBranchOnForgejo(branch: string): Promise<void> {
  const githubTip = await branchOnGithub(branch);

  const { report } = await syncBranches();

  assert.equal(await git(forgejoCopy(), ["rev-parse", `refs/heads/${branch}`]), githubTip);
  assert.ok(report.created.includes(branch), JSON.stringify(report));
}

test("syncing branches creates a GitHub branch that Forgejo does not have", async () => {
  await assertSyncCreatesTheGithubBranchOnForgejo("release/next");
});

test("syncing branches fast-forwards a Forgejo branch that is behind GitHub", async () => {
  await syncBranches();
  const githubMain = await commitInBareByHand(checkout().origin, "main", "merged on GitHub");

  const { report } = await syncBranches();

  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/main"]), githubMain);
  assert.deepEqual(report.fastForwarded, ["main"]);
});

test("syncing branches never force-pushes a branch that diverged, and reports it", async () => {
  const forgejoMain = await divergeMainBetweenGithubAndForgejo();

  const { report, stderr } = await syncBranches();

  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/main"]), forgejoMain);
  assert.deepEqual(report.diverged, ["main"]);
  assert.match(stderr, /main diverged between GitHub and Forgejo/);
});

test("a checkout whose git config sends all traffic through an unreachable proxy still mirrors to Forgejo", async () => {
  await git(checkout().repo, ["config", "http.proxy", "http://127.0.0.1:9"]);

  await assertSyncCreatesTheGithubBranchOnForgejo("release/next");
});

test("syncing branches leaves a Forgejo-only branch untouched", async () => {
  const pushed = await runForgeCapturing(["push-branch", "--branch", "add/feature"], dependencies, checkout().repo);
  assert.equal(pushed.exitCode, 0, pushed.stderr);
  const forgejoFeature = await git(forgejoCopy(), ["rev-parse", "refs/heads/add/feature"]);
  await git(checkout().repo, ["commit", "--no-gpg-sign", "-q", "--allow-empty", "-m", "local follow-up"]);
  await git(checkout().repo, ["update-ref", "refs/remotes/origin/add/feature", "add/feature"]);

  const { report } = await syncBranches();

  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/add/feature"]), forgejoFeature);
  assert.ok(!JSON.stringify(report).includes("add/feature"), JSON.stringify(report));
});

test("syncing branches reports an open pull request whose base it could not bring current", async () => {
  const number = await openPullRequest("add/feature", "main");
  await divergeMainBetweenGithubAndForgejo();

  const { report } = await syncBranches();

  assert.deepEqual(report.openPullRequestsNotCurrent, [{ number, base: "main", why: "diverged" }]);
});

test("syncing branches brings the bases of open pull requests current before the other branches", async () => {
  await branchOnGithub("release/next");
  await git(checkout().repo, ["fetch", "-q", "origin", "+refs/heads/release/next:refs/heads/release/next"]);
  await git(checkout().repo, ["checkout", "-q", "-b", "add/release-fix", "release/next"]);
  await git(checkout().repo, ["commit", "--no-gpg-sign", "-q", "--allow-empty", "-m", "fix the release"]);
  await openPullRequest("add/release-fix", "release/next");
  await commitInBareByHand(checkout().origin, "main", "merged on GitHub");
  await commitInBareByHand(checkout().origin, "release/next", "more release work");
  const recording = recordingGitCalls(dependencies);

  await syncBranches(recording);

  assert.deepEqual(pushedBranches(recording.gitCalls), ["release/next", "main"]);
});

test("syncing branches when nothing moved pushes nothing", async () => {
  await branchOnGithub("release/next");
  await syncBranches();
  const recording = recordingGitCalls(dependencies);

  const { report } = await syncBranches(recording);

  assert.deepEqual(pushedBranches(recording.gitCalls), []);
  assert.deepEqual([...report.current].sort(), ["main", "release/next"]);
});

test("syncing branches exits with a failure when a branch could not be pushed, and still reports every branch", async () => {
  await syncBranches();
  const refusingHook = path.join(forgejoCopy(), "hooks", "pre-receive");
  await writeFile(refusingHook, "#!/bin/sh\nif grep -q refs/heads/release/next; then echo 'release/next is refused here' >&2; exit 1; fi\n");
  await chmod(refusingHook, 0o755);
  await branchOnGithub("release/next");
  const githubHotfix = await branchOnGithub("hotfix/now");

  const synced = await runForgeCapturing(["sync-branches"], dependencies, checkout().repo);

  assert.equal(synced.exitCode, 1, synced.stderr);
  const report = JSON.parse(synced.stdout) as BranchSyncReport;
  assert.deepEqual(report.failed.map((failure) => failure.branch), ["release/next"]);
  assert.match(report.failed[0]!.reason, /release\/next is refused here/);
  assert.deepEqual(report.created, ["hotfix/now"]);
  assert.deepEqual(report.current, ["main"]);
  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/hotfix/now"]), githubHotfix);
});

test("the forge commands record the local checkout of each Forgejo copy", async () => {
  await syncBranches();
  const api = await openForgejoApiOnThisHost(dependencies);
  await api.sendJson("POST", "user/repos", { name: "made-by-hand", private: true });

  const copies = await forgejoCopiesWithCheckouts(api, dependencies);

  assert.deepEqual(
    copies.map((copy) => [`${copy.repository.owner}/${copy.repository.name}`, copy.checkout]).sort(),
    [
      [`${FAKE_FORGEJO_ADMIN}/made-by-hand`, undefined],
      [`${FAKE_FORGEJO_ADMIN}/staging-demo`, path.resolve(checkout().repo)],
    ],
  );
});
