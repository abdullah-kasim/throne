import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DELIVERY_EVIDENCE_DATA } from "../src/agentdata/delivery-evidence-data.service.ts";
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

test("the fallback stays false until this Shadow's own delivery is recorded", async () => {
  const shadowName = "shadow-gvs-02-fixture-delivered";
  const repo = await initRepo("gvs-slice-02-delivered-");
  const dataDir = await mkdtemp(path.join(tmpdir(), "gvs-slice-02-data-"));
  try {
    const root = await git(repo, ["rev-parse", "--show-toplevel"]);
    assert.equal(await hasDeliveryCommit(shadowName, root, dataDir), false);
    const commit = await git(repo, ["rev-parse", "HEAD"]);
    await DELIVERY_EVIDENCE_DATA.write(shadowName, { repo, targetBranch: "main", commit }, dataDir);
    assert.equal(await hasDeliveryCommit(shadowName, root, dataDir), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
