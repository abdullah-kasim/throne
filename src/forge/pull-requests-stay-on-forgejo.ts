import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";

export const PULL_REQUESTS_STAY_ON_FORGEJO_KEY = "throne.forge.pullRequestsStayOnForgejo";
export const RENAMED_LANDS_ON_MAIN_KEY = "throne.forge.landsOnMain";
const GIT_CONFIG_KEY_UNSET_EXIT_CODE = 1;
const GIT_TRUE = "true";

async function readBooleanKey(repo: string, key: string, dependencies: ForgeDependencies): Promise<boolean> {
  const result = await dependencies.runProcess("git", ["config", "--type=bool", "--get", key], { cwd: repo });
  if (result.exitCode === GIT_CONFIG_KEY_UNSET_EXIT_CODE) return false;
  if (result.exitCode !== 0) {
    throw new ForgeRefusal(`git could not read ${key} as true or false in ${repo} (exit ${result.exitCode}): ${result.stderr.trim()}. Nothing was changed.`);
  }
  return result.stdout.trim() === GIT_TRUE;
}

async function keyIsSet(repo: string, key: string, dependencies: ForgeDependencies): Promise<boolean> {
  const result = await dependencies.runProcess("git", ["config", "--get", key], { cwd: repo });
  return result.exitCode !== GIT_CONFIG_KEY_UNSET_EXIT_CODE;
}

export async function pullRequestsStayOnForgejo(repo: string, dependencies: ForgeDependencies): Promise<boolean> {
  if (await keyIsSet(repo, PULL_REQUESTS_STAY_ON_FORGEJO_KEY, dependencies)) return readBooleanKey(repo, PULL_REQUESTS_STAY_ON_FORGEJO_KEY, dependencies);
  if (!(await readBooleanKey(repo, RENAMED_LANDS_ON_MAIN_KEY, dependencies))) return false;
  throw new ForgeRefusal(
    `${repo} sets ${RENAMED_LANDS_ON_MAIN_KEY} to true, but that key was renamed to ${PULL_REQUESTS_STAY_ON_FORGEJO_KEY}; run \`git -C ${repo} config ${PULL_REQUESTS_STAY_ON_FORGEJO_KEY} true\` and \`git -C ${repo} config --unset ${RENAMED_LANDS_ON_MAIN_KEY}\`. Nothing was changed.`,
  );
}

export async function refuseUnlessPullRequestsStayOnForgejo(repo: string, dependencies: ForgeDependencies): Promise<void> {
  if (await pullRequestsStayOnForgejo(repo, dependencies)) return;
  throw new ForgeRefusal(
    `${repo} does not set ${PULL_REQUESTS_STAY_ON_FORGEJO_KEY} to true in its git config, so its Forgejo pull requests are not landed on main; they reach GitHub through /pr-promote. Nothing was changed.`,
  );
}

export async function refuseGithubWriteWherePullRequestsStayOnForgejo(repo: string, githubWrite: string, dependencies: ForgeDependencies): Promise<void> {
  if (!(await pullRequestsStayOnForgejo(repo, dependencies))) return;
  throw new ForgeRefusal(
    `${repo} sets ${PULL_REQUESTS_STAY_ON_FORGEJO_KEY} to true, so its pull requests stay on Forgejo and land on main through \`throne forge land\` (/pr-merge). ${githubWrite} was refused; nothing was sent to GitHub.`,
  );
}
