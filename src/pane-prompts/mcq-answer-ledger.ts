import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';

export const DEFAULT_MCQ_ANSWER_LEDGER_PATH = path.join(RUNTIME_DATA_DIR, 'regent', 'mcq-answers.jsonl');

export const MCQ_OUTCOMES = {
  ANSWERED: 'answered',
  DISMISSED: 'dismissed',
  TAKE_OVER: 'take-over',
} as const;
export type McqOutcome = (typeof MCQ_OUTCOMES)[keyof typeof MCQ_OUTCOMES];

export interface McqAnswerLedgerEntry {
  readonly time: string;
  readonly caller: string;
  readonly agent: string;
  readonly pane: string;
  readonly kind: string;
  readonly question: string;
  readonly command?: string;
  readonly chosen: { readonly number: number; readonly label: string } | 'dismiss';
  readonly outcome: McqOutcome;
  readonly detail?: string;
}

export async function appendMcqAnswerLedgerEntry(
  entry: McqAnswerLedgerEntry,
  ledgerPath: string = DEFAULT_MCQ_ANSWER_LEDGER_PATH,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}
