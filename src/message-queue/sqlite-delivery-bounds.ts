import { PRESS_ENTER_UNTIL_EMPTY_BOUNDS } from "../herdr/herdr-send.helpers.ts";
import {
  COMPOSER_VISIBILITY_TIMEOUT_MS,
  RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS,
} from "../herdr/herdr-send.types.ts";

export const LEGITIMATE_COMPOSER_WAIT_CEILING_MS = RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS;

export function deriveLaneBoundMs(
  waitCeilingMs: number = LEGITIMATE_COMPOSER_WAIT_CEILING_MS,
): number {
  return waitCeilingMs;
}

export function measureWritePhaseWorstCaseMs(): number {
  return Math.max(
    COMPOSER_VISIBILITY_TIMEOUT_MS,
    PRESS_ENTER_UNTIL_EMPTY_BOUNDS.timeoutMilliseconds,
  );
}

export function deriveMinimumDeliveryAttemptFloorMs(
  writePhaseWorstCaseMs: number = measureWritePhaseWorstCaseMs(),
): number {
  return writePhaseWorstCaseMs;
}

export const SANDBOX_HARD_KILL_MARGIN_MS = 30_000;

export function deriveSandboxHardKillBoundMs(
  laneBoundMs: number,
  writePhaseWorstCaseMs: number,
  minimumDeliveryFloorMs: number = deriveMinimumDeliveryAttemptFloorMs(),
  marginMs: number = SANDBOX_HARD_KILL_MARGIN_MS,
): number {
  return laneBoundMs + minimumDeliveryFloorMs + writePhaseWorstCaseMs + marginMs;
}
