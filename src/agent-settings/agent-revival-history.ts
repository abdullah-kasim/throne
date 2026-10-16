import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import {
  agentHistoryFileUnder,
  type AgentHistoryFile,
} from "./agent-history-file.ts";

export const REVIVALS_ALLOWED_PER_HOUR = 3;
export const ONE_HOUR_IN_MILLISECONDS = 60 * 60 * 1000;
export const REVIVAL_HISTORY_BASENAME = "revival-history.json";

export interface RevivalHistory {
  readonly revivedSubject: string;
  readonly revivedAt: readonly number[];
  readonly limitWasReported: boolean;
}

export type RevivalHistoryStore = AgentHistoryFile<RevivalHistory>;

function isRevivalHistory(value: unknown): value is RevivalHistory {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.revivedSubject === "string" &&
    Array.isArray(record.revivedAt) &&
    record.revivedAt.every((instant) => typeof instant === "number") &&
    typeof record.limitWasReported === "boolean"
  );
}

export function revivalHistoryStoreUnder(
  agentDataRoot: string = THRONE_DATA_DIR,
): RevivalHistoryStore {
  return agentHistoryFileUnder(
    agentDataRoot,
    REVIVAL_HISTORY_BASENAME,
    isRevivalHistory,
  );
}

export function revivalHistoryOfSubject(
  recorded: RevivalHistory | null,
  revivedSubject: string,
): RevivalHistory {
  return recorded !== null && recorded.revivedSubject === revivedSubject
    ? recorded
    : { revivedSubject, revivedAt: [], limitWasReported: false };
}

function revivalsInTheLastHour(
  history: RevivalHistory,
  now: number,
): readonly number[] {
  return history.revivedAt.filter(
    (instant) => now - instant < ONE_HOUR_IN_MILLISECONDS,
  );
}

export function revivalLimitIsReached(
  history: RevivalHistory,
  now: number,
): boolean {
  return (
    history.limitWasReported ||
    revivalsInTheLastHour(history, now).length >= REVIVALS_ALLOWED_PER_HOUR
  );
}

export function withRevivalAt(
  history: RevivalHistory,
  now: number,
): RevivalHistory {
  return {
    ...history,
    revivedAt: [...revivalsInTheLastHour(history, now), now],
  };
}

export function withLimitReported(history: RevivalHistory): RevivalHistory {
  return { ...history, limitWasReported: true };
}
