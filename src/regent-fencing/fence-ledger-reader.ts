import { readFile } from "node:fs/promises";
import type { FenceLedgerEntry } from "./fence-ledger.ts";

export type FenceLedgerResult =
  | { readonly state: "ok"; readonly entries: FenceLedgerEntry[] }
  | { readonly state: "unknown"; readonly reason: string };

function isFenceLedgerEntry(value: unknown): value is FenceLedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.firedAt === "string" &&
    record.firedAt !== "" &&
    typeof record.openItemCount === "number" &&
    typeof record.minutesIdle === "number" &&
    typeof record.dismissedRegentName === "string" &&
    record.dismissedRegentName !== "" &&
    typeof record.summonedRegentName === "string" &&
    record.summonedRegentName !== ""
  );
}

/**
 * Reads the append-only fence ledger. A missing ledger file reads as `ok`
 * with zero entries -- a fresh throne has never fenced anyone, which is a
 * positively known fact, not corruption. Any unparseable or invalid line
 * makes the whole read `unknown`, matching the launch-ledger's fail-closed
 * tri-state contract.
 */
export async function readFenceLedger(ledgerPath: string): Promise<FenceLedgerResult> {
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
      reason: `fence ledger "${ledgerPath}" is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const entries: FenceLedgerEntry[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return {
        state: "unknown",
        reason: `fence ledger "${ledgerPath}" has an unparseable line: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!isFenceLedgerEntry(parsed)) {
      return {
        state: "unknown",
        reason: `fence ledger "${ledgerPath}" has a line matching neither the fence-entry contract`,
      };
    }
    entries.push(parsed);
  }
  return { state: "ok", entries };
}

/**
 * Newest recorded firing time across every fence-ledger entry, or
 * `undefined` when no fence has ever been recorded -- the grace-period gate
 * reads this to decide whether the last fence was recent enough to suppress
 * a new one.
 */
export function findMostRecentFenceAtMs(entries: readonly FenceLedgerEntry[]): number | undefined {
  let mostRecent: number | undefined;
  for (const entry of entries) {
    const firedAtMs = Date.parse(entry.firedAt);
    if (mostRecent === undefined || firedAtMs > mostRecent) {
      mostRecent = firedAtMs;
    }
  }
  return mostRecent;
}
