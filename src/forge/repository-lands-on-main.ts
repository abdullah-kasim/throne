import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";

export const LANDS_ON_MAIN_KEY = "throne.forge.landsOnMain";
const GIT_CONFIG_KEY_UNSET_EXIT_CODE = 1;
const GIT_TRUE = "true";

export async function repositoryLandsOnMain(repo: string, dependencies: ForgeDependencies): Promise<boolean> {
  const result = await dependencies.runProcess("git", ["config", "--type=bool", "--get", LANDS_ON_MAIN_KEY], { cwd: repo });
  if (result.exitCode === GIT_CONFIG_KEY_UNSET_EXIT_CODE) return false;
  if (result.exitCode !== 0) {
    throw new ForgeRefusal(`git could not read ${LANDS_ON_MAIN_KEY} as true or false in ${repo} (exit ${result.exitCode}): ${result.stderr.trim()}. Nothing was changed.`);
  }
  return result.stdout.trim() === GIT_TRUE;
}

export async function refuseUnlessRepositoryLandsOnMain(repo: string, dependencies: ForgeDependencies): Promise<void> {
  if (await repositoryLandsOnMain(repo, dependencies)) return;
  throw new ForgeRefusal(
    `${repo} does not set ${LANDS_ON_MAIN_KEY} to true in its git config, so its Forgejo pull requests are not landed on main; they reach GitHub through /pr-promote. Nothing was changed.`,
  );
}

export async function refuseGithubWriteWhereRepositoryLandsOnMain(repo: string, githubWrite: string, dependencies: ForgeDependencies): Promise<void> {
  if (!(await repositoryLandsOnMain(repo, dependencies))) return;
  throw new ForgeRefusal(
    `${repo} sets ${LANDS_ON_MAIN_KEY} to true, so its pull requests live only in Forgejo and land on main through \`throne forge land\` (/pr-merge or /pr-promote). ${githubWrite} was refused; nothing was sent to GitHub.`,
  );
}
