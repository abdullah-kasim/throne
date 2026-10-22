import assert from "node:assert/strict";
import { test } from "node:test";
import { finalQuotaGate as legacyFinalQuotaGate } from "../create-agent-legacy/native-availability.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { CodexUsagePayload } from "../shared-policy/codex-usage.service.ts";
import { finalQuotaGate } from "./native-availability.ts";

const CODEX_MODEL = "gpt-5.6-sol";

function exhaustedCodexReading(stale: boolean): CodexUsagePayload {
  return {
    source: "api",
    harness: HARNESS_NAMES.CODEX,
    as_of: "2026-10-16T12:00:00Z",
    windows: [{ cap_window: "weekly", used_pct: 100, remaining_pct: 0, reset_time: "2026-10-20T00:00:00Z" }],
    ...(stale ? { stale: true, error: "Codex usage request failed (HTTP 429)" } : {}),
  };
}

for (const [copy, gate] of [["create-agent", finalQuotaGate], ["create-agent-legacy", legacyFinalQuotaGate]] as const) {
  test(`a stale exhausted codex reading neither refuses nor counts as a zero-quota override in ${copy}`, async () => {
    const gateFor = (stale: boolean, bypassZeroQuota: boolean) =>
      gate({
        name: "shadow-codex-gate",
        resuming: false,
        harness: HARNESS_NAMES.CODEX,
        model: CODEX_MODEL,
        bypassZeroQuota,
        readClaude: async () => {
          throw new Error("a Codex launch must not read Claude usage");
        },
        readCodex: async () => exhaustedCodexReading(stale),
      });

    assert.equal((await gateFor(false, false)).refuse, true);
    assert.equal((await gateFor(false, true)).overrideApplied, true);
    assert.deepEqual(await gateFor(true, false), { refuse: false, overrideApplied: false });
    assert.deepEqual(await gateFor(true, true), { refuse: false, overrideApplied: false });
  });
}
