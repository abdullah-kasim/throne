import { AgentResolutionError } from "./herdr-identity-contracts.ts";
import { errorText } from "../shared-policy/error-text.ts";
import type { resolveAgent } from "./herdr-runtime.service.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import { OpeningPromptDeliveryError } from "./herdr-errors.ts";
import {
  OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS,
  OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS,
} from "./herdr-errors.ts";

export interface WaitForAgentRegistrationDeps {
  resolveAgent: typeof resolveAgent;
  sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Polls `resolveAgent` for a just-launched pane until herdr registers it, or
 * throws a retry-safe `OpeningPromptDeliveryError` if it never does. The
 * pane must exist and be addressable before anything can be delivered to
 * it, so this wait always runs synchronously in the caller's own call
 * stack rather than through any delivery queue.
 */
export async function waitForAgentRegistration(
  name: string,
  deps: WaitForAgentRegistrationDeps,
): Promise<HerdrAgent> {
  let agent: HerdrAgent | undefined;
  for (
    let attempt = 1;
    attempt <= OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS && agent === undefined;
    attempt += 1
  ) {
    try {
      agent = await deps.resolveAgent(name);
    } catch (error) {
      if (!(error instanceof AgentResolutionError) || error.matchCount !== 0) {
        throw new OpeningPromptDeliveryError(
          name,
          true,
          `the launched pane could not be addressed (${errorText(error)})`,
          error,
        );
      }
      if (attempt < OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS) {
        await deps.sleep(OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS);
      }
    }
  }
  if (agent === undefined) {
    throw new OpeningPromptDeliveryError(
      name,
      true,
      `herdr did not register the launched agent within ` +
        `${
          (OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS - 1) *
          OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS
        }ms`,
    );
  }
  return agent;
}
