import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';

export const BLOCKED_PAGE_ESCALATION_BOUND = 3;
export const DEFAULT_BLOCKED_PAGE_LEDGER_PATH = path.join(
  RUNTIME_DATA_DIR,
  'regent',
  'blocked-agent-page-ledger.jsonl',
);

export interface BlockedPageLedgerEntry {
  readonly agentName: string;
  readonly observedAt: string;
  readonly kind: 'page-enqueued' | 'lord-notified';
  readonly pageKey?: string;
}

export async function readBlockedPageLedger(
  ledgerPath: string = DEFAULT_BLOCKED_PAGE_LEDGER_PATH,
): Promise<BlockedPageLedgerEntry[]> {
  try {
    return (await readFile(ledgerPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BlockedPageLedgerEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendBlockedPageLedgerEntry(
  entry: BlockedPageLedgerEntry,
  ledgerPath: string = DEFAULT_BLOCKED_PAGE_LEDGER_PATH,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function blockedPageEscalationState(
  agentName: string,
  entries: readonly BlockedPageLedgerEntry[],
): { pageCount: number; lordNotified: boolean } {
  const matching = entries.filter((entry) => entry.agentName === agentName);
  const distinctPageCredits = new Set(
    matching
      .filter((entry) => entry.kind === 'page-enqueued')
      .map((entry, index) => entry.pageKey ?? `legacy:${index}`),
  );
  return {
    pageCount: distinctPageCredits.size,
    lordNotified: matching.some((entry) => entry.kind === 'lord-notified'),
  };
}

export function hasBlockedPageCredit(
  agentName: string,
  pageKey: string,
  entries: readonly BlockedPageLedgerEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.agentName === agentName &&
      entry.kind === 'page-enqueued' &&
      entry.pageKey === pageKey,
  );
}
