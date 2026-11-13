import path from "node:path";
import { readdir } from "node:fs/promises";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { readGitStatus } from "../git-lifecycle/git-command.service.ts";
import { durableDefaultBranch, localBranchTip } from "../git-lifecycle/branch-authority.ts";
import { findCommitWithIdenticalTree, isAncestor } from "../git-lifecycle/delivery.ts";
import { repositoryIsYolo, YOLO_KEY } from "../forge/repository-yolo.ts";
import { latestPlanBundle, readEvidenceText } from "../amendment/reconciliation-evidence.ts";
import type { SliceEvidenceResult } from "./agent-evidence-gate.ts";

const DELIVERY_RECORD_PREFIX = "99c_";
const DELIVERY_RECORD_LINE = "**Delivery outcome:** PASS at <full sha>";
const DELIVERED_COMMIT_PATTERN = /^\*\*Delivery outcome:\*\* PASS at ([0-9a-f]{40})\s*$/m;

export async function checkYoloCampaignOnOriginDefault(
  alpha: string,
  baseDir: string,
): Promise<SliceEvidenceResult> {
  const repo = (await TREE_BASE_DATA.read(alpha, baseDir))?.repo;
  if (repo === undefined) return { ok: true };
  let missing: string | undefined;
  try {
    if (!(await repositoryIsYolo(repo))) return { ok: true };
    missing = await describeCampaignMissingFromOriginDefault(repo, alpha, baseDir);
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error);
  }
  if (missing === undefined) return { ok: true };
  return { ok: false, reason: "delivery-not-proven", detail: missing };
}

async function describeCampaignMissingFromOriginDefault(
  repo: string,
  alpha: string,
  baseDir: string,
): Promise<string | undefined> {
  const originFetch = await readGitStatus(["fetch", "origin"], repo);
  if (originFetch.code !== 0) {
    return `\`git fetch origin\` failed in ${repo} (${originFetch.stderr.trim() || `git exited ${originFetch.code}`}), so the campaign cannot be shown to be on origin`;
  }
  const defaultBranch = await durableDefaultBranch(repo);
  const originDefault = `origin/${defaultBranch}`;
  const head = await localBranchTip(repo, alpha);
  const originTip = (
    await readGitStatus(["rev-parse", "--verify", "--quiet", `refs/remotes/${originDefault}`], repo)
  ).stdout.trim();
  const remedy = `merge the campaign into ${defaultBranch} and \`git push origin ${defaultBranch}\``;
  if (head === undefined) {
    return `${repo} sets ${YOLO_KEY}, but its campaign branch "${alpha}" does not exist, so its head cannot be shown to be on ${originDefault}; ${remedy}`;
  }
  const deliveredHead = originTip === "" ? undefined : await deliveredPartOfCampaign(repo, head, originTip);
  if (deliveredHead === undefined) {
    return (
      `${repo} sets ${YOLO_KEY}, but campaign head ${head} ("${alpha}") ` +
      `is not on ${originDefault} (tip ${originTip || "missing"}); ${remedy}`
    );
  }
  const recordFile = await findDeliveryRecordFile(alpha, baseDir);
  if (recordFile === undefined) {
    return `${repo} sets ${YOLO_KEY}, but "${alpha}" has no delivery record holding "${DELIVERY_RECORD_LINE}"`;
  }
  const recorded = readDeliveredCommit(await readEvidenceText(recordFile));
  if (recorded === undefined) {
    return `${recordFile} does not hold "${DELIVERY_RECORD_LINE}" on its own line, naming the commit pushed to ${originDefault}`;
  }
  if (!(await isAncestor(repo, deliveredHead, recorded))) {
    return `${recordFile} names ${recorded}, which does not contain campaign head ${deliveredHead} ("${alpha}")`;
  }
  if (!(await isAncestor(repo, recorded, originTip))) {
    return `${recordFile} names ${recorded}, which is not on ${originDefault} (tip ${originTip}); ${remedy}`;
  }
  return undefined;
}

async function deliveredPartOfCampaign(repo: string, head: string, originTip: string): Promise<string | undefined> {
  const sharedBase = await readGitStatus(["merge-base", head, originTip], repo);
  if (sharedBase.code !== 0) return undefined;
  const deliveredHead = sharedBase.stdout.trim();
  const changesAfterOrigin = await readGitStatus(["diff", "--quiet", deliveredHead, head], repo);
  if (changesAfterOrigin.code === 1) return findCommitWithIdenticalTree(repo, head, originTip);
  if (changesAfterOrigin.code !== 0) {
    throw new Error(
      `cannot compare campaign head ${head} against ${deliveredHead}: ` +
        `${changesAfterOrigin.stderr.trim() || `git exited ${changesAfterOrigin.code}`}`,
    );
  }
  return deliveredHead;
}

async function findDeliveryRecordFile(alpha: string, baseDir: string): Promise<string | undefined> {
  const ledger = path.join(baseDir, alpha);
  const bundle = await latestPlanBundle(ledger);
  if (bundle === undefined) return undefined;
  const record = (await readdir(path.join(ledger, bundle)))
    .filter((entry) => entry.startsWith(DELIVERY_RECORD_PREFIX) && entry.endsWith(".md"))
    .sort()
    .at(0);
  return record === undefined ? undefined : path.join(ledger, bundle, record);
}

function readDeliveredCommit(recordText: string): string | undefined {
  return DELIVERED_COMMIT_PATTERN.exec(recordText)?.[1];
}
