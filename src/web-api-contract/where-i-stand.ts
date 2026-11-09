import { z } from "zod";

const pullRequestSide = z.looseObject({
  url: z.string(),
  number: z.number(),
  state: z.string(),
});

const workRow = z.looseObject({
  group: z.string(),
  repository: z.string(),
  title: z.string(),
  ticket: z.string(),
  ticket_url: z.string(),
  kind: z.string(),
  forgejo: pullRequestSide.nullable(),
  github: pullRequestSide.nullable(),
  head_commits: z.string(),
});

const checkCounts = z.looseObject({
  passing: z.number(),
  failing: z.number(),
  running: z.number(),
});

const otherPullRequest = z.looseObject({
  repository: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  checks: checkCounts,
});

const pullRequestWaitingForReview = otherPullRequest.extend({
  waiting_on: z.string(),
  created_at: z.string(),
});

const teammatePullRequest = otherPullRequest.extend({
  draft: z.boolean(),
  review: z.string(),
  updated_at: z.string(),
});

const pullRequestRecords = z.looseObject({
  read_at: z.string(),
  problems: z.array(z.string()),
  changes: z.array(z.string()),
  rows: z.array(workRow),
  waiting_for_review: z.array(pullRequestWaitingForReview),
  teammates: z.array(teammatePullRequest),
});

export const pageResponse = z.object({
  markdown: z.string(),
  lastModified: z.iso.datetime(),
});

export const recordsResponse = z.object({
  records: pullRequestRecords,
  lastModified: z.iso.datetime(),
});

export const failedResponse = z.object({
  outcome: z.literal("failed"),
  message: z.string(),
});

export const saveRequest = z.object({
  loaded: z.string().min(1),
  edited: z.string(),
  headingOccurrence: z.number().int().positive().optional(),
});

export const saveResponse = z.object({
  outcome: z.enum(["saved", "unchanged", "entry-changed", "entry-repeated", "lock-held", "frame-broken", "outside-epics", "failed"]),
  message: z.string(),
});

export type PageResponse = z.infer<typeof pageResponse>;
export type RecordsResponse = z.infer<typeof recordsResponse>;
export type PullRequestRecords = z.infer<typeof pullRequestRecords>;
export type FailedResponse = z.infer<typeof failedResponse>;
export type SaveRequest = z.infer<typeof saveRequest>;
export type SaveResponse = z.infer<typeof saveResponse>;
