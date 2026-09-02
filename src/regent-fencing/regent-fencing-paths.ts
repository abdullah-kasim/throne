import path from "node:path";
import { REGENT_DIR } from "../regent-state/regent-state.service.ts";

/** Canonical durable fence-ledger file: append-only JSON Lines, one entry per firing. */
export const DEFAULT_FENCE_LEDGER_PATH = path.join(REGENT_DIR, "regent-fence-ledger.jsonl");

/** Canonical durable suite-arbitration ledger: append-only JSON Lines, hold/release events. */
export const DEFAULT_SUITE_ARBITRATION_LEDGER_PATH = path.join(
  REGENT_DIR,
  "regent-suite-arbitration-ledger.jsonl",
);

/** Canonical fence-handoff-record file: single current JSON object, overwritten per fence. */
export const DEFAULT_FENCE_HANDOFF_RECORD_PATH = path.join(
  REGENT_DIR,
  "regent-fence-handoff.json",
);
