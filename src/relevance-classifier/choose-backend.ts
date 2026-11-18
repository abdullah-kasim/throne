import type { ClassifierBackend } from './classifier.types.ts';
import { RULES_BACKEND } from './rules-backend.ts';

export function chooseClassifierBackend(): Promise<ClassifierBackend> {
  return Promise.resolve(RULES_BACKEND);
}

export function renderedBackendStatus(): string {
  return ['backend that would answer now: rules', 'why: the keyword rules are the only backend', ''].join('\n');
}
