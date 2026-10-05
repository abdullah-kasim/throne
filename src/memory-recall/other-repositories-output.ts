import { answeredByLabel } from './recall-verdict.ts';
import {
  listedRepositoriesOf,
  type OtherRepositories,
  type OtherRepositoryAnswer,
} from './other-repositories.ts';
import { inPlainEnglishList } from './recall-scope.ts';

export const OTHER_REPOSITORIES_HEADING = 'Other repositories that may hold relevant memories:';
const TASK_PLACEHOLDER = '"<task>"';
const LONGEST_TASK_IN_A_COMMAND = 120;
const WORD_THAT_NEEDS_NO_QUOTES = /^[\w@%+=:,./-]+$/;

export interface OtherRepositoryJson {
  readonly repository: string;
  readonly checkout: string;
  readonly memoryDirectory: string;
  readonly probability: number;
  readonly recall: string;
}

function shellWordOf(text: string): string {
  return WORD_THAT_NEEDS_NO_QUOTES.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

function taskWordOf(taskText: string): string {
  const firstLine = taskText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine === undefined ? TASK_PLACEHOLDER : shellWordOf(firstLine.slice(0, LONGEST_TASK_IN_A_COMMAND));
}

export function recallCommandFor(checkout: string, taskText: string): string {
  return `throne recall --directory ${shellWordOf(checkout)} ${taskWordOf(taskText)}`;
}

export function percentOf(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

function nameWithPercentOf(shown: OtherRepositoryAnswer): string {
  return `${shown.candidate.repository.repositoryName} (${percentOf(shown.probabilityOfYes)})`;
}

function directiveHeadingOf(shown: readonly OtherRepositoryAnswer[]): string {
  const [only] = shown;
  if (shown.length === 1 && only !== undefined) {
    return `${only.candidate.repository.repositoryName} probably holds memories for this task (${percentOf(only.probabilityOfYes)}). Search it before looking it up yourself:`;
  }
  return `${inPlainEnglishList(shown.map(nameWithPercentOf))} probably hold memories for this task. Search them before looking them up yourself:`;
}

function renderedDirective(shown: readonly OtherRepositoryAnswer[], taskText: string): string {
  const commands = shown.map((repository) => recallCommandFor(repository.candidate.repository.checkout, taskText));
  return `${[directiveHeadingOf(shown), ...commands].join('\n')}\n`;
}

function isAnsweredByJev(otherRepositories: OtherRepositories): boolean {
  return otherRepositories.answeredBy.backend === 'jev';
}

export function isAnyRepositoryShown(otherRepositories: OtherRepositories): boolean {
  return listedRepositoriesOf(otherRepositories).length > 0;
}

export function renderedOtherRepositoriesBlock(otherRepositories: OtherRepositories, taskText: string): string {
  if (otherRepositories.answers.length === 0) return '';
  if (!isAnsweredByJev(otherRepositories)) {
    const label = answeredByLabel(otherRepositories.answeredBy, { confidence: 0 });
    return `${OTHER_REPOSITORIES_HEADING} none listed, because the ${label} answered instead of Jev.\n`;
  }
  if (!isAnyRepositoryShown(otherRepositories)) return '';
  return renderedDirective(listedRepositoriesOf(otherRepositories), taskText);
}

export function isOtherRepositoriesBlockWorthShowing(
  otherRepositories: OtherRepositories,
  printedByEveryRecall: boolean,
  anythingElsePrinted: boolean,
): boolean {
  return isAnyRepositoryShown(otherRepositories) || printedByEveryRecall || anythingElsePrinted;
}

export function otherRepositoriesJsonOf(
  otherRepositories: OtherRepositories,
  taskText: string,
): readonly OtherRepositoryJson[] {
  return listedRepositoriesOf(otherRepositories).map((listed) => ({
    repository: listed.candidate.repository.repositoryName,
    checkout: listed.candidate.repository.checkout,
    memoryDirectory: listed.candidate.repository.memoryDirectory,
    probability: listed.probabilityOfYes,
    recall: recallCommandFor(listed.candidate.repository.checkout, taskText),
  }));
}
