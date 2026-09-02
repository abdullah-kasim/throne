// Lord's ruling, 2026-08-08: "its important to know what's the previous
// persona so that transitions can fallback". Recorded in the DURABLE LEDGER
// (`RUNTIME_DATA_DIR`, home-anchored — not gitignored worktree state and not
// pane content), the same class of move BLK made for blocked state
// (`agentdata/blocked-marker.service.ts`) and for the identical reason: pane
// scraping is not a source of truth.
//
// Keeps only the single immediately-previous record, not a history: the
// ruling's three justifications (tab-rename reversibility, partial-broadcast
// recovery, operator undo) each need exactly one prior known-good state to
// roll back to, never an arbitrary point further back — a short history
// would be unused complexity past what the ruling asks for.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoleplayPresetName } from '../application-config.service.ts';

export interface PersonaHistoryRecord {
  readonly previousPreset: RoleplayPresetName;
  readonly switchedToPreset: RoleplayPresetName;
  readonly switchedAt: string;
}

export function personaHistoryPath(runtimeDataDir: string): string {
  return path.join(runtimeDataDir, 'persona-history.json');
}

/** Reads the most recent persona-history record, or `undefined` if none has
 *  ever been written (the first-ever switch, or a fresh throne). A present
 *  but unparsable file is a loud failure, not a silent "no history". */
export async function readPersonaHistory(
  historyPath: string,
): Promise<PersonaHistoryRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `Invalid persona history at "${historyPath}": not valid JSON — ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).previousPreset !== 'string' ||
    typeof (parsed as Record<string, unknown>).switchedToPreset !== 'string' ||
    typeof (parsed as Record<string, unknown>).switchedAt !== 'string'
  ) {
    throw new Error(
      `Invalid persona history at "${historyPath}": expected ` +
        '{ previousPreset, switchedToPreset, switchedAt } as strings.',
    );
  }
  return parsed as PersonaHistoryRecord;
}

/** Overwrites the single persona-history record with the transition just
 *  performed. Creates the containing directory if absent. */
export async function writePersonaHistory(
  historyPath: string,
  record: PersonaHistoryRecord,
): Promise<void> {
  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
