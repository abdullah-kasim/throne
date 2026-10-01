import {
  SERVE_ARM,
  SHADOW_ARM,
  type RecallArm,
} from '../relevance-classifier/recall-user-config.ts';
import type { DigEpisodes, PromptAndItsDig } from './dig-episodes.ts';
import type { LoggedPrompt } from './recall-report-logs.ts';
import type { Grade } from './dig-grades.ts';
import {
  isTypedPromptJudgedForACorrection,
  type CorrectionFindings,
} from './recall-report-corrections.ts';
import type { DigScope } from './dig-scope.ts';
import {
  actedOnRateOf,
  type ActedOnFindings,
  type ActedOnRate,
} from './recall-report-acted-on.ts';
import type { ReadAttribution } from './read-attribution.ts';
import type { RepeatMistakeFindings } from './repeat-mistakes.ts';
import type { UnmeasuredSessionsByHarness } from './unmeasured-sessions.ts';
import { uncountedFindsOf, type UncountedFinds } from './recall-report-uncounted-finds.ts';
import { PROMPT_KINDS, type PromptKind } from './prompt-kind.ts';
import {
  FILE_UNREADABLE,
  candidacyOfFind,
  type AskOfAMemory,
  type FindCandidacy,
} from './recall-report-candidacy.ts';
import {
  SCORED_ON_EVERY_PROMPT,
  SCORED_ON_PROMPTS_WITH_A_DIG,
  nothingVerdictsRightAfterADig,
  trustworthyNothingOf,
  verdictCalibrationsOf,
  type CalibrationBucket,
  type VerdictCalibration,
} from './recall-report-calibration.ts';
import {
  costPerDayOf,
  judgeQuestionsByBackendOf,
  type DailyCost,
} from './recall-report-cost.ts';
import {
  isEmptyHanded,
  isMissedAndFound,
  isOutOfScopeFind,
  isOutOfScopeFindAfterAScopedRecall,
  isOutOfScopeFindInAListedRepository,
  promptOutcomesOf,
  rateOf,
  servedAnything,
  type PromptOutcome,
  type Rate,
} from './recall-report-outcomes.ts';

export const EXAMPLES_SHOWN = 10;

export interface PromptGroupMetrics {
  readonly missedAndFound: Rate;
  readonly outOfScopeFinds: Rate;
  readonly outOfScopeFindsAfterAScopedRecall: number;
  readonly outOfScopeFindsInAListedRepository: number;
  readonly digs: Rate;
  readonly usefulServes: Rate;
  readonly actedOn: ActedOnRate;
  readonly emptyHandedServes: Rate;
  readonly calibrationOverEveryPrompt: readonly VerdictCalibration[];
}

export interface ArmMetrics extends PromptGroupMetrics {
  readonly arm: RecallArm;
}

export interface PromptKindMetrics extends PromptGroupMetrics {
  readonly promptKind: PromptKind;
  readonly calibrationOverPromptsWithADig: readonly VerdictCalibration[];
}

export interface CorrectionsCoveredInArm {
  readonly arm: RecallArm;
  readonly covered: Rate;
  readonly corrections: number;
}

export interface CoveredCorrectionExample {
  readonly at: string;
  readonly arm: RecallArm;
  readonly promptText: string;
  readonly coveringMemory: string;
  readonly outsideTheSearchedScope: boolean;
}

export interface MissedAndFoundExample {
  readonly at: string;
  readonly arm: RecallArm;
  readonly promptText: string;
  readonly served: readonly string[];
  readonly found: readonly string[];
  readonly findCandidacies: readonly FindCandidacy[];
}

export interface RecallReport {
  readonly since: Date | undefined;
  readonly promptKindsRecordedSince: string | undefined;
  readonly arms: readonly ArmMetrics[];
  readonly promptKinds: readonly PromptKindMetrics[];
  readonly missedAndFoundExamples: readonly MissedAndFoundExample[];
  readonly calibrationOverEveryPrompt: readonly VerdictCalibration[];
  readonly calibrationOverPromptsWithADig: readonly VerdictCalibration[];
  readonly trustworthyNothing: CalibrationBucket | undefined;
  readonly nothingVerdictsAfterADig: Rate;
  readonly uncountedFinds: UncountedFinds;
  readonly repeatMistakes: RepeatMistakeFindings;
  readonly correctionsCovered: readonly CorrectionsCoveredInArm[];
  readonly coveredCorrectionExamples: readonly CoveredCorrectionExample[];
  readonly judgeErrors: Rate;
  readonly judgeQuestionsByBackend: Readonly<Record<string, number>>;
  readonly costPerDay: readonly DailyCost[];
  readonly memoryReadLoggingFailures: number;
  readonly readsMatchedToNoPrompt: number;
  readonly readAttribution: ReadAttribution;
  readonly unmeasuredSessions: UnmeasuredSessionsByHarness;
  readonly judgeAgreementWithTheLord: Rate;
}

export interface RecallReportInputs {
  readonly since: Date | undefined;
  readonly promptKindsRecordedSince: string | undefined;
  readonly episodes: DigEpisodes;
  readonly promptGrades: ReadonlyMap<string, Grade>;
  readonly digScopes: ReadonlyMap<PromptAndItsDig, DigScope>;
  readonly memoryCreationTimes: ReadonlyMap<string, number>;
  readonly physicalPathOfEachMemory: ReadonlyMap<string, string>;
  readonly askOfEachFoundMemory: ReadonlyMap<string, AskOfAMemory>;
  readonly repeatMistakes: RepeatMistakeFindings;
  readonly correctionFindings: CorrectionFindings;
  readonly actedOnFindings: ActedOnFindings;
  readonly memoryReadLoggingFailures: number;
  readonly readAttribution: ReadAttribution;
  readonly unmeasuredSessions: UnmeasuredSessionsByHarness;
  readonly judgeAgreementWithTheLord: Rate;
}

function correctionsCoveredInArm(
  arm: RecallArm,
  prompts: readonly LoggedPrompt[],
  findings: CorrectionFindings,
): CorrectionsCoveredInArm {
  const isInArm = (prompt: LoggedPrompt): boolean => prompt.arm === arm;
  const coveredPrompts = new Set(findings.covered.map((covered) => covered.prompt));
  return {
    arm,
    covered: rateOf(
      prompts.filter((prompt) => isInArm(prompt) && isTypedPromptJudgedForACorrection(prompt)),
      (prompt) => coveredPrompts.has(prompt),
    ),
    corrections: findings.corrections.filter(isInArm).length,
  };
}

function promptGroupMetricsOf(
  outcomes: readonly PromptOutcome[],
  actedOnFindings: ActedOnFindings,
): PromptGroupMetrics {
  const servingOutcomes = outcomes.filter(servedAnything);
  return {
    missedAndFound: rateOf(outcomes, isMissedAndFound),
    outOfScopeFinds: rateOf(outcomes, isOutOfScopeFind),
    outOfScopeFindsAfterAScopedRecall: outcomes.filter(isOutOfScopeFindAfterAScopedRecall).length,
    outOfScopeFindsInAListedRepository: outcomes.filter(isOutOfScopeFindInAListedRepository).length,
    digs: rateOf(outcomes, (outcome) => outcome.dug),
    usefulServes: rateOf(servingOutcomes, (outcome) => outcome.servedSomethingRelevant),
    actedOn: actedOnRateOf(
      outcomes.map((outcome) => outcome.entry),
      actedOnFindings,
    ),
    emptyHandedServes: rateOf(servingOutcomes, isEmptyHanded),
    calibrationOverEveryPrompt: verdictCalibrationsOf(outcomes, SCORED_ON_EVERY_PROMPT),
  };
}

function armMetricsOf(
  arm: RecallArm,
  outcomes: readonly PromptOutcome[],
  actedOnFindings: ActedOnFindings,
): ArmMetrics {
  return {
    arm,
    ...promptGroupMetricsOf(
      outcomes.filter((outcome) => outcome.entry.prompt.arm === arm),
      actedOnFindings,
    ),
  };
}

function promptKindMetricsOf(
  promptKind: PromptKind,
  outcomes: readonly PromptOutcome[],
  actedOnFindings: ActedOnFindings,
): PromptKindMetrics {
  const kindOutcomes = outcomes.filter(
    (outcome) => outcome.entry.prompt.promptKind === promptKind,
  );
  return {
    promptKind,
    ...promptGroupMetricsOf(kindOutcomes, actedOnFindings),
    calibrationOverPromptsWithADig: verdictCalibrationsOf(
      kindOutcomes,
      SCORED_ON_PROMPTS_WITH_A_DIG,
    ),
  };
}

function missedAndFoundExampleOf(
  { entry, foundRelevantUnserved }: PromptOutcome,
  inputs: RecallReportInputs,
): MissedAndFoundExample {
  return {
    at: entry.prompt.at,
    arm: entry.prompt.arm,
    promptText: entry.prompt.promptText,
    served: entry.prompt.servedFiles,
    found: foundRelevantUnserved,
    findCandidacies: foundRelevantUnserved.map((memoryFile) => ({
      memoryFile,
      candidacy: candidacyOfFind(entry.prompt, memoryFile, inputs.physicalPathOfEachMemory),
      ask: inputs.askOfEachFoundMemory.get(memoryFile) ?? { kind: FILE_UNREADABLE },
    })),
  };
}

function mostRecentFirst(left: PromptOutcome, right: PromptOutcome): number {
  return Date.parse(right.entry.prompt.at) - Date.parse(left.entry.prompt.at);
}

export function recallReportOf(inputs: RecallReportInputs): RecallReport {
  const outcomes = promptOutcomesOf(inputs.episodes.prompts, inputs);
  const grades = [
    ...new Set([
      ...inputs.promptGrades.values(),
      ...inputs.repeatMistakes.grades,
      ...inputs.correctionFindings.grades,
      ...inputs.actedOnFindings.grades,
    ]),
  ];
  const prompts = inputs.episodes.prompts.map((entry) => entry.prompt);
  return {
    since: inputs.since,
    promptKindsRecordedSince: inputs.promptKindsRecordedSince,
    arms: ([SERVE_ARM, SHADOW_ARM] as const).map((arm) =>
      armMetricsOf(arm, outcomes, inputs.actedOnFindings),
    ),
    promptKinds: PROMPT_KINDS.map((promptKind) =>
      promptKindMetricsOf(promptKind, outcomes, inputs.actedOnFindings),
    ),
    missedAndFoundExamples: outcomes
      .filter(isMissedAndFound)
      .sort(mostRecentFirst)
      .slice(0, EXAMPLES_SHOWN)
      .map((outcome) => missedAndFoundExampleOf(outcome, inputs)),
    calibrationOverEveryPrompt: verdictCalibrationsOf(outcomes, SCORED_ON_EVERY_PROMPT),
    calibrationOverPromptsWithADig: verdictCalibrationsOf(outcomes, SCORED_ON_PROMPTS_WITH_A_DIG),
    trustworthyNothing: trustworthyNothingOf(outcomes),
    nothingVerdictsAfterADig: nothingVerdictsRightAfterADig(outcomes),
    uncountedFinds: uncountedFindsOf(outcomes, inputs.memoryCreationTimes, EXAMPLES_SHOWN),
    repeatMistakes: inputs.repeatMistakes,
    correctionsCovered: ([SERVE_ARM, SHADOW_ARM] as const).map((arm) =>
      correctionsCoveredInArm(arm, prompts, inputs.correctionFindings),
    ),
    coveredCorrectionExamples: [...inputs.correctionFindings.covered]
      .sort((left, right) => Date.parse(right.prompt.at) - Date.parse(left.prompt.at))
      .slice(0, EXAMPLES_SHOWN)
      .map(({ prompt, coveringMemory, outsideTheSearchedScope }) => ({
        at: prompt.at,
        arm: prompt.arm,
        promptText: prompt.promptText,
        coveringMemory,
        outsideTheSearchedScope,
      })),
    judgeErrors: rateOf(grades, (grade) => grade.failedOpen),
    judgeQuestionsByBackend: judgeQuestionsByBackendOf(grades),
    costPerDay: costPerDayOf(
      outcomes.map((outcome) => outcome.entry.prompt),
      grades,
    ),
    memoryReadLoggingFailures: inputs.memoryReadLoggingFailures,
    readsMatchedToNoPrompt: inputs.episodes.readsMatchedToNoPrompt,
    readAttribution: inputs.readAttribution,
    unmeasuredSessions: inputs.unmeasuredSessions,
    judgeAgreementWithTheLord: inputs.judgeAgreementWithTheLord,
  };
}
