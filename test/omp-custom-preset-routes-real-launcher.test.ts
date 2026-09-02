// Requirement: a config.user.ts preset selecting the omp harness routes a
// real spawn to the omp launcher.
//
// The live, gitignored config.user.ts is NEVER written or read here — this
// exercises the exact real functions that file's steering section would flow
// through (`validateSteeringOverride`, the `CONFIGURED_MODEL_PAIRS`
// membership check `materializeCustomPool` performs internally, and
// `buildLaunchArgv`) against an isolated, in-memory `{harness:'omp',
// model:'sonnet'}` override literal instead. See slice 07's semantic
// contract: the routing DECISION is proven in-process by calling the real
// functions; the live pane this decision would drive is separately proven by
// a real herdr spawn (execution log), since that part cannot be demonstrated
// any other way.

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIGURED_MODEL_PAIRS, modelPairInPool } from "../src/config.ts";
import {
  buildLaunchArgv,
  effortToken,
  HARNESS_NAMES,
  throneLauncherPath,
} from "../src/harness-routing/harness.ts";
import {
  validateSteeringOverride,
  type CustomPlanPresetPair,
} from "../src/steering-user-config.ts";

const OMP_SONNET_PAIR: CustomPlanPresetPair = {
  harness: HARNESS_NAMES.OMP,
  model: "sonnet",
};

/** Exactly the shape an operator would write into config.user.ts's
 *  `steering` section — never written to any file, isolated in memory. */
const ISOLATED_OMP_OVERRIDE = {
  activePlanPresetName: "OmpProofPreset",
  customPlanPresets: {
    OmpProofPreset: {
      alpha: [OMP_SONNET_PAIR],
      shadow: [OMP_SONNET_PAIR],
      shadowSlice99: [OMP_SONNET_PAIR],
    },
  },
};

test("a config.user.ts preset selecting the omp harness routes a real spawn to the omp launcher", () => {
  const validated = validateSteeringOverride(
    ISOLATED_OMP_OVERRIDE,
    "isolated in-memory fixture (never the live config.user.ts)",
  );
  assert.equal(validated.activePlanPresetName, "OmpProofPreset");
  const pools = validated.customPlanPresets?.OmpProofPreset;
  assert.ok(pools !== undefined);
  assert.deepEqual(pools.shadow, [OMP_SONNET_PAIR]);

  // The same membership check `materializeCustomPool` (src/config.ts) runs
  // against every custom-preset pair before accepting it.
  for (const pair of [...pools.alpha, ...pools.shadow, ...pools.shadowSlice99]) {
    assert.ok(
      modelPairInPool(CONFIGURED_MODEL_PAIRS, pair),
      `${pair.harness}/${pair.model} must be a configured spawnable pair`,
    );
  }

  const argv = buildLaunchArgv({
    harness: OMP_SONNET_PAIR.harness,
    model: OMP_SONNET_PAIR.model,
    effort: 1,
  });

  assert.equal(argv[0], throneLauncherPath("ompy"));
  assert.equal(argv[1], "--model");
  assert.equal(argv[2], OMP_SONNET_PAIR.model);
  assert.equal(argv[3], "--thinking");
  assert.equal(argv[4], effortToken(OMP_SONNET_PAIR.harness, 1));
  assert.equal(argv[4], "low");
});
