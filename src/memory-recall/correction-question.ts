import {
  NO,
  yesOrNoQuestion,
  type ClassifierAnswer,
  type FailOpenQuestion,
} from '../relevance-classifier/classifier.types.ts';
import { TYPED_PROMPT, type PromptKind } from './prompt-kind.ts';
import { TASK_STATE_FIELD } from './select-memories.ts';

export const CORRECTION_QUESTION_ID = 'is the prompt a correction';

const CORRECTION_INSTRUCTIONS = `Is the text in \`${TASK_STATE_FIELD}\` the person correcting or overruling an agent's earlier action or claim?`;

const PHRASES_OF_A_CORRECTION = [
  "that's wrong",
  'that is wrong',
  'not what i asked',
  'you should have',
  'you should not have',
  "you shouldn't have",
  'why did you',
  "don't do that",
  'do not do that',
  'i said',
  'i told you',
  'undo that',
  'revert that',
  'you missed',
  'you forgot',
];

const EVEN_ODDS = 0.5;

export interface CorrectionVerdict {
  readonly pick: string;
  readonly probability: number;
  readonly backend: ClassifierAnswer['backend'];
  readonly failedOpen: boolean;
}

export function isAskedWhetherItCorrects(promptKind: PromptKind | undefined): boolean {
  return promptKind === TYPED_PROMPT;
}

export const CORRECTION_QUESTION: FailOpenQuestion = {
  ...yesOrNoQuestion(
    CORRECTION_QUESTION_ID,
    CORRECTION_INSTRUCTIONS,
    { kind: 'any-phrase', phrases: PHRASES_OF_A_CORRECTION },
    TASK_STATE_FIELD,
  ),
  safePick: NO,
  minimumProbabilityOfSafePick: EVEN_ODDS,
};

export function correctionVerdictOf(
  answers: readonly ClassifierAnswer[],
): CorrectionVerdict | undefined {
  const answer = answers.find((candidate) => candidate.questionId === CORRECTION_QUESTION_ID);
  if (answer === undefined) return undefined;
  return {
    pick: answer.pick,
    probability: answer.probability,
    backend: answer.backend,
    failedOpen: answer.failedOpen,
  };
}
