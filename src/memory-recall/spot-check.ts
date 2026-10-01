import path from 'node:path';
import { SERVE_ARM } from '../relevance-classifier/recall-user-config.ts';
import { readStoredGrades, type Grade } from './dig-grades.ts';
import {
  digEpisodesOf,
  hadDig,
  memoriesTheDigTurnedUp,
  type PromptAndItsDig,
} from './dig-episodes.ts';
import { inputHash } from './recall-records.ts';
import { readRecallReportLogs, type LoggedPrompt } from './recall-report-logs.ts';
import { excerptOf, fileNames } from './recall-report-render.ts';

export const PROMPTS_SPOT_CHECKED_BY_DEFAULT = 10;
const SPOT_CHECK_EXCERPT_CHARACTERS = 300;

export interface GradedPrompt {
  readonly id: string;
  readonly entry: PromptAndItsDig;
  readonly grades: readonly Grade[];
}

export interface SpotCheckDependencies {
  readonly dataDirectory: string;
  writeStdout(text: string): void;
}

export function spotCheckIdOf(prompt: LoggedPrompt): string {
  return inputHash(`${prompt.at}\n${prompt.inputHash}`);
}

function gradesByPromptHash(grades: Iterable<Grade>): ReadonlyMap<string, readonly Grade[]> {
  const byPromptHash = new Map<string, Grade[]>();
  for (const grade of grades) {
    byPromptHash.set(grade.against, [...(byPromptHash.get(grade.against) ?? []), grade]);
  }
  return byPromptHash;
}

export async function gradedPromptsIn(dataDirectory: string): Promise<readonly GradedPrompt[]> {
  const logs = await readRecallReportLogs(dataDirectory, undefined);
  const grades = gradesByPromptHash((await readStoredGrades(dataDirectory)).values());
  return digEpisodesOf(logs.prompts, logs.memoryReads).prompts.flatMap((entry) => {
    const promptGrades = grades.get(entry.prompt.inputHash) ?? [];
    return promptGrades.length === 0
      ? []
      : [{ id: spotCheckIdOf(entry.prompt), entry, grades: promptGrades }];
  });
}

function inRandomOrder<Item>(items: readonly Item[]): Item[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other] as Item, shuffled[index] as Item];
  }
  return shuffled;
}

function renderedGrade(grade: Grade): string {
  return `    ${grade.question} ${path.basename(grade.memoryFile)}: ${grade.pick} (probability ${grade.probability.toFixed(2)})`;
}

function renderedGradedPrompt({ id, entry, grades }: GradedPrompt): string {
  const { prompt } = entry;
  const served = prompt.arm === SERVE_ARM ? 'Jev served' : 'Jev would have served';
  return [
    `[${id}] ${prompt.at} ${prompt.arm} arm, ${prompt.promptKind} prompt`,
    `  prompt: "${excerptOf(prompt.promptText, SPOT_CHECK_EXCERPT_CHARACTERS)}"`,
    `  ${served}: ${fileNames(prompt.servedFiles)}`,
    `  the dig found: ${hadDig(entry) ? fileNames(memoriesTheDigTurnedUp(entry)) : 'no dig'}`,
    '  the judge graded:',
    ...grades.map(renderedGrade),
    '',
  ].join('\n');
}

export async function printSpotCheck(
  count: number,
  dependencies: SpotCheckDependencies,
): Promise<void> {
  const gradedPrompts = await gradedPromptsIn(dependencies.dataDirectory);
  const chosen = inRandomOrder(gradedPrompts).slice(0, count);
  dependencies.writeStdout(
    [
      `Spot check: ${chosen.length} of ${gradedPrompts.length} graded prompts, chosen at random`,
      '',
      ...chosen.map(renderedGradedPrompt),
      'Record your verdict on the judge: throne recall --agree <id>, or throne recall --disagree <id> "<reason>"',
      '',
    ].join('\n'),
  );
}
