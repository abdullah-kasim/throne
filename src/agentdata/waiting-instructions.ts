import { PERSONA_CONFIG } from "../application-config.service.ts";

export const CHILD_WAIT_INSTRUCTION =
  "When you end a turn idle because you are genuinely waiting on a specific " +
  "child, publish `{\"blocked\":true}` together with one `__BLOCKED_BY_<name>__` " +
  "token per child you are waiting on, in that same message -- naming the " +
  "child(ren) lets the no-idling sweep detect when every one of them no " +
  "longer resolves and wake you directly with a concrete message, instead " +
  "of leaving you parked on a condition that already cleared.";

export const BACKGROUND_WAIT_INSTRUCTION =
  "When you end a turn to wait on background work you started (a test or " +
  "suite run, a monitor, a queued container slot, a background agent), end " +
  "that message with `{\"blocked\":true} BLOCKED_BY_own-background-run (<what>)`, " +
  "for example `{\"blocked\":true} BLOCKED_BY_own-background-run (candidate and base suites)`; " +
  "your next ordinary message clears it. Otherwise no-idling pages the " +
  `${PERSONA_CONFIG.tierTitles.regent} every minute about an agent that is not idle.`;
