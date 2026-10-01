import type { Grade } from './dig-grades.ts';
import type { LoggedPrompt } from './recall-report-logs.ts';

export interface DailyCost {
  readonly day: string;
  readonly recallQuestionsByBackend: Readonly<Record<string, number>>;
  readonly judgeQuestionsByBackend: Readonly<Record<string, number>>;
}

function dayOf(at: string): string {
  return at.slice(0, 10);
}

function countedByBackend<Item>(
  items: readonly Item[],
  backendOf: (item: Item) => string,
  countOf: (item: Item) => number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[backendOf(item)] = (counts[backendOf(item)] ?? 0) + countOf(item);
  return counts;
}

export function judgeQuestionsByBackendOf(grades: readonly Grade[]): Record<string, number> {
  return countedByBackend(grades, (grade) => grade.backend, () => 1);
}

export function costPerDayOf(
  prompts: readonly LoggedPrompt[],
  grades: readonly Grade[],
): readonly DailyCost[] {
  const days = [...new Set([...prompts.map((prompt) => dayOf(prompt.at)), ...grades.map((grade) => dayOf(grade.at))])].sort();
  return days.map((day) => ({
    day,
    recallQuestionsByBackend: countedByBackend(
      prompts.filter((prompt) => dayOf(prompt.at) === day),
      (prompt) => prompt.recallBackend,
      (prompt) => prompt.recallQuestionsAsked,
    ),
    judgeQuestionsByBackend: judgeQuestionsByBackendOf(
      grades.filter((grade) => dayOf(grade.at) === day),
    ),
  }));
}
