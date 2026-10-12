import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { git } from "./git-repo-test-fixture.ts";
import { FAKE_FORGEJO_ADMIN } from "./forge-fake-forgejo.ts";
import {
  commitInBareByHand,
  forgeDependenciesWithFakeGithub,
  recordingGitCalls,
  runForgeCapturing,
  startForgejoWithCheckoutForEachTest,
} from "./forge-test-support.ts";

const forgejoWithCheckout = startForgejoWithCheckoutForEachTest("forge-fresh-base-");
const dependencies = forgeDependenciesWithFakeGithub();
const checkout = () => forgejoWithCheckout().checkout;
const forgejo = () => forgejoWithCheckout().forgejo;

async function forge(args: readonly string[], forgeDependencies = dependencies) {
  return runForgeCapturing(args, forgeDependencies, checkout().repo);
}

async function commitOn(branch: string, file: string): Promise<void> {
  await git(checkout().repo, ["checkout", "-q", branch]);
  await writeFile(path.join(checkout().repo, file), `${file}\n`);
  await git(checkout().repo, ["add", file]);
  await git(checkout().repo, ["commit", "--no-gpg-sign", "-q", "-m", `add ${file}`]);
}

async function openPullRequest(head: string, base = "main", forgeDependencies = dependencies): Promise<number> {
  const bodyFile = path.join(checkout().repo, `${head.replace("/", "-")}.md`);
  await writeFile(bodyFile, "Body\n");
  const created = await forge(["pr", "create", "--base", base, "--head", head, "--title", head, "--body-file", bodyFile], forgeDependencies);
  assert.equal(created.exitCode, 0, created.stderr);
  return Number(created.stdout.trim().split("/").pop());
}

test("the base is fetched from GitHub before Forgejo's copy of it is refreshed", async () => {
  const recording = recordingGitCalls(dependencies);

  await openPullRequest("add/feature", "main", recording);

  const command = (args: string[]) => args.join(" ");
  const fetchOfBase = recording.gitCalls.findIndex((args) => command(args) === "fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
  const pushOfBase = recording.gitCalls.findIndex((args) => args[0] === "push" && args[1] === "forgejo" && args[2]!.endsWith(":refs/heads/main"));
  assert.ok(fetchOfBase >= 0, recording.gitCalls.map(command).join("\n"));
  assert.ok(pushOfBase > fetchOfBase, recording.gitCalls.map(command).join("\n"));
});

test("a pull request opened after the base branch moved is diffed against the new base", async () => {
  const copied = await forge(["ensure-repository"]);
  assert.equal(copied.exitCode, 0, copied.stderr);
  await commitOn("main", "moved-base.txt");
  await git(checkout().repo, ["push", "-q", "origin", "main"]);
  await commitOn("main", "local-only.txt");
  await git(checkout().repo, ["checkout", "-q", "-b", "add/second-feature", "origin/main"]);
  await commitOn("add/second-feature", "second-feature.txt");

  const second = await openPullRequest("add/second-feature");
  const diff = await forge(["pr", "diff", String(second)]);

  const bare = forgejo().bareRepositoryPath(`${FAKE_FORGEJO_ADMIN}/staging-demo`);
  assert.equal(await git(bare, ["rev-parse", "refs/heads/main"]), await git(checkout().repo, ["rev-parse", "origin/main"]));
  assert.match(diff.stdout, /^\+\+\+ b\/second-feature\.txt$/m);
  assert.doesNotMatch(diff.stdout, /moved-base\.txt|local-only\.txt/);
});

test("a pull request can be opened in Forgejo after its base was changed by hand in Forgejo", async () => {
  await openPullRequest("add/feature");
  const bare = forgejo().bareRepositoryPath(`${FAKE_FORGEJO_ADMIN}/staging-demo`);
  const forgejoMainAfterHandEdit = await commitInBareByHand(bare, "main", "edit in the Forgejo web editor");
  assert.equal(await git(bare, ["rev-parse", "refs/heads/main^"]), await git(checkout().repo, ["rev-parse", "origin/main"]));
  await git(checkout().repo, ["checkout", "-q", "-b", "add/second-feature", "origin/main"]);
  await commitOn("add/second-feature", "second-feature.txt");

  const second = await openPullRequest("add/second-feature");
  const diff = await forge(["pr", "diff", String(second)]);

  assert.equal(await git(bare, ["rev-parse", "refs/heads/main"]), forgejoMainAfterHandEdit);
  assert.match(diff.stdout, /^\+\+\+ b\/second-feature\.txt$/m);
  assert.doesNotMatch(diff.stdout, /b\/feature\.txt/);
});

test("a Forgejo base that truly diverged from origin is refused, never overwritten", async () => {
  await openPullRequest("add/feature");
  const bare = forgejo().bareRepositoryPath(`${FAKE_FORGEJO_ADMIN}/staging-demo`);
  const forgejoMainBefore = await git(bare, ["rev-parse", "refs/heads/main"]);
  await git(checkout().repo, ["checkout", "-q", "main"]);
  await git(checkout().repo, ["commit", "--no-gpg-sign", "-q", "--amend", "-m", "rewritten base"]);
  await git(checkout().repo, ["push", "-q", "--force", "origin", "main"]);
  const originMain = await git(checkout().repo, ["rev-parse", "origin/main"]);

  const pushed = await forge(["push-branch", "--branch", "add/feature"]);

  assert.equal(pushed.exitCode, 1);
  assert.match(pushed.stderr, /Forgejo refused the base branch main/);
  assert.ok(pushed.stderr.includes(forgejoMainBefore), pushed.stderr);
  assert.ok(pushed.stderr.includes(originMain), pushed.stderr);
  assert.equal(await git(bare, ["rev-parse", "refs/heads/main"]), forgejoMainBefore);
});

function forgejoCopy(): string {
  return forgejo().bareRepositoryPath(`${FAKE_FORGEJO_ADMIN}/staging-demo`);
}

test("a stale local copy of the base is corrected before it reaches Forgejo", async () => {
  await openPullRequest("add/feature");
  const githubMain = await commitInBareByHand(checkout().origin, "main", "merged on GitHub");
  assert.notEqual(await git(checkout().repo, ["rev-parse", "refs/remotes/origin/main"]), githubMain);

  const pushed = await forge(["push-branch", "--branch", "add/feature"]);

  assert.equal(pushed.exitCode, 0, pushed.stderr);
  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/main"]), githubMain);
  assert.equal(await git(checkout().repo, ["rev-parse", "refs/remotes/origin/main"]), githubMain);
});

test("a base refresh refuses with a clear message when GitHub cannot be reached, and pushes nothing", async () => {
  await openPullRequest("add/feature");
  const forgejoMainBefore = await git(forgejoCopy(), ["rev-parse", "refs/heads/main"]);
  const forgejoFeatureBefore = await git(forgejoCopy(), ["rev-parse", "refs/heads/add/feature"]);
  await commitOn("add/feature", "more-feature.txt");
  await git(checkout().repo, ["remote", "set-url", "origin", path.join(checkout().repo, "unreachable-github.git")]);

  const pushed = await forge(["push-branch", "--branch", "add/feature"]);

  assert.equal(pushed.exitCode, 1);
  assert.match(pushed.stderr, /git fetch origin main failed/);
  assert.match(pushed.stderr, /nothing was pushed/);
  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/main"]), forgejoMainBefore);
  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/add/feature"]), forgejoFeatureBefore);
});

test("a stacked pull request whose base exists only in Forgejo can still be pushed", async () => {
  await openPullRequest("add/feature");
  await git(checkout().repo, ["checkout", "-q", "-b", "add/stacked", "add/feature"]);
  await commitOn("add/stacked", "stacked.txt");

  const stacked = await openPullRequest("add/stacked", "add/feature");
  const diff = await forge(["pr", "diff", String(stacked)]);

  assert.equal(await git(forgejoCopy(), ["rev-parse", "refs/heads/add/stacked"]), await git(checkout().repo, ["rev-parse", "add/stacked"]));
  assert.match(diff.stdout, /^\+\+\+ b\/stacked\.txt$/m);
  assert.doesNotMatch(diff.stdout, /b\/feature\.txt/);
});
