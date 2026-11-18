import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const SPOT_CHECKS_FILE_NAME = 'spot-checks.jsonl';
export const AGREE = 'agree';
export const DISAGREE = 'disagree';

export type SpotCheckVerdictKind = typeof AGREE | typeof DISAGREE;

export interface SpotCheckVerdict {
  readonly id: string;
  readonly verdict: SpotCheckVerdictKind;
  readonly reason: string | null;
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
