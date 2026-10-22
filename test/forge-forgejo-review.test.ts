import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, test } from "node:test";
import type { ReviewFinding } from "../src/forge/forgejo-review.ts";
import { git } from "./git-repo-test-fixture.ts";
import {
  forgeJson,
  openForgejoDraftPullRequest,
  openGithubPullRequestToStage,
  promote,
  stagingDependencies,
  startStagingHostForEachTest,
  type StagingHost,
} from "./forge-staging-test-support.ts";
import { runForgeCapturing } from "./forge-test-support.ts";

interface ReviewResult {
  readonly reviewId: number;
  readonly reviewUrl: string;
  readonly copyCommentUrl: string;
  readonly head: string;
}

const FINDING_RECORD = "<!-- pr-review: finding -->";
const COPY_RECORD = "<!-- pr-review: copy -->";
const OVEN_FINDING: ReviewFinding = { path: "feature.txt", line: 2, body: "The second line never says which oven bakes the order." };
const REPEAT_FINDING: ReviewFinding = { path: "feature.txt", start_line: 1, line: 3, body: "These three lines repeat the same order." };
const LAST_LINE_FINDING: ReviewFinding = { path: "feature.txt", line: 3, body: "The third line drops the pickup time." };

let host: StagingHost;
let forgejoUrl: string;
let githubUrl: string;

const stagingHostForThisTest = startStagingHostForEachTest("forge-review-", async (prepared) => {
  forgejoUrl = await openForgejoDraftPullRequest(prepared);
  githubUrl = (await promote(prepared, forgejoUrl)).githubUrl;
});

beforeEach(() => {
  host = stagingHostForThisTest();
});

async function commentsFile(findings: readonly ReviewFinding[]): Promise<string> {
  const file = path.join(host.checkout.repo, `review-comments-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(file, JSON.stringify(findings));
  return file;
}

async function review(target: string, findings: readonly ReviewFinding[]): Promise<ReviewResult> {
  return forgeJson<ReviewResult>(host, ["pr", "review", target, "--comments-file", await commentsFile(findings)]);
}

async function exportedFindings(target: string): Promise<{ printed: { count: number; githubUrl: string }; findings: ReviewFinding[] }> {
  const out = path.join(host.checkout.repo, "exported-findings.json");
  const printed = await forgeJson<{ count: number; githubUrl: string }>(host, ["pr", "review-findings", target, "--out", out]);
  return { printed, findings: JSON.parse(await readFile(out, "utf8")) as ReviewFinding[] };
}

function copyPasteComments(): string[] {
  return host.forgejo.comments.filter((comment) => comment.body.includes(COPY_RECORD)).map((comment) => comment.body);
}

async function everythingOnGithub(): Promise<string> {
  const state = await host.github.read();
  const texts = state.pullRequests.flatMap((pull) => [
    pull.body,
    ...pull.threads.flatMap((thread) => thread.comments.map((comment) => comment.body)),
    ...pull.issueComments.map((comment) => comment.body),
    ...pull.reviews.map((entry) => entry.body),
  ]);
  return [...texts, ...state.calls.flat()].join("\n");
}

test("a review is posted on the Forgejo pull request as one comment review holding every finding", async () => {
  const result = await review(forgejoUrl, [OVEN_FINDING, REPEAT_FINDING]);

  assert.equal(host.forgejo.reviews.length, 1);
  const [posted] = host.forgejo.reviews;
  assert.equal(result.reviewId, posted!.id);
  assert.equal(result.reviewUrl, `${forgejoUrl}#pullrequestreview-${posted!.id}`);
  assert.equal(result.head, await git(host.checkout.repo, ["rev-parse", "add/feature"]));
  assert.deepEqual(
    host.forgejo.reviewComments.map(({ reviewId, path: filePath, position, body }) => ({ reviewId, filePath, position, body })),
    [
      { reviewId: posted!.id, filePath: "feature.txt", position: 2, body: `${OVEN_FINDING.body}\n\n${FINDING_RECORD}\n` },
      { reviewId: posted!.id, filePath: "feature.txt", position: 3, body: `${REPEAT_FINDING.body}\n\n${FINDING_RECORD}\n` },
    ],
  );
});

test("a review of a GitHub pull request staged in Forgejo lands on its Forgejo twin and writes nothing to GitHub", async () => {
  const before = await host.github.read();

  await review(githubUrl, [OVEN_FINDING]);

  assert.deepEqual(await host.github.read(), before);
  assert.deepEqual(
    host.forgejo.reviewComments.map((comment) => ({ number: comment.number, position: comment.position })),
    [{ number: host.forgejo.pullRequests[0]!.number, position: 2 }],
  );
});

test("a review of a GitHub pull request that is not staged is refused and names the stage command", async () => {
  const unstagedUrl = await openGithubPullRequestToStage(host);
  const commentsBefore = structuredClone(host.forgejo.comments);

  const refused = await runForgeCapturing(["pr", "review", unstagedUrl, "--comments-file", await commentsFile([OVEN_FINDING])], stagingDependencies, host.checkout.repo);

  assert.equal(refused.exitCode, 1);
  assert.ok(refused.stderr.includes(`throne forge stage ${unstagedUrl}`), refused.stderr);
  assert.deepEqual(host.forgejo.reviews, []);
  assert.deepEqual(host.forgejo.comments, commentsBefore);
});

test("the review leaves one copy-paste comment holding every finding under its file and line", async () => {
  const result = await review(forgejoUrl, [OVEN_FINDING, REPEAT_FINDING]);

  assert.deepEqual(copyPasteComments(), [
    `**\`feature.txt:2\`**\n\n${OVEN_FINDING.body}\n\n---\n\n**\`feature.txt:1-3\`**\n\n${REPEAT_FINDING.body}\n\n${COPY_RECORD}\n`,
  ]);
  const copyIndex = host.forgejo.comments.findIndex((comment) => comment.body.includes(COPY_RECORD));
  assert.equal(result.copyCommentUrl, `${forgejoUrl}#issuecomment-${copyIndex + 1}`);
});

test("reviewing again rewrites the copy-paste comment instead of adding a second one", async () => {
  const first = await review(forgejoUrl, [OVEN_FINDING]);

  const second = await review(forgejoUrl, [LAST_LINE_FINDING]);

  assert.deepEqual(copyPasteComments(), [`**\`feature.txt:3\`**\n\n${LAST_LINE_FINDING.body}\n\n${COPY_RECORD}\n`]);
  assert.equal(second.copyCommentUrl, first.copyCommentUrl);
});

test("promoting a pull request never carries the review or its copy-paste comment to GitHub", async () => {
  await review(forgejoUrl, [OVEN_FINDING, LAST_LINE_FINDING]);

  await promote(host, forgejoUrl);

  const onGithub = await everythingOnGithub();
  for (const text of [OVEN_FINDING.body, LAST_LINE_FINDING.body, "feature.txt:2", "pr-review"]) {
    assert.equal(onGithub.includes(text), false, `GitHub received ${text}`);
  }
});

test("the exported findings are the Forgejo review comments as the Lord left them", async () => {
  await review(forgejoUrl, [OVEN_FINDING]);
  await review(forgejoUrl, [OVEN_FINDING, REPEAT_FINDING, LAST_LINE_FINDING]);
  const latest = host.forgejo.reviews.at(-1)!.id;
  const [oven, repeat] = host.forgejo.reviewComments.filter((comment) => comment.reviewId === latest);
  const ovenIndex = host.forgejo.reviewComments.indexOf(oven!);
  host.forgejo.reviewComments[ovenIndex] = { ...oven!, body: `Name oven two on the second line.\n\n${FINDING_RECORD}\n` };
  host.forgejo.reviewComments.splice(host.forgejo.reviewComments.indexOf(repeat!), 1);

  const { printed, findings } = await exportedFindings(forgejoUrl);

  assert.deepEqual(printed, { count: 2, githubUrl });
  assert.deepEqual(findings, [
    { path: "feature.txt", line: 2, body: "Name oven two on the second line." },
    { path: "feature.txt", line: 3, body: LAST_LINE_FINDING.body },
  ]);
});

test("deleting every finding of the latest review exports nothing from an earlier review", async () => {
  await review(forgejoUrl, [OVEN_FINDING]);
  await review(forgejoUrl, [LAST_LINE_FINDING]);
  const latest = host.forgejo.reviews.at(-1)!.id;
  host.forgejo.reviewComments.splice(0, host.forgejo.reviewComments.length, ...host.forgejo.reviewComments.filter((comment) => comment.reviewId !== latest));
  const out = path.join(host.checkout.repo, "exported-findings.json");

  const refused = await runForgeCapturing(["pr", "review-findings", forgejoUrl, "--out", out], stagingDependencies, host.checkout.repo);

  assert.equal(refused.exitCode, 1, refused.stdout);
  await assert.rejects(readFile(out, "utf8"));
});

test("comments of a promoted review are not mirrored back into Forgejo as new feedback", async () => {
  await review(forgejoUrl, [OVEN_FINDING]);
  const { findings } = await exportedFindings(githubUrl);
  const state = await host.github.read();
  const pull = state.pullRequests[0]!;
  const at = "2026-10-19T10:00:00Z";
  pull.threads = [
    { id: "THREAD_FROM_THE_REVIEW", resolved: false, path: "feature.txt", line: 2, originalLine: 2, comments: [{ id: 501, author: "the-lord", body: findings[0]!.body, createdAt: at }] },
  ];
  pull.issueComments = [{ id: 502, author: "pastry-reviewer", body: "Could the button say Order?", createdAt: at }];
  await host.github.write(state);

  const mirror = await forgeJson<{ mirrored: string[] }>(host, ["mirror-feedback", githubUrl]);

  assert.deepEqual(mirror.mirrored, [`comment ${pull.number} 502`]);
  assert.equal(host.forgejo.reviewComments.length, 1);
});

