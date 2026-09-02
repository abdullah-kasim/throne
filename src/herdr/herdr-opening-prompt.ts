import { errorText } from "../shared-policy/error-text.ts";
import { SubmitNotSentError, type SubmitToAgentOptions } from "./herdr-send.types.ts";
import { resolveAgent } from "./herdr-runtime.service.ts";
import { submitToAgent } from "./herdr-send.service.ts";
import { sleep } from "./herdr-screen.service.ts";
import { OpeningPromptDeliveryError } from "./herdr-errors.ts";
import { requiresFileBackedDelivery } from "../send-agent/payload-transport.ts";
import { waitForAgentRegistration } from "./herdr-agent-registration-wait.ts";

export interface DeliverOpeningPromptDeps {
  resolveAgent: typeof resolveAgent;
  submitToAgent: typeof submitToAgent;
  sleep: (milliseconds: number) => Promise<void>;
}

/**
 * A caller-tunable subset of `SubmitToAgentOptions`, forwarded verbatim into
 * the underlying `submitToAgent` call below alongside its own hardcoded
 * opening-prompt options. Defaults (a 15-minute `composerWaitMilliseconds`
 * via `RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS` and
 * `forceSubmitResidentDraftOnTimeout: true`) are correct for a NORMAL
 * opening prompt, where no other durable resource is on the line. They are
 * WRONG for a caller that delivers an opening prompt while holding something
 * with its own, shorter staleness bound (e.g. `resurrectRegent`'s
 * `acquireResurrectLock`, `RESURRECT_LOCK_STALE_MS` = 5 minutes) — such a
 * caller must pass an explicit, shorter `composerWaitMilliseconds` here, or
 * risk that bound expiring while this function is still blocked waiting on
 * a resident draft.
 */
export type DeliverOpeningPromptOptions = Pick<
  SubmitToAgentOptions,
  "composerWaitMilliseconds" | "forceSubmitResidentDraftOnTimeout"
>;

const REAL_DELIVER_OPENING_PROMPT_DEPS: DeliverOpeningPromptDeps = {
  resolveAgent,
  submitToAgent,
  sleep,
};

export async function deliverOpeningPrompt(
  name: string,
  prompt: string,
  options: DeliverOpeningPromptOptions = {},
  deps: DeliverOpeningPromptDeps = REAL_DELIVER_OPENING_PROMPT_DEPS,
): Promise<void> {
  const agent = await waitForAgentRegistration(name, deps);
  try {
    await deps.submitToAgent(agent, name, prompt, {
      omitSenderAttribution: true,
      // Opening prompts are the agent's first turn, so paste their contents
      // directly instead of replacing them with a file pointer — but only
      // while they fit under the same threshold `send-agent` itself uses;
      // an oversized prompt still needs file-backing so it doesn't leave
      // the pane scrolled away from its composer.
      disableFileBackedDelivery: !requiresFileBackedDelivery(prompt),
      // Fresh Codex panes can still be painting startup chrome; require the
      // shared settled-composer/pressEnterUntilEmptyTextbox transaction before
      // writing the opening prompt.
      waitForStartupQuiescence: true,
      ...options,
    });
  } catch (error) {
    throw new OpeningPromptDeliveryError(
      name,
      error instanceof SubmitNotSentError,
      errorText(error),
      error,
    );
  }
}
