import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, initRepo } from "./git-repo-test-fixture.ts";
import { GitTreeCreationService } from "../src/git-lifecycle/git-tree-creation.service.ts";

async function repoWithPrivateWorktreesHome(prefix: string): Promise<string> {
  process.env.THRONE_WORKTREES_HOME = await mkdtemp(path.join(os.tmpdir(), `${prefix}home-`));
  return initRepo(prefix);
}

async function commitFile(repo: string, file: string, message: string): Promise<string> {
  await writeFile(path.join(repo, file), `${file}\n`, "utf8");
  await git(repo, ["add", file]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

test("a second launch takes over the clean worktree and branch the first launch left behind", async () => {
  const repo = await repoWithPrivateWorktreesHome("takeover-clean-");
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const creation = new GitTreeCreationService();
  const first = await creation.create("alpha-media139-01", base, repo);
  assert.equal(first.tookOverLeftover, "none");

  const second = await creation.create("alpha-media139-01", base, repo);

  assert.equal(second.tookOverLeftover, "worktree-on-branch");
  assert.equal(await realpath(second.treePath), await realpath(first.treePath));
  assert.equal(await git(second.treePath, ["rev-parse", "HEAD"]), base);
});

test("a clean leftover that sits behind the requested base is fast-forwarded to it", async () => {
  const repo = await repoWithPrivateWorktreesHome("takeover-behind-");
  const oldBase = await git(repo, ["rev-parse", "HEAD"]);
  const creation = new GitTreeCreationService();
  const first = await creation.create("alpha-behind-01", oldBase, repo);
  const newBase = await commitFile(repo, "moved.txt", "target branch moved on");

  const second = await creation.create("alpha-behind-01", newBase, repo);

  assert.equal(second.tookOverLeftover, "worktree-on-branch");
  assert.equal(await git(first.treePath, ["rev-parse", "HEAD"]), newBase);
});

test("a leftover holding commits and uncommitted work is taken over exactly as it stands", async () => {
  const repo = await repoWithPrivateWorktreesHome("takeover-work-");
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const creation = new GitTreeCreationService();
  const first = await creation.create("alpha-work-01", base, repo);
  const campaignCommit = await commitFile(first.treePath, "campaign.txt", "campaign work");
  await writeFile(path.join(first.treePath, "unsaved.txt"), "unsaved\n", "utf8");
  const newBase = await commitFile(repo, "moved.txt", "target branch moved on");

  const second = await creation.create("alpha-work-01", newBase, repo);

  assert.equal(second.tookOverLeftover, "worktree-on-branch");
  assert.equal(await git(first.treePath, ["rev-parse", "HEAD"]), campaignCommit);
  assert.match(await git(first.treePath, ["status", "--porcelain"]), /unsaved\.txt/);
});

test("a leftover branch whose worktree directory was deleted gets its worktree back on that branch", async () => {
  const repo = await repoWithPrivateWorktreesHome("takeover-branch-only-");
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const creation = new GitTreeCreationService();
  const first = await creation.create("alpha-gone-01", base, repo);
  const campaignCommit = await commitFile(first.treePath, "campaign.txt", "campaign work");
  await rm(first.treePath, { recursive: true, force: true });

  const second = await creation.create("alpha-gone-01", base, repo);

  assert.equal(second.tookOverLeftover, "branch-without-worktree");
  assert.equal(await git(second.treePath, ["rev-parse", "HEAD"]), campaignCommit);
  assert.equal(await git(second.treePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "alpha-gone-01");
});
