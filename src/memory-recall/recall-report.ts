import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { readJevUsageLines, type JevCallerKind } from '../relevance-classifier/jev-usage-log.ts';
import { renderedJevSpendByDayAndCaller } from './recall-report-jev-spend.ts';
import { spawnRecordsOfEveryAgent } from './agent-spawn-records.ts';
import {
  contentHashSeenBy,
  digEpisodesOf,
  hadDig,
  memoriesTheDigTurnedUp,
  type PromptAndItsDig,
} from './dig-episodes.ts';
import { digScopeOf, type DigScopeDependencies } from './dig-scope.ts';
import { RELEVANT_TO_PROMPT, gradeEach, type GradeRequest, type Judge } from './dig-grades.ts';
import {
  NO_REPEAT_MISTAKE_FINDINGS,
  repeatMistakesSince,
} from './repeat-mistakes.ts';
import { readRecallReportLogs, type LoggedPrompt } from './recall-report-logs.ts';
import { correctionsAnExistingMemoryCovered } from './recall-report-corrections.ts';
import { whetherServedMemoriesWereActedOn } from './recall-report-acted-on.ts';
import { recallReportOf } from './recall-report-metrics.ts';
import { askOfEachMemory } from './recall-report-candidacy.ts';
import { renderedRecallReport } from './recall-report-render.ts';
import { creationTimesOf } from './memory-creation-times.ts';
import { physicalPathOfEach } from './memory-files.ts';
import { readAttributionOf } from './read-attribution.ts';
import { unmeasuredSessionsByHarness } from './unmeasured-sessions.ts';
import { judgeAgreementWithTheLord } from './spot-check-verdicts.ts';

export interface RecallReportDependencies extends DigScopeDependencies {
  loadConfig(): Promise<RecallConfig>;
  chooseBackend(config: RecallConfig, caller: JevCallerKind): Promise<ClassifierBackend>;
  memoryDirectoriesForRepeats(config: RecallConfig): Promise<readonly string[]>;
  dataDirectory: string;
  jevDataHome: string;
  now(): Date;
  writeStdout(text: string): void;
}

function gradeRequestsFor(entry: PromptAndItsDig): readonly GradeRequest[] {
  const memoryFiles = new Set([...memoriesTheDigTurnedUp(entry), ...entry.prompt.servedFiles]);
  return [...memoryFiles].map((memoryFile) => {
    const contentHash = contentHashSeenBy(entry, memoryFile);
    return {
      question: RELEVANT_TO_PROMPT,
      against: entry.prompt.inputHash,
      againstText: entry.prompt.promptText,
      memoryFile,
      ...(contentHash === undefined ? {} : { contentHash }),
    };
  });
}

function earliestPromptTime(prompts: readonly LoggedPrompt[]): Date | undefined {
  if (prompts.length === 0) return undefined;
  return new Date(Math.min(...prompts.map((prompt) => Date.parse(prompt.at))));
}

export async function printRecallReport(
  since: Date | undefined,
  dependencies: RecallReportDependencies,
): Promise<void> {
  const config = await dependencies.loadConfig();
  const logs = await readRecallReportLogs(dependencies.dataDirectory, since);
  const episodes = digEpisodesOf(logs.prompts, logs.memoryReads);
  const agents = await spawnRecordsOfEveryAgent(dependencies.agentLedgerDirectory);
  const judge: Judge = {
    backend: await dependencies.chooseBackend(config, 'audit'),
    dataDirectory: dependencies.dataDirectory,
    now: () => dependencies.now(),
  };
  const promptGrades = await gradeEach(episodes.prompts.flatMap(gradeRequestsFor), judge);
  const digScopes = new Map(
    await Promise.all(
      episodes.prompts.map(
        async (entry) =>
          [
            entry,
            await digScopeOf(entry, config, {
              resolveProjectMemoryDirectory: (directory) =>
                dependencies.resolveProjectMemoryDirectory(directory),
              agentLedgerDirectory: dependencies.agentLedgerDirectory,
            }),
          ] as const,
      ),
    ),
  );
  const memoryCreationTimes = await creationTimesOf(
    episodes.prompts.flatMap(memoriesTheDigTurnedUp),
    logs.firstSightingOfEachMemory,
  );
  const physicalPathOfEachMemory = await physicalPathOfEach(
    episodes.prompts.flatMap((entry) => [
      ...memoriesTheDigTurnedUp(entry),
      ...entry.prompt.servedFiles,
      ...entry.prompt.suppressedFiles,
      ...(hadDig(entry) ? entry.prompt.probabilityOfYesOfEachJudgedFile.keys() : []),
    ]),
  );
  const windowStart = since ?? earliestPromptTime(logs.prompts);
  const everyMemoryDirectory = await dependencies.memoryDirectoriesForRepeats(config);
  const repeatMistakes =
    windowStart === undefined
      ? NO_REPEAT_MISTAKE_FINDINGS
      : await repeatMistakesSince(
          windowStart,
          everyMemoryDirectory,
          logs.firstSightingOfEachMemory,
          judge,
        );
  dependencies.writeStdout(
    renderedRecallReport(
      recallReportOf({
        since,
        promptKindsRecordedSince: logs.promptKindsRecordedSince,
        episodes,
        promptGrades,
        digScopes,
        memoryCreationTimes,
        physicalPathOfEachMemory,
        askOfEachFoundMemory: await askOfEachMemory(episodes.prompts.flatMap(memoriesTheDigTurnedUp)),
        repeatMistakes,
        correctionFindings: await correctionsAnExistingMemoryCovered(
          logs.prompts,
          everyMemoryDirectory,
          logs.firstSightingOfEachMemory,
          judge,
        ),
        actedOnFindings: await whetherServedMemoriesWereActedOn(episodes.prompts, promptGrades, judge),
        memoryReadLoggingFailures: logs.memoryReadLoggingFailures,
        readAttribution: readAttributionOf(logs.memoryReads, agents),
        unmeasuredSessions: unmeasuredSessionsByHarness(agents, since),
        judgeAgreementWithTheLord: await judgeAgreementWithTheLord(dependencies.dataDirectory, since),
      }),
    ) + renderedJevSpendByDayAndCaller(await readJevUsageLines(dependencies.jevDataHome, since)),
  );
}
