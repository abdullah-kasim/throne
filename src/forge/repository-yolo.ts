import { runForgeProcess, type ProcessRunner } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";

export const YOLO_KEY = "throne.yolo";
const GIT_CONFIG_KEY_UNSET_EXIT_CODE = 1;
const GIT_TRUE = "true";

export async function repositoryIsYolo(repo: string, runProcess: ProcessRunner = runForgeProcess): Promise<boolean> {
  const result = await runProcess("git", ["config", "--type=bool", "--get", YOLO_KEY], { cwd: repo });
  if (result.exitCode === GIT_CONFIG_KEY_UNSET_EXIT_CODE) return false;
  if (result.exitCode !== 0) {
    throw new ForgeRefusal(`git could not read ${YOLO_KEY} as true or false in ${repo} (exit ${result.exitCode}): ${result.stderr.trim()}. Nothing was changed.`);
  }
  return result.stdout.trim() === GIT_TRUE;
}
