import type { PromptOutcome } from './recall-report-outcomes.ts';

export interface LaterNoteExample {
  readonly at: string;
  readonly promptText: string;
  readonly memoryFile: string;
  readonly createdAt: string;
}

export interface UncountedFinds {
  readonly laterNotes: number;
  readonly laterNoteExamples: readonly LaterNoteExample[];
  readonly digsAfterAFailedHookRun: number;
  readonly findsAfterAFailedHookRun: number;
  readonly alreadyShown: number;
}

function countOf(
  outcomes: readonly PromptOutcome[],
  finds: (outcome: PromptOutcome) => readonly string[],
): number {
  return outcomes.reduce((total, outcome) => total + finds(outcome).length, 0);
}

function mostRecentFirst(left: LaterNoteExample, right: LaterNoteExample): number {
  return Date.parse(right.at) - Date.parse(left.at);
}

export function uncountedFindsOf(
  outcomes: readonly PromptOutcome[],
  memoryCreationTimes: ReadonlyMap<string, number>,
  examplesShown: number,
): UncountedFinds {
  return {
    laterNotes: countOf(outcomes, (outcome) => outcome.foundItsOwnLaterNote),
    laterNoteExamples: outcomes
      .flatMap(({ entry, foundItsOwnLaterNote }) =>
        foundItsOwnLaterNote.map((memoryFile) => ({
          at: entry.prompt.at,
          promptText: entry.prompt.promptText,
          memoryFile,
          createdAt: new Date(memoryCreationTimes.get(memoryFile) ?? 0).toISOString(),
        })),
      )
      .sort(mostRecentFirst)
      .slice(0, examplesShown),
    digsAfterAFailedHookRun: outcomes.filter(
      (outcome) => outcome.afterAFailedHookRun && outcome.dug,
    ).length,
    findsAfterAFailedHookRun: countOf(outcomes, (outcome) => outcome.foundAfterAFailedHookRun),
    alreadyShown: countOf(outcomes, (outcome) => outcome.foundAlreadyShown),
  };
}
