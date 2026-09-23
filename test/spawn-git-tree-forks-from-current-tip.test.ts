// Live failure, 2026-08-26: alpha-autoscale could not spawn
// "alpha-thw-harness-wiring" because the base recorded in the queue row had
// been overtaken by a new commit on main between minting and spawning:
//   'base ccd1cc3 is not the current tip 6c9126e of target branch "main"'
//
// A requested base is a HINT about where the caller last looked, not a lock.
// Refusing on a race turns ordinary mainline movement into an unspawnable
// objective. The tip of the target branch always wins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { git, initRepo } from "./git-repo-test-fixture.ts";
import { resolveNonCampaignBase } from "../src/spawn-git-tree/non-campaign-base.ts";

test("a stale requested base forks from the current tip instead of refusing", async () => {
  const repo = await initRepo("spawn-tip-");
  const stale = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "moved.txt"), "moved\n", "utf8");
  await git(repo, ["add", "moved.txt"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", "main moved on"]);
  const tip = await git(repo, ["rev-parse", "HEAD"]);
  assert.notEqual(stale, tip);

  const resolved = await resolveNonCampaignBase({
    name: "alpha-thw-harness-wiring",
    projectDir: repo,
    targetBranch: "main",
    requestedBase: stale,
  });

  assert.equal(resolved.ok, true, `refused: ${(resolved as { reason?: string }).reason}`);
  if (!resolved.ok) return;
  assert.equal(resolved.base.creationBase, tip);
  assert.equal(resolved.base.record.base, tip);
  assert.equal(resolved.base.record.commit, tip);
});

test("a base that is not a commit at all is still a caller error", async () => {
  const repo = await initRepo("spawn-tip-bad-");
  const resolved = await resolveNonCampaignBase({
    name: "alpha-thw-harness-wiring",
    projectDir: repo,
    targetBranch: "main",
    requestedBase: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  assert.equal(resolved.ok, false);
});

test("a local branch whose tip does not contain the filed base is refused, naming both commits", async () => {
  const repo = await initRepo("spawn-tip-diverged-");
  const fork = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "published.txt"), "the history that was filed\n", "utf8");
  await git(repo, ["add", "published.txt"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", "published head"]);
  const filedBase = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "-q", "-b", "scratch", fork]);
  await writeFile(path.join(repo, "stale.txt"), "a stale local line of history\n", "utf8");
  await git(repo, ["add", "stale.txt"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", "stale local work"]);
  const staleTip = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["branch", "-q", "add/feature", staleTip]);
  await git(repo, ["checkout", "-q", "main"]);

  const resolved = await resolveNonCampaignBase({
    name: "alpha-treelist-01",
    projectDir: repo,
    targetBranch: "add/feature",
    requestedBase: filedBase,
  });

  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, new RegExp(`is at ${staleTip}`));
  assert.match(resolved.reason, new RegExp(`does not contain the filed base ${filedBase}`));
  assert.match(resolved.reason, new RegExp(`branch -f add/feature ${filedBase}`));
  assert.match(resolved.reason, /Nothing was created/);
});

test("a local branch that is behind the filed base is refused too", async () => {
  const repo = await initRepo("spawn-tip-behind-");
  const staleTip = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["branch", "-q", "add/feature", staleTip]);
  await writeFile(path.join(repo, "newer.txt"), "remote moved on\n", "utf8");
  await git(repo, ["add", "newer.txt"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", "newer published work"]);
  const filedBase = await git(repo, ["rev-parse", "HEAD"]);

  const resolved = await resolveNonCampaignBase({
    name: "alpha-behind-01",
    projectDir: repo,
    targetBranch: "add/feature",
    requestedBase: filedBase,
  });

  assert.equal(resolved.ok, false);
});
