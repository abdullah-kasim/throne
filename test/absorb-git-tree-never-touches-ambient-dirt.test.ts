// Requirement: absorb-git-tree MUST NEVER touch uncommitted state in the
// live target repo it does not own — on EITHER outcome path (a real absorb
// that lands a new merge commit, and an already-landed no-op that only has
// to stamp the Shadow's own branch). A gate rehearsing an absorb runs it
// directly against the shared/live checkout (`root`), which can legitimately
// have a DIFFERENT campaign's uncommitted work sitting in it at the moment
// the Shadow's own branch happens to be checked out there. This reproduces
// that exact shape and proves a pre-op bracket (tracked diff + untracked
// file content) survives byte-identical across the call, on both paths —
// the reported defect only showed up on the no-op path, so a test that only
// exercises the real-absorb path would miss it entirely.
//
// This calls `absorbAndStamp` — the function that does the work — directly,
// never the CLI binary.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { git, initRepo } from "./git-repo-test-fixture.ts";
import { absorbAndStamp } from "../src/git-lifecycle/absorb-and-stamp.ts";

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

/** Dirties `root`'s current checkout the way a DIFFERENT, unrelated
 *  campaign's in-progress work would: modifies a tracked file — with an
 *  edit that lands on the SAME line the absorb/stamp's own tree content
 *  moves, so a stash-pop restore of it genuinely conflicts (this is the
 *  shape that trips the buggy fallback: a clean stash pop hides the defect
 *  entirely, since only a real conflict forces the "just `reset --quiet`
 *  and give up" path) — and drops two new untracked files under paths that
 *  mirror the reported incident (`src/agentdata`, `src/no-idling`). Returns
 *  a bracket — the tracked diff plus a `path -> content` map of the
 *  untracked files — captured the same way the reporting gate captured its
 *  pre-op evidence. */
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

test("absorb-git-tree leaves a real absorb's ambient dirt in the checked-out shadow branch untouched", async () => {
  const root = await newScratchRoot("throne-absorb-real-");
  await git(root, ["branch", "shadow"]);
  // Alpha diverges from the Shadow's branch on `base.txt` — this is what
  // makes the stamp's tree genuinely differ from what the Shadow checkout
  // has on disk, so restoring the ambient dirt after the stamp's
  // stash/reset actually has something to conflict with. A same-content
  // reset makes even the buggy stash-pop restore trivially succeed and
  // would hide the defect entirely.
  await git(root, ["checkout", "-b", "alpha"]);
  await writeFile(path.join(root, "base.txt"), "alpha version\n", "utf8");
  await git(root, ["commit", "--no-gpg-sign", "-am", "alpha diverges"]);
  // Target ("main") gains a commit the alpha branch does not have yet, so
  // the absorb is a genuine merge, not a no-op.
  await git(root, ["checkout", "main"]);
  await writeFile(path.join(root, "target.txt"), "target work\n", "utf8");
  await git(root, ["add", "target.txt"]);
  await git(root, ["commit", "--no-gpg-sign", "-m", "target work"]);
  // The gate rehearses the absorb with the Shadow's own branch checked out
  // at `root` — the live/shared checkout, not a dedicated worktree.
  await git(root, ["checkout", "shadow"]);

  const bracket = await plantAmbientDirtAndBracket(root);

  const result = await absorbAndStamp("shadow", root, "main", "alpha");
  assert.equal(result.absorbAlreadyLanded, false);
  assert.ok(result.absorbCommit, "a real absorb must land a merge commit");

  await assertBracketUnchanged(root, bracket);
});

test("absorb-git-tree leaves an already-landed no-op's ambient dirt in the checked-out shadow branch untouched", async () => {
  const root = await newScratchRoot("throne-absorb-noop-");
  // Alpha already contains everything target ("main") has — the absorb
  // itself is a no-op — but the Shadow's own branch has never been stamped,
  // so the stamp step still runs. This is the exact "already landed" shape
  // the incident reported: the corruption was on THIS path, not the
  // real-absorb one.
  await git(root, ["branch", "shadow"]);
  // Alpha diverges from the Shadow's branch on `base.txt` while remaining a
  // descendant of `main` (so target-into-alpha is still a genuine no-op) —
  // same reasoning as the real-absorb test above: without a genuine content
  // difference here, even the buggy restore path succeeds trivially and the
  // test can't tell a correct restore from a lucky one.
  await git(root, ["checkout", "-b", "alpha"]);
  await writeFile(path.join(root, "base.txt"), "alpha version\n", "utf8");
  await git(root, ["commit", "--no-gpg-sign", "-am", "alpha diverges"]);
  await git(root, ["checkout", "shadow"]);

  const bracket = await plantAmbientDirtAndBracket(root);

  const result = await absorbAndStamp("shadow", root, "main", "alpha");
  assert.equal(result.absorbAlreadyLanded, true);
  assert.equal(result.absorbCommit, undefined);
  assert.equal(result.stampAlreadyLanded, false);
  assert.ok(result.stampCommit, "the stamp must still land on the Shadow's own branch");

  await assertBracketUnchanged(root, bracket);

  // The stamp really did land on the Shadow's own branch, not just get
  // reported as if it had.
  const shadowLog = await git(root, ["log", "-1", "--format=%s", "shadow"]);
  assert.equal(shadowLog, "Deliver shadow");
});
