import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import type { TreeMergeTarget } from "./merge-git-tree-contracts.ts";

export type ReportBackedNoChangeDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string };

function identityField(body: string, label: string): string | undefined {
  const prefix = `- **${label}:** `;
  return body
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function validInstant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

export async function decideReportBackedNoChangePublication(
  name: string,
  dataDir: string,
  target: TreeMergeTarget,
): Promise<ReportBackedNoChangeDecision> {
  if (name === "" || path.basename(name) !== name) {
    return { accepted: false, reason: "agent name is not a ledger basename" };
  }
  const agentDir = path.join(dataDir, name);
  const reportPath = path.join(agentDir, "REPORT.md");
  let reportBytes: Buffer;
  let reportModifiedAt: number;
  let identity: string;
  try {
    const reportStat = await lstat(reportPath);
    if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
      return {
        accepted: false,
        reason: "REPORT.md is not a regular ledger file",
      };
    }
    [reportBytes, identity] = await Promise.all([
      readFile(reportPath),
      readFile(path.join(agentDir, "identity.md"), "utf8"),
    ]);
    reportModifiedAt = reportStat.mtimeMs;
  } catch {
    return {
      accepted: false,
      reason: "REPORT.md or identity.md is missing or unreadable",
    };
  }
  let report: string;
  try {
    report = new TextDecoder("utf-8", { fatal: true }).decode(reportBytes);
  } catch {
    return { accepted: false, reason: "REPORT.md is not valid UTF-8" };
  }
  if (report.trim() === "" || !/^#\s+\S/m.test(report)) {
    return {
      accepted: false,
      reason: "REPORT.md is empty or not parseable Markdown",
    };
  }
  const [spawn, tree] = await Promise.all([
    readSpawnSpec(name, dataDir),
    TREE_BASE_DATA.read(name, dataDir),
  ]);
  if (spawn === null || tree === null) {
    return {
      accepted: false,
      reason: "spawn.json or tree-base.json is missing or malformed",
    };
  }
  const identityName = /^# Identity — (.+)$/m.exec(identity)?.[1]?.trim();
  const supervisor = identityField(identity, "Supervisor (routine)");
  const objectiveCode = identityField(identity, "Campaign objective code");
  if (identityName !== name || tree.name !== name) {
    return {
      accepted: false,
      reason: "identity or tree evidence belongs to another agent",
    };
  }
  if (
    supervisor !== tree.base ||
    tree.branch !== target.branch ||
    tree.repo !== target.repo
  ) {
    return {
      accepted: false,
      reason: "supervision or merge-target evidence is contradictory",
    };
  }
  if (
    spawn.objective_code === undefined ||
    objectiveCode !== spawn.objective_code
  ) {
    return {
      accepted: false,
      reason: "campaign objective evidence is missing or contradictory",
    };
  }
  const spawnedAt = validInstant(spawn.spawned_at);
  const treeNotedAt = validInstant(tree.notedAt);
  if (
    spawnedAt === undefined ||
    treeNotedAt === undefined ||
    reportModifiedAt < Math.max(spawnedAt, treeNotedAt)
  ) {
    return {
      accepted: false,
      reason: "REPORT.md predates its authoritative spawn or tree record",
    };
  }
  return { accepted: true };
}
