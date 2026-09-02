import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * On-disk launch-ledger contract: append-only JSON Lines, one JSON object
 * per line. `create-agent` appends a `LaunchLedgerLaunchLine` at launch time
 * (alongside its existing `spawn.json`/`tree-base.json` writes); `reap-agent`
 * separately appends a `LaunchLedgerStatusLine` at teardown, joined to its
 * launch line by `name` when the ledger is read. Neither append ever
 * rewrites an existing line — the durable history is the append order.
 */
export interface LaunchLedgerLaunchLine {
  readonly type: "launch";
  readonly name: string;
  readonly objectiveCode: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
  readonly spawnedAt: string;
  readonly bypassedObjectiveCode?: boolean;
}

export type LaunchTerminalStatus = "delivered" | "abandoned" | "failed";

export interface LaunchLedgerStatusLine {
  readonly type: "status";
  readonly name: string;
  readonly status: LaunchTerminalStatus;
  readonly endedAt: string;
}

async function appendLedgerLine(
  ledgerPath: string,
  line: LaunchLedgerLaunchLine | LaunchLedgerStatusLine,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(line)}\n`, "utf8");
}

/** Appends one launch record. Called from `create-agent`'s existing launch
 *  write path as part of the launch act, not a separate bookkeeping step. */
export async function appendLaunchLedgerEntry(
  ledgerPath: string,
  entry: {
    name: string;
    objectiveCode: string;
    targetRepo: string;
    targetBranch: string;
    baseCommit: string;
    spawnedAt: string;
    bypassedObjectiveCode?: boolean;
  },
): Promise<void> {
  await appendLedgerLine(ledgerPath, { type: "launch", ...entry });
}

/** Appends one terminal-status record for an existing launch entry. Called
 *  from `reap-agent`'s existing teardown path, using whatever delivery-
 *  verification conclusion it has already reached — this module invents no
 *  new verification mechanism. */
export async function appendLaunchLedgerStatus(
  ledgerPath: string,
  entry: { name: string; status: LaunchTerminalStatus; endedAt: string },
): Promise<void> {
  await appendLedgerLine(ledgerPath, { type: "status", ...entry });
}
