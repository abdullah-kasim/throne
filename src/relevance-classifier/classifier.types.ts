export const CLASSIFIER_BACKEND_NAMES = ['rules', 'jev'] as const;
export type ClassifierBackendName = (typeof CLASSIFIER_BACKEND_NAMES)[number];

export const YES = 'yes';
export const NO = 'no';
export const YES_OR_NO_CHOICES = [YES, NO] as const;

export type ClassifierState = string | Readonly<Record<string, string>>;

export interface SharedWordsRule {
  readonly kind: 'shared-words';
  readonly text: string;
  readonly sharedWordsForCertainty: number;
}

export interface AnyPhraseRule {
  readonly kind: 'any-phrase';
  readonly phrases: readonly string[];
}

export type YesOrNoRule = SharedWordsRule | AnyPhraseRule;

export interface ClassifierQuestion {
  readonly id: string;
  readonly instructions: string;
  readonly choices: readonly string[];
  readonly yesOrNoRule: YesOrNoRule;
  readonly stateField?: string;
}

export interface FailOpenQuestion extends ClassifierQuestion {
  readonly safePick: string;
  readonly minimumProbabilityOfSafePick: number;
}

export interface BackendAnswer {
  readonly questionId: string;
  readonly pick: string;
  readonly probability: number;
}

export interface ClassifierAnswer extends BackendAnswer {
  readonly backend: ClassifierBackendName;
  readonly failedOpen: boolean;
}

export interface ClassifierBackend {
  readonly name: ClassifierBackendName;
  answer(
    state: ClassifierState,
    questions: readonly ClassifierQuestion[],
    abandoned?: AbortSignal,
  ): Promise<readonly BackendAnswer[]>;
}

export function yesOrNoQuestion(
  id: string,
  instructions: string,
  yesOrNoRule: YesOrNoRule,
  stateField?: string,
): ClassifierQuestion {
  return {
    id,
    instructions,
    choices: YES_OR_NO_CHOICES,
    yesOrNoRule,
    ...(stateField === undefined ? {} : { stateField }),
  };
}
