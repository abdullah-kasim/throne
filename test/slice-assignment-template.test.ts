import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderSliceAssignment } from "../src/slice-assignment/slice-assignment-template.ts";
import { formatReapabilityClaim } from "../src/reap-agent/reapability-claim.ts";
import { hasDeliveryCommit } from "../src/git-lifecycle/delivery-commit-proof.ts";
import { git, initRepo } from "./git-repo-test-fixture.ts";

test("rendered slice assignment instructs both the confirmation path and the delivery-commit fallback", () => {
  const rendered = renderSliceAssignment("# 01 — do the thing\n\nbody text\n");
  assert.match(rendered, /merge-confirmation message/);
  assert.match(rendered, /hasDeliveryCommit/);
  assert.match(
    rendered,
    new RegExp(
      formatReapabilityClaim("completed").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
});

test("a verdict-only Shadow with no Deliver commit on its first turn does not satisfy the delivery-commit fallback", async () => {
  const shadowName = "shadow-gvs-02-fixture-no-commit";
  const repo = await initRepo("gvs-slice-02-no-commit-");
  try {
    const satisfied = await hasDeliveryCommit(shadowName, repo);
    assert.equal(satisfied, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the same fallback turns true once this Shadow's own Deliver commit lands", async () => {
  const shadowName = "shadow-gvs-02-fixture-delivered";
  const repo = await initRepo("gvs-slice-02-delivered-");
  try {
    await writeFile(path.join(repo, "delivered.txt"), "delivered\n", "utf8");
    await git(repo, ["add", "delivered.txt"]);
    await git(repo, [
      "commit",
      "--no-gpg-sign",
      "-m",
      `Deliver ${shadowName}`,
    ]);
    const satisfied = await hasDeliveryCommit(shadowName, repo);
    assert.equal(satisfied, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
