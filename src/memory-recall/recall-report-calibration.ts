import {
  MEMORY_LIKELY_EXISTS,
  NO_RELEVANT_MEMORY,
  type RecallVerdict,
} from './recall-verdict.ts';
import {
  isJudgedInsideItsScope,
  rateOf,
  type PromptOutcome,
  type Rate,
} from './recall-report-outcomes.ts';

export const CALIBRATION_BUCKET_COUNT = 10;
export const SHARE_RIGHT_FOR_A_TRUSTWORTHY_NOTHING = 0.95;
export const EPISODES_NEEDED_FOR_A_TRUSTWORTHY_NOTHING = 30;

export interface CalibrationBucket {
  readonly lowerEdge: number;
  readonly right: number;
  readonly total: number;
}

export interface VerdictCalibration {
  readonly verdict: RecallVerdict['verdict'];
  readonly buckets: readonly CalibrationBucket[];
}

export interface VerdictScoring {
  isScored(outcome: PromptOutcome): boolean;
  isRight(outcome: PromptOutcome): boolean;
}

function saidMemoryLikelyExists(outcome: PromptOutcome): boolean {
  return outcome.entry.prompt.verdict.verdict === MEMORY_LIKELY_EXISTS;
}

function isVerdictRightAfterItsDig(outcome: PromptOutcome): boolean {
  return saidMemoryLikelyExists(outcome) === outcome.digFoundSomething;
}

function isVerdictRightOnWhatWasServed(outcome: PromptOutcome): boolean {
  return saidMemoryLikelyExists(outcome) === outcome.servedSomethingRelevant;
}

function isVerdictRightOnAnyPrompt(outcome: PromptOutcome): boolean {
  return outcome.dug ? isVerdictRightAfterItsDig(outcome) : isVerdictRightOnWhatWasServed(outcome);
}

function isScoredOnAnyPrompt(outcome: PromptOutcome): boolean {
  return outcome.dug ? isJudgedInsideItsScope(outcome) : !outcome.afterAFailedHookRun;
}

export const SCORED_ON_EVERY_PROMPT: VerdictScoring = {
  isScored: isScoredOnAnyPrompt,
  isRight: isVerdictRightOnAnyPrompt,
};

export const SCORED_ON_PROMPTS_WITH_A_DIG: VerdictScoring = {
  isScored: isJudgedInsideItsScope,
  isRight: isVerdictRightAfterItsDig,
};

function bucketIndexOf(confidence: number): number {
  return Math.min(
    CALIBRATION_BUCKET_COUNT - 1,
    Math.floor(Math.round(confidence * CALIBRATION_BUCKET_COUNT * 100) / 100),
  );
}

function bucketOf(
  outcomes: readonly PromptOutcome[],
  isRight: (outcome: PromptOutcome) => boolean,
  lowestIndex: number,
  highestIndex: number,
): CalibrationBucket {
  const inside = outcomes.filter((outcome) => {
    const index = bucketIndexOf(outcome.entry.prompt.verdict.confidence);
    return index >= lowestIndex && index <= highestIndex;
  });
  return {
    lowerEdge: lowestIndex / CALIBRATION_BUCKET_COUNT,
    right: inside.filter(isRight).length,
    total: inside.length,
  };
}

function bucketIndexes(): readonly number[] {
  return Array.from({ length: CALIBRATION_BUCKET_COUNT }, (_, index) => index);
}

function hasVerdict(verdict: RecallVerdict['verdict']): (outcome: PromptOutcome) => boolean {
  return (outcome) => outcome.entry.prompt.verdict.verdict === verdict;
}

function judgedNothingVerdicts(outcomes: readonly PromptOutcome[]): readonly PromptOutcome[] {
  return outcomes
    .filter(SCORED_ON_PROMPTS_WITH_A_DIG.isScored)
    .filter(hasVerdict(NO_RELEVANT_MEMORY));
}

export function verdictCalibrationsOf(
  outcomes: readonly PromptOutcome[],
  scoring: VerdictScoring,
): readonly VerdictCalibration[] {
  const scoredOutcomes = outcomes.filter(scoring.isScored);
  return ([NO_RELEVANT_MEMORY, MEMORY_LIKELY_EXISTS] as const).map((verdict) => {
    const verdictOutcomes = scoredOutcomes.filter(hasVerdict(verdict));
    return {
      verdict,
      buckets: bucketIndexes()
        .map((index) => bucketOf(verdictOutcomes, scoring.isRight, index, index))
        .filter((bucket) => bucket.total > 0),
    };
  });
}

export function trustworthyNothingOf(
  outcomes: readonly PromptOutcome[],
): CalibrationBucket | undefined {
  const nothingOutcomes = judgedNothingVerdicts(outcomes);
  return bucketIndexes()
    .map((index) =>
      bucketOf(
        nothingOutcomes,
        SCORED_ON_PROMPTS_WITH_A_DIG.isRight,
        index,
        CALIBRATION_BUCKET_COUNT - 1,
      ),
    )
    .find(
      (bucket) =>
        bucket.total >= EPISODES_NEEDED_FOR_A_TRUSTWORTHY_NOTHING &&
        bucket.right / bucket.total >= SHARE_RIGHT_FOR_A_TRUSTWORTHY_NOTHING,
    );
}

export function nothingVerdictsRightAfterADig(outcomes: readonly PromptOutcome[]): Rate {
  return rateOf(judgedNothingVerdicts(outcomes), SCORED_ON_PROMPTS_WITH_A_DIG.isRight);
}
