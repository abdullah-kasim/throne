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

export const recordsResponse = z.object({
  records: pullRequestRecords,
  lastModified: z.iso.datetime(),
});

export const failedResponse = z.object({
  outcome: z.literal("failed"),
  message: z.string(),
});

export type RecordsResponse = z.infer<typeof recordsResponse>;
export type PullRequestRecords = z.infer<typeof pullRequestRecords>;
export type FailedResponse = z.infer<typeof failedResponse>;

const storedTime = z.iso.datetime();

const authorship = {
  writtenAt: storedTime,
  writtenBy: z.string(),
  changedAt: storedTime,
  changedBy: z.string(),
  archivedAt: storedTime.nullable(),
  archivedBy: z.string().nullable(),
};

export const storedTab = z.object({ id: z.string(), name: z.string(), position: z.number().int(), ...authorship });

export const storedSection = z.object({
  id: z.string(),
  tabId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  position: z.number().int(),
  ...authorship,
});

export const storedRowKind = z.enum(["work", "event", "epic"]);

export const storedRow = z.object({
  id: z.string(),
  sectionId: z.string(),
  kind: storedRowKind,
  code: z.string().nullable(),
  links: z.string().nullable(),
  workKind: z.string().nullable(),
  whereItStands: z.string().nullable(),
  freeLines: z.array(z.string()),
  text: z.string(),
  writtenDateIsEstimate: z.boolean(),
  position: z.number().int(),
  ...authorship,
});

export const structureListing = z.object({
  tabs: z.array(storedTab),
  sections: z.array(storedSection),
  listingToken: z.string(),
});

export const storedPage = z.object({
  now: storedTime,
  listing: structureListing,
  rows: z.array(storedRow),
  archivedRowCounts: z.record(z.string(), z.number().int()),
});

export const archivedRowsResponse = z.object({ rows: z.array(storedRow) });

export const rowFields = z.object({
  kind: storedRowKind,
  code: z.string().optional(),
  links: z.string().optional(),
  workKind: z.string().optional(),
  whereItStands: z.string().optional(),
  freeLines: z.array(z.string()).optional(),
  text: z.string().optional(),
});

const writer = z.string().trim().min(1);

export const addRowRequest = z.object({
  sectionId: z.string(),
  listingToken: z.string(),
  writer,
  row: rowFields,
});

export const replaceRowRequest = z.object({
  writer,
  row: rowFields.omit({ kind: true }),
  loadedChangedAt: storedTime.optional(),
});

export const writerRequest = z.object({ writer, loadedChangedAt: storedTime.optional() });

export const createTabRequest = z.object({ name: z.string().trim().min(1), listingToken: z.string(), writer });

export const createSectionRequest = z.object({
  tabId: z.string(),
  parentId: z.string().optional(),
  name: z.string().trim().min(1),
  listingToken: z.string(),
  writer,
});

export const purgeRequest = z.object({ dryRun: z.boolean(), writer });

export const writeOutcome = z.enum(["done", "refused"]);

export const writeResponse = z.object({
  outcome: writeOutcome,
  message: z.string(),
  row: storedRow.optional(),
  section: storedSection.optional(),
  tab: storedTab.optional(),
  listing: structureListing.optional(),
});

export const purgedItem = z.object({ item: z.string(), words: z.string(), archivedAt: storedTime });

export const purgeResponse = z.object({ outcome: z.literal("done"), message: z.string(), purged: z.array(purgedItem) });

export type StoredTab = z.infer<typeof storedTab>;
export type StoredSection = z.infer<typeof storedSection>;
export type StoredRow = z.infer<typeof storedRow>;
export type StructureListing = z.infer<typeof structureListing>;
export type StoredPage = z.infer<typeof storedPage>;
export type ArchivedRowsResponse = z.infer<typeof archivedRowsResponse>;
export type RowFields = z.infer<typeof rowFields>;
export type AddRowRequest = z.infer<typeof addRowRequest>;
export type ReplaceRowRequest = z.infer<typeof replaceRowRequest>;
export type WriterRequest = z.infer<typeof writerRequest>;
export type CreateTabRequest = z.infer<typeof createTabRequest>;
export type CreateSectionRequest = z.infer<typeof createSectionRequest>;
export type PurgeRequest = z.infer<typeof purgeRequest>;
export type WriteResponse = z.infer<typeof writeResponse>;
export type PurgedItem = z.infer<typeof purgedItem>;
export type PurgeResponse = z.infer<typeof purgeResponse>;
