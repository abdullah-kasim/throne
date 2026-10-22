import { ForgeRefusal } from "./forge-refusal.ts";
import type { ForgejoApi } from "./forgejo-api.ts";
import { forgejoPullRequestAddressOf, type ForgejoPullRequestAddress } from "./forgejo-pull-requests.ts";
import { FORGE } from "./host-forge.ts";
import { decidePullRequestForge, parsePullRequestTarget } from "./pull-request-forge.ts";
import { openForgejoApiOnThisHost, type ForgeContext } from "./pull-request-operations.ts";
import { readStagingMetadataComment } from "./staging-metadata.ts";

export interface ForgejoPullRequest {
  readonly api: ForgejoApi;
  readonly address: ForgejoPullRequestAddress;
  readonly url: string;
}

export interface StagedPullRequest extends ForgejoPullRequest {
  readonly githubUrl: string;
}

export async function forgejoPullRequestFor(context: ForgeContext, targetText: string): Promise<ForgejoPullRequest> {
  const target = parsePullRequestTarget(targetText);
  const decision = await decidePullRequestForge(target, context.dependencies);
  if (decision.forge === FORGE.github) {
    throw new ForgeRefusal(
      `${targetText} is a GitHub pull request that was never staged or promoted: no Forgejo metadata comment links it (${decision.reason}). Stage it in Forgejo first with \`throne forge stage ${targetText}\`.`,
    );
  }
  const forgejoTarget = decision.twinUrl === undefined ? target : parsePullRequestTarget(decision.twinUrl);
  const api = await openForgejoApiOnThisHost(context.dependencies);
  const address = await forgejoPullRequestAddressOf(context.repo, forgejoTarget, api, context.dependencies);
  const url = `${api.rootUrl}${address.repository.owner}/${address.repository.name}/pulls/${address.number}`;
  return { api, address, url };
}

export async function githubTwinOf(pullRequest: ForgejoPullRequest): Promise<string | undefined> {
  return (await readStagingMetadataComment(pullRequest.address, pullRequest.api))?.githubUrl;
}

export async function stagedPullRequestFor(context: ForgeContext, targetText: string): Promise<StagedPullRequest> {
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  const githubUrl = await githubTwinOf(pullRequest);
  if (githubUrl === undefined) {
    throw new ForgeRefusal(
      `${pullRequest.url} has no metadata comment linking a GitHub pull request (it was never staged or promoted), so it has no GitHub feedback to work with.`,
    );
  }
  return { ...pullRequest, githubUrl };
}
