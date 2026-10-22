import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, test } from "node:test";
import type { PullRequestStatus } from "../src/forge/pull-request-status.ts";
import { git } from "./git-repo-test-fixture.ts";
import { forge, forgeJson, openForgejoDraftPullRequest, promote, startStagingHostForEachTest, writeInRepo, type StagingHost } from "./forge-staging-test-support.ts";

const FEATURE_BRANCH = "add/feature";
const stagingHostForThisTest = startStagingHostForEachTest("forge-self-review-");
let host: StagingHost;

beforeEach(async () => {
  host = stagingHostForThisTest();
});

function featureHead(): Promise<string> {
  return git(host.checkout.repo, ["rev-parse", FEATURE_BRANCH]);
}

async function recordSelfReview(forgejoUrl: string): Promise<string> {
  const head = await featureHead();
  await forge(host, ["pr", "self-reviewed", forgejoUrl, "--head", head]);
  return head;
}

async function selfReviewOf(forgejoUrl: string): Promise<PullRequestStatus["selfReview"]> {
  return (await forgeJson<PullRequestStatus>(host, ["status", forgejoUrl, "--json"])).selfReview;
}

async function commitFile(branch: string, name: string, content: string): Promise<void> {
  await git(host.checkout.repo, ["checkout", "-q", branch]);
  await writeFile(path.join(host.checkout.repo, name), content);
  await git(host.checkout.repo, ["add", name]);
  await git(host.checkout.repo, ["commit", "--no-gpg-sign", "-q", "-m", `change ${name} on ${branch}`]);
}

async function advanceDefaultBranch(name: string, content: string): Promise<void> {
  await commitFile("main", name, content);
  await git(host.checkout.repo, ["push", "-q", "origin", "main"]);
  await git(host.checkout.repo, ["checkout", "-q", FEATURE_BRANCH]);
}

async function mergeDefaultBranchIntoFeature(): Promise<void> {
  await git(host.checkout.repo, ["merge", "--no-edit", "--no-gpg-sign", "-q", "origin/main"]);
}

async function pushFeature(): Promise<void> {
  await forge(host, ["push-branch", "--branch", FEATURE_BRANCH]);
}

function forgejoBody(): string {
  return host.forgejo.pullRequests[0]!.body;
}

function assertForgejoBodyRecords(bodyBefore: string, head: string): void {
  assert.equal(forgejoBody(), `${bodyBefore}\n\n<!-- self-review: ${head} -->\n`);
}

async function assertGithubBodyHoldsNoSelfReview(): Promise<void> {
  const githubBody = (await host.github.read()).pullRequests[0]!.body;
  assert.doesNotMatch(githubBody, /self-review/);
  assert.equal(githubBody.includes(host.forgejo.rootUrl), false);
}

test("recording a self-review posts no comment and no review on the Forgejo pull request", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  await promote(host, forgejoUrl);
  const commentsBefore = structuredClone(host.forgejo.comments);

  await recordSelfReview(forgejoUrl);

  assert.deepEqual(host.forgejo.comments, commentsBefore);
  assert.deepEqual(host.forgejo.reviews, []);
});

test("a self-review's head is recorded on the Forgejo pull request and read back by status", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const bodyBefore = forgejoBody();

  const head = await recordSelfReview(forgejoUrl);

  assert.equal((await selfReviewOf(forgejoUrl)).reviewedHead, head);
  assertForgejoBodyRecords(bodyBefore, head);
});

test("a later self-review replaces the earlier record in the Forgejo body", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const bodyBefore = forgejoBody();
  await recordSelfReview(forgejoUrl);
  await commitFile(FEATURE_BRANCH, "feature.txt", "fixed\n");
  await pushFeature();

  const head = await recordSelfReview(forgejoUrl);

  assertForgejoBodyRecords(bodyBefore, head);
});

test("rewriting the Forgejo pull request body keeps the self-review record", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const head = await recordSelfReview(forgejoUrl);
  const rewrittenBody = "## Summary\n\nRewritten.\n";

  await forge(host, ["pr", "edit", forgejoUrl, "--body-file", await writeInRepo(host, "rewritten-body.md", rewrittenBody)]);

  assertForgejoBodyRecords(rewrittenBody, head);
});

test("promoting a self-reviewed pull request never carries the self-review record to GitHub", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  await recordSelfReview(forgejoUrl);

  await promote(host, forgejoUrl);
  await assertGithubBodyHoldsNoSelfReview();
  await promote(host, forgejoUrl);
  await assertGithubBodyHoldsNoSelfReview();
});

test("the recorded self-review head survives promoting the pull request", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  await promote(host, forgejoUrl);
  const head = await recordSelfReview(forgejoUrl);

  await promote(host, forgejoUrl);

  assert.deepEqual(await selfReviewOf(forgejoUrl), { reviewedHead: head, coversHead: true });
});

test("a self-review recorded before the first promote is still there after it", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const head = await recordSelfReview(forgejoUrl);

  await promote(host, forgejoUrl);

  assert.deepEqual(await selfReviewOf(forgejoUrl), { reviewedHead: head, coversHead: true });
});

test("the self-review covers the head when nothing was committed since it", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const head = await recordSelfReview(forgejoUrl);

  assert.deepEqual(await selfReviewOf(forgejoUrl), { reviewedHead: head, coversHead: true });
});

test("the self-review still covers the head after a clean merge of the default branch", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const reviewedHead = await recordSelfReview(forgejoUrl);
  await advanceDefaultBranch("unrelated.txt", "from main\n");
  await mergeDefaultBranchIntoFeature();
  await pushFeature();

  const selfReview = await selfReviewOf(forgejoUrl);

  assert.notEqual(await featureHead(), reviewedHead);
  assert.deepEqual(selfReview, { reviewedHead, coversHead: true });
});

test("a merge whose conflict was resolved by hand needs a new self-review", async () => {
  await commitFile(FEATURE_BRANCH, "base.txt", "from the feature\n");
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const reviewedHead = await recordSelfReview(forgejoUrl);
  await advanceDefaultBranch("base.txt", "from main\n");
  await assert.rejects(mergeDefaultBranchIntoFeature());
  await writeFile(path.join(host.checkout.repo, "base.txt"), "resolved by hand\n");
  await git(host.checkout.repo, ["add", "base.txt"]);
  await git(host.checkout.repo, ["commit", "--no-gpg-sign", "-q", "--no-edit"]);
  await pushFeature();

  assert.deepEqual(await selfReviewOf(forgejoUrl), { reviewedHead, coversHead: false });
});

test("a fix committed after the self-review needs a new self-review", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);
  const reviewedHead = await recordSelfReview(forgejoUrl);
  await commitFile(FEATURE_BRANCH, "feature.txt", "fixed\n");
  await pushFeature();

  assert.deepEqual(await selfReviewOf(forgejoUrl), { reviewedHead, coversHead: false });
});

test("a pull request never self-reviewed needs a self-review", async () => {
  const forgejoUrl = await openForgejoDraftPullRequest(host);

  assert.deepEqual(await selfReviewOf(forgejoUrl), { reviewedHead: null, coversHead: false });
});
