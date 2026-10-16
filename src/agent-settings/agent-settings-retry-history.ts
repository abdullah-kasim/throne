import { isPlainObject } from "../shared-policy/config-value-shape.ts";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import {
  agentHistoryFileUnder,
  type AgentHistoryFile,
} from "./agent-history-file.ts";
import {
  AGENT_SETTING_CORRECTION_KINDS,
  type AgentSettingCorrectionKind,
} from "./agent-settings.types.ts";

export const CORRECTION_TRIES_ALLOWED = 3;
export const CORRECTION_HISTORY_BASENAME = "settings-correction-history.json";

export interface CorrectionHistory {
  readonly correctedSubject: string;
  readonly tries: number;
  readonly harnessRefusedTheValue: boolean;
  readonly givingUpWasReported: boolean;
}

export type AgentCorrectionHistory = Readonly<
  Partial<Record<AgentSettingCorrectionKind, CorrectionHistory>>
>;

export type CorrectionHistoryStore = AgentHistoryFile<AgentCorrectionHistory>;

const CORRECTION_KINDS: readonly string[] = Object.values(
  AGENT_SETTING_CORRECTION_KINDS,
);

function isCorrectionHistory(value: unknown): value is CorrectionHistory {
  return (
    isPlainObject(value) &&
    typeof value.correctedSubject === "string" &&
    typeof value.tries === "number" &&
    typeof value.harnessRefusedTheValue === "boolean" &&
    typeof value.givingUpWasReported === "boolean"
  );
}

function isAgentCorrectionHistory(
  value: unknown,
): value is AgentCorrectionHistory {
  return (
    isPlainObject(value) &&
    Object.entries(value).every(
      ([kind, history]) =>
        CORRECTION_KINDS.includes(kind) && isCorrectionHistory(history),
    )
  );
}

export function correctionHistoryStoreUnder(
  agentDataRoot: string = THRONE_DATA_DIR,
): CorrectionHistoryStore {
  return agentHistoryFileUnder(
    agentDataRoot,
    CORRECTION_HISTORY_BASENAME,
    isAgentCorrectionHistory,
  );
}

export function correctionHistoryOfSubject(
  recorded: CorrectionHistory | undefined,
  correctedSubject: string,
): CorrectionHistory {
  return recorded !== undefined && recorded.correctedSubject === correctedSubject
    ? recorded
    : {
        correctedSubject,
        tries: 0,
        harnessRefusedTheValue: false,
        givingUpWasReported: false,
      };
}

export function correctionTriesAreUsedUp(history: CorrectionHistory): boolean {
  return history.tries >= CORRECTION_TRIES_ALLOWED;
}

export function withOneMoreTry(history: CorrectionHistory): CorrectionHistory {
  return { ...history, tries: history.tries + 1 };
}

export function withValueRefused(history: CorrectionHistory): CorrectionHistory {
  return { ...history, harnessRefusedTheValue: true };
}

export function withGivingUpReported(
  history: CorrectionHistory,
): CorrectionHistory {
  return { ...history, givingUpWasReported: true };
}
