// Requirement: when the Regent's usage sensor yields no reading, the
// persisted throttle signal and the keep-going log must carry the sensor's
// own one-line error. Observed 2026-09-07: throttle-state.json recorded only
// `status: "unavailable", keyPct: null`, so the cause (a credentials file
// that does not exist on macOS) was invisible until someone reran the CLI.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateThrottle,
  type ThrottleDeps,
  type ThrottleState,
} from "../src/shared-policy/usagethrottle.ts";
import { evaluateLiveRegentThrottle } from "../src/keep-going/keep-going-nudge.ts";
import type { KeepGoingDependencies } from "../src/keep-going/keep-going-context.ts";

const SENSOR_ERROR = "could not read Claude credentials (ENOENT: no such file or directory, open '/x/.credentials.json')";

function throttleDeps(getClaudeUsagePayload: ThrottleDeps["getClaudeUsagePayload"]) {
  const written: ThrottleState[] = [];
  const deps: ThrottleDeps = {
    readThrottleState: async () => ({ band: "NORMAL", lastNudgeAt: null }),
    writeThrottleState: async (state) => { written.push(state); },
    getClaudeUsagePayload,
    getCodexUsagePayload: async () => ({ source: "error", error: "unused" }),
    getOpenCodeGoUsagePayload: async () => ({ source: "error", error: "unused" }),
    readRegentRoute: async () => undefined,
    now: () => new Date("2026-09-07T06:00:00Z"),
    regentDir: "/nonexistent/regent",
  };
  return { deps, written };
}

test("an error payload's message is persisted as the unavailable signal's reason", async () => {
  const { deps, written } = throttleDeps(async () => ({ source: "error", error: SENSOR_ERROR }));
  const evaluation = await evaluateThrottle("claude", deps);
  assert.equal(evaluation.signal.status, "unavailable");
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].signal, {
    driverHarness: "claude",
    status: "unavailable",
    keyPct: null,
    reason: SENSOR_ERROR,
  });
});

test("a thrown sensor error becomes the reason", async () => {
  const { deps, written } = throttleDeps(async () => { throw new Error("boom"); });
  const evaluation = await evaluateThrottle("claude", deps);
  assert.equal(evaluation.signal.status, "unavailable");
  assert.equal(evaluation.signal.status === "unavailable" && evaluation.signal.reason, "boom");
  assert.equal(written[0]?.signal?.status === "unavailable" && written[0].signal.reason, "boom");
});

test("a fresh reading carries no reason", async () => {
  const { deps, written } = throttleDeps(async () => ({
    source: "api",
    windows: [{ cap_window: "weekly", remaining_pct: 80, reset_time: null }],
  }));
  await evaluateThrottle("claude", deps);
  assert.deepEqual(written[0]?.signal, { driverHarness: "claude", status: "fresh", keyPct: 80 });
});

test("keep-going prints the unavailable reason instead of a bare status", async () => {
  const lines: string[] = [];
  const deps = {
    stdout: (text: string) => { lines.push(text); },
    evaluateThrottle: async () => ({
      band: { name: "NORMAL", minIntervalMs: 0, advisory: "" },
      shouldNudge: true,
      signal: { status: "unavailable", reason: SENSOR_ERROR },
    }),
  } as unknown as KeepGoingDependencies;
  await evaluateLiveRegentThrottle("claude", deps);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /usage sensor for Regent harness "claude" is unavailable \(could not read Claude credentials/);
});
