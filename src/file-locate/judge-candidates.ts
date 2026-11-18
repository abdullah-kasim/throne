import { readFile } from 'node:fs/promises';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND, meaningfulWords } from '../relevance-classifier/rules-backend.ts';
import { answeredPiecesGroupByGroup } from '../item-rank/answered-pieces.ts';
import type { RankItem } from '../item-rank/rank-items.ts';
import { requestsPackedUnderTheStateLimit } from '../item-rank/rank-requests.ts';

const HEAD_LINES_ALWAYS_INCLUDED = 120;
const CONTEXT_LINES_AROUND_A_HIT = 8;

export interface Candidate {
  readonly path: string;
  readonly reasons: readonly string[];
  readonly score: number;
}

export interface JudgeDependencies {
  chooseBackend(config: RecallConfig): Promise<ClassifierBackend>;
  readFile(path: string): Promise<string>;
  writeStderr(text: string): void;
}

export const PRODUCTION_JUDGE_DEPENDENCIES: JudgeDependencies = {
  chooseBackend: () => chooseClassifierBackend(),
  readFile: (path) => readFile(path, 'utf8'),
  writeStderr: (text) => process.stderr.write(text),
};

export function judgeQuestionText(task: string): string {
  return `Would someone doing this task need to read or change this file? Task: ${task}`;
}

function hitLineIndexes(lines: readonly string[], task: string): readonly number[] {
  const taskWords = meaningfulWords(task);
  const hits: number[] = [];
  lines.forEach((line, index) => {
    const lineWords = meaningfulWords(line);
    if ([...taskWords].some((word) => lineWords.has(word))) hits.push(index);
  });
  return hits;
}

function windowedText(lines: readonly string[], task: string): string {
  const includedLineIndexes = new Set<number>();
  for (let index = 0; index < Math.min(HEAD_LINES_ALWAYS_INCLUDED, lines.length); index += 1) {
    includedLineIndexes.add(index);
  }
  for (const hitLineIndex of hitLineIndexes(lines, task)) {
    const start = Math.max(0, hitLineIndex - CONTEXT_LINES_AROUND_A_HIT);
    const end = Math.min(lines.length - 1, hitLineIndex + CONTEXT_LINES_AROUND_A_HIT);
    for (let index = start; index <= end; index += 1) includedLineIndexes.add(index);
  }
  return [...includedLineIndexes]
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .join('\n');
}

async function itemForCandidate(
  candidate: Candidate,
  task: string,
  dependencies: JudgeDependencies,
): Promise<RankItem> {
  let text: string;
  try {
    text = windowedText((await dependencies.readFile(candidate.path)).split('\n'), task);
  } catch {
    text = candidate.reasons.join('\n');
  }
  return { id: candidate.path, text };
}

async function probabilitiesByPath(
  backend: ClassifierBackend,
  backendWhenTheFirstFails: ClassifierBackend | undefined,
  task: string,
  items: readonly RankItem[],
  dependencies: JudgeDependencies,
): Promise<ReadonlyMap<string, number>> {
  const requests = requestsPackedUnderTheStateLimit(judgeQuestionText(task), items);
  const probabilityByPath = new Map<string, number>();
  const answeredGroups = answeredPiecesGroupByGroup(requests, (request) =>
    askFailingOpen(
      backend,
      request.state,
      request.questions,
      { writeStderr: dependencies.writeStderr },
      backendWhenTheFirstFails === undefined ? {} : { backendWhenTheFirstFails },
    ),
  );
  for await (const answeredPieces of answeredGroups) {
    for (const { answer, piece } of answeredPieces) {
      if (piece === undefined) continue;
      probabilityByPath.set(
        piece.item.id,
        Math.max(probabilityByPath.get(piece.item.id) ?? 0, answer.probability),
      );
    }
  }
  return probabilityByPath;
}

export async function judgeCandidates(
  candidates: readonly Candidate[],
  task: string,
  config: RecallConfig,
  dependencies: JudgeDependencies = PRODUCTION_JUDGE_DEPENDENCIES,
): Promise<readonly Candidate[]> {
  const backend = await dependencies.chooseBackend(config);
  const items = await Promise.all(
    candidates.map((candidate) => itemForCandidate(candidate, task, dependencies)),
  );
  const probabilityByPath = await probabilitiesByPath(backend, undefined, task, items, dependencies);
  return candidates.map((candidate) => ({
    ...candidate,
    score: probabilityByPath.get(candidate.path) ?? candidate.score,
  }));
}
