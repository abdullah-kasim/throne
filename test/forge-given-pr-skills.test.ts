import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeForgejo, type FakeForgejo } from "./forge-fake-forgejo.ts";
import {
  forgeDependenciesWithFakeGithub,
  repositoryWithOriginAndFeatureBranch,
  runForgeCapturing,
  TEST_FORGEJO_TOKEN,
  useFreshForgejoStateDirectory,
  type ForgejoStateDirectory,
} from "./forge-test-support.ts";

type RunSeam = (args: readonly string[]) => Promise<string>;
type RunGithub = (program: string, args: readonly string[], input?: string) => string;

interface StackScript {
  discoverStackToMerge(url: string, runSeam: RunSeam): Promise<unknown>;
}

interface PendingReviewScript {
  readonly forgejoHasNoPendingReview: string;
  leavePendingReview(
    url: string,
    commentsPath: string,
    flags: readonly string[],
    options: { readonly runSeam: RunSeam; readonly runGithub: RunGithub; readonly writeOutput: (text: string) => void },
  ): Promise<void>;
}

const SKILLS_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude", "skills");
const stackScript = (await import(path.join(SKILLS_DIRECTORY, "pr-merge", "stack.mjs"))) as StackScript;
const pendingReviewScript = (await import(path.join(SKILLS_DIRECTORY, "pr-review", "pending-review.mjs"))) as PendingReviewScript;

let state: ForgejoStateDirectory;
let checkout: Awaited<ReturnType<typeof repositoryWithOriginAndFeatureBranch>>;
let forgejo: FakeForgejo;
const REVIEWED_GITHUB_PULL_REQUEST_URL = "https://github.com/shop-owner/storefront/pull/42";
const REVIEWED_HEAD_SHA = "4f2c9e1ab07d55e3";
const dependencies = forgeDependenciesWithFakeGithub(() => ({
  exitCode: 0,
  stdout: JSON.stringify({
    number: 42,
    url: REVIEWED_GITHUB_PULL_REQUEST_URL,
    state: "OPEN",
    isDraft: false,
    headRefName: "add/feature",
    baseRefName: "main",
    headRefOid: REVIEWED_HEAD_SHA,
    mergedAt: null,
    mergeCommit: null,
  }),
  stderr: "",
}));

beforeEach(async () => {
  dependencies.githubCalls.length = 0;
  state = await useFreshForgejoStateDirectory();
  checkout = await repositoryWithOriginAndFeatureBranch("forge-given-pr-");
  forgejo = await startFakeForgejo(TEST_FORGEJO_TOKEN);
  await state.installForgejo(forgejo.rootUrl);
});

afterEach(async () => {
  await forgejo.close();
  await checkout.remove();
  await state.remove();
});

const runSeamInProcess: RunSeam = async (args) => {
  const result = await runForgeCapturing(args, dependencies, checkout.repo);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
};

async function openForgejoPullRequest(head: string, base: string, title: string): Promise<string> {
  const bodyFile = path.join(checkout.repo, `${head.replaceAll("/", "-")}.md`);
  await writeFile(bodyFile, `${title}.\n`);
  return (await runSeamInProcess(["pr", "create", "--base", base, "--head", head, "--title", title, "--body-file", bodyFile])).trim();
}

async function writeReviewComments(): Promise<string> {
  const commentsPath = path.join(checkout.repo, "review-comments.json");
  await writeFile(commentsPath, JSON.stringify([{ path: "basket.ts", line: 12, body: "An empty basket reaches checkout here." }]));
  return commentsPath;
}

function recordingGithub(answers: (args: readonly string[]) => string) {
  const calls: Array<{ readonly program: string; readonly args: readonly string[]; readonly input?: string }> = [];
  const runGithub: RunGithub = (program, args, input) => {
    calls.push(input === undefined ? { program, args: [...args] } : { program, args: [...args], input });
    return answers(args);
  };
  return { calls, runGithub };
}

test("a GitHub pull request handed to the review skill still uses GitHub", async () => {
  const url = REVIEWED_GITHUB_PULL_REQUEST_URL;
  const github = recordingGithub((args) => {
    if (args[0] === "pr") return `${REVIEWED_HEAD_SHA}\n`;
    if (args.includes("POST")) return JSON.stringify({ id: 7 });
    if (args.at(-1) === "--paginate") return JSON.stringify([{ id: 70 }]);
    return JSON.stringify({ state: "PENDING", html_url: `${url}#pullrequestreview-7` });
  });
  let output = "";

  await pendingReviewScript.leavePendingReview(url, await writeReviewComments(), [], {
    runSeam: runSeamInProcess,
    runGithub: github.runGithub,
    writeOutput: (text) => void (output += text),
  });

  const payload = {
    commit_id: REVIEWED_HEAD_SHA,
    comments: [{ path: "basket.ts", line: 12, side: "RIGHT", body: "An empty basket reaches checkout here." }],
  };
  assert.deepEqual(github.calls, [
    { program: "gh", args: ["pr", "view", "42", "--repo", "shop-owner/storefront", "--json", "headRefOid", "--jq", ".headRefOid"] },
    { program: "gh", args: ["api", "repos/shop-owner/storefront/pulls/42/reviews", "--method", "POST", "--input", "-"], input: JSON.stringify(payload) },
    { program: "gh", args: ["api", "repos/shop-owner/storefront/pulls/42/reviews/7"] },
    { program: "gh", args: ["api", "repos/shop-owner/storefront/pulls/42/reviews/7/comments", "--paginate"] },
  ]);
  assert.match(output, /^pending review 7 on #42: state PENDING, 1 of 1 comments attached/);
  assert.equal(forgejo.repositories.size, 0);
});

test("a Forgejo pull request is never merged in Forgejo", async () => {
  const url = await openForgejoPullRequest("add/feature", "main", "Add the basket store");

  const byUrl = await runForgeCapturing(["pr", "merge", url, "--squash", "--bypass"], dependencies, checkout.repo);
  const byNumber = await runForgeCapturing(["pr", "merge", "1", "--squash"], dependencies, checkout.repo);

  for (const refused of [byUrl, byNumber]) {
    assert.equal(refused.exitCode, 1);
    assert.match(
      refused.stderr,
      /Nothing is merged in Forgejo: it is only the staging area\. Promote the pull request to GitHub with \/pr-promote on the Lord's word, then merge the GitHub pull request\./,
    );
  }
  await assert.rejects(
    stackScript.discoverStackToMerge(url, runSeamInProcess),
    /is not on GitHub yet: it has no metadata comment linking a GitHub pull request \(it was never staged or promoted\), and nothing is merged in Forgejo\. It must be promoted first with \/pr-promote on the Lord's word\./,
  );
  assert.deepEqual(forgejo.merges, []);
  assert.deepEqual(forgejo.pullRequests.map((pullRequest) => [pullRequest.state, pullRequest.merged]), [["open", false]]);
  assert.deepEqual(dependencies.githubCalls, []);
});

test("an operation Forgejo cannot do stops with a plain statement instead of half-working", async () => {
  const url = await openForgejoPullRequest("add/feature", "main", "Add the basket store");
  const github = recordingGithub(() => {
    throw new Error("GitHub must not be called for a Forgejo pull request");
  });
  let output = "";

  await assert.rejects(
    pendingReviewScript.leavePendingReview(url, await writeReviewComments(), [], {
      runSeam: runSeamInProcess,
      runGithub: github.runGithub,
      writeOutput: (text) => void (output += text),
    }),
    { message: pendingReviewScript.forgejoHasNoPendingReview },
  );

  assert.equal(
    pendingReviewScript.forgejoHasNoPendingReview,
    "A Forgejo pull request cannot get a pending review: the forge seam has no review operation, so nothing was written.",
  );
  assert.deepEqual(github.calls, []);
  assert.equal(output, "");
  assert.deepEqual([forgejo.comments, forgejo.merges], [[], []]);
  assert.deepEqual(dependencies.githubCalls, []);
});
