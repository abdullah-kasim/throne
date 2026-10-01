import { answeringBackendOf } from '../relevance-classifier/answering-backend.ts';
import {
  CLASSIFIER_BUDGET_LOCK_BUSY,
  CLASSIFIER_RATE_LIMITED,
  CLASSIFIER_TIMED_OUT,
} from '../relevance-classifier/classifier.types.ts';
import type { PromptKind } from './prompt-kind.ts';
import { appendSkippedHookRunToLedger } from './recall-records.ts';
import type { MemoryDecision } from './select-memories.ts';

export const SERVED_OUTCOME = 'served';
export const NOTHING_RELEVANT_OUTCOME = 'nothing relevant';
export const TIMED_OUT_OUTCOME = 'timed out';
export const CLASSIFIER_ERROR_OUTCOME = 'classifier error';
export const JEV_BUDGET_USED_UP_OUTCOME = 'jev budget used up';
export const JEV_BUDGET_LOCK_BUSY_OUTCOME = 'jev budget lock busy';
export const SKIPPED_OUTCOME = 'skipped';

export type HookOutcome =
  | typeof SERVED_OUTCOME
  | typeof NOTHING_RELEVANT_OUTCOME
  | typeof TIMED_OUT_OUTCOME
  | typeof CLASSIFIER_ERROR_OUTCOME
  | typeof JEV_BUDGET_USED_UP_OUTCOME
  | typeof JEV_BUDGET_LOCK_BUSY_OUTCOME
  | typeof SKIPPED_OUTCOME;

export const HOOK_OUTCOMES: readonly HookOutcome[] = [
  SERVED_OUTCOME,
  NOTHING_RELEVANT_OUTCOME,
  TIMED_OUT_OUTCOME,
  CLASSIFIER_ERROR_OUTCOME,
  JEV_BUDGET_USED_UP_OUTCOME,
  JEV_BUDGET_LOCK_BUSY_OUTCOME,
  SKIPPED_OUTCOME,
];

export function isFailedHookRun(hookOutcome: HookOutcome | undefined): boolean {
  return (
    hookOutcome === TIMED_OUT_OUTCOME ||
    hookOutcome === CLASSIFIER_ERROR_OUTCOME ||
    hookOutcome === JEV_BUDGET_USED_UP_OUTCOME ||
    hookOutcome === JEV_BUDGET_LOCK_BUSY_OUTCOME
  );
}

export const HOOK_DISABLED = 'hook disabled';
export const UNREADABLE_PAYLOAD = 'unreadable payload';
export const EMPTY_PROMPT = 'empty prompt';
export const HOOK_FAILED = 'hook failed';

export type HookSkipReason =
  | typeof HOOK_DISABLED
  | typeof UNREADABLE_PAYLOAD
  | typeof EMPTY_PROMPT
  | typeof HOOK_FAILED;

export interface HookRunRecord {
  readonly promptKind: PromptKind;
  readonly hookOutcome: HookOutcome;
  readonly hookDurationMilliseconds: number;
}

export interface SkippedHookRunRecord {
  readonly hookOutcome: typeof SKIPPED_OUTCOME;
  readonly hookSkipReason: HookSkipReason;
  readonly hookDurationMilliseconds: number;
}

export interface SkippedHookRunDependencies {
  readonly dataDirectory: string;
  now(): Date;
  writeStderr(text: string): void;
}

export function millisecondsSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export function hookOutcomeOf(decisions: readonly MemoryDecision[]): HookOutcome {
  const answers = decisions.map((decision) => decision.answer);
  const { jevFailure } = answeringBackendOf(answers);
  if (jevFailure === CLASSIFIER_TIMED_OUT) return TIMED_OUT_OUTCOME;
  if (jevFailure === CLASSIFIER_RATE_LIMITED) return JEV_BUDGET_USED_UP_OUTCOME;
  if (jevFailure === CLASSIFIER_BUDGET_LOCK_BUSY) return JEV_BUDGET_LOCK_BUSY_OUTCOME;
  if (answers.some((answer) => answer.failedOpen)) return CLASSIFIER_ERROR_OUTCOME;
  return decisions.some((decision) => decision.served) ? SERVED_OUTCOME : NOTHING_RELEVANT_OUTCOME;
}

export function hookRunRecordOf(
  promptKind: PromptKind,
  decisions: readonly MemoryDecision[],
  startedAt: number,
): HookRunRecord {
  return {
    promptKind,
    hookOutcome: hookOutcomeOf(decisions),
    hookDurationMilliseconds: millisecondsSince(startedAt),
  };
}

export async function recordSkippedHookRun(
  sessionId: string | undefined,
  skipReason: HookSkipReason,
  startedAt: number,
  dependencies: SkippedHookRunDependencies,
): Promise<void> {
  try {
    await appendSkippedHookRunToLedger(
      dependencies.dataDirectory,
      sessionId,
      {
        hookOutcome: SKIPPED_OUTCOME,
        hookSkipReason: skipReason,
        hookDurationMilliseconds: millisecondsSince(startedAt),
      },
      dependencies.now(),
    );
  } catch (error) {
    dependencies.writeStderr(
      `recall: the skipped hook run could not be recorded: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
