import assert from "node:assert/strict";
import test from "node:test";
import { resolveSpawnPolicy as resolvePrimarySpawnPolicy } from "../src/create-agent/policy.ts";
import {
  baseDeps,
  baseRequest,
} from "../src/create-agent/policy-test-fixtures.ts";
import { resolveSpawnPolicy as resolveLegacySpawnPolicy } from "../src/create-agent-legacy/policy.ts";
import { HARNESS_NAMES } from "../src/harness-routing/harness.ts";

const PI_FLASH = { harness: HARNESS_NAMES.PI, model: "flash" } as const;
const CLAUDE_GPT = {
  harness: HARNESS_NAMES.CLAUDE,
  model: "gpt-5.6-sol",
} as const;

async function resolveSelectedPair(
  resolveSpawnPolicy: typeof resolvePrimarySpawnPolicy,
  selectedPair: typeof PI_FLASH | typeof CLAUDE_GPT,
  requestedHarness: typeof HARNESS_NAMES.CLAUDE | typeof HARNESS_NAMES.CODEX,
) {
  return resolveSpawnPolicy(
    baseRequest({
      harness: requestedHarness,
      model: selectedPair.model,
      launchHarness: requestedHarness,
      launchModel: selectedPair.model,
    }),
    baseDeps({
      readModelAllowlist: async () => [selectedPair],
    }),
  );
}

test("a fresh primary create-agent spawn uses its selected role-pool harness", async () => {
  const resolution = await resolveSelectedPair(
    resolvePrimarySpawnPolicy,
    PI_FLASH,
    HARNESS_NAMES.CLAUDE,
  );

  assert.equal(resolution.ok, true);
  assert.deepEqual(
    resolution.ok
      ? {
          harness: resolution.value.launchHarness,
          model: resolution.value.launchModel,
        }
      : undefined,
    PI_FLASH,
  );
});

test("a fresh legacy create-agent spawn uses its selected role-pool harness", async () => {
  const resolution = await resolveSelectedPair(
    resolveLegacySpawnPolicy,
    PI_FLASH,
    HARNESS_NAMES.CLAUDE,
  );

  assert.equal(resolution.ok, true);
  assert.deepEqual(
    resolution.ok
      ? {
          harness: resolution.value.launchHarness,
          model: resolution.value.launchModel,
        }
      : undefined,
    PI_FLASH,
  );
});

test("fresh primary and legacy create-agent GPT spawns keep selected harnesses", async () => {
  for (const resolveSpawnPolicy of [
    resolvePrimarySpawnPolicy,
    resolveLegacySpawnPolicy,
  ]) {
    const resolution = await resolveSelectedPair(
      resolveSpawnPolicy,
      CLAUDE_GPT,
      HARNESS_NAMES.CODEX,
    );

    assert.equal(resolution.ok, true);
    assert.deepEqual(
      resolution.ok
        ? {
            harness: resolution.value.launchHarness,
            model: resolution.value.launchModel,
          }
        : undefined,
      CLAUDE_GPT,
    );
  }
});

test("registered primary and legacy create-agent resumes keep their stored recipes", async () => {
  for (const resolveSpawnPolicy of [
    resolvePrimarySpawnPolicy,
    resolveLegacySpawnPolicy,
  ]) {
    const resolution = await resolveSpawnPolicy(
      baseRequest({
        resuming: true,
        harness: HARNESS_NAMES.PI,
        model: "flash",
        launchHarness: HARNESS_NAMES.PI,
        launchModel: "flash",
        launchEffort: 1,
      }),
      baseDeps(),
    );

    assert.equal(resolution.ok, true);
    assert.deepEqual(
      resolution.ok
        ? {
            harness: resolution.value.launchHarness,
            model: resolution.value.launchModel,
            effort: resolution.value.launchEffort,
          }
        : undefined,
      { harness: HARNESS_NAMES.PI, model: "flash", effort: 1 },
    );
  }
});
