import type { PromptAndItsDig } from './dig-episodes.ts';
import {
  ACTED_ON,
  RELEVANT_TO_PROMPT,
  gradeEach,
  gradeKey,
  isRelevant,
  type Grade,
  type GradeRequest,
  type Judge,
} from './dig-grades.ts';
import { inputHash } from './recall-records.ts';
import { rateOf, type Rate } from './recall-report-outcomes.ts';
import { assistantTurnsAfter } from './transcript-turns.ts';

export const ASSISTANT_TURNS_JUDGED_FOR_ACTING_ON_A_MEMORY = 5;

const TURN_SEPARATOR = '\n\n---\n\n';

export interface ActedOnJudgement {
  readonly memoryFile: string;
  readonly actedOn: boolean | undefined;
}

export interface ActedOnFindings {
  readonly judgementsByPrompt: ReadonlyMap<PromptAndItsDig, readonly ActedOnJudgement[]>;
  readonly grades: readonly Grade[];
}

export interface ActedOnRate {
  readonly actedOn: Rate;
  readonly transcriptUnavailable: number;
}

interface TurnsAfterThePrompt {
  readonly entry: PromptAndItsDig;
  readonly relevantServedFiles: readonly string[];
  readonly turnsText: string | undefined;
}

function relevantServedFilesOf(
  entry: PromptAndItsDig,
  promptGrades: ReadonlyMap<string, Grade>,
): readonly string[] {
  return entry.prompt.servedFiles.filter((memoryFile) =>
    isRelevant(promptGrades.get(gradeKey(RELEVANT_TO_PROMPT, entry.prompt.inputHash, memoryFile))),
  );
}

async function turnsTextAfter(entry: PromptAndItsDig): Promise<string | undefined> {
  const { transcriptPath, at } = entry.prompt;
  if (transcriptPath === null) return undefined;
  const turns = await assistantTurnsAfter(
    transcriptPath,
    at,
    ASSISTANT_TURNS_JUDGED_FOR_ACTING_ON_A_MEMORY,
  );
  return turns === undefined || turns.length === 0 ? undefined : turns.join(TURN_SEPARATOR);
}

function actedOnRequestsOf(turns: TurnsAfterThePrompt): readonly GradeRequest[] {
  const { entry, relevantServedFiles, turnsText } = turns;
  if (turnsText === undefined) return [];
  return relevantServedFiles.map((memoryFile) => {
    const contentHash = entry.prompt.contentHashOfEachDecidedFile.get(memoryFile);
    return {
      question: ACTED_ON,
      against: inputHash(turnsText),
      againstText: turnsText,
      memoryFile,
      ...(contentHash === undefined ? {} : { contentHash }),
    };
  });
}

function judgementsOf(
  turns: TurnsAfterThePrompt,
  grades: ReadonlyMap<string, Grade>,
): readonly ActedOnJudgement[] {
  const { relevantServedFiles, turnsText } = turns;
  return relevantServedFiles.map((memoryFile) => ({
    memoryFile,
    actedOn:
      turnsText === undefined
        ? undefined
        : isRelevant(grades.get(gradeKey(ACTED_ON, inputHash(turnsText), memoryFile))),
  }));
}

export async function whetherServedMemoriesWereActedOn(
  entries: readonly PromptAndItsDig[],
  promptGrades: ReadonlyMap<string, Grade>,
  judge: Judge,
): Promise<ActedOnFindings> {
  const turnsAfterEachPrompt: TurnsAfterThePrompt[] = [];
  for (const entry of entries) {
    const relevantServedFiles = relevantServedFilesOf(entry, promptGrades);
    if (relevantServedFiles.length === 0) continue;
    turnsAfterEachPrompt.push({ entry, relevantServedFiles, turnsText: await turnsTextAfter(entry) });
  }
  const grades = await gradeEach(turnsAfterEachPrompt.flatMap(actedOnRequestsOf), judge);
  return {
    judgementsByPrompt: new Map(
      turnsAfterEachPrompt.map((turns) => [turns.entry, judgementsOf(turns, grades)] as const),
    ),
    grades: [...grades.values()],
  };
}

export function actedOnRateOf(
  entries: readonly PromptAndItsDig[],
  findings: ActedOnFindings,
): ActedOnRate {
  const judgements = entries.flatMap((entry) => findings.judgementsByPrompt.get(entry) ?? []);
  const judged = judgements.filter((judgement) => judgement.actedOn !== undefined);
  return {
    actedOn: rateOf(judged, (judgement) => judgement.actedOn === true),
    transcriptUnavailable: judgements.length - judged.length,
  };
}
