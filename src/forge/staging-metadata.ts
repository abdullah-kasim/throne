import type { ForgejoApi } from "./forgejo-api.ts";
import { editForgejoConversationComment, readForgejoConversation, type ForgejoConversationComment } from "./forgejo-feedback.ts";
import {
  FORGEJO_PAGE_LIMIT,
  issueApiPath,
  readOpenPullRequestRecords,
  type ForgejoPullRequestAddress,
} from "./forgejo-pull-requests.ts";
import { forgejoCopyNamed, forgejoTokenUserLogin } from "./forgejo-repository.ts";
import {
  EMPTY_STAGING_SYNC,
  githubTwinIn,
  githubTwinRecord,
  stagingSyncIn,
  stagingSyncRecord,
  type StagingSync,
} from "./staging-records.ts";

const GITHUB_LINK_LABEL = "GitHub: ";

export interface StagingMetadata {
  readonly githubUrl: string;
  readonly sync: StagingSync;
}

export interface StagingMetadataComment extends StagingMetadata {
  readonly id: number;
}

export interface StagedForgejoPullRequest {
  readonly forgejoUrl: string;
  readonly githubUrl: string;
}

export function stagingMetadataCommentBody(metadata: StagingMetadata): string {
  return `${GITHUB_LINK_LABEL}${metadata.githubUrl}\n\n${githubTwinRecord(metadata.githubUrl)}\n${stagingSyncRecord(metadata.sync)}\n`;
}

function isStagingMetadataComment(comment: ForgejoConversationComment, courtLogin: string): boolean {
  return comment.author === courtLogin && githubTwinIn(comment.body) !== undefined;
}

async function readStagingMetadataCommentWrittenBy(
  address: ForgejoPullRequestAddress,
  courtLogin: string,
  api: ForgejoApi,
): Promise<StagingMetadataComment | undefined> {
  const conversation = await readForgejoConversation(address, api);
  const comment = conversation.find((candidate) => isStagingMetadataComment(candidate, courtLogin));
  if (comment === undefined) return undefined;
  return { id: comment.id, githubUrl: githubTwinIn(comment.body)!, sync: stagingSyncIn(comment.body) };
}

export async function readStagingMetadataComment(
  address: ForgejoPullRequestAddress,
  api: ForgejoApi,
): Promise<StagingMetadataComment | undefined> {
  return readStagingMetadataCommentWrittenBy(address, await forgejoTokenUserLogin(api), api);
}

export async function writeStagingMetadataComment(
  address: ForgejoPullRequestAddress,
  githubUrl: string,
  syncChanges: Partial<StagingSync>,
  api: ForgejoApi,
): Promise<number> {
  const recorded = await readStagingMetadataComment(address, api);
  const sync = { ...(recorded?.sync ?? EMPTY_STAGING_SYNC), ...syncChanges };
  const body = stagingMetadataCommentBody({ githubUrl, sync });
  if (recorded === undefined) {
    return (await api.sendJson<{ id: number }>("POST", `${issueApiPath(address)}/comments`, { body })).id;
  }
  await editForgejoConversationComment(address, recorded.id, body, api);
  return recorded.id;
}

export async function stagedPullRequestsInForgejoCopy(repositoryName: string, api: ForgejoApi): Promise<StagedForgejoPullRequest[]> {
  const repository = await forgejoCopyNamed(repositoryName, api);
  const open = await readOpenPullRequestRecords(repository, FORGEJO_PAGE_LIMIT, api);
  const staged: StagedForgejoPullRequest[] = [];
  for (const record of open) {
    const metadata = await readStagingMetadataCommentWrittenBy({ repository, number: record.number }, repository.owner, api);
    if (metadata !== undefined) staged.push({ forgejoUrl: record.html_url, githubUrl: metadata.githubUrl });
  }
  return staged;
}
