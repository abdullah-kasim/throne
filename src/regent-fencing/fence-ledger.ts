import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * On-disk fence-ledger contract: append-only JSON Lines, one entry per
 * fencing firing. Mirrors `launch-ledger.ts`'s append-only shape.
 * `dismissedRegentName`/`summonedRegentName` identify which Regent identity
 * dismiss/summon were run against, independent of whether either step
 * actually succeeded -- there is only ever one Regent name in play. A
 * dismiss or summon failure is recorded via the matching optional flag
 * rather than omitting the entry.
 */
export interface FenceLedgerEntry {
  readonly firedAt: string;
  readonly openItemCount: number;
  readonly minutesIdle: number;
  readonly dismissedRegentName: string;
  readonly summonedRegentName: string;
  readonly dismissFailed?: boolean;
  readonly summonFailed?: boolean;
}

/** Appends one fence-ledger entry. Called from the fence orchestrator at the
 *  moment a fence fires, recording whichever of dismiss/summon actually
 *  ran and whether each succeeded. */
export async function appendFenceLedgerEntry(
  ledgerPath: string,
  entry: FenceLedgerEntry,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
}
