import type { FakeAttachment, FakeConversationComment, FakeManualMerge, FakePullRequest, FakeRepository, FakeReview, FakeReviewComment } from "./forge-fake-forgejo.ts";

export interface FakeForgejoSnapshot {
  readonly records: FakeForgejoRecords;
  readonly bareRepositoriesCopy: string | null;
}

export interface FakeForgejoState {
  readonly repositories: Map<string, FakeRepository>;
  readonly pullRequests: FakePullRequest[];
  readonly comments: FakeConversationComment[];
  readonly attachments: FakeAttachment[];
  readonly reviews: FakeReview[];
  readonly reviewComments: FakeReviewComment[];
  readonly attachmentContents: Map<string, Buffer>;
  readonly adminSignIns: string[];
  readonly markdownRequests: unknown[];
  readonly merges: unknown[];
  readonly manualMerges: FakeManualMerge[];
  readonly gitAuthorizations: string[];
  readonly pullRequestCreateRequests: string[];
}

export interface FakeForgejoRecords extends FakeForgejoState {
  readonly branchReads: Map<string, number>;
  readonly nextAttachmentId: number;
  readonly readsBeforeBranchRegisters: number;
}

export const EMPTY_SNAPSHOT: FakeForgejoSnapshot = {
  records: {
    repositories: new Map(),
    pullRequests: [],
    comments: [],
    attachments: [],
    reviews: [],
    reviewComments: [],
    attachmentContents: new Map(),
    adminSignIns: [],
    markdownRequests: [],
    merges: [],
    manualMerges: [],
    gitAuthorizations: [],
    pullRequestCreateRequests: [],
    branchReads: new Map(),
    nextAttachmentId: 0,
    readsBeforeBranchRegisters: 0,
  },
  bareRepositoriesCopy: null,
};

export function replaceContents<T>(list: T[], replacement: readonly T[]): void {
  list.splice(0, list.length, ...structuredClone(replacement));
}

export function replaceEntries<K, V>(map: Map<K, V>, replacement: ReadonlyMap<K, V>): void {
  map.clear();
  for (const [key, value] of structuredClone(replacement)) map.set(key, value);
}
