import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  NO,
  YES,
  type ClassifierBackend,
  type ClassifierQuestion,
} from '../relevance-classifier/classifier.types.ts';
import type { RegisteredRepository } from './repository-registry.ts';

export const MEMORY_ANSWER_PROBABILITY_OF_NO = 0.9;

export interface FakeRepository {
  readonly name: string;
  readonly memoryFileNames?: readonly string[];
  readonly ask?: string;
}

export function fakeRepositoriesUnder(
  root: string,
  repositories: readonly FakeRepository[],
): readonly RegisteredRepository[] {
  return repositories.map(({ name, memoryFileNames = ['A_LESSON.md'], ask }) => {
    const memoryDirectory = path.join(root, 'other-memories', name);
    mkdirSync(memoryDirectory, { recursive: true });
    memoryFileNames.forEach((fileName, index) => {
      const filePath = path.join(memoryDirectory, fileName);
      writeFileSync(filePath, `# ${fileName}\n\n- a lesson of ${name}\n`);
      const modifiedAt = new Date(Date.UTC(2026, 8, 1, 0, index));
      utimesSync(filePath, modifiedAt, modifiedAt);
    });
    if (ask !== undefined) {
      writeFileSync(path.join(memoryDirectory, 'REPOSITORY.md'), `---\nask: "${ask}"\n---\n# ${name}\n`);
    }
    return {
      checkout: path.join(root, 'checkouts', name),
      repositoryName: name,
      memoryDirectory,
      lastSeenAt: null,
    };
  });
}

export function scratchRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'recall-other-repositories-'));
}

export interface RecordingBackend extends ClassifierBackend {
  readonly requests: (readonly ClassifierQuestion[])[];
}

function repositoryNameInQuestion(question: ClassifierQuestion): string | undefined {
  const match = /^other repository: .*[\\/]([^\\/]+)$/.exec(question.id);
  return match?.[1];
}

export function jevBackendAnswering(
  probabilityOfYesByRepository: Readonly<Record<string, number>>,
): RecordingBackend {
  const requests: (readonly ClassifierQuestion[])[] = [];
  return {
    name: 'jev',
    requests,
    answer: async (_state, questions) => {
      requests.push(questions);
      return questions.map((question) => {
        const repositoryName = repositoryNameInQuestion(question);
        if (repositoryName === undefined) {
          return { questionId: question.id, pick: NO, probability: MEMORY_ANSWER_PROBABILITY_OF_NO };
        }
        return { questionId: question.id, pick: YES, probability: probabilityOfYesByRepository[repositoryName] ?? 0 };
      });
    },
  };
}
