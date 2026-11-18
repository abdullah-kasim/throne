import type { AnsweringBackend } from '../relevance-classifier/answering-backend.ts';
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

export function answeredByLabel(answeredBy: AnsweringBackend): string {
  return answeredBy.failure === undefined ? 'rules' : 'rules (the judge failed)';
}

export function renderedVerdictLine(
  verdict: RecallVerdict,
  answeredBy: AnsweringBackend,
  scopePhrase: string,
): string {
  const label = answeredByLabel(answeredBy);
  return verdict.verdict === NO_RELEVANT_MEMORY
    ? `${label}: no relevant memory in ${scopePhrase}.\n`
    : `${label}: a relevant memory likely exists in ${scopePhrase}.\n`;
}
