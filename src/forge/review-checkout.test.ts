import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { git } from "../../test/git-repo-test-fixture.ts";
import { PRODUCTION_FORGE_DEPENDENCIES } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { FORGE } from "./host-forge.ts";
import { TARGET_KIND } from "./pull-request-status.ts";
import { chooseReviewCheckout, liveAgentReason, REVIEW_CHECKOUT_HOW, type ReviewCheckout, type ReviewCheckoutHead } from "./review-checkout.ts";

const PULL_REQUEST_NUMBER = 7;
const HEAD_BRANCH = "add/greeting";
const NO_LIVE_AGENTS: ReadonlySet<string> = new Set();
const scratchRoots: string[] = [];

interface Forges {
  readonly root: string;
  readonly checkout: string;
  readonly publisher: string;
  readonly baseSha: string;
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configureCommitter(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "test@throne.local"]);
  await git(repo, ["config", "user.name", "Throne Test"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
}

async function commitFile(repo: string, file: string): Promise<string> {
  await writeFile(path.join(repo, file), `${file}\n`);
  await git(repo, ["add", file]);
  await git(repo, ["commit", "--no-gpg-sign", "-q", "-m", `add ${file}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function createForges(): Promise<Forges> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "review-checkout-")));
  scratchRoots.push(root);
  const origin = path.join(root, "origin.git");
  const forgejo = path.join(root, "forgejo.git");
  await git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  await git(root, ["init", "-q", "--bare", "-b", "main", forgejo]);
  const publisher = path.join(root, "publisher");
  await git(root, ["init", "-q", "-b", "main", publisher]);
  await configureCommitter(publisher);
  const baseSha = await commitFile(publisher, "base.txt");
  await git(publisher, ["remote", "add", "origin", origin]);
  await git(publisher, ["remote", "add", "forgejo", forgejo]);
  await git(publisher, ["push", "-q", "origin", "main"]);
  await git(publisher, ["push", "-q", "forgejo", "main"]);
  const checkout = path.join(root, "project");
  await git(root, ["clone", "-q", origin, checkout]);
  await configureCommitter(checkout);
  await git(checkout, ["remote", "add", "forgejo", forgejo]);
  return { root, checkout, publisher, baseSha };
}

async function publishHead(forges: Forges, remote: string, ref: string): Promise<string> {
  await git(forges.publisher, ["checkout", "-q", "-B", HEAD_BRANCH, "main"]);
  const headSha = await commitFile(forges.publisher, "greeting.txt");
  await git(forges.publisher, ["push", "-q", remote, `${headSha}:${ref}`]);
  return headSha;
}

async function commitHeadLocally(forges: Forges): Promise<string> {
  await git(forges.checkout, ["checkout", "-q", "-b", HEAD_BRANCH]);
  const headSha = await commitFile(forges.checkout, "greeting.txt");
  await git(forges.checkout, ["checkout", "-q", "main"]);
  return headSha;
}

async function addDetachedWorktree(forges: Forges, name: string, sha: string): Promise<string> {
  const worktree = path.join(forges.root, name);
  await git(forges.checkout, ["worktree", "add", "-q", "--detach", worktree, sha]);
  return worktree;
}

function headAt(headSha: string, holder: ReviewCheckoutHead["holder"]): ReviewCheckoutHead {
  return { number: PULL_REQUEST_NUMBER, headBranch: HEAD_BRANCH, headSha, holder, targetKind: TARGET_KIND.githubUrl };
}

function chooseFor(forges: Forges, headSha: string, holder: ReviewCheckoutHead["holder"], liveAgentNames = NO_LIVE_AGENTS): Promise<ReviewCheckout> {
  return chooseReviewCheckout({ checkout: forges.checkout, head: headAt(headSha, holder), liveAgentNames }, PRODUCTION_FORGE_DEPENDENCIES);
}

async function reviewTreeBehindPublishedHead(forges: Forges): Promise<{ readonly headSha: string; readonly reviewTree: string }> {
  const headSha = await publishHead(forges, "origin", `refs/heads/${HEAD_BRANCH}`);
  const reviewTree = await addDetachedWorktree(forges, `project-pr-${PULL_REQUEST_NUMBER}`, forges.baseSha);
  return { headSha, reviewTree };
}

async function isDetachedAt(worktree: string, sha: string): Promise<boolean> {
  const branch = await git(worktree, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
  return branch === "" && (await git(worktree, ["rev-parse", "HEAD"])) === sha;
}

async function assertCreatedDetachedAt(forges: Forges, chosen: ReviewCheckout, headSha: string): Promise<void> {
  assert.equal(chosen.path, path.join(forges.root, `project-pr-${PULL_REQUEST_NUMBER}`));
  assert.equal(chosen.how, REVIEW_CHECKOUT_HOW.created);
  assert.ok(await isDetachedAt(chosen.path, headSha));
  assert.equal(await git(forges.checkout, ["branch", "--list", HEAD_BRANCH]), "");
}

test("a clean worktree already at the pull request head is reused", async () => {
  const forges = await createForges();
  const headSha = await commitHeadLocally(forges);
  const finishedAlphaTree = await addDetachedWorktree(forges, "alpha-finished-01", headSha);

  const chosen = await chooseFor(forges, headSha, FORGE.github);

  assert.equal(chosen.path, finishedAlphaTree);
  assert.equal(chosen.how, REVIEW_CHECKOUT_HOW.reused);
  await assert.rejects(access(path.join(forges.root, `project-pr-${PULL_REQUEST_NUMBER}`)));
});

test("a live agent's worktree at the pull request head is skipped and reported", async () => {
  const forges = await createForges();
  const headSha = await commitHeadLocally(forges);
  const liveAlphaTree = await addDetachedWorktree(forges, "alpha-busy-01", headSha);

  const chosen = await chooseFor(forges, headSha, FORGE.github, new Set(["alpha-busy-01"]));

  assert.notEqual(chosen.path, liveAlphaTree);
  assert.deepEqual(
    chosen.skipped.find((entry) => entry.path === liveAlphaTree),
    { path: liveAlphaTree, reason: liveAgentReason("alpha-busy-01") },
  );
});

test("a dirty review worktree is refused with its path and left untouched", async () => {
  const forges = await createForges();
  const { headSha, reviewTree } = await reviewTreeBehindPublishedHead(forges);
  await writeFile(path.join(reviewTree, "notes.txt"), "work in progress\n");

  await assert.rejects(
    chooseFor(forges, headSha, FORGE.github),
    (error: unknown) => error instanceof ForgeRefusal && error.message.includes(reviewTree),
  );

  assert.equal(await git(reviewTree, ["rev-parse", "HEAD"]), forges.baseSha);
  assert.equal(await git(reviewTree, ["status", "--porcelain"]), "?? notes.txt");
});

test("a clean review worktree that is behind is moved to the new head", async () => {
  const forges = await createForges();
  const { headSha, reviewTree } = await reviewTreeBehindPublishedHead(forges);

  const chosen = await chooseFor(forges, headSha, FORGE.github);

  assert.equal(chosen.path, reviewTree);
  assert.equal(chosen.how, REVIEW_CHECKOUT_HOW.moved);
  assert.ok(await isDetachedAt(reviewTree, headSha));
});

test("a new review worktree is created detached from the forgejo remote when forgejo holds the head", async () => {
  const forges = await createForges();
  const headSha = await publishHead(forges, "forgejo", `refs/heads/${HEAD_BRANCH}`);

  const chosen = await chooseFor(forges, headSha, FORGE.forgejo);

  await assertCreatedDetachedAt(forges, chosen, headSha);
});

test("a new review worktree is created detached from origin when github holds the head", async () => {
  const forges = await createForges();
  const headSha = await publishHead(forges, "origin", `refs/pull/${PULL_REQUEST_NUMBER}/head`);

  const chosen = await chooseFor(forges, headSha, FORGE.github);

  await assertCreatedDetachedAt(forges, chosen, headSha);
});
