import {
  YES,
  yesOrNoQuestion,
  type ClassifierAnswer,
  type ClassifierBackend,
  type FailOpenQuestion,
  type SharedWordsRule,
} from '../relevance-classifier/classifier.types.ts';
import {
  askFailingOpen,
  type FailOpenDependencies,
} from '../relevance-classifier/fail-open-classifier.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { GLOBAL_SCOPE, type Memory } from './memory-frontmatter.types.ts';
import { fileNameAsWords, isSuperseded } from './memory-files.ts';

const SHARED_WORDS_FOR_CERTAINTY = 3;
export const LOWEST_PROBABILITY_WORTH_SERVING = 0.4;
export const TASK_STATE_FIELD = 'task';
export const REPOSITORY_STATE_FIELD = 'repository';

export interface MemoryDecision {
  readonly memory: Memory;
  readonly answer: ClassifierAnswer;
  readonly served: boolean;
  readonly servedEarlierInSession: boolean;
}

export interface MemorySelectionRequest {
  readonly taskText: string;
  readonly repositoryName?: string;
  readonly memories: readonly Memory[];
  readonly repositoryScopes: readonly string[];
  readonly alreadyServedFilePaths: ReadonlySet<string>;
  readonly backend: ClassifierBackend;
  readonly config: Pick<
    RecallConfig,
    'serveThreshold' | 'serveThresholdWhenCostIsHigh' | 'maximumInjectedCharacters'
  >;
  readonly timeoutMilliseconds?: number;
  readonly questionsAskedAlongside?: readonly FailOpenQuestion[];
}

export interface MemorySelection {
  readonly decisions: readonly MemoryDecision[];
  readonly answersAlongside: readonly ClassifierAnswer[];
}

export const BELOW_THE_SERVING_FLOOR = 'below the serving floor';
export const OVER_THE_SIZE_LIMIT = 'over the size limit';
export type WithheldReason = typeof BELOW_THE_SERVING_FLOOR | typeof OVER_THE_SIZE_LIMIT;

export interface WithheldMemory {
  readonly decision: MemoryDecision;
  readonly reason: WithheldReason;
}

export function isWorthServing(answer: ClassifierAnswer): boolean {
  return answer.pick === YES && answer.probability >= LOWEST_PROBABILITY_WORTH_SERVING;
}

function isWithheld(decision: MemoryDecision): boolean {
  return decision.answer.pick === YES && !decision.served && !decision.servedEarlierInSession;
}

function withheldReasonOf(decision: MemoryDecision): WithheldReason {
  return isWorthServing(decision.answer) ? OVER_THE_SIZE_LIMIT : BELOW_THE_SERVING_FLOOR;
}

export function withheldMemoriesOf(decisions: readonly MemoryDecision[]): readonly WithheldMemory[] {
  return decisions
    .filter(isWithheld)
    .map((decision) => ({ decision, reason: withheldReasonOf(decision) }));
}

export function isInScope(
  memory: Memory,
  repositoryScopes: readonly string[],
): boolean {
  const scope = memory.frontmatter.scope;
  return (
    scope === undefined ||
    scope === GLOBAL_SCOPE ||
    repositoryScopes.includes(scope)
  );
}

function relevanceInstructions(memory: Memory): string {
  return (
    memory.frontmatter.ask ??
    `Is a recorded lesson titled "${fileNameAsWords(memory.fileName).toLowerCase()}" relevant to the work described in \`${TASK_STATE_FIELD}\`?`
  );
}

export function relevanceRuleOf(memory: Memory): SharedWordsRule {
  const { ask, description, name } = memory.frontmatter;
  return {
    kind: 'shared-words',
    text: [ask, fileNameAsWords(memory.fileName), description, name].join(' '),
    sharedWordsForCertainty: SHARED_WORDS_FOR_CERTAINTY,
  };
}

function relevanceQuestion(
  memory: Memory,
  config: MemorySelectionRequest['config'],
): FailOpenQuestion {
  return {
    ...yesOrNoQuestion(
      memory.filePath,
      relevanceInstructions(memory),
      relevanceRuleOf(memory),
      TASK_STATE_FIELD,
    ),
    safePick: YES,
    minimumProbabilityOfSafePick:
      memory.frontmatter.cost_if_missed === 'high'
        ? config.serveThresholdWhenCostIsHigh
        : config.serveThreshold,
  };
}

function mostRelevantFirst(
  left: { memory: Memory; answer: ClassifierAnswer },
  right: { memory: Memory; answer: ClassifierAnswer },
): number {
  const costRank = (memory: Memory) =>
    memory.frontmatter.cost_if_missed === 'high' ? 0 : 1;
  return (
    right.answer.probability - left.answer.probability ||
    costRank(left.memory) - costRank(right.memory) ||
    left.memory.fileName.localeCompare(right.memory.fileName)
  );
}

export async function selectMemories(
  request: MemorySelectionRequest,
  dependencies?: FailOpenDependencies,
): Promise<MemorySelection> {
  const candidates = request.memories.filter(
    (memory) =>
      !isSuperseded(memory) &&
      isInScope(memory, request.repositoryScopes) &&
      memory.body.length > 0,
  );
  const questionsAskedAlongside = request.questionsAskedAlongside ?? [];
  const answers = await askFailingOpen(
    request.backend,
    {
      [TASK_STATE_FIELD]: request.taskText,
      ...(request.repositoryName === undefined
        ? {}
        : { [REPOSITORY_STATE_FIELD]: request.repositoryName }),
    },
    [
      ...candidates.map((memory) => relevanceQuestion(memory, request.config)),
      ...questionsAskedAlongside,
    ],
    dependencies,
    {
      timeoutMilliseconds: request.timeoutMilliseconds,
      backendWhenTheFirstFails:
        request.backend === RULES_BACKEND ? undefined : RULES_BACKEND,
    },
  );
  const answered = candidates
    .map((memory, index) => ({ memory, answer: answers[index] }))
    .filter(
      (entry): entry is { memory: Memory; answer: ClassifierAnswer } =>
        entry.answer !== undefined,
    )
    .sort(mostRelevantFirst);
  let charactersLeft =
    request.config.maximumInjectedCharacters - RECALLED_MEMORIES_HEADING.length;
  const decisions = answered.map(({ memory, answer }) => {
    const servedEarlierInSession = request.alreadyServedFilePaths.has(memory.filePath);
    const fits = renderedMemory(memory).length <= charactersLeft;
    const served = !servedEarlierInSession && isWorthServing(answer) && fits;
    if (served) charactersLeft -= renderedMemory(memory).length;
    return { memory, answer, served, servedEarlierInSession };
  });
  return { decisions, answersAlongside: answers.slice(candidates.length) };
}

export function renderedMemory(memory: Memory): string {
  return `## ${memory.fileName}\n${memory.body}\n\n`;
}

export const RECALLED_MEMORIES_HEADING =
  'Recalled memories for this prompt, chosen by `throne recall`, most relevant first. Each is shown once per session.\n\n';

export function renderedServedMemories(
  decisions: readonly MemoryDecision[],
): string {
  const served = decisions.filter((decision) => decision.served);
  if (served.length === 0) return '';
  return (
    RECALLED_MEMORIES_HEADING +
    served.map((decision) => renderedMemory(decision.memory)).join('')
  );
}
