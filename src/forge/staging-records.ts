export interface ForgejoAnswerReference {
  readonly answers: number;
  readonly resolves: boolean;
}

export interface StagingSync {
  readonly promotedHead: string | null;
  readonly carriedAnswers: readonly number[];
}

export const EMPTY_STAGING_SYNC: StagingSync = { promotedHead: null, carriedAnswers: [] };

export const REVIEW_RECORD_FORM = { finding: "finding", copy: "copy" } as const;
export type ReviewRecordForm = (typeof REVIEW_RECORD_FORM)[keyof typeof REVIEW_RECORD_FORM];

const GITHUB_TWIN_PATTERN = /<!-- github-twin: (\S+) -->/;
const GITHUB_FEEDBACK_PATTERN = /<!-- github-feedback: ([a-z]+ \d+ \d+) -->/;
const FORGEJO_ANSWER_PATTERN = /<!-- forgejo-answer: (\d+)( resolved)? -->/;
const STAGING_SYNC_PATTERN = /<!-- staging-sync: (\{[^>]*\}) -->/;
const SELF_REVIEW_PATTERN = /<!-- self-review: ([0-9a-f]+) -->/;
const STAGING_RECORD_KINDS = "forgejo-twin|github-twin|github-feedback|forgejo-answer|forgejo-comment|staging-sync|pr-review|self-review";
const STAGING_RECORD_PATTERN = new RegExp(`\\s*<!-- (?:${STAGING_RECORD_KINDS}): [^>]* -->`, "g");
const STAGING_RECORD_OPENING_PATTERN = new RegExp(`<!-- (?:${STAGING_RECORD_KINDS}):`);

export function githubTwinRecord(githubUrl: string): string {
  return `<!-- github-twin: ${githubUrl} -->`;
}

export function githubTwinIn(text: string): string | undefined {
  return GITHUB_TWIN_PATTERN.exec(text)?.[1];
}

export function githubFeedbackRecord(key: string): string {
  return `<!-- github-feedback: ${key} -->`;
}

export function githubFeedbackKeyIn(text: string): string | undefined {
  return GITHUB_FEEDBACK_PATTERN.exec(text)?.[1];
}

export function forgejoAnswerRecord(answer: ForgejoAnswerReference): string {
  return `<!-- forgejo-answer: ${answer.answers}${answer.resolves ? " resolved" : ""} -->`;
}

export function forgejoAnswerIn(text: string): ForgejoAnswerReference | undefined {
  const match = FORGEJO_ANSWER_PATTERN.exec(text);
  return match === null ? undefined : { answers: Number(match[1]), resolves: match[2] !== undefined };
}

export function stagingSyncRecord(sync: StagingSync): string {
  return `<!-- staging-sync: ${JSON.stringify({ promotedHead: sync.promotedHead, carriedAnswers: sync.carriedAnswers })} -->`;
}

export function stagingSyncIn(text: string): StagingSync {
  const match = STAGING_SYNC_PATTERN.exec(text);
  if (match === null) return EMPTY_STAGING_SYNC;
  const recorded = JSON.parse(match[1]!) as Partial<StagingSync>;
  return { promotedHead: recorded.promotedHead ?? null, carriedAnswers: recorded.carriedAnswers ?? [] };
}

export function reviewRecord(form: ReviewRecordForm): string {
  return `<!-- pr-review: ${form} -->`;
}

export function holdsReviewRecord(text: string, form: ReviewRecordForm): boolean {
  return text.includes(reviewRecord(form));
}

export function selfReviewRecord(head: string): string {
  return `<!-- self-review: ${head} -->`;
}

export function selfReviewedHeadIn(text: string): string | undefined {
  return SELF_REVIEW_PATTERN.exec(text)?.[1];
}

export function withSelfReviewRecord(text: string, head: string): string {
  const record = selfReviewRecord(head);
  return selfReviewedHeadIn(text) === undefined ? `${text}\n\n${record}\n` : text.replace(SELF_REVIEW_PATTERN, record);
}

export function bodyKeepingSelfReviewRecord(previousBody: string, newBody: string): string {
  const previousHead = selfReviewedHeadIn(previousBody);
  return previousHead === undefined || selfReviewedHeadIn(newBody) !== undefined ? newBody : withSelfReviewRecord(newBody, previousHead);
}

export function withoutStagingRecords(text: string): string {
  return text.replace(STAGING_RECORD_PATTERN, "").trim();
}

export function hasStagingRecord(text: string): boolean {
  return STAGING_RECORD_OPENING_PATTERN.test(text);
}

export function withRecordAppended(text: string, record: string): string {
  return `${text.trimEnd()}\n\n${record}\n`;
}
