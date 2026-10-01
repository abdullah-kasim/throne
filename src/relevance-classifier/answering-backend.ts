import type {
  ClassifierAnswer,
  ClassifierBackendName,
  ClassifierFailure,
} from './classifier.types.ts';

export interface AnsweringBackend {
  readonly backend: ClassifierBackendName;
  readonly jevFailure: ClassifierFailure | undefined;
}

export function answeringBackendOf(answers: readonly ClassifierAnswer[]): AnsweringBackend {
  const jevFailure = answers.find((answer) => answer.failure !== undefined)?.failure;
  if (jevFailure !== undefined) return { backend: 'rules', jevFailure };
  return {
    backend: answers.some((answer) => answer.backend === 'jev') ? 'jev' : 'rules',
    jevFailure: undefined,
  };
}
