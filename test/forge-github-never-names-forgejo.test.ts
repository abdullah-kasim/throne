import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { runForgeCapturing, TEST_TAILNET_ADDRESS } from "./forge-test-support.ts";
import {
  answerFile,
  forge,
  forgeJson,
  openForgejoPullRequestWithMedia,
  openGithubPullRequestToStage,
  promote,
  stagingDependencies,
  startStagingHostForEachTest,
  type StagingHost,
} from "./forge-staging-test-support.ts";

const ANY_STAGING_RECORD = /<!-- (?:forgejo-twin|github-twin|github-feedback|forgejo-answer|forgejo-comment|staging-sync):/;

let host: StagingHost;
let forgejoUrl: string;
const stagingHostForThisTest = startStagingHostForEachTest("forge-github-unaware-", async (prepared) => {
  forgejoUrl = await openForgejoPullRequestWithMedia(prepared);
});

beforeEach(() => {
  host = stagingHostForThisTest();
});

async function everythingSentToGithub(): Promise<string> {
  const state = await host.github.read();
  const pullRequestText = state.pullRequests.flatMap((pull) => [
    pull.title,
    pull.body,
    ...pull.threads.flatMap((thread) => thread.comments.map((comment) => comment.body)),
    ...pull.issueComments.map((comment) => comment.body),
  ]);
  return [...pullRequestText, ...(await host.github.mutatingCalls()).flat()].join("\n");
}

function assertGithubKnowsNothingOfForgejo(sent: string): void {
  assert.doesNotMatch(sent, ANY_STAGING_RECORD);
  assert.doesNotMatch(sent, /forgejo/i);
  assert.doesNotMatch(sent, /\[GH-/);
  for (const name of [new URL(host.forgejo.rootUrl).host, new URL(host.forgejo.rootUrl).hostname, TEST_TAILNET_ADDRESS]) {
    assert.equal(sent.includes(name), false, `GitHub received the Forgejo host ${name}`);
  }
}

async function editForgejoBody(body: string): Promise<void> {
  const bodyFile = path.join(host.checkout.repo, `forgejo-body-${Date.now()}.md`);
  await writeFile(bodyFile, body);
  await forge(host, ["pr", "edit", forgejoUrl, "--body-file", bodyFile]);
}

async function withRecordsInTheForgejoBody(): Promise<void> {
  const body = host.forgejo.pullRequests[0]!.body;
  await editForgejoBody(`${body}\n<!-- forgejo-twin: staging-demo#1 -->\n<!-- github-twin: https://github.com/example/other/pull/9 -->\n`);
}

async function refusedGithubWrite(subcommand: string): Promise<void> {
  const githubUrl = await openGithubPullRequestToStage(host);
  const before = await host.github.read();
  const bodyFile = await answerFile(host, `See ${host.forgejo.rootUrl}court-admin/staging-demo/pulls/1 for the staged copy.\n<!-- forgejo-twin: staging-demo#1 -->\n`);

  const refused = await runForgeCapturing(["pr", subcommand, githubUrl, "--body-file", bodyFile], stagingDependencies, host.checkout.repo);

  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /names the Forgejo host, which must never reach GitHub/);
  assert.deepEqual(await host.github.mutatingCalls(), []);
  assert.deepEqual((await host.github.read()).pullRequests, before.pullRequests);
}

async function mirroredItemId(githubKey: string): Promise<number> {
  const items = await forgeJson<Array<{ id: number; githubKey: string | null }>>(host, ["pr", "feedback", forgejoUrl]);
  return items.find((item) => item.githubKey === githubKey)!.id;
}

test("a promoted GitHub body carries no Forgejo record or host", async () => {
  await withRecordsInTheForgejoBody();

  await promote(host, forgejoUrl);

  const [pull] = (await host.github.read()).pullRequests;
  assert.match(pull!.body, /^## Summary\n\nAdds the feature\.\n/);
  assertGithubKnowsNothingOfForgejo(await everythingSentToGithub());
});

test("a repromoted GitHub body carries no Forgejo record or host", async () => {
  await promote(host, forgejoUrl);
  await withRecordsInTheForgejoBody();

  await promote(host, forgejoUrl);

  const editCalls = (await host.github.mutatingCalls()).filter((call) => call.includes("edit"));
  assert.ok(editCalls.length >= 1);
  assertGithubKnowsNothingOfForgejo(await everythingSentToGithub());
});

test("answers carried back to GitHub carry no Forgejo record or host", async () => {
  const { githubUrl } = await promote(host, forgejoUrl);
  const state = await host.github.read();
  const pull = state.pullRequests[0]!;
  const asked = { author: "pastry-reviewer", createdAt: "2026-10-07T10:01:00Z" };
  pull.threads = [
    { id: "THREAD_ON_LINE_TWO", resolved: false, path: "feature.txt", line: 2, originalLine: 2, comments: [{ id: 201, body: "Which oven?", ...asked }] },
  ];
  pull.issueComments = [{ id: 301, body: "Could the button say Order?", ...asked }];
  await host.github.write(state);
  await forge(host, ["mirror-feedback", githubUrl]);
  const threadAnswer = await answerFile(host, "The line now names the oven.");
  const conversationAnswer = await answerFile(host, "Renamed the button to Order.");
  await forge(host, ["pr", "answer", forgejoUrl, "--comment", String(await mirroredItemId("thread 7 201")), "--body-file", threadAnswer, "--resolve"]);
  await forge(host, ["pr", "answer", forgejoUrl, "--comment", String(await mirroredItemId("comment 7 301")), "--body-file", conversationAnswer]);

  const repromoted = await promote(host, forgejoUrl);

  const after = (await host.github.read()).pullRequests[0]!;
  assert.equal(repromoted.answers.replied.length, 2);
  assert.deepEqual(after.threads[0]!.comments.map((comment) => comment.body), ["Which oven?", "The line now names the oven."]);
  assert.deepEqual(after.issueComments.map((comment) => comment.body), ["Could the button say Order?", "Renamed the button to Order."]);
  assertGithubKnowsNothingOfForgejo(await everythingSentToGithub());
});

test("GitHub-bound text that still names a Forgejo host is refused", async () => {
  await editForgejoBody(`See ${host.forgejo.rootUrl}court-admin/staging-demo/commit/abc123 for the earlier attempt.\n`);

  const namingHost = await runForgeCapturing(["promote", forgejoUrl], stagingDependencies, host.checkout.repo);

  assert.equal(namingHost.exitCode, 1);
  assert.match(namingHost.stderr, /names the Forgejo host, which must never reach GitHub/);
  assert.deepEqual(await host.github.mutatingCalls(), []);

  await editForgejoBody("Adds the feature.\n<!-- forgejo-twin: staging-demo#1 > left over -->\n");

  const holdingRecord = await runForgeCapturing(["promote", forgejoUrl], stagingDependencies, host.checkout.repo);

  assert.equal(holdingRecord.exitCode, 1);
  assert.match(holdingRecord.stderr, /holds a staging record that could not be removed, which must never reach GitHub/);
  assert.deepEqual(await host.github.mutatingCalls(), []);
});

test("editing a GitHub pull request body through the forge on a Forgejo host strips staging records before sending it", async () => {
  const githubUrl = await openGithubPullRequestToStage(host);
  const bodyFile = await answerFile(
    host,
    '## Summary\n\nAdds the feature.\n\n<!-- forgejo-twin: staging-demo#1 -->\n<!-- staging-sync: {"promotedHead":null,"carriedAnswers":[]} -->\n',
  );

  await forge(host, ["pr", "edit", githubUrl, "--body-file", bodyFile]);

  const edited = (await host.github.read()).pullRequests.find((pull) => pull.url === githubUrl)!;
  assert.equal(edited.body, "## Summary\n\nAdds the feature.\n");
  assert.equal((await host.github.mutatingCalls()).length, 1);
  assertGithubKnowsNothingOfForgejo(await everythingSentToGithub());
});

test("editing a GitHub pull request body that names the Forgejo host is refused with nothing sent to GitHub", async () => {
  await refusedGithubWrite("edit");
});

test("commenting on a GitHub pull request that names the Forgejo host is refused with nothing sent to GitHub", async () => {
  await refusedGithubWrite("comment");
});
