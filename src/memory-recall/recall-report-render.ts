import path from 'node:path';
import {
  CALIBRATION_BUCKET_COUNT,
  EPISODES_NEEDED_FOR_A_TRUSTWORTHY_NOTHING,
  SHARE_RIGHT_FOR_A_TRUSTWORTHY_NOTHING,
  type VerdictCalibration,
} from './recall-report-calibration.ts';
import type { DailyCost } from './recall-report-cost.ts';
import { ASSISTANT_TURNS_JUDGED_FOR_ACTING_ON_A_MEMORY } from './recall-report-acted-on.ts';
import {
  EXAMPLES_SHOWN,
  type ArmMetrics,
  type CorrectionsCoveredInArm,
  type CoveredCorrectionExample,
  type MissedAndFoundExample,
  type PromptGroupMetrics,
  type PromptKindMetrics,
  type RecallReport,
} from './recall-report-metrics.ts';
import { OTHER_PROMPT, PROMPT_KINDS } from './prompt-kind.ts';
import {
  HAS_ASK,
  JUDGED,
  NEVER_A_CANDIDATE,
  type AskOfAMemory,
  type Candidacy,
  type FindCandidacy,
} from './recall-report-candidacy.ts';
import { LOWEST_PROBABILITY_OF_YES_WORTH_A_LEDGER_LINE } from './recall-records.ts';
import type { Rate } from './recall-report-outcomes.ts';
import type { LaterNoteExample, UncountedFinds } from './recall-report-uncounted-finds.ts';
import { VERDICTS_NEEDED_FOR_AN_AGREEMENT_RATE } from './spot-check-verdicts.ts';

const PROMPT_EXCERPT_CHARACTERS = 80;
const ANY_PROMPT = 'prompt';
const PROMPT_WITH_A_DIG = 'prompt with a dig';

function perHundred(rate: Rate, whatIsCounted: string): string {
  if (rate.outOf === 0) return `no ${whatIsCounted}`;
  return `${((100 * rate.count) / rate.outOf).toFixed(1)} per 100 ${whatIsCounted} (${rate.count} of ${rate.outOf} ${whatIsCounted})`;
}

function perHundredPrompts(rate: Rate): string {
  return perHundred(rate, 'prompts');
}

function percentOf(rate: Rate, whatIsCounted: string): string {
  if (rate.outOf === 0) return `no data (0 ${whatIsCounted})`;
  return `${((100 * rate.count) / rate.outOf).toFixed(1)}% (${rate.count} of ${rate.outOf} ${whatIsCounted})`;
}

export function fileNames(filePaths: readonly string[]): string {
  return filePaths.length === 0 ? 'nothing' : filePaths.map((filePath) => path.basename(filePath)).join(', ');
}

export function excerptOf(promptText: string, characters: number = PROMPT_EXCERPT_CHARACTERS): string {
  const oneLine = promptText.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > characters ? `${oneLine.slice(0, characters)}...` : oneLine;
}

function countsByName(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? 'none' : entries.map(([name, count]) => `${name} ${count}`).join(', ');
}

function renderedUnmeasuredSessions(report: RecallReport): string {
  const total = Object.values(report.unmeasuredSessions).reduce((sum, count) => sum + count, 0);
  return `  unmeasured sessions: ${total} (agents spawned on a harness with no recall or read logging, by harness: ${countsByName(report.unmeasuredSessions)})`;
}

function renderedReadAttribution(report: RecallReport): string {
  const { attributedThroughPaneOrTranscriptDirectory, stillUnattributed } = report.readAttribution;
  return `  memory reads with no agent name: ${attributedThroughPaneOrTranscriptDirectory} attributed through their herdr pane or transcript directory, ${stillUnattributed} still unattributed`;
}

function perArm(arms: readonly ArmMetrics[], line: (arm: ArmMetrics) => string): string[] {
  return arms.map((arm) => `    ${arm.arm} arm: ${line(arm)}`);
}

function perPromptKind(
  promptKinds: readonly PromptKindMetrics[],
  line: (promptKind: PromptKindMetrics) => string,
): string[] {
  return promptKinds.map((promptKind) => `      ${promptKind.promptKind} prompts: ${line(promptKind)}`);
}

function renderedOutOfScopeFinds(group: PromptGroupMetrics): string {
  return `${perHundredPrompts(group.outOfScopeFinds)}; ${group.outOfScopeFindsAfterAScopedRecall} of ${group.outOfScopeFinds.count} first ran throne recall with that repository's scope; ${group.outOfScopeFindsInAListedRepository} of ${group.outOfScopeFinds.count} had recall list that repository among the other repositories`;
}

function renderedActedOn({ actedOn }: PromptGroupMetrics): string {
  return `${percentOf(actedOn.actedOn, 'relevant served memories')}; transcript unavailable: ${actedOn.transcriptUnavailable}`;
}

function renderedCandidacy(candidacy: Candidacy): string {
  if (candidacy.kind === JUDGED) {
    return `judged, Jev's probability of yes ${candidacy.probabilityOfYes.toFixed(2)}`;
  }
  if (candidacy.kind === NEVER_A_CANDIDATE) {
    return 'never a candidate (every answer was logged and none names it)';
  }
  return `candidacy unknown (logged before every answer was logged, so it was judged below ${LOWEST_PROBABILITY_OF_YES_WORTH_A_LEDGER_LINE} or never asked)`;
}

function renderedAsk(ask: AskOfAMemory): string {
  return ask.kind === HAS_ASK ? `ask: "${ask.ask}"` : ask.kind;
}

function renderedFindCandidacy(find: FindCandidacy): string {
  return `      ${path.basename(find.memoryFile)}: ${renderedCandidacy(find.candidacy)} | ${renderedAsk(find.ask)}`;
}

function renderedExample(example: MissedAndFoundExample): string[] {
  return [
    `    - ${example.at} ${example.arm} arm: "${excerptOf(example.promptText)}" | Jev served: ${fileNames(example.served)} | the dig found: ${fileNames(example.found)}`,
    ...example.findCandidacies.map(renderedFindCandidacy),
  ];
}

function renderedLaterNoteExample(example: LaterNoteExample): string {
  return `      - ${example.at} "${excerptOf(example.promptText)}" | found ${path.basename(example.memoryFile)}, created ${example.createdAt}`;
}

function renderedUncountedFinds(uncountedFinds: UncountedFinds): string[] {
  return [
    '  finds that do not count against Jev:',
    `    found its own later note (the memory was created after the prompt): ${uncountedFinds.laterNotes}`,
    ...uncountedFinds.laterNoteExamples.map(renderedLaterNoteExample),
    `    after a timed-out or errored hook run: ${uncountedFinds.digsAfterAFailedHookRun} prompts with a dig, ${uncountedFinds.findsAfterAFailedHookRun} relevant finds (neither missed-and-found nor out of scope)`,
    `    already shown earlier in the session (suppressed as a repeat): ${uncountedFinds.alreadyShown}`,
  ];
}

function renderedCorrectionsCovered(correctionsCovered: CorrectionsCoveredInArm): string {
  return `    ${correctionsCovered.arm} arm: ${perHundred(correctionsCovered.covered, 'typed prompts')}; corrections recorded: ${correctionsCovered.corrections}`;
}

function renderedCoveringMemory(example: CoveredCorrectionExample): string {
  const fileName = path.basename(example.coveringMemory);
  return example.outsideTheSearchedScope
    ? `${fileName}, outside the memory directories Jev searched (${path.dirname(example.coveringMemory)})`
    : fileName;
}

function renderedCoveredCorrectionExample(example: CoveredCorrectionExample): string {
  return `      - ${example.at} ${example.arm} arm: "${excerptOf(example.promptText)}" | covered by ${renderedCoveringMemory(example)}`;
}

function renderedCorrectionsAnExistingMemoryCovered(report: RecallReport): string[] {
  return [
    '  corrections an existing memory covered (a typed prompt corrected an agent on a lesson a memory older than the prompt already taught, in any memory directory on this machine; typed prompts counted are those judged for a correction):',
    ...report.correctionsCovered.map(renderedCorrectionsCovered),
    `    The ${report.coveredCorrectionExamples.length} most recent (at most ${EXAMPLES_SHOWN}):`,
    ...report.coveredCorrectionExamples.map(renderedCoveredCorrectionExample),
  ];
}

function bucketRange(lowerEdge: number): string {
  return `${lowerEdge.toFixed(1)}-${(lowerEdge + 1 / CALIBRATION_BUCKET_COUNT).toFixed(1)}`;
}

function renderedCalibration(calibration: VerdictCalibration, scoredPrompt: string): string[] {
  return [
    `  "${calibration.verdict}" was right:`,
    ...(calibration.buckets.length === 0
      ? [`    no ${scoredPrompt} got this verdict`]
      : calibration.buckets.map(
          (bucket) => `    confidence ${bucketRange(bucket.lowerEdge)}: ${bucket.right} of ${bucket.total}`,
        )),
  ];
}

function renderedCompactCalibration(calibration: VerdictCalibration, scoredPrompt: string): string {
  const buckets = calibration.buckets.map(
    (bucket) => `${bucketRange(bucket.lowerEdge)} ${bucket.right} of ${bucket.total}`,
  );
  return buckets.length === 0
    ? `"${calibration.verdict}" given to no ${scoredPrompt}`
    : `"${calibration.verdict}" right at confidence ${buckets.join(', ')}`;
}

function renderedCompactCalibrations(
  calibrations: readonly VerdictCalibration[],
  scoredPrompt: string,
): string {
  return calibrations
    .map((calibration) => renderedCompactCalibration(calibration, scoredPrompt))
    .join('; ');
}

function renderedPromptKindsRecordedSince(report: RecallReport): string {
  const kinds = PROMPT_KINDS.join(', ');
  return report.promptKindsRecordedSince === undefined
    ? `No logged prompt records its kind (${kinds}) yet, so every prompt counts as ${OTHER_PROMPT}`
    : `Prompt kinds (${kinds}) recorded since ${report.promptKindsRecordedSince}; a prompt logged without a kind counts as ${OTHER_PROMPT}`;
}

function renderedByPromptKind(promptKinds: readonly PromptKindMetrics[]): string[] {
  return [
    '  by prompt kind:',
    '    missed-and-found:',
    ...perPromptKind(promptKinds, (promptKind) => perHundredPrompts(promptKind.missedAndFound)),
    '    out of scope:',
    ...perPromptKind(promptKinds, renderedOutOfScopeFinds),
    '    dig episodes:',
    ...perPromptKind(promptKinds, (promptKind) => perHundredPrompts(promptKind.digs)),
    '    useful serves:',
    ...perPromptKind(promptKinds, (promptKind) => percentOf(promptKind.usefulServes, 'prompts that served something')),
    '    acted on:',
    ...perPromptKind(promptKinds, renderedActedOn),
    '    empty-handed serves:',
    ...perPromptKind(promptKinds, (promptKind) => percentOf(promptKind.emptyHandedServes, 'prompts that served something')),
    '    verdict calibration over every prompt:',
    ...perPromptKind(promptKinds, (promptKind) => renderedCompactCalibrations(promptKind.calibrationOverEveryPrompt, ANY_PROMPT)),
    '    verdict calibration over prompts with a dig:',
    ...perPromptKind(promptKinds, (promptKind) => renderedCompactCalibrations(promptKind.calibrationOverPromptsWithADig, PROMPT_WITH_A_DIG)),
  ];
}

function renderedTrustworthyNothing(report: RecallReport): string {
  const share = `${Math.round(SHARE_RIGHT_FOR_A_TRUSTWORTHY_NOTHING * 100)}%`;
  const bucket = report.trustworthyNothing;
  if (bucket !== undefined) {
    return `  "no relevant memory" was right at least ${share} of the time from confidence ${bucket.lowerEdge.toFixed(1)} up (${bucket.right} of ${bucket.total} episodes).`;
  }
  const { count, outOf } = report.nothingVerdictsAfterADig;
  return `  No confidence has "no relevant memory" right at least ${share} of the time on at least ${EPISODES_NEEDED_FOR_A_TRUSTWORTHY_NOTHING} episodes yet (${count} of ${outOf} right over every confidence).`;
}

function renderedJudgeAgreementWithTheLord({ judgeAgreementWithTheLord: agreement }: RecallReport): string {
  const moreNeeded = VERDICTS_NEEDED_FOR_AN_AGREEMENT_RATE - agreement.outOf;
  if (moreNeeded > 0) {
    return `  judge agreement with the Lord: ${agreement.outOf} spot-check verdicts so far, ${moreNeeded} more needed before it is shown (throne recall --spot-check)`;
  }
  return `  judge agreement with the Lord: ${percentOf(agreement, 'spot-check verdicts')}`;
}

function renderedDailyCost(cost: DailyCost): string {
  return `    ${cost.day}: recall ${countsByName(cost.recallQuestionsByBackend)}; judge ${countsByName(cost.judgeQuestionsByBackend)}`;
}

export function renderedRecallReport(report: RecallReport): string {
  const window = report.since === undefined ? 'all time' : `since ${report.since.toISOString()}`;
  const { repeatMistakes } = report;
  return [
    `Jev recall report, ${window}`,
    renderedPromptKindsRecordedSince(report),
    '',
    'MAIN: missed-and-found (Jev served nothing relevant, then a dig found a relevant memory in the memory directories Jev searched that Jev did not serve)',
    ...perArm(report.arms, (arm) => perHundredPrompts(arm.missedAndFound)),
    `  The ${report.missedAndFoundExamples.length} most recent (at most ${EXAMPLES_SHOWN}):`,
    ...report.missedAndFoundExamples.flatMap(renderedExample),
    '',
    'OUT OF SCOPE: a dig found a relevant memory outside the memory directories Jev searched (not counted as missed-and-found)',
    ...perArm(report.arms, renderedOutOfScopeFinds),
    '',
    'BONUS: verdict calibration over every prompt (a prompt with a dig is scored on its dig, as in the next table; a prompt without one is right to say "memory likely exists" when a memory Jev served or would have served was graded relevant, and "no relevant memory" when none was; a prompt whose hook run timed out or errored is left out)',
    ...report.calibrationOverEveryPrompt.flatMap((calibration) => renderedCalibration(calibration, ANY_PROMPT)),
    '  by arm:',
    ...perArm(report.arms, (arm) => renderedCompactCalibrations(arm.calibrationOverEveryPrompt, ANY_PROMPT)),
    '',
    "BONUS: verdict calibration over prompts with a dig inside the verdict's scope (a dig whose relevant finds all lie outside it, or that followed a timed-out or errored hook run, is left out)",
    ...report.calibrationOverPromptsWithADig.flatMap((calibration) => renderedCalibration(calibration, PROMPT_WITH_A_DIG)),
    renderedTrustworthyNothing(report),
    '',
    'Supporting:',
    '  dig episodes:',
    ...perArm(report.arms, (arm) => perHundredPrompts(arm.digs)),
    '  useful serves (at least one served memory graded relevant):',
    ...perArm(report.arms, (arm) => percentOf(arm.usefulServes, 'prompts that served something')),
    `  acted on (a served memory graded relevant that the agent cited or followed within the next ${ASSISTANT_TURNS_JUDGED_FOR_ACTING_ON_A_MEMORY} assistant turns; a memory whose transcript is missing, unreadable or has no assistant turn after the prompt is counted apart):`,
    ...perArm(report.arms, renderedActedOn),
    '  empty-handed serves (everything served graded irrelevant, and a dig followed):',
    ...perArm(report.arms, (arm) => percentOf(arm.emptyHandedServes, 'prompts that served something')),
    ...renderedByPromptKind(report.promptKinds),
    ...renderedUncountedFinds(report.uncountedFinds),
    `  repeat mistakes: ${repeatMistakes.repeats.length} (${repeatMistakes.checkedMemoryCount} new or edited memories checked)`,
    ...repeatMistakes.repeats.map(
      (repeat) => `    - ${path.basename(repeat.newMemory)} repeats ${path.basename(repeat.existingMemory)}`,
    ),
    `  duplicates (a new memory about the same incident as the existing one, written the same day; not repeat mistakes, which need the existing memory to predate the incident): ${repeatMistakes.duplicates.length}`,
    ...repeatMistakes.duplicates.map(
      (duplicate) => `    - ${path.basename(duplicate.newMemory)} duplicates ${path.basename(duplicate.existingMemory)}`,
    ),
    ...renderedCorrectionsAnExistingMemoryCovered(report),
    `  judge errors: ${percentOf(report.judgeErrors, 'grades')}`,
    `  judged by: ${countsByName(report.judgeQuestionsByBackend)}`,
    renderedJudgeAgreementWithTheLord(report),
    '  cost per day (classifier questions):',
    ...(report.costPerDay.length === 0 ? ['    no questions asked'] : report.costPerDay.map(renderedDailyCost)),
    `  memory-read logging failures: ${report.memoryReadLoggingFailures}`,
    `  memory reads matched to no prompt: ${report.readsMatchedToNoPrompt}`,
    renderedReadAttribution(report),
    renderedUnmeasuredSessions(report),
    '',
  ].join('\n');
}
