import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const JEV_CALLER_KINDS = ['hook', 'hand recall', 'rank', 'sift', 'audit', 'locate', 'probe'] as const;
export type JevCallerKind = (typeof JEV_CALLER_KINDS)[number];

export const JEV_REQUEST_OUTCOMES = ['answered', 'rate-limited', 'lock-busy', 'outdated-build', 'failed'] as const;
export type JevRequestOutcome = (typeof JEV_REQUEST_OUTCOMES)[number];

export const JEV_USAGE_LOG_FILE_NAME = 'jev-usage.jsonl';

export interface JevUsageLine {
  readonly at: string;
  readonly caller: JevCallerKind;
  readonly estimatedTokens: number;
  readonly realTokens: number | null;
  readonly outcome: JevRequestOutcome;
  readonly invocationId?: string;
}

export interface JevUsageLog {
  readonly lines: readonly JevUsageLine[];
  readonly unreadableLineCount: number;
}

export function recallDirectoryInDataHome(dataHome: string): string {
  return path.join(dataHome, 'data', 'recall');
}

export function jevUsageLogPath(dataHome: string): string {
  return path.join(recallDirectoryInDataHome(dataHome), JEV_USAGE_LOG_FILE_NAME);
}

export async function appendJevUsageLine(dataHome: string, line: JevUsageLine): Promise<void> {
  await mkdir(recallDirectoryInDataHome(dataHome), { recursive: true });
  await appendFile(jevUsageLogPath(dataHome), `${JSON.stringify(line)}\n`, { flag: 'a' });
}

function isJevCallerKind(value: unknown): value is JevCallerKind {
  return (JEV_CALLER_KINDS as readonly unknown[]).includes(value);
}

function isJevRequestOutcome(value: unknown): value is JevRequestOutcome {
  return (JEV_REQUEST_OUTCOMES as readonly unknown[]).includes(value);
}

function isJevUsageLine(value: unknown): value is JevUsageLine {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    typeof line.at === 'string' &&
    !Number.isNaN(Date.parse(line.at)) &&
    isJevCallerKind(line.caller) &&
    typeof line.estimatedTokens === 'number' &&
    (typeof line.realTokens === 'number' || line.realTokens === null) &&
    isJevRequestOutcome(line.outcome) &&
    (line.invocationId === undefined || typeof line.invocationId === 'string')
  );
}

function parsedJevUsageLine(text: string): JevUsageLine | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJevUsageLine(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readJevUsageLogText(dataHome: string): Promise<string> {
  try {
    return await readFile(jevUsageLogPath(dataHome), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function readJevUsageLines(dataHome: string, since?: Date): Promise<JevUsageLog> {
  const texts = (await readJevUsageLogText(dataHome)).split('\n').filter((text) => text !== '');
  const lines: JevUsageLine[] = [];
  let unreadableLineCount = 0;
  for (const text of texts) {
    const line = parsedJevUsageLine(text);
    if (line === undefined) unreadableLineCount += 1;
    else if (since === undefined || Date.parse(line.at) >= since.getTime()) lines.push(line);
  }
  return { lines, unreadableLineCount };
}
