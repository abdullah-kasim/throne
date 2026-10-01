import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { YES, type BackendAnswer } from '../relevance-classifier/classifier.types.ts';
import {
  SHADOW_ARM,
  SPLIT_HOOK_MODE,
  type HookMode,
  type RecallArm,
} from '../relevance-classifier/recall-user-config.ts';
import type { CorrectionVerdict } from './correction-question.ts';
import type { HookRunRecord, SkippedHookRunRecord } from './hook-outcome.ts';
import { contentHashOf } from './memory-versions.ts';
import type { OtherRepositories } from './other-repositories.ts';
import { otherRepositoryLedgerLinesOf } from './other-repositories-records.ts';
import type { PromptKind } from './prompt-kind.ts';
import type { RecallVerdict } from './recall-verdict.ts';
import { isWorthServing, type MemoryDecision } from './select-memories.ts';

export function productionRecallDataDirectory(): string {
  return path.join(homedir(), '.throne', 'data', 'recall');
}

export function inputHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function servedListPath(dataDirectory: string, sessionId: string): string {
  const safeSessionId = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, '_');
  return path.join(dataDirectory, 'served', `${safeSessionId}.json`);
}

export type WhenServedInSession = ReadonlyMap<string, string | null>;

function isServedAt(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function whenServedFromServedList(servedList: unknown): WhenServedInSession {
  if (Array.isArray(servedList)) {
    return new Map(
      servedList
        .filter((filePath): filePath is string => typeof filePath === 'string')
        .map((filePath) => [filePath, null]),
    );
  }
  if (typeof servedList !== 'object' || servedList === null) return new Map();
  return new Map(
    Object.entries(servedList).filter((entry): entry is [string, string | null] =>
      isServedAt(entry[1]),
    ),
  );
}

export async function readWhenServedInSession(
  dataDirectory: string,
  sessionId: string,
): Promise<WhenServedInSession> {
  try {
    return whenServedFromServedList(
      JSON.parse(await readFile(servedListPath(dataDirectory, sessionId), 'utf8')),
    );
  } catch {
    return new Map();
  }
}

export const DAYS_A_SERVED_LIST_IS_KEPT = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

async function removeServedListsOlderThanTheLimit(
  servedDirectory: string,
  now: Date,
): Promise<void> {
  for (const fileName of await readdir(servedDirectory)) {
    const filePath = path.join(servedDirectory, fileName);
    try {
      const ageInDays =
        (now.getTime() - (await stat(filePath)).mtimeMs) / MILLISECONDS_PER_DAY;
      if (ageInDays > DAYS_A_SERVED_LIST_IS_KEPT) await rm(filePath, { force: true });
    } catch {
      continue;
    }
  }
}

export async function recordWhenServedInSession(
  dataDirectory: string,
  sessionId: string,
  whenServed: WhenServedInSession,
  now: Date,
): Promise<void> {
  const listPath = servedListPath(dataDirectory, sessionId);
  await mkdir(path.dirname(listPath), { recursive: true });
  await writeFile(listPath, `${JSON.stringify(Object.fromEntries(whenServed), null, 1)}\n`);
  await removeServedListsOlderThanTheLimit(path.dirname(listPath), now);
}

export const RECALL_LEDGER_FILE_NAME = 'ledger.jsonl';
export const PREVIOUS_RECALL_LEDGER_FILE_NAME = 'ledger.previous.jsonl';
export const LEDGER_BYTES_BEFORE_IT_IS_ROTATED = 20_000_000;
export const LOWEST_PROBABILITY_OF_YES_WORTH_A_LEDGER_LINE = 0.1;

export function probabilityOfYes(decision: {
  readonly answer: Pick<BackendAnswer, 'pick' | 'probability'>;
}): number {
  return decision.answer.pick === YES
    ? decision.answer.probability
    : 1 - decision.answer.probability;
}

export function isWorthALedgerLine(decision: MemoryDecision): boolean {
  return (
    decision.served ||
    decision.answer.failedOpen ||
    probabilityOfYes(decision) >= LOWEST_PROBABILITY_OF_YES_WORTH_A_LEDGER_LINE
  );
}

export function isSuppressedRepeat(decision: MemoryDecision): boolean {
  return decision.servedEarlierInSession && isWorthServing(decision.answer);
}

function suppressionRecordOf(
  decision: MemoryDecision,
  whenServedInSession: WhenServedInSession,
): object {
  if (!isSuppressedRepeat(decision)) return {};
  return {
    suppressed: true,
    servedEarlierAt: whenServedInSession.get(decision.memory.filePath) ?? null,
  };
}

async function rotateLedgerOverTheSizeLimit(
  dataDirectory: string,
  ledgerByteLimit: number,
): Promise<void> {
  const ledgerPath = path.join(dataDirectory, RECALL_LEDGER_FILE_NAME);
  let ledgerBytes: number;
  try {
    ledgerBytes = (await stat(ledgerPath)).size;
  } catch {
    return;
  }
  if (ledgerBytes > ledgerByteLimit) {
    await rename(
      ledgerPath,
      path.join(dataDirectory, PREVIOUS_RECALL_LEDGER_FILE_NAME),
    );
  }
}

export async function appendLinesToLedger(
  dataDirectory: string,
  lines: readonly object[],
  ledgerByteLimit: number = LEDGER_BYTES_BEFORE_IT_IS_ROTATED,
): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dataDirectory, { recursive: true });
  await rotateLedgerOverTheSizeLimit(dataDirectory, ledgerByteLimit);
  await appendFile(
    path.join(dataDirectory, RECALL_LEDGER_FILE_NAME),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

export const HOOK_SOURCE = 'hook';
export const COMMAND_SOURCE = 'command';

export interface PromptJudgement {
  readonly taskText: string;
  readonly decisions: readonly MemoryDecision[];
  readonly otherRepositories?: OtherRepositories;
  readonly decidedAt: Date;
  readonly source: typeof HOOK_SOURCE | typeof COMMAND_SOURCE;
  readonly sessionId: string | undefined;
  readonly arm: RecallArm;
  readonly hookMode?: HookMode;
  readonly verdict: RecallVerdict;
  readonly searchedMemoryDirectories: readonly string[];
  readonly hookRun?: HookRunRecord;
  readonly whenServedInSession: WhenServedInSession;
}

const HOOK_MODES_THAT_LOG_EVERY_ANSWER: readonly HookMode[] = [SPLIT_HOOK_MODE, SHADOW_ARM];

function logsEveryAnswer(judgement: Pick<PromptJudgement, 'source' | 'hookMode'>): boolean {
  return (
    judgement.source === COMMAND_SOURCE ||
    (judgement.hookMode !== undefined &&
      HOOK_MODES_THAT_LOG_EVERY_ANSWER.includes(judgement.hookMode))
  );
}

function fullDecisionLineOf(
  decision: MemoryDecision,
  judgement: PromptJudgement,
  at: string,
  hashOfInput: string,
): object {
  return {
    at,
    questionId: decision.answer.questionId,
    inputHash: hashOfInput,
    pick: decision.answer.pick,
    probability: decision.answer.probability,
    backend: decision.answer.backend,
    failedOpen: decision.answer.failedOpen,
    ...(decision.answer.failure === undefined ? {} : { reason: decision.answer.failure }),
    served: decision.served,
    ...suppressionRecordOf(decision, judgement.whenServedInSession),
    contentHash: contentHashOf(decision.memory.fileText),
    arm: judgement.arm,
    sessionId: judgement.sessionId ?? null,
  };
}

function compactDecisionLineOf(decision: MemoryDecision, at: string, hashOfInput: string): object {
  return {
    at,
    inputHash: hashOfInput,
    questionId: decision.answer.questionId,
    pick: decision.answer.pick,
    probability: decision.answer.probability,
  };
}

export async function appendDecisionsToLedger(
  dataDirectory: string,
  judgement: PromptJudgement,
  ledgerByteLimit: number = LEDGER_BYTES_BEFORE_IT_IS_ROTATED,
): Promise<void> {
  const { decisions, arm } = judgement;
  const at = judgement.decidedAt.toISOString();
  const hashOfInput = inputHash(judgement.taskText);
  const everyAnswerLogged = logsEveryAnswer(judgement);
  const decisionLines = decisions
    .filter((decision) => everyAnswerLogged || isWorthALedgerLine(decision))
    .map((decision) =>
      isWorthALedgerLine(decision)
        ? fullDecisionLineOf(decision, judgement, at, hashOfInput)
        : compactDecisionLineOf(decision, at, hashOfInput),
    );
  const summaryLine = {
    at,
    inputHash: hashOfInput,
    source: judgement.source,
    sessionId: judgement.sessionId ?? null,
    arm,
    ...(judgement.hookMode === undefined ? {} : { hookMode: judgement.hookMode }),
    verdict: judgement.verdict.verdict,
    verdictConfidence: judgement.verdict.confidence,
    searchedMemoryDirectories: judgement.searchedMemoryDirectories,
    ...judgement.hookRun,
    questionsAsked: decisions.length,
    served: decisions.filter((decision) => decision.served).length,
    confidentNoAnswersLeftOut: decisions.length - decisionLines.length,
    ...(everyAnswerLogged ? { everyAnswerLogged } : {}),
  };
  const otherRepositoryLines =
    judgement.otherRepositories === undefined
      ? []
      : otherRepositoryLedgerLinesOf(judgement.otherRepositories, {
          at,
          inputHash: hashOfInput,
          arm,
          sessionId: judgement.sessionId ?? null,
        });
  await appendLinesToLedger(
    dataDirectory,
    [summaryLine, ...decisionLines, ...otherRepositoryLines],
    ledgerByteLimit,
  );
}

export async function appendSkippedHookRunToLedger(
  dataDirectory: string,
  sessionId: string | undefined,
  skippedRun: SkippedHookRunRecord,
  at: Date,
): Promise<void> {
  await appendLinesToLedger(dataDirectory, [
    { at: at.toISOString(), source: HOOK_SOURCE, sessionId: sessionId ?? null, ...skippedRun },
  ]);
}

export const PROMPT_LOG_FILE_NAME = 'prompts.jsonl';
export const PROMPT_CHARACTERS_KEPT = 2000;

export interface PromptLogEntry {
  readonly sessionId: string | undefined;
  readonly taskText: string;
  readonly promptKind: PromptKind;
  readonly searchedMemoryDirectories: readonly string[];
  readonly transcriptPath: string | undefined;
  readonly correction: CorrectionVerdict | undefined;
  readonly at: Date;
}

export async function appendPromptToPromptLog(
  dataDirectory: string,
  entry: PromptLogEntry,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const promptLine = {
    at: entry.at.toISOString(),
    sessionId: entry.sessionId ?? null,
    inputHash: inputHash(entry.taskText),
    prompt: entry.taskText.slice(0, PROMPT_CHARACTERS_KEPT),
    promptKind: entry.promptKind,
    searchedMemoryDirectories: entry.searchedMemoryDirectories,
    transcriptPath: entry.transcriptPath ?? null,
    ...(entry.correction === undefined ? {} : { correction: entry.correction }),
  };
  await appendFile(
    path.join(dataDirectory, PROMPT_LOG_FILE_NAME),
    `${JSON.stringify(promptLine)}\n`,
  );
}
