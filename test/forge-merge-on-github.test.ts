import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_GITHUB_REPOSITORY } from "./forge-fake-github.ts";
import { runForgeCapturing } from "./forge-test-support.ts";
import { forge, forgeJson, promote, stagingDependencies, startStagingHost, type StagingHost } from "./forge-staging-test-support.ts";

interface StackToMerge {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly root: number;
  readonly forgejoTwin?: string;
}

interface StackScript {
  discoverStackToMerge(url: string, runSeam: (args: readonly string[]) => Promise<string>): Promise<StackToMerge>;
}

const SKILLS_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude", "skills");
const stackScript = (await import(path.join(SKILLS_DIRECTORY, "pr-merge", "stack.mjs"))) as StackScript;
const GITHUB_PULL_REQUEST_URL = `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/7`;

let host: StagingHost;

before(async () => {
  await import("../src/forge/forge.command.ts");
});

beforeEach(async () => {
  host = await startStagingHost("forge-merge-on-github-");
});

afterEach(async () => {
  await host.remove();
});

async function openAndPromoteForgejoPullRequest(): Promise<{ readonly forgejoUrl: string; readonly githubUrl: string }> {
  const bodyFile = path.join(host.checkout.repo, "pr-body.md");
  await writeFile(bodyFile, "## Summary\n\nAdds the feature.\n");
  const forgejoUrl = (
    await forge(host, ["pr", "create", "--base", "main", "--head", "add/feature", "--title", "Add the feature", "--body-file", bodyFile])
  ).trim();
  const promotion = await promote(host, forgejoUrl);
  return { forgejoUrl, githubUrl: promotion.githubUrl };
}

async function mergeOnGithubDirectly(githubUrl: string): Promise<void> {
  const state = await host.github.read();
  state.pullRequests.find((pullRequest) => pullRequest.url === githubUrl)!.state = "MERGED";
  await host.github.write(state);
}

async function closeCommandNamedByTheMergeSkill(rootUrl: string): Promise<string[]> {
  const skill = await readFile(path.join(SKILLS_DIRECTORY, "pr-merge", "SKILL.md"), "utf8");
  const command = /throne forge (close-merged-twin <root url>)/.exec(skill);
  assert.ok(command, "the merge skill names the command that closes the Forgejo twin");
  return command[1]!.replace("<root url>", rootUrl).split(" ");
}

function mergedOnGithubMessages(): string[] {
  return host.forgejo.comments.map((comment) => comment.body).filter((body) => body.includes("merged on the GitHub side"));
}

const runSeamInProcess = async (args: readonly string[]): Promise<string> => forge(host, args);

test("merging a staged pull request merges it on GitHub", async () => {
  const { forgejoUrl, githubUrl } = await openAndPromoteForgejoPullRequest();

  for (const handedUrl of [forgejoUrl, githubUrl]) {
    const stack = await stackScript.discoverStackToMerge(handedUrl, runSeamInProcess);
    assert.deepEqual(
      [stack.host, `${stack.owner}/${stack.repo}`, stack.root, stack.forgejoTwin],
      ["github.com", FAKE_GITHUB_REPOSITORY, 7, forgejoUrl],
    );
  }
  await forge(host, ["pr", "merge", githubUrl, "--squash", "--bypass"]);

  assert.equal(githubUrl, GITHUB_PULL_REQUEST_URL);
  assert.equal((await host.github.read()).pullRequests[0]!.state, "MERGED");
  assert.deepEqual((await host.github.read()).calls.filter((call) => call.includes("merge")), [
    ["--bypass", "pr", "merge", githubUrl, "--squash", "--delete-branch=false"],
  ]);
  assert.deepEqual(host.forgejo.merges, []);
  assert.equal(host.forgejo.pullRequests[0]!.merged, false);
});

test("merging a staged pull request on GitHub closes its Forgejo pull request with a message saying it was merged on GitHub", async () => {
  const { githubUrl } = await openAndPromoteForgejoPullRequest();
  const closeCommand = await closeCommandNamedByTheMergeSkill(githubUrl);

  const beforeTheMerge = await runForgeCapturing(closeCommand, stagingDependencies, host.checkout.repo);
  assert.equal(beforeTheMerge.exitCode, 1);
  assert.match(beforeTheMerge.stderr, /is not merged on GitHub, so its Forgejo pull request .* stays open/);
  assert.equal(host.forgejo.pullRequests[0]!.state, "open");

  await forge(host, ["pr", "merge", githubUrl, "--squash", "--bypass"]);
  const githubCallsBeforeClosing = (await host.github.mutatingCalls()).length;
  const closing = await forgeJson<{ closed: boolean; githubUrl: string }>(host, closeCommand);

  assert.deepEqual([closing.closed, closing.githubUrl], [true, githubUrl]);
  assert.deepEqual([host.forgejo.pullRequests[0]!.state, host.forgejo.pullRequests[0]!.merged], ["closed", false]);
  assert.deepEqual(mergedOnGithubMessages(), [`This pull request has been merged on the GitHub side: ${githubUrl}`]);
  assert.deepEqual(host.forgejo.merges, []);
  assert.equal((await host.github.mutatingCalls()).length, githubCallsBeforeClosing);
});

test("promoting a pull request whose GitHub twin was already merged closes the Forgejo pull request instead of promoting again", async () => {
  const { forgejoUrl, githubUrl } = await openAndPromoteForgejoPullRequest();
  await mergeOnGithubDirectly(githubUrl);
  const originHeadBefore = await git(host.checkout.origin, ["rev-parse", "refs/heads/add/feature"]);
  await writeFile(path.join(host.checkout.repo, "late-change.txt"), "late change\n");
  await git(host.checkout.repo, ["add", "late-change.txt"]);
  await git(host.checkout.repo, ["commit", "--no-gpg-sign", "-q", "-m", "late change"]);
  const githubCallsBefore = (await host.github.mutatingCalls()).length;

  const promotion = await promote(host, forgejoUrl);

  assert.deepEqual(promotion, {
    forgejoUrl,
    githubUrl,
    created: false,
    mergedOnGithub: true,
    answers: { replied: [], resolved: [] },
  });
  assert.deepEqual([host.forgejo.pullRequests[0]!.state, host.forgejo.pullRequests[0]!.merged], ["closed", false]);
  assert.deepEqual(mergedOnGithubMessages(), [`This pull request has been merged on the GitHub side: ${githubUrl}`]);
  assert.equal(await git(host.checkout.origin, ["rev-parse", "refs/heads/add/feature"]), originHeadBefore);
  assert.equal((await host.github.mutatingCalls()).length, githubCallsBefore);
  assert.equal((await host.github.read()).pullRequests.length, 1);
});

test("closing a Forgejo twin twice adds one message", async () => {
  const { forgejoUrl, githubUrl } = await openAndPromoteForgejoPullRequest();
  await mergeOnGithubDirectly(githubUrl);

  const first = await forgeJson<{ closed: boolean }>(host, ["close-merged-twin", githubUrl]);
  const second = await forgeJson<{ closed: boolean }>(host, ["close-merged-twin", forgejoUrl]);
  const promotedAgain = await promote(host, forgejoUrl);

  assert.deepEqual([first.closed, second.closed], [true, false]);
  assert.equal(promotedAgain.created, false);
  assert.deepEqual(mergedOnGithubMessages(), [`This pull request has been merged on the GitHub side: ${githubUrl}`]);
  assert.equal(host.forgejo.pullRequests[0]!.state, "closed");
});
