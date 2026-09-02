import { readFile } from "node:fs/promises";
import type {
  LaunchLedgerLaunchLine,
  LaunchLedgerStatusLine,
  LaunchTerminalStatus,
} from "./launch-ledger.ts";

export interface LaunchRecord {
  readonly name: string;
  readonly objectiveCode: string;
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
  readonly spawnedAt: string;
  /** `unknown` means no status line was found for this name — a launch with
   *  no recorded ending, exactly what a killed Alpha (never reaching
   *  `reap-agent`) leaves behind. Never inferred or defaulted. */
  readonly status: LaunchTerminalStatus | "unknown";
}

export type LaunchLedgerResult =
  | { readonly state: "ok"; readonly entries: LaunchRecord[] }
  | { readonly state: "unknown"; readonly reason: string };

function isLaunchLine(value: unknown): value is LaunchLedgerLaunchLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "launch" &&
    typeof record.name === "string" &&
    record.name !== "" &&
    typeof record.objectiveCode === "string" &&
    record.objectiveCode !== "" &&
    typeof record.targetRepo === "string" &&
    record.targetRepo !== "" &&
    typeof record.targetBranch === "string" &&
    record.targetBranch !== "" &&
    typeof record.baseCommit === "string" &&
    record.baseCommit !== "" &&
    typeof record.spawnedAt === "string" &&
    record.spawnedAt !== ""
  );
}

const TERMINAL_STATUSES: readonly LaunchTerminalStatus[] = [
  "delivered",
  "abandoned",
  "failed",
];

function isStatusLine(value: unknown): value is LaunchLedgerStatusLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "status" &&
    typeof record.name === "string" &&
    record.name !== "" &&
    typeof record.status === "string" &&
    TERMINAL_STATUSES.includes(record.status as LaunchTerminalStatus) &&
    typeof record.endedAt === "string" &&
    record.endedAt !== ""
  );
}

/**
 * Reads the append-only launch ledger and resolves each launch to exactly
 * one of `delivered` / `abandoned` / `failed` / `unknown` by joining launch
 * lines to status lines on `name` — never inferred, never defaulted on
 * absence. A missing ledger file reads as `ok` with zero entries (no launch
 * has ever been recorded yet, which is a positively known fact, not
 * corruption). Any unparseable or invalid line makes the whole read
 * `unknown`, matching the ready-queue's own fail-closed tri-state contract.
 * `filter.objectiveCode`, when given, narrows the returned entries.
 */
export async function readLaunchLedger(
  ledgerPath: string,
  filter?: { objectiveCode?: string },
): Promise<LaunchLedgerResult> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { state: "ok", entries: [] };
    }
    return {
      state: "unknown",
      reason: `launch ledger "${ledgerPath}" is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const launches = new Map<string, LaunchLedgerLaunchLine>();
  const statuses = new Map<string, LaunchLedgerStatusLine>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return {
        state: "unknown",
        reason: `launch ledger "${ledgerPath}" has an unparseable line: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (isLaunchLine(parsed)) {
      launches.set(parsed.name, parsed);
    } else if (isStatusLine(parsed)) {
      statuses.set(parsed.name, parsed);
    } else {
      return {
        state: "unknown",
        reason: `launch ledger "${ledgerPath}" has a line matching neither the launch nor status contract`,
      };
    }
  }
  const entries: LaunchRecord[] = [];
  for (const launch of launches.values()) {
    if (
      filter?.objectiveCode !== undefined &&
      launch.objectiveCode !== filter.objectiveCode
    ) {
      continue;
    }
    const status = statuses.get(launch.name);
    entries.push({
      name: launch.name,
      objectiveCode: launch.objectiveCode,
      targetRepo: launch.targetRepo,
      targetBranch: launch.targetBranch,
      baseCommit: launch.baseCommit,
      spawnedAt: launch.spawnedAt,
      status: status?.status ?? "unknown",
    });
  }
  return { state: "ok", entries };
}
