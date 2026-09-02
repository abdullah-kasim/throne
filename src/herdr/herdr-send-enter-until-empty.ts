import { deliverToOmp } from "./omp-delivery-client.ts";
import { stagePayload } from "../send-agent/payload-transport.ts";
import { shouldUseFileBackedAgentPayloads } from "../shared-policy/feature-flags.service.ts";
import { RecipientPaneLockService } from "../shared-policy/recipient-pane-lock.service.ts";
import { captureComposerTimeoutDiagnostic } from "./herdr-composer-diagnostic-capture.ts";
import { REAL_KEYED_SUBMISSION_WINDOW_STORE } from "./keyed-submission-token.ts";
import { getPaneProcessInfo, resolveAgent } from "./herdr-runtime.service.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import { pressEnter, pressPaneKey, sendText } from "./herdr-client.ts";
import {
  describeEnterPresses,
  PRESS_ENTER_UNTIL_EMPTY_BOUNDS,
  recipientName,
} from "./herdr-send.helpers.ts";
import {
  readRecentAgentAnsi,
  readRecentCodexAgentAnsi,
  readVisibleAgentAnsi,
  readVisibleCodexAgentAnsi,
  sleep,
} from "./herdr-screen.service.ts";
import {
  SubmitAssumedFilledError,
  type ComposerClearanceContract,
  type PressEnterUntilEmptyTextboxBounds,
  type PressEnterUntilEmptyTextboxDeps,
  type SubmitToAgentDeps,
} from "./herdr-send.types.ts";

const RECIPIENT_PANE_LOCK = new RecipientPaneLockService();

export const REAL_SUBMIT_TO_AGENT_DEPS: SubmitToAgentDeps = {
  sendText,
  deliverToOmp,
  pressEnter,
  pressPaneKey,
  getPaneProcessInfo,
  readVisibleAgentAnsi,
  readRecentAgentAnsi,
  readVisibleCodexAgentAnsi,
  readRecentCodexAgentAnsi,
  sleep,
  now: Date.now,
  refreshRecipientIdentity: async (recipientName) =>
    resolveAgent(recipientName),
  withRecipientPaneLock:
    RECIPIENT_PANE_LOCK.withRecipientPaneLock.bind(RECIPIENT_PANE_LOCK),
  stagePayload,
  fileBackedPayloadsEnabled: shouldUseFileBackedAgentPayloads(),
  keyedSubmissionWindowStore: REAL_KEYED_SUBMISSION_WINDOW_STORE,
  captureComposerDiagnostic: captureComposerTimeoutDiagnostic,
};

export const REAL_ENTER_UNTIL_EMPTY_DEPS = {
  pressEnter,
  getPaneProcessInfo,
  readVisibleAgentAnsi,
  readVisibleCodexAgentAnsi,
  readRecentAgentAnsi,
  readRecentCodexAgentAnsi,
  sleep,
  now: Date.now,
};

/**
 * The bounded Enter-press transaction shared by every delivery path: presses
 * Enter, observes the composer's clearance, and repeats until the payload is
 * confirmed sent, refused, or the transaction's deadline/press budget is
 * exhausted. A leaf module so both the locked-submit transaction and the
 * orchestration entry point can call it without importing each other.
 */
export async function pressEnterUntilEmptyTextbox(
  target: HerdrAgent,
  text: string,
  clearance: ComposerClearanceContract,
  deps: PressEnterUntilEmptyTextboxDeps = REAL_SUBMIT_TO_AGENT_DEPS,
  bounds: PressEnterUntilEmptyTextboxBounds = PRESS_ENTER_UNTIL_EMPTY_BOUNDS,
): Promise<void> {
  const name = recipientName(target);
  const attributedPayload = `${[...text].length}-character payload`;
  const deadline = deps.now() + bounds.timeoutMilliseconds;
  let enterPresses = 0;
  let emptyConfirmations = 0;
  let lastPressAt = Number.NEGATIVE_INFINITY;
  let lastObservationError: unknown;
  // The composer is `empty` or `filled`; there is no third verdict for "we
  // couldn't tell". Once observation runs out of looks, this is the
  // structurally initialized `filled` default (assume sent, never resend
  // into a possibly-already-submitted composer) — not a fallback branch.
  const exhausted = (): never => {
    if (lastObservationError !== undefined) throw lastObservationError;
    throw new SubmitAssumedFilledError(
      name,
      `${describeEnterPresses(enterPresses)} sent but ` +
        `${clearance.unmetClearanceDescription} for the ${attributedPayload}`,
    );
  };
  while (true) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) exhausted();
    const observed = await clearance.observe(target, deps);
    let confirmedAwaitingDebounce = false;
    if (observed.clearance === "confirmed") {
      if (emptyConfirmations >= 2) return;
      emptyConfirmations += 1;
      confirmedAwaitingDebounce = true;
    } else if (observed.clearance === "refused") {
      throw new SubmitAssumedFilledError(name, observed.reason);
    } else {
      emptyConfirmations = 0;
      lastObservationError = observed.observationError;
      // The pre-write resident-draft check (elsewhere in the send
      // transaction) already answered "is a human typing here" before this
      // loop ever wrote the payload — that is the only place draft
      // protection belongs. Past that write the composer is OURS, so the
      // only remaining question is whether it emptied, not whether its
      // content still matches what we sent: a post-write content comparison
      // re-asks an already-answered question one step too late to act on.
      // Every attempt at that comparison has failed for the same underlying
      // reason — the terminal RENDERS the composer rather than echoing it,
      // and the rendered form depends on terminal width, harness version,
      // and pane state, none of which this loop controls. Three distinct
      // false-mismatch mechanisms surfaced in one day alone: a collapsed
      // paste chip, that same chip plus a dim "Press up to edit queued
      // messages" hint defeating an anchored pattern match, and a terminal
      // hard-wrap mid-word rejoining with a space. Cost: three campaign
      // briefs never delivered, four Regent corrections lost, roughly eight
      // hand-recovered panes, and messages the Lord had to submit himself.
      // There is no smarter comparison to write here — write, then ask only
      // "is it empty yet?", never "is it still mine?".
      if (!observed.mayPressAgain) {
        await deps.sleep(Math.min(bounds.pollMilliseconds, remaining));
        continue;
      }
    }
    if (deps.now() - lastPressAt < bounds.pressSpacingMilliseconds) {
      await deps.sleep(Math.min(bounds.pollMilliseconds, remaining));
      continue;
    }
    if (confirmedAwaitingDebounce && enterPresses >= bounds.maxPresses) {
      // Out of press budget, but the LAST observation was already confirmed
      // empty — the remaining work is re-observation to reach the third
      // consecutive confirmation, not another press. Exhausting the press
      // budget here was a latent bug masked only by generous press budgets
      // (4 for Claude, pre-DWR): with `maxPresses` now 1 for Claude
      // (single-press-then-observe), a genuinely empty composer that had not
      // yet reached its third consecutive confirmation would report
      // an assumed-filled verdict on a delivery that already succeeded. Only an
      // UNCONFIRMED observation past the press budget is a genuine failure
      // (handled below).
      await deps.sleep(Math.min(bounds.pollMilliseconds, remaining));
      continue;
    }
    if (enterPresses >= bounds.maxPresses) exhausted();
    await deps.pressEnter(target.paneId);
    enterPresses += 1;
    lastPressAt = deps.now();
    await deps.sleep(Math.min(bounds.pollMilliseconds, remaining));
  }
}
