import {
  YES,
  yesOrNoQuestion,
  type FailOpenQuestion,
} from '../relevance-classifier/classifier.types.ts';
import {
  JEV_REQUEST_TOKEN_LIMIT,
  JEV_STATE_AND_LONGEST_QUESTION_TOKEN_LIMIT,
  estimatedTokens,
} from '../relevance-classifier/jev-backend.ts';
import { meaningfulWords } from '../relevance-classifier/rules-backend.ts';
import type { RankItem } from './rank-items.ts';

const SHARE_OF_EACH_LIMIT_WE_FILL = 0.8;
const CHARACTERS_PER_ESTIMATED_TOKEN = 3;
const ESTIMATED_TOKENS_OF_OVERHEAD_PER_ITEM = 40;
const STATE_TOKEN_BUDGET = Math.floor(
  Math.min(JEV_STATE_AND_LONGEST_QUESTION_TOKEN_LIMIT, JEV_REQUEST_TOKEN_LIMIT / 2) *
    SHARE_OF_EACH_LIMIT_WE_FILL,
);
export const CHARACTERS_IN_THE_LARGEST_PIECE =
  STATE_TOKEN_BUDGET * CHARACTERS_PER_ESTIMATED_TOKEN;

export interface ItemPiece {
  readonly item: RankItem;
  readonly text: string;
}

export interface RankRequest {
  readonly state: Readonly<Record<string, string>>;
  readonly questions: readonly FailOpenQuestion[];
  readonly piecesByQuestionId: ReadonlyMap<string, ItemPiece>;
}

export function piecesOf(item: RankItem): readonly ItemPiece[] {
  if (item.text.length <= CHARACTERS_IN_THE_LARGEST_PIECE) {
    return [{ item, text: item.text }];
  }
  const pieces: ItemPiece[] = [];
  for (
    let start = 0;
    start < item.text.length;
    start += CHARACTERS_IN_THE_LARGEST_PIECE
  ) {
    pieces.push({
      item,
      text: item.text.slice(start, start + CHARACTERS_IN_THE_LARGEST_PIECE),
    });
  }
  return pieces;
}

function pieceQuestion(
  yesOrNoQuestionText: string,
  stateField: string,
): FailOpenQuestion {
  return {
    ...yesOrNoQuestion(
      stateField,
      `${yesOrNoQuestionText} Judge only the text in \`${stateField}\`.`,
      {
        kind: 'shared-words',
        text: yesOrNoQuestionText,
        sharedWordsForCertainty: Math.max(
          1,
          meaningfulWords(yesOrNoQuestionText).size,
        ),
      },
      stateField,
    ),
    safePick: YES,
    minimumProbabilityOfSafePick: 0,
  };
}

export function requestsPackedUnderTheStateLimit(
  yesOrNoQuestionText: string,
  items: readonly RankItem[],
): readonly RankRequest[] {
  const requests: RankRequest[] = [];
  let state: Record<string, string> = {};
  let questions: FailOpenQuestion[] = [];
  let pieces = new Map<string, ItemPiece>();
  let stateTokens = 0;
  const closeRequest = (): void => {
    if (questions.length === 0) return;
    requests.push({ state, questions, piecesByQuestionId: pieces });
    state = {};
    questions = [];
    pieces = new Map();
    stateTokens = 0;
  };
  let pieceNumber = 0;
  for (const piece of items.flatMap(piecesOf)) {
    const pieceTokens =
      estimatedTokens(piece.text) + ESTIMATED_TOKENS_OF_OVERHEAD_PER_ITEM;
    if (stateTokens + pieceTokens > STATE_TOKEN_BUDGET) closeRequest();
    const stateField = `item_${pieceNumber}`;
    pieceNumber += 1;
    state[stateField] = piece.text;
    questions.push(pieceQuestion(yesOrNoQuestionText, stateField));
    pieces.set(stateField, piece);
    stateTokens += pieceTokens;
  }
  closeRequest();
  return requests;
}
