import type { JevCallerKind } from '../relevance-classifier/jev-usage-log.ts';
import {
  SERVE_ARM,
  type HookMode,
  type RecallArm,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import {
  CORRECTION_QUESTION,
  correctionVerdictOf,
  isAskedWhetherItCorrects,
  type CorrectionVerdict,
} from './correction-question.ts';
import { hookRunRecordOf } from './hook-outcome.ts';
import type { RecallRequest } from './hook-payload.ts';
import { readMemoriesInEachDirectoryOnce } from './memory-files.ts';
import { keepMemoryVersions } from './memory-versions.ts';
import type { PromptKind } from './prompt-kind.ts';
import {
  HOOK_SOURCE,
  appendDecisionsToLedger,
  isWorthALedgerLine,
  readWhenServedInSession,
  recordWhenServedInSession,
  type PromptJudgement,
  type WhenServedInSession,
} from './recall-records.ts';
import type { RecallReportDependencies } from './recall-report.ts';
import {
  repositoryNameOf,
  repositoryScopesOf,
  searchedMemoryDirectoriesOf,
  type RecallScope,
} from './recall-scope.ts';
import { verdictOf, type RecallVerdict } from './recall-verdict.ts';
import { selectMemories, type MemoryDecision } from './select-memories.ts';
import {
  otherRepositoriesOf,
  otherRepositoryCandidatesOf,
  otherRepositoryQuestionOf,
  type OtherRepositories,
} from './other-repositories.ts';
import {
  JSON_OUTPUT,
  TEXT_OUTPUT,
  renderedRecallJson,
  renderedRecallText,
  renderedWithheldMemoriesLine,
  type RecallAnswer,
  type RecallOutputFormat,
} from './recall-output.ts';
import {
  readRepositoryRegistry,
  registryWithScopedRepositories,
  saveRepositoryRegistry,
  type RepositoryRegistry,
  type RepositoryRegistryDependencies,
} from './repository-registry.ts';

export interface RecallForPromptDependencies
  extends Pick<RecallReportDependencies, 'chooseBackend' | 'dataDirectory' | 'now' | 'writeStdout'>,
    RepositoryRegistryDependencies {
  writeStderr(text: string): void;
}

export interface PromptOccasion {
  readonly source: PromptJudgement['source'];
  readonly arm: RecallArm;
  readonly hookMode?: HookMode;
  readonly decidedAt: Date;
  readonly hookPrompt?: HookPrompt;
  readonly outputFormat?: RecallOutputFormat;
}

interface HookPrompt {
  readonly promptKind: PromptKind;
  readonly startedAt: number;
}

interface DecidedMemories {
  readonly decisions: readonly MemoryDecision[];
  readonly otherRepositories: OtherRepositories;
  readonly whenServedInSession: WhenServedInSession;
  readonly correction: CorrectionVerdict | undefined;
}

function jevCallerOf(source: PromptJudgement['source']): JevCallerKind {
  return source === HOOK_SOURCE ? 'hook' : 'hand recall';
}

async function rememberScopedRepositories(
  scope: RecallScope,
  seenAt: Date,
  dependencies: RecallForPromptDependencies,
): Promise<RepositoryRegistry> {
  let registry: RepositoryRegistry = new Map();
  try {
    registry = registryWithScopedRepositories(await readRepositoryRegistry(dependencies), scope, seenAt);
    await saveRepositoryRegistry(dependencies.dataDirectory, registry);
  } catch (error) {
    dependencies.writeStderr(
      `recall: the list of repositories recall has seen could not be updated: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return registry;
}

async function decideMemories(
  request: RecallRequest,
  scope: RecallScope,
  config: RecallConfig,
  timeoutMilliseconds: number | undefined,
  occasion: PromptOccasion,
  dependencies: RecallForPromptDependencies,
): Promise<DecidedMemories> {
  const promptKind = occasion.hookPrompt?.promptKind;
  const memories = await readMemoriesInEachDirectoryOnce(searchedMemoryDirectoriesOf(scope));
  const repositoryName = repositoryNameOf(scope);
  const otherRepositoryCandidates = await otherRepositoryCandidatesOf(
    await rememberScopedRepositories(scope, occasion.decidedAt, dependencies),
    scope,
    config.repositoryMemoryNamesPerRepository,
  );
  const whenServedInSession: WhenServedInSession =
    request.sessionId === undefined
      ? new Map()
      : await readWhenServedInSession(dependencies.dataDirectory, request.sessionId);
  const { decisions, answersAlongside } = await selectMemories(
    {
      taskText: request.taskText,
      ...(repositoryName === undefined ? {} : { repositoryName }),
      memories,
      repositoryScopes: repositoryScopesOf(scope),
      alreadyServedFilePaths: new Set(whenServedInSession.keys()),
      backend: await dependencies.chooseBackend(config, jevCallerOf(occasion.source)),
      config,
      timeoutMilliseconds,
      questionsAskedAlongside: [
        ...(isAskedWhetherItCorrects(promptKind) ? [CORRECTION_QUESTION] : []),
        ...otherRepositoryCandidates.map(otherRepositoryQuestionOf),
      ],
    },
    { writeStderr: dependencies.writeStderr },
  );
  return {
    decisions,
    otherRepositories: otherRepositoriesOf(otherRepositoryCandidates, answersAlongside),
    whenServedInSession,
    correction: correctionVerdictOf(answersAlongside),
  };
}

export async function recallForPrompt(
  request: RecallRequest,
  scope: RecallScope,
  config: RecallConfig,
  timeoutMilliseconds: number | undefined,
  occasion: PromptOccasion,
  dependencies: RecallForPromptDependencies,
): Promise<CorrectionVerdict | undefined> {
  const { decisions, otherRepositories, whenServedInSession, correction } = await decideMemories(
    request,
    scope,
    config,
    timeoutMilliseconds,
    occasion,
    dependencies,
  );
  const answer: RecallAnswer = { decisions, verdict: verdictOf(decisions), otherRepositories };
  if (occasion.arm === SERVE_ARM) {
    printRecallAnswer(answer, request.taskText, scope, config, occasion, dependencies);
  }
  await recordWhatWasDecided(
    { request, scope, answer, whenServedInSession, occasion },
    dependencies,
  );
  return correction;
}

function printRecallAnswer(
  answer: RecallAnswer,
  taskText: string,
  scope: RecallScope,
  config: RecallConfig,
  occasion: PromptOccasion,
  dependencies: RecallForPromptDependencies,
): void {
  if ((occasion.outputFormat ?? TEXT_OUTPUT) === JSON_OUTPUT) {
    dependencies.writeStdout(renderedRecallJson(answer, scope, taskText));
    return;
  }
  dependencies.writeStdout(renderedRecallText(answer, scope, config, occasion.source, taskText));
  const withheldMemoriesLine = renderedWithheldMemoriesLine(answer.decisions);
  if (withheldMemoriesLine.length > 0) dependencies.writeStderr(withheldMemoriesLine);
}

async function rememberWhatWasServedInTheSession(
  request: RecallRequest,
  decisions: readonly MemoryDecision[],
  whenServedInSession: WhenServedInSession,
  servedAt: Date,
  dependencies: RecallForPromptDependencies,
): Promise<void> {
  const servedFilePaths = decisions
    .filter((decision) => decision.served)
    .map((decision) => decision.memory.filePath);
  if (request.sessionId === undefined || servedFilePaths.length === 0) return;
  await recordWhenServedInSession(
    dependencies.dataDirectory,
    request.sessionId,
    new Map([
      ...whenServedInSession,
      ...servedFilePaths.map((filePath) => [filePath, servedAt.toISOString()] as const),
    ]),
    dependencies.now(),
  );
}

interface WhatWasDecided {
  readonly request: RecallRequest;
  readonly scope: RecallScope;
  readonly answer: RecallAnswer;
  readonly whenServedInSession: WhenServedInSession;
  readonly occasion: PromptOccasion;
}

async function recordWhatWasDecided(
  { request, scope, answer, whenServedInSession, occasion }: WhatWasDecided,
  dependencies: RecallForPromptDependencies,
): Promise<void> {
  const { decisions, verdict, otherRepositories } = answer;
  try {
    if (occasion.arm === SERVE_ARM) {
      await rememberWhatWasServedInTheSession(
        request,
        decisions,
        whenServedInSession,
        occasion.decidedAt,
        dependencies,
      );
    }
    await keepMemoryVersions(
      dependencies.dataDirectory,
      decisions.filter(isWorthALedgerLine).map((decision) => decision.memory.fileText),
    );
    const { hookPrompt, outputFormat, ...judgementOccasion } = occasion;
    await appendDecisionsToLedger(dependencies.dataDirectory, {
      ...judgementOccasion,
      ...(hookPrompt === undefined
        ? {}
        : {
            hookRun: hookRunRecordOf(hookPrompt.promptKind, decisions, hookPrompt.startedAt),
          }),
      taskText: request.taskText,
      decisions,
      otherRepositories,
      sessionId: request.sessionId,
      verdict,
      searchedMemoryDirectories: searchedMemoryDirectoriesOf(scope),
      whenServedInSession,
    });
  } catch (error) {
    dependencies.writeStderr(
      `recall: the memories were printed but the record of it could not be written: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
