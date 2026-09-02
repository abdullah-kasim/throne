import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";

/** Shared by `herdr-send-composer-wait.test.ts` and `herdr-send-unkeyed.test.ts`. */
export function fakeClaudeAgent(): HerdrAgent {
  return {
    agent: HARNESS_NAMES.CLAUDE,
    name: "recipient",
    agentStatus: "idle",
    cwd: "/throne/recipient",
    focused: false,
    paneId: "pane-recipient",
    tabId: "tab-recipient",
    terminalId: "term-recipient",
  };
}

/**
 * A deterministic virtual clock: `now()` reads a counter, `sleep()` advances
 * it instantly instead of yielding to a real timer, so a simulated hour of
 * polling costs no real wall-clock time in the test suite.
 */
export function fakeVirtualClock(): { now(): number; sleep(milliseconds: number): Promise<void> } {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (milliseconds: number) => {
      elapsed += milliseconds;
    },
  };
}
