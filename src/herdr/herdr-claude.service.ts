import { isSupportedComposerEmpty } from "../codex-screen/composer/composer.service.ts";
import { Injectable } from '@nestjs/common';
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import type { SupportedAgentScreenSnapshot } from "../codex-screen/composer/composer.types.ts";
import {
  isTransientComposerObservationFailure,
  observeSupportedScreen,
  observeSupportedScreenWithVisibleAnsi,
  pollForVisibleEffect,
  sameScreenTextEntries,
} from "./herdr-screen.service.ts";
import {
  RESIDENT_COMPOSER_POLL_MS,
  type ComposerClearanceContract,
  type SubmitToAgentDeps,
} from "./herdr-send.types.ts";

export async function waitForStableClaudeResidentRepresentation(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<string | undefined> {
  let previousText: string | undefined;
  let stableText: string | undefined;
  const confirmed = await pollForVisibleEffect(
    async () => {
      const composer = (
        await observeSupportedScreen(agent, HARNESS_NAMES.CLAUDE, deps)
      ).activeComposer;
      if (composer.state !== "draft") {
        previousText = undefined;
        return false;
      }
      if (previousText !== undefined && composer.text === previousText) {
        stableText = composer.text;
        return true;
      }
      previousText = composer.text;
      return false;
    },
    deps,
  );
  return confirmed ? stableText : undefined;
}

/**
 * Codex's `waitForSettledCodexComposer` sibling for Claude: a freshly spawned
 * pane can still be painting its own startup chrome (welcome banner, initial
 * layout) when the opening prompt tries to write into it. Writing mid-paint
 * is how DEFECT A reproduced — the text lands, but the confirm-written poll
 * right after it (`waitForStableClaudeResidentRepresentation`) can catch the
 * composer still mid-repaint and time out, and a timed-out confirm never
 * presses Enter, stranding a resident draft forever with no retry (an
 * assumed-filled submit is deliberately never resent, see
 * `message-delivery-retry-policy.ts`). Waiting HERE, before any text is
 * written, for the composer to sit `empty` across two consecutive reads
 * closes that race the same way Codex's quiescence wait already does for
 * Codex — one shared shape, not a second bespoke sequence.
 */
export async function waitForSettledClaudeComposer(
  agent: HerdrAgent,
  deadline: number,
  deps: SubmitToAgentDeps,
): Promise<SupportedAgentScreenSnapshot> {
  let previousSettledFrame: SupportedAgentScreenSnapshot | undefined;
  while (true) {
    try {
      const snapshot = await observeSupportedScreen(agent, HARNESS_NAMES.CLAUDE, deps);
      const settled = snapshot.activeComposer.state === "empty";
      const stable =
        settled &&
        previousSettledFrame !== undefined &&
        sameScreenTextEntries(
          previousSettledFrame.promptTexts,
          snapshot.promptTexts,
        );
      if (stable) return snapshot;
      previousSettledFrame = settled ? snapshot : undefined;
    } catch (error) {
      if (!isTransientComposerObservationFailure(error)) throw error;
      previousSettledFrame = undefined;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        "Claude startup did not settle before the composer deadline; nothing was written",
      );
    }
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

export function claudeTextboxClearance(): ComposerClearanceContract {
  return {
    unmetClearanceDescription:
      "the composer never reached a canonical empty state",
    observe: async (target, deps) => {
      let reading: Awaited<
        ReturnType<typeof observeSupportedScreenWithVisibleAnsi>
      >;
      try {
        reading = await observeSupportedScreenWithVisibleAnsi(
          target,
          HARNESS_NAMES.CLAUDE,
          deps,
        );
      } catch (error) {
        return {
          clearance: "unconfirmed",
          mayPressAgain: false,
          observationError: error,
        };
      }
      if (isSupportedComposerEmpty(HARNESS_NAMES.CLAUDE, reading.visibleAnsi)) {
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
export class HerdrClaudeService {
  waitForStableResidentRepresentation = waitForStableClaudeResidentRepresentation;
  waitForSettledComposer = waitForSettledClaudeComposer;
  textboxClearance = claudeTextboxClearance;
}
