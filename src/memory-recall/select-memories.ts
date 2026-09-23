import {
  YES,
  yesOrNoQuestion,
  type ClassifierAnswer,
  type ClassifierBackend,
  type FailOpenQuestion,
} from '../relevance-classifier/classifier.types.ts';
import {
  askFailingOpen,
  type FailOpenDependencies,
} from '../relevance-classifier/fail-open-classifier.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { GLOBAL_SCOPE, type Memory } from './memory-frontmatter.types.ts';

const SHARED_WORDS_FOR_CERTAINTY = 3;
export const TASK_STATE_FIELD = 'task';
export const REPOSITORY_STATE_FIELD = 'repository';

export interface MemoryDecision {
  readonly memory: Memory;
  readonly answer: ClassifierAnswer;
  readonly served: boolean;
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
}

export function isSuperseded(memory: Memory): boolean {
  return memory.frontmatter.status === 'superseded';
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

function fileNameAsWords(memory: Memory): string {
  return memory.fileName.replace(/\.md$/, '').replaceAll(/[_-]+/g, ' ');
}

function relevanceInstructions(memory: Memory): string {
  return (
    memory.frontmatter.ask ??
    `Is a recorded lesson titled "${fileNameAsWords(memory).toLowerCase()}" relevant to the work described in \`${TASK_STATE_FIELD}\`?`
  );
}

function relevanceQuestion(
  memory: Memory,
  config: MemorySelectionRequest['config'],
): FailOpenQuestion {
  const { ask, description, name } = memory.frontmatter;
  return {
    ...yesOrNoQuestion(
      memory.filePath,
      relevanceInstructions(memory),
      {
        kind: 'shared-words',
        text: [ask, fileNameAsWords(memory), description, name].join(' '),
        sharedWordsForCertainty: SHARED_WORDS_FOR_CERTAINTY,
      },
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
): Promise<readonly MemoryDecision[]> {
  const candidates = request.memories.filter(
    (memory) =>
      !isSuperseded(memory) &&
      isInScope(memory, request.repositoryScopes) &&
      !request.alreadyServedFilePaths.has(memory.filePath) &&
      memory.body.length > 0,
  );
  const answers = await askFailingOpen(
    request.backend,
    {
      [TASK_STATE_FIELD]: request.taskText,
      ...(request.repositoryName === undefined
        ? {}
        : { [REPOSITORY_STATE_FIELD]: request.repositoryName }),
    },
    candidates.map((memory) => relevanceQuestion(memory, request.config)),
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
  return answered.map(({ memory, answer }) => {
    const fits = renderedMemory(memory).length <= charactersLeft;
    const served = answer.pick === YES && fits;
    if (served) charactersLeft -= renderedMemory(memory).length;
    return { memory, answer, served };
  });
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
