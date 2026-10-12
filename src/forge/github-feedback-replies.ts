import type { ForgeDependencies, ProcessResult } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { GITHUB_FEEDBACK_KIND, type GithubFeedbackItem, type GithubRepository } from "./github-feedback.ts";
import { runGithub } from "./github-pull-requests.ts";
import { githubProgramForHost } from "./pull-request-forge.ts";

async function runAuthorizedGithub(
  repository: GithubRepository,
  args: readonly string[],
  repo: string,
  dependencies: ForgeDependencies,
): Promise<ProcessResult> {
  const program = githubProgramForHost(repository.host);
  const result = await runGithub(args, { program, repo, bypass: true }, dependencies);
  if (result.exitCode !== 0) throw new ForgeRefusal(`${program} ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
  return result;
}

function repositoryApiPath(repository: GithubRepository): string {
  return `repos/${repository.owner}/${repository.repo}`;
}

export async function replyOnGithub(
  repository: GithubRepository,
  item: GithubFeedbackItem,
  body: string,
  repo: string,
  dependencies: ForgeDependencies,
): Promise<void> {
  const args =
    item.kind === GITHUB_FEEDBACK_KIND.thread
      ? ["api", `${repositoryApiPath(repository)}/pulls/${item.pullRequestNumber}/comments`, "-f", `body=${body}`, "-F", `in_reply_to=${item.id}`]
      : ["api", `${repositoryApiPath(repository)}/issues/${item.pullRequestNumber}/comments`, "-f", `body=${body}`];
  await runAuthorizedGithub(repository, args, repo, dependencies);
}

export async function resolveGithubThread(
  repository: GithubRepository,
  threadId: string,
  repo: string,
  dependencies: ForgeDependencies,
): Promise<void> {
  const mutation = `mutation { resolveReviewThread(input:{threadId:"${threadId}"}) { thread { isResolved } } }`;
  await runAuthorizedGithub(repository, ["api", "graphql", "-f", `query=${mutation}`], repo, dependencies);
}
