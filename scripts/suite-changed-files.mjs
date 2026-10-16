import { spawnSync } from "node:child_process";

export const CHANGED_FILES_ENVIRONMENT_VARIABLE = "THRONE_SUITE_CHANGED_FILES";
export const LINT_EVERYTHING = Object.freeze({ lintEverything: true });

function readGitLines(repositoryRoot, gitArguments) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...gitArguments], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.split("\n").filter((line) => line !== "");
}

export function listFilesChangedAgainstMain(repositoryRoot) {
  const mergeBase = readGitLines(repositoryRoot, ["merge-base", "main", "HEAD"]);
  if (mergeBase === undefined || mergeBase.length !== 1) return undefined;
  const changedTrackedFiles = readGitLines(repositoryRoot, ["diff", "--name-only", "--diff-filter=d", mergeBase[0]]);
  const untrackedFiles = readGitLines(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (changedTrackedFiles === undefined || untrackedFiles === undefined) return undefined;
  return [...new Set([...changedTrackedFiles, ...untrackedFiles])].sort();
}

export function formatChangedFilesForEnvironment(changedFiles) {
  return changedFiles === undefined ? {} : { [CHANGED_FILES_ENVIRONMENT_VARIABLE]: JSON.stringify(changedFiles) };
}

export function chooseLintTargets(environmentValue) {
  if (environmentValue === undefined) return LINT_EVERYTHING;
  try {
    const changedFiles = JSON.parse(environmentValue);
    const isListOfPaths = Array.isArray(changedFiles) && changedFiles.every((file) => typeof file === "string");
    return isListOfPaths ? { lintEverything: false, files: changedFiles } : LINT_EVERYTHING;
  } catch {
    return LINT_EVERYTHING;
  }
}

export function createLintArguments(lintTargets) {
  return lintTargets.lintEverything ? ["."] : ["--no-warn-ignored", "--no-error-on-unmatched-pattern", ...lintTargets.files];
}
