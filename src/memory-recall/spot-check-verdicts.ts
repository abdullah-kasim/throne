import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isInsideWindow, readLogLines, type LogLine } from './recall-report-logs.ts';
import type { Rate } from './recall-report-outcomes.ts';

export const SPOT_CHECKS_FILE_NAME = 'spot-checks.jsonl';
export const AGREE = 'agree';
export const DISAGREE = 'disagree';
export const VERDICTS_NEEDED_FOR_AN_AGREEMENT_RATE = 10;

export type SpotCheckVerdictKind = typeof AGREE | typeof DISAGREE;

export interface SpotCheckVerdict {
  readonly id: string;
  readonly verdict: SpotCheckVerdictKind;
  readonly reason: string | null;
}

function isSpotCheckVerdictLine(line: LogLine): boolean {
  return typeof line.id === 'string' && (line.verdict === AGREE || line.verdict === DISAGREE);
}

export async function appendSpotCheckVerdict(
  dataDirectory: string,
  verdict: SpotCheckVerdict,
  at: Date,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(
    path.join(dataDirectory, SPOT_CHECKS_FILE_NAME),
    `${JSON.stringify({ at: at.toISOString(), ...verdict })}\n`,
  );
}

export async function judgeAgreementWithTheLord(
  dataDirectory: string,
  since: Date | undefined,
): Promise<Rate> {
  const verdicts = (await readLogLines(path.join(dataDirectory, SPOT_CHECKS_FILE_NAME))).filter(
    (line) => isSpotCheckVerdictLine(line) && isInsideWindow(line.at, since),
  );
  return {
    count: verdicts.filter((line) => line.verdict === AGREE).length,
    outOf: verdicts.length,
  };
}
