import { DEFAULT_FENCE_HANDOFF_RECORD_PATH } from "./regent-fencing-paths.ts";
import { readFenceHandoffRecord, type FenceHandoffRecord } from "./fence-handoff-record.ts";

/**
 * Consumes the current fence handoff record on Regent startup, before any
 * pane message is processed. Delegates entirely to `readFenceHandoffRecord`'s
 * read-then-clear contract: a fresh fence yields the record once, and any
 * later call before the next fence yields `null`.
 */
export async function consumeFenceHandoffOnStart(
  recordPath: string = DEFAULT_FENCE_HANDOFF_RECORD_PATH,
): Promise<FenceHandoffRecord | null> {
  return readFenceHandoffRecord(recordPath);
}
