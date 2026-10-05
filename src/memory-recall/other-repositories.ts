import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  answeringBackendOf,
  type AnsweringBackend,
} from '../relevance-classifier/answering-backend.ts';
import {
  NO,
  yesOrNoQuestion,
  type ClassifierAnswer,
  type FailOpenQuestion,
} from '../relevance-classifier/classifier.types.ts';
import { fileNameAsWords, isMemoryFileName, physicalPath, readRepositoryFile } from './memory-files.ts';
import { probabilityOfYes } from './recall-records.ts';
import { searchedMemoryDirectoriesOf, resolvedMemoryDirectoriesOf, type RecallScope } from './recall-scope.ts';
import type { RegisteredRepository, RepositoryRegistry } from './repository-registry.ts';
import { LOWEST_PROBABILITY_WORTH_SERVING, TASK_STATE_FIELD } from './select-memories.ts';

export const OTHER_REPOSITORIES_LISTED = 3;
const OTHER_REPOSITORY_QUESTION_PREFIX = 'other repository: ';
const SHARED_WORDS_FOR_CERTAINTY = 3;
const NEVER_REWRITE_THE_ANSWER = 1;

export interface OtherRepositoryCandidate {
  readonly repository: RegisteredRepository;
  readonly ask: string | undefined;
  readonly memoryFileNames: readonly string[];
}

export interface OtherRepositoryAnswer {
  readonly candidate: OtherRepositoryCandidate;
  readonly answer: ClassifierAnswer;
  readonly probabilityOfYes: number;
  readonly rank: number;
  readonly listed: boolean;
}

export interface OtherRepositories {
  readonly answers: readonly OtherRepositoryAnswer[];
  readonly answeredBy: AnsweringBackend;
}

export const NO_OTHER_REPOSITORIES: OtherRepositories = {
  answers: [],
  answeredBy: { backend: 'rules', jevFailure: undefined },
};

async function modifiedAt(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

export async function memoryFileNamesMostRecentFirst(
  memoryDirectory: string,
  limit: number,
): Promise<readonly string[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(memoryDirectory)).filter(isMemoryFileName);
  } catch {
    return [];
  }
  const dated = await Promise.all(
    fileNames.map(async (fileName) => ({
      fileName,
      modifiedAt: await modifiedAt(path.join(memoryDirectory, fileName)),
    })),
  );
  return dated
    .sort((left, right) => right.modifiedAt - left.modifiedAt || left.fileName.localeCompare(right.fileName))
    .slice(0, limit)
    .map((entry) => entry.fileName);
}

async function isAlreadyInScope(
  repository: RegisteredRepository,
  scope: RecallScope,
): Promise<boolean> {
  const scopedCheckouts = resolvedMemoryDirectoriesOf(scope).map((memoryDirectory) => memoryDirectory.checkout);
  if (scopedCheckouts.includes(repository.checkout)) return true;
  const searched = await Promise.all(searchedMemoryDirectoriesOf(scope).map(physicalPath));
  return searched.includes(await physicalPath(repository.memoryDirectory));
}

async function candidateOf(
  repository: RegisteredRepository,
  memoryNamesPerRepository: number,
): Promise<OtherRepositoryCandidate> {
  return {
    repository,
    ask: (await readRepositoryFile(repository.memoryDirectory))?.frontmatter.ask,
    memoryFileNames: await memoryFileNamesMostRecentFirst(repository.memoryDirectory, memoryNamesPerRepository),
  };
}

export async function otherRepositoryCandidatesOf(
  registry: RepositoryRegistry,
  scope: RecallScope,
  memoryNamesPerRepository: number,
): Promise<readonly OtherRepositoryCandidate[]> {
  const candidates = await Promise.all(
    [...registry.values()].map(async (repository) =>
      (await isAlreadyInScope(repository, scope))
        ? undefined
        : candidateOf(repository, memoryNamesPerRepository),
    ),
  );
  return candidates
    .flatMap((candidate) =>
      candidate === undefined || candidate.memoryFileNames.length === 0 ? [] : [candidate],
    )
    .sort((left, right) => left.repository.checkout.localeCompare(right.repository.checkout));
}

function questionIdOf(candidate: OtherRepositoryCandidate): string {
  return `${OTHER_REPOSITORY_QUESTION_PREFIX}${candidate.repository.checkout}`;
}

function memoryNamesAsWords(candidate: OtherRepositoryCandidate): string {
  return candidate.memoryFileNames.map((fileName) => fileNameAsWords(fileName).toLowerCase()).join('; ');
}

function otherRepositoryInstructions(candidate: OtherRepositoryCandidate): string {
  const name = candidate.repository.repositoryName;
  return [
    `Does the repository "${name}" likely hold a recorded lesson that helps with the work described in \`${TASK_STATE_FIELD}\`?`,
    ...(candidate.ask === undefined ? [] : [candidate.ask]),
    `The recorded lessons of ${name}, most recently changed first, are titled: ${memoryNamesAsWords(candidate)}.`,
  ].join(' ');
}

export function otherRepositoryQuestionOf(candidate: OtherRepositoryCandidate): FailOpenQuestion {
  return {
    ...yesOrNoQuestion(
      questionIdOf(candidate),
      otherRepositoryInstructions(candidate),
      {
        kind: 'shared-words',
        text: [candidate.repository.repositoryName, candidate.ask ?? '', memoryNamesAsWords(candidate)].join(' '),
        sharedWordsForCertainty: SHARED_WORDS_FOR_CERTAINTY,
      },
      TASK_STATE_FIELD,
    ),
    safePick: NO,
    minimumProbabilityOfSafePick: NEVER_REWRITE_THE_ANSWER,
  };
}

function mostLikelyFirst(
  left: { candidate: OtherRepositoryCandidate; probabilityOfYes: number },
  right: { candidate: OtherRepositoryCandidate; probabilityOfYes: number },
): number {
  return (
    right.probabilityOfYes - left.probabilityOfYes ||
    left.candidate.repository.repositoryName.localeCompare(right.candidate.repository.repositoryName) ||
    left.candidate.repository.checkout.localeCompare(right.candidate.repository.checkout)
  );
}

function rankedProbabilityOfYes(answer: ClassifierAnswer): number {
  return answer.failedOpen ? 0 : probabilityOfYes({ answer });
}

function isLikelyEnoughToShow(entry: { probabilityOfYes: number }): boolean {
  return entry.probabilityOfYes >= LOWEST_PROBABILITY_WORTH_SERVING;
}

export function otherRepositoriesOf(
  candidates: readonly OtherRepositoryCandidate[],
  answersAlongside: readonly ClassifierAnswer[],
): OtherRepositories {
  const answersByQuestionId = new Map(answersAlongside.map((answer) => [answer.questionId, answer]));
  const answered = candidates.flatMap((candidate) => {
    const answer = answersByQuestionId.get(questionIdOf(candidate));
    return answer === undefined ? [] : [{ candidate, answer, probabilityOfYes: rankedProbabilityOfYes(answer) }];
  });
  const answeredBy = answeringBackendOf(answered.map((entry) => entry.answer));
  const showsAnything = answeredBy.backend === 'jev';
  return {
    answers: answered.sort(mostLikelyFirst).map((entry, index) => ({
      ...entry,
      rank: index + 1,
      listed: showsAnything && isLikelyEnoughToShow(entry) && index < OTHER_REPOSITORIES_LISTED,
    })),
    answeredBy,
  };
}

export function listedRepositoriesOf(otherRepositories: OtherRepositories): readonly OtherRepositoryAnswer[] {
  return otherRepositories.answers.filter((answer) => answer.listed);
}
