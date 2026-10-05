import path from "node:path";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";
import { queueRowEffortFlags } from "./queue-row-effort-flags.ts";

export function publishedCliEntrypoint(repoRoot: string): string {
  return path.join(repoRoot, "dist", "src", "tools.js");
}

export function spawnGitTreeArguments(
  cliEntrypoint: string,
  candidate: LaunchQueueCandidate,
): string[] {
  return [
    cliEntrypoint,
    "spawn-git-tree",
    candidate.name,
    "--repo",
    candidate.targetRepo,
    "--base",
    candidate.baseCommit,
    "--target-branch",
    candidate.targetBranch,
    ...(candidate.createTargetFromBranch === undefined
      ? []
      : ["--create-target-from", candidate.createTargetFromBranch]),
  ];
}

export function createAlphaArguments(
  cliEntrypoint: string,
  candidate: LaunchQueueCandidate,
  authorizedBypassFlags: readonly string[],
  candidateCwd: string,
): string[] {
  return [
    cliEntrypoint,
    "create-agent",
    "--model",
    candidate.model,
    ...authorizedBypassFlags,
    ...queueRowEffortFlags(candidate.effort),
    ...(candidate.modelHint === null || candidate.modelHint === undefined
      ? []
      : ["--model-hint", `${candidate.modelHint.harness}/${candidate.modelHint.model}`]),
    ...(candidate.deliverableShape === null || candidate.deliverableShape === undefined
      ? []
      : ["--deliverable-shape", candidate.deliverableShape]),
    ...(candidate.sliceless === true ? ["--sliceless"] : []),
    ...(candidate.shadowless === true || candidate.sliceless === true ? ["--shadowless"] : []),
    "--role",
    "Alpha",
    "--supervisor",
    "Regent",
    "--cwd",
    candidateCwd,
    "--name",
    candidate.name,
    "--objective-code",
    candidate.objectiveCode,
    "--prompt",
    candidate.objective,
  ];
}
