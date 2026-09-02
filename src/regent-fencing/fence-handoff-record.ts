import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HeldCampaign } from "./suite-arbitration-ledger.ts";

/**
 * The single current handoff record: not append-only, one file overwritten
 * per fence. Lets a freshly-summoned Regent learn why its predecessor was
 * fenced, and the in-flight suite-arbitration snapshot at fence time,
 * before it processes any pane message.
 */
export interface FenceHandoffRecord {
  readonly firedAt: string;
  readonly openItemCount: number;
  readonly minutesIdle: number;
  readonly suiteArbitrationSnapshot: HeldCampaign[];
}

/** Writes the current handoff record, overwriting whatever was there.
 *  Called by the fence orchestrator at fence time. */
export async function writeFenceHandoffRecord(
  recordPath: string,
  record: FenceHandoffRecord,
): Promise<void> {
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify(record), "utf8");
}

/**
 * Reads the current handoff record and consumes it: a successful read
 * deletes the file, so a stale handoff from an earlier fence is never
 * re-read as current. Returns `null` when no fence has happened, or the
 * record was already consumed.
 */
export async function readFenceHandoffRecord(
  recordPath: string,
): Promise<FenceHandoffRecord | null> {
  let raw: string;
  try {
    raw = await readFile(recordPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(raw) as FenceHandoffRecord;
  await unlink(recordPath);
  return record;
}
