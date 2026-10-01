import { answeringBackendOf } from '../relevance-classifier/answering-backend.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import type { OtherRepositories } from './other-repositories.ts';
import {
  isOtherRepositoriesBlockWorthShowing,
  otherRepositoriesJsonOf,
  renderedOtherRepositoriesBlock,
} from './other-repositories-output.ts';
import { COMMAND_SOURCE, probabilityOfYes, type PromptJudgement } from './recall-records.ts';
import {
  isScopeLineWorthShowing,
  renderedScopeLine,
  scopePhraseOf,
  type RecallScope,
} from './recall-scope.ts';
import {
  MEMORY_LIKELY_EXISTS,
  isVerdictLineWorthShowing,
  renderedVerdictLine,
  type RecallVerdict,
} from './recall-verdict.ts';
import {
  renderedServedMemories,
  withheldMemoriesOf,
  type MemoryDecision,
} from './select-memories.ts';

export const TEXT_OUTPUT = 'text';
export const JSON_OUTPUT = 'json';
export type RecallOutputFormat = typeof TEXT_OUTPUT | typeof JSON_OUTPUT;

export interface RecallAnswer {
  readonly decisions: readonly MemoryDecision[];
  readonly verdict: RecallVerdict;
  readonly otherRepositories: OtherRepositories;
}

function answeredByOfMemories(answer: RecallAnswer) {
  return answeringBackendOf(answer.decisions.map((decision) => decision.answer));
}

export function renderedRecallText(
  answer: RecallAnswer,
  scope: RecallScope,
  config: Pick<RecallConfig, 'verdictLineThreshold'>,
  source: PromptJudgement['source'],
): string {
  const servedMemories = renderedServedMemories(answer.decisions);
  const verdictLine = isVerdictLineWorthShowing(
    answer.verdict,
    config.verdictLineThreshold,
    servedMemories.length > 0,
  )
    ? renderedVerdictLine(answer.verdict, answeredByOfMemories(answer), scopePhraseOf(scope))
    : '';
  const memoriesAndVerdict = servedMemories + verdictLine;
  const otherRepositoriesBlock = isOtherRepositoriesBlockWorthShowing(
    answer.otherRepositories,
    source === COMMAND_SOURCE,
    memoriesAndVerdict.length > 0,
  )
    ? renderedOtherRepositoriesBlock(answer.otherRepositories)
    : '';
  const printed = memoriesAndVerdict + otherRepositoriesBlock;
  const scopeLine = isScopeLineWorthShowing(source, printed.length > 0) ? renderedScopeLine(scope) : '';
  return printed + scopeLine;
}

export function renderedWithheldMemoriesLine(decisions: readonly MemoryDecision[]): string {
  const withheld = withheldMemoriesOf(decisions);
  if (withheld.length === 0) return '';
  return `recall: ${withheld.length} relevant memories were not served: ${withheld
    .map(({ decision, reason }) => `${decision.memory.fileName} (${reason})`)
    .join(', ')}\n`;
}

export function renderedRecallJson(answer: RecallAnswer, scope: RecallScope): string {
  const json = {
    scope: {
      repositories: scope.repositories.map((repository) => repository.directory),
      globalMemoryDirectories: scope.globalMemoryDirectories,
    },
    verdict: {
      memoryLikelyExists: answer.verdict.verdict === MEMORY_LIKELY_EXISTS,
      confidence: answer.verdict.confidence,
      backend: answeredByOfMemories(answer).backend,
    },
    memories: answer.decisions
      .filter((decision) => decision.served)
      .map((decision) => ({
        file: decision.memory.filePath,
        probability: probabilityOfYes(decision),
        served: true,
        body: decision.memory.body,
      })),
    withheldMemories: withheldMemoriesOf(answer.decisions).map(({ decision, reason }) => ({
      file: decision.memory.filePath,
      probability: probabilityOfYes(decision),
      reason,
    })),
    otherRepositories: otherRepositoriesJsonOf(answer.otherRepositories),
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}
