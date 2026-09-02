import path from "node:path";
import { REGENT_DIR } from "../regent-state/regent-state.service.ts";

/** Canonical ready-queue directory: one `.json` candidate file per entry. */
export const DEFAULT_READY_QUEUE_DIR = path.join(REGENT_DIR, "alpha-launch-queue");

/** Canonical durable launch-ledger file: append-only JSON Lines. */
export const DEFAULT_LAUNCH_LEDGER_PATH = path.join(
  REGENT_DIR,
  "alpha-launch-ledger.jsonl",
);
