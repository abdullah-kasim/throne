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
import { YES } from '../relevance-classifier/classifier.types.ts';
import type { MemoryDecision } from './select-memories.ts';

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

export async function readServedFilePaths(
  dataDirectory: string,
  sessionId: string,
): Promise<ReadonlySet<string>> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(servedListPath(dataDirectory, sessionId), 'utf8'),
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
  } catch {
    return new Set();
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

export async function recordServedFilePaths(
  dataDirectory: string,
  sessionId: string,
  servedFilePaths: ReadonlySet<string>,
  now: Date,
): Promise<void> {
  const listPath = servedListPath(dataDirectory, sessionId);
  await mkdir(path.dirname(listPath), { recursive: true });
  await writeFile(listPath, `${JSON.stringify([...servedFilePaths], null, 1)}\n`);
  await removeServedListsOlderThanTheLimit(path.dirname(listPath), now);
}

export const RECALL_LEDGER_FILE_NAME = 'ledger.jsonl';
export const PREVIOUS_RECALL_LEDGER_FILE_NAME = 'ledger.previous.jsonl';
export const LEDGER_BYTES_BEFORE_IT_IS_ROTATED = 20_000_000;
export const LOWEST_PROBABILITY_OF_YES_WORTH_A_LEDGER_LINE = 0.1;

function probabilityOfYes(decision: MemoryDecision): number {
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

export async function appendDecisionsToLedger(
  dataDirectory: string,
  taskText: string,
  decisions: readonly MemoryDecision[],
  decidedAt: Date,
  ledgerByteLimit: number = LEDGER_BYTES_BEFORE_IT_IS_ROTATED,
): Promise<void> {
  if (decisions.length === 0) return;
  const hashOfInput = inputHash(taskText);
  const summaryLine = {
    at: decidedAt.toISOString(),
    inputHash: hashOfInput,
    questionsAsked: decisions.length,
    served: decisions.filter((decision) => decision.served).length,
    confidentNoAnswersLeftOut: decisions.filter(
      (decision) => !isWorthALedgerLine(decision),
    ).length,
  };
  const lines = decisions.filter(isWorthALedgerLine).map((decision) => ({
    at: decidedAt.toISOString(),
    questionId: decision.answer.questionId,
    inputHash: hashOfInput,
    pick: decision.answer.pick,
    probability: decision.answer.probability,
    backend: decision.answer.backend,
    failedOpen: decision.answer.failedOpen,
    served: decision.served,
  }));
  await appendLinesToLedger(
    dataDirectory,
    [summaryLine, ...lines],
    ledgerByteLimit,
  );
}
