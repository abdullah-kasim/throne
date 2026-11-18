import type {
  ClassifierAnswer,
  ClassifierBackendName,
  ClassifierFailure,
} from './classifier.types.ts';

export interface AnsweringBackend {
  readonly backend: ClassifierBackendName;
  readonly failure: ClassifierFailure | undefined;
}

export function answeringBackendOf(answers: readonly ClassifierAnswer[]): AnsweringBackend {
  return {
    backend: 'rules',
    failure: answers.find((answer) => answer.failure !== undefined)?.failure,
  };
}
