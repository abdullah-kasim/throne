import { submitToAgentKeyed } from "./herdr-send-keyed-window.ts";
import { submitToAgentWhileLocked } from "./herdr-send-transaction.ts";
import { probeComposerCleared, submitToAgentUnkeyed } from "./herdr-send-unkeyed.ts";
import {
  REAL_ENTER_UNTIL_EMPTY_DEPS,
  REAL_SUBMIT_TO_AGENT_DEPS,
  buildSubmitToAgentDeps,
  pressEnterUntilEmptyTextbox,
} from "./herdr-send-enter-until-empty.ts";
import { THRONE_HERDR_SESSION_NAME } from "./herdr-client.ts";
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

export function defaultSubmitToAgentDeps(agent: HerdrAgent): SubmitToAgentDeps {
  const sessionName = agent.herdrSessionName;
  return sessionName === undefined || sessionName === THRONE_HERDR_SESSION_NAME
    ? REAL_SUBMIT_TO_AGENT_DEPS
    : buildSubmitToAgentDeps(sessionName);
}

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
  deps: SubmitToAgentDeps = defaultSubmitToAgentDeps(agent),
): Promise<void> {
  if (options.key !== undefined) {
    await submitToAgentKeyed(agent, senderName, prompt, options, deps);
    return;
  }
  await submitToAgentUnkeyed(agent, senderName, prompt, options, deps);
}
