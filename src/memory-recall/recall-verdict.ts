import type { AnsweringBackend } from '../relevance-classifier/answering-backend.ts';
import {
  CLASSIFIER_BUDGET_LOCK_BUSY,
  CLASSIFIER_BUILD_WITHOUT_JEV_LIMITER,
  CLASSIFIER_RATE_LIMITED,
} from '../relevance-classifier/classifier.types.ts';
import { probabilityOfYes } from './recall-records.ts';
import { isWorthServing, type MemoryDecision } from './select-memories.ts';

export const MEMORY_LIKELY_EXISTS = 'memory likely exists';
export const NO_RELEVANT_MEMORY = 'no relevant memory';

export interface RecallVerdict {
  readonly verdict: typeof MEMORY_LIKELY_EXISTS | typeof NO_RELEVANT_MEMORY;
  readonly confidence: number;
}

export function verdictOf(decisions: readonly MemoryDecision[]): RecallVerdict {
  const topProbabilityOfYes = Math.max(0, ...decisions.map(probabilityOfYes));
  return decisions.some((decision) => isWorthServing(decision.answer))
    ? { verdict: MEMORY_LIKELY_EXISTS, confidence: topProbabilityOfYes }
    : { verdict: NO_RELEVANT_MEMORY, confidence: 1 - topProbabilityOfYes };
}

export function isVerdictLineWorthShowing(
  verdict: RecallVerdict,
  verdictLineThreshold: number,
  anythingServed: boolean,
): boolean {
  return (
    anythingServed ||
    (verdict.verdict === NO_RELEVANT_MEMORY &&
      verdict.confidence > verdictLineThreshold)
  );
}

export function answeredByLabel(answeredBy: AnsweringBackend, verdict: Pick<RecallVerdict, 'confidence'>): string {
  if (answeredBy.backend === 'jev') return `Jev (${Math.round(verdict.confidence * 100)}% sure)`;
  if (answeredBy.jevFailure === undefined) return 'rules';
  if (answeredBy.jevFailure === CLASSIFIER_RATE_LIMITED) return 'rules (Jev budget used up)';
  if (answeredBy.jevFailure === CLASSIFIER_BUDGET_LOCK_BUSY) return 'rules (Jev budget lock busy)';
  if (answeredBy.jevFailure === CLASSIFIER_BUILD_WITHOUT_JEV_LIMITER) return 'rules (this build has no Jev limiter)';
  return 'rules (Jev failed)';
}

export function renderedVerdictLine(
  verdict: RecallVerdict,
  answeredBy: AnsweringBackend,
  scopePhrase: string,
): string {
  const label = answeredByLabel(answeredBy, verdict);
  return verdict.verdict === NO_RELEVANT_MEMORY
    ? `${label}: no relevant memory in ${scopePhrase}.\n`
    : `${label}: a relevant memory likely exists in ${scopePhrase}.\n`;
}
