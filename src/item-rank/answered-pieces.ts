import type { ClassifierAnswer } from '../relevance-classifier/classifier.types.ts';
import type { ItemPiece, RankRequest } from './rank-requests.ts';

const REQUESTS_ASKED_AT_ONCE = 8;

export interface AnsweredPiece {
  readonly answer: ClassifierAnswer;
  readonly piece: ItemPiece | undefined;
}

export async function* answeredPiecesGroupByGroup(
  requests: readonly RankRequest[],
  askOneRequest: (request: RankRequest) => Promise<readonly ClassifierAnswer[]>,
): AsyncGenerator<readonly AnsweredPiece[]> {
  for (let start = 0; start < requests.length; start += REQUESTS_ASKED_AT_ONCE) {
    const group = requests.slice(start, start + REQUESTS_ASKED_AT_ONCE);
    const groupAnswers = await Promise.all(group.map((request) => askOneRequest(request)));
    yield group.flatMap((request, requestIndex) =>
      (groupAnswers[requestIndex] ?? []).map((answer) => ({
        answer,
        piece: request.piecesByQuestionId.get(answer.questionId),
      })),
    );
  }
}
