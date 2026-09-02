import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import { Injectable } from '@nestjs/common';
import type { HerdrAgent } from './herdr-inventory.service.ts';
import type { SupportedAgentScreenSnapshot } from '../codex-screen/composer/composer.types.ts';
import {
  isTransientComposerObservationFailure,
  observeSupportedScreen,
  observeSupportedScreenWithVisibleAnsi,
  pollForVisibleEffect,
  supportedComposerHarness,
} from './herdr-screen.service.ts';
import {
  RESIDENT_COMPOSER_POLL_MS,
  type ComposerClearanceContract,
  SubmitNotSentError,
  type SubmitToAgentDeps,
} from './herdr-send.types.ts';

export async function dismissOpenCodeMessageActionsModal(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<void> {
  if (supportedComposerHarness(agent.agent) !== HARNESS_NAMES.OPENCODE) {
    return;
  }
  const name = agent.name ?? agent.terminalId;
  let snapshot = await observeSupportedScreen(agent, HARNESS_NAMES.OPENCODE, deps);
  if (snapshot.messageActionsModal !== true) return;
  try {
    await deps.pressPaneKey(agent.paneId, 'Escape');
    snapshot = await observeSupportedScreen(agent, HARNESS_NAMES.OPENCODE, deps);
  } catch (error) {
    throw new SubmitNotSentError(
      name,
      new Error(
        `Message Actions modal could not be dismissed with one Esc: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (snapshot.messageActionsModal === true) {
    throw new SubmitNotSentError(
      name,
      new Error(
        'Message Actions modal remained open after one Esc; nothing was written',
      ),
    );
  }
}

export async function waitForStableOpenCodeResidentRepresentation(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<string | undefined> {
  let previousText: string | undefined;
  let stableText: string | undefined;
  const confirmed = await pollForVisibleEffect(
    async () => {
      const composer = (
        await observeSupportedScreen(agent, HARNESS_NAMES.OPENCODE, deps)
      ).activeComposer;
      if (composer.state !== 'draft') {
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
 * OpenCode's sibling of `waitForSettledClaudeComposer` /
 * `waitForSettledCodexComposer`: waits for a fresh pane's own startup chrome
 * to stop painting (composer sits stably `empty` across two consecutive
 * reads) before this court ever writes into it. OpenCode is currently
 * `registered-resume-only` in the model policy, so a genuinely fresh spawn
 * does not happen through ordinary routing today — but a caller that passes
 * `waitForStartupQuiescence` for a resumed pane still deserves the same
 * startup-settling treatment every other harness gets, not a silent gap.
 */
export async function waitForSettledOpenCodeComposer(
  agent: HerdrAgent,
  deadline: number,
  deps: SubmitToAgentDeps,
): Promise<SupportedAgentScreenSnapshot> {
  let previousSettledFrame: SupportedAgentScreenSnapshot | undefined;
  while (true) {
    try {
      const snapshot = await observeSupportedScreen(agent, HARNESS_NAMES.OPENCODE, deps);
      const settled = snapshot.activeComposer.state === 'empty';
      const stable = settled && previousSettledFrame !== undefined;
      if (stable) return snapshot;
      previousSettledFrame = settled ? snapshot : undefined;
    } catch (error) {
      if (!isTransientComposerObservationFailure(error)) throw error;
      previousSettledFrame = undefined;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        'OpenCode startup did not settle before the composer deadline; nothing was written',
      );
    }
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

/**
 * OpenCode clearance is the canonical empty textbox and nothing else: the
 * shared emptiness predicate over the exact classified frame. A frame that
 * could not be read, or one whose composer box bottom is absent, vetoes the
 * next key — the opencode box is closed by a `╹▀▀▀…` edge in every normal
 * frame, so its absence means an interactive dialog holds the pane and Enter
 * would activate it. An ordinary non-empty box keeps the transaction pressing.
 */
export function opencodeTextboxClearance(): ComposerClearanceContract {
  return {
    unmetClearanceDescription:
      'the composer never reached a canonical empty state',
    observe: async (target, deps) => {
      let reading: Awaited<
        ReturnType<typeof observeSupportedScreenWithVisibleAnsi>
      >;
      try {
        reading = await observeSupportedScreenWithVisibleAnsi(
          target,
          HARNESS_NAMES.OPENCODE,
          deps,
        );
      } catch (error) {
        return {
          clearance: 'unconfirmed',
          mayPressAgain: false,
          observationError: error,
        };
      }
      const composer = reading.snapshot.activeComposer;
      if (composer.state === 'empty') {
        return { clearance: 'confirmed' };
      }
      return {
        clearance: 'unconfirmed',
        mayPressAgain: composer.state === 'draft',
        observedText: composer.state === 'draft' ? composer.text : undefined,
      };
    },
  };
}

@Injectable()
export class HerdrOpencodeService {
  dismissMessageActionsModal = dismissOpenCodeMessageActionsModal;
  waitForStableResidentRepresentation = waitForStableOpenCodeResidentRepresentation;
  textboxClearance = opencodeTextboxClearance;
}
