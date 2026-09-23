import { readFile, realpath } from 'node:fs/promises';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import {
  pathWithHomeExpanded,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND, meaningfulWords } from '../relevance-classifier/rules-backend.ts';
import { isUnderAnyRoot, type RankItem } from '../item-rank/rank-items.ts';
import { requestsPackedUnderTheStateLimit } from '../item-rank/rank-requests.ts';

const REQUESTS_ASKED_AT_ONCE = 8;
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
  realPathOrUndefined(path: string): Promise<string | undefined>;
  writeStderr(text: string): void;
}

export const PRODUCTION_JUDGE_DEPENDENCIES: JudgeDependencies = {
  chooseBackend: (config) => chooseClassifierBackend(config),
  readFile: (path) => readFile(path, 'utf8'),
  realPathOrUndefined: async (path) => {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  },
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
  physicalAllowedRoots: readonly string[],
): Promise<RankItem> {
  const physicalPath = await dependencies.realPathOrUndefined(candidate.path);
  const mayBeSentToJev =
    physicalPath !== undefined && isUnderAnyRoot(physicalPath, physicalAllowedRoots);
  let text: string;
  try {
    text = windowedText((await dependencies.readFile(candidate.path)).split('\n'), task);
  } catch {
    text = candidate.reasons.join('\n');
  }
  return { id: candidate.path, text, mayBeSentToJev };
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
  for (let start = 0; start < requests.length; start += REQUESTS_ASKED_AT_ONCE) {
    const group = requests.slice(start, start + REQUESTS_ASKED_AT_ONCE);
    const groupAnswers = await Promise.all(
      group.map((request) =>
        askFailingOpen(
          backend,
          request.state,
          request.questions,
          { writeStderr: dependencies.writeStderr },
          backendWhenTheFirstFails === undefined ? {} : { backendWhenTheFirstFails },
        ),
      ),
    );
    group.forEach((request, requestIndex) => {
      for (const answer of groupAnswers[requestIndex] ?? []) {
        const piece = request.piecesByQuestionId.get(answer.questionId);
        if (piece === undefined) continue;
        probabilityByPath.set(
          piece.item.id,
          Math.max(probabilityByPath.get(piece.item.id) ?? 0, answer.probability),
        );
      }
    });
  }
  return probabilityByPath;
}

async function physicalAllowedRootsOf(
  config: RecallConfig,
  dependencies: JudgeDependencies,
): Promise<readonly string[]> {
  const resolved = await Promise.all(
    config.rankAllowedRoots
      .map((root) => pathWithHomeExpanded(root))
      .map((root) => dependencies.realPathOrUndefined(root)),
  );
  return resolved.filter((root): root is string => root !== undefined);
}

export async function judgeCandidates(
  candidates: readonly Candidate[],
  task: string,
  config: RecallConfig,
  dependencies: JudgeDependencies = PRODUCTION_JUDGE_DEPENDENCIES,
): Promise<readonly Candidate[]> {
  const backend = await dependencies.chooseBackend(config);
  const physicalAllowedRoots = await physicalAllowedRootsOf(config, dependencies);
  const items = await Promise.all(
    candidates.map((candidate) =>
      itemForCandidate(candidate, task, dependencies, physicalAllowedRoots),
    ),
  );
  const sentItems = backend.name === 'jev' ? items.filter((item) => item.mayBeSentToJev) : [];
  const keptLocalItems = items.filter((item) => !sentItems.includes(item));
  if (backend.name === 'jev' && keptLocalItems.length > 0) {
    dependencies.writeStderr(
      `locate: not sent to Jev, judged by rules instead (outside recall.rankAllowedRoots): ${keptLocalItems.map((item) => item.id).join(', ')}\n`,
    );
  }
  const [sentProbabilities, keptProbabilities] = await Promise.all([
    probabilitiesByPath(backend, RULES_BACKEND, task, sentItems, dependencies),
    probabilitiesByPath(RULES_BACKEND, undefined, task, keptLocalItems, dependencies),
  ]);
  const probabilityByPath = new Map([...sentProbabilities, ...keptProbabilities]);
  return candidates.map((candidate) => ({
    ...candidate,
    score: probabilityByPath.get(candidate.path) ?? candidate.score,
  }));
}
