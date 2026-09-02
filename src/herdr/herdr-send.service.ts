import { submitToAgentKeyed } from "./herdr-send-keyed-window.ts";
import { submitToAgentWhileLocked } from "./herdr-send-transaction.ts";
import { probeComposerCleared, submitToAgentUnkeyed } from "./herdr-send-unkeyed.ts";
import {
  REAL_ENTER_UNTIL_EMPTY_DEPS,
  REAL_SUBMIT_TO_AGENT_DEPS,
  pressEnterUntilEmptyTextbox,
} from "./herdr-send-enter-until-empty.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import {
  SubmitAssumedFilledError,
  SubmitNotSentError,
  type SubmitToAgentDeps,
  type SubmitToAgentOptions,
} from "./herdr-send.types.ts";

export { SubmitAssumedFilledError, SubmitNotSentError };
export { submitToAgentWhileLocked };
export { submitToAgentUnkeyed };
export { probeComposerCleared };
export {
  REAL_ENTER_UNTIL_EMPTY_DEPS,
  REAL_SUBMIT_TO_AGENT_DEPS,
  pressEnterUntilEmptyTextbox,
};

/**
 * The keyed-admission orchestration entry point: routes to the coalescing
 * keyed delivery window when `options.key` is set, otherwise straight to the
 * unkeyed delivery transaction. Both branches are effect modules this file
 * composes but never imports back from.
 */
export async function submitToAgent(
  agent: HerdrAgent,
  senderName: string,
  prompt: string,
  options: SubmitToAgentOptions = {},
  deps: SubmitToAgentDeps = REAL_SUBMIT_TO_AGENT_DEPS,
): Promise<void> {
  if (options.key !== undefined) {
    await submitToAgentKeyed(agent, senderName, prompt, options, deps);
    return;
  }
  await submitToAgentUnkeyed(agent, senderName, prompt, options, deps);
}
