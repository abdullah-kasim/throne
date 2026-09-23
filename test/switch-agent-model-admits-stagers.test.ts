import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRegisteredSwitchPolicy } from "../src/switch-agent-model/registered-switch-policy.ts";
import type { SpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";

const STAGER_SPAWN: SpawnSpec = {
  harness: "claude",
  model: "opus",
  effort: 1,
  cwd: "/Users/theuser/.throne/worktrees/throne/stager-fifth",
};

const NO_BYPASS = { model: false, effort: false, zeroQuota: false };

const DEPS = {
  readClaudeUsage: async () => ({
    source: "api" as const,
    harness: "claude" as const,
    as_of: "2026-09-21T00:00:00.000Z",
    windows: [],
  }),
  readCodexUsage: async () => ({}) as never,
  targetEffort: 1,
};

const NO_ROLE_PREFIX = /has no recognized role prefix/;

test("a Stager is admitted by its identity role rather than a name prefix", async () => {
  const resolved = await resolveRegisteredSwitchPolicy({
    agentName: "stager-fifth",
    spawn: STAGER_SPAWN,
    requested: { model: "fable", effort: 1 },
    bypass: NO_BYPASS,
    identityRole: "Stager",
    deps: DEPS,
  });

  if (!resolved.ok) assert.doesNotMatch(resolved.reason, NO_ROLE_PREFIX);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  if (!resolved.ok) return;
  assert.equal(resolved.request.model, "fable");
});

test("the identity role is read case-insensitively, as identity.md casing drifts", async () => {
  const resolved = await resolveRegisteredSwitchPolicy({
    agentName: "stager-second",
    spawn: STAGER_SPAWN,
    requested: { model: "fable", effort: 1 },
    bypass: NO_BYPASS,
    identityRole: "stager",
    deps: DEPS,
  });

  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
});

test("a Stager needs no objective contract to be switched", async () => {
  const resolved = await resolveRegisteredSwitchPolicy({
    agentName: "stager-fifth",
    spawn: { ...STAGER_SPAWN, objective_code: undefined },
    requested: { model: "fable", effort: 1 },
    bypass: NO_BYPASS,
    identityRole: "Stager",
    deps: DEPS,
  });

  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
});

test("the Stager name alone does not admit it; the identity role is what does", async () => {
  const resolved = await resolveRegisteredSwitchPolicy({
    agentName: "stager-fifth",
    spawn: STAGER_SPAWN,
    requested: { model: "fable", effort: 1 },
    bypass: NO_BYPASS,
    deps: DEPS,
  });

  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, NO_ROLE_PREFIX);
});

test("an agent with neither a known role prefix nor a Stager identity is still refused", async () => {
  const resolved = await resolveRegisteredSwitchPolicy({
    agentName: "canary-floor",
    spawn: STAGER_SPAWN,
    requested: { model: "fable", effort: 1 },
    bypass: NO_BYPASS,
    deps: DEPS,
  });

  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, NO_ROLE_PREFIX);
});
