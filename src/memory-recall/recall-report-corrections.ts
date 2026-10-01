import { mostLikelyFirst, rankItemsByQuestion } from '../item-rank/rank-by-question.ts';
import type { RankItem } from '../item-rank/rank-items.ts';
import { YES } from '../relevance-classifier/classifier.types.ts';
import {
  COVERS_THE_CORRECTION,
  gradeEach,
  gradeKey,
  isRelevant,
  type Grade,
  type Judge,
} from './dig-grades.ts';
import { isInsideScope } from './dig-scope.ts';
import { creationTimesOf, isCreatedAfter } from './memory-creation-times.ts';
import { physicalPath, readMemoriesInEachDirectoryOnce } from './memory-files.ts';
import { TYPED_PROMPT } from './prompt-kind.ts';
import type { LoggedPrompt } from './recall-report-logs.ts';

const CORRECTION_CHARACTERS_IN_THE_RANKING_QUESTION = 300;

export interface CoveredCorrection {
  readonly prompt: LoggedPrompt;
  readonly coveringMemory: string;
  readonly outsideTheSearchedScope: boolean;
}

export interface CorrectionFindings {
  readonly corrections: readonly LoggedPrompt[];
  readonly covered: readonly CoveredCorrection[];
  readonly grades: readonly Grade[];
}

export function isTypedPromptJudgedForACorrection(prompt: LoggedPrompt): boolean {
  return prompt.promptKind === TYPED_PROMPT && prompt.correctionPick !== undefined;
}

export function isTypedCorrection(prompt: LoggedPrompt): boolean {
  return isTypedPromptJudgedForACorrection(prompt) && prompt.correctionPick === YES;
}

interface MemoryPool {
  readonly memories: readonly RankItem[];
  readonly creationTimes: ReadonlyMap<string, number>;
}

async function memoryPoolOf(
  memoryDirectories: readonly string[],
  firstSightingOfEachMemory: ReadonlyMap<string, number>,
): Promise<MemoryPool> {
  const memories = await readMemoriesInEachDirectoryOnce(memoryDirectories);
  return {
    memories: memories.map((memory) => ({ id: memory.filePath, text: memory.fileText, mayBeSentToJev: true })),
    creationTimes: await creationTimesOf(
      memories.map((memory) => memory.filePath),
      firstSightingOfEachMemory,
    ),
  };
}

function memoriesThatPredate(prompt: LoggedPrompt, pool: MemoryPool): readonly RankItem[] {
  return pool.memories.filter((memory) => !isCreatedAfter(memory.id, prompt.at, pool.creationTimes));
}

async function isOutsideTheSearchedScope(
  prompt: LoggedPrompt,
  coveringMemory: string,
): Promise<boolean> {
  if (prompt.searchedMemoryDirectories === undefined) return false;
  const searchedScope = await Promise.all(prompt.searchedMemoryDirectories.map(physicalPath));
  return !isInsideScope(await physicalPath(coveringMemory), searchedScope);
}

async function closestMemoryToTheCorrection(
  prompt: LoggedPrompt,
  memories: readonly RankItem[],
  judge: Judge,
): Promise<string | undefined> {
  const correction = prompt.promptText.slice(0, CORRECTION_CHARACTERS_IN_THE_RANKING_QUESTION);
  const question = `Does this recorded lesson teach what the person corrects in "${correction}"?`;
  const outcome = await rankItemsByQuestion(judge.backend, question, memories);
  if (outcome.failed) return undefined;
  return [...outcome.ranked].sort(mostLikelyFirst)[0]?.id;
}

export async function correctionsAnExistingMemoryCovered(
  prompts: readonly LoggedPrompt[],
  everyMemoryDirectory: readonly string[],
  firstSightingOfEachMemory: ReadonlyMap<string, number>,
  judge: Judge,
): Promise<CorrectionFindings> {
  const corrections = prompts.filter(isTypedCorrection);
  const pool = await memoryPoolOf(
    [...everyMemoryDirectory, ...corrections.flatMap((prompt) => prompt.searchedMemoryDirectories ?? [])],
    firstSightingOfEachMemory,
  );
  const candidates: CoveredCorrection[] = [];
  for (const prompt of corrections) {
    const coveringMemory = await closestMemoryToTheCorrection(
      prompt,
      memoriesThatPredate(prompt, pool),
      judge,
    );
    if (coveringMemory === undefined) continue;
    candidates.push({
      prompt,
      coveringMemory,
      outsideTheSearchedScope: await isOutsideTheSearchedScope(prompt, coveringMemory),
    });
  }
  const grades = await gradeEach(
    candidates.map(({ prompt, coveringMemory }) => ({
      question: COVERS_THE_CORRECTION,
      against: prompt.inputHash,
      againstText: prompt.promptText,
      memoryFile: coveringMemory,
    })),
    judge,
  );
  return {
    corrections,
    covered: candidates.filter(({ prompt, coveringMemory }) =>
      isRelevant(grades.get(gradeKey(COVERS_THE_CORRECTION, prompt.inputHash, coveringMemory))),
    ),
    grades: [...grades.values()],
  };
}
