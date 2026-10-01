import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SERVE_ARM, SHADOW_ARM, type RecallArm } from '../relevance-classifier/recall-user-config.ts';
import {
  HOOK_SOURCE,
  PREVIOUS_RECALL_LEDGER_FILE_NAME,
  PROMPT_LOG_FILE_NAME,
  RECALL_LEDGER_FILE_NAME,
  probabilityOfYes,
} from './recall-records.ts';
import { HOOK_OUTCOMES, type HookOutcome } from './hook-outcome.ts';
import { OTHER_REPOSITORY_LEDGER_FIELD } from './other-repositories-records.ts';
import { OTHER_PROMPT, PROMPT_KINDS, type PromptKind } from './prompt-kind.ts';
import {
  MEMORY_LIKELY_EXISTS,
  NO_RELEVANT_MEMORY,
  type RecallVerdict,
} from './recall-verdict.ts';

export const MEMORY_READ_LOG_FILE_NAME = 'memory-reads.jsonl';
export const MEMORY_READ_FAILURE_LOG_FILE_NAME = 'memory-reads.failures.jsonl';
export const UNRECORDED_BACKEND = 'unrecorded';

export type LogLine = Readonly<Record<string, unknown>>;

export interface LoggedPrompt {
  readonly at: string;
  readonly sessionId: string | null;
  readonly inputHash: string;
  readonly promptText: string;
  readonly arm: RecallArm;
  readonly verdict: RecallVerdict;
  readonly servedFiles: readonly string[];
  readonly recallQuestionsAsked: number;
  readonly recallBackend: string;
  readonly searchedMemoryDirectories: readonly string[] | undefined;
  readonly promptKind: PromptKind;
  readonly correctionPick: string | undefined;
  readonly transcriptPath: string | null;
  readonly hookOutcome: HookOutcome | undefined;
  readonly suppressedFiles: readonly string[];
  readonly contentHashOfEachDecidedFile: ReadonlyMap<string, string>;
  readonly probabilityOfYesOfEachJudgedFile: ReadonlyMap<string, number>;
  readonly everyAnswerLogged: boolean;
  readonly listedRepositoryMemoryDirectories: readonly string[];
}

export interface LoggedMemoryRead {
  readonly at: string;
  readonly sessionId: string | null;
  readonly kind: string;
  readonly memoryFiles: readonly string[];
  readonly returnedSomething: boolean;
  readonly readInFull: boolean;
  readonly cwd: string | null;
  readonly agentName: string | null;
  readonly herdrPaneId: string | null;
  readonly transcriptPath: string | null;
  readonly recallArguments: readonly string[] | undefined;
  readonly memoryFileHashes: ReadonlyMap<string, string>;
}

export interface RecallReportLogs {
  readonly prompts: readonly LoggedPrompt[];
  readonly memoryReads: readonly LoggedMemoryRead[];
  readonly memoryReadLoggingFailures: number;
  readonly promptKindsRecordedSince: string | undefined;
  readonly firstSightingOfEachMemory: ReadonlyMap<string, number>;
}

export async function readLogLines(filePath: string): Promise<readonly LogLine[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null ? [parsed as LogLine] : [];
    } catch {
      return [];
    }
  });
}

export function isInsideWindow(at: unknown, since: Date | undefined): boolean {
  if (since === undefined) return true;
  return typeof at === 'string' && Date.parse(at) >= since.getTime();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringsOrUndefined(value: unknown): readonly string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function stringsByString(value: unknown): ReadonlyMap<string, string> {
  if (typeof value !== 'object' || value === null) return new Map();
  return new Map(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function promptKey(line: LogLine): string {
  return `${String(line.at)}\n${String(line.inputHash)}`;
}

function isHookSummary(line: LogLine): boolean {
  return line.source === HOOK_SOURCE && 'questionsAsked' in line;
}

function isDecisionLine(line: LogLine): boolean {
  return 'questionId' in line && line.command === undefined;
}

function isOtherRepositoryLine(line: LogLine): boolean {
  return typeof line[OTHER_REPOSITORY_LEDGER_FIELD] === 'string';
}

function linesByPromptKey(lines: readonly LogLine[]): ReadonlyMap<string, readonly LogLine[]> {
  const grouped = new Map<string, LogLine[]>();
  for (const line of lines) {
    const group = grouped.get(promptKey(line)) ?? [];
    group.push(line);
    grouped.set(promptKey(line), group);
  }
  return grouped;
}

function listedRepositoryMemoryDirectoriesOf(otherRepositoryLines: readonly LogLine[]): readonly string[] {
  return otherRepositoryLines
    .filter((line) => line.listed === true && typeof line.memoryDirectory === 'string')
    .map((line) => String(line.memoryDirectory));
}

function recordsTheBackend(line: LogLine): boolean {
  return typeof line.backend === 'string';
}

function armOf(line: LogLine): RecallArm {
  return line.arm === SHADOW_ARM ? SHADOW_ARM : SERVE_ARM;
}

function isPromptKind(value: unknown): value is PromptKind {
  return PROMPT_KINDS.some((promptKind) => promptKind === value);
}

function promptKindOf(line: LogLine): PromptKind {
  return isPromptKind(line.promptKind) ? line.promptKind : OTHER_PROMPT;
}

function isHookOutcome(value: unknown): value is HookOutcome {
  return HOOK_OUTCOMES.some((hookOutcome) => hookOutcome === value);
}

function hookOutcomeOfSummary(line: LogLine): HookOutcome | undefined {
  return isHookOutcome(line.hookOutcome) ? line.hookOutcome : undefined;
}

function earliestLineRecordingAPromptKind(lines: readonly LogLine[]): string | undefined {
  const times = lines
    .filter((line) => isPromptKind(line.promptKind) && typeof line.at === 'string')
    .map((line) => String(line.at))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return times[0];
}

function correctionPickOf(promptLine: LogLine | undefined): string | undefined {
  const correction = promptLine?.correction;
  if (typeof correction !== 'object' || correction === null || !('pick' in correction)) {
    return undefined;
  }
  return typeof correction.pick === 'string' ? correction.pick : undefined;
}

function verdictOfSummary(line: LogLine): RecallVerdict {
  return {
    verdict: line.verdict === MEMORY_LIKELY_EXISTS ? MEMORY_LIKELY_EXISTS : NO_RELEVANT_MEMORY,
    confidence: typeof line.verdictConfidence === 'number' ? line.verdictConfidence : 0,
  };
}

function probabilityOfYesOfEachJudgedFile(
  decisions: readonly LogLine[],
): ReadonlyMap<string, number> {
  return new Map(
    decisions
      .filter((decision) => typeof decision.pick === 'string' && typeof decision.probability === 'number')
      .map((decision) => [
        String(decision.questionId),
        probabilityOfYes({
          answer: { pick: String(decision.pick), probability: Number(decision.probability) },
        }),
      ]),
  );
}

function promptsFromLedger(
  ledgerLines: readonly LogLine[],
  promptLines: readonly LogLine[],
  since: Date | undefined,
): readonly LoggedPrompt[] {
  const promptLineByKey = new Map(promptLines.map((line) => [promptKey(line), line]));
  const decisionsByKey = linesByPromptKey(ledgerLines.filter(isDecisionLine));
  const otherRepositoryLinesByKey = linesByPromptKey(ledgerLines.filter(isOtherRepositoryLine));
  return ledgerLines
    .filter((line) => isHookSummary(line) && isInsideWindow(line.at, since))
    .map((line) => {
      const decisions = decisionsByKey.get(promptKey(line)) ?? [];
      const promptLine = promptLineByKey.get(promptKey(line));
      return {
        at: String(line.at),
        sessionId: stringOrNull(line.sessionId),
        inputHash: String(line.inputHash),
        promptText: String(promptLine?.prompt ?? ''),
        arm: armOf(line),
        verdict: verdictOfSummary(line),
        servedFiles: decisions
          .filter((decision) => decision.served === true)
          .map((decision) => String(decision.questionId)),
        recallQuestionsAsked:
          typeof line.questionsAsked === 'number' ? line.questionsAsked : 0,
        recallBackend:
          stringOrNull(decisions.find(recordsTheBackend)?.backend) ?? UNRECORDED_BACKEND,
        searchedMemoryDirectories: stringsOrUndefined(line.searchedMemoryDirectories),
        promptKind: promptKindOf(line),
        correctionPick: correctionPickOf(promptLine),
        transcriptPath: stringOrNull(promptLine?.transcriptPath),
        hookOutcome: hookOutcomeOfSummary(line),
        suppressedFiles: decisions
          .filter((decision) => decision.suppressed === true)
          .map((decision) => String(decision.questionId)),
        contentHashOfEachDecidedFile: new Map(
          decisions
            .filter((decision) => typeof decision.contentHash === 'string')
            .map((decision) => [String(decision.questionId), String(decision.contentHash)]),
        ),
        probabilityOfYesOfEachJudgedFile: probabilityOfYesOfEachJudgedFile(decisions),
        everyAnswerLogged: line.everyAnswerLogged === true,
        listedRepositoryMemoryDirectories: listedRepositoryMemoryDirectoriesOf(
          otherRepositoryLinesByKey.get(promptKey(line)) ?? [],
        ),
      };
    });
}

function memoryReadOf(line: LogLine): LoggedMemoryRead {
  return {
    at: String(line.at),
    sessionId: stringOrNull(line.sessionId),
    kind: String(line.kind),
    memoryFiles: stringsOrUndefined(line.memoryFiles) ?? [],
    returnedSomething: line.returnedSomething === true,
    readInFull: line.readInFull === true,
    cwd: stringOrNull(line.cwd),
    agentName: stringOrNull(line.agentName),
    herdrPaneId: stringOrNull(line.herdrPaneId),
    transcriptPath: stringOrNull(line.transcriptPath),
    recallArguments: stringsOrUndefined(line.recallArguments),
    memoryFileHashes: stringsByString(line.memoryFileHashes),
  };
}

function memoryFilesSightedOnLine(line: LogLine): readonly string[] {
  if (isDecisionLine(line)) return [String(line.questionId)];
  return stringsOrUndefined(line.memoryFiles) ?? [];
}

function firstSightingOfEachMemory(lines: readonly LogLine[]): ReadonlyMap<string, number> {
  const firstSightings = new Map<string, number>();
  for (const line of lines) {
    const sightedAt = typeof line.at === 'string' ? Date.parse(line.at) : Number.NaN;
    if (Number.isNaN(sightedAt)) continue;
    for (const memoryFile of memoryFilesSightedOnLine(line)) {
      const earlier = firstSightings.get(memoryFile);
      if (earlier === undefined || sightedAt < earlier) firstSightings.set(memoryFile, sightedAt);
    }
  }
  return firstSightings;
}

export async function readRecallReportLogs(
  dataDirectory: string,
  since: Date | undefined,
): Promise<RecallReportLogs> {
  const [previousLedger, ledger, promptLines, readLines, failureLines] =
    await Promise.all(
      [
        PREVIOUS_RECALL_LEDGER_FILE_NAME,
        RECALL_LEDGER_FILE_NAME,
        PROMPT_LOG_FILE_NAME,
        MEMORY_READ_LOG_FILE_NAME,
        MEMORY_READ_FAILURE_LOG_FILE_NAME,
      ].map((fileName) => readLogLines(path.join(dataDirectory, fileName))),
    );
  const ledgerLines = [...(previousLedger ?? []), ...(ledger ?? [])];
  return {
    prompts: promptsFromLedger(ledgerLines, promptLines ?? [], since),
    memoryReads: (readLines ?? [])
      .filter((line) => isInsideWindow(line.at, since))
      .map(memoryReadOf),
    memoryReadLoggingFailures: (failureLines ?? []).filter((line) =>
      isInsideWindow(line.at, since),
    ).length,
    promptKindsRecordedSince: earliestLineRecordingAPromptKind([
      ...ledgerLines,
      ...(promptLines ?? []),
    ]),
    firstSightingOfEachMemory: firstSightingOfEachMemory([...ledgerLines, ...(readLines ?? [])]),
  };
}
