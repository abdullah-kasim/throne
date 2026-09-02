// Requirement: a terminal-gate Shadow's own `Deliver <name>` completion
// stamp is published only onto its own branch (`absorbAndStamp` deliberately
// never advances the supervising branch). When that branch is later cleared
// for deletion through the content-only (`delivery-content`) retention
// authority — the shape a squash/transplant rewrite of the merge target
// produces, where the branch's tip is never a git ancestor of the target
// even though its content already landed there — the stamp commit must
// still be reachable from some ref after the branch is gone, or the
// completion proof (`hasDeliveryCommit`) can never find it again.

import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { git, initRepo } from "./git-repo-test-fixture.ts";
import {
  deleteBranchCleanup,
  preflightBranchCleanup,
} from "../src/git-lifecycle/branch-cleanup.ts";
import { findDeliveryCommitHashes } from "../src/git-lifecycle/delivery-commit-proof.ts";

let root: string;
let base: string;
let realAbsorbCommit: string;
let rewrittenAlphaTip: string;
let stampCommit: string;

after(async () => {
  await rm(root, { recursive: true, force: true });
});

before(async () => {
  root = await initRepo("throne-preserve-stamp-");
  base = await git(root, ["rev-parse", "HEAD"]);

  // The Shadow's own branch and the branch it will eventually be absorbed
  // into both spawn from the same base commit.
  await git(root, ["branch", "alpha", base]);
  await git(root, ["branch", "shadow", base]);

  // Real work lands on "alpha" first, as its own git-ancestry commit.
  await git(root, ["checkout", "alpha"]);
  await writeFile(path.join(root, "content.txt"), "delivered content\n", "utf8");
  await git(root, ["add", "content.txt"]);
  await git(root, ["commit", "--no-gpg-sign", "-m", "feature work"]);
  realAbsorbCommit = await git(root, ["rev-parse", "HEAD"]);
  const alphaTree = await git(root, ["rev-parse", `${realAbsorbCommit}^{tree}`]);

  // absorbAndStamp's own shape: a content-empty, single-parent stamp commit
  // fast-forwarded onto the Shadow's branch — never touching "alpha".
  stampCommit = await git(root, [
    "commit-tree",
    alphaTree,
    "-p",
    realAbsorbCommit,
    "-m",
    "Deliver shadow",
  ]);
  await git(root, ["update-ref", "refs/heads/shadow", stampCommit]);

  // "alpha" is later squash-rewritten by an unrelated, later transplant —
  // same delivered tree, but the rewritten tip is no longer a git
  // descendant of `realAbsorbCommit`, so the Shadow's stamp (a descendant of
  // `realAbsorbCommit`) can no longer be proven an ancestor of "alpha" by
  // commit graph alone, even though its content already landed there.
  rewrittenAlphaTip = await git(root, [
    "commit-tree",
    alphaTree,
    "-p",
    base,
    "-m",
    "Squashed transplant of shadow's work",
  ]);
  await git(root, ["update-ref", "refs/heads/alpha", rewrittenAlphaTip]);
  await git(root, ["checkout", "main"]);
});

test("a terminal gate's completion stamp survives its own branch being reaped through delivery-content retention", async () => {
  const plan = await preflightBranchCleanup(
    "shadow",
    root,
    "alpha",
    false,
    base,
    rewrittenAlphaTip,
  );
  assert.equal(plan.status, "ready");
  assert.ok(plan.status === "ready");
  assert.deepEqual(plan.retention, {
    kind: "delivery-content",
    commit: rewrittenAlphaTip,
  });

  const deleted = await deleteBranchCleanup(plan);
  assert.equal(deleted, true);

  const shadowRef = await git(root, [
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/shadow",
  ]).catch(() => "absent");
  assert.equal(shadowRef, "absent", "the Shadow's branch must actually be gone");

  const stampHashes = await findDeliveryCommitHashes("shadow", root);
  assert.deepEqual(
    stampHashes,
    [stampCommit],
    "the completion proof must still find the stamp after the branch is gone",
  );

  const tagTarget = await git(root, [
    "rev-parse",
    "refs/tags/preserved-deliver-stamp/shadow",
  ]);
  assert.equal(
    tagTarget,
    stampCommit,
    "the preserving tag must point at the exact stamp commit",
  );
});

test("preserving the stamp never moves the merge target branch", async () => {
  const alphaTipAfter = await git(root, ["rev-parse", "refs/heads/alpha"]);
  assert.equal(
    alphaTipAfter,
    rewrittenAlphaTip,
    "the merge target branch's own tip must be byte-identical after the preserving tag is created",
  );
});

test("a branch whose tip is not itself a stamp is unregressed by the preservation step", async () => {
  const plainRoot = await initRepo("throne-preserve-stamp-plain-");
  try {
    const plainBase = await git(plainRoot, ["rev-parse", "HEAD"]);
    await git(plainRoot, ["branch", "alpha", plainBase]);
    await git(plainRoot, ["branch", "shadow", plainBase]);

    await git(plainRoot, ["checkout", "shadow"]);
    await writeFile(path.join(plainRoot, "content.txt"), "ordinary content\n", "utf8");
    await git(plainRoot, ["add", "content.txt"]);
    await git(plainRoot, ["commit", "--no-gpg-sign", "-m", "feature work"]);
    const shadowTip = await git(plainRoot, ["rev-parse", "HEAD"]);
    await git(plainRoot, ["checkout", "alpha"]);
    await git(plainRoot, ["merge", "--no-gpg-sign", "--no-ff", "-m", "merge shadow into alpha", "shadow"]);
    await git(plainRoot, ["checkout", "main"]);

    const plan = await preflightBranchCleanup(
      "shadow",
      plainRoot,
      "alpha",
      false,
      plainBase,
    );
    assert.equal(plan.status, "ready");
    assert.ok(plan.status === "ready");
    assert.deepEqual(plan.retention, { kind: "branch", branch: "alpha" });

    const deleted = await deleteBranchCleanup(plan);
    assert.equal(deleted, true);

    const tagList = await git(plainRoot, [
      "tag",
      "--list",
      "preserved-deliver-stamp/shadow",
    ]);
    assert.equal(tagList, "", "no tag is created when the branch tip is not a stamp");

    const shadowRef = await git(plainRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/shadow",
    ]).catch(() => "absent");
    assert.equal(shadowRef, "absent", "ordinary deletion still proceeds exactly as before");
    void shadowTip;
  } finally {
    await rm(plainRoot, { recursive: true, force: true });
  }
});
