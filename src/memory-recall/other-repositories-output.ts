import { answeredByLabel } from './recall-verdict.ts';
import {
  listedRepositoriesOf,
  type OtherRepositories,
  type OtherRepositoryAnswer,
} from './other-repositories.ts';

export const OTHER_REPOSITORIES_HEADING = 'Other repositories that may hold relevant memories:';
const TASK_PLACEHOLDER = '"<task>"';
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

export function recallCommandFor(checkout: string): string {
  return `throne recall --directory ${shellWordOf(checkout)} ${TASK_PLACEHOLDER}`;
}

function percentOf(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

function renderedListedRepository(listed: OtherRepositoryAnswer): string {
  const { repository } = listed.candidate;
  return `- ${repository.repositoryName} (${percentOf(listed.probabilityOfYes)}): ${recallCommandFor(repository.checkout)}\n`;
}

function isAnsweredByJev(otherRepositories: OtherRepositories): boolean {
  return otherRepositories.answeredBy.backend === 'jev';
}

export function renderedOtherRepositoriesBlock(otherRepositories: OtherRepositories): string {
  if (otherRepositories.answers.length === 0) return '';
  if (!isAnsweredByJev(otherRepositories)) {
    const label = answeredByLabel(otherRepositories.answeredBy, { confidence: 0 });
    return `${OTHER_REPOSITORIES_HEADING} none listed, because the ${label} answered instead of Jev.\n`;
  }
  const listed = listedRepositoriesOf(otherRepositories);
  if (listed.length === 0) return '';
  return `${OTHER_REPOSITORIES_HEADING}\n${listed.map(renderedListedRepository).join('')}`;
}

export function isOtherRepositoriesBlockWorthShowing(
  otherRepositories: OtherRepositories,
  printedByEveryRecall: boolean,
  anythingElsePrinted: boolean,
): boolean {
  return listedRepositoriesOf(otherRepositories).length > 0 || printedByEveryRecall || anythingElsePrinted;
}

export function otherRepositoriesJsonOf(otherRepositories: OtherRepositories): readonly OtherRepositoryJson[] {
  return listedRepositoriesOf(otherRepositories).map((listed) => ({
    repository: listed.candidate.repository.repositoryName,
    checkout: listed.candidate.repository.checkout,
    memoryDirectory: listed.candidate.repository.memoryDirectory,
    probability: listed.probabilityOfYes,
    recall: recallCommandFor(listed.candidate.repository.checkout),
  }));
}
