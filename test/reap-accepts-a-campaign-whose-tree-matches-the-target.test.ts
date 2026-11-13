import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { git, initRepo } from "./git-repo-test-fixture.ts";
import {
  deleteBranchCleanup,
  describeRetention,
  preflightBranchCleanup,
} from "../src/git-lifecycle/branch-cleanup.ts";
import { localBranchTip } from "../src/git-lifecycle/branch-authority.ts";
import { YOLO_KEY } from "../src/forge/repository-yolo.ts";
import { checkYoloCampaignOnOriginDefault } from "../src/slice-evidence/origin-delivery.ts";
import { checkOwnWorktreeCommittedPrecondition } from "../src/slice-evidence/agent-evidence-gate.ts";
import { requireLiveReapabilityClaim } from "../src/reap-agent/reapability-claim.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import type { ReapDeps, ReapRequest } from "../src/reap-agent/reap-agent.types.ts";

const CAMPAIGN = "alpha-treematch-01";
const scratchFolders: string[] = [];

after(async () => {
  await Promise.all(scratchFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

interface Campaign {
  repo: string;
  spawnCommit: string;
  campaignTip: string;
  squashCommit: string;
  dataDir: string;
}

async function buildSquashedCampaign(
  options: { pushed: boolean; targetContent?: string },
): Promise<Campaign> {
  const repo = await initRepo("reap-tree-match-");
  const origin = await mkdtemp(path.join(tmpdir(), "reap-tree-match-origin-"));
  const dataDir = await mkdtemp(path.join(tmpdir(), "reap-tree-match-data-"));
  scratchFolders.push(repo, origin, dataDir);
  await git(origin, ["init", "--bare", "-b", "main"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "origin", "main"]);
  await git(repo, ["fetch", "-q", "origin"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const spawnCommit = await git(repo, ["rev-parse", "HEAD"]);

  await git(repo, ["switch", "-q", "-c", CAMPAIGN]);
  await writeFile(path.join(repo, "feature.txt"), "first\n", "utf8");
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "-q", "--no-gpg-sign", "-m", "Start the feature"]);
  await writeFile(path.join(repo, "feature.txt"), "first\nsecond\n", "utf8");
  await git(repo, ["commit", "-q", "--no-gpg-sign", "-am", "Finish the feature"]);
  const campaignTip = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["switch", "-q", "main"]);

  await writeFile(path.join(repo, "feature.txt"), options.targetContent ?? "first\nsecond\n", "utf8");
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "-q", "--no-gpg-sign", "-m", "Add the feature in one step"]);
  const squashCommit = await git(repo, ["rev-parse", "HEAD"]);
  if (options.pushed) {
    await git(repo, ["push", "-q", "origin", "main"]);
  }
  return { repo, spawnCommit, campaignTip, squashCommit, dataDir };
}

async function writeYoloLedger(campaign: Campaign, recordedCommit: string): Promise<void> {
  await git(campaign.repo, ["config", YOLO_KEY, "true"]);
  const ledger = path.join(campaign.dataDir, CAMPAIGN);
  const bundle = path.join(ledger, "todo-2026-11-11-0000-fixture");
  await mkdir(bundle, { recursive: true });
  await writeFile(
    path.join(ledger, "tree-base.json"),
    JSON.stringify({ name: CAMPAIGN, branch: "main", commit: campaign.spawnCommit, repo: campaign.repo }),
    "utf8",
  );
  await writeFile(
    path.join(bundle, "99c_deliver_fixture.md"),
    `# Deliver\n\n**Delivery outcome:** PASS at ${recordedCommit}\n`,
    "utf8",
  );
}

function plan(campaign: Campaign) {
  return preflightBranchCleanup(CAMPAIGN, campaign.repo, "main", false, campaign.spawnCommit);
}

test("reap still refuses a campaign whose work is not on the target", async () => {
  const campaign = await buildSquashedCampaign({ pushed: true, targetContent: "something else\n" });
  await assert.rejects(plan(campaign), /not reachable from its recorded merge-target branch "main"[\s\S]*--force/);
});

test("a squashed campaign whose tree matches the target is reaped without --force", async () => {
  const campaign = await buildSquashedCampaign({ pushed: true });
  await writeYoloLedger(campaign, campaign.squashCommit);

  assert.deepEqual(await checkYoloCampaignOnOriginDefault(CAMPAIGN, campaign.dataDir), { ok: true });

  const cleanup = await plan(campaign);
  assert.equal(cleanup.status, "ready");
  if (cleanup.status !== "ready") return;
  assert.deepEqual(cleanup.retention, { kind: "identical-tree", commit: campaign.squashCommit, onOrigin: true });
  assert.equal(describeRetention(cleanup), ` (its tree is identical to ${campaign.squashCommit}, on origin/main)`);
  assert.equal(await deleteBranchCleanup(cleanup), true);
  assert.equal(await localBranchTip(campaign.repo, CAMPAIGN), undefined);
});

test("an unpushed merge with a matching tree is reaped without --force and is reported as local only", async () => {
  const campaign = await buildSquashedCampaign({ pushed: false });

  const cleanup = await plan(campaign);
  assert.equal(cleanup.status, "ready");
  if (cleanup.status !== "ready") return;
  assert.deepEqual(cleanup.retention, { kind: "identical-tree", commit: campaign.squashCommit, onOrigin: false });
  assert.equal(
    describeRetention(cleanup),
    ` (its tree is identical to ${campaign.squashCommit}, on local main only, not on origin)`,
  );
  assert.doesNotMatch(describeRetention(cleanup), /on origin\//);

  await writeYoloLedger(campaign, campaign.squashCommit);
  const yolo = await checkYoloCampaignOnOriginDefault(CAMPAIGN, campaign.dataDir);
  assert.equal(yolo.ok, false);

  assert.equal(await deleteBranchCleanup(cleanup), true);
});

test("a campaign one byte away from the target is still refused and the refusal names --force", async () => {
  const campaign = await buildSquashedCampaign({ pushed: true, targetContent: "first\nsecond!\n" });
  await assert.rejects(plan(campaign), /rerun with --force/);

  await writeYoloLedger(campaign, campaign.squashCommit);
  const yolo = await checkYoloCampaignOnOriginDefault(CAMPAIGN, campaign.dataDir);
  assert.equal(yolo.ok, false);
});

test("a campaign whose tree changed after preflight is not deleted", async () => {
  const campaign = await buildSquashedCampaign({ pushed: true });
  const cleanup = await plan(campaign);
  assert.equal(cleanup.status, "ready");
  if (cleanup.status !== "ready") return;
  await git(campaign.repo, ["reset", "-q", "--hard", campaign.spawnCommit]);
  await assert.rejects(deleteBranchCleanup(cleanup), /no longer has a tree identical/);
  assert.equal(await localBranchTip(campaign.repo, CAMPAIGN), campaign.campaignTip);
});

test("a campaign with uncommitted changes is still refused", async () => {
  const campaign = await buildSquashedCampaign({ pushed: true });
  const worktree = path.join(path.dirname(campaign.repo), `${path.basename(campaign.repo)}-campaign`);
  scratchFolders.push(worktree);
  await git(campaign.repo, ["worktree", "add", "-q", worktree, CAMPAIGN]);
  await writeFile(path.join(worktree, "feature.txt"), "first\nsecond\nunsaved\n", "utf8");
  const ledger = path.join(campaign.dataDir, CAMPAIGN);
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, "spawn.json"), JSON.stringify({ harness: "claude", model: "opus", effort: 3, cwd: worktree }), "utf8");
  await writeFile(
    path.join(ledger, "tree-base.json"),
    JSON.stringify({ name: CAMPAIGN, branch: "main", commit: campaign.spawnCommit, repo: campaign.repo }),
    "utf8",
  );

  const committed = await checkOwnWorktreeCommittedPrecondition(CAMPAIGN, campaign.dataDir);
  assert.equal(committed.ok, false);
  assert.equal(committed.ok === false && committed.reason, "own-worktree-dirty");
});

test("a matching tree does not stand in for the agent's own reapability claim", async () => {
  const campaign = await buildSquashedCampaign({ pushed: true });
  const cleanup = await plan(campaign);
  assert.equal(cleanup.status === "ready" && cleanup.retention.kind, "identical-tree");

  const request = { name: CAMPAIGN, reason: "completed", force: false } as unknown as ReapRequest;
  const deps = { readAgent: async () => "finished, tree is on main" } as unknown as ReapDeps;
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(await requireLiveReapabilityClaim(request, {} as HerdrAgent, deps), false);
  } finally {
    process.stderr.write = originalWrite;
  }
});
