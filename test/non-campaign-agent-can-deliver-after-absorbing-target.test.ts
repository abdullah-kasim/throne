// A hard deadlock, hit live on 2026-08-25 and self-trapping.
//
// `markDeliveryValidationRequired` threw when the delivering agent had no
// objective_code. A non-campaign agent — a Stager, a canary, any
// infrastructure worker — correctly has none, so the moment its branch
// absorbed target content it could never deliver: merge-git-tree refused with
// 'has no objective_code; cannot persist validation-required'. The first
// agent to hit it was a Stager whose branch had absorbed main mid-flight, and
// it could not ship the fix, because shipping the fix required the delivery
// the bug was blocking.
//
// The distinction the throw collapsed: "this delivery needs no queue
// bookkeeping" is not "this delivery is impossible".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDeliveryValidationRequired } from "../src/merge-git-tree/merge-git-tree-transaction.ts";

async function dataDirWithSpawn(spawn: object | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "noncampaign-delivery-"));
  if (spawn !== undefined) {
    await mkdir(join(dir, "stager-floor"), { recursive: true });
    await writeFile(
      join(dir, "stager-floor", "spawn.json"),
      JSON.stringify(spawn),
      "utf8",
    );
  }
  return dir;
}

test("an agent with no objective_code marks nothing and does NOT throw", async () => {
  // Exactly the live spawn.json shape: harness/model/effort/cwd, no
  // objective_code, because it is not a campaign.
  const dir = await dataDirWithSpawn({
    harness: "claude",
    model: "opus",
    effort: 1,
    // A representative Stager worktree path. Deliberately not a real one:
    // this repo is bound for public release and lint:private-refs bans host
    // home paths. The test only needs the FIELD to be present and non-empty.
    cwd: "/home/example/.throne/worktrees/throne/stager-floor",
    spawned_at: "2026-08-24T16:27:44.104Z",
  });
  try {
    await assert.doesNotReject(
      markDeliveryValidationRequired("stager-floor", dir),
      "a non-campaign delivery has no queue row to mark; that is not a failure",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an agent with no spawn record at all is also not a failure", async () => {
  const dir = await dataDirWithSpawn(undefined);
  try {
    await assert.doesNotReject(markDeliveryValidationRequired("stager-floor", dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// NOT TESTED HERE, AND SAID PLAINLY RATHER THAN FAKED: that the
// validation-required NOTIFICATION still fires for a non-campaign absorb.
//
// That property lives in `merge-git-tree-runtime.ts`, where the notify call
// is sequenced after the mark and is NOT conditional on it having persisted
// anything — so a no-op mark cannot suppress it. Asserting it honestly means
// driving the real runtime through a real absorb, which needs a git repo, an
// agent ledger, and a delivery target; a version stubbed down to the point of
// cheapness would assert only that the stubs were called in the order the
// test itself called them, which is the shape of test that passes whatever
// the production code does.
//
// So it is covered by structure and by review, not by this suite. If the
// notify call is ever moved inside a conditional, nothing here will catch it.
