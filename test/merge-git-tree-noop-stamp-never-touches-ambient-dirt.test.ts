// Requirement (Q2 of the adversarial review of commit 3edeb7d1): the same
// `advanceCandidateBranch` fix `absorb-git-tree` relies on must independently
// cover `merge-git-tree`'s own no-op completion path, `stampNoopDelivery` —
// both callers share the helper, but only `absorbAndStamp`'s two scenarios
// were proven in `absorb-git-tree-never-touches-ambient-dirt.test.ts`. This
// reproduces the identical ambient-dirt shape against `stampNoopDelivery`
// directly (the function that does the work, in-process, never the CLI
// binary) so the fix's coverage of `merge-git-tree`'s caller is proven, not
// assumed from the sibling test's own claim.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { git, initRepo } from "./git-repo-test-fixture.ts";
import { stampNoopDelivery } from "../src/git-lifecycle/delivery.ts";

const scratchRoots: string[] = [];

after(async () => {
  for (const root of scratchRoots) {
    await rm(root, { recursive: true, force: true });
  }
});

async function newScratchRoot(prefix: string): Promise<string> {
  const root = await initRepo(prefix);
  scratchRoots.push(root);
  return root;
}

/** Same shape as `absorb-git-tree-never-touches-ambient-dirt.test.ts`'s own
 *  helper: dirties `root`'s checked-out working tree the way a DIFFERENT,
 *  unrelated campaign's in-progress work would — a tracked edit on the exact
 *  line the stamp's own published tree also rewrites (so restoring it after
 *  a force-move genuinely conflicts) plus untracked files mirroring the
 *  reported incident's paths. */
async function plantAmbientDirtAndBracket(
  root: string,
): Promise<{ diff: string; untracked: Map<string, string> }> {
  await writeFile(path.join(root, "base.txt"), "ambient edit\n", "utf8");
  await mkdir(path.join(root, "src", "agentdata"), { recursive: true });
  await mkdir(path.join(root, "src", "no-idling"), { recursive: true });
  await writeFile(
    path.join(root, "src", "agentdata", "blocked-marker.service.spec.ts"),
    "ambient dirt A\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "no-idling", "dependency-cleared-wake.spec.ts"),
    "ambient dirt B\n",
    "utf8",
  );
  const diff = await git(root, ["diff", "--", "base.txt"]);
  const untracked = new Map<string, string>();
  for (const rel of [
    "src/agentdata/blocked-marker.service.spec.ts",
    "src/no-idling/dependency-cleared-wake.spec.ts",
  ]) {
    untracked.set(rel, await readFile(path.join(root, rel), "utf8"));
  }
  return { diff, untracked };
}

async function assertBracketUnchanged(
  root: string,
  bracket: { diff: string; untracked: Map<string, string> },
): Promise<void> {
  const diffAfter = await git(root, ["diff", "--", "base.txt"]);
  assert.equal(diffAfter, bracket.diff, "tracked modification must survive byte-identical");
  for (const [rel, content] of bracket.untracked) {
    const after = await readFile(path.join(root, rel), "utf8");
    assert.equal(after, content, `untracked file "${rel}" must survive byte-identical`);
  }
}

test("merge-git-tree's no-op stamp leaves the checked-out candidate branch's ambient dirt untouched", async () => {
  const root = await newScratchRoot("throne-stamp-noop-");
  const dataDir = await mkdtemp(path.join(tmpdir(), "throne-stamp-noop-data-"));
  scratchRoots.push(dataDir);

  await git(root, ["branch", "shadow"]);
  // "main" (the recorded merge target) diverges from the Shadow's own branch
  // on `base.txt` — this is what makes the no-op stamp's published tree
  // genuinely differ from what the Shadow's checkout has on disk, so
  // restoring the ambient dirt after the force-move actually has something
  // to conflict with. A same-content stamp makes even the buggy stash-pop
  // restore succeed trivially and would hide the defect entirely.
  await writeFile(path.join(root, "base.txt"), "target version\n", "utf8");
  await git(root, ["commit", "--no-gpg-sign", "-am", "target moved on without the shadow"]);
  // The gate rehearses the no-op stamp with the Shadow's own branch checked
  // out at `root` — the live/shared checkout, not a dedicated worktree.
  await git(root, ["checkout", "shadow"]);

  const bracket = await plantAmbientDirtAndBracket(root);

  const published = await stampNoopDelivery(
    "shadow",
    root,
    "main",
    "no-op delivery for shadow",
    dataDir,
  );
  assert.ok(published, "the no-op stamp must still publish a commit");

  await assertBracketUnchanged(root, bracket);

  // The stamp really did land on the Shadow's own branch, not just get
  // reported as if it had.
  const shadowLog = await git(root, ["log", "-1", "--format=%s", "shadow"]);
  assert.equal(shadowLog, "no-op delivery for shadow");
});
