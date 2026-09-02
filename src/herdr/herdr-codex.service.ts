import {
  isSupportedComposerEmpty,
} from "../codex-screen/composer/composer.service.ts";
import type { SupportedAgentScreenSnapshot } from "../codex-screen/composer/composer.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import {
  isTransientComposerObservationFailure,
  observationFailureForbidsKeys,
  observeCodexScreenWithRecentPrompts,
  observeSupportedScreen,
} from "./herdr-screen.service.ts";
import {
  RESIDENT_COMPOSER_POLL_MS,
  SubmitAssumedFilledError,
  type ComposerClearanceContract,
  type SubmitToAgentDeps,
} from "./herdr-send.types.ts";
import { Injectable } from '@nestjs/common';

const HERDR_ANSI_CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const CODEX_COMPOSER_QUEUE_HINT_LINE =
  /^tab to queue message(?:\s+\d+% context left)?$/u;

export function codexScreenShowsComposerQueueHint(
  visibleAnsi: string,
): boolean {
  return visibleAnsi
    .split(/\r?\n/u)
    .some((line) =>
      CODEX_COMPOSER_QUEUE_HINT_LINE.test(
        line.replace(HERDR_ANSI_CONTROL_SEQUENCE, "").trim(),
      ),
    );
}

export async function waitForCodexDraftRepresentation(
  agent: HerdrAgent,
  recipientName: string,
  deadline: number,
  deps: SubmitToAgentDeps,
): Promise<SupportedAgentScreenSnapshot> {
  while (true) {
    try {
      const snapshot = await observeSupportedScreen(
        agent,
        HARNESS_NAMES.CODEX,
        deps,
      );
      if (snapshot.activeComposer.state === "draft") return snapshot;
    } catch (error) {
      if (!isTransientComposerObservationFailure(error)) throw error;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new SubmitAssumedFilledError(
        recipientName,
        "no-enter could not identify a resident Codex representation before the composer deadline",
      );
    }
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

/**
 * Codex clearance is the canonical empty textbox and nothing else: the shared
 * emptiness predicate over the exact classified frame. A frame that could not
 * be read is not clearance, and only an unrecognized active composer forbids
 * the next key — every other read failure leaves the payload sitting in the
 * textbox, which is a reason to press again rather than to stop.
 *
 * The contract names only what Codex clearance failed to be. Which payload the
 * press series belonged to is the transaction's to name, from the submitted
 * text it holds for every harness.
 */
export function codexTextboxClearance(): ComposerClearanceContract {
  return {
    unmetClearanceDescription:
      "the composer never reached a canonical empty state",
    observe: async (target, deps) => {
      let reading: Awaited<ReturnType<typeof observeCodexScreenWithRecentPrompts>>;
      try {
        reading = await observeCodexScreenWithRecentPrompts(target, deps);
      } catch (error) {
        return {
          clearance: "unconfirmed",
          mayPressAgain: !observationFailureForbidsKeys(error),
          observationError: error,
        };
      }
      if (isSupportedComposerEmpty(HARNESS_NAMES.CODEX, reading.visibleAnsi)) {
        return { clearance: "confirmed" };
      }
      const composer = reading.snapshot.activeComposer;
      return {
        clearance: "unconfirmed",
        mayPressAgain: composer.state === "draft",
        observedText: composer.state === "draft" ? composer.text : undefined,
      };
    },
  };
}

@Injectable()
export class HerdrCodexService {
  screenShowsComposerQueueHint = codexScreenShowsComposerQueueHint;
  waitForDraftRepresentation = waitForCodexDraftRepresentation;
  textboxClearance = codexTextboxClearance;
}
