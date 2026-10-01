import type {
  ClassifierBackend,
  ClassifierBackendName,
} from '../relevance-classifier/classifier.types.ts';
import {
  askFailingOpen,
  isLeftWithoutAnAnswer,
} from '../relevance-classifier/fail-open-classifier.ts';
import { answeredPiecesGroupByGroup } from './answered-pieces.ts';
import type { RankItem } from './rank-items.ts';
import { requestsPackedUnderTheStateLimit } from './rank-requests.ts';

export interface RankedItem {
  readonly id: string;
  readonly probability: number;
  readonly backend: ClassifierBackendName;
}

export interface RankingOutcome {
  readonly ranked: readonly RankedItem[];
  readonly failed: boolean;
}

export async function rankItemsByQuestion(
  backend: ClassifierBackend,
  question: string,
  items: readonly RankItem[],
): Promise<RankingOutcome> {
  const requests = requestsPackedUnderTheStateLimit(question, items);
  const bestProbabilityById = new Map<string, number>();
  const answeringBackendById = new Map<string, ClassifierBackendName>();
  const answeredGroups = answeredPiecesGroupByGroup(requests, (request) =>
    askFailingOpen(backend, request.state, request.questions, {
      writeStderr: () => undefined,
    }),
  );
  for await (const answeredPieces of answeredGroups) {
    if (answeredPieces.some(({ answer }) => isLeftWithoutAnAnswer(answer, backend))) {
      return { ranked: [], failed: true };
    }
    for (const { answer, piece } of answeredPieces) {
      if (piece === undefined) continue;
      answeringBackendById.set(piece.item.id, answer.backend);
      bestProbabilityById.set(
        piece.item.id,
        Math.max(bestProbabilityById.get(piece.item.id) ?? 0, answer.probability),
      );
    }
  }
  return {
    failed: false,
    ranked: items.map((item) => ({
      id: item.id,
      probability: bestProbabilityById.get(item.id) ?? 0,
      backend: answeringBackendById.get(item.id) ?? backend.name,
    })),
  };
}

export function mostLikelyFirst(left: RankedItem, right: RankedItem): number {
  return right.probability - left.probability || left.id.localeCompare(right.id);
}
