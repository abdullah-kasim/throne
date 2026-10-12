import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { openForgejoApi } from "../src/forge/forgejo-api.ts";
import type { PullRequestStatus } from "../src/forge/pull-request-status.ts";
import { writeStagingMetadataComment } from "../src/forge/staging-metadata.ts";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_FORGEJO_ADMIN } from "./forge-fake-forgejo.ts";
import type { FakeGithubPullRequest } from "./forge-fake-github.ts";
import {
  forge,
  forgeJson,
  openGithubPullRequestToStage,
  stagingDependencies,
  startStagingHost,
  type StagingHost,
} from "./forge-staging-test-support.ts";
import { forgeDependenciesWithFakeGithub, runForgeCapturing, useFreshForgejoStateDirectory } from "./forge-test-support.ts";

const FORGEJO_REPOSITORY = `${FAKE_FORGEJO_ADMIN}/staging-demo`;
const NEVER_PROMOTED_REFUSAL = "is not on GitHub yet: it has no metadata comment linking a GitHub pull request (it was never staged or promoted)";

let host: StagingHost;
let featureSha: string;

before(async () => {
  host = await startStagingHost("forge-status-");
  await forge(host, ["push-branch", "--branch", "add/feature"]);
  featureSha = await git(host.checkout.repo, ["rev-parse", "add/feature"]);
});

after(async () => {
  await host.remove();
});

function addForgejoPullRequest(state = "open"): string {
  const number = host.forgejo.pullRequests.length + 1;
  const url = `${host.forgejo.rootUrl}${FORGEJO_REPOSITORY}/pulls/${number}`;
  host.forgejo.pullRequests.push({
    number,
    html_url: url,
    title: "Add the feature",
    body: "Adds the feature.\n",
    state,
    merged: false,
    head: { ref: "add/feature" },
    base: { ref: "main" },
    repository: FORGEJO_REPOSITORY,
  });
  return url;
}

async function linkToGithub(forgejoUrl: string, githubUrl: string): Promise<void> {
  const api = await openForgejoApi(host.forgejo.rootUrl, stagingDependencies);
  const number = Number(forgejoUrl.split("/").pop());
  await writeStagingMetadataComment({ repository: { owner: FAKE_FORGEJO_ADMIN, name: "staging-demo" }, number }, githubUrl, {}, api);
}

async function stagedPair(githubFields: Partial<FakeGithubPullRequest> = {}): Promise<{ forgejoUrl: string; githubUrl: string }> {
  const forgejoUrl = addForgejoPullRequest();
  const githubUrl = await openGithubPullRequestToStage(host, { headSha: featureSha, ...githubFields });
  await linkToGithub(forgejoUrl, githubUrl);
  return { forgejoUrl, githubUrl };
}

function status(target: string): Promise<PullRequestStatus> {
  return forgeJson<PullRequestStatus>(host, ["status", target, "--json"]);
}

test("a Forgejo pull request that was never promoted is forgejo-only", async () => {
  const forgejoUrl = addForgejoPullRequest();

  const found = await status(forgejoUrl);

  assert.equal(found.stage, "forgejo-only");
  assert.equal(found.hostForge, "forgejo");
  assert.equal(found.github, null);
  assert.deepEqual(found.forgejo, {
    url: forgejoUrl,
    number: Number(forgejoUrl.split("/").pop()),
    state: "OPEN",
    draft: false,
    base: "main",
    head: "add/feature",
    headSha: featureSha,
  });
  assert.deepEqual(found.target, {
    asked: forgejoUrl,
    kind: "forgejo-url",
    resolvedOn: "forgejo",
    how: "read the Forgejo pull request at that URL, and its GitHub twin through its metadata comment",
  });
});

test("a Forgejo pull request with an open GitHub twin is promoted, and its GitHub URL reports the same stage", async () => {
  const { forgejoUrl, githubUrl } = await stagedPair();
  const mutatingCallsBefore = await host.github.mutatingCalls();
  const commentsBefore = host.forgejo.comments.length;

  const fromForgejo = await status(forgejoUrl);
  const fromGithub = await status(githubUrl);

  for (const found of [fromForgejo, fromGithub]) {
    assert.equal(found.stage, "promoted");
    assert.equal(found.forgejo?.url, forgejoUrl);
    assert.equal(found.github?.url, githubUrl);
    assert.deepEqual(found.mergeTarget, { url: githubUrl, program: "gh", forgejoUrl });
    assert.equal(found.mergeTargetRefusal, null);
  }
  assert.equal(fromGithub.target.kind, "github-url");
  assert.equal(fromGithub.target.resolvedOn, "github");
  assert.deepEqual(await host.github.mutatingCalls(), mutatingCallsBefore);
  assert.equal(host.forgejo.comments.length, commentsBefore);
});

test("a GitHub pull request that was never staged is github-only", async () => {
  const githubUrl = await openGithubPullRequestToStage(host, { headSha: featureSha });

  const found = await status(githubUrl);

  assert.equal(found.stage, "github-only");
  assert.equal(found.forgejo, null);
  assert.equal(found.inSync, null);
  assert.equal(found.publishTo, "github");
  assert.deepEqual(found.mergeTarget, { url: githubUrl, program: "gh", forgejoUrl: null });
});

test("a pull request merged on GitHub reports merged-on-github with its merge commit", async () => {
  const mergeCommit = "4f1c2a9b7e0d3f5a6c8b1e2d4f6a8c0e2b4d6f8a";
  const { forgejoUrl, githubUrl } = await stagedPair({ state: "MERGED", mergedAt: "2026-10-08T09:00:00Z", mergeCommit });

  const found = await status(forgejoUrl);

  assert.equal(found.stage, "merged-on-github");
  assert.equal(found.github?.url, githubUrl);
  assert.equal(found.github?.mergeCommit, mergeCommit);
  assert.equal(found.github?.mergedAt, "2026-10-08T09:00:00Z");
});

test("a closed pull request reports closed", async () => {
  const closedOnGithub = await stagedPair({ state: "CLOSED" });
  const closedInForgejo = addForgejoPullRequest("closed");

  assert.equal((await status(closedOnGithub.forgejoUrl)).stage, "closed");
  assert.equal((await status(closedInForgejo)).stage, "closed");
});

test("a GitHub URL that has a Forgejo twin publishes to GitHub", async () => {
  const { forgejoUrl, githubUrl } = await stagedPair();

  const found = await status(githubUrl);

  assert.equal(found.forgejo?.url, forgejoUrl);
  assert.equal(found.publishTo, "github");
});

test("a Forgejo URL publishes to Forgejo", async () => {
  const { forgejoUrl } = await stagedPair();

  assert.equal((await status(forgejoUrl)).publishTo, "forgejo");
});

test("a bare number finds the Forgejo pull request first and falls back to GitHub when Forgejo has none", async () => {
  const forgejoUrl = addForgejoPullRequest();
  const forgejoNumber = forgejoUrl.split("/").pop()!;
  const githubUrl = await openGithubPullRequestToStage(host, { head: "only/on-github", headSha: featureSha });
  const githubNumber = githubUrl.split("/").pop()!;

  const onForgejo = await status(forgejoNumber);
  const onGithub = await status(githubNumber);
  const nowhere = await runForgeCapturing(["status", "999", "--json"], stagingDependencies, host.checkout.repo);

  assert.equal(onForgejo.forgejo?.url, forgejoUrl);
  assert.deepEqual(onForgejo.target, {
    asked: forgejoNumber,
    kind: "number",
    resolvedOn: "forgejo",
    how: `found ${forgejoNumber} in this checkout's Forgejo copy, the host forge`,
  });
  assert.equal(onForgejo.publishTo, "forgejo");
  assert.equal(onGithub.github?.url, githubUrl);
  assert.equal(onGithub.target.resolvedOn, "github");
  assert.equal(
    onGithub.target.how,
    `this checkout's Forgejo copy has no such pull request, so ${githubNumber} was read from this checkout's GitHub repository with gh`,
  );
  assert.equal(onGithub.publishTo, "github");
  assert.equal(nowhere.exitCode, 1);
  assert.match(nowhere.stderr, /no pull request 999 was found: this checkout's Forgejo copy has no such pull request; gh could not read 999/);
});

test("a branch name finds its pull request", async () => {
  const githubUrl = await openGithubPullRequestToStage(host, { head: "branch/on-github", headSha: featureSha });

  const onForgejo = await status("add/feature");
  const onGithub = await status("branch/on-github");

  assert.equal(onForgejo.target.kind, "branch");
  assert.equal(onForgejo.forgejo?.head, "add/feature");
  assert.equal(onGithub.target.resolvedOn, "github");
  assert.equal(onGithub.github?.url, githubUrl);
});

test("the merge target of a never-promoted pull request is null with the refusal the old command gave", async () => {
  const forgejoUrl = addForgejoPullRequest();

  const found = await status(forgejoUrl);

  assert.equal(found.mergeTarget, null);
  assert.equal(
    found.mergeTargetRefusal,
    `${forgejoUrl} ${NEVER_PROMOTED_REFUSAL}, and nothing is merged in Forgejo. It must be promoted first with /pr-promote on the Lord's word.`,
  );
});

test("the head shas say whether the two copies are in sync", async () => {
  const inSync = await stagedPair({ headSha: featureSha });
  const behind = await stagedPair({ headSha: "0000000000000000000000000000000000000001" });

  assert.equal((await status(inSync.githubUrl)).inSync, true);
  assert.equal((await status(behind.githubUrl)).inSync, false);
});

test("plain status prints every fact as a key and value line", async () => {
  const { forgejoUrl, githubUrl } = await stagedPair();

  const printed = await forge(host, ["status", forgejoUrl]);

  assert.match(printed, /^stage: promoted$/m);
  assert.match(printed, new RegExp(`^github\\.url: ${githubUrl}$`, "m"));
  assert.match(printed, new RegExp(`^forgejo\\.headSha: ${featureSha}$`, "m"));
  assert.match(printed, /^mergeTargetRefusal: none$/m);
  assert.match(printed, /^inSync: true$/m);
});

test("an enterprise GitHub URL on a host without Forgejo is read with ghe and looks for no Forgejo twin", async () => {
  const state = await useFreshForgejoStateDirectory();
  const directory = await mkdtemp(path.join(tmpdir(), "forge-status-no-forgejo-"));
  const enterpriseUrl = "https://github.example-corp.test/team/service/pull/12";
  const answer = { number: 12, url: enterpriseUrl, state: "OPEN", isDraft: false, headRefName: "fix", baseRefName: "trunk", headRefOid: "abc123", mergedAt: null, mergeCommit: null };
  const dependencies = forgeDependenciesWithFakeGithub(() => ({ exitCode: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: "" }));
  try {
    const result = await runForgeCapturing(["status", enterpriseUrl, "--json"], dependencies, directory);
    const found = JSON.parse(result.stdout) as PullRequestStatus;

    assert.equal(found.hostForge, "github");
    assert.equal(found.stage, "github-only");
    assert.equal(found.target.how, "read the GitHub pull request at that URL with ghe, and looked for its Forgejo twin nowhere, because this host has no Forgejo");
    assert.deepEqual(found.mergeTarget, { url: enterpriseUrl, program: "ghe", forgejoUrl: null });
    assert.deepEqual(
      dependencies.githubCalls.map((call) => [call.program, ...call.args]),
      [["ghe", "pr", "view", enterpriseUrl, "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid,mergedAt,mergeCommit"]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await state.remove();
  }
});

test("which and merge-target are no longer forge operations", async () => {
  for (const args of [["which", "--json"], ["merge-target", "1"]]) {
    const result = await runForgeCapturing(args, stagingDependencies, host.checkout.repo);

    assert.equal(result.exitCode, 2, args.join(" "));
    assert.match(result.stderr, new RegExp(`unknown operation "${args[0]}"`));
    assert.doesNotMatch(result.stderr, /^\s+(which|merge-target) /m);
  }
});
