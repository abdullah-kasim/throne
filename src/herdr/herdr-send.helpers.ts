import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import type { SupportedComposerHarness } from '../codex-screen/composer/composer.types.ts';
import { claudeTextboxClearance } from './herdr-claude.service.ts';
import { codexTextboxClearance } from './herdr-codex.service.ts';
import { opencodeTextboxClearance } from './herdr-opencode.service.ts';
import type { HerdrAgent } from './herdr-inventory.service.ts';
import { waitForRecognizedComposer } from './herdr-screen.service.ts';
import {
  COMPOSER_RECOGNITION_TIMEOUT_MS,
  type ComposerClearanceContract,
  type PressEnterUntilEmptyTextboxBounds,
  type SubmitToAgentDeps,
  type SubmitToAgentOptions,
} from './herdr-send.types.ts';

export function recipientName(target: HerdrAgent): string {
  return target.name ?? target.terminalId;
}

export function describeEnterPresses(presses: number): string {
  return presses === 1 ? 'one Enter was' : `${presses} Enters were`;
}

export function recipientIdentityText(agent: HerdrAgent): string {
  return `${agent.terminalId}/${agent.tabId}/${agent.paneId}/${agent.agent}`;
}

export function submittedPayload(
  senderName: string,
  prompt: string,
  options: SubmitToAgentOptions,
): string {
  if (options.omitSenderAttribution === true) return prompt;
  if (senderName.length === 0) return prompt;
  return `${senderName} said: ${prompt}`;
}

/**
 * The one press-and-observe budget shared by every harness's step 5 (confirm
 * the composer cleared): once every press is gated on an observation, the
 * ceiling only guards against a composer that never resolves — it no longer
 * needs to differ per harness. `maxPresses` keeps the proven Codex/OpenCode
 * ceiling; Claude's former ceiling of 1 was a stopgap against blind pressing
 * that this observation gate makes unnecessary.
 */
export const PRESS_ENTER_UNTIL_EMPTY_BOUNDS: PressEnterUntilEmptyTextboxBounds = {
  timeoutMilliseconds: 45_000,
  pollMilliseconds: 1_000,
  pressSpacingMilliseconds: 1_500,
  maxPresses: 12,
};

/**
 * Harnesses whose composer grammar and submission contract are Claude's:
 * claude itself and the two Omni harnesses, which run claude-derived screens
 * and submit through the shared Claude clearance. Codex and opencode each own
 * a separate branch; a harness joining later must choose one explicitly.
 */
export function isClaudeBranchHarness(harness: string): boolean {
  return (
    harness === HARNESS_NAMES.CLAUDE ||
    harness === HARNESS_NAMES.CLAUDEY_ALL_OMNI ||
    harness === HARNESS_NAMES.CODEXY_ALL_OMNI
  );
}

/**
 * Distinguishes an idle pane with an empty (or stuck-unrecognized) composer
 * from a pane genuinely holding someone else's resident draft, before ever
 * committing to the long resident-draft ceiling. A first observation is
 * taken under the tight composer-recognition bound; only a pane that draft
 * observation actually finds resident earns the long `requestedMilliseconds`
 * wait — anything else that fails to resolve within the tight bound reports
 * failure there instead of silently continuing toward the long ceiling.
 */
export async function resolveComposerWaitDeadline(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  requestedMilliseconds: number,
  deps: SubmitToAgentDeps,
): Promise<number> {
  const probeDeadline =
    deps.now() + Math.min(COMPOSER_RECOGNITION_TIMEOUT_MS, requestedMilliseconds);
  const probe = await waitForRecognizedComposer(agent, harness, probeDeadline, deps);
  return probe.activeComposer.state === 'draft'
    ? deps.now() + requestedMilliseconds
    : probeDeadline;
}

export function enterUntilEmptyTransactionFor(harness: string): {
  clearance: ComposerClearanceContract;
  bounds: PressEnterUntilEmptyTextboxBounds;
} {
  if (isClaudeBranchHarness(harness)) {
    return {
      clearance: claudeTextboxClearance(),
      bounds: PRESS_ENTER_UNTIL_EMPTY_BOUNDS,
    };
  }
  if (harness === HARNESS_NAMES.OPENCODE) {
    return {
      clearance: opencodeTextboxClearance(),
      bounds: PRESS_ENTER_UNTIL_EMPTY_BOUNDS,
    };
  }
  return {
    clearance: codexTextboxClearance(),
    bounds: PRESS_ENTER_UNTIL_EMPTY_BOUNDS,
  };
}
