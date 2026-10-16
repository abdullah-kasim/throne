import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, test } from "node:test";
import { githubTwinIn, stagingSyncIn } from "../src/forge/staging-records.ts";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_GITHUB_REPOSITORY, type FakeGithubComment, type FakeGithubThread } from "./forge-fake-github.ts";
import {
  answerFile,
  forge,
  forgeJson,
  openForgejoPullRequestWithMedia,
  promote,
  stagingDependencies,
  startStagingHostForEachTest,
  type StagingHost,
} from "./forge-staging-test-support.ts";
import { runForgeCapturing } from "./forge-test-support.ts";
import { installPinnedNode } from "./pinned-node.support.ts";

interface FeedbackItem {
  readonly id: number;
  readonly kind: string;
  readonly place: { readonly path: string; readonly line: number; readonly onOldSide: boolean } | null;
  readonly reviewId: number | null;
  readonly resolved: boolean;
  readonly body: string;
  readonly githubKey: string | null;
  readonly answers: number | null;
}

interface PendingReviewScript {
  readonly forgejoHasNoPendingReview: string;
  leavePendingReview(
    url: string,
    commentsPath: string,
    flags: readonly string[],
    options: {
      readonly runSeam: (args: readonly string[]) => Promise<string>;
      readonly runGithub: (program: string, args: readonly string[]) => string;
      readonly writeOutput: (text: string) => void;
    },
  ): Promise<void>;
}

const SKILLS_DIRECTORY = path.join(import.meta.dirname, "..", ".claude", "skills");
const THREADS_SCRIPT = path.join(SKILLS_DIRECTORY, "pr-address-feedback", "threads.mjs");
const pendingReviewScript = (await import(path.join(SKILLS_DIRECTORY, "pr-review", "pending-review.mjs"))) as PendingReviewScript;

let host: StagingHost;
let forgejoUrl: string;
let githubUrl: string;

const at = (minute: number) => `2026-10-07T10:${String(minute).padStart(2, "0")}:00Z`;
const comment = (id: number, author: string, body: string, minute: number): FakeGithubComment => ({ id, author, body, createdAt: at(minute) });
const thread = (id: string, line: number | null, originalLine: number, comments: FakeGithubComment[], resolved = false): FakeGithubThread => ({
  id,
  resolved,
  path: "feature.txt",
  line,
  originalLine,
  comments,
});

const stagingHostForThisTest = startStagingHostForEachTest("forge-staged-", async (prepared) => {
  forgejoUrl = await openForgejoPullRequestWithMedia(prepared);
  githubUrl = (await promote(prepared, forgejoUrl)).githubUrl;
  const state = await prepared.github.read();
  const pull = state.pullRequests[0]!;
  pull.threads = [
    thread("THREAD_ON_LINE_TWO", 2, 2, [comment(201, "pastry-reviewer", "The second line should say which oven.", 1)]),
    thread("THREAD_ON_A_GONE_LINE", null, 40, [comment(202, "pastry-reviewer", "This loop sends the order email twice.", 2)]),
    thread("THREAD_ALREADY_SETTLED", 1, 1, [comment(203, "pastry-reviewer", "Typo in the first line.", 3)], true),
  ];
  pull.issueComments = [
    comment(301, "pastry-reviewer", "Could the button say Order instead of Pay?", 4),
    comment(302, "review-bot[bot]", "Finding: the discount total can go negative. (first report)", 5),
    comment(303, "review-bot[bot]", "Finding: the pickup date is parsed without a time zone. (latest report)", 6),
  ];
  pull.reviews = [{ ...comment(401, "head-baker", "Two queries here could be one.", 7), state: "COMMENTED" }];
  await prepared.github.write(state);
});

beforeEach(() => {
  host = stagingHostForThisTest();
});

async function feedback(target: string): Promise<FeedbackItem[]> {
  return forgeJson<FeedbackItem[]>(host, ["pr", "feedback", target]);
}

async function mirroredItem(key: string): Promise<FeedbackItem> {
  return (await feedback(forgejoUrl)).find((item) => item.githubKey === key)!;
}

async function answer(itemId: number, text: string, resolve: boolean): Promise<void> {
  await forge(host, ["pr", "answer", githubUrl, "--comment", String(itemId), "--body-file", await answerFile(host, text), ...(resolve ? ["--resolve"] : [])]);
}

async function pushFixCommit(): Promise<void> {
  await writeFile(path.join(host.checkout.repo, "feature.txt"), "first line\nsecond line, baked in oven two\nthird line\n");
  await git(host.checkout.repo, ["commit", "--no-gpg-sign", "-q", "-am", "name the oven"]);
  await forge(host, ["push-branch", "--branch", "add/feature"]);
}

test("a promoted GitHub pull request is worked on through its Forgejo twin", async () => {
  const status = await forgeJson<{ stage: string; forgejo: { url: string } }>(host, ["status", githubUrl, "--json"]);
  const viewed = await forgeJson<{ url: string; title: string }>(host, ["pr", "view", githubUrl]);
  const newBody = path.join(host.checkout.repo, "edited.md");
  await writeFile(newBody, "Edited through the GitHub URL.\n");
  await forge(host, ["pr", "edit", githubUrl, "--body-file", newBody]);

  assert.equal(status.stage, "promoted");
  assert.equal(status.forgejo.url, forgejoUrl);
  assert.deepEqual({ url: viewed.url, title: viewed.title }, { url: forgejoUrl, title: "[GH-7] Add the feature" });
  assert.equal(host.forgejo.pullRequests[0]!.body, "Edited through the GitHub URL.\n");
  assert.equal((await host.github.mutatingCalls()).filter((call) => call.includes("edit")).length, 1);
});

test("addressing feedback on a staged pull request mirrors every unresolved GitHub comment into Forgejo once", async () => {
  const first = await forgeJson<{ mirrored: string[]; alreadyMirrored: string[] }>(host, ["mirror-feedback", githubUrl]);
  const second = await forgeJson<{ mirrored: string[]; alreadyMirrored: string[] }>(host, ["mirror-feedback", forgejoUrl]);

  const expectedKeys = ["thread 7 201", "thread 7 202", "comment 7 301", "comment 7 303", "review 7 401"];
  assert.deepEqual(first.mirrored, expectedKeys);
  assert.deepEqual(second.mirrored, []);
  assert.deepEqual(second.alreadyMirrored, expectedKeys);
  const mirrored = (await feedback(forgejoUrl)).filter((item) => item.githubKey !== null);
  assert.deepEqual(mirrored.map((item) => item.githubKey).sort(), [...expectedKeys].sort());
  const inline = mirrored.find((item) => item.githubKey === "thread 7 201")!;
  assert.equal(inline.kind, "review-comment");
  assert.deepEqual(inline.place, { path: "feature.txt", line: 2, onOldSide: false });
  assert.match(inline.body, /\*\*@pastry-reviewer\*\* on GitHub:\n\n> The second line should say which oven\./);
  assert.match(inline.body, new RegExp(`\\[View on GitHub\\]\\(${githubUrl}#discussion_r201\\)`));
  const bot = mirrored.find((item) => item.githubKey === "comment 7 303")!;
  assert.match(bot.body, /review-bot\[bot\]\*\* on GitHub:\n\n> Finding: the pickup date/);
  assert.equal(host.forgejo.comments.some((entry) => entry.body.includes("first report")), false);
  assert.equal(host.forgejo.comments.some((entry) => entry.body.includes("Typo in the first line")), false);
});

test("mirroring review feedback reports a GitHub media link in a mirrored comment without failing the mirror", async () => {
  const screenshotUrl = "https://github.com/user-attachments/assets/4b6d8f0a-0000-4c2e-9a1b-3d5f7e9c1b2a";
  const state = await host.github.read();
  state.pullRequests[0]!.issueComments.push(comment(304, "pastry-reviewer", `The button overlaps the total:\n\n![overlap](${screenshotUrl})`, 8));
  await host.github.write(state);

  const mirror = await runForgeCapturing(["mirror-feedback", githubUrl], stagingDependencies, host.checkout.repo);

  const found = { link: screenshotUrl, githubCommentUrl: `${githubUrl}#issuecomment-304` };
  const printed = JSON.parse(mirror.stdout) as { mirrored: string[]; mediaLinksInMirroredComments: unknown[] };
  assert.equal(mirror.exitCode, 0, mirror.stderr);
  assert.equal(printed.mirrored.length, 6);
  assert.deepEqual(printed.mediaLinksInMirroredComments, [found]);
  assert.equal(
    mirror.stderr,
    `a mirrored review comment holds the GitHub media link ${found.link}, which does not load in Forgejo; see it on GitHub at ${found.githubCommentUrl}\n`,
  );
  assert.ok(host.forgejo.comments.some((entry) => entry.body.includes(`> ![overlap](${screenshotUrl})`)));
});

test("an inline comment whose line is gone is mirrored as a conversation comment naming the file and line", async () => {
  await forge(host, ["mirror-feedback", githubUrl]);

  const gone = await mirroredItem("thread 7 202");

  assert.equal(gone.kind, "comment");
  assert.equal(gone.place, null);
  assert.match(gone.body, /^On `feature\.txt` line 40, which is no longer in this pull request's diff\. \[View on GitHub\]/);
  assert.match(gone.body, /> This loop sends the order email twice\./);
});

test("answering and resolving a mirrored review comment resolves its conversation when Forgejo sends two session cookies", async () => {
  await forge(host, ["mirror-feedback", githubUrl]);
  const mirrored = await mirroredItem("thread 7 201");

  await answer(mirrored.id, "The line now names the oven.", true);

  assert.deepEqual(host.forgejo.adminSignIns, ["court-admin"]);
  assert.equal((await mirroredItem("thread 7 201")).resolved, true);
  assert.equal(host.forgejo.reviewComments.find((entry) => entry.id === mirrored.id)!.resolved, true);
});

test("an answer to a mirrored review comment after a fix commit lands in the reviewer's conversation", async () => {
  await forge(host, ["mirror-feedback", githubUrl]);
  const mirrored = await mirroredItem("thread 7 201");
  await pushFixCommit();

  await answer(mirrored.id, "Fixed in the oven commit: the line now names the oven.", true);

  const reply = (await feedback(forgejoUrl)).find((item) => item.answers === mirrored.id)!;
  assert.equal(reply.kind, "review-comment");
  assert.equal(reply.reviewId, mirrored.reviewId);
  assert.deepEqual(reply.place, mirrored.place);
  const conversationsOnTheLine = new Set(
    host.forgejo.reviewComments.filter((entry) => entry.path === "feature.txt" && entry.position === 2).map((entry) => entry.reviewId),
  );
  assert.deepEqual([...conversationsOnTheLine], [mirrored.reviewId]);
  assert.equal((await mirroredItem("thread 7 201")).resolved, true);
});

test("repromoting carries each Forgejo answer back to its GitHub thread once and resolves it", async () => {
  await forge(host, ["mirror-feedback", githubUrl]);
  await answer((await mirroredItem("thread 7 201")).id, "Fixed in the oven commit: the line now names the oven.", true);
  await answer((await mirroredItem("thread 7 202")).id, "The loop sends once; the second send is the receipt.", true);
  await answer((await mirroredItem("comment 7 301")).id, "Renamed the button to Order.", false);
  await pushFixCommit();
  assert.equal((await mirroredItem("thread 7 201")).resolved, true);

  const repromoted = await promote(host, forgejoUrl);
  const again = await promote(host, forgejoUrl);

  const pull = (await host.github.read()).pullRequests[0]!;
  const lineTwo = pull.threads.find((candidate) => candidate.id === "THREAD_ON_LINE_TWO")!;
  const goneLine = pull.threads.find((candidate) => candidate.id === "THREAD_ON_A_GONE_LINE")!;
  assert.deepEqual(lineTwo.comments.map((entry) => entry.body.split("\n")[0]), [
    "The second line should say which oven.",
    "Fixed in the oven commit: the line now names the oven.",
  ]);
  assert.equal(lineTwo.comments[1]!.body, "Fixed in the oven commit: the line now names the oven.");
  assert.equal(lineTwo.resolved, true);
  assert.equal(goneLine.comments.length, 2);
  assert.equal(goneLine.resolved, true);
  assert.deepEqual(
    pull.issueComments.map((entry) => entry.body.split("\n")[0]),
    [
      "Could the button say Order instead of Pay?",
      "Finding: the discount total can go negative. (first report)",
      "Finding: the pickup date is parsed without a time zone. (latest report)",
      "Renamed the button to Order.",
    ],
  );
  assert.equal(repromoted.answers.replied.length, 3);
  assert.deepEqual(repromoted.answers.resolved.sort(), ["THREAD_ON_A_GONE_LINE", "THREAD_ON_LINE_TWO"]);
  assert.deepEqual(again.answers, { replied: [], resolved: [] });
  assert.equal(await git(host.checkout.origin, ["rev-parse", "refs/heads/add/feature"]), await git(host.checkout.repo, ["rev-parse", "add/feature"]));
});

test("an answer already carried back is not carried twice, judged from the Forgejo metadata comment", async () => {
  await forge(host, ["mirror-feedback", githubUrl]);
  await answer((await mirroredItem("thread 7 201")).id, "Fixed in the oven commit.", false);
  await answer((await mirroredItem("comment 7 301")).id, "Renamed the button to Order.", false);
  const first = await promote(host, forgejoUrl);
  const state = await host.github.read();
  const pull = state.pullRequests[0]!;
  pull.threads.find((candidate) => candidate.id === "THREAD_ON_LINE_TWO")!.comments.splice(1);
  pull.issueComments = pull.issueComments.filter((entry) => entry.body !== "Renamed the button to Order.");
  await host.github.write(state);

  const second = await promote(host, forgejoUrl);

  const metadataComments = host.forgejo.comments.filter((entry) => githubTwinIn(entry.body) === githubUrl);
  assert.equal(first.answers.replied.length, 2);
  assert.equal(metadataComments.length, 1);
  assert.deepEqual(stagingSyncIn(metadataComments[0]!.body).carriedAnswers, first.answers.replied);
  assert.deepEqual(second.answers, { replied: [], resolved: [] });
  const after = (await host.github.read()).pullRequests[0]!;
  assert.equal(after.threads.find((candidate) => candidate.id === "THREAD_ON_LINE_TWO")!.comments.length, 1);
  assert.equal(after.issueComments.some((entry) => entry.body === "Renamed the button to Order."), false);
});

test("an answer carried back to GitHub is never mirrored back into Forgejo as new feedback", async () => {
  await forge(host, ["mirror-feedback", githubUrl]);
  await answer((await mirroredItem("comment 7 301")).id, "Renamed the button to Order.", false);
  await answer((await mirroredItem("thread 7 201")).id, "Fixed in the oven commit.", false);
  await promote(host, forgejoUrl);

  const again = await forgeJson<{ mirrored: string[] }>(host, ["mirror-feedback", githubUrl]);

  assert.deepEqual(again.mirrored, []);
});

test("nothing reaches GitHub until promote or repromote is run", async () => {
  const afterPromotion = await host.github.mutatingCalls();

  await forge(host, ["status", githubUrl]);
  await forge(host, ["mirror-feedback", githubUrl]);
  await forge(host, ["pr", "view", githubUrl]);
  await forge(host, ["pr", "diff", githubUrl]);
  await answer((await mirroredItem("thread 7 201")).id, "Fixed.", true);
  await answer((await mirroredItem("review 7 401")).id, "Merged the two queries.", false);
  await forge(host, ["mirror-feedback", forgejoUrl]);

  assert.deepEqual(await host.github.mutatingCalls(), afterPromotion);
  const pull = (await host.github.read()).pullRequests[0]!;
  assert.equal(pull.threads.every((candidate) => candidate.comments.length === 1), true);
  assert.equal(pull.threads.find((candidate) => candidate.id === "THREAD_ON_LINE_TWO")!.resolved, false);
  assert.equal(pull.issueComments.length, 3);

  await promote(host, githubUrl);

  assert.equal(pull.threads.length, (await host.github.read()).pullRequests[0]!.threads.length);
  assert.equal((await host.github.read()).pullRequests[0]!.threads.find((candidate) => candidate.id === "THREAD_ON_LINE_TWO")!.resolved, true);
});

test("the GitHub thread dump of a staged pull request sends the reader to its Forgejo twin", async () => {
  const homeWithPinnedNode = await mkdtemp(path.join(tmpdir(), "forge-staged-home-"));
  await installPinnedNode(homeWithPinnedNode);
  const refused = await promisify(execFile)(process.execPath, [THREADS_SCRIPT, githubUrl], { cwd: host.checkout.repo, env: { ...process.env, HOME: homeWithPinnedNode } })
    .catch((error: { code: number; stderr: string }) => error)
    .finally(() => rm(homeWithPinnedNode, { recursive: true, force: true }));

  assert.equal("code" in refused ? refused.code : 0, 1);
  assert.match(
    "stderr" in refused ? refused.stderr : "",
    new RegExp(`is staged in Forgejo as ${forgejoUrl.replaceAll(".", "\\.")}; copy its GitHub feedback there with \`throne forge mirror-feedback`),
  );
});

test("a pending review on a GitHub pull request with a Forgejo twin goes to GitHub, and a Forgejo pull request still refuses", async () => {
  const commentsPath = path.join(host.checkout.repo, "review-comments.json");
  await writeFile(commentsPath, JSON.stringify([{ path: "feature.txt", line: 2, body: "Name the oven here." }]));
  const githubCalls: Array<{ readonly program: string; readonly args: readonly string[] }> = [];
  const options = {
    runSeam: (args: readonly string[]) => forge(host, args),
    runGithub: (program: string, args: readonly string[]) => {
      githubCalls.push({ program, args: [...args] });
      return "9d1e7c2b\n";
    },
    writeOutput: () => undefined,
  };

  await pendingReviewScript.leavePendingReview(githubUrl, commentsPath, ["--dry-run"], options);
  await assert.rejects(pendingReviewScript.leavePendingReview(forgejoUrl, commentsPath, ["--dry-run"], options), {
    message: pendingReviewScript.forgejoHasNoPendingReview,
  });

  assert.equal(githubUrl, `https://github.com/${FAKE_GITHUB_REPOSITORY}/pull/7`);
  assert.deepEqual(githubCalls, [
    { program: "gh", args: ["pr", "view", "7", "--repo", FAKE_GITHUB_REPOSITORY, "--json", "headRefOid", "--jq", ".headRefOid"] },
  ]);
});
