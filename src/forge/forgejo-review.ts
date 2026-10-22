import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";
import {
  editForgejoConversationComment,
  FEEDBACK_KIND,
  postForgejoConversationComment,
  postForgejoReview,
  readForgejoConversation,
  readForgejoFeedback,
  type ForgejoFeedbackItem,
} from "./forgejo-feedback.ts";
import { pullRequestApiPath, type ForgejoPullRequestRecord } from "./forgejo-pull-requests.ts";
import { textSafeForGithub } from "./github-bound-text.ts";
import type { ForgeContext } from "./pull-request-operations.ts";
import { refuseGithubWriteWhereRepositoryLandsOnMain } from "./repository-lands-on-main.ts";
import { forgejoPullRequestFor, stagedPullRequestFor, type ForgejoPullRequest } from "./staged-pair.ts";
import { holdsReviewRecord, REVIEW_RECORD_FORM, reviewRecord, withRecordAppended } from "./staging-records.ts";

const PENDING_REVIEW_SCRIPT_PATH = path.join(RUNTIME_THRONE_ROOT, ".claude", "skills", "pr-review", "pending-review.mjs");

export interface ReviewFinding {
  readonly path: string;
  readonly line: number;
  readonly body: string;
  readonly start_line?: number;
}

export interface ForgejoReviewResult {
  readonly reviewId: number;
  readonly reviewUrl: string;
  readonly copyCommentUrl: string;
  readonly head: string;
}

export interface ExportedReviewFindings {
  readonly count: number;
  readonly githubUrl: string;
}

async function readReviewFindings(commentsFile: string): Promise<ReviewFinding[]> {
  const script = (await import(pathToFileURL(PENDING_REVIEW_SCRIPT_PATH).href)) as { validateComments: (comments: unknown) => ReviewFinding[] };
  try {
    return script.validateComments(JSON.parse(await readFile(commentsFile, "utf8"))).map(({ path: filePath, line, body, start_line }) => ({
      path: filePath,
      line,
      body,
      ...(start_line === undefined ? {} : { start_line }),
    }));
  } catch (error) {
    throw new ForgeRefusal(`${commentsFile} is not a review comments file: ${messageOf(error)}. Nothing was written.`);
  }
}

function findingPlace(finding: ReviewFinding): string {
  return finding.start_line === undefined ? `${finding.path}:${finding.line}` : `${finding.path}:${finding.start_line}-${finding.line}`;
}

async function findingsSafeForGithub(context: ForgeContext, pullRequest: ForgejoPullRequest, findings: readonly ReviewFinding[]): Promise<ReviewFinding[]> {
  const safe: ReviewFinding[] = [];
  for (const finding of findings) {
    const body = await textSafeForGithub(finding.body, `the finding on ${findingPlace(finding)}`, pullRequest.api.rootUrl, context.dependencies);
    safe.push({ ...finding, body });
  }
  return safe;
}

export function copyPasteCommentBody(findings: readonly ReviewFinding[]): string {
  const sections = findings.map((finding) => `**\`${findingPlace(finding)}\`**\n\n${finding.body}`);
  return withRecordAppended(sections.join("\n\n---\n\n"), reviewRecord(REVIEW_RECORD_FORM.copy));
}

async function writeCopyPasteComment(pullRequest: ForgejoPullRequest, body: string): Promise<string> {
  const conversation = await readForgejoConversation(pullRequest.address, pullRequest.api);
  const existing = conversation.find((comment) => holdsReviewRecord(comment.body, REVIEW_RECORD_FORM.copy));
  const written =
    existing === undefined
      ? await postForgejoConversationComment(pullRequest.address, body, pullRequest.api)
      : await editForgejoConversationComment(pullRequest.address, existing.id, body, pullRequest.api);
  return written.url;
}

export async function reviewOnForgejo(context: ForgeContext, targetText: string, commentsFile: string): Promise<ForgejoReviewResult> {
  const findings = await readReviewFindings(commentsFile);
  const pullRequest = await forgejoPullRequestFor(context, targetText);
  const safeFindings = await findingsSafeForGithub(context, pullRequest, findings);
  const head = (await pullRequest.api.readJson<ForgejoPullRequestRecord>(pullRequestApiPath(pullRequest.address))).head.sha;
  const reviewComments = safeFindings.map((finding) => ({
    place: { path: finding.path, line: finding.line, onOldSide: false },
    body: withRecordAppended(finding.body, reviewRecord(REVIEW_RECORD_FORM.finding)),
  }));
  const review = await postForgejoReview(pullRequest.address, reviewComments, pullRequest.api, reviewRecord(REVIEW_RECORD_FORM.finding));
  const copyCommentUrl = await writeCopyPasteComment(pullRequest, copyPasteCommentBody(safeFindings));
  return { reviewId: review.id, reviewUrl: review.url, copyCommentUrl, head };
}

function latestReviewFindings(items: readonly ForgejoFeedbackItem[]): ForgejoFeedbackItem[] {
  const reviews = items.filter((item) => item.kind === FEEDBACK_KIND.review && holdsReviewRecord(item.body, REVIEW_RECORD_FORM.finding));
  const latestReviewId = Math.max(...reviews.map((review) => review.id));
  return items.filter((item) => item.kind === FEEDBACK_KIND.reviewComment && item.reviewId === latestReviewId);
}

export async function reviewFindingsForGithub(context: ForgeContext, targetText: string, outFile: string): Promise<ExportedReviewFindings> {
  await refuseGithubWriteWhereRepositoryLandsOnMain(context.repo, "Exporting review findings for a GitHub review", context.dependencies);
  const staged = await stagedPullRequestFor(context, targetText);
  const findings = latestReviewFindings(await readForgejoFeedback(staged.address, staged.api));
  if (findings.length === 0) throw new ForgeRefusal(`${staged.url} has no findings left in the latest review posted by \`throne forge pr review\`, so there is nothing to export. Nothing was written.`);
  const exported: ReviewFinding[] = [];
  for (const finding of findings) {
    const body = await textSafeForGithub(finding.body, `the review comment ${finding.url}`, staged.api.rootUrl, context.dependencies);
    exported.push({ path: finding.place!.path, line: finding.place!.line, body });
  }
  await writeFile(outFile, `${JSON.stringify(exported, null, 2)}\n`);
  return { count: exported.length, githubUrl: staged.githubUrl };
}
