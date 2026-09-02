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
