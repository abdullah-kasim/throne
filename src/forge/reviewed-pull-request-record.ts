import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { gitOutput } from "./forgejo-repository.ts";

const RECORD_FILE_NAME = "forge-open-pull-request";

async function recordPathOf(worktree: string, dependencies: ForgeDependencies): Promise<string | undefined> {
  const gitDirectory = await gitOutput(worktree, ["rev-parse", "--absolute-git-dir"], dependencies);
  return gitDirectory === undefined ? undefined : path.join(gitDirectory, RECORD_FILE_NAME);
}

export async function recordReviewedPullRequest(worktree: string, pullRequestUrl: string, dependencies: ForgeDependencies): Promise<void> {
  const recordPath = await recordPathOf(worktree, dependencies);
  if (recordPath === undefined) throw new ForgeRefusal(`${worktree} is not a git worktree, so the pull request it holds could not be recorded.`);
  await writeFile(recordPath, `${pullRequestUrl}\n`);
}

export async function recordedPullRequestOf(worktree: string, dependencies: ForgeDependencies): Promise<string | undefined> {
  const recordPath = await recordPathOf(worktree, dependencies);
  if (recordPath === undefined) return undefined;
  const recorded = (await readFile(recordPath, "utf8").catch(() => "")).trim();
  return recorded === "" ? undefined : recorded;
}
